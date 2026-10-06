import type express from 'express';
import { Readable } from 'node:stream';
import { MAX_UPLOAD_BYTES, REQUEST_HEADER, USER_HEADER } from '@lumina/contract';
import { env } from './env.js';
import { sseHeaders } from './sse.js';

const ids = (res: express.Response) => ({
  [USER_HEADER]: String(res.locals.userId ?? ''),
  [REQUEST_HEADER]: String(res.locals.requestId)
});

const unreachable = (res: express.Response, err: unknown) =>
  res.status(502).json({
    error: `agent unreachable: ${(err as Error).message}`,
    status: 502,
    requestId: String(res.locals.requestId)
  });

/** 2xx and 4xx pass through unchanged; agent 5xx becomes 502. Never a fake 2xx. */
async function relay(upstream: globalThis.Response, res: express.Response) {
  const text = await upstream.text();
  res.status(upstream.status >= 500 ? 502 : upstream.status);
  if (text) res.type(upstream.headers.get('content-type') ?? 'application/json').send(text);
  else res.end();
}

export async function forward(req: express.Request, res: express.Response, body?: unknown) {
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: req.method,
      headers: { ...ids(res), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000)
    });
  } catch (err) {
    return unreachable(res, err);
  }
  await relay(upstream, res);
}

/** SSE pass-through: raw bytes written as they arrive, no buffering, no short timeout. */
export async function askPassThrough(req: express.Request, res: express.Response) {
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: 'POST',
      headers: { ...ids(res), 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(req.body),
      signal: abort.signal
    });
  } catch (err) {
    return unreachable(res, err);
  }

  // Refused before streaming (400 / 404 / 429 deep cap / 5xx): relay the JSON.
  if (!upstream.ok || !upstream.body) return relay(upstream, res);

  sseHeaders(res);
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // Upstream broke mid-stream; headers are sent, so just end. The agent emits its own `event: error`.
  } finally {
    res.end();
  }
}

/** Multipart is streamed raw to the agent (which owns multer), boundary intact. */
export async function uploadPassThrough(req: express.Request, res: express.Response) {
  if (Number(req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) {
    return res.status(413).json({
      error: `file is larger than ${MAX_UPLOAD_BYTES} bytes`,
      status: 413,
      requestId: String(res.locals.requestId)
    });
  }
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: 'POST',
      headers: { ...ids(res), 'content-type': req.header('content-type') ?? '' },
      body: Readable.toWeb(req) as unknown as RequestInit['body'],
      duplex: 'half'
    } as RequestInit);
  } catch (err) {
    return unreachable(res, err);
  }
  await relay(upstream, res);
}
