import { describe, it, expect } from 'vitest';
import { toolLoopAgent } from '@glassbox/engine';
import type { JsonValue, ModelClient, ModelClientRequest, ModelResponse, Step, Trace } from '@glassbox/engine';
import {
  compareRuns,
  runEvals,
  toolCalled,
  toolNotCalled,
  noRealSideEffects,
  finalContains,
  statusIs,
  costUnder,
} from '../src/index.ts';

function llm(idx: number, content: JsonValue[]): Step {
  return {
    idx, type: 'llm', input: { system: 'S', messages: [], tools: [] }, output: { content, stopReason: 'end_turn' },
    tokens: { inputTokens: 1, outputTokens: 1 }, latencyMs: 0, stateBefore: {}, stateAfter: {}, executionMode: 'recorded',
  } as Step;
}
function tool(idx: number, name: string, kind: 'read_only' | 'side_effecting', args: JsonValue, result: JsonValue): Step {
  return {
    idx, type: 'tool', toolName: name, kind, input: args, output: result,
    wasRealEffect: kind === 'side_effecting', simulated: false, latencyMs: 0, stateBefore: {}, stateAfter: {}, executionMode: 'recorded',
  } as Step;
}
function trace(
  steps: Step[],
  final: JsonValue,
  cost = { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  status: Trace['status'] = 'completed',
): Trace {
  return {
    schemaVersion: 1, id: 'id', parentId: null, fork: null, createdAtIso: '2020-01-01T00:00:00.000Z',
    config: { agent: 'a', model: 'stub', systemPrompt: 'S', systemPromptHash: 'x', hashAlgo: 'sha256', toolset: [], maxSteps: 32 },
    input: {}, steps, nondeterminism: [], status, cost, final,
  } as Trace;
}

describe('compareRuns (regression diff)', () => {
  it('ignores nondeterministic tool_use ids — same behavior is identical', () => {
    const a = trace([llm(0, [{ type: 'tool_use', id: 'a1', name: 'search', input: { q: 'x' } }]), tool(1, 'search', 'read_only', { q: 'x' }, { r: 1 })], { text: 'ok' });
    const b = trace([llm(0, [{ type: 'tool_use', id: 'DIFFERENT', name: 'search', input: { q: 'x' } }]), tool(1, 'search', 'read_only', { q: 'x' }, { r: 1 })], { text: 'ok' });
    expect(compareRuns(a, b).identical).toBe(true);
  });

  it('flags a changed tool arg and a changed final', () => {
    const a = trace([tool(0, 'send', 'side_effecting', { body: 'neutral hi' }, { ok: true })], { text: 'sent neutral' });
    const b = trace([tool(0, 'send', 'side_effecting', { body: 'EXCITED hi' }, { ok: true })], { text: 'sent excited' });
    const d = compareRuns(a, b);
    expect(d.identical).toBe(false);
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]!.kind).toBe('changed');
    expect(d.finalChanged).toBe(true);
  });

  it('detects added/removed steps and cost delta', () => {
    const a = trace([tool(0, 'a', 'read_only', {}, {})], null, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    const b = trace([tool(0, 'a', 'read_only', {}, {}), tool(1, 'b', 'read_only', {}, {})], null, { inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    const d = compareRuns(a, b);
    expect(d.changes.some((c) => c.kind === 'added' && c.idx === 1)).toBe(true);
    expect(d.costDelta.totalTokens).toBe(5);
  });

  it('localizes an interior insertion via LCS (no cascade)', () => {
    const g = trace([tool(0, 'search', 'read_only', {}, {}), tool(1, 'read', 'read_only', {}, {}), llm(2, [{ type: 'text', text: 'done' }])], null);
    const c = trace([tool(0, 'search', 'read_only', {}, {}), tool(1, 'search', 'read_only', {}, {}), tool(2, 'read', 'read_only', {}, {}), llm(3, [{ type: 'text', text: 'done' }])], null);
    const d = compareRuns(g, c);
    expect(d.changes.filter((x) => x.kind === 'changed')).toHaveLength(0);
    expect(d.changes.filter((x) => x.kind === 'added')).toHaveLength(1);
  });

  it('detects a real↔simulated side-effect flip', () => {
    const real = trace([tool(0, 'send', 'side_effecting', { to: 'x' }, { ok: true })], null);
    const sim = trace([{ ...tool(0, 'send', 'side_effecting', { to: 'x' }, { ok: true }), wasRealEffect: false } as Step], null);
    expect(compareRuns(real, sim).identical).toBe(false);
  });

  it('enriches a changed summary with the differing fields', () => {
    const g = trace([tool(0, 'send', 'side_effecting', { to: 'x', subject: 'A', body: 'hi' }, { ok: true })], null);
    const c = trace([tool(0, 'send', 'side_effecting', { to: 'x', subject: 'B', body: 'bye' }, { ok: true })], null);
    const d = compareRuns(g, c);
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]!.summary).toContain('subject');
    expect(d.changes[0]!.summary).toContain('body');
  });

  it('surfaces cost delta in the summary even when behavior is identical', () => {
    const g = trace([], null, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    const c = trace([], null, { inputTokens: 30, outputTokens: 10, totalTokens: 40 });
    const d = compareRuns(g, c);
    expect(d.identical).toBe(true);
    expect(d.summary).toContain('cost -110 tokens');
  });
});

describe('assertions', () => {
  it('evaluate over a trace', () => {
    const t = trace([tool(0, 'send_email', 'side_effecting', { to: 'x' }, { ok: true })], { confirmation: 'Done neutral' });
    expect(toolCalled('send_email')(t).pass).toBe(true);
    expect(toolNotCalled('charge')(t).pass).toBe(true);
    expect(noRealSideEffects()(t).pass).toBe(false); // a side effect did fire
    expect(finalContains('neutral')(t).pass).toBe(true);
    expect(statusIs('completed')(t).pass).toBe(true);
    expect(costUnder(1)(t).pass).toBe(true);
  });

  it('finalContains matches string leaves, not JSON key names', () => {
    const t = trace([], { confirmation: 'Done neutral' });
    expect(finalContains('Done')(t).pass).toBe(true);
    expect(finalContains('confirmation')(t).pass).toBe(false); // key name is not content
  });
});

function isObj(v: unknown): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stubModel(): ModelClient {
  return {
    async complete(req: ModelClientRequest): Promise<ModelResponse> {
      let turns = 0;
      for (const m of req.messages) {
        if (isObj(m) && m['role'] === 'assistant' && Array.isArray(m['content']) && m['content'].some((b) => isObj(b) && b['type'] === 'tool_use')) turns++;
      }
      if (turns === 0) {
        return { content: [{ type: 'tool_use', id: 'tu', name: 'noop', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return { content: [{ type: 'text', text: 'finished' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

describe('runEvals', () => {
  it('records each case and scores assertions', async () => {
    const agent = toolLoopAgent({
      name: 'mini', systemPrompt: 'S', tools: [{ name: 'noop', kind: 'read_only', run: () => ({ ok: true }) }],
      toolSchemas: [], userMessage: () => 'go', finalize: (text) => ({ text }),
    });
    const report = await runEvals({
      agent, client: stubModel(), modelId: 'stub',
      cases: [
        { name: 'calls noop and finishes', input: {}, assertions: [toolCalled('noop'), finalContains('finished'), statusIs('completed')] },
        { name: 'expects a missing tool', input: {}, assertions: [toolCalled('missing')] },
      ],
    });
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.results[0]!.pass).toBe(true);
  });
});
