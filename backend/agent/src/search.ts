/**
 * web_search and fetch_page.
 *
 * web_search goes through a two-tier cache: an in-process LRU in front of the
 * `searchCache` collection (TTL index on expiresAt), keyed by sha256(normalized query + provider).
 * Tavily returns each page's text with the results (include_raw_content), so a cache hit
 * also gives us the page text without touching the network.
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { env, secrets } from './env.js';
import { db } from './db.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Full page text when the provider returned it (Tavily). */
  content?: string;
}

const MAX_PAGE_CHARS = 6000;
const LRU_MAX = 500;
const lru = new Map<string, { results: SearchResult[]; expiresAt: number }>();

const normalizeQuery = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').trim();

export async function webSearch(query: string): Promise<{ results: SearchResult[]; cached: boolean }> {
  const provider = env.searchProvider;
  const key = createHash('sha256').update(`${normalizeQuery(query)}|${provider}`).digest('hex');

  // Tier 1: in-process LRU.
  const hit = lru.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    lru.delete(key);
    lru.set(key, hit); // move to most-recently-used
    return { results: hit.results, cached: true };
  }

  // Tier 2: Mongo. The TTL index deletes old rows, but it runs about once a minute, so check expiry too.
  const cache = (await db()).collection<{ _id: string; results: SearchResult[]; expiresAt: Date }>('searchCache');
  const row = await cache.findOne({ _id: key });
  if (row && row.expiresAt.getTime() > Date.now()) {
    remember(key, row.results, row.expiresAt.getTime());
    return { results: row.results, cached: true };
  }

  // Miss: call the provider. Errors propagate: a failed search is a failed step, never "no results".
  const results = provider === 'serpapi' ? await serpapiSearch(query) : await tavilySearch(query);
  const expiresAt = new Date(Date.now() + env.searchCacheTtlSeconds * 1000);
  await cache.updateOne(
    { _id: key },
    { $set: { provider, query, results, expiresAt, createdAt: new Date() } },
    { upsert: true }
  );
  remember(key, results, expiresAt.getTime());
  return { results, cached: false };
}

function remember(key: string, results: SearchResult[], expiresAt: number) {
  lru.set(key, { results, expiresAt });
  if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value as string);
}

async function tavilySearch(query: string): Promise<SearchResult[]> {
  if (!secrets.tavily) throw new Error('TAVILY_API_KEY is not set');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.tavily}` },
    body: JSON.stringify({ query, max_results: 5, include_raw_content: true }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    results?: { title?: string; url: string; content?: string; raw_content?: string | null }[];
  };
  return (body.results ?? []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.content ?? '',
    content: r.raw_content ? cleanText(r.raw_content).slice(0, MAX_PAGE_CHARS) : undefined
  }));
}

async function serpapiSearch(query: string): Promise<SearchResult[]> {
  if (!secrets.serpapi) throw new Error('SERPAPI_API_KEY is not set');
  const url = `https://serpapi.com/search.json?engine=google&num=5&q=${encodeURIComponent(query)}&api_key=${secrets.serpapi}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`serpapi ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { organic_results?: { title: string; link: string; snippet?: string }[] };
  return (body.organic_results ?? []).slice(0, 5).map((r) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet ?? ''
  }));
}

/** Download a page and extract its readable text. Throws on any failure. */
export async function fetchPage(url: string): Promise<{ title: string; text: string }> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; lumina/0.1)' },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).hostname}`);
  const html = (await res.text()).slice(0, 2_000_000);
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const text = cleanText(article?.textContent ?? '');
  if (text.length < 200) throw new Error('page had no readable text');
  return { title: article?.title || url, text: text.slice(0, MAX_PAGE_CHARS) };
}

/** Strip markdown links/images and extra whitespace, keeping paragraph breaks. */
function cleanText(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * The passage a citation rests on: up to 40 consecutive words from one paragraph of the
 * page, picked by overlap with the query. Taken verbatim from the fetched text, so the
 * grounding check can find it in the page.
 */
export function bestPassage(text: string, query: string): string {
  const terms = new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  let best = '';
  let bestScore = -1;
  for (const para of text.split(/\n+/)) {
    const words = para.trim().split(/\s+/);
    if (words.length < 12) continue;
    for (let i = 0; i < words.length; i += 20) {
      const window = words.slice(i, i + 40);
      const score = window.filter((w) => terms.has(w.toLowerCase().replace(/[^a-z0-9]/g, ''))).length;
      if (score > bestScore) {
        best = window.join(' ');
        bestScore = score;
      }
    }
  }
  return best || text.slice(0, 300);
}
