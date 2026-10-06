// Agent tests: memory (step 16), deep search (steps 20–22), /stats (step 23).
// Runs against the real stack: npm run dev:agent + npm run dev:gateway.
//
//   node "Test Cases/agent-scripts/run.mjs"                              memory + deep + stats
//   node "Test Cases/agent-scripts/run.mjs" --only memory
//   node "Test Cases/agent-scripts/run.mjs" --only deep,stats
//   node "Test Cases/agent-scripts/run.mjs" --only cap                   deep daily cap (spends cap × deep runs)
//
// Options: --url <gateway> (default http://localhost:8787) · --agent-url <agent> (default
// http://localhost:8000, for the "cap is in the agent" check) · --agent-log <file> (agent stdout
// saved with `npm run dev:agent 2>&1 | tee agent.log`, for the per-answer log line) ·
// --deep-query "<text>" · --yes-spend (allow the cap test when DEEP_DAILY_CAP > 3).
//
// Reuses benchmark/lib.mjs (imported, never edited) so the stream is read exactly as the grader reads it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { HttpError, ask, citationNumbers, makeClient, sleep } from '../../benchmark/lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

const BASE = val('--url', 'http://localhost:8787').replace(/\/$/, '');
const AGENT = val('--agent-url', 'http://localhost:8000').replace(/\/$/, '');
const AGENT_LOG = val('--agent-log', null);
const ONLY = new Set(val('--only', 'memory,deep,stats').split(','));
const LOCAL = /localhost|127\.0\.0\.1/.test(BASE);
const RUNS = join(ROOT, 'runs');

const sla = JSON.parse(readFileSync(join(ROOT, 'benchmark/sla.json'), 'utf8'));
const S = sla.sla ?? {};
const pick = (k, d) => S[k] ?? sla[k] ?? d;
const MIN_SUBS = pick('min_deep_sub_questions', 3);
const MAX_SUBS = 6;
const PLAN_MS = pick('deep_plan_p95_ms', 4000);
const DEEP_S = pick('deep_answer_p95_s', 90);
const RATIO = pick('min_deep_source_ratio', 2);
const DEEP_COST = pick('max_cost_per_deep_answer_usd', 0.35);
const QUICK_COST = pick('max_cost_per_answer_usd', 0.05);
const DEEP_QUERY =
  val('--deep-query', null) ?? JSON.parse(readFileSync(join(ROOT, 'benchmark/queries.json'), 'utf8')).deep[0];
const RETRIEVAL = ['web_search', 'fetch_page', 'search_documents'];

// ---------------------------------------------------------------- reporting

