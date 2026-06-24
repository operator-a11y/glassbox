/**
 * Coverage. Enumerate every place a secret or injection can hide, with a JSON
 * Pointer and a provenance for each. Coverage is exhaustive on purpose — a security
 * tool that says "no findings" while a secret sits in stateAfter or input.system is
 * worse than no tool. Cross-trace dedup (in scanTrace) absorbs the redundancy that
 * scanning state + messages introduces.
 */

import type { JsonValue, ToolKind, Trace } from '@glassbox/engine';
import type { Provenance } from './types.ts';

export interface Surface {
  pointer: string;
  stepIdx: number | null;
  stepType?: 'llm' | 'tool';
  toolName?: string;
  toolKind?: ToolKind;
  provenance: Provenance;
  /** Raw string leaves under this field-group (concatenated for scanning, kept for taint). */
  leaves: string[];
}

export function collectSurface(trace: Trace): Surface[] {
  const surfaces: Surface[] = [];
  const add = (s: Omit<Surface, 'leaves'>, value: JsonValue): void => {
    const leaves = leavesOf(value);
    if (leaves.length) surfaces.push({ ...s, leaves });
  };

  add({ pointer: '/input', stepIdx: null, provenance: 'user-input' }, trace.input);
  add({ pointer: '/config/systemPrompt', stepIdx: null, provenance: 'config' }, trace.config.systemPrompt);
  if (trace.fork && trace.fork.mutation.system != null) {
    add({ pointer: '/fork/mutation/system', stepIdx: null, provenance: 'config' }, trace.fork.mutation.system);
  }

  trace.steps.forEach((step, i) => {
    if (step.type === 'llm') {
      add({ pointer: `/steps/${i}/input/system`, stepIdx: i, stepType: 'llm', provenance: 'system' }, step.input.system);
      add({ pointer: `/steps/${i}/input/messages`, stepIdx: i, stepType: 'llm', provenance: 'model-input' }, step.input.messages as JsonValue);
      add({ pointer: `/steps/${i}/input/tools`, stepIdx: i, stepType: 'llm', provenance: 'tool-schema' }, step.input.tools as JsonValue);
      add({ pointer: `/steps/${i}/output/content`, stepIdx: i, stepType: 'llm', provenance: 'model-output' }, step.output.content as JsonValue);
    } else {
      const meta = { stepIdx: i, stepType: 'tool' as const, toolName: step.toolName, toolKind: step.kind };
      add({ pointer: `/steps/${i}/input`, provenance: 'tool-args', ...meta }, step.input);
      add({ pointer: `/steps/${i}/output`, provenance: 'tool-result', ...meta }, step.output);
    }
    add({ pointer: `/steps/${i}/stateBefore`, stepIdx: i, stepType: step.type, provenance: 'state' }, step.stateBefore);
    add({ pointer: `/steps/${i}/stateAfter`, stepIdx: i, stepType: step.type, provenance: 'state' }, step.stateAfter);
  });

  add({ pointer: '/final', stepIdx: null, provenance: 'final' }, trace.final);
  return surfaces;
}

function leavesOf(value: JsonValue): string[] {
  const out: string[] = [];
  const walk = (v: JsonValue): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const el of v) walk(el);
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]!);
  };
  walk(value);
  return out;
}
