import { normalizeWhitespace } from "../util/text.js";

export interface ChunkOptions {
  maxChars: number;
  overlapChars: number;
}

export interface TextChunk {
  /** 1-based page the chunk starts on. */
  page: number;
  text: string;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"'“(\[])/;

function splitLongBlock(block: string, maxChars: number): string[] {
  const sentences = block.split(SENTENCE_SPLIT).flatMap((s) => (s.length > maxChars ? hardWrap(s, maxChars) : [s]));
  const parts: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= maxChars) {
      current += ` ${sentence}`;
    } else {
      parts.push(current);
      current = sentence;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Last resort for text with no sentence punctuation (tables, etc.). */
function hardWrap(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Start the next chunk with a little context from the previous one. */
function overlapTail(text: string, overlapChars: number): string {
  if (overlapChars <= 0) return "";
  const tail = text.slice(Math.max(0, text.length - overlapChars));
  const boundary = tail.search(/[.!?]\s/);
  if (boundary >= 0 && boundary < tail.length - 40) return tail.slice(boundary + 1).trim();
  return tail.trim();
}

/**
 * Split one page of text into overlapping chunks, preferring paragraph and
 * sentence boundaries so citations stay readable.
 */
export function chunkPageText(pageText: string, options: ChunkOptions): string[] {
  const text = normalizeWhitespace(pageText);
  if (!text) return [];

  const blocks = text
    .split(/\n{2,}/)
    .flatMap((block) => (block.length > options.maxChars ? splitLongBlock(block, options.maxChars) : [block]))
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }
    if (current.length + 2 + block.length <= options.maxChars) {
      current += `\n\n${block}`;
      continue;
    }
    chunks.push(current);
    const tail = overlapTail(current, options.overlapChars);
    current = tail ? `${tail}\n\n${block}` : block;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.replace(/\s/g, "").length > 0);
}

/** Page-aware chunking: never mixes text from different PDF pages. */
export function chunkPages(pages: string[], options: ChunkOptions): TextChunk[] {
  const chunks: TextChunk[] = [];
  pages.forEach((pageText, index) => {
    for (const text of chunkPageText(pageText, options)) {
      chunks.push({ page: index + 1, text });
    }
  });
  return chunks;
}
