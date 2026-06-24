/**
 * Read-only probes — the sound modes (watch / assert) attached to runtime events,
 * run offline over a recorded trace. A probe is a scoped check at a step boundary;
 * watch records an observation, assert records a pass/fail. (Mutating/intervening
 * probes need sandboxing and live inside the trust boundary, so they come later;
 * the engine-unique `investigate` covers counterfactuals safely by forking.)
 */

import type { JsonValue, Step, Trace } from '@glassbox/engine';

export type ProbeMode = 'watch' | 'assert';

export interface ProbeContext {
  step: Step;
  trace: Trace;
}

export interface Probe {
  name: string;
  on: 'tool' | 'llm' | 'any';
  mode: ProbeMode;
  when?: (step: Step) => boolean;
  run: (ctx: ProbeContext) => { ok?: boolean; note: string };
}

export interface ProbeHit {
  probe: string;
  stepIdx: number;
  mode: ProbeMode;
  ok?: boolean;
  note: string;
}

export interface ProbeReport {
  hits: ProbeHit[];
  assertionsPassed: number;
  assertionsFailed: number;
  ok: boolean;
}

export function runProbes(trace: Trace, probes: Probe[]): ProbeReport {
  const hits: ProbeHit[] = [];
  for (const step of trace.steps) {
    for (const p of probes) {
      if (p.on !== 'any' && p.on !== step.type) continue;
      if (p.when && !p.when(step)) continue;
      // One faulty probe must not abort the whole report — isolate it as a failed check.
      let r: { ok?: boolean; note: string };
      try {
        r = p.run({ step, trace });
      } catch (err) {
        r = { ok: p.mode === 'assert' ? false : undefined, note: `probe errored: ${err instanceof Error ? err.message : String(err)}` };
      }
      hits.push({ probe: p.name, stepIdx: step.idx, mode: p.mode, ok: r.ok, note: r.note });
    }
  }
  const asserts = hits.filter((h) => h.mode === 'assert');
  const passed = asserts.filter((h) => h.ok === true).length;
  return { hits, assertionsPassed: passed, assertionsFailed: asserts.length - passed, ok: asserts.every((h) => h.ok === true) };
}

// ---- a small built-in probe library ----------------------------------------

/** Watch every tool call (name, simulated flag). */
export const watchToolCalls = (): Probe => ({
  name: 'watch:tool-calls',
  on: 'tool',
  mode: 'watch',
  run: ({ step }) =>
    step.type === 'tool'
      ? { note: `${step.toolName} (${step.kind}) [${step.executionMode}]${step.simulated ? ' SIMULATED' : ''}` }
      : { note: '' },
});

/** Assert every side-effecting step is accounted for (really fired or simulated). */
export const assertSideEffectsTracked = (): Probe => ({
  name: 'assert:side-effects-tracked',
  on: 'tool',
  mode: 'assert',
  when: (s) => s.type === 'tool' && s.kind === 'side_effecting',
  run: ({ step }) =>
    step.type === 'tool'
      ? { ok: step.wasRealEffect || step.simulated, note: `${step.toolName}: wasRealEffect=${step.wasRealEffect} simulated=${step.simulated}` }
      : { ok: true, note: '' },
});

/** Assert a tool's args stay under a size budget (catches runaway prompts/payloads). */
export const assertArgsUnder = (maxChars: number): Probe => ({
  name: `assert:args<${maxChars}`,
  on: 'tool',
  mode: 'assert',
  run: ({ step }) => {
    const len = JSON.stringify(step.type === 'tool' ? (step.input as JsonValue) : {}).length;
    return { ok: len < maxChars, note: `${len} chars` };
  },
});
