import { contentTerms, tokenize } from "../util/text.js";

/**
 * Offline, dependency-free embedder.
 *
 * Uses signed feature hashing over word unigrams + bigrams. It is not a neural
 * embedding, but it gives useful semantic-ish recall for small corpora and
 * guarantees the server works with zero API keys or network access.
 * Deterministic across processes, so indexes remain valid across restarts.
 */
export class LocalHashEmbedder {
  readonly provider = "local-hash" as const;
  readonly model = "hashed-tf-512";
  readonly dim = 512;

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embed(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  private embed(text: string): number[] {
    const vector = new Float64Array(this.dim);
    const terms = contentTerms(text);
    const fallback = terms.length > 0 ? terms : tokenize(text);

    for (const term of fallback) {
      addFeature(vector, term, 1);
    }
    // Word bigrams add a bit of phrase sensitivity.
    for (let i = 0; i + 1 < fallback.length; i++) {
      addFeature(vector, `${fallback[i]}\u0000${fallback[i + 1]}`, 0.45);
    }

    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    const out = new Array<number>(this.dim);
    for (let i = 0; i < this.dim; i++) out[i] = (vector[i] ?? 0) / norm;
    return out;
  }
}

function addFeature(vector: Float64Array, feature: string, weight: number): void {
  const hash = fnv1a(feature);
  const index = hash % vector.length;
  const sign = (hash & 0x80000000) !== 0 ? -1 : 1;
  vector[index] = (vector[index] ?? 0) + sign * weight;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
