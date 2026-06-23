import { describe, it, expect } from 'vitest';
import {
  runAgent,
  assertReplayIdentical,
  comparePrefix,
  canonicalize,
} from '../src/index.ts';
import type {
  AgentDefinition,
  AgentFn,
  JsonValue,
  ModelClient,
  ModelClientRequest,
  ModelResponse,
  ToolDefinition,
  ToolUseBlock,
} from '../src/index.ts';

// ---- a minimal but realistic structured agent + deterministic stub model -----
//
// 5 primitive steps: llm(→lookup) · tool lookup(read_only) · llm(→commit) ·
// tool commit(side_effecting) · llm(→final). The stub is a prompt-conditioned
// planner: its output text varies with the system prompt's TONE directive, so a
// fork that mutates TONE produces a genuinely divergent continuation.

const TOOL_SCHEMA: JsonValue[] = [
  { name: 'lookup', description: 'look up a fact' },
  { name: 'commit', description: 'persist a value (side-effecting)' },
];

function isObj(v: unknown): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractTone(system: string): string {
  const m = system.match(/TONE:\s*(\w+)/);
  return m ? m[1]! : 'plain';
}

function countToolUseTurns(messages: JsonValue[]): number {
  let n = 0;
  for (const m of messages) {
    if (!isObj(m) || m['role'] !== 'assistant') continue;
    const content = m['content'];
    if (Array.isArray(content) && content.some((b) => isObj(b) && b['type'] === 'tool_use')) n++;
  }
  return n;
}

function lookupFact(messages: JsonValue[]): string {
  for (const m of messages) {
    if (!isObj(m)) continue;
    const content = m['content'];
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (isObj(c) && c['type'] === 'tool_result') {
        const inner = c['content'];
        if (isObj(inner) && typeof inner['fact'] === 'string') return inner['fact'];
      }
    }
  }
  return 'no-fact';
}

function scriptedModel(): ModelClient {
  return {
    async complete(req: ModelClientRequest): Promise<ModelResponse> {
      const tone = extractTone(req.system);
      const turns = countToolUseTurns(req.messages);
      const usage = { inputTokens: req.messages.length, outputTokens: 3 };
      if (turns === 0) {
        return {
          content: [{ type: 'tool_use', id: 'tu_0', name: 'lookup', input: { q: 'topic' } }],
          stopReason: 'tool_use',
          usage,
        };
      }
      if (turns === 1) {
        const fact = lookupFact(req.messages);
        return {
          content: [{ type: 'tool_use', id: 'tu_1', name: 'commit', input: { value: `${tone}:${fact}` } }],
          stopReason: 'tool_use',
          usage,
        };
      }
      return { content: [{ type: 'text', text: `done ${tone}` }], stopReason: 'end_turn', usage };
    },
  };
}

const agentRun: AgentFn = async (io) => {
  io.state['runId'] = io.ctx.uuid(); // agent-level nondeterminism, captured + served
  const messages: JsonValue[] = [{ role: 'user', content: `start ${(io.input as { q: string }).q}` }];
  io.state['messages'] = messages;
  io.state['turns'] = 0;

  for (let i = 0; i < 10; i++) {
    const resp = await io.model.complete({ messages, tools: TOOL_SCHEMA, maxTokens: 100 });
    messages.push({ role: 'assistant', content: resp.content as unknown as JsonValue });
    io.state['turns'] = (io.state['turns'] as number) + 1;

    const toolUses = resp.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      io.state['final'] = text;
      return text;
    }
    const results: JsonValue[] = [];
    for (const tu of toolUses) {
      const result = await io.tools.run(tu.name, tu.input);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    messages.push({ role: 'user', content: results });
  }
  return (io.state['final'] as JsonValue) ?? null;
};

