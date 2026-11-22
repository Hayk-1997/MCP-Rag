import type { Embedder } from "../embedding/index.js";
import { readIndex } from "../ingest/indexer.js";
import type { IndexedDoc, SearchHit, StoredChunk, StoredIndex } from "../types.js";
import { contentTerms } from "../util/text.js";

export interface SearchOptions {
  topK?: number;
  /** 0 = keyword only, 1 = vector only. */
  alpha?: number;
  /** Restrict to one document (id, path or file name). */
  document?: string;
  minScore?: number;
}

interface Bm25Stats {
  documentFrequency: Map<string, number>;
  termFrequencies: Array<Map<string, number>>;
  lengths: number[];
  averageLength: number;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;
/** Raw cosine a query must reach when it has zero keyword overlap. */
const VECTOR_RELEVANCE_FLOOR = 0.12;

/** In-memory view over the persisted index, with hybrid search. */
export class DocumentStore {
  readonly index: StoredIndex;
  private readonly docsById = new Map<string, IndexedDoc>();
  private readonly chunksByDoc = new Map<string, StoredChunk[]>();
  private readonly chunkPositions = new Map<string, number>();
  private bm25?: Bm25Stats;

  private constructor(index: StoredIndex) {
    this.index = index;
    for (const doc of index.docs) this.docsById.set(doc.id, doc);
    index.chunks.forEach((chunk, position) => {
      this.chunkPositions.set(chunk.id, position);
      const list = this.chunksByDoc.get(chunk.docId);
      if (list) list.push(chunk);
      else this.chunksByDoc.set(chunk.docId, [chunk]);
    });
    for (const list of this.chunksByDoc.values()) list.sort((a, b) => a.order - b.order);
  }

  static fromIndex(index: StoredIndex): DocumentStore {
    return new DocumentStore(index);
  }

  static async open(indexPath: string): Promise<DocumentStore> {
    const index = await readIndex(indexPath);
    if (!index) {
      throw new Error(`No search index found at ${indexPath}. Run \`npm run ingest\` first.`);
    }
    if (index.chunks.length === 0) {
      throw new Error(`The index at ${indexPath} contains no chunks. Re-run \`npm run ingest\`.`);
    }
    return new DocumentStore(index);
  }

  get documents(): IndexedDoc[] {
    return this.index.docs;
  }

  get chunkCount(): number {
    return this.index.chunks.length;
  }

  get embedding() {
    return this.index.embedding;
  }

  /** Resolve a user supplied document reference (id, path, file name or title fragment). */
  findDocument(reference: string): { doc?: IndexedDoc; candidates: IndexedDoc[] } {
    const needle = reference.trim().toLowerCase();
    if (!needle) return { candidates: [] };

    const exact = this.index.docs.find(
      (doc) =>
        doc.id.toLowerCase() === needle ||
        doc.path.toLowerCase() === needle ||
        doc.path.split("/").pop()?.toLowerCase() === needle,
    );
    if (exact) return { doc: exact, candidates: [exact] };

    const partial = this.index.docs.filter(
      (doc) => doc.path.toLowerCase().includes(needle) || doc.title.toLowerCase().includes(needle),
    );
    return partial.length === 1 ? { doc: partial[0], candidates: partial } : { candidates: partial };
  }

  async search(query: string, embedder: Embedder, options: SearchOptions = {}): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const alpha = clamp(options.alpha ?? 0.5, 0, 1);
    const topK = Math.max(1, Math.min(50, options.topK ?? 6));

    let filterIds: Set<string> | undefined;
    if (options.document) {
      const { doc, candidates } = this.findDocument(options.document);
      if (!doc) {
        const hint =
          candidates.length > 1
            ? ` It matched several documents: ${candidates.slice(0, 5).map((c) => c.path).join(", ")}.`
            : "";
        throw new Error(`Unknown document "${options.document}".${hint}`);
      }
      filterIds = new Set([doc.id]);
    }

    const queryVector = await embedder.embedQuery(trimmed);
    if (this.index.chunks[0] && queryVector.length !== this.index.chunks[0].vector.length) {
      throw new Error(
        `Embedding dimension mismatch: query has ${queryVector.length} dimensions but the index uses ` +
          `${this.index.chunks[0].vector.length} (${this.index.embedding.provider}/${this.index.embedding.model}). ` +
          `Re-run ingestion with the current embedding settings.`,
      );
    }

