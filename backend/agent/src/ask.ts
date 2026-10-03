/**
 * POST /threads/:threadId/ask — the quick loop.
 *
 *   1. retrieve: web_search(the question) + recall_memory, then fetch the top pages
 *   2. loop: the model either calls more tools or writes the answer (streamed)
 *   3. done event, assistant message, run log, request row, one pino line
 *
 * Event order: trace* → sources → token* → done. `sources` goes out right before the
 * first token, so it holds everything retrieved in this request and nothing else.
 *
 * Fail loud: the SSE headers are only sent once the LLM has accepted the first call, so a
 * dead search provider or LLM still reaches the caller as a real 502. A failure after that
 * is an `error` event. Either way the run log says terminated: "error".
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Request, Response } from 'express';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pino from 'pino';
import { AskBody, newId, type AskTool, type DoneEvent, type RunLog, type Source, type TraceEvent } from '@lumina/contract';
import { env, secrets } from './env.js';
import { db } from './db.js';
import { bestPassage, fetchPage, webSearch, type SearchResult } from './search.js';
import { recallMemories, saveMemory } from './memory.js';

const anthropic = new Anthropic({ apiKey: secrets.anthropic });
const PAGES_TO_FETCH = 3;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'web_search',
    description: 'Search the web. Returns titles, URLs and short snippets. Use fetch_page to read a result before citing it.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  {
    name: 'fetch_page',
    description: 'Read the full text of a web page. The page becomes a numbered source you can cite.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  {
    name: 'recall_memory',
    description: 'Look up saved facts and preferences about this user.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  {
    name: 'save_memory',
    description:
      'Save a stable fact or preference the user stated about themselves (e.g. "prefers TypeScript examples"). Never save trivia or facts from search results.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  }
];

/** Everything one request accumulates. */
class Run {
  readonly started = Date.now();
  ttftMs: number | null = null;
  steps: TraceEvent[] = [];
  sources: Source[] = [];
  pageText = new Map<number, string>();
  searchResults = new Map<string, SearchResult>();
  tokensIn = 0;
  tokensOut = 0;
  embedTokens = 0;
  searches = 0;
  searchHits = 0;
  terminated: 'done' | 'cap' | 'error' = 'done';
  constructor(
    readonly requestId: string,
    readonly userId: string,
    readonly threadId: string,
    readonly query: string
  ) {}

  /** Number a fetched page as a source. Deduped by URL. */
  addSource(title: string, url: string, text: string): number {
    const existing = this.sources.find((s) => s.url === url);
    if (existing) return existing.n;
    const n = this.sources.length + 1;
    this.sources.push({ n, kind: 'web', title, url, snippet: bestPassage(text, this.query) });
    this.pageText.set(n, text);
    return n;
  }

  costUsd(): number {
    const p = env.prices;
    return (
      (this.tokensIn / 1e6) * p.inputUsdPerMtok +
      (this.tokensOut / 1e6) * p.outputUsdPerMtok +
      (this.embedTokens / 1e6) * p.embeddingUsdPerMtok +
      (this.searches - this.searchHits) * p.searchUsdPerCall
    );
  }
}

