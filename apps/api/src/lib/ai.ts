// Default LLM client per jal-standards: OpenAI gpt-4o-mini, nothing else,
// with a maxed-out sane configuration. Report any deviation from this
// default model to Brian before use.
//
// The client is constructed lazily on first use, not at import time, so
// importing this module never throws even when OPENAI_API_KEY is unset
// (e.g. under `bun test`). The clear error only fires when a caller
// actually tries to use the AI feature without a key configured.
import OpenAI from "openai";

export const DEFAULT_MODEL = "gpt-4o-mini" as const;

/** Ceiling for one call when the caller names none. */
const DEFAULT_TIMEOUT_MS = 30_000;

let client: OpenAI | undefined;

export function getOpenAI(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Add it to .env (see .env.example) before using the AI feature.",
      );
    }
    // maxRetries 0: a retry inside the client hides the timeout the caller
    // asked for, and every caller in this repository is required to fail open
    // on a slow model rather than wait longer (spec 12, modules/ai).
    client = new OpenAI({ apiKey, timeout: DEFAULT_TIMEOUT_MS, maxRetries: 0 });
  }
  return client;
}

export interface CompleteOptions {
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
}

/** Thin helper around a single-turn chat completion using the default model. */
export async function complete(prompt: string, options: CompleteOptions = {}): Promise<string> {
  const openai = getOpenAI();
  const response = await openai.chat.completions.create(
    {
      model: DEFAULT_MODEL,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxOutputTokens ?? 4096,
      ...(options.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      messages: [
        ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
        { role: "user" as const, content: prompt },
      ],
    },
    { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  return response.choices[0]?.message?.content ?? "";
}
