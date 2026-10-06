// Gateway test runner (checklist steps 24–29).
//
//   node "Test Cases/gateway-scripts/run.mjs" --mode static
//   node "Test Cases/gateway-scripts/run.mjs" --mode mock   [--slow]
//   node "Test Cases/gateway-scripts/run.mjs" --mode live   [--url http://localhost:8787] [--no-upload]
//
// mock: starts a fake agent (:8001) and the gateway itself (:8788 → mock, :8789 → dead agent).
// live: the real stack must already be running (npm run dev:agent + npm run dev:gateway).
import { spawn, execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockAgent } from './mock-agent.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GW_DIR = join(ROOT, 'backend/gateway');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const MODE = val('--mode', 'mock');

const MOCK_PORT = 8001;
const GW_PORT = 8788;
const DEAD_GW_PORT = 8789;
const DEAD_AGENT_PORT = 8002;
const RATE = 5;
const ORIGIN = 'http://localhost:5173';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------- reporting

const results = [];
const record = (id, outcome, title, detail = '') => {
  results.push({ id, outcome, title, detail });
  const tag = { PASS: '\x1b[32mPASS\x1b[0m', FAIL: '\x1b[31mFAIL\x1b[0m', WARN: '\x1b[33mWARN\x1b[0m', SKIP: '\x1b[90mSKIP\x1b[0m' }[outcome];
  console.log(`${tag}  ${id.padEnd(4)} ${title}${detail ? `\n          ${detail}` : ''}`);
};
async function test(id, title, fn) {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && r.skip) return record(id, 'SKIP', title, r.skip);
    if (r && typeof r === 'object' && r.warn) return record(id, 'WARN', title, r.warn);
    record(id, 'PASS', title, typeof r === 'string' ? r : '');
  } catch (err) {
    record(id, 'FAIL', title, err.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

// ---------------------------------------------------------------- http helpers

let BASE = '';
const uid = () => `t-${randomUUID().slice(0, 8)}`;

async function call(method, path, { user = uid(), body, rawBody, headers = {}, base = BASE, signal } = {}) {
  const h = { ...headers };
  if (user !== null) h['x-user-id'] = user;
  let payload;
  if (rawBody !== undefined) payload = rawBody;
  else if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload, signal });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: json stays null and callers read .text.
  }
  return { status: res.status, headers: res.headers, text, json };
}

// node:http request that survives the server answering before the body is fully sent.
function rawRequest(method, url, headers, body) {
  return new Promise((resolveP, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolveP({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (err) => (err.code === 'EPIPE' || err.code === 'ECONNRESET' ? null : reject(err)));
    req.end(body);
  });
}

const isErrorBody = (j, status) =>
  j && typeof j.error === 'string' && j.error.length > 0 && (j.status === undefined || j.status === status);

// ---------------------------------------------------------------- mock control

const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const mockLog = async () => (await fetch(`${MOCK}/__log`)).json();
const mockReset = () => fetch(`${MOCK}/__reset`, { method: 'POST' });
const mockNext = (o) => fetch(`${MOCK}/__next`, { method: 'POST', body: JSON.stringify(o) });
const callsFor = async (user) => (await mockLog()).filter((r) => r.headers['x-user-id'] === user);

// ---------------------------------------------------------------- gateway process

const gwLogs = [];
const children = [];
function startGateway(port, agentUrl, sink) {
  const child = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: GW_DIR,
    env: {
      ...process.env,
      PORT_GATEWAY: String(port),
      PORT: String(port),
      AGENT_URL: agentUrl,
      CORS_ORIGINS: ORIGIN,
      RATE_LIMIT_PER_MINUTE: String(RATE),
      LOG_LEVEL: 'info'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  let buf = '';
  const onData = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (sink) sink.push(line);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return child;
}
async function waitUp(base, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await sleep(300);
    }
  }
  return false;
}
const cleanup = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const parsedLogs = () =>
  gwLogs
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
const completionLinesFor = (rid) =>
  parsedLogs().filter((o) => o.requestId === rid && (o.responseTime !== undefined || o.res || o.ms !== undefined));

// ================================================================ STATIC

