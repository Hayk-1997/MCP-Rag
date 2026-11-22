import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Embedder } from "../embedding/index.js";
import { createEmbedder } from "../embedding/index.js";
import type { IndexedDoc, StoredChunk, StoredIndex } from "../types.js";
import { log } from "../util/log.js";
import { normalizeWhitespace } from "../util/text.js";
import { chunkPages } from "./chunker.js";
import { loadAllPdfs, listPdfFiles, type LoadedPdf } from "./pdf.js";

export interface IngestStats {
  documents: number;
  chunks: number;
  pages: number;
  reusedDocuments: number;
  emptyPages: number;
  failedFiles: number;
  durationMs: number;
}

export interface IngestResult {
  index: StoredIndex;
  stats: IngestStats;
}

export interface IngestOptions {
  /** Reuse vectors/doc metadata when the file hash and embedder are unchanged. */
  incremental?: boolean;
  embedder?: Embedder;
  onProgress?: (message: string) => void;
}

const MIN_PAGE_CHARS = 25;
const EMBED_BATCH = 128;
const PIPELINE_VERSION = 2;

export async function readIndex(indexPath: string): Promise<StoredIndex | null> {
  if (!existsSync(indexPath)) return null;
  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as StoredIndex;
    if (parsed.version !== 1 || !Array.isArray(parsed.chunks) || !Array.isArray(parsed.docs)) {
      log.warn(`Ignoring index with unsupported format at ${indexPath}.`);
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn(`Could not read index at ${indexPath}: ${(error as Error).message}`);
    return null;
  }
}

