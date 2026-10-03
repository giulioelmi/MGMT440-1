/**
 * Long-term memory: written only by an explicit save_memory call, recalled by Atlas Vector
 * Search on memories.embedding filtered by userId. GET /memory shows every row.
 */
import OpenAI from 'openai';
import { newId } from '@lumina/contract';
import { env, secrets } from './env.js';
import { db } from './db.js';

const openai = new OpenAI({ apiKey: secrets.openai || 'missing' });

export interface MemoryRow {
  _id: string;
  userId: string;
  text: string;
  embedding: number[];
  sourceThread?: string;
  createdAt: Date;
}

const memories = async () => (await db()).collection<MemoryRow>('memories');

/** Embed one string. Returns the vector and the tokens it cost. */
export async function embed(text: string): Promise<{ vector: number[]; tokens: number }> {
  if (!secrets.openai) throw new Error('OPENAI_API_KEY is not set');
  const res = await openai.embeddings.create({ model: env.embeddingModel, input: text });
  return { vector: res.data[0]!.embedding, tokens: res.usage.total_tokens };
}

export async function recallMemories(userId: string, query: string) {
  const { vector, tokens } = await embed(query);
  const rows = await (await memories())
    .aggregate<{ text: string }>([
      {
        $vectorSearch: {
          index: 'memories_vector',
          path: 'embedding',
          queryVector: vector,
          numCandidates: 50,
          limit: 5,
          filter: { userId }
        }
      },
      { $project: { _id: 0, text: 1 } }
    ])
    .toArray();
  return { texts: rows.map((r) => r.text), tokens };
}

export async function saveMemory(userId: string, text: string, threadId: string) {
  const { vector, tokens } = await embed(text);
  const id = newId('mem');
  await (await memories()).insertOne({
    _id: id,
    userId,
    text,
    embedding: vector,
    sourceThread: threadId,
    createdAt: new Date()
  });
  return { id, tokens };
}

export async function listMemories(userId: string) {
  const rows = await (await memories())
    .find({ userId }, { projection: { embedding: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map((m) => ({
    id: m._id,
    text: m.text,
    sourceThread: m.sourceThread,
    createdAt: m.createdAt.toISOString()
  }));
}

export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const res = await (await memories()).deleteOne({ _id: id, userId });
  return res.deletedCount === 1;
}
