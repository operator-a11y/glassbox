/**
 * guard(tools, firewall) — live enforcement at the agent's tool layer, with ZERO
 * engine changes. It wraps each ToolDefinition's run (and simulate, so enforcement
 * also applies in the fork suffix):
 *  - deny ⇒ a model-legible "blocked" result is returned and the real tool (and its
 *    side effect) is never invoked;
 *  - quarantine ⇒ an injected tool result is replaced with a neutral sentinel before
 *    the model sees it, while findings are emitted to the (ephemeral) event feed.
 *
 * Inspection runs on deep CLONES, so the value returned to the agent is never
 * mutated — an allowed result is byte-identical to the raw tool's result, keeping
 * record/replay determinism intact.
 */

import type { JsonValue, ToolContext, ToolDefinition } from '@glassbox/engine';
import type { Finding } from './types.ts';
import type { Firewall } from './firewall.ts';

export interface FirewallEvent {
  seq: number;
  tool: string;
  phase: 'call' | 'result';
  action?: string;
  quarantined?: boolean;
  findings: Finding[];
}

function blockedResult(tool: string, reason: string): JsonValue {
  return { status: 'blocked_by_firewall', tool, reason, note: 'This action was not performed by Glassbox firewall policy.' };
}

function withheldResult(tool: string, reason: string): JsonValue {
  return { status: 'withheld_by_firewall', tool, reason, note: 'Tool result withheld: suspected prompt injection.' };
}

function clone<T extends JsonValue>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function guard(
  tools: ToolDefinition[],
  firewall: Firewall,
  onEvent?: (event: FirewallEvent) => void,
): ToolDefinition[] {
  let seq = 0;
  const emit = (e: Omit<FirewallEvent, 'seq'>): void => {
    if (!onEvent) return;
    try {
      onEvent({ seq: seq++, ...e });
    } catch {
      /* an observer must never crash the agent run */
    }
  };

  const wrap = (tool: ToolDefinition, impl: NonNullable<ToolDefinition['run']>) => {
    return async (args: JsonValue, ctx: ToolContext): Promise<JsonValue> => {
      const verdict = firewall.inspectCall({ tool: tool.name, kind: tool.kind, args: clone(args) });
      emit({ tool: tool.name, phase: 'call', action: verdict.action, findings: verdict.findings });
      if (verdict.action === 'deny') {
        return blockedResult(tool.name, verdict.findings[0]?.rule ?? 'policy');
      }

      const result = (await impl(args, ctx)) as JsonValue;

      const after = firewall.inspectResult({ tool: tool.name, kind: tool.kind, args: clone(args) }, clone(result));
      if (after.findings.length) emit({ tool: tool.name, phase: 'result', quarantined: after.quarantine, findings: after.findings });
      if (after.quarantine) {
        return withheldResult(tool.name, after.findings.find((f) => f.kind === 'injection')?.rule ?? 'injection');
      }
      return result;
    };
  };

  return tools.map((tool) => {
    const wrapped: ToolDefinition = { ...tool, run: wrap(tool, tool.run) };
    if (tool.simulate) wrapped.simulate = wrap(tool, tool.simulate);
    return wrapped;
  });
}
