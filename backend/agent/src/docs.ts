/**
 * Spaces and documents.
 *
 * Upload: store the file in GridFS, insert a `pending` document and a `jobs` row, return 202.
 * Nothing is parsed here; the worker (worker.ts) does that.
 *
 * Search: hybrid retrieval over the one `chunks` collection, always filtered by spaceId
 * INSIDE $vectorSearch / $search, fused with reciprocal rank fusion.
 */
import express from 'express';
import multer from 'multer';
import { GridFSBucket } from 'mongodb';
import { CreateSpaceBody, MAX_UPLOAD_BYTES, newId, type Locator } from '@lumina/contract';
import { db } from './db.js';
import { embed } from './embed.js';

export interface ChunkRow {
  _id: string;
  docId: string;
  spaceId: string;
  userId: string;
  title: string;
  text: string;
  locator: Locator;
  ord: number;
  embedding: number[];
  createdAt: Date;
}

const TYPES: Record<string, string> = { pdf: 'application/pdf', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain' };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } }).single('file');

/** The space if it belongs to this user, else null. */
export async function findSpace(spaceId: string, userId: string) {
  return (await db()).collection<{ _id: string; name: string }>('spaces').findOne({ _id: spaceId, userId });
}

export function docRoutes(route: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler) {
  const r = express.Router();
  const user = (req: express.Request) => req.header('x-user-id')!;

  r.post(
    '/spaces',
    route(async (req, res) => {
      const parsed = CreateSpaceBody.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: 'name is required', status: 400 });
      const spaceId = newId('spc');
      await (await db())
        .collection('spaces')
        .insertOne({ _id: spaceId as never, userId: user(req), name: parsed.data.name, createdAt: new Date() });
      res.status(201).json({ spaceId, name: parsed.data.name });
    })
  );

  r.get(
    '/spaces',
    route(async (req, res) => {
      const rows = await (await db())
        .collection<{ _id: string; name: string; createdAt: Date }>('spaces')
        .find({ userId: user(req) })
        .sort({ createdAt: -1 })
        .toArray();
      res.json({ spaces: rows.map((s) => ({ spaceId: s._id, name: s.name, createdAt: s.createdAt.toISOString() })) });
    })
  );

  r.post('/spaces/:spaceId/documents', (req, res, next) =>
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `file is larger than ${MAX_UPLOAD_BYTES} bytes`, status: 413 });
      }
      if (err) return next(err);
      route(async (req, res) => {
        const space = await findSpace(req.params.spaceId!, user(req));
        if (!space) return res.status(404).json({ error: `unknown space ${req.params.spaceId}`, status: 404 });
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'multipart field "file" is required', status: 400 });
        const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
        const mimeType = TYPES[ext];
        if (!mimeType) return res.status(400).json({ error: 'only PDF, Markdown and plain text are accepted', status: 400 });

        const database = await db();
        const docId = newId('doc');
        const stream = new GridFSBucket(database, { bucketName: 'uploads' }).openUploadStream(file.originalname, {
          metadata: { docId, spaceId: space._id, userId: user(req) }
        });
        await new Promise<void>((resolve, reject) => stream.on('finish', () => resolve()).on('error', reject).end(file.buffer));

        await database.collection('documents').insertOne({
          _id: docId as never,
          spaceId: space._id,
          userId: user(req),
          title: file.originalname,
          mimeType,
          bytes: file.size,
          status: 'pending',
          pct: 0,
          fileId: String(stream.id),
          createdAt: new Date()
        });
        await database.collection('jobs').insertOne({
          _id: docId.replace('doc_', 'job_') as never,
          kind: 'index_document',
          status: 'pending',
          payload: { docId },
          userId: user(req),
          attempts: 0,
          createdAt: new Date()
        });
        res.status(202).json({ docId, status: 'pending' });
      })(req, res, next);
    })
  );

  r.get(
    '/spaces/:spaceId/documents',
    route(async (req, res) => {
      const space = await findSpace(req.params.spaceId!, user(req));
      if (!space) return res.status(404).json({ error: `unknown space ${req.params.spaceId}`, status: 404 });
      const rows = await (await db())
        .collection<{ _id: string; title: string; status: string; pct: number; pages?: number; chunks?: number; error?: string }>(
          'documents'
        )
        .find({ spaceId: space._id })
        .sort({ createdAt: 1 })
        .toArray();
      res.json({
        documents: rows.map((d) => ({
          docId: d._id,
          title: d.title,
          status: d.status,
          pct: d.pct,
          ...(d.pages ? { pages: d.pages } : {}),
          ...(d.chunks !== undefined ? { chunks: d.chunks } : {}),
          ...(d.error ? { error: d.error } : {})
        }))
      });
    })
  );

  return r;
}

/**
 * The best chunks in a Space for a query: vector search (meaning) and text search (keywords),
 * fused with reciprocal rank fusion. Both filter by spaceId inside the search stage.
 */
export async function searchDocuments(spaceId: string, query: string, k = 5) {
  const { vector, tokens } = await embed(query);
  const chunks = (await db()).collection<ChunkRow>('chunks');
  const [byVector, byText] = await Promise.all([
    chunks
      .aggregate<ChunkRow>([
        {
          $vectorSearch: {
            index: 'chunks_vector',
            path: 'embedding',
            queryVector: vector,
            numCandidates: 100,
            limit: 10,
            filter: { spaceId }
          }
        },
        { $project: { embedding: 0 } }
      ])
      .toArray(),
    chunks
      .aggregate<ChunkRow>([
        {
          $search: {
            index: 'chunks_text',
            compound: {
              must: [{ text: { query, path: 'text' } }],
              filter: [{ equals: { path: 'spaceId', value: spaceId } }]
            }
          }
        },
        { $limit: 10 },
        { $project: { embedding: 0 } }
      ])
      .toArray()
  ]);

  // RRF: each list adds 1 / (60 + rank). A chunk near the top of both lists wins.
  const scores = new Map<string, { chunk: ChunkRow; score: number }>();
  for (const list of [byVector, byText]) {
    list.forEach((chunk, rank) => {
      const entry = scores.get(chunk._id) ?? { chunk, score: 0 };
      entry.score += 1 / (60 + rank + 1);
      scores.set(chunk._id, entry);
    });
  }
  const top = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, k);
  return { chunks: top.map((e) => e.chunk), tokens };
}
