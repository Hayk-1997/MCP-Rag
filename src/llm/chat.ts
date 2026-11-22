export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatOptions {
  /** Omit for local endpoints that do not need authentication. */
  apiKey?: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export function hasChatModel(chat: { enabled?: boolean; apiKey?: string }): boolean {
  return chat.enabled ?? Boolean(chat.apiKey);
}

/** Minimal OpenAI-compatible chat completion call (works with Ollama, LM Studio, Groq, OpenRouter, Azure, ...). */
export async function chatCompletion(messages: ChatMessage[], options: ChatOptions): Promise<string> {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 800,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Chat completion failed (${response.status} ${response.statusText}): ${body.slice(0, 500)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("Chat completion returned no content.");
  return content.trim();
}
