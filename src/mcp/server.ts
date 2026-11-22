import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RagEngine } from "../rag.js";
import { formatBytes, formatHits, formatSources } from "../util/format.js";
import { log } from "../util/log.js";

const SERVER_NAME = "pdf-rag-mcp";
const SERVER_VERSION = "1.0.0";

const searchResultSchema = z.object({
  chunk_id: z.string(),
  document: z.string(),
  page: z.number(),
  score: z.number(),
  vector_score: z.number(),
  lexical_score: z.number(),
  text: z.string(),
});

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log.warn(`Tool call failed: ${message}`);
  return { isError: true as const, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

/**
 * Build the MCP server around an already-warmed RAG engine.
 * Tools are the primary interface (LLM-friendly); resources expose whole docs.
 */
export function buildMcpServer(engine: RagEngine): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "This server searches a private library of PDF documents using hybrid retrieval (BM25 + embeddings). " +
        "Call ask_documents when the user asks a question and wants a synthesized, cited answer. " +
        "Call search_documents to inspect raw passages or to debug retrieval. " +
        "Call list_documents to see what is indexed, and read_document_page to read a full page. " +
        "Always cite documents as <file>, page <n> in your reply to the user.",
    },
  );

  server.registerTool(
    "search_documents",
    {
      title: "Search PDF library",
      description:
        "Search the indexed PDFs and return the most relevant passages with file name, page number and relevance score. " +
        "Use this for factual lookups or when you need the exact wording from a document. " +
        "Combine several focused queries if one search is not enough.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language search query, e.g. 'data encryption at rest'."),
        top_k: z.number().int().min(1).max(20).optional().describe("Number of passages to return (default 6)."),
        document: z
          .string()
          .optional()
          .describe("Optional file name, path or document id to restrict the search to one PDF."),
        min_score: z.number().min(0).max(1).optional().describe("Drop passages scoring below this value (0..1)."),
      },
      outputSchema: {
        query: z.string(),
        count: z.number(),
        embedding: z.string(),
        results: z.array(searchResultSchema),
      },
      annotations: { title: "Search PDF library", readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, top_k, document, min_score }) => {
      try {
        const hits = await engine.search(query, {
          topK: top_k,
          document,
          minScore: min_score,
        });

        const header =
          hits.length === 0
            ? `No passages matched "${query}".`
            : `Found ${hits.length} passage(s) for "${query}" (hybrid search: ${engine.stats.embedder}):`;

        return {
          content: [{ type: "text", text: `${header}\n\n${formatHits(hits)}` }],
          structuredContent: {
            query,
            count: hits.length,
            embedding: engine.stats.embedder,
            results: hits.map((hit) => ({
              chunk_id: hit.chunkId,
              document: hit.docPath,
              page: hit.page,
              score: hit.score,
              vector_score: hit.vectorScore,
              lexical_score: hit.lexicalScore,
              text: hit.text,
            })),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "ask_documents",
    {
      title: "Ask the PDF library",
      description:
        "Answer a question using the indexed PDFs (RAG). Retrieves the best passages and, when an LLM is configured, " +
        "writes a concise answer with bracketed citations. Prefer this tool when the user asks 'what/why/how' questions.",
      inputSchema: {
        question: z.string().min(1).describe("The user's question in natural language."),
        top_k: z.number().int().min(1).max(20).optional().describe("Passages to retrieve as context (default 6)."),
        document: z
          .string()
          .optional()
          .describe("Optional file name, path or document id to answer from a single PDF."),
      },
      outputSchema: {
        answer: z.string(),
        mode: z.enum(["llm", "extractive"]),
        model: z.string().optional(),
        sources: z.array(
          z.object({
            document: z.string(),
            page: z.number(),
            chunk_id: z.string(),
            score: z.number(),
          }),
        ),
      },
      annotations: { title: "Ask the PDF library", readOnlyHint: true, openWorldHint: false },
    },
    async ({ question, top_k, document }) => {
      try {
        const result = await engine.ask(question, { topK: top_k, document });
        const sources = result.sources.map((hit) => ({
          document: hit.docPath,
          page: hit.page,
          chunk_id: hit.chunkId,
          score: hit.score,
        }));

        const text =
          result.mode === "extractive"
            ? result.answer
            : `${result.answer}\n\nSources:\n${formatSources(result.sources)}`;

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            answer: result.answer,
            mode: result.mode,
            ...(result.model ? { model: result.model } : {}),
            sources,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_documents",
    {
      title: "List indexed PDFs",
      description:
        "List every PDF currently in the search index with page/chunk counts and document ids. " +
        "Use this before filtering a search with the `document` parameter.",
      inputSchema: {},
      outputSchema: {
        documents: z.array(
          z.object({
            id: z.string(),
            path: z.string(),
            title: z.string(),
            pages: z.number(),
            chunks: z.number(),
            empty_pages: z.array(z.number()),
          }),
        ),
        total_documents: z.number(),
        total_pages: z.number(),
        total_chunks: z.number(),
        embedding: z.string(),
      },
      annotations: { title: "List indexed PDFs", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const docs = engine.documents;
        const stats = engine.stats;

        if (docs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `The index is empty. Add PDFs to ${engine.config.pdfDir} and run reindex_documents.`,
              },
            ],
            structuredContent: {
              documents: [],
              total_documents: 0,
              total_pages: 0,
              total_chunks: 0,
              embedding: stats.embedder,
            },
          };
        }

        const lines = docs.map((doc, index) => {
          const empty = doc.emptyPages.length > 0 ? `, ${doc.emptyPages.length} page(s) without text` : "";
          return `${index + 1}. ${doc.path} — ${doc.title}\n   id: ${doc.id} · ${doc.pages} pages · ${doc.chunks} chunks · ${formatBytes(doc.bytes)}${empty}`;
        });

        return {
          content: [
            {
              type: "text",
              text:
                `${stats.documents} document(s), ${stats.pages} page(s), ${stats.chunks} chunk(s) · embeddings: ${stats.embedder}\n\n` +
                lines.join("\n"),
            },
          ],
          structuredContent: {
            documents: docs.map((doc) => ({
              id: doc.id,
              path: doc.path,
              title: doc.title,
              pages: doc.pages,
              chunks: doc.chunks,
              empty_pages: doc.emptyPages,
            })),
            total_documents: stats.documents,
            total_pages: stats.pages,
            total_chunks: stats.chunks,
            embedding: stats.embedder,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "read_document_page",
    {
      title: "Read a PDF page",
      description:
        "Return the full extracted text of one page of an indexed PDF. " +
        "Use search_documents first to find the right page, then this tool if you need more context.",
      inputSchema: {
        document: z.string().min(1).describe("File name, path or document id (see list_documents)."),
        page: z.number().int().min(1).describe("1-based page number."),
      },
      annotations: { title: "Read a PDF page", readOnlyHint: true, openWorldHint: false },
    },
    async ({ document, page }) => {
      try {
        const { doc, candidates } = engine.findDocument(document);
        if (!doc) {
          const hint =
            candidates.length > 1
              ? ` Several documents matched: ${candidates.slice(0, 5).map((c) => c.path).join(", ")}.`
              : " Call list_documents to see the available documents.";
          return {
            isError: true,
            content: [{ type: "text", text: `Unknown document "${document}".${hint}` }],
          };
        }

        if (page > doc.pages) {
          return {
            isError: true,
            content: [{ type: "text", text: `"${doc.path}" only has ${doc.pages} page(s).` }],
          };
        }

        const text = engine.pageText(doc.id, page);
        if (!text || text.trim().length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Page ${page} of ${doc.path} contains no extractable text. ` +
                  `It is probably a scanned image; run OCR (e.g. ocrmypdf) and re-ingest to search it.`,
              },
            ],
          };
        }

        return {
          content: [
            { type: "text", text: `${doc.path} — page ${page} of ${doc.pages}\n\n${text}` },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "reindex_documents",
    {
      title: "Re-index PDFs",
      description:
        "Re-scan the PDF folder, re-embed new or changed files and update the search index. " +
        "Use after adding, removing or editing PDFs. Unchanged files are reused when possible.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe("Set to true to re-embed every document even if the file has not changed."),
      },
      outputSchema: {
        documents: z.number(),
        pages: z.number(),
        chunks: z.number(),
        reused_documents: z.number(),
        empty_pages: z.number(),
        failed_files: z.number(),
        duration_ms: z.number(),
        embedding: z.string(),
      },
      annotations: { title: "Re-index PDFs", readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ force }) => {
      try {
        const { stats } = await engine.reindex({ incremental: force !== true });
        server.sendResourceListChanged();

        return {
          content: [
            {
              type: "text",
              text:
                `Re-indexed ${stats.documents} document(s): ${stats.pages} page(s), ${stats.chunks} chunk(s) ` +
                `(${stats.reusedDocuments} reused) in ${(stats.durationMs / 1000).toFixed(1)}s. ` +
                `Embeddings: ${engine.stats.embedder}.` +
                (stats.emptyPages > 0
                  ? ` ${stats.emptyPages} page(s) had no text layer — OCR may be needed.`
                  : "") +
                (stats.failedFiles > 0 ? ` ${stats.failedFiles} file(s) could not be read.` : ""),
            },
          ],
          structuredContent: {
            documents: stats.documents,
            pages: stats.pages,
            chunks: stats.chunks,
            reused_documents: stats.reusedDocuments,
            empty_pages: stats.emptyPages,
            failed_files: stats.failedFiles,
            duration_ms: stats.durationMs,
            embedding: engine.stats.embedder,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // ---- Resources: whole documents, addressable as pdf://doc/{docId} ----------
  server.registerResource(
    "indexed-pdf",
    new ResourceTemplate("pdf://doc/{docId}", {
      list: async () => ({
        resources: engine.documents.map((doc) => ({
          uri: `pdf://doc/${doc.id}`,
          name: doc.title,
          description: `${doc.path} — ${doc.pages} page(s), ${doc.chunks} chunk(s)`,
          mimeType: "text/plain",
        })),
      }),
      complete: {
        docId: (value) =>
          engine.documents
            .filter((doc) => doc.id.startsWith(value) || doc.path.toLowerCase().includes(value.toLowerCase()))
            .map((doc) => doc.id)
            .slice(0, 20),
      },
    }),
    {
      title: "Indexed PDF documents",
      description: "Full extracted text of a PDF in the library.",
      mimeType: "text/plain",
    },
    async (uri, variables) => {
      const raw = variables.docId;
      const docId = Array.isArray(raw) ? raw[0] : raw;
      const doc = engine.documents.find((candidate) => candidate.id === docId);
      if (!doc) throw new Error(`Unknown document id "${docId ?? ""}".`);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: engine.documentText(doc.id),
          },
        ],
      };
    },
  );

  server.registerResource(
    "pdf-library",
    "pdf://library",
    {
      title: "PDF library overview",
      description: "Summary of all indexed PDFs, page counts and the embedding model in use.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const stats = engine.stats;
      const lines = engine.documents.map(
        (doc) => `- ${doc.path} (${doc.title}) — ${doc.pages} pages, ${doc.chunks} chunks, id=${doc.id}`,
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text:
              `# PDF library\n\n` +
              `${stats.documents} document(s) · ${stats.pages} page(s) · ${stats.chunks} chunk(s)\n` +
              `Embeddings: ${stats.embedder}\n\n` +
              (lines.length > 0 ? lines.join("\n") : "No documents indexed yet."),
          },
        ],
      };
    },
  );

  // ---- Prompt: a ready-made RAG workflow ------------------------------------
  server.registerPrompt(
    "ask_pdf_library",
    {
      title: "Ask the PDF library",
      description: "Ask a question that must be answered from the indexed PDFs, with citations.",
      argsSchema: {
        question: z.string().describe("Question to answer from the PDFs."),
      },
    },
    ({ question }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Answer this question using only the indexed PDF files: "${question}"\n\n` +
              `Steps: call ask_documents with a concise query. If the answer needs more detail, call ` +
              `search_documents or read_document_page for the cited pages. Cite each claim as \`<file>, page <n>\`. ` +
              `If nothing relevant is found, say so instead of guessing.`,
          },
        },
      ],
    }),
  );

  log.debug(
    `MCP server ready: ${engine.stats.documents} doc(s), ${engine.stats.chunks} chunk(s), embeddings ${engine.stats.embedder}`,
  );
  return server;
}
