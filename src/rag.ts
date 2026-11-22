import type { AppConfig } from "./config.js";
import type { Embedder } from "./embedding/index.js";
import { embedderForIndex } from "./embedding/index.js";
import { buildIndex, ensureIndex, type IngestResult, type IngestStats } from "./ingest/indexer.js";
import { DocumentStore, type SearchOptions } from "./store/store.js";
import type { IndexedDoc, SearchHit } from "./types.js";
import { answerQuestion, type AnswerResult } from "./llm/answer.js";

export interface AskOptions extends SearchOptions {
  /** Character budget for the context handed to the model. */
  maxContextChars?: number;
}

/**
 * Owns the index, the matching embedder and the retrieval/answer pipeline.
 * Everything the MCP tools need goes through this class.
 */
export class RagEngine {
  private constructor(
    readonly config: AppConfig,
    private store: DocumentStore,
    private embedder: Embedder,
  ) {}

  static async create(config: AppConfig): Promise<RagEngine> {
    const index = await ensureIndex(config);
    // The index dictates the embedding space, not the current environment.
    const embedder = embedderForIndex(config, index.embedding);
    return new RagEngine(config, DocumentStore.fromIndex(index), embedder);
  }

  get documents(): IndexedDoc[] {
    return this.store.documents;
  }

  get stats(): { documents: number; pages: number; chunks: number; embedder: string } {
    return {
      documents: this.store.documents.length,
      pages: this.store.documents.reduce((sum, doc) => sum + doc.pages, 0),
      chunks: this.store.chunkCount,
      embedder: `${this.store.embedding.provider}/${this.store.embedding.model}`,
    };
  }

  get embedding() {
    return this.store.embedding;
  }

  async search(query: string, options: AskOptions = {}): Promise<SearchHit[]> {
    return this.store.search(query, this.embedder, {
      topK: options.topK ?? this.config.topK,
      alpha: options.alpha ?? this.config.hybridAlpha,
      document: options.document,
      minScore: options.minScore ?? 0.05,
    });
  }

  async ask(question: string, options: AskOptions = {}): Promise<AnswerResult> {
    const hits = await this.search(question, options);
    return answerQuestion(question, hits, this.config, {
      maxContextChars: options.maxContextChars,
    });
  }

  findDocument(reference: string) {
    return this.store.findDocument(reference);
  }

  pageText(docId: string, page: number): string | null {
    return this.store.pageText(docId, page);
  }

  documentText(docId: string): string {
    return this.store.documentText(docId);
  }

  /** Re-parse the PDF directory and swap in the new index. */
  async reindex(options: { incremental?: boolean; onProgress?: (message: string) => void } = {}): Promise<IngestResult> {
    const result = await buildIndex(this.config, {
      incremental: options.incremental,
      onProgress: options.onProgress,
    });
    this.store = DocumentStore.fromIndex(result.index);
    this.embedder = embedderForIndex(this.config, result.index.embedding);
    return result;
  }
}

export type { AnswerResult, IngestStats, SearchHit };
