import { describe, it, expect } from 'vitest';
import { runAgent, assertReplayIdentical, comparePrefix } from '@glassbox/engine';
import type { ModelClient, Step, Trace } from '@glassbox/engine';
import { buildAgent, DEFAULT_SYSTEM_PROMPT } from '../src/agent.ts';
import { stubModel } from '../src/stub-model.ts';
import { memoryTicketSink } from '../src/sink.ts';

const INPUT = { customer: 'c-42', ticket: 'login is broken, cannot access account' };
const META = { newId: () => 'fixed-id', nowIso: () => '2020-01-01T00:00:00.000Z' };

const throwingClient: ModelClient = {
  async complete() {
    throw new Error('LLM must not be called during replay');
  },
};

function record() {
  const sink = memoryTicketSink();
  return { sink, agent: buildAgent(sink) };
}

function ticketStep(trace: Trace): Step {
  const s = trace.steps.find((x) => x.type === 'tool' && x.toolName === 'create_ticket');
  if (!s) throw new Error('no create_ticket step');
  return s;
}

function draftStep(trace: Trace): number {
  return trace.steps.findIndex((x) => x.type === 'tool' && x.toolName === 'create_ticket') - 1;
}

function titleOf(step: Step): string {
  return step.type === 'tool' ? ((step.input as unknown as { title?: string }).title ?? '') : '';
}

function urgentPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT.replace(/STYLE:\s*\w+/, 'STYLE: urgent');
}

describe('support-triage: a second agent on the same engine, no engine changes', () => {
  it('record: 7 structured steps and exactly one filed ticket', async () => {
    const { sink, agent } = record();
    const { trace } = await runAgent({ agent, input: INPUT, mode: { kind: 'record' }, client: stubModel(), modelId: 'stub', ...META });
    expect(trace.status).toBe('completed');
    expect(trace.steps.map((s) => s.type)).toEqual(['llm', 'tool', 'llm', 'tool', 'llm', 'tool', 'llm']);
    expect(sink.list()).toHaveLength(1);
    const t = ticketStep(trace);
    expect(t.type === 'tool' && t.kind).toBe('side_effecting');
    expect(t.type === 'tool' && t.executionMode).toBe('recorded');
    // customer id parsed cleanly (no trailing delimiter period)
    expect((t.input as unknown as { customer: string }).customer).toBe('c-42');
  });

  it('replay: bit-identical, the ticket tool is SIMULATED and never re-filed', async () => {
    const rec = record();
    const { trace: original } = await runAgent({ agent: rec.agent, input: INPUT, mode: { kind: 'record' }, client: stubModel(), modelId: 'stub', ...META });

    const rep = record();
    const { trace: replayed } = await runAgent({ agent: rep.agent, input: original.input, mode: { kind: 'replay' }, client: throwingClient, modelId: original.config.model, source: original, ...META });

    assertReplayIdentical(original, replayed);
    expect(rep.sink.list()).toHaveLength(0);
    const t = ticketStep(replayed);
    expect(t.type === 'tool' && t.simulated).toBe(true);
    expect(t.type === 'tool' && t.executionMode).toBe('replayed');
  });

  it('fork with an edited STYLE: prefix identical, ticket SIMULATED, divergent title', async () => {
    const rec = record();
    const { trace: original } = await runAgent({ agent: rec.agent, input: INPUT, mode: { kind: 'record' }, client: stubModel(), modelId: 'stub', ...META });
    const k = draftStep(original);
    expect(k).toBeGreaterThan(0);

    const fork = record();
    const { trace: forked } = await runAgent({
      agent: fork.agent,
      input: original.input,
      mode: { kind: 'fork', fromStep: k, mutation: { system: urgentPrompt() } },
      client: stubModel(),
      modelId: 'stub',
      source: original,
      ...META,
    });

    expect(comparePrefix(original, forked, k).identical).toBe(true);
    expect(fork.sink.list()).toHaveLength(0); // not re-filed
    const t = ticketStep(forked);
    expect(t.type === 'tool' && t.simulated).toBe(true);

    const origTitle = titleOf(ticketStep(original));
    const forkTitle = titleOf(t);
    expect(forkTitle).not.toBe(origTitle);
    expect(forkTitle).toContain('URGENT');
  });
});
