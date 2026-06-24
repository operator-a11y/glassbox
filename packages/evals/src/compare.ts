/**
 * Regression = replay-with-variation, diffed. `compareRuns` produces a *semantic*
 * diff between a golden trace and a candidate (e.g. the same input re-run with an
 * edited system prompt): which tool-call decisions changed, whether the final
 * answer changed, and the cost delta.
 *
 * It deliberately ignores per-run nondeterminism (uuids, timestamps, state
 * snapshots, tool_use ids) — those differ between any two live runs and would drown
 * the real signal. What it compares is the agent's *behavior*: the tools it chose,
 * the args it passed (incl. whether a side effect really fired), and the answer it
 * produced. Steps are aligned with an LCS diff, so a single inserted/removed step is
 * localized rather than cascading into a wall of false "changed" rows.
 */

import { canonicalize } from '@glassbox/engine';
import type { JsonValue, Step, Trace } from '@glassbox/engine';

export interface StepChange {
  idx: number;
  kind: 'added' | 'removed' | 'changed';
  summary: string;
}

export interface RunDiff {
  identical: boolean;
  changes: StepChange[];
  finalChanged: boolean;
  statusChanged: boolean;
  costDelta: { inputTokens: number; outputTokens: number; totalTokens: number };
  summary: string;
}

export function compareRuns(golden: Trace, candidate: Trace): RunDiff {
  const g = golden.steps.map(semStep);
  const c = candidate.steps.map(semStep);
  const changes = diffSteps(g, c);

  const finalChanged = canonicalize(golden.final) !== canonicalize(candidate.final);
  const statusChanged = golden.status !== candidate.status;
  const costDelta = {
    inputTokens: candidate.cost.inputTokens - golden.cost.inputTokens,
    outputTokens: candidate.cost.outputTokens - golden.cost.outputTokens,
    totalTokens: candidate.cost.totalTokens - golden.cost.totalTokens,
  };
  const identical = changes.length === 0 && !finalChanged && !statusChanged;

  const sign = costDelta.totalTokens >= 0 ? '+' : '';
  const cost = costDelta.totalTokens !== 0 ? `; cost ${sign}${costDelta.totalTokens} tokens` : '';
  const summary = identical
    ? `no behavioral change${cost}`
    : `${changes.length} step change(s)${finalChanged ? ', final changed' : ''}${statusChanged ? ', status changed' : ''}${cost}`;

  return { identical, changes, finalChanged, statusChanged, costDelta, summary };
}

interface SemStep {
  key: string; // canonical semantic identity (nondeterminism stripped)
  type: 'llm' | 'tool';
  tool?: string;
  label: string;
  args?: JsonValue; // for richer "what changed" on tool steps
}

function semStep(s: Step): SemStep {
  if (s.type === 'llm') {
    const content = s.output.content as JsonValue[];
    const calls = toolCalls(content);
    const text = textOf(content);
    return {
      key: canonicalize({ calls, text }),
      type: 'llm',
      label: calls.length ? `llm → ${calls.map((c) => c.name).join(', ')}` : `llm → "${truncate(text, 40)}"`,
    };
  }
  // Fold kind + whether the effect really fired into the key, so a real↔simulated
  // flip (or a tool changing kind) is detected as a behavior change.
  return {
    key: canonicalize({ tool: s.toolName, args: s.input, kind: s.kind, realEffect: s.wasRealEffect }),
    type: 'tool',
    tool: s.toolName,
    label: `tool ${s.toolName}`,
    args: s.input,
  };
}

/** LCS-aligned edit script over step keys, with adjacent delete+insert coalesced to "changed". */
function diffSteps(g: SemStep[], c: SemStep[]): StepChange[] {
  const m = g.length;
  const k = c.length;
  const L: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(k + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = k - 1; j >= 0; j--) {
      L[i]![j] = g[i]!.key === c[j]!.key ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    }
  }

  const changes: StepChange[] = [];
  let dels: Array<{ step: SemStep; idx: number }> = [];
  let inses: Array<{ step: SemStep; idx: number }> = [];

  // Flush the accumulated gap between two LCS matches: pair deletions with insertions
  // positionally as "changed" (a substitution), and emit any extras as removed/added.
  const flush = (): void => {
    const paired = Math.min(dels.length, inses.length);
    for (let x = 0; x < paired; x++) changes.push({ idx: dels[x]!.idx, kind: 'changed', summary: changedSummary(dels[x]!.step, inses[x]!.step) });
    for (let x = paired; x < dels.length; x++) changes.push({ idx: dels[x]!.idx, kind: 'removed', summary: `removed: ${dels[x]!.step.label}` });
    for (let x = paired; x < inses.length; x++) changes.push({ idx: inses[x]!.idx, kind: 'added', summary: `added: ${inses[x]!.step.label}` });
    dels = [];
    inses = [];
  };

  let i = 0;
  let j = 0;
  while (i < m && j < k) {
    if (g[i]!.key === c[j]!.key) {
      flush();
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) {
      dels.push({ step: g[i]!, idx: i });
      i++;
    } else {
      inses.push({ step: c[j]!, idx: j });
      j++;
    }
  }
  while (i < m) dels.push({ step: g[i]!, idx: i++ });
  while (j < k) inses.push({ step: c[j]!, idx: j++ });
  flush();

  return changes;
}

function changedSummary(a: SemStep, b: SemStep): string {
  if (a.type !== b.type || a.label !== b.label) return `${a.label}  →  ${b.label}`;
  if (a.type === 'tool' && a.tool === b.tool) {
    const fields = changedKeys(a.args, b.args);
    return fields.length ? `tool ${a.tool}: ${fields.join(', ')} changed` : `tool ${a.tool}: args changed`;
  }
  return `${a.label}: output changed`;
}

function changedKeys(a: JsonValue | undefined, b: JsonValue | undefined): string[] {
  if (!isObj(a) || !isObj(b)) return [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const key of keys) {
    if (canonicalize(a[key] ?? null) !== canonicalize(b[key] ?? null)) out.push(key);
  }
  return out.sort();
}

function toolCalls(content: JsonValue[]): Array<{ name: string; input: JsonValue }> {
  const out: Array<{ name: string; input: JsonValue }> = [];
  for (const block of content) {
    if (isObj(block) && block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      out.push({ name: block['name'], input: block['input'] ?? null });
    }
  }
  return out;
}

function textOf(content: JsonValue[]): string {
  let t = '';
  for (const block of content) if (isObj(block) && block['type'] === 'text' && typeof block['text'] === 'string') t += block['text'];
  return t;
}

function truncate(s: string, n: number): string {
  const o = s.replace(/\s+/g, ' ').trim();
  return o.length <= n ? o : o.slice(0, n - 1) + '…';
}

function isObj(v: JsonValue | undefined): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
