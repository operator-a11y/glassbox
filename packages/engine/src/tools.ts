/**
 * The tool instrumentation seam — also the side-effect soundness boundary.
 *
 * Tool policy is region + kind aware and is decided at runtime, never copied
 * from the recording:
 *  - pre-fork (record/replay/fork-prefix): the result is served from the
 *    recording; side-effecting tools are flagged SIMULATED and never executed.
 *  - fork suffix (divergent, live): side-effecting tools are ALWAYS short-circuited
 *    to a synthesized SIMULATED result BEFORE any recording lookup or live-exec
 *    fallback; read_only / idempotent tools run live.
 *
 * A divergent forked agent can emit a brand-new side-effecting call the recording
 * never knew about — the kind-based interception is what stops that call from
 * firing a real email / charge. Belt-and-suspenders: during replay/fork the real
 * `run` of a side-effecting tool is wrapped in a trap that throws if ever invoked.
 */

import type { JsonValue } from './json.ts';
import type { ToolKind } from './trace.ts';
import type { Recorder } from './recorder.ts';

export interface ToolContext {
  now(): number;
  random(): number;
  uuid(): string;
}

export interface ToolDefinition {
  name: string;
  kind: ToolKind;
  /** The real implementation. For side-effecting tools this performs the effect
   *  and is only ever called in record mode (or via explicit opt-in live re-exec). */
  run(args: JsonValue, ctx: ToolContext): Promise<JsonValue> | JsonValue;
  /** Pure, side-effect-free result synthesis for the fork suffix, where a
   *  divergent side-effecting call has no recorded result to serve. Must not
   *  perform the side effect. */
  simulate?(args: JsonValue, ctx: ToolContext): Promise<JsonValue> | JsonValue;
  /** Opt this tool into REAL execution in the fork suffix instead of being
   *  SIMULATED. Explicit and dangerous for side-effecting tools — the effect fires
   *  for real and the step is flagged `executionMode: 'live'`. Off by default. */
  liveReplay?: boolean;
}

export interface WrappedTools {
  run(name: string, args: JsonValue): Promise<JsonValue>;
}

export function createToolRunner(tools: ToolDefinition[], recorder: Recorder): WrappedTools {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`createToolRunner: duplicate tool "${tool.name}"`);
    byName.set(tool.name, tool);
  }
  return {
    run(name: string, args: JsonValue): Promise<JsonValue> {
      const tool = byName.get(name);
      if (!tool) throw new Error(`createToolRunner: unknown tool "${name}"`);
      return recorder.runToolStep(tool, args);
    },
  };
}
