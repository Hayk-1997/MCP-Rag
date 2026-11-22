export type EmbeddingProvider = "local-hash" | "openai";

export interface EmbeddingInfo {
  provider: EmbeddingProvider;
  model: string;
  dim: number;
}

export interface IndexedDoc {
  /** Stable id derived from the document path. */
  id: string;
  /** Path relative to PDF_DIR. */
  path: string;
  title: string;
  pages: number;
  chunks: number;
  bytes: number;
  /** SHA-1 of the file, used for incremental re-indexing. */
  sha1: string;
  indexedAt: string;
  /** 1-based page numbers that had no extractable text (likely scanned). */
  emptyPages: number[];
}

export interface StoredChunk {
  id: string;
  docId: string;
  /** 1-based page number the chunk starts on. */
  page: number;
  /** 0-based position of the chunk inside its document. */
  order: number;
  text: string;
  /** Normalized embedding vector. */
  vector: number[];
}

export interface ChunkingInfo {
  maxChars: number;
  overlapChars: number;
  /** Bump when text extraction or chunking changes so stale chunks are rebuilt. */
  pipelineVersion: number;
}

export interface StoredIndex {
  version: 1;
  createdAt: string;
  embedding: EmbeddingInfo;
  /** Missing on indexes created by older builds (which forces a rebuild). */
  chunking?: ChunkingInfo;
  docs: IndexedDoc[];
  chunks: StoredChunk[];
}

export interface SearchHit {
  chunkId: string;
  docId: string;
  docPath: string;
  docTitle: string;
  page: number;
  text: string;
  /** Combined hybrid score, normalized to 0..1. */
  score: number;
  vectorScore: number;
  lexicalScore: number;
}
