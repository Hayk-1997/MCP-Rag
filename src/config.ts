import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, whether we run from src/ (tsx) or dist/ (node). */
export const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

// Load .env without pulling in a dependency (Node >= 20.12).
const envFile = path.join(projectRoot, ".env");
if (existsSync(envFile)) {
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(envFile);
  } catch {
    // Ignore malformed .env; environment variables still win.
  }
}

function str(name: string, fallback?: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}

function num(name: string, fallback: number): number {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEnabled(name: string, fallback: boolean): boolean {
  const raw = (str(name, "auto") ?? "auto").toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "").toLowerCase();
}

function isDefaultOpenAiUrl(value: string | undefined): boolean {
  return value === undefined || normalizeBaseUrl(value) === normalizeBaseUrl(DEFAULT_OPENAI_BASE_URL);
}

function resolveFromRoot(p: string | undefined, fallback: string): string {
  const value = p && p.length > 0 ? p : fallback;
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export type TransportKind = "stdio" | "http";
export type ProviderChoice = "auto" | "local" | "local-hash" | "openai";

export interface AppConfig {
  root: string;
  pdfDir: string;
  indexPath: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  hybridAlpha: number;
  embedding: {
    choice: ProviderChoice;
    /** True when embeddings should come from an OpenAI-compatible endpoint. */
    enabled: boolean;
    /** True when that endpoint can be used without an API key. */
    keylessAllowed: boolean;
    model: string;
    baseUrl: string;
    apiKey?: string;
  };
  chat: {
    /** True when answer synthesis should call an OpenAI-compatible chat endpoint. */
    enabled: boolean;
    model: string;
    baseUrl: string;
    apiKey?: string;
    temperature: number;
    maxTokens: number;
  };
  transport: TransportKind;
  host: string;
  port: number;
}

// --- Embeddings -------------------------------------------------------------
const embeddingProviderRaw = (str("EMBEDDING_PROVIDER", "auto") ?? "auto").toLowerCase();
const embeddingChoice: ProviderChoice =
  embeddingProviderRaw === "local" || embeddingProviderRaw === "local-hash"
    ? "local-hash"
    : embeddingProviderRaw === "openai"
      ? "openai"
      : "auto";

const openAiBaseUrlSetting = str("OPENAI_BASE_URL");
const embeddingBaseUrlSetting = str("EMBEDDING_BASE_URL");
const embeddingBaseUrl =
  embeddingBaseUrlSetting ?? openAiBaseUrlSetting ?? DEFAULT_OPENAI_BASE_URL;
const embeddingApiKey = str("EMBEDDING_API_KEY") ?? str("OPENAI_API_KEY");
const embeddingExplicitKeylessEndpoint =
  embeddingBaseUrlSetting !== undefined && !isDefaultOpenAiUrl(embeddingBaseUrlSetting);
const embeddingEnabled =
  embeddingChoice === "openai" ||
  (embeddingChoice === "auto" && (embeddingApiKey !== undefined || embeddingExplicitKeylessEndpoint));
const embeddingKeylessAllowed =
  !isDefaultOpenAiUrl(embeddingBaseUrl) &&
  (embeddingExplicitKeylessEndpoint || (embeddingChoice === "openai" && openAiBaseUrlSetting !== undefined));

// --- Chat -------------------------------------------------------------------
const chatBaseUrlSetting = str("CHAT_BASE_URL");
const chatBaseUrl = chatBaseUrlSetting ?? openAiBaseUrlSetting ?? DEFAULT_OPENAI_BASE_URL;
const chatApiKeySetting = str("CHAT_API_KEY") ?? str("OPENAI_API_KEY");
const chatKeylessEndpoint =
  !isDefaultOpenAiUrl(chatBaseUrl) && (chatBaseUrlSetting !== undefined || openAiBaseUrlSetting !== undefined);
const llmOverride = str("LLM_ENABLED");
const chatEnabled =
  llmOverride === undefined
    ? chatApiKeySetting !== undefined || chatKeylessEndpoint
    : parseEnabled("LLM_ENABLED", false);
// Some hosted endpoints require an Authorization header even when the key is a
// placeholder. Local servers ignore it, but sending "not-needed" is harmless.
const chatApiKey = chatApiKeySetting ?? (chatEnabled ? "not-needed" : undefined);

export const config: AppConfig = {
  root: projectRoot,
  pdfDir: resolveFromRoot(str("PDF_DIR"), path.join(projectRoot, "pdfs")),
  indexPath: resolveFromRoot(str("INDEX_PATH"), path.join(projectRoot, "data", "index.json")),
  chunkSize: Math.max(300, num("CHUNK_SIZE", 1000)),
  chunkOverlap: Math.max(0, num("CHUNK_OVERLAP", 150)),
  topK: Math.min(20, Math.max(1, num("TOP_K", 6))),
  hybridAlpha: Math.min(1, Math.max(0, num("HYBRID_ALPHA", 0.5))),
  embedding: {
    choice: embeddingChoice,
    enabled: embeddingEnabled,
    keylessAllowed: embeddingKeylessAllowed,
    model: str("EMBEDDING_MODEL", "text-embedding-3-small")!,
    baseUrl: embeddingBaseUrl,
    apiKey: embeddingApiKey,
  },
  chat: {
    enabled: chatEnabled,
    model: str("CHAT_MODEL", "gpt-4o-mini")!,
    baseUrl: chatBaseUrl,
    apiKey: chatApiKey,
    temperature: num("CHAT_TEMPERATURE", 0.1),
    maxTokens: num("CHAT_MAX_TOKENS", 800),
  },
  transport: (str("MCP_TRANSPORT", "stdio") === "http" ? "http" : "stdio") as TransportKind,
  host: str("HOST", "127.0.0.1")!,
  port: num("PORT", 8787),
};
