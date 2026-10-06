#!/usr/bin/env node
/**
 * Deep spend gate (checklist step 22), against the running gateway. The cap only counts
 * deep asks that get past validation, so this sends real ones and costs about DEEP_DAILY_CAP
 * deep answers (~$0.10–0.20 each). To keep it cheap, start the agent with a small cap:
 *
 *   DEEP_DAILY_CAP=2 npm run dev:agent
 *   node "Test Cases/deep-search/deep-cap.mjs"
 *
 * Expected: 2 runs accepted, the 3rd is 429 with resetsAt, and /stats shows deepToday 2.
 * Env: GATEWAY (default http://localhost:8787).
 */
const BASE = process.env.GATEWAY ?? 'http://localhost:8787';
const USER = `cap-${Date.now().toString(36)}`;
const headers = { 'x-user-id': USER, 'content-type': 'application/json' };

const stats0 = await (await fetch(`${BASE}/stats`, { headers })).json();
const cap = stats0.deepDailyCap;
console.log(`user ${USER} · deepDailyCap ${cap}`);
if (cap > 3) console.log(`  (cap is ${cap}: this will run ${cap} real deep searches. Ctrl+C and restart the agent with DEEP_DAILY_CAP=2 to keep it cheap.)`);

const thread = await (await fetch(`${BASE}/threads`, { method: 'POST', headers, body: '{}' })).json();
for (let i = 1; i <= cap + 1; i++) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/threads/${thread.threadId}/ask`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: `cap probe ${i}: what is reciprocal rank fusion?`, mode: 'web', depth: 'deep' })
  });
  if (res.status === 429) {
    const body = await res.json();
    const ok = i === cap + 1 && Boolean(body.resetsAt);
    console.log(`  ${ok ? '✓' : '✗'} request ${i}: 429 ${JSON.stringify(body)}`);
    const stats = await (await fetch(`${BASE}/stats`, { headers })).json();
    console.log(`  ${stats.deepToday === cap ? '✓' : '✗'} /stats deepToday ${stats.deepToday} / ${stats.deepDailyCap}`);
    process.exit(ok && stats.deepToday === cap ? 0 : 1);
  }
  await res.text();
  console.log(`  · request ${i}: ${res.status} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
console.log(`  ✗ ${cap + 1} deep searches all accepted: the cap is not enforced`);
process.exit(1);