const results = [];
const record = (id, outcome, title, detail = '') => {
  results.push({ id, outcome });
  const tag = { PASS: '\x1b[32mPASS\x1b[0m', FAIL: '\x1b[31mFAIL\x1b[0m', WARN: '\x1b[33mWARN\x1b[0m', SKIP: '\x1b[90mSKIP\x1b[0m' }[outcome];
  console.log(`${tag}  ${id.padEnd(4)} ${title}${detail ? `\n          ${String(detail).split('\n').join('\n          ')}` : ''}`);
};
async function test(id, title, fn) {
  try {
    const r = await fn();
    if (r?.skip) return record(id, 'SKIP', title, r.skip);
    if (r?.warn) return record(id, 'WARN', title, r.warn);
    record(id, 'PASS', title, typeof r === 'string' ? r : '');
  } catch (err) {
    record(id, 'FAIL', title, err.message);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const need = (v, what) => {
  if (!v) throw new Error(`skipped: ${what} did not complete (see the failure above)`);
  return v;
};
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`);
const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 220 ? `${s.slice(0, 220)}…` : s;
};
const isoFuture = (s, maxMs) => {
  const t = Date.parse(s);
  return Number.isFinite(t) && t > Date.now() && t <= Date.now() + maxMs;
};

// ---------------------------------------------------------------- helpers

const fresh = (tag) => `t-${tag}-${randomUUID().slice(0, 6)}`;
const clientFor = (user, base = BASE) => makeClient({ target: base, userId: user, timeoutMs: 300000 });
const newThread = async (c) => (await c.post('/threads', {})).threadId;
const tools = (run) => (run.trace ?? []).map((t) => t.tool);
const distinct = (run) =>
  new Set((run.sources ?? []).map((s) => s.url ?? `${s.docId}:${s.locator?.page ?? s.locator?.heading ?? s.locator?.line ?? ''}`)).size;
const runLog = (rid) => {
  const f = join(RUNS, `${rid}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};
const stats = (c) => c.get('/stats');

/** Ask with an exact body (the bench helper always sends depth; this one can leave it out). */
async function askExact(user, threadId, body) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/threads/${threadId}/ask`, {
    method: 'POST',
    headers: { 'x-user-id': user, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const out = { status: res.status, requestId: res.headers.get('x-request-id'), ms: Date.now() - t0, order: [], trace: [], plan: null, sources: [], text: '', done: null };
  if (!res.ok) {
    out.body = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })();
    return out;
  }
  for (const frame of text.split('\n\n')) {
    const ev = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!ev || !data) continue;
    let d;
    try {
      d = JSON.parse(data);
    } catch {
      continue;
    }
    out.order.push(ev);
    if (ev === 'plan') out.plan = d;
    else if (ev === 'trace') out.trace.push(d);
    else if (ev === 'sources') out.sources = d;
    else if (ev === 'token') out.text += d.text ?? '';
    else if (ev === 'done') out.done = d;
  }
  return out;
}

// ================================================================ preflight

section(`Preflight · ${BASE}`);
try {
  const h = await (await fetch(`${BASE}/health`)).json();
  console.log(`health: ${h.status} · ${h.model} · ${h.searchProvider} · ${h.vectorStore} · db ${h.db}`);
  if (h.status !== 'ok') console.log('⚠ health is not ok: expect failures below');
} catch (err) {
  console.log(`Gateway not reachable at ${BASE}: ${err.message}\nStart npm run dev:agent and npm run dev:gateway first.`);
  process.exit(2);
}
if (!LOCAL) console.log('remote target: run-log checks (runs/*.json) are skipped');

const ctx = {};

// ================================================================ step 23 baseline

if (ONLY.has('stats')) {
  section('Step 23 · /stats shape');
  await test('T1', '/stats returns all 7 fields with the right types; fresh user has deepToday 0', async () => {
    const s = await stats(clientFor(fresh('stats')));
    const ints = ['requests', 'answers', 'deepToday', 'deepDailyCap'];
    const nums = ['searchCacheHitRatePct', 'ttftP95Ms', 'costUsdToday'];
    const bad = [
      ...ints.filter((k) => !Number.isInteger(s[k]) || s[k] < 0),
      ...nums.filter((k) => typeof s[k] !== 'number' || s[k] < 0)
    ];
    assert(!bad.length, `bad or missing: ${bad.join(', ')} in ${short(s)}`);
    assert(s.searchCacheHitRatePct <= 100, `searchCacheHitRatePct = ${s.searchCacheHitRatePct}`);
    assert(s.deepToday === 0, `fresh user deepToday = ${s.deepToday}`);
    assert(s.deepDailyCap >= 1, `deepDailyCap = ${s.deepDailyCap}`);
    ctx.cap = s.deepDailyCap;
    return `deepDailyCap ${s.deepDailyCap}, answers ${s.answers}, ttftP95 ${s.ttftP95Ms} ms, cache ${s.searchCacheHitRatePct}%`;
  });
}

// ================================================================ step 16: memory

if (ONLY.has('memory')) {
  section('Step 16 · memory');
  const user = fresh('mem');
  const c = clientFor(user);
  const PREF = 'I am vegetarian, so never suggest meat or fish.';
  const DINNER = 'Suggest one dinner recipe I could cook tonight.';

  await test('M1', 'new user: GET /memory → 200 {memories: []}', async () => {
    const r = await c.get('/memory');
    assert(Array.isArray(r?.memories) && r.memories.length === 0, short(r));
  });

  await test('M2', 'trivia is not remembered (no save_memory, /memory still empty)', async () => {
    const tu = fresh('trivia');
    const tc = clientFor(tu);
    const run = await ask(tc, await newThread(tc), { query: 'What is the boiling point of water at sea level in Celsius?', mode: 'web', userId: tu });
    const rows = (await tc.get('/memory')).memories;
    assert(!tools(run).includes('save_memory'), 'save_memory was called for a one-off fact');
    assert(rows.length === 0, `${rows.length} row(s) saved: ${short(rows)}`);
  });

  await test('M3', 'save: "remember…" → save_memory ok in the trace, row appears in GET /memory', async () => {
    const threadA = await newThread(c);
    const run = await ask(c, threadA, { query: `Remember this preference for all future answers: ${PREF}`, mode: 'web', userId: user });
    assert(!run.error, `stream error: ${short(run.error)}`);
    const step = run.trace.find((t) => t.tool === 'save_memory');
    const rows = (await c.get('/memory')).memories;
    assert(step, `no save_memory step; trace = ${tools(run).join(', ')}`);
    assert(step.ok, `save_memory failed: ${step.error}`);
    assert(rows.length >= 1, 'GET /memory is empty after the save');
    const row = rows.find((m) => /vegetarian/i.test(m.text)) ?? rows[0];
    assert(/^mem_/.test(row.id) && row.text && !Number.isNaN(Date.parse(row.createdAt)), `row shape: ${short(row)}`);
    assert(/vegetarian/i.test(row.text), `saved text does not carry the preference: "${row.text}"`);
    ctx.mem = { user, c, id: row.id, threadA, row };
    const srcNote = row.sourceThread === threadA ? '' : ` (sourceThread ${row.sourceThread ?? 'missing'}, expected ${threadA})`;
    return `saved ${row.id}: "${short(row.text)}"${srcNote}`;
  });

  await test('M4', 'recall in a NEW thread: recall_memory ok, and the answer honours the preference', async () => {
    const m = need(ctx.mem, 'M3');
    const run = await ask(c, await newThread(c), { query: DINNER, mode: 'web', userId: user });
    const step = run.trace.find((t) => t.tool === 'recall_memory');
    assert(step?.ok, step ? `recall_memory failed: ${step.error}` : `no recall_memory step; trace = ${tools(run).join(', ')}`);
    const veg = /vegetarian|meat[- ]free|plant[- ]based|tofu|lentil|chickpea|bean|paneer|halloumi|mushroom/i.test(run.text);
    const meat = /\b(chicken|beef|pork|bacon|lamb|salmon|tuna|shrimp|prawn|steak|turkey|fish)\b/i.test(run.text);
    m.recallText = run.text;
    if (meat && !/vegetarian/i.test(run.text)) throw new Error(`answer suggests meat/fish: "${short(run.text)}"`);
    if (!veg) return { warn: `recall ran, but the answer shows no clear vegetarian cue; read it yourself:\n"${short(run.text)}"` };
    return `"${short(run.text.slice(0, 120))}"`;
  });

  await test('M5', 'isolation: another user cannot see or delete the memory', async () => {
    const m = need(ctx.mem, 'M3');
    const other = clientFor(fresh('other'));
    const theirs = (await other.get('/memory')).memories;
    assert(!theirs.some((r) => r.id === m.id), "another user's GET /memory lists it");
    let status = 0;
    try {
      await other.del(`/memory/${m.id}`);
      status = 204;
    } catch (err) {
      status = err instanceof HttpError ? err.status : 0;
    }
    assert(status === 404, `another user's DELETE → ${status} (want 404)`);
    const still = (await c.get('/memory')).memories.some((r) => r.id === m.id);
    assert(still, "the owner's memory disappeared after someone else's DELETE");
  });

  await test('M6', 'delete: DELETE → 204, gone from GET /memory, second DELETE → 404', async () => {
    const m = need(ctx.mem, 'M3');
    const r = await c.raw('DELETE', `/memory/${m.id}`);
    assert(r.status === 204, `DELETE → ${r.status}`);
    const rows = (await c.get('/memory')).memories;
    assert(!rows.some((x) => x.id === m.id), 'row still listed after DELETE');
    const again = await c.raw('DELETE', `/memory/${m.id}`);
    assert(again.status === 404, `second DELETE → ${again.status}`);
    m.deleted = true;
  });

  await test('M7', 'after delete, a fresh thread no longer reflects the preference', async () => {
    const m = need(ctx.mem?.deleted && ctx.mem, 'M6');
    const leftover = (await c.get('/memory')).memories.filter((x) => /vegetarian/i.test(x.text));
    assert(!leftover.length, `another vegetarian row is still saved (${leftover.map((x) => x.id).join(', ')}), so the effect cannot disappear`);
    const run = await ask(c, await newThread(c), { query: DINNER, mode: 'web', userId: user });
    const refers = /(since|because|as) you('| a)re (a )?vegetarian|you are (a )?vegetarian|your vegetarian|as a vegetarian|your (saved )?preference/i.test(run.text);
    assert(!refers, `the answer still refers to the deleted preference: "${short(run.text)}"`);
    return 'no reference to the deleted preference';
  });

  await test('M8', 'unknown memory id → 404', async () => {
    const r = await c.raw('DELETE', '/memory/mem_doesnotexist');
    assert(r.status === 404, `→ ${r.status}`);
  });
}

