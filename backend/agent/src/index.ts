/**
 * LUMINA agent service — the AI backend. PROVIDED SKELETON: YOU BUILD THIS OUT.
 * This is where the real work is. Provider keys live only in this process.
 *
 * What is already here: the server, /health (Mongo ping + which model, provider and
 * vector backend are live), and a 501 for every other route.
 *
 * What you build (README Part 1, in this order — each step is testable with curl -N):
 *   1. the QUICK loop: plan → choose tool → observe → repeat → answer, with web_search
 *      and fetch_page, streaming trace → sources → token → done. sources BEFORE the
 *      first token. Disable compression on this route and flush after every event.
 *   2. the search cache: in-process LRU over the searchCache collection (TTL index),
 *      key = sha256(normalized query + provider). searchCached only when every hit.
 *   3. threads + messages, so a follow-up sees the thread.
 *   4. memory: save_memory / recall_memory over the memories vector index; GET /memory,
 *      DELETE /memory/:id.
 *   5. the run log: one runs/<requestId>.json per answer, in the RunLog shape from the
 *      contract. Ten lines. The gates read it, so it is not optional.
 *   6. spaces + the jobs worker: upload → GridFS → parse → chunk → embed → upsert →
 *      read-your-write probe → indexed.
 *   7. hybrid retrieval: $vectorSearch + $search fused with RRF, page locators.
 *   8. DEEP search (depth: "deep"): plan_research decomposes the question into 3–6
 *      sub-questions, you stream a `plan` event BEFORE retrieving anything, research each
 *      sub-question, then merge the results into ONE citation numbering and synthesise.
 *      Every trace step and every source carries the subQuestion it served. Deep runs
 *      under the wider caps (maxToolCallsDeep, maxWallClockSecDeep) and behind
 *      DEEP_DAILY_CAP → 429 {error, resetsAt}.
 *
 * Three rules to hold on to while you write it:
 *   - Fail loud. A provider exception ends the run with terminated:"error" and a 502.
 *     Never a try/catch that returns a plausible answer. (Live Translate served English
 *     for weeks because of exactly that catch.)
 *   - Grounded or nothing. A citation that does not resolve to something retrieved in
 *     THIS request is an automatic fail.
 *   - Depth is opted into, never drifted into. A quick search may not call plan_research,
 *     however much the model would like to. Deep costs several times more, and a product
 *     that escalates itself is a product with an unbounded bill.
 */
import express from 'express';
import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { CreateThreadBody, HealthResponse, ROUTES, newId, type StatsResponse } from '@lumina/contract';
import { env } from './env.js';
import { db, pingDb } from './db.js';
import { handleAsk } from './ask.js';
import { deleteMemory, listMemories } from './memory.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

mkdirSync(env.runsDir, { recursive: true });

// ---------------------------------------------------------------- request id, auth, request rows

app.use((req, res, next) => {
  // Reuse the gateway's id so one request is greppable end to end.
  res.setHeader('x-request-id', req.header('x-request-id') || newId('req'));
  next();
});

app.use((req, res, next) => {
  // Checked here too, not only at the gateway: the agent must not trust a caller that skipped it.
  if (req.path === '/health' || req.header('x-user-id')) return next();
  res.status(401).json({ error: 'X-User-Id header is required', status: 401 });
});

app.use((req, res, next) => {
  // One `requests` row per call, for /stats. The ask route writes its own, richer row.
  if (req.path === '/health' || req.path.endsWith('/ask')) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    db()
      .then((d) =>
        d.collection('requests').insertOne({
          requestId: res.getHeader('x-request-id'),
          userId: req.header('x-user-id'),
          route: `${req.method} ${req.route?.path ?? req.path}`,
          status: res.statusCode,
          ms: Date.now() - t0,
          createdAt: new Date()
        })
      )
      .catch((err) => log.error({ err: (err as Error).message }, 'could not record request'));
  });
  next();
});

// ---------------------------------------------------------------- /health