export async function handleAsk(req: Request, res: Response, log: pino.Logger) {
  const userId = req.header('x-user-id')!;
  const requestId = res.getHeader('x-request-id') as string;
  const threadId = req.params.threadId!;

  const parsed = AskBody.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return res.status(400).json({ error: `${issue?.path.join('.') || 'body'}: ${issue?.message}`, status: 400 });
  }
  const body = parsed.data;
  if (body.depth === 'deep') return res.status(501).json({ error: 'not implemented yet: deep search', status: 501 });
  if (body.mode === 'docs') return res.status(501).json({ error: 'not implemented yet: document search', status: 501 });

  const database = await db();
  const thread = await database.collection('threads').findOne({ _id: threadId as never, userId });
  if (!thread) return res.status(404).json({ error: `unknown thread ${threadId}`, status: 404 });

  const run = new Run(requestId, userId, threadId, body.query);

  // ---- the SSE stream: buffered until the LLM accepts the first call (see header comment)
  let open = false;
  const pending: [string, unknown][] = [];
  const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const emit = (event: string, data: unknown) => (open ? write(event, data) : pending.push([event, data]));
  const openStream = () => {
    if (open) return;
    open = true;
    res.status(200);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    for (const [e, d] of pending) write(e, d);
  };

  const abort = new AbortController();
  res.on('close', () => abort.abort());

  /** Run one tool, record it as a trace step, return what the model should see. */
  const runTool = async (tool: AskTool, input: Record<string, unknown>, reason: string) => {
    const t0 = Date.now();
    const step: TraceEvent = { step: run.steps.length + 1, tool, input, ok: true, ms: 0, reason };
    run.steps.push(step);
    try {
      return await execute(tool, input);
    } catch (err) {
      step.ok = false;
      step.error = (err as Error).message || String(err);
      return `ERROR: ${step.error}`;
    } finally {
      step.ms = Date.now() - t0;
      emit('trace', step);
    }
  };

  const execute = async (tool: AskTool, input: Record<string, unknown>): Promise<string> => {
    if (tool === 'web_search') {
      const { results, cached } = await webSearch(String(input.query));
      run.searches++;
      if (cached) run.searchHits++;
      for (const r of results) run.searchResults.set(r.url, r);
      if (!results.length) return 'No results.';
      return results.map((r) => `- ${r.title} (${r.url}): ${r.snippet}`).join('\n');
    }
    if (tool === 'fetch_page') {
      const url = String(input.url);
      const known = run.searchResults.get(url);
      // Tavily already fetched the page with the search; otherwise download it ourselves.
      const page = known?.content ? { title: known.title, text: known.content } : await fetchPage(url);
      const n = run.addSource(page.title, url, page.text);
      return `Source [${n}]: ${page.title}\n${url}\n\n${page.text}`;
    }
    if (tool === 'recall_memory') {
      const { texts, tokens } = await recallMemories(userId, String(input.query));
      run.embedTokens += tokens;
      return texts.length ? texts.map((t) => `- ${t}`).join('\n') : 'No saved memories match.';
    }
    if (tool === 'save_memory') {
      const { id, tokens } = await saveMemory(userId, String(input.text), threadId);
      run.embedTokens += tokens;
      return `Saved memory ${id}.`;
    }
    throw new Error(`tool ${tool} is not available in a quick search`);
  };

  const maxCalls = env.maxToolCalls;
  const maxMs = env.maxWallClockSec * 1000;
  let answer = '';

  try {
    const history = await database
      .collection<{ role: 'user' | 'assistant'; content: string }>('messages')
      .find({ threadId })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();
    await database.collection('messages').insertOne({
      _id: messageId() as never,
      threadId,
      userId,
      role: 'user',
      content: body.query,
      createdAt: new Date()
    });

    // ---- 1. retrieve: search the question and recall memories in parallel
    const [, memoryText] = await Promise.all([
      runTool('web_search', { query: body.query }, 'quick search: search the question as asked'),
      runTool('recall_memory', { query: body.query }, 'check saved preferences for this user')
    ]);
    const searchStep = run.steps.find((s) => s.tool === 'web_search')!;
    if (!searchStep.ok) throw new ProviderError(`web search failed: ${searchStep.error}`);

    const top = [...run.searchResults.values()].slice(0, PAGES_TO_FETCH);
    await Promise.all(top.map((r) => runTool('fetch_page', { url: r.url }, 'read a top result before citing it')));
    if (!run.sources.length && top.length) {
      // No page could be read: cite the search snippets instead, and say so in the trace.
      for (const r of top) if (r.snippet) run.addSource(r.title, r.url, r.snippet);
      searchStep.reason += ' (no page could be fetched; falling back to search snippets)';
    }

    // ---- 2. the loop
    const messages: Anthropic.MessageParam[] = history.reverse().map((m) => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: contextBlock(run) + `\n\nQuestion: ${body.query}` });
    const memories = memoryText.startsWith('- ') ? memoryText : '';

    const filter = citationFilter(run);
    const sendText = (text: string) => {
      if (!text) return;
      if (run.ttftMs === null) run.ttftMs = Date.now() - run.started;
      answer += text;
      emit('token', { text });
    };

    for (;;) {
      const toolCalls = run.steps.length;
      const capped = toolCalls >= maxCalls || Date.now() - run.started > maxMs;
      if (capped) run.terminated = 'cap';

      const stream = anthropic.messages.stream(
        {
          model: env.llmModel,
          max_tokens: 4096,
          system: systemPrompt(memories, capped),
          messages,
          tools: TOOLS,
          tool_choice: capped ? { type: 'none' } : { type: 'auto' },
          output_config: { effort: 'low' } // quick gear: answer fast, think little
        },
        { signal: abort.signal }
      );

      let answering = false;
      for await (const ev of stream) {
        openStream(); // the provider accepted the call
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          if (!answering) {
            answering = true;
            emit('sources', run.sources);
          }
          sendText(filter.push(ev.delta.text));
        }
      }
      const msg = await stream.finalMessage();
      run.tokensIn += msg.usage.input_tokens;
      run.tokensOut += msg.usage.output_tokens;

      const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (answering || !uses.length) {
        if (!answering) emit('sources', run.sources);
        sendText(filter.flush());
        break;
      }

      // The model asked for more tools. Run them (up to the cap) and go round again.
      messages.push({ role: 'assistant', content: msg.content });
      const results = await Promise.all(
        uses.map(async (u, i): Promise<Anthropic.ToolResultBlockParam> => {
          if (toolCalls + i >= maxCalls) {
            return { type: 'tool_result', tool_use_id: u.id, content: 'Tool-call cap reached.', is_error: true };
          }
          const name = u.name as AskTool;
          const out = await runTool(name, u.input as Record<string, unknown>, `model chose ${u.name}`);
          return { type: 'tool_result', tool_use_id: u.id, content: out, is_error: out.startsWith('ERROR:') };
        })
      );
      messages.push({ role: 'user', content: results });
    }
  } catch (err) {
    run.terminated = 'error';
    const message = (err as Error).message || 'provider error';
    log.error({ requestId, err: message }, 'ask failed');
    if (!open) res.status(502).json({ error: message, status: 502, requestId });
    else write('error', { status: 502, error: message });
  }

  // ---- 3. done, persist, log
  const latencyMs = Date.now() - run.started;
  const done: DoneEvent = {
    answerId: newId('ans'),
    latencyMs,
    ttftMs: run.ttftMs ?? latencyMs,
    model: env.llmModel,
    tokens: { in: run.tokensIn, out: run.tokensOut },
    costUsd: Number(run.costUsd().toFixed(6)),
    searchCached: run.searches > 0 && run.searchHits === run.searches,
    terminated: run.terminated,
    depth: 'quick',
    subQuestions: 0
  };
  if (run.terminated !== 'error') {
    write('done', done);
    await database.collection('messages').insertOne({
      _id: done.answerId.replace('ans_', 'msg_') as never,
      threadId,
      userId,
      role: 'assistant',
      content: answer,
      answerId: done.answerId,
      sources: run.sources,
      done,
      createdAt: new Date()
    });
  }
  if (open) res.end();

  await saveRun(run, done, res.statusCode);
  log.info(
    {
      requestId,
      toolCalls: run.steps.length,
      terminated: run.terminated,
      tokens: done.tokens,
      costUsd: done.costUsd,
      searchCached: done.searchCached,
      ttftMs: done.ttftMs,
      latencyMs
    },
    'answer'
  );
}

