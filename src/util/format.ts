import { truncate } from "../util/text.js";
import type { SearchHit } from "../types.js";

export function formatHit(hit: SearchHit, index: number, options: { maxChars?: number; scores?: boolean } = {}): string {
  const scores = options.scores === false ? "" : ` (score ${hit.score.toFixed(3)})`;
  const header = `[${index}] ${hit.docPath} — page ${hit.page}${scores}`;
  return `${header}\n${truncate(hit.text, options.maxChars ?? 700)}`;
}

export function formatHits(hits: SearchHit[], options: { maxChars?: number; scores?: boolean } = {}): string {
  if (hits.length === 0) return "No matching passages found.";
  return hits.map((hit, index) => formatHit(hit, index + 1, options)).join("\n\n");
}

export function formatSources(hits: SearchHit[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const hit of hits) {
    const key = `${hit.docId}:${hit.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${hit.docPath}, page ${hit.page}`);
  }
  return lines.join("\n");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
