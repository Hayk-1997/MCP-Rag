import { config } from "../config.js";
import { buildIndex } from "../ingest/indexer.js";
import { formatBytes } from "../util/format.js";
import { log } from "../util/log.js";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  log.info(`PDF directory: ${config.pdfDir}`);
  log.info(`Index target:  ${config.indexPath}`);

  try {
    const { index, stats } = await buildIndex(config, {
      incremental: !force,
      onProgress: (message) => log.debug(message),
    });

    const lines = index.docs.map(
      (doc) =>
        `  • ${doc.path} — ${doc.pages} pages, ${doc.chunks} chunks, ${formatBytes(doc.bytes)}` +
        (doc.emptyPages.length > 0 ? ` (${doc.emptyPages.length} page(s) without text)` : ""),
    );

    process.stdout.write(
      `\nIndex ready.\n\n` +
        `Documents: ${stats.documents} (${stats.reusedDocuments} reused)\n` +
        `Pages:     ${stats.pages}\n` +
        `Chunks:    ${stats.chunks}\n` +
        `Embedding: ${index.embedding.provider}/${index.embedding.model} (dim ${index.embedding.dim})\n` +
        `Time:      ${(stats.durationMs / 1000).toFixed(1)}s\n` +
        `Index file: ${config.indexPath}\n\n` +
        (lines.length > 0 ? `${lines.join("\n")}\n\n` : "") +
        `Next: start the MCP server with \`npm start\` (stdio) or \`npm run serve:http\`.\n`,
    );

    if (stats.emptyPages > 0) {
      log.warn(
        `${stats.emptyPages} page(s) have no text layer. Scanned pages need OCR (e.g. \`ocrmypdf in.pdf out.pdf\`) before they can be searched.`,
      );
    }
  } catch (error) {
    log.error(`Ingestion failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

void main();
