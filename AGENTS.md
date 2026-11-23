# AGENTS.md

## Verification / commands

- Use npm (`package-lock.json`). No CI, lint, formatter, or unit-test framework is configured.
- Verify with `npm run typecheck`, then `npm run build`, then `npm run smoke`; smoke spawns `dist/index.js`, so build must be current.
- `npm run smoke` deletes `data/smoke-index.json`, sets `EMBEDDING_PROVIDER=local`, `LLM_ENABLED=false`, and removes chat keys. It tolerates extra PDFs but requires `pdfs/orion-platform-guide.pdf` and `pdfs/orion-security-whitepaper.pdf` with assertions on AES-256-GCM, Enterprise 1,899, OR-5031, and page 4 Enterprise/99.95. Don't rename or alter those demo PDFs.
- `npm run llm:check` is the chat connection test (`--json` supported). Config is read once at process start; restart MCP clients after env edits.

## Env / runtime quirks

- `src/config.ts` loads `.env` via `process.loadEnvFile` (Node >= 20.12; malformed `.env` is ignored) and real env vars win. `.env` is ignored and user-owned — don't overwrite it from `.env.example`.
- Base URL precedence: `CHAT_BASE_URL ?? OPENAI_BASE_URL ?? https://api.openai.com/v1`; key precedence: `CHAT_API_KEY ?? OPENAI_API_KEY`. Embeddings use `EMBEDDING_BASE_URL ?? OPENAI_BASE_URL ?? ...` and `EMBEDDING_API_KEY ?? OPENAI_API_KEY`.
- `CHAT_BASE_URL` is a base only; `src/llm/chat.ts` appends `/chat/completions`. Do not include that path yourself. Keyless endpoints get `Bearer not-needed`.
- `LLM_ENABLED` only controls answer synthesis, not retrieval. Unset means enabled if a chat key or non-OpenAI chat base exists; `true`/`false` force it.
- `EMBEDDING_PROVIDER=local` forces local-hash even with keys. `openai` embeddings require a key or a keyless custom `EMBEDDING_BASE_URL`.
- The index records provider/model/dim; query embeddings must match the stored index. Changing embedding model/base URL or chunking requires `npm run ingest` (`-- --force` to force). Adding a chat key does not re-embed.
- In stdio mode stdout is JSON-RPC: diagnostics go through `src/util/log.ts` to stderr and `src/index.ts` redirects `console.*`. Never write normal logs to stdout in the server path.

## Code wiring

- Entrypoints: `src/index.ts` (MCP stdio/HTTP), `src/cli/ingest.ts`, `src/cli/ask.ts`, `src/cli/check-llm.ts`.
- `RagEngine` (`src/rag.ts`) owns index + embedder; query flow is `DocumentStore.search` (BM25 + cosine via `HYBRID_ALPHA`) -> `answerQuestion` -> optional `chatCompletion`.
- MCP tools live in `src/mcp/server.ts`; every tool returns both prose `content` and `structuredContent`. Preserve both for clients.
- Ingestion: `src/ingest/pdf.ts` scans `PDF_DIR` recursively, skipping hidden dirs; `unpdf` extracts per-page text; chunking preserves page numbers for citations. Scanned PDFs need OCR first.
- ESM/NodeNext: relative imports inside `src` use `.js` extensions even when the source file is `.ts`.

## Docs vs code / generated files

- README says the HTTP transport is "stateless"; `src/index.ts` is actually stateful per session (one McpServer + transport per client, sharing `engine`). Trust the code.
- `dist/` and `data/` are generated/ignored; `pdfs/*.pdf` is ignored. Don't hand-edit the generated index or commit local PDFs/`.env`.
- `npm run search` prepends `--search` to `src/cli/ask.ts`; the CLI strips it as the raw-search sentinel. Keep that quirk when changing CLI arg parsing.
