/**
 * The trace model — the engine's output and the only contract between record,
 * replay, fork, the store, and (later) the UI. zod-validated at every boundary.
 *
 * Design rules baked into these schemas:
 *  - No `.default()` / `.catch()` / `.coerce` on any field that participates in
 *    the bit-identical check: parsing a trace must never add or mutate a value,
 *    or trace-out would differ from trace-in.
 *  - `wasRealEffect` is an IMMUTABLE recorded fact (did the side effect truly
 *    fire at record time) and is part of the identity. `executionMode` and
 *    `simulated` are RUNTIME annotations (recorded vs replayed vs simulated vs
 *    live) recomputed every run; they are excluded from the identity check.
 */

import { z } from 'zod';
import type { JsonValue } from './json.ts';

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** A single draw from the nondeterminism oracle (clock / rng / id). */
export const drawSchema = z.object({
  kind: z.enum(['now', 'random', 'uuid']),
  value: z.union([z.number(), z.string()]),
  /** The step index during whose window this draw occurred. */
  stepIdx: z.number().int().nonnegative(),
});
export type Draw = z.infer<typeof drawSchema>;
export type DrawKind = Draw['kind'];

export const toolKindSchema = z.enum(['read_only', 'idempotent', 'side_effecting']);
export type ToolKind = z.infer<typeof toolKindSchema>;

export const executionModeSchema = z.enum(['recorded', 'replayed', 'simulated', 'live']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const tokensSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type Tokens = z.infer<typeof tokensSchema>;

const stepBase = {
  idx: z.number().int().nonnegative(),
  latencyMs: z.number().nonnegative(),
  stateBefore: jsonValueSchema,
  stateAfter: jsonValueSchema,
  // Runtime annotation — recomputed every run, excluded from the identity check.
  executionMode: executionModeSchema,
};

export const llmStepSchema = z.object({
  ...stepBase,
  type: z.literal('llm'),
  input: z.object({
    system: z.string(),
    messages: z.array(jsonValueSchema),
    tools: z.array(jsonValueSchema),
  }),
  output: z.object({
    content: z.array(jsonValueSchema),
    stopReason: z.string(),
  }),
  tokens: tokensSchema,
});
export type LlmStep = z.infer<typeof llmStepSchema>;

export const toolStepSchema = z.object({
  ...stepBase,
  type: z.literal('tool'),
  toolName: z.string(),
  kind: toolKindSchema,
  input: jsonValueSchema, // args
  output: jsonValueSchema, // result
  /** Immutable: did the tool's real side effect actually fire at record time. */
  wasRealEffect: z.boolean(),
  /** Runtime annotation: was the real fn suppressed this run (served or simulated). */
  simulated: z.boolean(),
});
export type ToolStep = z.infer<typeof toolStepSchema>;

export const stepSchema = z.discriminatedUnion('type', [llmStepSchema, toolStepSchema]);
export type Step = z.infer<typeof stepSchema>;

export const traceStatusSchema = z.enum(['completed', 'truncated', 'error']);
export type TraceStatus = z.infer<typeof traceStatusSchema>;

export const toolDescriptorSchema = z.object({
  name: z.string(),
  kind: toolKindSchema,
});

export const traceConfigSchema = z.object({
  agent: z.string(),
  model: z.string(),
  systemPrompt: z.string(),
  systemPromptHash: z.string(),
  hashAlgo: z.literal('sha256'),
  toolset: z.array(toolDescriptorSchema),
  maxSteps: z.number().int().positive(),
});
export type TraceConfig = z.infer<typeof traceConfigSchema>;

export const forkInfoSchema = z.object({
  fromStep: z.number().int().nonnegative(),
  mutation: z.object({ system: z.string().nullable() }),
});
export type ForkInfo = z.infer<typeof forkInfoSchema>;

export const costSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type Cost = z.infer<typeof costSchema>;

export const traceSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  /** Trace this one was forked from, if any. */
  parentId: z.string().nullable(),
  fork: forkInfoSchema.nullable(),
  /** Engine metadata — excluded from the bit-identical comparison. */
  createdAtIso: z.string(),
  config: traceConfigSchema,
  input: jsonValueSchema,
  steps: z.array(stepSchema),
  /** Flat, ordered nondeterminism log for the whole run. */
  nondeterminism: z.array(drawSchema),
  status: traceStatusSchema,
  cost: costSchema,
  final: jsonValueSchema,
});
export type Trace = z.infer<typeof traceSchema>;

export const SCHEMA_VERSION = 1 as const;
