/**
 * LUMINA gateway — the software backend. PROVIDED SKELETON: YOU BUILD THIS OUT.
 *
 * The server, CORS, the request id, the pino request log, /health (which nests the agent
 * service's health) and the static hosting of web/dist, plus:
 *   1. X-User-Id enforcement           → 401 without it, on every API route (guards.ts)
 *   2. zod validation from @lumina/contract → 400 on a bad body, with the zod message
 *   3. layered rate limits (per user, per IP, open streams) → 429
 *   4. the proxy to the agent service, and SSE pass-through for /threads/:id/ask (proxy.ts)
 *   5. 502 for any upstream failure    → never a 2xx when the agent threw
 *
 * The browser talks ONLY to this service. No provider key is ever read here.
 */
import express from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AskBody,
  CreateSpaceBody,
  CreateThreadBody,
  HealthResponse,
  REQUEST_HEADER,
  USER_HEADER
} from '@lumina/contract';
import { env } from './env.js';
import { limitCostly, limitGeneral, limitOpenAsks, requireUser, validate } from './guards.js';
import { askPassThrough, forward, uploadPassThrough } from './proxy.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: env.corsOrigins, credentials: false, exposedHeaders: [REQUEST_HEADER, 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'] }));

// One request id, reused if the caller sent one, generated if not, forwarded to the agent
// service and logged by both. This is what makes one request greppable end to end.
app.use((req, res, next) => {
  // The agent writes runs/<requestId>.json, so an inbound id is kept only if it is a safe
  // filename (no slashes, can't start with a dot, not empty). Anything else gets a fresh id.
  const inbound = req.header(REQUEST_HEADER)?.trim() ?? '';
  const id = SAFE_REQUEST_ID.test(inbound) ? inbound : `req_${randomUUID().slice(0, 12)}`;
  res.locals.requestId = id;
  res.locals.startedAt = Date.now();
  res.setHeader(REQUEST_HEADER, id);
  next();
});

app.use(
  pinoHttp({
    logger: log,
    genReqId: (_req, res) => String(res.locals.requestId),
    customProps: (req, res) => ({
      requestId: res.locals.requestId,
      userId: req.header(USER_HEADER) ?? null,
      method: req.method,
      route: (req as express.Request).route?.path ?? (req as express.Request).path,
      status: res.statusCode,
      ms: Date.now() - Number(res.locals.startedAt)
    }),
    // The ask route is a stream; one line when it closes is the useful line.
    autoLogging: true
  })
);

// JSON everywhere except the multipart upload route, which your handler owns.
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

// ---------------------------------------------------------------- /health (implemented)

app.get('/health', async (_req, res) => {
  let ai: { status: 'ok' | 'down' } & Record<string, unknown> = { status: 'down' };
  try {
    const upstream = await fetch(`${env.agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await upstream.json()) as Record<string, unknown>;
    ai = { ...body, status: upstream.ok ? 'ok' : 'down' };
  } catch (err) {
    // Health tells the truth about a dead dependency. It never pretends.
    ai = { status: 'down', error: (err as Error).message };
  }

  const body: HealthResponse = {
    status: ai.status === 'ok' ? 'ok' : 'degraded',
    model: String(ai.model ?? 'unset'),
    searchProvider: (ai.searchProvider as HealthResponse['searchProvider']) ?? 'tavily',
    vectorStore: (ai.vectorStore as HealthResponse['vectorStore']) ?? 'atlas-vector-search',
    db: (ai.db as HealthResponse['db']) ?? 'down',
    ai
  };
  res.status(ai.status === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- contract routes

app.use(requireUser);

app.get('/stats', limitGeneral, (req, res) => forward(req, res));
app.post('/threads', limitGeneral, validate(CreateThreadBody), (req, res) => forward(req, res, req.body));
app.get('/threads', limitGeneral, (req, res) => forward(req, res));
app.get('/threads/:threadId', limitGeneral, (req, res) => forward(req, res));
app.post('/threads/:threadId/ask', limitCostly, limitOpenAsks, validate(AskBody), askPassThrough);
app.get('/memory', limitGeneral, (req, res) => forward(req, res));
app.delete('/memory/:memoryId', limitGeneral, (req, res) => forward(req, res));
app.post('/spaces', limitGeneral, validate(CreateSpaceBody), (req, res) => forward(req, res, req.body));
app.get('/spaces', limitGeneral, (req, res) => forward(req, res));
app.post('/spaces/:spaceId/documents', limitCostly, uploadPassThrough);
app.get('/spaces/:spaceId/documents', limitGeneral, (req, res) => forward(req, res));

// The eval report the UI renders at /evals. Open, no X-User-Id.
const reportPath = resolve(process.cwd(), '../../reports/report.json');
app.get('/evals/report.json', (_req, res) => {
  if (existsSync(reportPath)) return res.type('application/json').sendFile(reportPath);
  res.status(404).json({ error: 'no report yet: run /fde-lumina-eval', status: 404, requestId: String(res.locals.requestId) });
});

// ---------------------------------------------------------------- static UI

// In production the gateway serves the built UI, so / and /evals come from one origin.
if (existsSync(env.webDist)) {
  app.use(express.static(env.webDist));
  app.get(/^(?!\/(health|stats|threads|memory|spaces|artifacts|evals)).*/, (_req, res) => {
    res.sendFile(`${env.webDist}/index.html`);
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 });
});

// A thrown error is a 502 with a log line, never a 200 with a plausible body (rule A1).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if ((err as Error & { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body', status: 400, requestId: String(res.locals.requestId) });
  }
  log.error({ err, requestId: res.locals.requestId }, 'gateway error');
  res.status(502).json({ error: err.message, status: 502, requestId: String(res.locals.requestId) });
});

app.listen(env.port, () => {
  log.info(
    { port: env.port, agentUrl: env.agentUrl, cors: env.corsOrigins },
    'gateway up'
  );
});
