#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, type TransportKind } from "./config.js";
import { buildMcpServer } from "./mcp/server.js";
import { RagEngine } from "./rag.js";
import { log } from "./util/log.js";

interface CliArgs {
  transport?: TransportKind;
  port?: number;
  host?: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--transport":
        args.transport = next() === "http" ? "http" : "stdio";
        break;
      case "--port":
        args.port = Number(next());
        break;
      case "--host":
        args.host = next();
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`pdf-rag-mcp — RAG over your local PDF files

Usage:
  pdf-rag-mcp [--transport stdio|http] [--host 127.0.0.1] [--port 8787]

Environment (or .env):
  PDF_DIR               Folder with PDFs (default ./pdfs)
  INDEX_PATH            Index file (default ./data/index.json)
  EMBEDDING_PROVIDER    auto | local | openai (default auto)
  OPENAI_API_KEY        Enables OpenAI embeddings and written answers
  OPENAI_BASE_URL       OpenAI-compatible endpoint (default https://api.openai.com/v1)
  CHAT_BASE_URL         Chat endpoint (Ollama/LM Studio/Groq/OpenRouter); keyless OK
  CHAT_API_KEY          Key for the chat endpoint, if required
  CHAT_MODEL            Model name (e.g. llama3.2, llama-3.3-70b-versatile)
  LLM_ENABLED           auto (default), true or false
  TOP_K                 Default number of retrieved passages
  HYBRID_ALPHA          Vector vs BM25 weight, 0..1 (default 0.5)

Examples:
  npm run ingest                       Build/refresh the index
  npm start                            Run MCP over stdio (for Claude Desktop, Cursor, ...)
  npm run serve:http                   Run MCP over Streamable HTTP on :8787/mcp

Run "npm run ingest" first so the index exists.
`);
}

/** Anything printed to stdout corrupts the JSON-RPC stream, so redirect it. */
function guardStdout(): void {
  const toStderr = (...args: unknown[]) => {
    const text = args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 2 }))).join(" ");
    process.stderr.write(`${text}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n`);
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    process.stdout.write("pdf-rag-mcp 1.0.0\n");
    return;
  }

  if (args.transport) config.transport = args.transport;
  if (args.host) config.host = args.host;
  if (Number.isFinite(args.port)) config.port = args.port!;

  if (config.transport === "stdio") guardStdout();

  process.on("unhandledRejection", (reason) => log.error("Unhandled rejection", reason));
  process.on("uncaughtException", (error) => {
    log.error("Uncaught exception", error);
    process.exit(1);
  });

  log.info(`Starting with PDFs from ${config.pdfDir}`);
  const engine = await RagEngine.create(config);

  if (config.transport === "http") {
    await serveHttp(engine);
  } else {
    await serveStdio(buildMcpServer(engine));
  }
}

async function serveStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server listening on stdio");

  const shutdown = async () => {
    log.info("Shutting down");
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function serveHttp(engine: RagEngine): Promise<void> {
  // Stateful Streamable HTTP: one McpServer + transport per client session.
  // The expensive parts (index, embedder) are shared through `engine`.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/health") {
        sendJson(res, 200, { status: "ok", transport: "http", sessions: sessions.size, ...engine.stats });
        return;
      }

      if (url.pathname !== "/mcp") {
        sendJson(res, 404, { error: "Not found", hint: "The MCP endpoint is /mcp" });
        return;
      }

      if (req.headers.origin) {
        res.setHeader("access-control-allow-origin", req.headers.origin);
        res.setHeader("access-control-allow-headers", "content-type, mcp-session-id, mcp-protocol-version");
        res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      const sessionHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

      let transport = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !transport) {
        sendJson(res, 404, { error: "Session not found", hint: "Send an initialize request without mcp-session-id." });
        return;
      }

      const body = req.method === "POST" ? await readJsonBody(req) : undefined;

      if (!transport) {
        // No session yet: this must be an initialize request. Build a dedicated
        // server instance so concurrent clients cannot share protocol state.
        const server = buildMcpServer(engine);
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, created);
            log.info(`HTTP session ${id} initialized (${sessions.size} active)`);
          },
        });
        created.onclose = () => {
          if (created.sessionId) sessions.delete(created.sessionId);
          void server.close().catch(() => undefined);
        };
        await server.connect(created);
        transport = created;
      }

      if (req.method === "POST") {
        await transport.handleRequest(req, res, body);
      } else {
        await transport.handleRequest(req, res);
      }
    } catch (error) {
      const message = (error as Error).message;
      log.warn(`HTTP request failed: ${message}`);
      if (!res.headersSent) sendJson(res, 400, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });

  log.info(`MCP server listening on http://${config.host}:${config.port}/mcp`);

  const shutdown = async () => {
    log.info("Shutting down");
    for (const transport of sessions.values()) {
      await transport.close().catch(() => undefined);
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large (max 5 MB).");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

main().catch((error) => {
  log.error("Fatal error", error);
  process.exit(1);
});
