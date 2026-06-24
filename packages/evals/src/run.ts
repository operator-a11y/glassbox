/**
 * Evals = batch record + scoring. `runEvals` records each case and runs its
 * assertions over the resulting trace. (Build the agent with a throwaway sink so
 * eval runs don't perform real side effects.)
 */

import { runAgent } from '@glassbox/engine';
import type { AgentDefinition, JsonValue, ModelClient, Trace } from '@glassbox/engine';
import type { Assertion, Check } from './assert.ts';

export interface EvalCase {
  name: string;
  input: JsonValue;
  assertions: Assertion[];
}

export interface CaseResult {
  name: string;
  trace: Trace;
  checks: Check[];
  pass: boolean;
}

export interface EvalReport {
  results: CaseResult[];
  passed: number;
  failed: number;
  ok: boolean;
}

export async function runEvals(opts: {
  agent: AgentDefinition;
  client: ModelClient;
  modelId: string;
  cases: EvalCase[];
}): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const c of opts.cases) {
    const { trace } = await runAgent({ agent: opts.agent, input: c.input, mode: { kind: 'record' }, client: opts.client, modelId: opts.modelId });
    const checks = c.assertions.map((a) => a(trace));
    results.push({ name: c.name, trace, checks, pass: checks.every((ck) => ck.pass) });
  }
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed, ok: passed === results.length };
}
