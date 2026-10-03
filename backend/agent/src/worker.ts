/**
 * The jobs worker. Runs as its own process (started by index.ts, or `npm run worker`),
 * so parsing a big PDF never blocks a streaming answer.
 *
 * index_document → GridFS read → parse → chunk → embed → insert chunks →
 *                  READ-YOUR-WRITE PROBE → status: 'indexed'
 *
 * Crash safety: a job claimed by a worker that died stays `running` with an old claimedAt;
 * the sweeper puts it back to `pending`. Once the chunks are written the job is marked
 * stage: 'probe', so a retry goes straight to the probe instead of embedding again.
 */
import pino from 'pino';
import { GridFSBucket, ObjectId } from 'mongodb';
import { env } from './env.js';
import { db } from './db.js';
import { embedMany } from './embed.js';
import { parseFile } from './parse.js';
import type { ChunkRow } from './docs.js';

const log = pino({ level: env.logLevel });
const workerId = `worker_${process.pid}`;
const STALE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const EMBED_BATCH = 64;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface JobRow {
  _id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  payload: { docId: string };
  attempts: number;
  stage?: 'probe';
  claimedAt?: Date;
}
interface DocRow {
  _id: string;
  spaceId: string;
  userId: string;
  title: string;
  mimeType: string;
  fileId: string;
}

async function main(): Promise<void> {
  process.on('disconnect', () => process.exit(0)); // the agent that started us is gone
  const database = await db();
  const jobs = database.collection<JobRow>('jobs');
  log.info({ workerId }, 'worker up');

  let lastSweep = 0;
  for (;;) {
    if (Date.now() - lastSweep > 30_000) {
      lastSweep = Date.now();
      const swept = await jobs.updateMany(
        { status: 'running', claimedAt: { $lt: new Date(Date.now() - STALE_MS) } },
        { $set: { status: 'pending' } }
      );
      if (swept.modifiedCount) log.warn({ count: swept.modifiedCount }, 'swept stale jobs back to pending');
    }

    // Atomic claim: two workers can never get the same job.
    const job = await jobs.findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'running', claimedAt: new Date(), workerId }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, returnDocument: 'after' }
    );
    if (!job) {
      await sleep(1000);
      continue;
    }

    const docId = job.payload.docId;
    try {
      await indexDocument(job);
      await jobs.updateOne({ _id: job._id }, { $set: { status: 'done' } });
      log.info({ docId, jobId: job._id }, 'indexed');
    } catch (err) {
      const error = (err as Error).message || String(err);
      const giveUp = job.attempts >= MAX_ATTEMPTS;
      await jobs.updateOne({ _id: job._id }, { $set: { status: giveUp ? 'failed' : 'pending', error } });
      if (giveUp) await database.collection('documents').updateOne({ _id: docId as never }, { $set: { status: 'failed', error } });
      log.error({ docId, jobId: job._id, attempt: job.attempts, error }, giveUp ? 'job failed' : 'job will retry');
    }
  }
}

async function indexDocument(job: JobRow) {
  const database = await db();
  const documents = database.collection<DocRow & { status: string; pct: number }>('documents');
  const chunks = database.collection<ChunkRow>('chunks');
  const doc = await documents.findOne({ _id: job.payload.docId });
  if (!doc) throw new Error(`document ${job.payload.docId} not found`);
  const setDoc = (fields: Record<string, unknown>) => documents.updateOne({ _id: doc._id }, { $set: fields });

  if (job.stage !== 'probe') {
    await setDoc({ status: 'parsing', pct: 5 });
    const buf = await readFile(doc.fileId);
    const { chunks: parsed, pages } = await parseFile(buf, doc.mimeType);
    if (!parsed.length) throw new Error('no text could be extracted from the file');

    await setDoc({ status: 'embedding', pct: 20, ...(pages ? { pages } : {}) });
    await chunks.deleteMany({ docId: doc._id }); // an earlier, crashed attempt may have written some
    for (let i = 0; i < parsed.length; i += EMBED_BATCH) {
      const batch = parsed.slice(i, i + EMBED_BATCH);
      const { vectors } = await embedMany(batch.map((c) => c.text));
      await chunks.insertMany(
        batch.map((c, j) => ({
          _id: `${doc._id}_${i + j}`,
          docId: doc._id,
          spaceId: doc.spaceId,
          userId: doc.userId,
          title: doc.title,
          text: c.text,
          locator: c.locator,
          ord: i + j,
          embedding: vectors[j]!,
          createdAt: new Date()
        }))
      );
      await setDoc({ pct: 20 + Math.round((70 * (i + batch.length)) / parsed.length) });
    }
    await setDoc({ chunks: parsed.length });
    await database.collection<JobRow>('jobs').updateOne({ _id: job._id }, { $set: { stage: 'probe' } });
  }

  // Read-your-write probe: "inserted" is not "searchable". Ask the vector index for one of
  // the chunks we just wrote, and only call the document indexed once it comes back.
  const first = await chunks.findOne({ docId: doc._id }, { sort: { ord: 1 } });
  if (!first) throw new Error('no chunks found for the probe');
  for (let tries = 0; tries < 60; tries++) {
    const found = await chunks
      .aggregate([
        {
          $vectorSearch: {
            index: 'chunks_vector',
            path: 'embedding',
            queryVector: first.embedding,
            numCandidates: 100,
            limit: 10,
            filter: { spaceId: doc.spaceId }
          }
        },
        { $match: { docId: doc._id } },
        { $limit: 1 }
      ])
      .toArray();
    if (found.length) {
      await setDoc({ status: 'indexed', pct: 100 });
      return;
    }
    await sleep(2000);
  }
  throw new Error('read-your-write probe: the chunks were not searchable after 120 s');
}

async function readFile(fileId: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  const stream = new GridFSBucket(await db(), { bucketName: 'uploads' }).openDownloadStream(new ObjectId(fileId));
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'worker crashed');
  process.exit(1);
});
