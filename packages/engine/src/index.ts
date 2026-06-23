/**
 * @glassbox/engine — deterministic record-replay-fork core.
 *
 * The atom: record an agent run, replay it bit-identically (the LLM is not
 * re-called), and fork from any step (restore state by re-driving, mutate the
 * system prompt, run live forward) into a divergent-but-valid continuation —
 * with side-effecting tools served-and-mocked (SIMULATED), never re-fired.
 */

// Determinism primitives
export {
  assertJsonValue,
  canonicalize,
  canonicalEqual,
  jsonClone,
  toPrettyJson,
  sha256Hex,
} from './json.ts';
export type { JsonValue, JsonObject } from './json.ts';

// Trace model
export {
  drawSchema,
  toolKindSchema,
  executionModeSchema,
  tokensSchema,
  llmStepSchema,
  toolStepSchema,
  stepSchema,
  traceStatusSchema,
  traceConfigSchema,
  traceSchema,
  SCHEMA_VERSION,
} from './trace.ts';
export type {
  Draw,
  DrawKind,
  ToolKind,
  ExecutionMode,
  Tokens,
  LlmStep,
  ToolStep,
  Step,
  TraceStatus,
  TraceConfig,
  ForkInfo,
  Cost,
  Trace,
} from './trace.ts';

// Instrumentation seams
export { wrapModel } from './model.ts';
export type {
  TextBlock,
  ToolUseBlock,
  ContentBlock,
  ModelRequest,
  ModelClientRequest,
  ModelResponse,
  ModelClient,
  WrappedModel,
} from './model.ts';

export { createToolRunner } from './tools.ts';
export type { ToolContext, ToolDefinition, WrappedTools } from './tools.ts';

// Engine core
export {
  Recorder,
  DesyncError,
  BudgetExceededError,
  SideEffectTrapError,
} from './recorder.ts';
export type { RunMode, RecorderInit } from './recorder.ts';

export { runAgent, DEFAULT_MAX_STEPS } from './runner.ts';
export type { AgentIO, AgentFn, AgentDefinition, RunOptions, RunResult } from './runner.ts';

// Comparison + store
export {
  compareTraces,
  assertReplayIdentical,
  comparePrefix,
  assertPrefixIdentical,
  behavioralView,
  stepIdentity,
  summarizeStep,
} from './diff.ts';
export type { TraceComparison } from './diff.ts';

export { saveTrace, loadTrace } from './store.ts';
