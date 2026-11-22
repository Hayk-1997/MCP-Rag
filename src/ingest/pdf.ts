import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { log } from "../util/log.js";
import { normalizeWhitespace, titleFromPath } from "../util/text.js";

export interface LoadedPdf {
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to PDF_DIR, always with forward slashes. */
  relPath: string;
  title: string;
  pages: string[];
  bytes: number;
  sha1: string;
}

/** Recursively find every .pdf under `dir`, skipping hidden folders. */
export async function listPdfFiles(dir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
        found.push(full);
      }
    }
  }

  await walk(dir);
  return found.sort((a, b) => a.localeCompare(b));
}

export async function loadPdf(absPath: string, pdfDir: string): Promise<LoadedPdf> {
  const buffer = await readFile(absPath);
  const fileStat = await stat(absPath);
  const relPath = path.relative(pdfDir, absPath).split(path.sep).join("/");

  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const extracted = await extractText(pdf, { mergePages: false });
  const pages = extracted.text.map((page) => normalizeWhitespace(page));

  let metaTitle: string | undefined;
  try {
    const metadata = await pdf.getMetadata();
    const info = metadata.info as Record<string, unknown> | undefined;
    const rawTitle = info?.Title;
    if (typeof rawTitle === "string" && rawTitle.trim().length > 2 && !/^untitled$/i.test(rawTitle.trim())) {
      metaTitle = rawTitle.trim();
    }
  } catch {
    // Metadata is optional.
  }

  await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);

  return {
    absPath,
    relPath,
    title: metaTitle ?? titleFromPath(relPath),
    pages,
    bytes: fileStat.size,
    sha1: createHash("sha1").update(buffer).digest("hex"),
  };
}

/** Load many PDFs, isolating failures so one bad file cannot abort ingestion. */
export async function loadAllPdfs(
  pdfDir: string,
  onError?: (file: string, error: Error) => void,
): Promise<LoadedPdf[]> {
  const files = await listPdfFiles(pdfDir);
  const docs: LoadedPdf[] = [];

  for (const file of files) {
    try {
      docs.push(await loadPdf(file, pdfDir));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.warn(`Could not read PDF ${path.relative(pdfDir, file)}: ${err.message}`);
      onError?.(file, err);
    }
  }

  return docs;
}
