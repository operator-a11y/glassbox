import { describe, it, expect } from 'vitest';
import {
  runAgent,
  assertReplayIdentical,
  comparePrefix,
  canonicalize,
} from '@glassbox/engine';
import type { ModelClient, Step, Trace } from '@glassbox/engine';
import { buildAgent, DEFAULT_SYSTEM_PROMPT } from '../src/agent.ts';
import { stubModel } from '../src/stub-model.ts';
import { memoryOutboxSink } from '../src/sink.ts';

const INPUT = { topic: 'cats', recipient: 'a@b.com' };
const META = { newId: () => 'fixed-id', nowIso: () => '2020-01-01T00:00:00.000Z' };

const throwingClient: ModelClient = {
  async complete() {
    throw new Error('LLM must not be called during replay');
  },
};

function record() {
  const sink = memoryOutboxSink();
  const agent = buildAgent(sink);
  return { sink, agent };
}

function emailStep(trace: Trace): Step {
  const s = trace.steps.find((x) => x.type === 'tool' && x.toolName === 'send_email');
  if (!s) throw new Error('no send_email step');
  return s;
}

function draftStep(trace: Trace): number {
  return trace.steps.findIndex((x) => x.type === 'tool' && x.toolName === 'send_email') - 1;
}

function enthusiasticPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT.replace(/TONE:\s*\w+/, 'TONE: enthusiastic');
}

describe('research-emailer: the four thesis properties', () => {
  it('record: runs 7 structured steps and sends exactly one real email', async () => {
    const { sink, agent } = record();
    const { trace } = await runAgent({ agent, input: INPUT, mode: { kind: 'record' }, client: stubModel(), modelId: 'stub', ...META });

    expect(trace.status).toBe('completed');
    expect(trace.steps.map((s) => s.type)).toEqual(['llm', 'tool', 'llm', 'tool', 'llm', 'tool', 'llm']);
    expect(sink.list()).toHaveLength(1); // real side effect fired once
    expect((sink.list()[0] as { status: string }).status).toBe('sent');
    const email = emailStep(trace);
    expect(email.type === 'tool' && email.executionMode).toBe('recorded');
    expect(email.type === 'tool' && email.wasRealEffect).toBe(true);
  });

  it('record: a topic containing double-quotes still emails the right recipient (parseTask regression)', async () => {
    const { agent } = record();
    const input = { topic: 'the "alignment" problem', recipient: 'team@x.com' };
    const { trace } = await runAgent({ agent, input, mode: { kind: 'record' }, client: stubModel(), modelId: 'stub', ...META });
    const email = emailStep(trace);
    expect((email.input as { to: string }).to).toBe('team@x.com');
    expect((email.input as { subject: string }).subject).toContain('alignment');
  });

  it('replay: bit-identical, LLM not re-called, side effect NOT re-fired', async () => {
    const rec = record();
    const { trace: original } = await runAgent({ agent: rec.agent, input: INPUT, mode: { kind: 'record' }, client: stubModel(), modelId: 'stub', ...META });

    const rep = record();
    const { trace: replayed } = await runAgent({
      agent: rep.agent,
      input: original.input,
      mode: { kind: 'replay' },
      client: throwingClient, // proves the LLM is never called
      modelId: original.config.model,
      source: original,
      ...META,
    });

    assertReplayIdentical(original, replayed); // throws if not bit-identical
    expect(rep.sink.list()).toHaveLength(0); // email tool never executed on replay
    const email = emailStep(replayed);
    expect(email.type === 'tool' && email.executionMode).toBe('replayed');
    expect(email.type === 'tool' && email.simulated).toBe(true);
    expect(email.type === 'tool' && email.wasRealEffect).toBe(true); // immutable recorded fact
  });

  it('fork at the draft step: prefix identical, email SIMULATED, continuation divergent', async () => {
    const rec = record();
    const { trace: original } = await runAgent({ agent: rec.agent, input: INPUT, mode: { kind: 'record' }, client: stubModel(), modelId: 'stub', ...META });
    const parentBefore = canonicalize(original);
    const k = draftStep(original);
    expect(k).toBeGreaterThan(0);

    const fork = record();
    const { trace: forked } = await runAgent({
      agent: fork.agent,
      input: original.input,
      mode: { kind: 'fork', fromStep: k, mutation: { system: enthusiasticPrompt() } },
      client: stubModel(),
      modelId: 'stub',
      source: original,
      ...META,
    });

    // (a) pre-fork steps untouched
    expect(comparePrefix(original, forked, k).identical).toBe(true);
    // (b) side effect not re-fired
    expect(fork.sink.list()).toHaveLength(0);
    const email = emailStep(forked);
    expect(email.type === 'tool' && email.executionMode).toBe('simulated');
    expect(email.type === 'tool' && email.simulated).toBe(true);
    expect(email.type === 'tool' && email.wasRealEffect).toBe(false);
    // (c) divergent-but-valid continuation: the email subject changed with the tone
    const origSubject = (emailStep(original).input as { subject: string }).subject;
    const forkSubject = (email.input as { subject: string }).subject;
    expect(origSubject).toContain('Summary:');
    expect(forkSubject).toContain('🎉');
    expect(forkSubject).not.toBe(origSubject);
    expect(forked.final).not.toEqual(original.final);
    // parent trace untouched by forking
    expect(canonicalize(original)).toBe(parentBefore);
  });

  it('fork at the email tool step: served email args, but the mutation takes effect at the next llm', async () => {
    const rec = record();
    const { trace: original } = await runAgent({ agent: rec.agent, input: INPUT, mode: { kind: 'record' }, client: stubModel(), modelId: 'stub', ...META });
    const emailIdx = original.steps.findIndex((s) => s.type === 'tool' && s.toolName === 'send_email');

    const fork = record();
    const { trace: forked } = await runAgent({
      agent: fork.agent,
      input: original.input,
      mode: { kind: 'fork', fromStep: emailIdx, mutation: { system: enthusiasticPrompt() } },
      client: stubModel(),
      modelId: 'stub',
      source: original,
      ...META,
    });

    // The email step is the fork point: simulated, never re-sent.
    expect(fork.sink.list()).toHaveLength(0);
    const email = emailStep(forked);
    expect(email.type === 'tool' && email.simulated).toBe(true);
    // Its args were drafted by the served step k-1, so the subject is unchanged...
    const forkSubject = (email.input as { subject: string }).subject;
    expect(forkSubject).toContain('Summary:'); // still neutral — drafted pre-fork
    // ...but the subsequent (live) confirmation llm reflects the mutated tone.
    expect(String(canonicalize(forked.final))).toContain('enthusiastic');
    expect(String(canonicalize(original.final))).toContain('neutral');
  });
});
