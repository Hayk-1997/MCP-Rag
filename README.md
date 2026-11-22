# PDF RAG MCP Server

A Node.js **MCP server** that turns a folder of static PDF files into a searchable knowledge base. Any MCP client (Claude Desktop, Claude Code, Cursor, VS Code, the MCP Inspector, or your own agent) can ask a question in natural language and get back relevant passages — or a written answer with page-level citations.

Runs fully offline by default. An API key is optional: you can also connect a free local model (Ollama, LM Studio) or a free hosted tier (Groq, OpenRouter `:free` models) for written, cited answers.

```
┌──────────────┐   MCP (stdio / HTTP)   ┌──────────────────────────────────────────┐
│ MCP client   │ ─────────────────────▶ │  pdf-rag-mcp                             │
│ (Claude,     │   ask_documents        │                                          │
│  Cursor…)    │ ◀───────────────────── │  1. retrieve  ── hybrid BM25 + vectors   │
└──────────────┘   answer + citations   │  2. rerank/merge ── score normalisation  │
                                        │  3. answer    ── LLM or best passages    │
                                        └───────────────▲──────────────────────────┘
                                                        │ reads at startup
                                        ┌───────────────┴──────────────────────────┐
                                        │ data/index.json  (chunks + embeddings)   │
                                        └───────────────▲──────────────────────────┘
                                                        │ built by `npm run ingest`
                                        ┌───────────────┴──────────────────────────┐
                                        │ pdfs/**/*.pdf → text per page → chunks   │
                                        └──────────────────────────────────────────┘
```

## Quick start

```bash
npm install
npm run sample      # optional: writes two demo PDFs into ./pdfs
npm run ingest      # parse + chunk + embed -> data/index.json
npm start           # MCP server on stdio
```

Drop your own PDFs into `pdfs/` (subfolders are scanned recursively), run `npm run ingest`, and you are done. The server also builds the index automatically on first start if it is missing.

### Try it without configuring a client

Ask a question straight from the terminal (no MCP client needed):

```bash
npm run ask -- "What encryption is used for data at rest?"   # one question
npm run ask                                                  # interactive prompt
npm run search -- "Kubernetes version required"              # raw passages
```

In interactive mode, type a question and press Enter; type `q` or `exit` to quit. Add `--json` for machine-readable output, `--top-k 3` to limit retrieved passages, or `--document guide.pdf` to search a single PDF — for example `npm run ask -- --json --top-k 3 "what does error OR-5031 mean?"`. Without a configured chat model, the "answer" is the best-matching passages; with one it is a written answer with citations.

### Use a free or local LLM

