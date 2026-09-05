// Concrete AiPort adapter, wrapping the lazily-constructed OpenAI client in
// ../../lib/ai. Importing this module never throws, even with no
// OPENAI_API_KEY configured; the clear error only fires when a caller
// actually invokes `complete`.
//
// THIS FACTORY IS NOT CALLED UNLESS THE AI FEATURE FLAG IS ON. core/app.ts
// constructs it only when AI_ENABLED is "true", so a deployment with the layer
// off never builds an OpenAI client at all and never needs a key. Under
// `bun test` the flag is never on: modules/ai's tests inject a stub port, so
// no test in this repository can reach a network or an API key.
import { complete, DEFAULT_MODEL } from "../../lib/ai";
import type { AiPort, CompletionOptions } from "../ports/ai";

export function createAiAdapter(): AiPort {
  return {
    model: DEFAULT_MODEL,
    complete(prompt: string, options?: CompletionOptions): Promise<string> {
      return complete(prompt, options);
    },
  };
}
