import type { AppConfig } from "../config.js";
import { chatCompletion, hasChatModel } from "./chat.js";
import type { SearchHit } from "../types.js";
import { formatHits } from "../util/format.js";
import { log } from "../util/log.js";
import { truncate } from "../util/text.js";

export interface AnswerOptions {
  maxContextChars?: number;
}

export interface AnswerResult {
  answer: string;
  mode: "llm" | "extractive";
  /** Passages given to the model (or shown in extractive mode). */
  hits: SearchHit[];
  /** Passages the answer cites; falls back to `hits` when no citations were produced. */
  sources: SearchHit[];
  model?: string;
}

const SYSTEM_PROMPT = `You are a retrieval-augmented document assistant.
Answer the user's question using ONLY the numbered excerpts provided.
Rules:
- Cite the excerpt number in square brackets after each claim, e.g. [2].
- If several excerpts support a point, cite them all, e.g. [1][3].
- If the excerpts do not contain the answer, say "I couldn't find that in the indexed PDFs." and suggest a more specific search.
- Never use outside knowledge and never invent page numbers, figures or names.
- Be concise: a short paragraph or a few bullet points.`;

/** Number only the excerpts that actually fit in the context budget. */
function buildContext(hits: SearchHit[], maxChars: number): { context: string; used: SearchHit[] } {
  const blocks: string[] = [];
  const used: SearchHit[] = [];
  let budget = maxChars;

  for (const hit of hits) {
    const header = `[${used.length + 1}] ${hit.docPath} — page ${hit.page}`;
    const bodyBudget = Math.min(hit.text.length, Math.max(400, budget - header.length - 8));
    if (bodyBudget < 200 || budget <= header.length + 200) break;

    const body = truncate(hit.text, bodyBudget);
    blocks.push(`${header}\n${body}`);
    used.push(hit);
    budget -= header.length + body.length + 6;
  }

  return { context: blocks.join("\n\n---\n\n"), used };
}

/** Keep the extractive fallback readable: a few strong passages, not the whole tail. */
function mostRelevant(hits: SearchHit[], limit = 3): SearchHit[] {
  const strong = hits.filter((hit) => hit.score >= 0.08);
  return (strong.length > 0 ? strong : hits.slice(0, 1)).slice(0, limit);
}

/** Map the [n] markers in an answer back to the passages that were sent. */
function citedHits(answer: string, used: SearchHit[]): SearchHit[] {
  const indices = new Set<number>();
  for (const match of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const index = Number(match[1]);
    if (index >= 1 && index <= used.length) indices.add(index);
  }
  const cited = [...indices].sort((a, b) => a - b).map((index) => used[index - 1]!);
  return cited.length > 0 ? cited : used;
}

export async function answerQuestion(
  question: string,
  hits: SearchHit[],
  config: AppConfig,
  options: AnswerOptions = {},
): Promise<AnswerResult> {
  if (hits.length === 0) {
    return {
      answer:
        `I couldn't find anything relevant to "${question}" in the indexed PDFs.\n\n` +
        `Try rephrasing with terms that appear in the documents, or run list_documents to see what is available.`,
      mode: "extractive",
      hits,
      sources: [],
    };
  }

  const { context, used } = buildContext(hits, options.maxContextChars ?? 6000);

  if (!hasChatModel(config.chat)) {
    return {
      answer:
        `No LLM is configured, so here are the best-matching passages for "${question}":\n\n` +
        `${formatHits(mostRelevant(hits), { maxChars: 700 })}\n\n` +
        `To get a written, cited answer, set CHAT_API_KEY (or OPENAI_API_KEY), or point CHAT_BASE_URL at a ` +
        `local OpenAI-compatible server such as Ollama and set CHAT_MODEL. Run npm run llm:check to verify.`,
      mode: "extractive",
      hits,
      sources: mostRelevant(hits),
    };
  }

  try {
    const answer = await chatCompletion(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Question: ${question}\n\nExcerpts:\n\n${context}`,
        },
      ],
      {
        apiKey: config.chat.apiKey,
        baseUrl: config.chat.baseUrl,
        model: config.chat.model,
        temperature: config.chat.temperature,
        maxTokens: config.chat.maxTokens,
      },
    );

    return { answer, mode: "llm", hits: used, sources: citedHits(answer, used), model: config.chat.model };
  } catch (error) {
    log.warn(`Answer synthesis failed, falling back to excerpts: ${(error as Error).message}`);
    return {
      answer:
        `The language model call failed (${(error as Error).message}).\n\n` +
        `Best-matching passages for "${question}":\n\n${formatHits(mostRelevant(used), { maxChars: 700 })}`,
      mode: "extractive",
      hits: used,
      sources: mostRelevant(used),
    };
  }
}