app.get('/health', async (_req, res) => {
  const dbStatus = await pingDb();
  const body: HealthResponse = {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    model: env.llmModel,
    searchProvider: env.searchProvider,
    vectorStore: env.vectorBackend,
    db: dbStatus,
    ai: { status: 'ok' }
  };
  res.status(dbStatus === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- threads

type Async = (req: express.Request, res: express.Response) => Promise<unknown>;
const route = (fn: Async) => (req: express.Request, res: express.Response, next: express.NextFunction) =>
  fn(req, res).catch(next);
const user = (req: express.Request) => req.header('x-user-id')!;

app.post(
  '/threads',
  route(async (req, res) => {
    const parsed = CreateThreadBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message, status: 400 });
    const threadId = newId('thr');
    await (await db())
      .collection('threads')
      .insertOne({ _id: threadId as never, userId: user(req), title: parsed.data.title ?? 'New thread', createdAt: new Date() });
    res.status(201).json({ threadId });
  })
);

app.get(
  '/threads',
  route(async (req, res) => {
    const rows = await (await db())
      .collection<{ _id: string; title: string; createdAt: Date }>('threads')
      .find({ userId: user(req) })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    res.json({ threads: rows.map((t) => ({ threadId: t._id, title: t.title, createdAt: t.createdAt.toISOString() })) });
  })
);

app.get(
  '/threads/:threadId',
  route(async (req, res) => {
    const database = await db();
    const thread = await database
      .collection<{ _id: string; title: string }>('threads')
      .findOne({ _id: req.params.threadId!, userId: user(req) });
    if (!thread) return res.status(404).json({ error: `unknown thread ${req.params.threadId}`, status: 404 });
    const messages = await database
      .collection('messages')
      .find({ threadId: thread._id }, { projection: { _id: 0, threadId: 0, userId: 0 } })
      .sort({ createdAt: 1 })
      .toArray();
    res.json({
      threadId: thread._id,
      title: thread.title,
      messages: messages.map((m) => ({ ...m, createdAt: (m.createdAt as Date).toISOString() }))
    });
  })
);

app.post(
  '/threads/:threadId/ask',
  route((req, res) => handleAsk(req, res, log))
);

// ---------------------------------------------------------------- memory

app.get(
  '/memory',
  route(async (req, res) => res.json({ memories: await listMemories(user(req)) }))
);

app.delete(
  '/memory/:memoryId',
  route(async (req, res) => {
    const deleted = await deleteMemory(user(req), req.params.memoryId!);
    if (!deleted) return res.status(404).json({ error: `unknown memory ${req.params.memoryId}`, status: 404 });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- stats

app.get(
  '/stats',
  route(async (req, res) => {
    const requests = (await db()).collection<{
      route: string;
      status: number;
      userId?: string;
      depth?: string;
      ttftMs?: number;
      costUsd?: number;
      searches?: number;
      searchHits?: number;
      createdAt: Date;
    }>('requests');
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const answers = await requests.find({ route: 'POST /threads/:threadId/ask', status: 200 }).toArray();

    const searches = answers.reduce((n, a) => n + (a.searches ?? 0), 0);
    const hits = answers.reduce((n, a) => n + (a.searchHits ?? 0), 0);
    const ttfts = answers.map((a) => a.ttftMs ?? 0).sort((a, b) => a - b);
    const body: StatsResponse = {
      requests: await requests.countDocuments(),
      answers: answers.length,
      searchCacheHitRatePct: searches ? Number(((hits / searches) * 100).toFixed(1)) : 0,
      ttftP95Ms: ttfts.length ? ttfts[Math.min(ttfts.length - 1, Math.ceil(ttfts.length * 0.95) - 1)]! : 0,
      costUsdToday: Number(
        answers.filter((a) => a.createdAt >= today).reduce((n, a) => n + (a.costUsd ?? 0), 0).toFixed(4)
      ),
      deepToday: answers.filter((a) => a.depth === 'deep' && a.userId === user(req) && a.createdAt >= today).length,
      deepDailyCap: env.deepDailyCap
    };
    res.json(body);
  })
);

// ---------------------------------------------------------------- everything else: 501

const built = ['/health', '/evals/report.json', '/threads', '/threads/:threadId', '/threads/:threadId/ask', '/memory', '/memory/:memoryId', '/stats'];
const notImplemented = (route: string) => (_req: express.Request, res: express.Response) => {
  res.status(501).json({ error: `not implemented yet: ${route}. Build it in backend/agent/src/.`, status: 501 });
};

for (const route of ROUTES) {
  if (built.includes(route.path)) continue;
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
  app[method](route.path, notImplemented(`${route.method} ${route.path}`));
}

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'agent error');
  if (res.headersSent) return res.end();
  res.status(502).json({ error: err.message, status: 502 });
});

app.listen(env.port, () => {
  log.info(
    {
      port: env.port,
      model: env.llmModel,
      searchProvider: env.searchProvider,
      vectorStore: env.vectorBackend,
      caps: {
        quick: { toolCalls: env.maxToolCalls, wallClockSec: env.maxWallClockSec },
        deep: { toolCalls: env.maxToolCallsDeep, wallClockSec: env.maxWallClockSecDeep, dailyCap: env.deepDailyCap }
      }
    },
    'agent up'
  );
});
