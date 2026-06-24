/**
 * The fork-to-investigate counterfactual — the probe only a record-replay-fork engine
 * can offer. Pose a "what if I changed X at step k?" question; it forks the trace at
 * k with the mutation, re-runs live from there, and reports BOTH how behavior diverged
 * (the regression diff) and how the security picture changed (firewall findings that
 * the change RESOLVED or INTRODUCED).
 *
 * It is pure composition over proven pieces: runAgent (fork) + compareRuns + scanTrace.
 */

import { runAgent } from '@glassbox/engine';
import type { AgentDefinition, ModelClient, Trace } from '@glassbox/engine';
import { compareRuns } from '@glassbox/evals';
import type { RunDiff } from '@glassbox/evals';
import { scanTrace } from '@glassbox/firewall';
import type { Finding } from '@glassbox/firewall';

export interface SeverityChange {
  before: Finding;
  after: Finding;
}

export interface Investigation {
  fromStep: number;
  mutation: { system: string | null };
  diff: RunDiff;
  baselineFindings: Finding[];
  counterfactualFindings: Finding[];
  /** A threat present in the baseline but gone entirely in the counterfactual. */
  resolved: Finding[];
  /** A threat new in the counterfactual (a risk the change introduced). */
  introduced: Finding[];
  /** Same threat, different severity — e.g. critical→medium means the change stopped
   *  an exfiltration even though the secret itself still appears (in user input). */
  severityChanges: SeverityChange[];
}

export interface InvestigateResult {
  investigation: Investigation;
  fork: Trace;
}

export async function investigate(opts: {
  original: Trace;
  fromStep: number;
  mutation: { system: string | null };
  agent: AgentDefinition;
  client: ModelClient;
  modelId: string;
}): Promise<InvestigateResult> {
  const { trace: fork } = await runAgent({
    agent: opts.agent,
    input: opts.original.input,
    mode: { kind: 'fork', fromStep: opts.fromStep, mutation: opts.mutation },
    client: opts.client,
    modelId: opts.modelId,
    source: opts.original,
  });

  const diff = compareRuns(opts.original, fork);
  const baselineFindings = scanTrace(opts.original);
  const counterfactualFindings = scanTrace(fork);

  const baseById = new Map(baselineFindings.map((f) => [findingKey(f), f]));
  const cfById = new Map(counterfactualFindings.map((f) => [findingKey(f), f]));

  const resolved = [...baseById].filter(([k]) => !cfById.has(k)).map(([, f]) => f);
  const introduced = [...cfById].filter(([k]) => !baseById.has(k)).map(([, f]) => f);
  const severityChanges: SeverityChange[] = [];
  for (const [k, before] of baseById) {
    const after = cfById.get(k);
    if (after && after.severity !== before.severity) severityChanges.push({ before, after });
  }

  return {
    investigation: { fromStep: opts.fromStep, mutation: opts.mutation, diff, baselineFindings, counterfactualFindings, resolved, introduced, severityChanges },
    fork,
  };
}

// Identity for correlating a threat across the two runs. `match` carries the secret
// fingerprint / injection phrase, so a secret/injection correlates by value (and its
// severity change is the consequence we measure). Taint findings, however, are one
// per (untrusted value, SINK) and share a value-only match, so they must include the
// sink location or two sinks would collide and a half-fixed leak would read "unchanged".
function findingKey(f: Finding): string {
  const base = `${f.kind}:${f.rule}:${f.match}`;
  return f.kind === 'taint' ? `${base}:${f.location.pointer}` : base;
}