// ================================================================ steps 20–22: deep search

if (ONLY.has('deep')) {
  section('Steps 20–22 · deep search');
  const user = fresh('deep');
  const c = clientFor(user);
  console.log(`question: "${DEEP_QUERY}"`);

  let before;
  try {
    before = await stats(c);
  } catch {}

  try {
    ctx.quick = await ask(c, await newThread(c), { query: DEEP_QUERY, mode: 'web', depth: 'quick', userId: user });
  } catch (err) {
    console.log(`quick baseline failed: ${err.message}`);
  }
  let deepErr = null;
  try {
    ctx.deepThread = await newThread(c);
    ctx.deep = await ask(c, ctx.deepThread, { query: DEEP_QUERY, mode: 'web', depth: 'deep', userId: user });
  } catch (err) {
    deepErr = err;
  }
  ctx.deepUser = user;
  ctx.deepBefore = before;

  await test('D0', 'deep ask streams (not 501 / 429 / 502)', () => {
    assert(!deepErr, `deep ask → ${deepErr?.status ?? ''} ${short(deepErr?.body ?? deepErr?.message)}`);
    assert(!ctx.deep.error, `stream error event: ${short(ctx.deep.error)}`);
    assert(ctx.deep.done, `no done event; order = ${ctx.deep.order.join(' → ')}`);
    return `${(ctx.deep.latencyMs / 1000).toFixed(1)} s, ${ctx.deep.trace.length} steps, ${ctx.deep.sources.length} sources`;
  });

  const deep = () => need(ctx.deep?.done && ctx.deep, 'D0');

  await test('D1', 'plan is streamed BEFORE any retrieval (only recall_memory may precede it)', () => {
    const d = deep();
    assert(d.plan, 'no plan event');
    assert(d.planBeforeRetrieval === true, 'a retrieval step (web_search / fetch_page / search_documents) came before the plan');
    const iPlan = d.order.indexOf('plan');
    const tracesBefore = d.order.slice(0, iPlan).filter((e) => e === 'trace').length;
    const early = d.trace.slice(0, tracesBefore).map((t) => t.tool);
    const odd = early.filter((t) => !['recall_memory', 'plan_research'].includes(t));
    assert(!odd.length, `before the plan: ${early.join(', ')}`);
    assert(!d.order.slice(0, iPlan).some((e) => e === 'sources' || e === 'token'), `order: ${d.order.slice(0, iPlan + 1).join(' → ')}`);
  });

  await test('D2', `plan has ${MIN_SUBS}–${MAX_SUBS} sub-questions, numbered 1..n, each with a one-line reason`, () => {
    const subs = deep().plan.subQuestions ?? [];
    assert(subs.length >= MIN_SUBS && subs.length <= MAX_SUBS, `${subs.length} sub-questions`);
    assert(subs.every((s, k) => s.i === k + 1), `numbering: ${subs.map((s) => s.i).join(', ')}`);
    assert(subs.every((s) => s.question?.trim()), 'a sub-question has no text');
    const noReason = subs.filter((s) => !s.reason?.trim() || /\n/.test(s.reason.trim()) || s.reason.length > 240);
    assert(!noReason.length, `sub-question(s) ${noReason.map((s) => s.i).join(', ')} lack a one-line reason`);
    const dup = subs.length !== new Set(subs.map((s) => s.question.trim().toLowerCase())).size;
    assert(!dup, 'duplicate sub-questions');
    return subs.map((s) => `${s.i}. ${s.question}  (${s.reason})`).join('\n');
  });

  await test('D3', `plan arrives in < ${PLAN_MS} ms (deep's first paint)`, () => {
    const d = deep();
    assert(d.planMs < PLAN_MS, `plan at ${d.planMs} ms`);
    return `${d.planMs} ms`;
  });

  await test('D4', 'every retrieval step carries a valid subQuestion; every sub-question is researched', () => {
    const d = deep();
    const n = d.plan.subQuestions.length;
    const steps = d.trace.filter((t) => RETRIEVAL.includes(t.tool));
    assert(steps.length, 'no retrieval steps at all');
    const bad = steps.filter((t) => !Number.isInteger(t.subQuestion) || t.subQuestion < 1 || t.subQuestion > n);
    assert(!bad.length, `${bad.length} retrieval step(s) without a valid subQuestion: ${short(bad.map((t) => `${t.step}:${t.tool}:${t.subQuestion}`))}`);
    const covered = new Set(steps.map((t) => t.subQuestion));
    const missing = d.plan.subQuestions.map((s) => s.i).filter((i) => !covered.has(i));
    assert(!missing.length, `sub-question(s) ${missing.join(', ')} never researched`);
    const failed = d.trace.filter((t) => t.ok === false && !t.error?.trim());
    assert(!failed.length, 'a failed step has no error string (A1)');
  });

  await test('D5', 'merged sources: numbered 1..N once each, deduped, each tagged with its subQuestion', () => {
    const d = deep();
    const n = d.plan.subQuestions.length;
    const src = d.sources;
    assert(src.length, 'no sources');
    const ns = src.map((s) => s.n);
    assert(ns.every((v, k) => v === k + 1), `numbering: ${ns.join(', ')}`);
    const urls = src.filter((s) => s.url).map((s) => s.url);
    assert(urls.length === new Set(urls).size, 'duplicate url in sources (dedupe failed)');
    const docs = src.filter((s) => s.docId).map((s) => `${s.docId}:${JSON.stringify(s.locator ?? {})}`);
    assert(docs.length === new Set(docs).size, 'duplicate docId+locator in sources');
    const untagged = src.filter((s) => !Number.isInteger(s.subQuestion) || s.subQuestion < 1 || s.subQuestion > n);
    assert(!untagged.length, `source(s) ${untagged.map((s) => s.n).join(', ')} lack a valid subQuestion`);
    const shape = src.filter((s) => !s.title || !s.snippet || (s.kind === 'web' && !s.url) || (s.kind === 'doc' && !s.docId));
    assert(!shape.length, `source(s) ${shape.map((s) => s.n).join(', ')} break the Source schema`);
  });

  await test('D6', 'every [n] in the deep answer resolves to a source', () => {
    const d = deep();
    const have = new Set(d.sources.map((s) => s.n));
    const cited = citationNumbers(d.text);
    assert(cited.length, 'the answer cites nothing');
    const dangling = cited.filter((x) => !have.has(x));
    assert(!dangling.length, `[${dangling.join('], [')}] have no source`);
    return `${cited.length} distinct citations over ${d.sources.length} sources`;
  });

  await test('D7', `deep reads ≥ ${RATIO}× the distinct sources of the same question run quick`, () => {
    const d = deep();
    const q = need(ctx.quick?.done && ctx.quick, 'the quick baseline');
    const ratio = distinct(d) / Math.max(1, distinct(q));
    assert(ratio >= RATIO, `deep ${distinct(d)} vs quick ${distinct(q)} = ${ratio.toFixed(2)}×`);
    return `deep ${distinct(d)} vs quick ${distinct(q)} = ${ratio.toFixed(1)}×`;
  });

  await test('D8', 'done: depth deep, subQuestions = plan size, terminated done, within budget', () => {
    const d = deep();
    const dn = d.done;
    assert(dn.depth === 'deep', `done.depth = ${dn.depth}`);
    assert(dn.subQuestions === d.plan.subQuestions.length, `done.subQuestions ${dn.subQuestions} vs plan ${d.plan.subQuestions.length}`);
    assert(dn.costUsd <= DEEP_COST, `cost $${dn.costUsd} > $${DEEP_COST}`);
    assert(d.trace.length <= 24, `${d.trace.length} tool calls > 24`);
    assert(d.latencyMs <= DEEP_S * 1000, `${(d.latencyMs / 1000).toFixed(1)} s > ${DEEP_S} s`);
    const plans = d.trace.filter((t) => t.tool === 'plan_research');
    assert(plans.length === 1 && plans[0].ok, `plan_research steps: ${plans.length}`);
    if (dn.terminated === 'cap') return { warn: 'terminated: cap. Allowed (an honest partial), but a normal question should finish as done' };
    assert(dn.terminated === 'done', `terminated = ${dn.terminated}`);
    return `$${dn.costUsd} · ${d.trace.length} calls · ${(d.latencyMs / 1000).toFixed(1)} s`;
  });

  await test('D9', 'structured answer: direct answer, a section per sub-question, what is still unknown', () => {
    const d = deep();
    const heads = d.text.split('\n').filter((l) => /^\s*(#{1,4}\s+\S|\*\*[^*]+\*\*\s*:?\s*$)/.test(l));
    const unknown = /unknown|open question|still unclear|uncertain|not (yet )?(known|clear)|gaps?\b|limitations?/i.test(d.text);
    const want = Math.min(d.plan.subQuestions.length, MIN_SUBS);
    if (heads.length < want || !unknown)
      return { warn: `${heads.length} section heading(s) (want ≥ ${want}), "still unknown" part: ${unknown ? 'yes' : 'no'}. This is a Should, and the human grader reads it` };
    return `${heads.length} headings, has a "still unknown" part`;
  });

  await test('D10', 'run logs: deep run has depth deep + plan_research; quick baseline has neither', () => {
    if (!LOCAL) return { skip: 'remote target' };
    const d = deep();
    const log = runLog(d.requestId);
    assert(log, `no runs/${d.requestId}.json`);
    assert(log.depth === 'deep', `runlog depth = ${log.depth}`);
    assert(log.terminated === d.done.terminated, `runlog terminated ${log.terminated} vs done ${d.done.terminated}`);
    assert(log.toolCalls.length <= 24 && log.wallClockSec <= 240 && log.costUsd <= DEEP_COST, `budget: ${log.toolCalls.length} calls, ${log.wallClockSec} s, $${log.costUsd}`);
    assert(log.toolCalls.some((t) => t.name === 'plan_research'), 'runlog has no plan_research call');
    assert(Math.abs(log.costUsd - d.done.costUsd) < 1e-6, `runlog cost ${log.costUsd} vs done ${d.done.costUsd}`);
    const ql = ctx.quick?.requestId && runLog(ctx.quick.requestId);
    if (ql) assert(ql.depth === 'quick' && !ql.toolCalls.some((t) => t.name === 'plan_research'), `quick runlog: depth ${ql.depth}, plan_research ${ql.toolCalls.some((t) => t.name === 'plan_research')}`);
  });

  await test('D11', 'the thread keeps the deep answer (sources + depth) for follow-ups', async () => {
    const d = deep();
    const t = await c.get(`/threads/${ctx.deepThread}`);
    const last = [...(t.messages ?? [])].reverse().find((m) => m.role === 'assistant');
    assert(last, 'no assistant message stored');
    assert((last.sources ?? []).length === d.sources.length, `stored ${last.sources?.length ?? 0} sources, streamed ${d.sources.length}`);
    if (last.done?.depth !== 'deep') return { warn: `stored done.depth = ${last.done?.depth}` };
    if (!JSON.stringify(t).includes('subQuestions')) return { warn: 'the plan is not stored with the thread (SPEC 5.3 says the thread keeps the plan it ran)' };
  });

  await test('D12', 'quick NEVER escalates: no depth sent + a "research in depth" question → quick, no plan', async () => {
    const u = fresh('esc');
    const ec = clientFor(u);
    const tid = await newThread(ec);
    const sBefore = ONLY.has('stats') ? await stats(ec) : null;
    const r = await askExact(u, tid, {
      query: 'Research this in depth with several sub-questions: compare Kafka, RabbitMQ and NATS on cost, latency and operations.',
      mode: 'web'
    });
    ctx.esc = { r, sBefore, ec };
    assert(r.status === 200 && r.done, `→ ${r.status} ${short(r.body)}`);
    assert(!r.order.includes('plan'), 'a plan event was streamed on a quick run');
    assert(!tools(r).includes('plan_research'), 'plan_research in a quick trace (red line)');
    assert(r.done.depth === 'quick' && !r.done.subQuestions, `done.depth ${r.done.depth}, subQuestions ${r.done.subQuestions}`);
    assert(r.trace.length <= 8, `${r.trace.length} tool calls > quick cap 8`);
    assert(r.done.costUsd <= QUICK_COST, `cost $${r.done.costUsd} > $${QUICK_COST}`);
    return `${r.trace.length} calls, $${r.done.costUsd}`;
  });
}

// ================================================================ step 23: stats after activity

if (ONLY.has('stats') && ONLY.has('deep')) {
  section('Step 23 · /stats reconciles');
  await sleep(1000);

  await test('T2', 'deepToday: 0 → 1 for the deep user after one deep run (the quick baseline does not count)', async () => {
    need(ctx.deep?.done, 'D0');
    const s = await stats(clientFor(ctx.deepUser));
    assert(ctx.deepBefore?.deepToday === 0, `before = ${ctx.deepBefore?.deepToday}`);
    assert(s.deepToday === 1, `after = ${s.deepToday}`);
  });

  await test('T3', 'deepToday is per user (other users still 0)', async () => {
    const s = await stats(clientFor(fresh('x')));
    assert(s.deepToday === 0, `fresh user deepToday = ${s.deepToday}`);
  });

  await test('T4', 'answers +1 and costUsdToday +done.costUsd after one quick ask', async () => {
    const e = need(ctx.esc?.r?.done && ctx.esc, 'D12');
    const after = await stats(e.ec);
    const dA = after.answers - e.sBefore.answers;
    const dC = after.costUsdToday - e.sBefore.costUsdToday;
    const msg = `answers +${dA}, cost +$${dC.toFixed(4)} (answer cost $${e.r.done.costUsd})`;
    if (dA !== 1 || Math.abs(dC - e.r.done.costUsd) > 0.0002)
      return { warn: `${msg}. Fine if something else was using the stack at the same time; otherwise /stats does not reconcile` };
    return msg;
  });

  await test('T5', 'ttftP95Ms is positive and plausible', async () => {
    const s = await stats(clientFor(fresh('t5')));
    assert(s.ttftP95Ms > 0 && s.ttftP95Ms < 60000, `ttftP95Ms = ${s.ttftP95Ms}`);
    return `${s.ttftP95Ms} ms`;
  });

  await test('T6', 'agent logs one "answer" line per answer with the 8 required fields', () => {
    if (!AGENT_LOG) return { skip: 'pass --agent-log agent.log (start the agent with: npm run dev:agent 2>&1 | tee agent.log)' };
    const d = need(ctx.deep?.done && ctx.deep, 'D0');
    const lines = readFileSync(AGENT_LOG, 'utf8')
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((o) => o && o.requestId === d.requestId && ('ttftMs' in o || 'latencyMs' in o));
    assert(lines.length === 1, `${lines.length} answer line(s) for ${d.requestId}`);
    const o = lines[0];
    const miss = ['requestId', 'toolCalls', 'terminated', 'tokens', 'costUsd', 'searchCached', 'ttftMs', 'latencyMs'].filter((k) => !(k in o));
    assert(!miss.length, `missing ${miss.join(', ')}`);
    assert(o.terminated === d.done.terminated && Math.abs(o.costUsd - d.done.costUsd) < 1e-6, `log ${o.terminated}/$${o.costUsd} vs done ${d.done.terminated}/$${d.done.costUsd}`);
  });
}

// ================================================================ step 22: deep daily cap

if (ONLY.has('cap')) {
  section('Step 22 · deep daily cap');
  const user = fresh('cap');
  const c = clientFor(user);
  const s0 = await stats(c);
  const K = s0.deepDailyCap;
  console.log(`DEEP_DAILY_CAP = ${K}: this spends ${K} deep run(s), roughly $${(K * 0.3).toFixed(2)} at most`);

  if (K > 3 && !flag('--yes-spend')) {
    record('C*', 'SKIP', 'cap tests', `cap is ${K}. Restart the agent with DEEP_DAILY_CAP=2 for a cheap test, or pass --yes-spend`);
  } else {
    const tid = await newThread(c);
    const okRuns = [];
    await test('C1', `the first ${K} deep searches are accepted`, async () => {
      for (let i = 0; i < K; i++) {
        const r = await ask(c, tid, { query: `cap probe ${i}: what is reciprocal rank fusion?`, mode: 'web', depth: 'deep', userId: user });
        assert(r.done, `deep #${i + 1}: no done (${short(r.error)})`);
        okRuns.push(r);
      }
    });

    let capped;
    await test('C2', `deep search #${K + 1} → 429 {error, resetsAt}`, async () => {
      const r = await askExact(user, tid, { query: 'cap probe over the limit', mode: 'web', depth: 'deep' });
      capped = r;
      assert(r.status === 429, `→ ${r.status} ${short(r.body ?? r.order)}`);
      assert(typeof r.body?.error === 'string' && r.body.error, `body ${short(r.body)}`);
      assert(isoFuture(r.body.resetsAt, 25 * 3600_000), `resetsAt = ${r.body?.resetsAt}`);
      return `resetsAt ${r.body.resetsAt}`;
    });

    await test('C3', 'the 429 is decided before any spend (fast, no run log)', () => {
      const r = need(capped?.status === 429 && capped, 'C2');
      assert(r.ms < 1500, `429 took ${r.ms} ms (planning or searching before checking the cap?)`);
      if (LOCAL && r.requestId) assert(!runLog(r.requestId), `runs/${r.requestId}.json was written for a refused request`);
      return `${r.ms} ms`;
    });

    await test('C4', 'the capped user can still ask quick questions', async () => {
      const r = await askExact(user, tid, { query: 'What is reciprocal rank fusion?', mode: 'web', depth: 'quick' });
      assert(r.status === 200 && r.done?.depth === 'quick', `quick → ${r.status}`);
    });

    await test('C5', 'the cap is enforced in the AGENT (direct call to the agent, skipping the gateway, → 429)', async () => {
      let res;
      try {
        res = await fetch(`${AGENT}/threads/${tid}/ask`, {
          method: 'POST',
          headers: { 'x-user-id': user, 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'bypass the gateway', mode: 'web', depth: 'deep' }),
          signal: AbortSignal.timeout(10000)
        });
      } catch {
        return { skip: `agent not reachable at ${AGENT} (expected when it is private on Fly)` };
      }
      const body = await res.text();
      assert(res.status === 429, `agent → ${res.status} ${short(body)}: the cap lives only in the gateway`);
    });

    await test('C6', `/stats deepToday = ${K} (refused attempts are not counted)`, async () => {
      await sleep(800);
      const s = await stats(c);
      assert(s.deepToday === K && s.deepDailyCap === K, `deepToday ${s.deepToday}, deepDailyCap ${s.deepDailyCap}`);
    });

    await test('C7', 'the cap is per user: a different user still has deepToday 0', async () => {
      const s = await stats(clientFor(fresh('cap2')));
      assert(s.deepToday === 0, `deepToday = ${s.deepToday}`);
    });
  }
}

// ================================================================ summary

const n = (o) => results.filter((r) => r.outcome === o).length;
console.log(`\n${n('PASS')} passed · ${n('FAIL')} failed · ${n('WARN')} warn · ${n('SKIP')} skipped  (${[...ONLY].join(',')})`);
process.exit(n('FAIL') ? 1 : 0);
