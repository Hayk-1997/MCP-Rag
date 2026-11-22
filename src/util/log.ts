/**
 * Logging helper. The MCP server speaks JSON-RPC over stdout, so every
 * diagnostic message MUST go to stderr.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;

function emit(level: LogLevel, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  const suffix = extra === undefined ? "" : ` ${safeStringify(extra)}`;
  process.stderr.write(`[pdf-rag-mcp] ${stamp} ${level.toUpperCase()} ${message}${suffix}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (message: string, extra?: unknown) => emit("debug", message, extra),
  info: (message: string, extra?: unknown) => emit("info", message, extra),
  warn: (message: string, extra?: unknown) => emit("warn", message, extra),
  error: (message: string, extra?: unknown) => emit("error", message, extra),
};
