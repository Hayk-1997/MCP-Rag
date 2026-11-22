import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config } from "../config.js";
import { RagEngine } from "../rag.js";
import { formatHits, formatSources } from "../util/format.js";
import { log } from "../util/log.js";

interface CliOptions {
  question: string;
  topK?: number;
  document?: string;
  json: boolean;
  raw: boolean;
  help: boolean;
}

const USAGE = `Ask questions about the indexed PDFs (same RAG engine as the MCP server).

Usage:
  npm run ask                                  interactive prompt
  npm run ask -- "What encryption is used?"    single question
  npm run ask -- --top-k 3 "question"          limit retrieved passages
  npm run ask -- --document guide.pdf "question"   search one PDF only
  npm run ask -- --json "question"             machine-readable output
  npm run search -- "Kubernetes version"       raw passages (no LLM answer)
  npm run llm:check                            verify the configured chat model

Options:
  -k, --top-k N      Number of passages to retrieve (default ${config.topK})
  -d, --document X   File name, path or document id to restrict the search
      --json         Output JSON instead of prose
  -h, --help         Show this help

In interactive mode type 'q', 'exit' or Ctrl+C to quit.
Without a configured chat model the answer is the best-matching passages instead
of written text. Run \`npm run llm:check\` to test Ollama/LM Studio/Groq/OpenRouter,
or \`npm run ingest\` after adding PDFs.`;

function parseArgs(args: string[]): CliOptions {
  // `npm run search -- ...` prepends --search as a script argument.
  const fromScript = args[0] === "--search";
  const rest = fromScript ? args.slice(1) : args;
  const options: CliOptions = { question: "", json: false, raw: fromScript, help: false };
  const words: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    const nextValue = (): string => {
      const value = rest[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--search" || arg === "--raw") options.raw = true;
    else if (arg === "--top-k" || arg === "-k") {
      options.topK = Number(nextValue());
    } else if (arg.startsWith("--top-k=")) {
      options.topK = Number(arg.slice("--top-k=".length));
    } else if (arg === "--document" || arg === "-d") {
      options.document = nextValue();
    } else if (arg.startsWith("--document=")) {
      options.document = arg.slice("--document=".length);
    } else if (arg === "--") {
      continue;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      words.push(arg);
    }
  }

  if (options.topK !== undefined && (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > 20)) {
    throw new Error("--top-k must be an integer between 1 and 20.");
  }

  options.question = words.join(" ").trim();
  return options;
}

async function runQuestion(engine: RagEngine, question: string, options: CliOptions): Promise<void> {
  if (options.raw) {
    const hits = await engine.search(question, { topK: options.topK, document: options.document });
    if (options.json) {
      stdout.write(`${JSON.stringify({ query: question, count: hits.length, results: hits }, null, 2)}\n`);
    } else {
      stdout.write(
        `Found ${hits.length} passage(s) for "${question}":\n\n` +
          `${formatHits(hits)}\n\nSources:\n${formatSources(hits)}\n`,
      );
    }
    return;
  }

  const result = await engine.ask(question, { topK: options.topK, document: options.document });

  if (options.json) {
    stdout.write(
      `${JSON.stringify(
        {
          answer: result.answer,
          mode: result.mode,
          model: result.model ?? null,
          sources: result.sources.map((hit) => ({
            document: hit.docPath,
            page: hit.page,
            chunk_id: hit.chunkId,
            score: hit.score,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const sources =
    result.mode === "llm" && result.sources.length > 0
      ? `\n\nSources:\n${formatSources(result.sources)}`
      : "";
  stdout.write(`${result.answer}${sources}\n`);
}

async function interactive(engine: RagEngine, options: CliOptions): Promise<void> {
  stdout.write("Ask questions about your PDFs. Type 'q' or 'exit' to quit.\n\n");
  const rl = createInterface({ input: stdin, output: stdout });
  let stopped = false;
  rl.on("SIGINT", () => {
    stopped = true;
    rl.close();
  });

  try {
    while (!stopped) {
      let line: string | undefined;
      try {
        line = await rl.question("ask> ");
      } catch {
        break; // stdin closed or Ctrl+C
      }
      if (line === undefined || stopped) break;

      const question = line.trim();
      if (!question) continue;
      if (/^(q|quit|exit)$/i.test(question)) break;

      try {
        await runQuestion(engine, question, options);
      } catch (error) {
        log.error((error as Error).message);
      }
      stdout.write("\n");
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }

  const engine = await RagEngine.create(config);

  if (options.question) {
    await runQuestion(engine, options.question, options);
  } else {
    await interactive(engine, options);
  }
}

main().catch((error) => {
  log.error((error as Error).message);
  process.exitCode = 1;
});