class ProviderError extends Error {}

const messageId = () => newId('ans').replace('ans_', 'msg_');

function systemPrompt(memories: string, capped: boolean): string {
  const lines = [
    `You are LUMINA, an answer engine. Today is ${new Date().toISOString().slice(0, 10)}.`,
    'Answer using ONLY the numbered sources in this conversation.',
    '- Cite every factual claim with its source number in square brackets, like [1] or [2][3]. Only use numbers of sources you were given.',
    '- If the sources do not answer the question, say so plainly and cite nothing.',
    '- If the sources are not enough, call web_search or fetch_page. When you call tools, write no text in that turn: any text you write is shown to the user as the final answer.',
    '- Call save_memory only when the user states a stable fact or preference about themselves.',
    '- Be concise: a direct answer first, then short supporting detail. Markdown is fine.'
  ];
  if (memories) lines.push(`\nSaved memories about this user (follow their preferences):\n${memories}`);
  if (capped) lines.push('\nYou have reached the tool limit. Answer now with what you have and say the answer may be incomplete.');
  return lines.join('\n');
}

function contextBlock(run: Run): string {
  if (!run.sources.length) return 'No sources were retrieved for this question.';
  const pages = run.sources.map((s) => `Source [${s.n}]: ${s.title}\n${s.url}\n\n${run.pageText.get(s.n)}`);
  const unread = [...run.searchResults.values()]
    .filter((r) => !run.sources.some((s) => s.url === r.url))
    .map((r) => `- ${r.title} (${r.url}): ${r.snippet}`);
  return (
    `Sources retrieved so far:\n\n${pages.join('\n\n---\n\n')}` +
    (unread.length ? `\n\nOther search results (not read yet, use fetch_page to read one):\n${unread.join('\n')}` : '')
  );
}