The chat client speaks the OpenAI-compatible API, so no OpenAI account is needed. Set these in `.env` (or in the MCP client's `env` block), then run `npm run llm:check`.

**Ollama — free, fully local.** Install Ollama, run `ollama pull llama3.2`, then:

```dotenv
LLM_ENABLED=true
CHAT_BASE_URL=http://127.0.0.1:11434/v1
CHAT_MODEL=llama3.2
```

**LM Studio — free, fully local.** Start the model's local server, then:

```dotenv
LLM_ENABLED=true
CHAT_BASE_URL=http://127.0.0.1:1234/v1
CHAT_MODEL=local-model
```

**Groq — free hosted tier** (free API key required):

```dotenv
CHAT_BASE_URL=https://api.groq.com/openai/v1
CHAT_API_KEY=gsk_...
CHAT_MODEL=llama-3.3-70b-versatile
```

**OpenRouter — free models** (free API key required; `:free` model ids change, check the current list):

```dotenv
CHAT_BASE_URL=https://openrouter.ai/api/v1
CHAT_API_KEY=sk-or-...
CHAT_MODEL=meta-llama/llama-3.3-70b-instruct:free
```

```bash
npm run llm:check                 # one tiny completion; prints endpoint/model/key state
npm run llm:check -- --json       # machine-readable
npm run ask -- "What encryption is used for data at rest?"
```

`LLM_ENABLED=auto` (default) turns chat on when a key is present **or** when `CHAT_BASE_URL` / `OPENAI_BASE_URL` is non-OpenAI; `true`/`false` force it. Keyless endpoints such as Ollama work without `CHAT_API_KEY`. Document embeddings stay local unless you explicitly configure an embedding endpoint, so a local chat model keeps everything on your machine.

The smoke test spawns the real server over stdio, calls every tool and resource, and asserts on the retrieved content:

```bash
npm run build
npm run smoke
```

## Connect an MCP client

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "pdf-rag": {
      "command": "node",
      "args": ["C:/absolute/path/to/pdf-rag-mcp/dist/index.js"],
      "env": {
        "PDF_DIR": "C:/absolute/path/to/pdf-rag-mcp/pdfs"
      }
    }
  }
}
```

Restart Claude Desktop, then ask: *"What encryption is used for data at rest?"* The model will call `ask_documents` and answer with `orion-security-whitepaper.pdf, page 1`.

### Claude Code

```bash
claude mcp add pdf-rag -- node "C:/absolute/path/to/pdf-rag-mcp/dist/index.js"
```

### Cursor / VS Code / other clients

Add the same command/args pair to the client's MCP config (`.cursor/mcp.json`, `.vscode/mcp.json`, `mcp.json`, …). On macOS/Linux use the `node` binary from `which node`; on Windows use the full `node.exe` path if the client does not inherit `PATH`.

### Streamable HTTP instead of stdio

```bash
npm run serve:http         # http://127.0.0.1:8787/mcp  (health: /health)
```

It is a **stateless** single-user endpoint. Keep it bound to `127.0.0.1`; add authentication and per-session transports before exposing it publicly.

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `ask_documents` | `question`, `top_k?`, `document?` | RAG: retrieve the best passages and write a cited answer (falls back to the passages when no chat model is enabled). |
| `search_documents` | `query`, `top_k?`, `document?`, `min_score?` | Raw hybrid search: returns passages with file, page, vector score and BM25 score. |
| `list_documents` | – | Indexed PDFs with ids, page/chunk counts and pages that had no text layer. |
| `read_document_page` | `document`, `page` | Full extracted text of one page, for follow-up reading. |
| `reindex_documents` | `force?` | Re-scan the PDF folder after adding/changing files. Unchanged files are reused. |

Every tool also returns `structuredContent` (JSON) for programmatic clients, so an agent can filter results without parsing prose.

**Resources:** `pdf://library` (overview) and `pdf://doc/{docId}` (full extracted text of a document) for clients that browse resources.
**Prompt:** `ask_pdf_library` — a ready-made workflow that instructs the model to search, read the cited pages, and cite `<file>, page <n>`.

## How retrieval works

1. **Extraction** — `unpdf` (PDF.js) pulls text per page. Page numbers are kept for citations.
2. **Chunking** — each page is split on paragraph/sentence boundaries into ~1000-character chunks with 150 characters of overlap. Chunks never span pages.
3. **Embedding** — each chunk is embedded (title included) and L2-normalised.
4. **Hybrid search** — cosine similarity is blended with BM25 keyword scoring (`HYBRID_ALPHA`, default 50/50). Each signal is normalised by its own maximum, so a pure-semantic hit and a pure-keyword hit both rank well.
5. **Answering** — the top passages are packed into a citation-numbered context window. With a configured chat model the model writes a grounded answer with `[n]` citations; without one you get the passages plus an explanation of what to configure.

### Embeddings

| `EMBEDDING_PROVIDER` | Used when | Notes |
| --- | --- | --- |
| `auto` (default) | Key or explicit `EMBEDDING_BASE_URL` → OpenAI-compatible, otherwise local | Good default: a chat-only key does not force remote embeddings unless it is in `OPENAI_API_KEY`. |
| `local` / `local-hash` | Always | Signed feature hashing over word unigrams/bigrams into 512 dims. No network, no key, deterministic. Works surprisingly well on small corpora, weakest on paraphrases. |
| `openai` | Always | `text-embedding-3-small` by default. Best recall; needs a key **or** a keyless custom endpoint via `EMBEDDING_BASE_URL`. |

A keyless local embedder example:

```dotenv
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
EMBEDDING_MODEL=nomic-embed-text
```

The index records which embedder built it. If you later add `OPENAI_API_KEY`, the server keeps using the existing index's embedding space and tells you to re-run ingestion — just `npm run ingest` to rebuild with the better model. Rebuild after changing `EMBEDDING_MODEL` or `EMBEDDING_BASE_URL` too.

## Configuration

