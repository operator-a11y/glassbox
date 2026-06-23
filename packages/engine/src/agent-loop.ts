/**
 * The Anthropic-style tool-loop adapter — the integration contract made ergonomic.
 *
 * Most structured agents are the same loop: build an initial message, ask the
 * model, run whatever tools it requested, feed the results back, repeat until the
 * model stops asking for tools. `toolLoopAgent` is that loop, written once in the
 * engine's inline-io shape, so instrumenting a NEW agent is pure configuration:
 * provide a system prompt, a toolset, the tool schemas, and how to build the first
 * message. No engine changes, no hand-written resumption.
 *
 * Two run-level conveniences captured here for every agent:
 *  - a `runId` (uuid) and `startedAt` (now) drawn from ctx at the top, so every
 *    run carries captured nondeterminism that replay must reproduce;
 *  - a bounded loop (maxTurns) so a divergent fork always terminates.
 */

import type { JsonObject, JsonValue } from './json.ts';
import type { AgentDefinition, AgentFn } from './runner.ts';
import type { ToolDefinition } from './tools.ts';
import type { ToolUseBlock } from './model.ts';

export interface ToolLoopConfig {
  name: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  /** Tool schemas forwarded to the model (Anthropic Messages `tools` shape). */
  toolSchemas: JsonValue[];
  /** Build the first user message text from the run input. */
  userMessage: (input: JsonValue) => string;
  maxTokens?: number;
  maxTurns?: number;
  /** Map the final assistant text + ending state to the trace's `final` value. */
  finalize?: (finalText: string, state: JsonObject) => JsonValue;
}

const DEFAULT_MAX_TURNS = 16;
const DEFAULT_MAX_TOKENS = 1024;

export function toolLoopAgent(config: ToolLoopConfig): AgentDefinition {
  const run: AgentFn = async (io) => {
    io.state['runId'] = io.ctx.uuid();
    io.state['startedAt'] = io.ctx.now();

    const messages: JsonValue[] = [{ role: 'user', content: config.userMessage(io.input) }];
    io.state['messages'] = messages;
    io.state['turns'] = 0;

    const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    for (let turn = 0; turn < maxTurns; turn++) {
      const resp = await io.model.complete({
        messages,
        tools: config.toolSchemas,
        maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      });
      messages.push({ role: 'assistant', content: resp.content as unknown as JsonValue });
      io.state['turns'] = (io.state['turns'] as number) + 1;

      const toolUses = resp.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) {
        const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
        io.state['final'] = text;
        return finalizeValue(config, text, io.state);
      }

      const results: JsonValue[] = [];
      for (const tu of toolUses) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: await io.tools.run(tu.name, tu.input) });
      }
      messages.push({ role: 'user', content: results });
    }

    // Exhausted maxTurns without a natural stop — return whatever we have.
    const text = typeof io.state['final'] === 'string' ? (io.state['final'] as string) : '';
    return finalizeValue(config, text, io.state);
  };

  return { name: config.name, systemPrompt: config.systemPrompt, tools: config.tools, run };
}

function finalizeValue(config: ToolLoopConfig, text: string, state: JsonObject): JsonValue {
  return config.finalize ? config.finalize(text, state) : { text };
}
