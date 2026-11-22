import { stdout, stderr } from "node:process";
import { config } from "../config.js";
import { chatCompletion, hasChatModel } from "../llm/chat.js";

const USAGE = `Check the configured OpenAI-compatible chat model.

Usage:
  npm run llm:check
  npm run llm:check -- --json

Configuration:
  CHAT_BASE_URL   endpoint (e.g. http://127.0.0.1:11434/v1 for Ollama)
  CHAT_API_KEY    API key, if the endpoint needs one
  CHAT_MODEL      model name (e.g. llama3.2)
  LLM_ENABLED     auto (default), true or false
`;

const DISABLED_HINT =
  "No chat model is enabled. Set CHAT_API_KEY (or OPENAI_API_KEY), point CHAT_BASE_URL at an " +
  "OpenAI-compatible endpoint such as http://127.0.0.1:11434/v1, or set LLM_ENABLED=true to force one.";

function report(payload: Record<string, unknown>, ok: boolean): void {
  const json = process.argv.includes("--json");
  const text = json ? `${JSON.stringify(payload, null, 2)}\n` : `${String(payload.message)}\n`;
  if (ok) stdout.write(text);
  else stderr.write(text);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    stdout.write(USAGE);
    return;
  }

  const { chat } = config;
  const keyState =
    chat.apiKey === undefined ? "none" : chat.apiKey === "not-needed" ? "not-needed (keyless)" : "set";

  if (!hasChatModel(chat)) {
    report({ ok: false, enabled: false, error: DISABLED_HINT, message: DISABLED_HINT }, false);
    process.exitCode = 1;
    return;
  }

  try {
    const reply = await chatCompletion([{ role: "user", content: "Reply with exactly OK." }], {
      apiKey: chat.apiKey,
      baseUrl: chat.baseUrl,
      model: chat.model,
      temperature: 0,
      maxTokens: 16,
      timeoutMs: 20_000,
    });

    const message = `LLM OK — ${chat.model} at ${chat.baseUrl} (key: ${keyState}). Reply: ${reply.slice(0, 120)}`;
    report(
      {
        ok: true,
        enabled: true,
        base_url: chat.baseUrl,
        model: chat.model,
        key: keyState,
        reply,
        message,
      },
      true,
    );
  } catch (error) {
    const detail = (error as Error).message;
    const message = `LLM check failed for ${chat.model} at ${chat.baseUrl}: ${detail}`;
    report(
      {
        ok: false,
        enabled: true,
        base_url: chat.baseUrl,
        model: chat.model,
        key: keyState,
        error: detail,
        message,
      },
      false,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  report({ ok: false, error: (error as Error).message, message: (error as Error).message }, false);
  process.exitCode = 1;
});
