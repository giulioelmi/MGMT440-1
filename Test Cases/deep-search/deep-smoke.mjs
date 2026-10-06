#!/usr/bin/env node
/**
 * Deep search smoke test (checklist steps 20–23), against the running gateway.
 *
 *   node "Test Cases/deep-search/deep-smoke.mjs" ["your question"]
 *
 * Asks the same question quick, then deep, as a throwaway user, and checks what the
 * benchmark checks: the plan arrives first and fast, 3–6 sub-questions, every retrieval
 * step and source tagged with its subQuestion, one contiguous numbering, every [n] resolves,
 * ≥ 2× quick's distinct sources, cost and call budget, done carries depth and subQuestions,
 * and /stats counts the run. Env: GATEWAY (default http://localhost:8787).
 */
const BASE = process.env.GATEWAY ?? 'http://localhost:8787';
const QUESTION =
  process.argv[2] ??
  'How do Server-Sent Events, WebSockets and long polling compare for streaming an LLM answer, and what breaks in each behind a CDN?';
const USER = `smoke-${Date.now().toString(36)}`;
const RETRIEVAL = ['web_search', 'fetch_page', 'search_documents'];

const headers = { 'x-user-id': USER, 'content-type': 'application/json' };
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function ask(depth) {
  const thread = await (await fetch(`${BASE}/threads`, { method: 'POST', headers, body: '{}' })).json();
  const started = Date.now();
  const res = await fetch(`${BASE}/threads/${thread.threadId}/ask`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: QUESTION, mode: 'web', depth })
  });
  if (!res.ok) throw new Error(`${depth}: HTTP ${res.status} ${await res.text()}`);

  const out = { order: [], trace: [], sources: [], text: '', plan: null, planMs: null, done: null, error: null, sawRetrievalBeforePlan: false };
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (!event || !data) continue;
      const d = JSON.parse(data);
      out.order.push(event);
      if (event === 'plan') {
        out.plan = d;
        out.planMs = Date.now() - started;
        out.sawRetrievalBeforePlan = out.trace.some((t) => RETRIEVAL.includes(t.tool));
      } else if (event === 'trace') out.trace.push(d);
      else if (event === 'sources') out.sources = d;
      else if (event === 'token') out.text += d.text;
      else if (event === 'done') out.done = d;
      else if (event === 'error') out.error = d;
    }
  }
  return out;
}

const distinct = (a) => new Set(a.sources.map((s) => s.url ?? `${s.docId}:${s.locator?.page ?? s.locator?.heading ?? ''}`)).size;

console.log(`gateway ${BASE} · user ${USER}\nquestion: ${QUESTION}\n`);

console.log('quick (baseline)…');
const quick = await ask('quick');
check(!quick.error && quick.done, 'quick finished', quick.error?.error ?? `${distinct(quick)} distinct sources`);
check(!quick.trace.some((t) => t.tool === 'plan_research'), 'quick never calls plan_research');

console.log('\ndeep…');
const deep = await ask('deep');
if (deep.error) console.log(`  stream error: ${deep.error.status} ${deep.error.error}`);
const subs = deep.plan?.subQuestions ?? [];

console.log('\nplan:');
for (const q of subs) console.log(`  ${q.i}. ${q.question}${q.reason ? `\n     why: ${q.reason}` : ''}`);
console.log('\nchecks:');
check(deep.order[0] === 'plan', 'plan is the first event', `order starts ${deep.order.slice(0, 3).join(' → ')}`);
check(!deep.sawRetrievalBeforePlan, 'no retrieval before the plan');
const planStep = deep.trace.find((t) => t.tool === 'plan_research');
check(deep.planMs !== null && deep.planMs <= 4000, 'plan within 4 s', `${deep.planMs} ms (planner call ${planStep?.ms ?? '?'} ms)`);
check(subs.length >= 3 && subs.length <= 6, '3–6 sub-questions', `${subs.length}`);
const untaggedSteps = deep.trace.filter((t) => RETRIEVAL.includes(t.tool) && !Number.isInteger(t.subQuestion));
check(untaggedSteps.length === 0, 'every retrieval step has a subQuestion', `${untaggedSteps.length} untagged`);
const untaggedSources = deep.sources.filter((s) => !Number.isInteger(s.subQuestion));
check(deep.sources.length > 0 && untaggedSources.length === 0, 'every source has a subQuestion', `${deep.sources.length} sources, ${untaggedSources.length} untagged`);
const ns = deep.sources.map((s) => s.n);
check(ns.every((n, k) => n === k + 1), 'one contiguous numbering from 1', `[${ns.join(',')}]`);
const urls = deep.sources.filter((s) => s.url).map((s) => s.url);
check(new Set(urls).size === urls.length, 'no duplicate URLs');
const cited = [...new Set([...deep.text.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])))];
const dangling = cited.filter((n) => !ns.includes(n));
check(cited.length > 0 && dangling.length === 0, 'every [n] resolves to a source', `${cited.length} cited, ${dangling.length} dangling`);
const ratio = distinct(quick) ? distinct(deep) / distinct(quick) : 0;
check(ratio >= 2, 'deep reads ≥ 2× quick', `${distinct(deep)} vs ${distinct(quick)} = ${ratio.toFixed(1)}×`);
check(/##\s*What is still unknown/i.test(deep.text), 'structured: has a "What is still unknown" section');
check(deep.trace.length <= 24, '≤ 24 tool calls', `${deep.trace.length}`);
check(deep.done?.depth === 'deep' && deep.done?.subQuestions === subs.length, 'done carries depth + subQuestions', JSON.stringify({ depth: deep.done?.depth, subQuestions: deep.done?.subQuestions }));
check((deep.done?.costUsd ?? 1) <= 0.35, 'cost ≤ $0.35', `$${deep.done?.costUsd}`);
check((deep.done?.latencyMs ?? Infinity) <= 90_000, 'full answer ≤ 90 s', `${((deep.done?.latencyMs ?? 0) / 1000).toFixed(1)} s, first token ${deep.done?.ttftMs} ms`);

const stats = await (await fetch(`${BASE}/stats`, { headers })).json();
check(stats.deepToday === 1, '/stats counts the deep run', `deepToday ${stats.deepToday} / cap ${stats.deepDailyCap}`);

console.log('\nsources by sub-question:');
for (const q of subs) {
  const found = deep.sources.filter((s) => s.subQuestion === q.i);
  console.log(`  ${q.i}: ${found.map((s) => `[${s.n}] ${new URL(s.url ?? 'http://doc').hostname}`).join(', ') || '(none)'}`);
}
console.log(`\n---- deep answer ----\n${deep.text}\n---------------------`);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
