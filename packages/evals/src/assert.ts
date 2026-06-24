/**
 * A tiny assertion DSL over a recorded trace. Each assertion is a pure function
 * trace → Check, so a case is just an input plus a list of assertions.
 */

import type { JsonValue, Trace } from '@glassbox/engine';

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export type Assertion = (trace: Trace) => Check;

/** Concatenate the string leaves of a value, so a needle isn't matched against JSON
 *  key names or delimiters (avoids both false positives and false negatives). */
function stringLeaves(v: JsonValue): string {
  const out: string[] = [];
  const walk = (x: JsonValue): void => {
    if (typeof x === 'string') out.push(x);
    else if (Array.isArray(x)) for (const el of x) walk(el);
    else if (x && typeof x === 'object') for (const k of Object.keys(x)) walk(x[k]!);
  };
  walk(v);
  return out.join('\n');
}

export const finalContains =
  (needle: string): Assertion =>
  (t) => ({ name: `final contains "${needle}"`, pass: stringLeaves(t.final).includes(needle) });

export const finalNotContains =
  (needle: string): Assertion =>
  (t) => ({ name: `final does not contain "${needle}"`, pass: !stringLeaves(t.final).includes(needle) });

export const toolCalled =
  (name: string): Assertion =>
  (t) => ({ name: `tool "${name}" called`, pass: t.steps.some((s) => s.type === 'tool' && s.toolName === name) });

export const toolNotCalled =
  (name: string): Assertion =>
  (t) => ({ name: `tool "${name}" not called`, pass: !t.steps.some((s) => s.type === 'tool' && s.toolName === name) });

export const noRealSideEffects =
  (): Assertion =>
  (t) => {
    const fired = t.steps.filter((s) => s.type === 'tool' && s.kind === 'side_effecting' && s.wasRealEffect);
    return { name: 'no real side effects fired', pass: fired.length === 0, detail: fired.length ? `${fired.length} fired` : undefined };
  };

export const statusIs =
  (status: Trace['status']): Assertion =>
  (t) => ({ name: `status is ${status}`, pass: t.status === status });

export const stepCountIs =
  (n: number): Assertion =>
  (t) => ({ name: `${n} steps`, pass: t.steps.length === n, detail: t.steps.length !== n ? `got ${t.steps.length}` : undefined });

export const costUnder =
  (maxTokens: number): Assertion =>
  (t) => ({ name: `cost < ${maxTokens} tokens`, pass: t.cost.totalTokens < maxTokens, detail: `${t.cost.totalTokens}` });
