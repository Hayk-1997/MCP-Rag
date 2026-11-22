// End-to-end test: starts the built MCP server over stdio, calls every tool and
// resource like a real client, and asserts on the answers.
// Run: npm run build && npm run smoke
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverEntry = path.join(root, "dist", "index.js");

const env = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);
env.PDF_DIR = path.join(root, "pdfs");
env.INDEX_PATH = path.join(root, "data", "smoke-index.json");
env.EMBEDDING_PROVIDER = "local";
env.MCP_TRANSPORT = "stdio";
env.LOG_LEVEL = env.LOG_LEVEL ?? "warn";
env.LLM_ENABLED = "false"; // exercise the offline path even if a chat model is configured globally
delete env.OPENAI_API_KEY;
delete env.CHAT_API_KEY;
delete env.CHAT_BASE_URL;

// Start from a clean index so the incremental-reuse assertions are deterministic.
await rm(env.INDEX_PATH, { force: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: root,
  env,
  stderr: "inherit",
});

const client = new Client({ name: "pdf-rag-smoke", version: "1.0.0" }, { capabilities: {} });

function textOf(result) {
  return (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const toolNames = tools.map((tool) => tool.name).sort();
  console.log(`Tools: ${toolNames.join(", ")}\n`);

  await check("lists the expected tools", async () => {
    for (const name of ["ask_documents", "search_documents", "list_documents", "read_document_page", "reindex_documents"]) {
      assert.ok(toolNames.includes(name), `missing tool ${name}`);
    }
  });

  await check("list_documents finds both PDFs", async () => {
    const result = await client.callTool({ name: "list_documents", arguments: {} });
    const text = textOf(result);
    assert.match(text, /orion-platform-guide\.pdf/);
    assert.match(text, /orion-security-whitepaper\.pdf/);
    assert.ok(result.structuredContent?.total_documents >= 2, "expected at least the two demo PDFs");
  });

  await check("search_documents retrieves the encryption passage", async () => {
    const result = await client.callTool({
      name: "search_documents",
      arguments: { query: "What encryption is used for data at rest?", top_k: 4 },
    });
    const text = textOf(result);
    assert.match(text, /AES-256-GCM/i, `unexpected results:\n${text}`);
    const results = result.structuredContent?.results ?? [];
    assert.ok(results.length > 0, "no structured results");
    assert.ok(results[0].page >= 1);
    console.log(`      top hit: ${results[0].document} p.${results[0].page} (${results[0].score})`);
  });

  await check("search_documents honours the document filter", async () => {
    const result = await client.callTool({
      name: "search_documents",
      arguments: { query: "penetration test", document: "orion-security-whitepaper.pdf" },
    });
    const results = result.structuredContent?.results ?? [];
    assert.ok(results.length > 0);
    assert.ok(results.every((hit) => hit.document === "orion-security-whitepaper.pdf"));
  });

  await check("ask_documents answers the pricing question", async () => {
    const result = await client.callTool({
      name: "ask_documents",
      arguments: { question: "How much does the Enterprise plan cost per month?" },
    });
    const text = textOf(result);
    assert.match(text, /1,899|1899/, `unexpected answer:\n${text}`);
    assert.equal(result.structuredContent?.mode, "extractive");
    assert.ok((result.structuredContent?.sources ?? []).length > 0);
  });

  await check("ask_documents finds the troubleshooting error code", async () => {
    const result = await client.callTool({
      name: "ask_documents",
      arguments: { question: "What does error OR-5031 mean?" },
    });
    assert.match(textOf(result), /licence token has expired/i);
  });

  await check("returns no hits for unrelated queries", async () => {
    const result = await client.callTool({
      name: "search_documents",
      arguments: { query: "zzzqqq xylophage quantumflux" },
    });
    assert.equal(result.structuredContent?.count, 0, textOf(result));
  });

  await check("read_document_page returns page text", async () => {
    const result = await client.callTool({
      name: "read_document_page",
      arguments: { document: "orion-platform-guide.pdf", page: 4 },
    });
    const text = textOf(result);
    assert.match(text, /Enterprise plan/);
    assert.match(text, /99\.95/);
  });

  await check("rejects an out-of-range page", async () => {
    const result = await client.callTool({
      name: "read_document_page",
      arguments: { document: "orion-platform-guide.pdf", page: 99 },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /only has 5 page/);
  });

  await check("resources list + read expose the documents", async () => {
    const { resources } = await client.listResources();
    assert.ok(resources.some((resource) => resource.uri === "pdf://library"), "missing pdf://library");
    const docResource = resources.find(
      (resource) => resource.uri.startsWith("pdf://doc/") && resource.uri.includes("orion-security-whitepaper"),
    );
    assert.ok(docResource, "missing per-document resource for the security whitepaper");

    const library = await client.readResource({ uri: "pdf://library" });
    assert.match(library.contents[0].text, /\d+ document\(s\)/);
    assert.match(library.contents[0].text, /orion-platform-guide\.pdf/);

    const doc = await client.readResource({ uri: docResource.uri });
    assert.match(doc.contents[0].text, /AES-256-GCM/);
  });

  await check("prompts are advertised", async () => {
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((prompt) => prompt.name === "ask_pdf_library"));
  });

  await check("reindex_documents reports stats", async () => {
    const result = await client.callTool({ name: "reindex_documents", arguments: {} });
    const stats = result.structuredContent;
    assert.ok(stats?.documents >= 2, "expected at least the two demo PDFs");
    assert.ok(stats.chunks >= 4);
    assert.equal(stats.reused_documents, stats.documents);
  });
} finally {
  await client.close().catch(() => undefined);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
