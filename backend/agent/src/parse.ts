/**
 * Turn an uploaded file into chunks, each with a locator a citation can point at:
 * PDF → {page}, Markdown → {heading}, plain text → {line}.
 */
import type { Locator } from '@lumina/contract';

export interface ParsedChunk {
  text: string;
  locator: Locator;
}

const CHUNK_WORDS = 150;
const OVERLAP_WORDS = 30;

/** Split text into windows of ~150 words that overlap by 30, so a sentence is never cut in half everywhere. */
function windows(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += CHUNK_WORDS - OVERLAP_WORDS) {
    out.push(words.slice(i, i + CHUNK_WORDS).join(' '));
    if (i + CHUNK_WORDS >= words.length) break;
  }
  return out;
}

export async function parseFile(buf: Buffer, mimeType: string): Promise<{ chunks: ParsedChunk[]; pages?: number }> {
  if (mimeType === 'application/pdf') return parsePdf(buf);
  const text = buf.toString('utf8');
  return { chunks: mimeType === 'text/markdown' ? parseMarkdown(text) : parsePlain(text) };
}

async function parsePdf(buf: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;
  const chunks: ParsedChunk[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    const text = content.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : ' ') : '')).join('');
    for (const w of windows(text)) chunks.push({ text: w, locator: { page: p } });
  }
  return { chunks, pages: pdf.numPages };
}

function parseMarkdown(text: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  let heading: string | undefined;
  let body: string[] = [];
  let startLine = 1;
  const flush = () => {
    for (const w of windows(body.join('\n'))) {
      chunks.push({ text: w, locator: heading ? { heading } : { line: startLine } });
    }
    body = [];
  };
  text.split('\n').forEach((line, i) => {
    const m = /^#{1,6}\s+(.*)/.exec(line);
    if (m) {
      flush();
      heading = m[1]!.trim();
      startLine = i + 1;
    } else body.push(line);
  });
  flush();
  return chunks;
}

function parsePlain(text: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  let block: string[] = [];
  let startLine = 1;
  text.split('\n').forEach((line, i) => {
    if (!block.length) startLine = i + 1;
    block.push(line);
    if (block.join(' ').split(/\s+/).length >= CHUNK_WORDS) {
      chunks.push({ text: block.join('\n').trim(), locator: { line: startLine } });
      block = [];
    }
  });
  if (block.join('').trim()) chunks.push({ text: block.join('\n').trim(), locator: { line: startLine } });
  return chunks;
}
