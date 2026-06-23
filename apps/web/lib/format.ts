import type { ExecutionMode, Step } from './api';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function contentCalls(content: unknown[]): string[] {
  const out: string[] = [];
  for (const b of content) if (isObj(b) && b['type'] === 'tool_use' && typeof b['name'] === 'string') out.push(b['name']);
  return out;
}

export function contentText(content: unknown[]): string {
  for (const b of content) if (isObj(b) && b['type'] === 'text' && typeof b['text'] === 'string') return b['text'];
  return '';
}

export function truncate(s: string, n: number): string {
  const o = s.replace(/\s+/g, ' ').trim();
  return o.length <= n ? o : o.slice(0, n - 1) + '…';
}

export function stepSummary(step: Step): string {
  if (step.type === 'llm') {
    const calls = contentCalls(step.output.content);
    if (calls.length) return `→ calls ${calls.join(', ')}`;
    const t = contentText(step.output.content);
    return t ? `“${truncate(t, 64)}”` : '→ (final)';
  }
  return `${step.toolName} (${step.kind})`;
}

export function execClass(mode: ExecutionMode): string {
  switch (mode) {
    case 'recorded':
      return 'text-zinc-400';
    case 'replayed':
      return 'text-zinc-500';
    case 'simulated':
      return 'text-sky-300';
    case 'live':
      return 'text-emerald-300';
  }
}

export function prettyJson(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/** Identity of a step ignoring per-run annotations (executionMode, simulated). */
function stepIdentity(step: Step): string {
  const clone = JSON.parse(JSON.stringify(step)) as Record<string, unknown>;
  delete clone['executionMode'];
  delete clone['simulated'];
  return JSON.stringify(clone);
}

export function stepDiverged(a: Step | undefined, b: Step | undefined): boolean {
  if (!a || !b) return true;
  return stepIdentity(a) !== stepIdentity(b);
}
