// Fake agent service for gateway tests. No LLM, no Mongo, no spend.
// Records every request it receives so the tests can see what the gateway forwarded.
//
// Control routes (never forwarded by the gateway, called by the test runner directly):
//   GET  /__log    -> recorded requests
//   POST /__reset  -> clear the log and any queued overrides
//   POST /__next   -> {status, body?, headers?}: the next non-control request answers with this
import http from 'node:http';
import { createHash } from 'node:crypto';

export const FRAME_COUNT = 10;
export const FRAME_GAP_MS = 300;

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function framesFor(n) {
  const out = [frame('trace', { step: 1, tool: 'web_search', input: { q: 'mock' }, ok: true, ms: 5 })];
  out.push(frame('sources', { sources: [{ n: 1, kind: 'web', url: 'https://example.com', title: 'Example' }] }));
  for (let i = 0; out.length < n - 1; i++) out.push(frame('token', { text: `word${i} ` }));
  out.push(frame('done', { answerId: 'ans_mock', terminated: 'done', depth: 'quick' }));
  return out;
}

export function startMockAgent(port) {
  const log = [];
  const overrides = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = req.url ?? '/';
      const path = url.split('?')[0];

      if (path === '/__log') return json(res, 200, log);
      if (path === '/__reset') {
        log.length = 0;
        overrides.length = 0;
        return json(res, 200, { ok: true });
      }
      if (path === '/__next') {
        overrides.push(JSON.parse(raw.toString() || '{}'));
        return json(res, 200, { ok: true });
      }

      let body = null;
      try {
        body = raw.length && /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw.toString()) : null;
      } catch {
        body = '<<invalid json>>';
      }
      const rec = {
        method: req.method,
        url,
        headers: req.headers,
        body,
        bytes: raw.length,
        sha256: createHash('sha256').update(raw).digest('hex'),
        aborted: false,
        sent: ''
      };
      if (path !== '/health') log.push(rec);

      const o = overrides.shift();
      if (o) {
        res.writeHead(o.status, { 'content-type': 'application/json', ...(o.headers ?? {}) });
        return res.end(o.status === 204 || o.body === undefined ? undefined : JSON.stringify(o.body));
      }
      route(req, res, path, rec);
    });
  });

  function route(req, res, path, rec) {
    const m = req.method;
    if (m === 'GET' && path === '/health')
      return json(res, 200, {
        status: 'ok',
        model: 'mock-model',
        searchProvider: 'tavily',
        vectorStore: 'atlas-vector-search',
        db: 'ok',
        ai: { status: 'ok' }
      });

    const ask = path.match(/^\/threads\/([^/]+)\/ask$/);
    if (m === 'POST' && ask) {
      const id = ask[1];
      if (id === 'thr_missing') return json(res, 404, { error: `unknown thread ${id}`, status: 404 });
      const slow = id === 'thr_slow';
      const quick = id === 'thr_quick';
      const frames = framesFor(quick ? 4 : slow ? 7 : FRAME_COUNT);
      const gap = quick ? 5 : slow ? 6000 : FRAME_GAP_MS;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no'
      });
      let i = 0;
      const send = () => {
        if (res.destroyed) return;
        rec.sent += frames[i];
        res.write(frames[i++]);
        if (i >= frames.length) {
          clearInterval(timer);
          res.end();
        }
      };
      const timer = setInterval(send, gap);
      res.on('close', () => {
        clearInterval(timer);
        if (!res.writableEnded) rec.aborted = true;
      });
      send();
      return;
    }

    if (m === 'POST' && /^\/spaces\/[^/]+\/documents$/.test(path))
      return json(res, 202, { docId: 'doc_mock1', status: 'pending' });
    if (m === 'GET' && /^\/spaces\/[^/]+\/documents$/.test(path))
      return json(res, 200, { documents: [{ docId: 'doc_mock1', title: 'm', status: 'embedding', pct: 50 }] });
    if (m === 'GET' && path === '/threads/thr_nope') return json(res, 404, { error: 'unknown thread thr_nope', status: 404 });
    if (m === 'POST' && path === '/threads') return json(res, 201, { threadId: 'thr_mock' });
    if (m === 'POST' && path === '/spaces') return json(res, 201, { spaceId: 'spc_mock', name: 'mock' });
    if (m === 'DELETE' && path.startsWith('/memory/')) {
      res.writeHead(204);
      return res.end();
    }
    return json(res, 200, { ok: true, method: m, path });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8001);
  await startMockAgent(port);
  console.log(`mock agent on :${port}`);
}