/** Drops any [n] that is not a source of this request, even when "[1" and "2]" arrive in different chunks. */
function citationFilter(run: Run) {
  let buf = '';
  const clean = (s: string) =>
    s.replace(/\[(\d{1,3})\]/g, (m, n: string) => (run.sources.some((src) => src.n === Number(n)) ? m : ''));
  return {
    push(text: string) {
      buf += text;
      const i = buf.lastIndexOf('[');
      let keep = '';
      if (i !== -1 && /^\[\d{0,3}$/.test(buf.slice(i))) {
        keep = buf.slice(i);
        buf = buf.slice(0, i);
      }
      const out = clean(buf);
      buf = keep;
      return out;
    },
    flush() {
      const out = clean(buf);
      buf = '';
      return out;
    }
  };
}

async function saveRun(run: Run, done: DoneEvent, status: number) {
  const runLog: RunLog = {
    tokens: run.tokensIn + run.tokensOut,
    wallClockSec: Number(((Date.now() - run.started) / 1000).toFixed(2)),
    costUsd: done.costUsd,
    terminated: run.terminated,
    depth: 'quick',
    toolCalls: run.steps.map((s) => ({ name: s.tool, ok: s.ok, ms: s.ms, ...(s.error ? { error: s.error } : {}) }))
  };
  writeFileSync(join(env.runsDir, `${run.requestId}.json`), JSON.stringify(runLog, null, 2));
  const database = await db();
  await database.collection('runs').insertOne({
    ...runLog,
    requestId: run.requestId,
    userId: run.userId,
    threadId: run.threadId,
    answerId: done.answerId,
    query: run.query,
    createdAt: new Date()
  });
  await database.collection('requests').insertOne({
    requestId: run.requestId,
    userId: run.userId,
    route: 'POST /threads/:threadId/ask',
    status,
    ms: done.latencyMs,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    costUsd: done.costUsd,
    toolCalls: run.steps.length,
    terminated: run.terminated,
    depth: 'quick',
    ttftMs: done.ttftMs,
    searches: run.searches,
    searchHits: run.searchHits,
    createdAt: new Date()
  });
}