    const queryTerms = [...new Set(contentTerms(trimmed))];
    const bm25 = queryTerms.length > 0 ? this.getBm25() : undefined;

    const candidates = filterIds
      ? this.index.chunks.filter((chunk) => filterIds!.has(chunk.docId))
      : this.index.chunks;

    const scored = candidates.map((chunk) => ({
      chunk,
      vectorScore: Math.max(0, dot(queryVector, chunk.vector)),
      lexicalScore: bm25 ? this.bm25Score(chunk, queryTerms, bm25) : 0,
    }));

    // No shared features at all means the query is unrelated to the corpus.
    if (!scored.some((item) => item.vectorScore > 0 || item.lexicalScore > 0)) return [];

    const maxVector = scored.reduce((max, item) => Math.max(max, item.vectorScore), 0) || 1;
    const maxLexical = scored.reduce((max, item) => Math.max(max, item.lexicalScore), 0);

    // Hashed embeddings produce small collision noise. With no keyword overlap
    // at all, only accept the results if the best vector match is convincing.
    if (maxLexical === 0 && maxVector < VECTOR_RELEVANCE_FLOOR) return [];

    const hits: SearchHit[] = scored.map((item) => {
      const vectorPart = item.vectorScore / maxVector;
      const lexicalPart = maxLexical > 0 ? item.lexicalScore / maxLexical : 0;
      const score =
        maxLexical > 0 && alpha > 0 && alpha < 1
          ? alpha * vectorPart + (1 - alpha) * lexicalPart
          : alpha >= 1 || maxLexical === 0
            ? vectorPart
            : lexicalPart;

      const doc = this.docsById.get(item.chunk.docId);
      return {
        chunkId: item.chunk.id,
        docId: item.chunk.docId,
        docPath: doc?.path ?? item.chunk.docId,
        docTitle: doc?.title ?? item.chunk.docId,
        page: item.chunk.page,
        text: item.chunk.text,
        score: round(score),
        vectorScore: round(vectorPart),
        lexicalScore: round(lexicalPart),
      };
    });

    const minScore = options.minScore ?? 0;
    return hits
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score || a.docPath.localeCompare(b.docPath) || a.page - b.page)
      .slice(0, topK);
  }

  /** All stored chunk text for one page of a document. */
  pageText(docId: string, page: number): string | null {
    const chunks = this.chunksByDoc.get(docId)?.filter((chunk) => chunk.page === page);
    if (!chunks || chunks.length === 0) return null;
    return chunks.map((chunk) => chunk.text).join("\n\n");
  }

  documentText(docId: string, maxChars = 200_000): string {
    const chunks = this.chunksByDoc.get(docId) ?? [];
    let text = chunks.map((chunk) => chunk.text).join("\n\n");
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n[... truncated at ${maxChars} characters ...]`;
    return text;
  }

  private getBm25(): Bm25Stats {
    if (this.bm25) return this.bm25;

    const documentFrequency = new Map<string, number>();
    const termFrequencies: Array<Map<string, number>> = [];
    const lengths: number[] = [];

    for (const chunk of this.index.chunks) {
      const terms = contentTerms(chunk.text);
      const frequencies = new Map<string, number>();
      for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      for (const term of frequencies.keys()) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
      termFrequencies.push(frequencies);
      lengths.push(terms.length);
    }

    const total = lengths.reduce((sum, value) => sum + value, 0);
    this.bm25 = {
      documentFrequency,
      termFrequencies,
      lengths,
      averageLength: lengths.length > 0 ? total / lengths.length : 0,
    };
    return this.bm25;
  }

  private bm25Score(chunk: StoredChunk, queryTerms: string[], stats: Bm25Stats): number {
    const position = this.chunkPositions.get(chunk.id) ?? -1;
    const frequencies = stats.termFrequencies[position];
    const length = stats.lengths[position] ?? 0;
    if (!frequencies) return 0;

    const total = this.index.chunks.length;
    let score = 0;

    for (const term of queryTerms) {
      const tf = frequencies.get(term);
      if (!tf) continue;
      const df = stats.documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const denominator = tf + BM25_K1 * (1 - BM25_B + (BM25_B * length) / (stats.averageLength || 1));
      score += idf * ((tf * (BM25_K1 + 1)) / denominator);
    }

    return score;
  }
}

function dot(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < length; i++) total += (a[i] ?? 0) * (b[i] ?? 0);
  return total;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
