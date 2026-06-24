import { describe, it, expect } from 'vitest';
import { runAgent, toolLoopAgent } from '@glassbox/engine';
import type { AgentDefinition, JsonValue, ModelClient, ModelClientRequest, ModelResponse } from '@glassbox/engine';
import { scanTrace } from '@glassbox/firewall';
import { investigate, runProbes, watchToolCalls, assertSideEffectsTracked, assertArgsUnder, type Probe } from '../src/index.ts';

const SECRET = 'sk-ant-api03-' + 'A'.repeat(28);

function isObj(v: unknown): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function countToolUseTurns(messages: JsonValue[]): number {
  let n = 0;
  for (const m of messages) {
    if (isObj(m) && m['role'] === 'assistant' && Array.isArray(m['content']) && m['content'].some((b) => isObj(b) && b['type'] === 'tool_use')) n++;
  }
  return n;
}

// A leaky agent: it forwards the user's text into a side-effecting `send` tool's args.
// The stub honors a `SAFE` directive in the system prompt by redacting secrets — so a
// counterfactual that adds SAFE removes the exfiltration.
function stubModel(): ModelClient {
  return {
    async complete(req: ModelClientRequest): Promise<ModelResponse> {
      const safe = /SAFE/.test(req.system);
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (countToolUseTurns(req.messages) === 0) {
        const first = req.messages[0];
        const payload = isObj(first) && typeof first['content'] === 'string' ? first['content'] : '';
        const body = safe ? payload.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]') : payload;
        return { content: [{ type: 'tool_use', id: 'tu', name: 'send', input: { body } }], stopReason: 'tool_use', usage };
      }
      return { content: [{ type: 'text', text: safe ? 'done (safe)' : 'done' }], stopReason: 'end_turn', usage };
    },
  };
}

function leakyAgent(): AgentDefinition {
  return toolLoopAgent({
    name: 'leaky',
    systemPrompt: 'You are leaky.',
    tools: [{ name: 'send', kind: 'side_effecting', run: () => ({ status: 'sent' }) }],
    toolSchemas: [],
    userMessage: (input) => String((input as { payload: string }).payload),
    finalize: (text) => ({ text }),
  });
}

describe('investigate (fork-to-counterfactual)', () => {
  it('a counterfactual resolves a critical exfiltration finding and shows the behavior change', async () => {
    const agent = leakyAgent();
    const client = stubModel();
    const { trace: original } = await runAgent({ agent, input: { payload: `my key ${SECRET} stopped working` }, mode: { kind: 'record' }, client, modelId: 'stub' });

    // baseline: the secret is exfiltrated through the side-effecting tool
    expect(scanTrace(original).some((f) => f.severity === 'critical')).toBe(true);

    const { investigation, fork } = await investigate({
      original,
      fromStep: 0,
      mutation: { system: 'You are leaky. SAFE' },
      agent,
      client,
      modelId: 'stub',
    });

    // the counterfactual stops the exfiltration: no critical remains in the fork,
    // and the secret's severity is downgraded critical→medium (it still appears in the
    // user's input, which the prompt edit cannot un-type, but it no longer leaves).
    expect(scanTrace(fork).some((f) => f.severity === 'critical')).toBe(false);
    expect(investigation.severityChanges.some((sc) => sc.before.severity === 'critical' && sc.after.severity === 'medium')).toBe(true);
    // ... and that is reflected as a behavior change (the send args differ)
    expect(investigation.diff.identical).toBe(false);
  });
});

describe('runProbes (read-only watch/assert)', () => {
  it('watches tool calls and asserts side effects are tracked', async () => {
    const agent = leakyAgent();
    const client = stubModel();
    const { trace } = await runAgent({ agent, input: { payload: 'hello' }, mode: { kind: 'record' }, client, modelId: 'stub' });

    const report = runProbes(trace, [watchToolCalls(), assertSideEffectsTracked(), assertArgsUnder(100_000)]);
    expect(report.hits.some((h) => h.probe === 'watch:tool-calls' && h.note.includes('send'))).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.assertionsFailed).toBe(0);
  });

  it('flags a failing assertion', async () => {
    const agent = leakyAgent();
    const client = stubModel();
    const { trace } = await runAgent({ agent, input: { payload: 'hello world this is a longer payload' }, mode: { kind: 'record' }, client, modelId: 'stub' });
    const report = runProbes(trace, [assertArgsUnder(5)]); // unrealistically small budget
    expect(report.ok).toBe(false);
    expect(report.assertionsFailed).toBeGreaterThan(0);
  });

  it('isolates a throwing probe instead of aborting the whole report', async () => {
    const agent = leakyAgent();
    const client = stubModel();
    const { trace } = await runAgent({ agent, input: { payload: 'hi' }, mode: { kind: 'record' }, client, modelId: 'stub' });
    const thrower: Probe = { name: 'boom', on: 'any', mode: 'assert', run: () => { throw new Error('boom'); } };
    const report = runProbes(trace, [watchToolCalls(), thrower]);
    expect(report.hits.some((h) => h.probe === 'watch:tool-calls')).toBe(true); // good probe still ran
    expect(report.hits.some((h) => h.probe === 'boom' && h.ok === false && h.note.includes('errored'))).toBe(true);
    expect(report.ok).toBe(false);
  });
});