function makeAgent(counter: { commits: number }): AgentDefinition {
  const tools: ToolDefinition[] = [
    {
      name: 'lookup',
      kind: 'read_only',
      run: (args) => ({ fact: `fact:${(args as { q: string }).q}` }),
    },
    {
      name: 'commit',
      kind: 'side_effecting',
      // The real side effect: bumps the counter. Only ever runs in record mode.
      run: (args, ctx) => {
        counter.commits++;
        return { id: ctx.uuid(), saved: (args as { value: string }).value, real: true };
      },
      // Pure synthesis for the fork suffix — performs no side effect.
      simulate: (args, ctx) => ({ id: ctx.uuid(), saved: (args as { value: string }).value, real: false }),
    },
  ];
  return { name: 'min-agent', systemPrompt: 'You are a writer. TONE: neutral', tools, run: agentRun };
}

const META = { newId: () => 'fixed-id', nowIso: () => '2020-01-01T00:00:00.000Z' };

describe('record → replay → fork', () => {
  it('replays bit-identically and never re-fires the side effect', async () => {
    const counter = { commits: 0 };
    const agent = makeAgent(counter);
    const client = scriptedModel();

    const rec = await runAgent({ agent, input: { q: 'cats' }, mode: { kind: 'record' }, client, modelId: 'stub', ...META });
    expect(counter.commits).toBe(1); // record fired the real side effect once
    expect(rec.trace.steps.map((s) => s.type)).toEqual(['llm', 'tool', 'llm', 'tool', 'llm']);
    expect(rec.trace.status).toBe('completed');
    expect(rec.trace.final).toBe('done neutral');

    const rep = await runAgent({ agent, input: { q: 'cats' }, mode: { kind: 'replay' }, client, modelId: 'stub', source: rec.trace, ...META });
    expect(counter.commits).toBe(1); // replay must NOT re-fire
    assertReplayIdentical(rec.trace, rep.trace);

    const commit = rep.trace.steps[3]!;
    expect(commit.type).toBe('tool');
    if (commit.type === 'tool') {
      expect(commit.simulated).toBe(true);
      expect(commit.executionMode).toBe('replayed');
      expect(commit.wasRealEffect).toBe(true); // immutable: it really fired at record time
    }
  });

  it('serves recorded nondeterminism back (runId is identical on replay)', async () => {
    const counter = { commits: 0 };
    const agent = makeAgent(counter);
    const client = scriptedModel();
    const rec = await runAgent({ agent, input: { q: 'x' }, mode: { kind: 'record' }, client, modelId: 'stub', ...META });
    const rep = await runAgent({ agent, input: { q: 'x' }, mode: { kind: 'replay' }, client, modelId: 'stub', source: rec.trace, ...META });
    const recRunId = (rec.trace.steps[0]!.stateAfter as { runId: string }).runId;
    const repRunId = (rep.trace.steps[0]!.stateAfter as { runId: string }).runId;
    expect(repRunId).toBe(recRunId);
    expect(rec.trace.nondeterminism[0]).toEqual(rep.trace.nondeterminism[0]);
  });

  it('forks at step 2 with a mutated prompt: prefix identical, suffix divergent, side effect simulated', async () => {
    const counter = { commits: 0 };
    const agent = makeAgent(counter);
    const client = scriptedModel();
    const rec = await runAgent({ agent, input: { q: 'cats' }, mode: { kind: 'record' }, client, modelId: 'stub', ...META });
    expect(counter.commits).toBe(1);

    const forked = await runAgent({
      agent,
      input: { q: 'cats' },
      mode: { kind: 'fork', fromStep: 2, mutation: { system: 'You are a writer. TONE: EXCITED' } },
      client,
      modelId: 'stub',
      source: rec.trace,
    });
    expect(counter.commits).toBe(1); // fork must NOT re-fire the real side effect

    // pre-fork untouched
    expect(comparePrefix(rec.trace, forked.trace, 2).identical).toBe(true);
    // suffix diverges at the first live step
    expect(canonicalize(rec.trace.steps[2])).not.toBe(canonicalize(forked.trace.steps[2]));

    const commit = forked.trace.steps[3]!;
    expect(commit.type).toBe('tool');
    if (commit.type === 'tool') {
      expect(commit.simulated).toBe(true);
      expect(commit.executionMode).toBe('simulated');
      expect(commit.wasRealEffect).toBe(false);
      expect((commit.input as { value: string }).value).toContain('EXCITED');
    }
    expect(forked.trace.final).toBe('done EXCITED');
    expect(forked.trace.config.systemPromptHash).not.toBe(rec.trace.config.systemPromptHash);
    expect(forked.trace.parentId).toBe(rec.trace.id);
  });

  it('forking twice never mutates the parent and reproduces the deterministic divergence', async () => {
    const counter = { commits: 0 };
    const agent = makeAgent(counter);
    const client = scriptedModel();
    const rec = await runAgent({ agent, input: { q: 'cats' }, mode: { kind: 'record' }, client, modelId: 'stub', ...META });
    const parentBefore = canonicalize(rec.trace);

    const mode = { kind: 'fork', fromStep: 2, mutation: { system: 'You are a writer. TONE: WILD' } } as const;
    const f1 = await runAgent({ agent, input: { q: 'cats' }, mode, client, modelId: 'stub', source: rec.trace, ...META });
    const f2 = await runAgent({ agent, input: { q: 'cats' }, mode, client, modelId: 'stub', source: rec.trace, ...META });

    // Parent trace is never mutated by forking (re-drive reads, never writes, the source).
    expect(canonicalize(rec.trace)).toBe(parentBefore);
    // The served prefix is identical across forks...
    expect(comparePrefix(f1.trace, f2.trace, 2).identical).toBe(true);
    // ...and the deterministic divergence content reproduces (the only thing that
    // legitimately differs run-to-run is genuinely-live nondeterminism in the suffix,
    // e.g. the simulated tool's freshly-drawn uuid).
    expect(f1.trace.final).toBe('done WILD');
    expect(f2.trace.final).toBe('done WILD');
    const v1 = (f1.trace.steps[3]! as unknown as { input: { value: string } }).input.value;
    const v2 = (f2.trace.steps[3]! as unknown as { input: { value: string } }).input.value;
    expect(v1).toBe(v2);
  });

  it('per-tool opt-in: a side-effecting tool can be forced to fire live in the fork suffix', async () => {
    const counter = { commits: 0 };
    const agent = makeAgent(counter);
    const client = scriptedModel();
    const rec = await runAgent({ agent, input: { q: 'cats' }, mode: { kind: 'record' }, client, modelId: 'stub', ...META });
    expect(counter.commits).toBe(1);

    // Default fork: the side effect is SIMULATED, never re-fired.
    const f1 = await runAgent({ agent, input: { q: 'cats' }, mode: { kind: 'fork', fromStep: 2, mutation: { system: 'You are a writer. TONE: A' } }, client, modelId: 'stub', source: rec.trace });
    expect(counter.commits).toBe(1);
    const s1 = f1.trace.steps[3]!;
    expect(s1.type === 'tool' && s1.executionMode).toBe('simulated');

    // Opted-in fork: the side effect FIRES for real and is flagged live.
    const f2 = await runAgent({
      agent,
      input: { q: 'cats' },
      mode: { kind: 'fork', fromStep: 2, mutation: { system: 'You are a writer. TONE: B' } },
      client,
      modelId: 'stub',
      source: rec.trace,
      liveTools: ['commit'],
    });
    expect(counter.commits).toBe(2); // real re-execution
    const s2 = f2.trace.steps[3]!;
    expect(s2.type === 'tool' && s2.executionMode).toBe('live');
    expect(s2.type === 'tool' && s2.wasRealEffect).toBe(true);
    expect(s2.type === 'tool' && s2.simulated).toBe(false);
  });

  it('enforces the maxSteps budget → truncated, side effect never reached', async () => {
    const counter = { commits: 0 };
    const agent = makeAgent(counter);
    const rec = await runAgent({ agent, input: { q: 'x' }, mode: { kind: 'record' }, client: scriptedModel(), modelId: 'stub', maxSteps: 2, ...META });
    expect(rec.trace.status).toBe('truncated');
    expect(rec.trace.steps.length).toBe(2);
    expect(counter.commits).toBe(0);
  });
});
