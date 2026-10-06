import type express from 'express';
import type { ZodTypeAny } from 'zod';
import { USER_HEADER } from '@lumina/contract';
import { env } from './env.js';

const fail = (res: express.Response, status: number, error: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ error, status, ...extra, requestId: String(res.locals.requestId) });

const API_PATH = /^\/(stats|threads|memory|spaces)(\/|$)/;

/** 401 without X-User-Id on API routes. /health, /evals/report.json and the UI stay open. */
export const requireUser: express.RequestHandler = (req, res, next) => {
  if (!API_PATH.test(req.path)) return next();
  const user = req.header(USER_HEADER)?.trim();
  if (!user) return fail(res, 401, 'X-User-Id header is required');
  res.locals.userId = user;
  next();
};

/** 400 with the zod message; forwards the parsed body so contract defaults are filled in. */
export const validate =
  (schema: ZodTypeAny): express.RequestHandler =>
  (req, res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return fail(res, 400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    }
    req.body = parsed.data;
    next();
  };

/**
 * Rate limits, layered by cost (DESIGN.md trade-off 6). Token buckets in gateway memory:
 * per instance, reset on restart. The deep-search daily cap is not here; it lives in the agent.
 */
const MINUTE = 60_000;
const GENERAL_PER_MINUTE = 120;
const IP_PER_MINUTE = 120;
const MAX_OPEN_ASKS = 5;

type Bucket = { tokens: number; updatedAt: number };

/** A bucket of `capacity` tokens refilling at `capacity` per minute: a short burst, then a steady rate. */
function bucketLimiter(capacity: number) {
  const buckets = new Map<string, Bucket>();
  const refill = (b: Bucket, now: number) => {
    b.tokens = Math.min(capacity, b.tokens + ((now - b.updatedAt) / MINUTE) * capacity);
    b.updatedAt = now;
  };
  // Drop buckets that have refilled to full, so rotating ids cannot fill memory.
  setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      refill(b, now);
      if (b.tokens >= capacity) buckets.delete(key);
    }
  }, MINUTE).unref();

  return (key: string) => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { tokens: capacity, updatedAt: now }));
    refill(b, now);
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    return {
      ok,
      capacity,
      remaining: Math.floor(b.tokens),
      msToNext: ok ? 0 : ((1 - b.tokens) / capacity) * MINUTE,
      msToFull: ((capacity - b.tokens) / capacity) * MINUTE
    };
  };
}

type Verdict = ReturnType<ReturnType<typeof bucketLimiter>>;

function rateHeaders(res: express.Response, v: Verdict) {
  res.setHeader('RateLimit-Limit', String(v.capacity));
  res.setHeader('RateLimit-Remaining', String(v.remaining));
  res.setHeader('RateLimit-Reset', String(Math.ceil(v.msToFull / 1000)));
}

function tooMany(res: express.Response, error: string, retryMs: number) {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryMs / 1000))));
  fail(res, 429, error, { resetsAt: new Date(Date.now() + retryMs).toISOString() });
}

/** Fly sets Fly-Client-IP itself; locally fall back to the socket address. */
const clientIp = (req: express.Request) =>
  req.header('fly-client-ip')?.trim() || req.socket.remoteAddress || 'unknown';

const costlyByUser = bucketLimiter(env.rateLimitPerMinute);
const costlyByIp = bucketLimiter(IP_PER_MINUTE);
const generalByUser = bucketLimiter(GENERAL_PER_MINUTE);

/** Asks and uploads: a per-IP backstop, then the per-user bucket of RATE_LIMIT_PER_MINUTE. */
export const limitCostly: express.RequestHandler = (req, res, next) => {
  const ip = costlyByIp(clientIp(req));
  if (!ip.ok) return tooMany(res, `rate limit: ${IP_PER_MINUTE} asks or uploads per minute from one IP`, ip.msToNext);
  const user = costlyByUser(String(res.locals.userId));
  rateHeaders(res, user);
  if (!user.ok) return tooMany(res, `rate limit: ${env.rateLimitPerMinute} asks or uploads per minute`, user.msToNext);
  next();
};

/** Every other API route: loose enough for status polling every ~1.2 s. */
export const limitGeneral: express.RequestHandler = (_req, res, next) => {
  const v = generalByUser(String(res.locals.userId));
  rateHeaders(res, v);
  if (!v.ok) return tooMany(res, `rate limit: ${GENERAL_PER_MINUTE} requests per minute`, v.msToNext);
  next();
};

/** At most MAX_OPEN_ASKS answer streams open per user; a slot frees when the response closes. */
const openAsks = new Map<string, number>();
export const limitOpenAsks: express.RequestHandler = (_req, res, next) => {
  const user = String(res.locals.userId);
  const open = openAsks.get(user) ?? 0;
  if (open >= MAX_OPEN_ASKS) return tooMany(res, `too many open answers: at most ${MAX_OPEN_ASKS} at once`, 5_000);
  openAsks.set(user, open + 1);
  res.once('close', () => {
    const n = (openAsks.get(user) ?? 1) - 1;
    if (n <= 0) openAsks.delete(user);
    else openAsks.set(user, n);
  });
  next();
};
