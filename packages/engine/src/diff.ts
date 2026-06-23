/**
 * Trace comparison — where "bit-identical" is actually adjudicated.
 *
 * The comparison is over the BEHAVIORAL content of a trace (config, input, steps,
 * nondeterminism, status, cost, final), with two classes of fields excluded:
 *  - envelope metadata (id, parentId, fork, createdAtIso): legitimately unique
 *    per run.
 *  - per-step runtime annotations (executionMode, simulated): legitimately differ
 *    between a recorded step and the same step replayed/served. The immutable
 *    `wasRealEffect` IS compared.
 */

import { canonicalize } from './json.ts';
import type { JsonValue } from './json.ts';
import type { Step, Trace } from './trace.ts';

export interface TraceComparison {
  identical: boolean;
  differences: string[];
}

/** Strip per-step runtime annotations so two renderings of the same step compare equal. */
export function stepIdentity(step: Step): JsonValue {
  if (step.type === 'llm') {
    const { executionMode, ...rest } = step;
    void executionMode;
    return rest as unknown as JsonValue;
  }
  const { executionMode, simulated, ...rest } = step;
  void executionMode;
  void simulated;
  return rest as unknown as JsonValue;
}

/** The fields that make a replay "bit-identical" to its recording. */
export function behavioralView(trace: Trace): JsonValue {
  return {
    config: trace.config as unknown as JsonValue,
    input: trace.input,
    steps: trace.steps.map(stepIdentity),
    nondeterminism: trace.nondeterminism as unknown as JsonValue,
    status: trace.status,
    cost: trace.cost as unknown as JsonValue,
    final: trace.final,
  };
}

/** Full behavioral comparison — used to assert replay reproduces the recording. */
export function compareTraces(a: Trace, b: Trace): TraceComparison {
  const differences: string[] = [];

  if (a.status !== b.status) differences.push(`status: ${a.status} vs ${b.status}`);
  if (!eq(a.cost, b.cost)) differences.push(`cost: ${canonicalize(a.cost)} vs ${canonicalize(b.cost)}`);
  if (!eq(a.final, b.final)) differences.push(`final differs`);
  if (a.config.systemPromptHash !== b.config.systemPromptHash) {
    differences.push(`systemPromptHash: ${a.config.systemPromptHash} vs ${b.config.systemPromptHash}`);
  }
  if (!eq(a.input, b.input)) differences.push(`input differs`);

  if (a.steps.length !== b.steps.length) {
    differences.push(`step count: ${a.steps.length} vs ${b.steps.length}`);
  } else {
    for (let i = 0; i < a.steps.length; i++) {
      if (!eq(stepIdentity(a.steps[i]!), stepIdentity(b.steps[i]!))) {
        differences.push(`step #${i} differs`);
      }
    }
  }

  if (!eq(a.nondeterminism, b.nondeterminism)) differences.push(`nondeterminism log differs`);

  return { identical: differences.length === 0, differences };
}

export function assertReplayIdentical(original: Trace, replay: Trace): void {
  const cmp = compareTraces(original, replay);
  if (!cmp.identical) {
    throw new Error(`replay is NOT bit-identical to recording:\n  - ${cmp.differences.join('\n  - ')}`);
  }
}

/**
 * Pre-fork soundness: steps [0, k) and the nondeterminism drawn before step k must
 * be byte-for-byte identical between the original and the fork. config is excluded
 * (the fork legitimately mutates the system prompt).
 */
export function comparePrefix(original: Trace, forked: Trace, k: number): TraceComparison {
  const differences: string[] = [];

  if (forked.steps.length < k) {
    differences.push(`fork has only ${forked.steps.length} steps, expected at least ${k}`);
    return { identical: false, differences };
  }

  for (let i = 0; i < k; i++) {
    if (!eq(stepIdentity(original.steps[i]!), stepIdentity(forked.steps[i]!))) {
      differences.push(`pre-fork step #${i} differs`);
    }
  }

  const od = original.nondeterminism.filter((d) => d.stepIdx < k);
  const fd = forked.nondeterminism.filter((d) => d.stepIdx < k);
  if (!eq(od, fd)) differences.push(`pre-fork nondeterminism differs`);

  return { identical: differences.length === 0, differences };
}

export function assertPrefixIdentical(original: Trace, forked: Trace, k: number): void {
  const cmp = comparePrefix(original, forked, k);
  if (!cmp.identical) {
    throw new Error(`fork changed pre-fork steps (must be untouched):\n  - ${cmp.differences.join('\n  - ')}`);
  }
}

/** One-line, human-readable summary of a step for CLI listing / diffing. */
export function summarizeStep(step: Step): string {
  const idx = `#${String(step.idx).padStart(2, ' ')}`;
  if (step.type === 'llm') {
    return `${idx} llm   [${step.executionMode.padEnd(9)}] ${describeContent(step.output.content)}`;
  }
  const flag = step.simulated ? ' SIMULATED' : '';
  return `${idx} tool  [${step.executionMode.padEnd(9)}] ${step.toolName} (${step.kind})${flag} ${describeArgs(step.input)}`;
}

function describeContent(content: JsonValue[]): string {
  const calls: string[] = [];
  let text = '';
  for (const block of content) {
    if (isObj(block) && block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      calls.push(block['name']);
    } else if (isObj(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      text = block['text'];
    }
  }
  if (calls.length) return `→ calls ${calls.join(', ')}`;
  return `→ "${truncate(text, 56)}"`;
}

function describeArgs(args: JsonValue): string {
  const s = canonicalize(args);
  return truncate(s, 64);
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ');
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + '…';
}

function isObj(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function eq(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}
