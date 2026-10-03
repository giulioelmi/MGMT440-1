/** OpenAI embeddings, used for memories and document chunks. */
import OpenAI from 'openai';
import { env, secrets } from './env.js';

const openai = new OpenAI({ apiKey: secrets.openai || 'missing' });

/** Embed several strings in one call. Returns the vectors (same order) and the tokens it cost. */
export async function embedMany(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
  if (!secrets.openai) throw new Error('OPENAI_API_KEY is not set');
  const res = await openai.embeddings.create({ model: env.embeddingModel, input: texts });
  return { vectors: res.data.map((d) => d.embedding), tokens: res.usage.total_tokens };
}

export async function embed(text: string): Promise<{ vector: number[]; tokens: number }> {
  const { vectors, tokens } = await embedMany([text]);
  return { vector: vectors[0]!, tokens };
}