async function runStatic() {
  section('Static checks');
  const src = readdirSync(join(GW_DIR, 'src'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({
      f,
      text: readFileSync(join(GW_DIR, 'src', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
    }));
  const grep = (re) => src.filter(({ text }) => re.test(text)).map(({ f }) => f);

  await test('S1', 'no edits in web/ packages/contract/ benchmark/ eval/ quality/ scripts/', () => {
    const out = execSync('git status --porcelain -- web packages/contract benchmark eval quality scripts', { cwd: ROOT }).toString().trim();
    assert(!out, `changed protected files:\n${out}`);
  });
  await test('S2', 'no compression in the gateway', () => {
    const hits = grep(/from\s+['"]compression['"]|require\(\s*['"]compression['"]|\bcompression\s*\(/);
    const pkg = readFileSync(join(GW_DIR, 'package.json'), 'utf8');
    assert(!hits.length && !/"compression"/.test(pkg), `found in ${hits.join(', ') || 'package.json'}`);
  });
  await test('S3', 'gateway reads no provider keys', () => {
    const hits = grep(/ANTHROPIC|OPENAI|TAVILY|SERPAPI|MONGODB/);
    assert(!hits.length, `provider names in ${hits.join(', ')}`);
  });
  await test('S4', 'no deep-search cap in the gateway', () => {
    const hits = grep(/DEEP_DAILY_CAP|deepDailyCap|dailyCap/i);
    assert(!hits.length, `deep cap referenced in ${hits.join(', ')}`);
  });
  await test('S5', '501 notImplemented loop removed', () => {
    const hits = grep(/notImplemented|not implemented yet/);
    assert(!hits.length, `still present in ${hits.join(', ')}`);
  });
  await test('S6', 'no multipart parser in the gateway (multer/busboy)', () => {
    const hits = grep(/from\s+['"](multer|busboy|formidable)['"]|require\(\s*['"](multer|busboy|formidable)['"]/);
    const pkg = readFileSync(join(GW_DIR, 'package.json'), 'utf8');
    assert(!hits.length && !/multer|busboy|formidable/.test(pkg), `found in ${hits.join(', ') || 'package.json'}`);
  });
  await test('S7', 'npm run typecheck -w @lumina/gateway', () => {
    try {
      execSync('npm run typecheck -w @lumina/gateway', { cwd: ROOT, stdio: 'pipe' });
    } catch (err) {
      throw new Error((err.stdout?.toString() + err.stderr?.toString()).trim().split('\n').slice(-12).join('\n          '));
    }
  });
}

// ================================================================ MOCK

const AUTH_ROUTES = [
  ['GET', '/stats'],
  ['POST', '/threads', {}],
  ['GET', '/threads'],
  ['GET', '/threads/thr_x'],
  ['POST', '/threads/thr_x/ask', { query: 'q' }],
  ['GET', '/memory'],
  ['DELETE', '/memory/mem_x'],
  ['POST', '/spaces', { name: 'x' }],
  ['GET', '/spaces'],
  ['POST', '/spaces/spc_x/documents', 'multipart'],
  ['GET', '/spaces/spc_x/documents']
];

function multipart(bytes, boundary = `----lumina${randomUUID().slice(0, 8)}`) {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.pdf"\r\nContent-Type: application/pdf\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function runMock() {
  try {
    await startMockAgent(MOCK_PORT);
  } catch (err) {
    console.log(`Could not start the mock agent on :${MOCK_PORT}: ${err.message}`);
    console.log('Free the port, or run this from your own terminal with the ! prefix.');
    process.exit(2);
  }
  BASE = `http://127.0.0.1:${GW_PORT}`;
  startGateway(GW_PORT, MOCK, gwLogs);
  startGateway(DEAD_GW_PORT, `http://127.0.0.1:${DEAD_AGENT_PORT}`, []);
  if (!(await waitUp(BASE))) {
    console.log(`Gateway did not come up on :${GW_PORT}. Last log lines:\n${gwLogs.slice(-15).join('\n')}`);
    process.exit(2);
  }
  await waitUp(`http://127.0.0.1:${DEAD_GW_PORT}`);
  await mockReset();

  // ------------------------------------------------ step 24
  section('Step 24 · auth + CORS');
  await test('A1', 'every API route → 401 ErrorBody without X-User-Id, agent not called', async () => {
    const bad = [];
    for (const [m, p, b] of AUTH_ROUTES) {
      const opt = { user: null };
      if (b === 'multipart') {
        const mp = multipart(Buffer.from('x'));
        opt.rawBody = mp.body;
        opt.headers = { 'content-type': mp.contentType };
      } else if (b) opt.body = b;
      const r = await call(m, p, opt);
      if (r.status !== 401 || !isErrorBody(r.json, 401) || !r.json.requestId) bad.push(`${m} ${p} → ${r.status} ${short(r.text)}`);
    }
    const leaked = (await mockLog()).filter((x) => !x.headers['x-user-id']);
    assert(!bad.length, bad.join('\n          '));
    assert(!leaked.length, `agent received ${leaked.length} unauthenticated call(s)`);
  });
  await test('A2', 'blank / whitespace X-User-Id → 401', async () => {
    for (const u of ['', '   ']) {
      const r = await call('GET', '/memory', { user: u });
      assert(r.status === 401, `x-user-id "${u}" → ${r.status}`);
    }
  });
  await test('A3', '/health and /evals/report.json are open (not 401)', async () => {
    const h = await call('GET', '/health', { user: null });
    const e = await call('GET', '/evals/report.json', { user: null });
    assert(h.status !== 401 && e.status !== 401, `/health ${h.status}, /evals/report.json ${e.status}`);
  });
  await test('A4', 'UI pages / and /evals are open (needs web/dist)', async () => {
    if (!existsSync(join(ROOT, 'web/dist'))) return { skip: 'web/dist not built (npm run build -w @lumina/web)' };
    for (const p of ['/', '/evals']) {
      const r = await call('GET', p, { user: null });
      assert(r.status === 200 && /<html/i.test(r.text), `${p} → ${r.status}`);
    }
  });
  await test('A5', 'CORS preflight from the UI origin passes without X-User-Id', async () => {
    const r = await call('OPTIONS', '/threads', {
      user: null,
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-user-id,content-type' }
    });
    const acao = r.headers.get('access-control-allow-origin');
    const acah = (r.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    assert(r.status >= 200 && r.status < 300, `preflight → ${r.status}`);
    assert(acao === ORIGIN, `allow-origin = ${acao}`);
    assert(acah.includes('x-user-id'), `allow-headers = "${acah}"`);
  });
  await test('A6', 'a foreign origin gets no Access-Control-Allow-Origin', async () => {
    const r = await call('GET', '/threads', { headers: { origin: 'https://evil.example' } });
    const acao = r.headers.get('access-control-allow-origin');
    assert(!acao || acao === ORIGIN, `allow-origin = ${acao}`);
  });
  await test('A7', 'X-Request-Id is exposed to the browser', async () => {
    const r = await call('GET', '/threads', { headers: { origin: ORIGIN } });
    const exp = (r.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    assert(exp.includes('x-request-id'), `expose-headers = "${exp}"`);
  });

  // ------------------------------------------------ step 25
  section('Step 25 · request id');
  await test('R1', 'inbound X-Request-Id echoed and forwarded unchanged', async () => {
    const user = uid();
    const rid = `test-${randomUUID().slice(0, 8)}`;
    const r = await call('GET', '/threads', { user, headers: { 'x-request-id': rid } });
    const [fwd] = await callsFor(user);
    assert(r.headers.get('x-request-id') === rid, `response header = ${r.headers.get('x-request-id')}`);
    assert(fwd, 'agent never received the request');
    assert(fwd.headers['x-request-id'] === rid, `agent got x-request-id = ${fwd.headers['x-request-id']}`);
  });
  await test('R2', 'generated id when absent; response and agent see the same one', async () => {
    const user = uid();
    const r = await call('GET', '/threads', { user });
    const [fwd] = await callsFor(user);
    const id = r.headers.get('x-request-id');
    assert(id, 'no x-request-id on the response');
    assert(fwd?.headers['x-request-id'] === id, `response ${id} vs agent ${fwd?.headers['x-request-id']}`);
  });
  await test('R3', 'X-User-Id forwarded to the agent', async () => {
    const user = uid();
    await call('GET', '/memory', { user });
    const [fwd] = await callsFor(user);
    assert(fwd, 'agent did not receive x-user-id');
  });
  await test('R4', 'request id on 400 / 401 / 502 responses', async () => {
    const out = [];
    const r400 = await call('POST', '/threads/thr_x/ask', { body: {} });
    const r401 = await call('GET', '/memory', { user: null });
    const r502 = await call('GET', '/threads', { base: `http://127.0.0.1:${DEAD_GW_PORT}` });
    for (const [n, r] of [['400', r400], ['401', r401], ['502', r502]]) {
      if (!r.headers.get('x-request-id') || !r.json?.requestId) out.push(`${n}: header=${r.headers.get('x-request-id')} body.requestId=${r.json?.requestId}`);
    }
    assert(!out.length, out.join('; '));
  });

  await test('R5', 'unsafe inbound X-Request-Id (path traversal / empty) is replaced, never forwarded', async () => {
    // The agent writes runs/<requestId>.json, so the id must be safe to use as a filename.
    const safe = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
    const bad = [];
    for (const sent of ['../../package', 'a/b', '', '   ', 'x'.repeat(300)]) {
      const user = uid();
      const r = await call('GET', '/threads', { user, headers: { 'x-request-id': sent } });
      const [fwd] = await callsFor(user);
      const got = fwd?.headers['x-request-id'] ?? '';
      if (!safe.test(got) || got.includes('..') || r.headers.get('x-request-id') !== got)
        bad.push(`sent "${short(sent)}" → agent got "${short(got)}"`);
    }
    assert(!bad.length, bad.join('\n          '));
  });

  // ------------------------------------------------ step 26
  section('Step 26 · validation');
  await test('V1', 'bad ask bodies → 400 with a zod message, agent not called', async () => {
    const cases = [{}, { query: '' }, { query: 'x'.repeat(2001) }, { query: 'q', depth: 'ultra' }, { query: 'q', mode: 'x' }];
    const bad = [];
    for (const body of cases) {
      const user = uid();
      const r = await call('POST', '/threads/thr_x/ask', { user, body });
      const forwarded = (await callsFor(user)).length;
      if (r.status !== 400 || !isErrorBody(r.json, 400) || forwarded) bad.push(`${short(body)} → ${r.status}, forwarded=${forwarded}`);
    }
    assert(!bad.length, bad.join('\n          '));
    const r = await call('POST', '/threads/thr_x/ask', { body: {} });
    assert(/query/i.test(r.json?.error ?? ''), `400 message does not name the field: "${r.json?.error}"`);
  });
  await test('V2', 'malformed JSON → 400 (not 502)', async () => {
    const r = await call('POST', '/threads/thr_x/ask', { rawBody: '{bad', headers: { 'content-type': 'application/json' } });
    assert(r.status === 400 && isErrorBody(r.json, 400), `→ ${r.status} ${short(r.text)}`);
  });
  await test('V3', 'valid ask forwarded with defaults mode:auto, depth:quick', async () => {
    const user = uid();
    await call('POST', '/threads/thr_quick/ask', { user, body: { query: 'hello' } });
    const [fwd] = await callsFor(user);
    assert(fwd, 'agent never received the ask');
    assert(fwd.body?.mode === 'auto' && fwd.body?.depth === 'quick', `agent got ${short(fwd.body)}`);
  });
  await test('V4', 'depth is never changed by the gateway (deep stays deep)', async () => {
    const user = uid();
    await call('POST', '/threads/thr_quick/ask', { user, body: { query: 'hello', depth: 'deep', mode: 'web' } });
    const [fwd] = await callsFor(user);
    assert(fwd?.body?.depth === 'deep' && fwd?.body?.mode === 'web', `agent got ${short(fwd?.body)}`);
  });
  await test('V5', 'POST /threads: {} ok; empty or 201-char title → 400', async () => {
    const ok = await call('POST', '/threads', { body: {} });
    const e1 = await call('POST', '/threads', { body: { title: '' } });
    const e2 = await call('POST', '/threads', { body: { title: 'x'.repeat(201) } });
    assert(ok.status === 201, `{} → ${ok.status}`);
    assert(e1.status === 400 && e2.status === 400, `empty → ${e1.status}, long → ${e2.status}`);
  });
  await test('V6', 'POST /spaces: {} → 400; {name} forwarded → 201', async () => {
    const e = await call('POST', '/spaces', { body: {} });
    const ok = await call('POST', '/spaces', { body: { name: 'x' } });
    assert(e.status === 400 && ok.status === 201, `{} → ${e.status}, {name} → ${ok.status}`);
  });
  await test('V7', 'GET /threads/thr_nope reaches the agent → 404 (ids not validated at gateway)', async () => {
    const user = uid();
    const r = await call('GET', '/threads/thr_nope', { user });
    assert(r.status === 404 && (await callsFor(user)).length === 1, `→ ${r.status}`);
  });

  // ------------------------------------------------ proxy
  section('Proxy + error mapping');
  await test('P1', 'agent 201/202/204/400/404/413 pass through unchanged', async () => {
    const bad = [];
    for (const status of [201, 202, 400, 404, 413]) {
      const body = status < 300 ? { ok: true, s: status } : { error: `mock ${status}`, status };
      await mockNext({ status, body });
      const r = await call('GET', '/threads');
      if (r.status !== status || JSON.stringify(r.json) !== JSON.stringify(body)) bad.push(`${status} → ${r.status} ${short(r.text)}`);
    }
    await mockNext({ status: 204 });
    const r = await call('GET', '/threads');
    if (r.status !== 204) bad.push(`204 → ${r.status}`);
    assert(!bad.length, bad.join('; '));
  });
  await test('P2', 'agent 500 / 503 → 502 ErrorBody', async () => {
    const bad = [];
    for (const status of [500, 503]) {
      await mockNext({ status, body: { error: `boom ${status}` } });
      const r = await call('GET', '/threads');
      if (r.status !== 502 || typeof r.json?.error !== 'string') bad.push(`${status} → ${r.status} ${short(r.text)}`);
    }
    assert(!bad.length, bad.join('; '));
  });
  await test('P3', "agent's deep-cap 429 {error, resetsAt} passes through on ask", async () => {
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    await mockNext({ status: 429, body: { error: 'deep cap', status: 429, resetsAt } });
    const r = await call('POST', '/threads/thr_x/ask', { body: { query: 'q', depth: 'deep' } });
    assert(r.status === 429 && r.json?.resetsAt === resetsAt, `→ ${r.status} ${short(r.text)}`);
  });
  await test('P4', 'query string preserved', async () => {
    const user = uid();
    await call('GET', '/threads?limit=3&x=y', { user });
    const [fwd] = await callsFor(user);
    assert(fwd?.url === '/threads?limit=3&x=y', `agent url = ${fwd?.url}`);
  });
  await test('P5', 'DELETE /memory/:id → 204 with empty body', async () => {
    const r = await call('DELETE', '/memory/mem_x');
    assert(r.status === 204 && r.text === '', `→ ${r.status} "${short(r.text)}"`);
  });
  await test('P6', 'agent down → 502 on API; /health → 503 degraded, ai.status down', async () => {
    const base = `http://127.0.0.1:${DEAD_GW_PORT}`;
    const r = await call('GET', '/threads', { base });
    const a = await call('POST', '/threads/thr_x/ask', { base, body: { query: 'q' } });
    const h = await call('GET', '/health', { base, user: null });
    assert(r.status === 502 && isErrorBody(r.json, 502), `GET /threads → ${r.status} ${short(r.text)}`);
    assert(a.status === 502, `ask → ${a.status}`);
    assert(h.status === 503 && h.json?.status === 'degraded' && h.json?.ai?.status === 'down', `/health → ${h.status} ${short(h.json)}`);
  });
  await test('P7', 'unknown API path → 404 JSON', async () => {
    const r = await call('GET', '/threads/thr_x/nope');
    assert(r.status === 404 && r.json?.error, `→ ${r.status} ${short(r.text)}`);
  });

  // ------------------------------------------------ step 27
  section(`Step 27 · rate limit (test limit ${RATE}/min)`);
  await test('L1', `call ${RATE + 1} → 429 {error,status,resetsAt,requestId} + Retry-After; not forwarded`, async () => {
    const user = uid();
    let last;
    for (let i = 0; i <= RATE; i++) last = await call('POST', '/threads/thr_quick/ask', { user, body: { query: `q${i}` } });
    const j = last.json ?? {};
    const reset = Date.parse(j.resetsAt);
    const ra = Number(last.headers.get('retry-after'));
    const forwarded = (await callsFor(user)).length;
    assert(last.status === 429, `call ${RATE + 1} → ${last.status}`);
    assert(j.error && j.status === 429 && j.requestId, `body ${short(j)}`);
    assert(reset > Date.now() && reset <= Date.now() + 61_000, `resetsAt = ${j.resetsAt}`);
    assert(ra >= 1 && ra <= 60, `Retry-After = ${last.headers.get('retry-after')}`);
    assert(forwarded === RATE, `agent received ${forwarded} asks, expected ${RATE}`);
  });
  await test('L2', 'another user is unaffected in the same window', async () => {
    const a = uid();
    for (let i = 0; i <= RATE; i++) await call('POST', '/threads/thr_quick/ask', { user: a, body: { query: 'q' } });
    const r = await call('POST', '/threads/thr_quick/ask', { user: uid(), body: { query: 'q' } });
    assert(r.status === 200, `user B → ${r.status}`);
  });
  await test('L3', '25 rapid document-status polls never 429 (bench polls every 1.2 s)', async () => {
    const user = uid();
    const codes = [];
    for (let i = 0; i < 25; i++) codes.push((await call('GET', '/spaces/spc_x/documents', { user })).status);
    assert(!codes.includes(429), `got 429 on poll #${codes.indexOf(429) + 1}`);
  });

  // ------------------------------------------------ step 28
  section('Step 28 · SSE pass-through');
  await test('E1', 'SSE headers right, no compression even with Accept-Encoding: gzip', async () => {
    const res = await fetch(`${BASE}/threads/thr_quick/ask`, {
      method: 'POST',
      headers: { 'x-user-id': uid(), 'content-type': 'application/json', 'accept-encoding': 'gzip, deflate, br' },
      body: JSON.stringify({ query: 'q' })
    });
    await res.text();
    const ct = res.headers.get('content-type') ?? '';
    const cc = res.headers.get('cache-control') ?? '';
    const xab = res.headers.get('x-accel-buffering');
    const ce = res.headers.get('content-encoding');
    assert(ct.startsWith('text/event-stream'), `content-type = ${ct}`);
    assert(cc.includes('no-cache'), `cache-control = ${cc}`);
    assert(xab === 'no', `x-accel-buffering = ${xab}`);
    assert(!ce, `content-encoding = ${ce}`);
  });
  await test('E2+E3', 'frames arrive progressively and byte-identical, in order', async () => {
    const user = uid();
    const t0 = Date.now();
    const res = await fetch(`${BASE}/threads/thr_stream/ask`, {
      method: 'POST',
      headers: { 'x-user-id': user, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'q' })
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const arrivals = [];
    let got = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(Date.now() - t0);
      got += dec.decode(value, { stream: true });
    }
    const [fwd] = await callsFor(user);
    const first = arrivals[0];
    const span = arrivals.at(-1) - first;
    assert(first < 600, `first bytes after ${first} ms (mock sent the first frame at ~0 ms) → buffered`);
    assert(arrivals.length >= 5 && span > 2000, `${arrivals.length} reads over ${span} ms → stream was buffered`);
    assert(got === fwd?.sent, 'bytes differ from what the agent sent (re-framed or truncated)');
    return `${arrivals.length} reads, first at ${first} ms, spread over ${span} ms`;
  });
  await test('E4', 'client disconnect aborts the agent request', async () => {
    const user = uid();
    const ac = new AbortController();
    const res = await fetch(`${BASE}/threads/thr_stream/ask`, {
      method: 'POST',
      headers: { 'x-user-id': user, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'q' }),
      signal: ac.signal
    });
    const reader = res.body.getReader();
    await reader.read();
    await sleep(500);
    ac.abort();
    await sleep(1200);
    const [fwd] = await callsFor(user);
    assert(fwd?.aborted, 'agent kept streaming after the browser left (no abort on res close)');
  });
  await test('E5', 'agent 404 before streaming → JSON 404, not SSE', async () => {
    const r = await call('POST', '/threads/thr_missing/ask', { body: { query: 'q' } });
    const ct = r.headers.get('content-type') ?? '';
    assert(r.status === 404 && ct.includes('json') && r.json?.error, `→ ${r.status} ${ct} ${short(r.text)}`);
  });
  await test('E6', 'a 36 s stream is not cut off (no short timeout on ask)', async () => {
    if (!flag('--slow')) return { skip: 'run with --slow (takes ~40 s)' };
    const user = uid();
    const r = await call('POST', '/threads/thr_slow/ask', { user, body: { query: 'q' } });
    assert(r.status === 200 && r.text.includes('event: done'), `stream ended early: ${short(r.text.slice(-120))}`);
  });

  // ------------------------------------------------ uploads
  section('Uploads');
  await test('U1', 'multipart body forwarded byte-identical, boundary intact', async () => {
    const user = uid();
    const bytes = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 31) % 256));
    const mp = multipart(bytes);
    const r = await call('POST', '/spaces/spc_x/documents', { user, rawBody: mp.body, headers: { 'content-type': mp.contentType } });
    const [fwd] = await callsFor(user);
    const sha = createHash('sha256').update(mp.body).digest('hex');
    assert(r.status === 202 && r.json?.status === 'pending', `→ ${r.status} ${short(r.text)}`);
    assert(fwd?.headers['content-type'] === mp.contentType, `agent content-type = ${fwd?.headers['content-type']}`);
    assert(fwd?.sha256 === sha, `agent got ${fwd?.bytes} bytes, hash differs`);
  });
  await test('U2', `content-length over ${MAX_UPLOAD_BYTES} → 413, agent not called`, async () => {
    const user = uid();
    const mp = multipart(Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 1));
    const r = await rawRequest('POST', `${BASE}/spaces/spc_x/documents`, {
      'x-user-id': user,
      'content-type': mp.contentType,
      'content-length': mp.body.length
    }, mp.body);
    const forwarded = (await callsFor(user)).length;
    assert(r.status === 413, `→ ${r.status} ${short(r.text)}`);
    assert(forwarded === 0, 'agent received the oversized upload (gateway should stop it early)');
  });
  await test('U3', 'upload 202 through the gateway in < 300 ms', async () => {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const mp = multipart(Buffer.alloc(300_000, 7));
      const t0 = Date.now();
      const r = await call('POST', '/spaces/spc_x/documents', { rawBody: mp.body, headers: { 'content-type': mp.contentType } });
      times.push(Date.now() - t0);
      assert(r.status === 202, `→ ${r.status}`);
    }
    assert(Math.max(...times) < 300, `times ${times.join(', ')} ms`);
    return `${times.join(', ')} ms`;
  });

  // ------------------------------------------------ step 29
  section('Step 29 · logs, report, static');
  await test('G1+G2', 'one pino line per request with method, route, status, ms, requestId, userId', async () => {
    const probes = [
      ['GET', '/threads', 200, {}],
      ['GET', '/memory', 401, { user: null }],
      ['POST', '/threads/thr_quick/ask', 200, { body: { query: 'q' } }],
      ['GET', '/threads', 502, { base: `http://127.0.0.1:${DEAD_GW_PORT}` }]
    ];
    const rids = [];
    for (const [m, p, want, opt] of probes) {
      const rid = `log-${randomUUID().slice(0, 8)}`;
      const user = opt.user === null ? null : uid();
      await call(m, p, { ...opt, user, headers: { 'x-request-id': rid } });
      if (!opt.base) rids.push({ rid, want, user, label: `${m} ${p}` });
    }
    await sleep(400);
    const bad = [];
    for (const { rid, want, user, label } of rids) {
      const lines = completionLinesFor(rid);
      if (lines.length !== 1) {
        bad.push(`${label}: ${lines.length} log lines for requestId ${rid}`);
        continue;
      }
      const o = lines[0];
      const status = o.status ?? o.res?.statusCode;
      const missing = ['method', 'route', 'status', 'requestId'].filter((k) => o[k] === undefined);
      if (o.ms === undefined && o.responseTime === undefined) missing.push('ms');
      if (!('userId' in o)) missing.push('userId');
      if (missing.length) bad.push(`${label}: missing top-level ${missing.join(', ')}`);
      if (status !== want) bad.push(`${label}: logged status ${status}, real ${want}`);
      if (user && o.userId !== user) bad.push(`${label}: logged userId ${o.userId}`);
    }
    assert(!bad.length, bad.join('\n          '));
  });
  await test('G2b', 'a 429 is logged with status 429', async () => {
    const user = uid();
    const rid = `log429-${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < RATE; i++) await call('POST', '/threads/thr_quick/ask', { user, body: { query: 'q' } });
    await call('POST', '/threads/thr_quick/ask', { user, body: { query: 'q' }, headers: { 'x-request-id': rid } });
    await sleep(300);
    const [o] = completionLinesFor(rid);
    assert(o && (o.status ?? o.res?.statusCode) === 429, `logged ${short(o)}`);
  });
  await test('G3', 'route logged as a template (/threads/:threadId)', async () => {
    const rid = `logt-${randomUUID().slice(0, 6)}`;
    await call('GET', '/threads/thr_x', { headers: { 'x-request-id': rid } });
    await sleep(300);
    const [o] = completionLinesFor(rid);
    if (o?.route !== '/threads/:threadId') return { warn: `route = ${o?.route} (template is nicer for grouping; not required)` };
  });
  await test('G4', '/evals/report.json: 404 ErrorBody without a report, 200 JSON with one', async () => {
    const dir = join(ROOT, 'reports');
    const file = join(dir, 'report.json');
    if (existsSync(file)) {
      const r = await call('GET', '/evals/report.json', { user: null });
      assert(r.status === 200 && r.json, `report exists but → ${r.status}`);
      return 'report already exists → 200 (404 path not tested)';
    }
    const r404 = await call('GET', '/evals/report.json', { user: null });
    assert(r404.status === 404 && isErrorBody(r404.json, 404), `no report → ${r404.status} ${short(r404.text)}`);
    const madeDir = !existsSync(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ test: 'temporary file from gateway tests' }));
    try {
      const r = await call('GET', '/evals/report.json', { user: null });
      assert(r.status === 200 && r.json?.test, `with report → ${r.status} ${short(r.text)}`);
      assert((r.headers.get('content-type') ?? '').includes('json'), `content-type ${r.headers.get('content-type')}`);
    } finally {
      rmSync(file);
      if (madeDir) rmSync(dir, { recursive: true });
    }
  });
  await test('G5', 'web/dist served at / with SPA fallback at /evals', async () => {
    if (!existsSync(join(ROOT, 'web/dist'))) return { skip: 'web/dist not built (npm run build -w @lumina/web)' };
    const a = await call('GET', '/', { user: null });
    const b = await call('GET', '/evals', { user: null });
    assert(a.status === 200 && b.status === 200 && /<html/i.test(b.text), `/ → ${a.status}, /evals → ${b.status}`);
  });
  await test('G6', 'no secrets in gateway logs', () => {
    const all = gwLogs.join('\n');
    const hit = all.match(/sk-ant-[\w-]{6,}|sk-[A-Za-z0-9]{20,}|tvly-[\w-]{6,}|mongodb(\+srv)?:\/\/[^\s"]+/);
    assert(!hit, `found ${hit?.[0].slice(0, 14)}…`);
  });
}

// ================================================================ LIVE

function parseSse(text) {
  return text
    .split(/\n\n/)
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => {
      const ev = f.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const data = f
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      let d = null;
      try {
        d = JSON.parse(data);
      } catch {
        // Not JSON: data stays null.
      }
      return { event: ev, data: d };
    });
}

async function runLive() {
  BASE = val('--url', 'http://localhost:8787').replace(/\/$/, '');
  const user = `live-${randomUUID().slice(0, 6)}`;

  section(`Live · ${BASE}`);
  await test('Z1', '/health 200 names model, searchProvider, vectorStore; db ok', async () => {
    const r = await call('GET', '/health', { user: null });
    const j = r.json ?? {};
    assert(r.status === 200, `→ ${r.status} ${short(r.text)}`);
    assert(j.model && j.searchProvider && j.vectorStore && j.db === 'ok' && j.ai?.status === 'ok', short(j));
    return `${j.model} · ${j.searchProvider} · ${j.vectorStore} · db ${j.db}`;
  });
  await test('Z2', 'the 4 bench contract probes', async () => {
    const got = [
      ['GET /memory without X-User-Id', (await call('GET', '/memory', { user: '' })).status, 401],
      ['GET /threads/thr_nope', (await call('GET', '/threads/thr_nope', { user })).status, 404],
      ['POST ask with {}', (await call('POST', '/threads/thr_x/ask', { user, body: {} })).status, 400]
    ];
    const rep = (await call('GET', '/evals/report.json', { user: '' })).status;
    const bad = got.filter(([, g, w]) => g !== w).map(([l, g, w]) => `${l}: ${g} (want ${w})`);
    if (rep === 401) bad.push('/evals/report.json without user: 401');
    assert(!bad.length, bad.join('; '));
  });

  let threadId;
  const rid = `live-${Date.now().toString(36)}`;
  await test('Z3', 'real quick ask: trace* → sources → token → done, TTFT < 2.5 s, streamed', async () => {
    const t = await call('POST', '/threads', { user, body: {} });
    assert(t.status === 201 && t.json?.threadId, `POST /threads → ${t.status} ${short(t.text)}`);
    threadId = t.json.threadId;
    const t0 = Date.now();
    const res = await fetch(`${BASE}/threads/${threadId}/ask`, {
      method: 'POST',
      headers: { 'x-user-id': user, 'x-request-id': rid, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is a TTL index in MongoDB?', mode: 'web' })
    });
    assert(res.status === 200, `ask → ${res.status} ${short(await res.text())}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    let firstTokenAt = null;
    let tokenReads = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      if (chunk.includes('event: token')) {
        tokenReads++;
        firstTokenAt ??= Date.now() - t0;
      }
      text += chunk;
    }
    const evs = parseSse(text);
    const names = evs.map((e) => e.event);
    const iSrc = names.indexOf('sources');
    const iTok = names.indexOf('token');
    const done = evs.find((e) => e.event === 'done')?.data;
    assert(!names.includes('error'), `stream had an error event: ${short(evs.find((e) => e.event === 'error')?.data)}`);
    assert(names[0] === 'trace', `first event is ${names[0]}`);
    assert(iSrc >= 0 && iTok > iSrc, `sources at ${iSrc}, first token at ${iTok}`);
    assert(names.at(-1) === 'done', `last event is ${names.at(-1)}`);
    assert(!names.includes('plan'), 'quick run emitted a plan');
    assert(!evs.some((e) => e.event === 'trace' && e.data?.tool === 'plan_research'), 'quick run called plan_research (red line)');
    const need = ['answerId', 'latencyMs', 'ttftMs', 'model', 'tokens', 'costUsd', 'searchCached', 'terminated', 'depth', 'subQuestions'];
    const miss = need.filter((k) => done?.[k] === undefined);
    assert(!miss.length, `done missing ${miss.join(', ')}`);
    assert(done.terminated === 'done' && done.depth === 'quick', `terminated=${done.terminated} depth=${done.depth}`);
    const answer = evs.filter((e) => e.event === 'token').map((e) => e.data?.text ?? e.data?.token ?? '').join('');
    const ns = new Set((evs[iSrc].data?.sources ?? []).map((s) => s.n));
    const cited = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    const dangling = cited.filter((n) => !ns.has(n));
    assert(!dangling.length, `citations with no source: ${[...new Set(dangling)].join(', ')}`);
    assert(firstTokenAt < 2500, `first token at ${firstTokenAt} ms (SLA p95 2500)`);
    assert(tokenReads >= 3, `tokens arrived in only ${tokenReads} read(s) → buffering`);
    return `first token ${firstTokenAt} ms, ${tokenReads} token reads, ${ns.size} sources, ${cited.length} citations`;
  });
  await test('Z4', 'runs/<my X-Request-Id>.json exists (id forwarded end to end)', async () => {
    await sleep(500);
    const f = join(ROOT, 'runs', `${rid}.json`);
    assert(existsSync(f), `no ${f}`);
  });
  await test('Z5', 'real PDF upload: 202 < 300 ms, polling to indexed never 429', async () => {
    if (flag('--no-upload')) return { skip: '--no-upload' };
    const s = await call('POST', '/spaces', { user, body: { name: `gw-test-${Date.now()}` } });
    assert(s.status === 201 && s.json?.spaceId, `POST /spaces → ${s.status} ${short(s.text)}`);
    const pdf = join(ROOT, 'eval/gold/corpus/retrieval-basics.pdf');
    const form = new FormData();
    form.append('file', new Blob([readFileSync(pdf)], { type: 'application/pdf' }), 'retrieval-basics.pdf');
    const t0 = Date.now();
    const up = await fetch(`${BASE}/spaces/${s.json.spaceId}/documents`, { method: 'POST', headers: { 'x-user-id': user }, body: form });
    const ms = Date.now() - t0;
    const uj = await up.json().catch(() => null);
    assert(up.status === 202 && uj?.status === 'pending' && uj?.docId, `upload → ${up.status} ${short(uj)}`);
    assert(ms < 300, `202 took ${ms} ms`);
    const deadline = Date.now() + 240_000;
    let polls = 0;
    for (;;) {
      const r = await call('GET', `/spaces/${s.json.spaceId}/documents`, { user });
      polls++;
      assert(r.status !== 429, `poll #${polls} → 429`);
      const row = r.json?.documents?.find((d) => d.docId === uj.docId);
      if (row?.status === 'indexed') return `202 in ${ms} ms, indexed after ${polls} polls (${row.pages ?? '?'} pages, ${row.chunks ?? '?'} chunks)`;
      assert(row?.status !== 'failed', `indexing failed: ${row?.error}`);
      assert(Date.now() < deadline, `still ${row?.status} after 240 s`);
      await sleep(1200);
    }
  });
  await test('Z6', 'GET /memory 200; DELETE /memory/mem_nope → 404 passed through', async () => {
    const g = await call('GET', '/memory', { user });
    const d = await call('DELETE', '/memory/mem_nope', { user });
    assert(g.status === 200 && Array.isArray(g.json?.memories), `GET → ${g.status} ${short(g.text)}`);
    assert(d.status === 404, `DELETE → ${d.status}`);
  });
}

// ================================================================ main

if (MODE === 'static') await runStatic();
else if (MODE === 'mock') await runMock();
else if (MODE === 'live') await runLive();
else {
  console.log(`unknown --mode ${MODE} (static | mock | live)`);
  process.exit(2);
}

const n = (o) => results.filter((r) => r.outcome === o).length;
console.log(`\n${n('PASS')} passed · ${n('FAIL')} failed · ${n('WARN')} warn · ${n('SKIP')} skipped  (${MODE})`);
cleanup();
process.exit(n('FAIL') ? 1 : 0);
