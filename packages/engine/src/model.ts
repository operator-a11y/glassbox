/**
 * The LLM instrumentation seam.
 *
 * `wrapModel` returns a model the agent calls inline (`await io.model.complete(...)`).
 * The agent never passes a system prompt — the engine injects it (config prompt
 * pre-fork, mutated prompt in the fork suffix), so the system prompt has exactly
 * one runtime source of truth and a fork mutation cannot silently no-op.
 *
 * In record mode the wrapped call hits the real client and emits an `llm` step.
 * In replay / fork-prefix it returns the recorded completion WITHOUT calling the
 * client. In the fork suffix it calls the client live with the mutated prompt.
 * All of that policy lives in the Recorder; this file is the typed facade.
 */

import type { JsonValue, JsonObject } from './json.ts';
import type { Tokens } from './trace.ts';
import type { Recorder } from './recorder.ts';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: JsonObject;
}

export type ContentBlock = TextBlock | ToolUseBlock;

/** What the agent passes — note the absence of `system`, by design. */
export interface ModelRequest {
  messages: JsonValue[];
  tools: JsonValue[];
  maxTokens: number;
}

/** What the engine passes to the underlying client, with the injected system. */
export interface ModelClientRequest extends ModelRequest {
  system: string;
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: string;
  usage: Tokens;
}

/** The minimal client contract. The real Anthropic adapter and the deterministic
 *  stub both implement this; the engine never imports `@anthropic-ai/sdk` directly. */
export interface ModelClient {
  complete(req: ModelClientRequest): Promise<ModelResponse>;
}

export interface WrappedModel {
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export function wrapModel(client: ModelClient, recorder: Recorder): WrappedModel {
  return {
    complete: (req: ModelRequest) => recorder.runLlmStep(req, client),
  };
}