Copy `.env.example` to `.env` (loaded automatically; real environment variables win).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PDF_DIR` | `./pdfs` | Folder scanned recursively for `*.pdf`. |
| `INDEX_PATH` | `./data/index.json` | Where chunks + vectors are stored. |
| `EMBEDDING_PROVIDER` | `auto` | `auto` / `local` / `local-hash` / `openai`. |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Used when building the index. |
| `EMBEDDING_BASE_URL` | `OPENAI_BASE_URL` or OpenAI | Keyless OpenAI-compatible embeddings endpoint (e.g. Ollama). |
| `EMBEDDING_API_KEY` | `OPENAI_API_KEY` | Optional key for embeddings only. |
| `LLM_ENABLED` | `auto` | `auto`, `true` or `false`; forces chat synthesis on/off. |
| `CHAT_BASE_URL` | `OPENAI_BASE_URL` or OpenAI | Chat endpoint; free/local endpoints need no key. |
| `CHAT_API_KEY` | `OPENAI_API_KEY` | Key for the chat endpoint, if required. |
| `OPENAI_API_KEY` | – | Legacy shorthand for both embeddings and chat. |
| `OPENAI_BASE_URL` | OpenAI | Legacy shorthand for both endpoints unless `*_BASE_URL` overrides it. |
| `CHAT_MODEL` | `gpt-4o-mini` | Model used by `ask_documents` (set to `llama3.2`, etc. for local models). |
| `CHAT_TEMPERATURE` / `CHAT_MAX_TOKENS` | `0.1` / `800` | Answer style/length. |
| `TOP_K` | `6` | Default number of passages. |
| `HYBRID_ALPHA` | `0.5` | 0 = keyword only, 1 = vector only. |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1000` / `150` | Characters per chunk / overlap. Changing these rebuilds the index. |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | HTTP bind address. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. Logs go to stderr only. |

## Operational notes

- **Incremental ingestion.** Documents are keyed by SHA-1, so `npm run ingest` (or `reindex_documents`) only re-embeds new/changed files. `--force` re-embeds everything. If `CHUNK_SIZE`, `CHUNK_OVERLAP` or the extraction pipeline changes, the whole index is rebuilt automatically.
- **Scanned PDFs have no text layer.** Those pages are listed by `list_documents` as “without text”. Run OCR first (e.g. `ocrmypdf in.pdf out.pdf`) and re-ingest.
- **The index is a JSON file** loaded into memory. It is ideal for hundreds to a few thousand pages. Beyond that, store the vectors in a real vector DB (pgvector, Qdrant, LanceDB) — `src/store/store.ts` is the single place that would change.
- **Privacy.** With the local embedder and a local chat endpoint (e.g. Ollama + `CHAT_BASE_URL=http://127.0.0.1:11434/v1`), no document text leaves the machine. Hosted free tiers still receive the retrieved excerpts.
- **`stdio` safety.** All diagnostics are written to stderr, and `console.log` is redirected, so JSON-RPC traffic on stdout stays clean.

## Project layout

```
src/
  index.ts              entry point: stdio or Streamable HTTP
  config.ts             env/.env configuration
  rag.ts                engine: index + embedder + retrieve/answer
  mcp/server.ts         tools, resources, prompt
  ingest/pdf.ts         PDF -> page text (unpdf)
  ingest/chunker.ts     page-aware text chunking
  ingest/indexer.ts     scan -> embed -> data/index.json (incremental)
  embedding/localHash.ts offline embedder
  embedding/openai.ts   OpenAI-compatible embedder
  store/store.ts        in-memory index + hybrid BM25/vector search
  llm/answer.ts         RAG prompt + extractive fallback
  llm/chat.ts           chat completion client
  cli/ingest.ts         `npm run ingest`
  cli/ask.ts            `npm run ask` / `npm run search` (terminal Q&A)
  cli/check-llm.ts      `npm run llm:check` (chat connection check)
scripts/
  make-sample-pdf.mjs   demo PDFs
  mcp-smoke.mjs         end-to-end MCP test
```

## Scripts

| Script | Description |
| --- | --- |
| `npm run ingest` | Build/refresh the index (`-- --force` to re-embed everything). |
| `npm run ask` | Ask a question in the terminal (no argument = interactive prompt). |
| `npm run search` | Show raw matching passages instead of a written answer. |
| `npm run llm:check` | Test the configured chat endpoint with one tiny completion. |
| `npm start` | MCP server over stdio. |
| `npm run serve:http` | MCP server over Streamable HTTP. |
| `npm run dev` | Same as start but via `tsx` (no build step). |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run smoke` | End-to-end test against the built server. |
| `npm run sample` | Generate the two demo PDFs. |
| `npm run typecheck` | Type-check without emitting. |

## Limitations

- Text only: embedded images, charts and form fields are not interpreted.
- PDFs must have a text layer (run OCR otherwise).
- Single-process index; no concurrent writers. Ingestion is a separate step by design.
- `ask_documents` quality with the local embedder is good for keyword-ish questions and weaker for heavy paraphrasing; use a configured embedding endpoint for production corpora. Free hosted chat tiers may impose rate limits.
- The HTTP transport is stateless and unauthenticated — local use only as shipped.