export async function writeIndex(indexPath: string, index: StoredIndex): Promise<void> {
  await mkdir(path.dirname(indexPath), { recursive: true });
  const tempPath = `${indexPath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(index), "utf8");
  await rename(tempPath, indexPath);
}

/**
 * Parse every PDF under config.pdfDir, chunk it, embed the chunks and persist
 * the index. Existing vectors are reused when the file hash matches.
 */
export async function buildIndex(config: AppConfig, options: IngestOptions = {}): Promise<IngestResult> {
  const startedAt = Date.now();
  const report = options.onProgress ?? (() => undefined);

  if (!existsSync(config.pdfDir)) {
    throw new Error(`PDF directory not found: ${config.pdfDir}. Create it and add some .pdf files.`);
  }

  const embedder = options.embedder ?? createEmbedder(config);
  const previous = options.incremental === false ? null : await readIndex(config.indexPath);
  const canReuse =
    previous !== null &&
    previous.embedding.provider === embedder.provider &&
    previous.embedding.model === embedder.model &&
    previous.chunking?.pipelineVersion === PIPELINE_VERSION &&
    previous.chunking?.maxChars === config.chunkSize &&
    previous.chunking?.overlapChars === config.chunkOverlap;

  report(`Scanning ${config.pdfDir} ...`);
  let failedFiles = 0;
  const loaded = await loadAllPdfs(config.pdfDir, () => {
    failedFiles += 1;
  });

  if (loaded.length === 0) {
    throw new Error(
      `No readable PDF files found in ${config.pdfDir}. Add PDFs and run ingestion again. ` +
        `Scanned PDFs without a text layer are not supported (OCR required).`,
    );
  }

  const previousByPath = new Map((previous?.docs ?? []).map((doc) => [doc.path, doc]));
  const chunksByDoc = new Map<string, StoredChunk[]>();
  if (canReuse && previous) {
    for (const chunk of previous.chunks) {
      const list = chunksByDoc.get(chunk.docId);
      if (list) list.push(chunk);
      else chunksByDoc.set(chunk.docId, [chunk]);
    }
  }

  const docs: IndexedDoc[] = [];
  const pending: Array<{ docId: string; page: number; order: number; text: string; title: string }> = [];
  const recycled: StoredChunk[] = [];
  let reusedDocuments = 0;
  let emptyPages = 0;

  for (const pdf of loaded) {
    const docId = makeDocId(pdf);
    const prior = previousByPath.get(pdf.relPath);
    const reusableChunks = canReuse && prior && prior.sha1 === pdf.sha1 ? chunksByDoc.get(docId) : undefined;

    if (prior && reusableChunks) {
      recycled.push(...reusableChunks);
      emptyPages += prior.emptyPages.length;
      docs.push({
        ...prior,
        path: pdf.relPath,
        bytes: pdf.bytes,
        indexedAt: new Date().toISOString(),
      });
      reusedDocuments += 1;
      continue;
    }

    const pages = pdf.pages;
    const emptyPageNumbers: number[] = [];
    pages.forEach((page, index) => {
      if (normalizeWhitespace(page).length < MIN_PAGE_CHARS) emptyPageNumbers.push(index + 1);
    });
    emptyPages += emptyPageNumbers.length;

    const docChunks = chunkPages(pages, { maxChars: config.chunkSize, overlapChars: config.chunkOverlap });
    docChunks.forEach((chunk, order) => {
      pending.push({ docId, page: chunk.page, order, text: chunk.text, title: pdf.title });
    });

    docs.push({
      id: docId,
      path: pdf.relPath,
      title: pdf.title,
      pages: pages.length,
      chunks: docChunks.length,
      bytes: pdf.bytes,
      sha1: pdf.sha1,
      indexedAt: new Date().toISOString(),
      emptyPages: emptyPageNumbers,
    });
  }

  // Documents whose file disappeared should not linger in the index.
  const keptDocIds = new Set(docs.map((doc) => doc.id));
  for (const docId of chunksByDoc.keys()) {
    if (!keptDocIds.has(docId)) chunksByDoc.delete(docId);
  }

  const allChunks: StoredChunk[] = [...recycled];

  if (pending.length > 0) {
    report(`Embedding ${pending.length} chunks from ${docs.length - reusedDocuments} document(s) with ${embedder.provider}/${embedder.model} ...`);

    for (let offset = 0; offset < pending.length; offset += EMBED_BATCH) {
      const batch = pending.slice(offset, offset + EMBED_BATCH);
      const inputs = batch.map((item) => `${item.title}\n\n${item.text}`);
      const vectors = await embedder.embedDocuments(inputs);
      if (vectors.length !== batch.length) {
        throw new Error(`Embedder returned ${vectors.length} vectors for ${batch.length} chunks.`);
      }

      batch.forEach((item, index) => {
        const vector = vectors[index];
        if (!vector) throw new Error(`Missing embedding for chunk ${item.order} of ${item.docId}.`);
        allChunks.push({
          id: `${item.docId}:p${item.page}:c${item.order}`,
          docId: item.docId,
          page: item.page,
          order: item.order,
          text: item.text,
          vector,
        });
      });

      const done = Math.min(offset + batch.length, pending.length);
      report(`Embedded ${done}/${pending.length} chunks`);
    }
  }

  docs.sort((a, b) => a.path.localeCompare(b.path));
  allChunks.sort((a, b) => a.docId.localeCompare(b.docId) || a.order - b.order);

  const dim = embedder.dim || allChunks[0]?.vector.length || 0;
  const index: StoredIndex = {
    version: 1,
    createdAt: new Date().toISOString(),
    embedding: { provider: embedder.provider, model: embedder.model, dim },
    chunking: {
      maxChars: config.chunkSize,
      overlapChars: config.chunkOverlap,
      pipelineVersion: PIPELINE_VERSION,
    },
    docs,
    chunks: allChunks,
  };

  await writeIndex(config.indexPath, index);

  const stats: IngestStats = {
    documents: docs.length,
    chunks: allChunks.length,
    pages: docs.reduce((sum, doc) => sum + doc.pages, 0),
    reusedDocuments,
    emptyPages,
    failedFiles,
    durationMs: Date.now() - startedAt,
  };

  log.info(
    `Indexed ${stats.documents} PDF(s), ${stats.pages} page(s), ${stats.chunks} chunk(s) -> ${config.indexPath} (${stats.durationMs} ms)`,
  );
  if (stats.emptyPages > 0) {
    log.warn(
      `${stats.emptyPages} page(s) had no extractable text. If they are scans, run OCR (e.g. ocrmypdf) before ingesting.`,
    );
  }

  return { index, stats };
}

function makeDocId(pdf: LoadedPdf): string {
  const slug = pdf.relPath
    .toLowerCase()
    .replace(/\.pdf$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha1").update(pdf.relPath).digest("hex").slice(0, 6);
  return `${slug || "doc"}-${hash}`;
}

/** Build the index on first use, then reuse it (ingestion is a separate CLI step). */
export async function ensureIndex(config: AppConfig): Promise<StoredIndex> {
  const existing = await readIndex(config.indexPath);
  if (existing && existing.chunks.length > 0) return existing;

  await mkdir(config.pdfDir, { recursive: true }).catch(() => undefined);
  const files = await listPdfFiles(config.pdfDir).catch(() => []);

  if (files.length === 0) {
    // Start with an empty library instead of refusing to boot: the MCP tools
    // then explain how to add documents.
    log.warn(
      `No PDF files found in ${config.pdfDir}. Starting with an empty library — add PDFs and call reindex_documents.`,
    );
    const embedder = createEmbedder(config);
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      embedding: { provider: embedder.provider, model: embedder.model, dim: embedder.dim },
      chunking: {
        maxChars: config.chunkSize,
        overlapChars: config.chunkOverlap,
        pipelineVersion: PIPELINE_VERSION,
      },
      docs: [],
      chunks: [],
    };
  }

  log.info("No index found — building one from the PDFs now (this happens only once) ...");
  const { index } = await buildIndex(config);
  return index;
}
