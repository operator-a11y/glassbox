/**
 * The runner: drives a structured agent in `record`, `replay`, or `fork` mode and
 * assembles a zod-validated Trace.
 *
 * The agent is an inline-io async function: it awaits `io.model.complete(...)` and
 * `io.tools.run(...)` and mutates `io.state`. A step is born at each wrapped call;
 * the run ends when the function returns. Replay and fork re-drive this same
 * function from the top — the Recorder decides, per primitive, whether to serve a
 * recorded value or run live.
 */

import { randomUUID } from 'node:crypto';
import { jsonClone, sha256Hex } from './json.ts';
import type { JsonObject, JsonValue } from './json.ts';
import { traceSchema } from './trace.ts';
import type { Trace, TraceStatus } from './trace.ts';
import { wrapModel } from './model.ts';
import type { ModelClient, WrappedModel } from './model.ts';
import { createToolRunner } from './tools.ts';
import type { ToolContext, ToolDefinition, WrappedTools } from './tools.ts';
import { BudgetExceededError, Recorder } from './recorder.ts';
import type { RunMode } from './recorder.ts';

export const DEFAULT_MAX_STEPS = 32;

/** What the agent author implements. */
export interface AgentIO {
  readonly input: JsonValue;
  /** Mutable working state. Must stay strictly JSON-serializable. */
  readonly state: JsonObject;
  readonly model: WrappedModel;
  readonly tools: WrappedTools;
  readonly ctx: ToolContext;
}

export type AgentFn = (io: AgentIO) => Promise<JsonValue>;

export interface AgentDefinition {
  name: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  run: AgentFn;
}

export interface RunOptions {
  agent: AgentDefinition;
  input: JsonValue;
  mode: RunMode;
  client: ModelClient;
  /** Model identifier recorded in the trace config. */
  modelId: string;
  /** Recorded trace to serve from (required for replay / fork). */
  source?: Trace | null;
  maxSteps?: number;
  /** Injectable engine-metadata generators (kept out of the bit-identical check). */
  newId?: () => string;
  nowIso?: () => string;
}

export interface RunResult {
  trace: Trace;
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { agent, mode, source } = opts;

  if ((mode.kind === 'replay' || mode.kind === 'fork') && !source) {
    throw new Error(`runAgent: mode "${mode.kind}" requires a source trace`);
  }
  if (mode.kind === 'fork' && source) {
    const maxStep = source.steps.length - 1;
    if (!Number.isInteger(mode.fromStep) || mode.fromStep < 0 || mode.fromStep > maxStep) {
      throw new Error(
        `runAgent: fork fromStep ${mode.fromStep} is out of range [0, ${maxStep}] — there is no step to fork at`,
      );
    }
  }

  const originalSystem = source ? source.config.systemPrompt : agent.systemPrompt;
  const maxSteps = opts.maxSteps ?? source?.config.maxSteps ?? DEFAULT_MAX_STEPS;

  const recorder = new Recorder({
    mode,
    systemPrompt: originalSystem,
    maxSteps,
    source: source ? { steps: source.steps, nondeterminism: source.nondeterminism } : null,
  });

  const state: JsonObject = {};
  recorder.bindState(() => state);

  const io: AgentIO = {
    input: opts.input,
    state,
    model: wrapModel(opts.client, recorder),
    tools: createToolRunner(agent.tools, recorder),
    ctx: recorder.ctx,
  };

  let status: TraceStatus = 'completed';
  let final: JsonValue = null;
  try {
    final = await agent.run(io);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      status = 'truncated';
      final = null;
    } else {
      throw err;
    }
  }

  // Replay must be a strict, fully-consumed reproduction.
  recorder.assertFullyConsumed();

  const steps = recorder.getSteps();
  const draws = recorder.getDraws();

  let inputTokens = 0;
  let outputTokens = 0;
  for (const step of steps) {
    if (step.type === 'llm') {
      inputTokens += step.tokens.inputTokens;
      outputTokens += step.tokens.outputTokens;
    }
  }

  const configSystem =
    mode.kind === 'fork' && mode.mutation.system !== null ? mode.mutation.system : originalSystem;

  const modelId = opts.modelId || source?.config.model || 'unknown';

  const trace: Trace = {
    schemaVersion: 1,
    id: opts.newId ? opts.newId() : randomUUID(),
    parentId: source?.id ?? null,
    fork:
      mode.kind === 'fork'
        ? { fromStep: mode.fromStep, mutation: { system: mode.mutation.system } }
        : null,
    createdAtIso: opts.nowIso ? opts.nowIso() : new Date().toISOString(),
    config: {
      agent: agent.name,
      model: modelId,
      systemPrompt: configSystem,
      systemPromptHash: sha256Hex(configSystem),
      hashAlgo: 'sha256',
      toolset: agent.tools.map((t) => ({ name: t.name, kind: t.kind })),
      maxSteps,
    },
    input: jsonClone(opts.input),
    steps,
    nondeterminism: draws,
    status,
    cost: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    final: jsonClone(final),
  };

  // zod at the boundary: the produced trace must be valid by construction.
  return { trace: traceSchema.parse(trace) };
}
