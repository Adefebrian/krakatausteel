// Port interface for the default LLM. Modules depend on this shape, never on
// the `openai` client directly. See core/adapters/ai.ts for the concrete
// adapter, which is pinned to gpt-4o-mini per jal-standards.
//
// EVERY OPTION HERE EXISTS BECAUSE A CALLER MUST BE ABLE TO BOUND THE CALL.
// The AI layer of this system is an ASSISTANT (spec 12): it proposes, a human
// decides, and the human workflow must continue untouched when the model is
// slow, absent or wrong. A port with no timeout and no output ceiling cannot
// be made to fail open by its caller, because the caller has no lever: it can
// only wait. So `timeoutMs` and `maxOutputTokens` are part of the CONTRACT,
// not of one adapter's configuration.
export interface CompletionOptions {
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Hard ceiling for ONE call, in milliseconds. The adapter hands it to the
   * provider client; a caller that needs a guarantee rather than a request
   * races this promise itself (modules/ai/ekstraksi.ts does both).
   */
  timeoutMs?: number;
  /**
   * Ask the provider for a syntactically valid JSON object. It is a hint and
   * never a guarantee: the caller still parses defensively and still treats
   * the result as untrusted text. See modules/ai/contract.ts rule 3.
   */
  jsonMode?: boolean;
}

export interface AiPort {
  /** Single-turn chat completion using the JAL default model. */
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  /**
   * The model this adapter actually calls, for provenance. Recorded on every
   * stored suggestion (spec 12: "model yang dipakai"), so a suggestion made by
   * one model is never mistaken for one made by another.
   */
  readonly model: string;
}
