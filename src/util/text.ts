const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Very light stemmer: enough to make "deployments" match "deployment" while
 * staying deterministic and dependency-free.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

/** Raw lowercase tokens (numbers and single letters kept). */
export function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  const out: string[] = [];
  for (const piece of normalized.split(/[^a-z0-9]+/)) {
    if (!piece) continue;
    if (piece.length > 1 || /[0-9]/.test(piece)) out.push(stem(piece));
  }
  return out;
}

/** Tokens with stopwords removed — used for lexical (BM25) ranking. */
export function contentTerms(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
}

/** Collapse whitespace and repair PDF line-break artefacts. */
export function normalizeWhitespace(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u00ad/g, "") // soft hyphen
    .replace(/([a-z])-\n(?=[a-z])/g, "$1-") // keep compounds whole ("Role-based") and split tokens stay searchable
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Turn a file name into a human-readable title. */
export function titleFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const withoutExt = base.replace(/\.pdf$/i, "");
  return withoutExt
    .replace(/[_-]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
