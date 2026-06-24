/**
 * Regression = replay-with-variation, diffed. `compareRuns` produces a *semantic*
 * diff between a golden trace and a candidate (e.g. the same input re-run with an
 * edited system prompt): which tool-call decisions changed, whether the final
 * answer changed, and the cost delta.
 *
 * It deliberately ignores per-run nondeterminism (uuids, timestamps, state
 * snapshots, tool_use ids) — those differ between any two live runs and would drown
 * the real signal. What it compares is the agent's *behavior*: the tools it chose,
 * the args it passed, and the answer it produced.
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
  const n = Math.max(g.length, c.length);

  const changes: StepChange[] = [];
  for (let i = 0; i < n; i++) {
    const a = g[i];
    const b = c[i];
    if (a && b) {
      if (a.key !== b.key) changes.push({ idx: i, kind: 'changed', summary: `${a.label}  →  ${b.label}` });
    } else if (a) {
      changes.push({ idx: i, kind: 'removed', summary: `removed: ${a.label}` });
    } else if (b) {
      changes.push({ idx: i, kind: 'added', summary: `added: ${b.label}` });
    }
  }

  const finalChanged = canonicalize(golden.final) !== canonicalize(candidate.final);
  const statusChanged = golden.status !== candidate.status;
  const costDelta = {
    inputTokens: candidate.cost.inputTokens - golden.cost.inputTokens,
    outputTokens: candidate.cost.outputTokens - golden.cost.outputTokens,
    totalTokens: candidate.cost.totalTokens - golden.cost.totalTokens,
  };
  const identical = changes.length === 0 && !finalChanged && !statusChanged;
  const sign = costDelta.totalTokens >= 0 ? '+' : '';
  const summary = identical
    ? 'no behavioral change'
    : `${changes.length} step change(s)${finalChanged ? ', final changed' : ''}${statusChanged ? ', status changed' : ''}; cost ${sign}${costDelta.totalTokens} tokens`;

  return { identical, changes, finalChanged, statusChanged, costDelta, summary };
}

interface SemStep {
  key: string; // canonical semantic identity (nondeterminism stripped)
  label: string; // human one-liner
}

function semStep(s: Step): SemStep {
  if (s.type === 'llm') {
    const content = s.output.content as JsonValue[];
    const calls = toolCalls(content);
    const text = textOf(content);
    return {
      key: canonicalize({ calls, text }),
      label: calls.length ? `llm → ${calls.map((c) => c.name).join(', ')}` : `llm → "${truncate(text, 40)}"`,
    };
  }
  return { key: canonicalize({ tool: s.toolName, args: s.input }), label: `tool ${s.toolName}` };
}

function toolCalls(content: JsonValue[]): Array<{ name: string; input: JsonValue }> {
  const out: Array<{ name: string; input: JsonValue }> = [];
  for (const b of content) {
    if (isObj(b) && b['type'] === 'tool_use' && typeof b['name'] === 'string') {
      out.push({ name: b['name'], input: b['input'] ?? null });
    }
  }
  return out;
}

function textOf(content: JsonValue[]): string {
  let t = '';
  for (const b of content) if (isObj(b) && b['type'] === 'text' && typeof b['text'] === 'string') t += b['text'];
  return t;
}

function truncate(s: string, n: number): string {
  const o = s.replace(/\s+/g, ' ').trim();
  return o.length <= n ? o : o.slice(0, n - 1) + '…';
}

function isObj(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
