import type { EmbeddingProvider } from "../types.js";
import type { Embedder } from "./index.js";

export interface OpenAIEmbedderOptions {
  /** Omit for keyless OpenAI-compatible endpoints (e.g. local Ollama). */
  apiKey?: string;
  baseUrl: string;
  model: string;
  expectedDim?: number;
  batchSize?: number;
}

const BATCH_SIZE_DEFAULT = 64;

/** OpenAI-compatible embeddings (also works with Azure/OpenRouter/Voyage proxies). */
export class OpenAIEmbedder implements Embedder {
  readonly provider: EmbeddingProvider = "openai";
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly expectedDim: number | undefined;
  private readonly batchSize: number;
  private resolvedDim = 0;

  constructor(options: OpenAIEmbedderOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.expectedDim = options.expectedDim;
    this.batchSize = options.batchSize ?? BATCH_SIZE_DEFAULT;
  }

  get dim(): number {
    return this.expectedDim ?? this.resolvedDim;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedDocuments([text]);
    if (!vector) throw new Error("Embedding API returned no vector.");
    return vector;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      results.push(...(await this.request(batch)));
    }
    return results;
  }

  private async request(batch: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, input: batch, encoding_format: "float" }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Embedding request failed (${response.status} ${response.statusText}): ${body.slice(0, 500)}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding: number[]; index: number }>;
    };
    if (!payload.data || payload.data.length !== batch.length) {
      throw new Error(`Embedding API returned ${payload.data?.length ?? 0} vectors for ${batch.length} inputs.`);
    }

    const ordered = [...payload.data].sort((a, b) => a.index - b.index);
    return ordered.map((item) => normalize(item.embedding, this.expectedDim ?? item.embedding.length));
  }
}

function normalize(vector: number[], dim: number): number[] {
  if (vector.length !== dim) {
    throw new Error(`Embedding dimension mismatch: expected ${dim}, got ${vector.length}.`);
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}
