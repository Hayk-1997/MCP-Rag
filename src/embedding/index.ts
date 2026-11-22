import type { EmbeddingInfo, EmbeddingProvider } from "../types.js";
import type { AppConfig } from "../config.js";
import { LocalHashEmbedder } from "./localHash.js";
import { OpenAIEmbedder } from "./openai.js";

export interface Embedder {
  readonly provider: EmbeddingProvider;
  readonly model: string;
  /** Vector size; only known after the first OpenAI response. */
  readonly dim: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

function assertUsableOpenAiConfig(config: AppConfig): void {
  if (config.embedding.apiKey || config.embedding.keylessAllowed) return;
  throw new Error(
    "OpenAI-compatible embeddings need an API key (EMBEDDING_API_KEY / OPENAI_API_KEY), " +
      "or set EMBEDDING_BASE_URL to a keyless endpoint such as http://127.0.0.1:11434/v1.",
  );
}

/** Pick the embedder used to build a brand new index. */
export function createEmbedder(config: AppConfig, override?: { provider?: EmbeddingProvider; model?: string }): Embedder {
  const provider = override?.provider;
  const wantsLocal =
    provider === "local-hash" || (provider === undefined && (config.embedding.choice === "local-hash" || !config.embedding.enabled));
  if (wantsLocal) return new LocalHashEmbedder();

  assertUsableOpenAiConfig(config);
  return new OpenAIEmbedder({
    apiKey: config.embedding.apiKey,
    baseUrl: config.embedding.baseUrl,
    model: override?.model ?? config.embedding.model,
  });
}

/**
 * Build the embedder that matches an existing index. Query vectors must live in
 * the same space as the stored document vectors, so the index wins over config.
 */
export function embedderForIndex(config: AppConfig, info: EmbeddingInfo): Embedder {
  if (info.provider === "local-hash") return new LocalHashEmbedder();

  assertUsableOpenAiConfig(config);
  return new OpenAIEmbedder({
    apiKey: config.embedding.apiKey,
    baseUrl: config.embedding.baseUrl,
    model: info.model,
    expectedDim: info.dim,
  });
}
