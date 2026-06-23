import { describe, it, expect } from 'vitest';
import { runAgent, assertReplayIdentical, comparePrefix } from '../src/index.ts';
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

// Regression coverage for the subtle nondeterminism-attribution edges: draws made
// after the last primitive, draws made inside a (served) tool body, draws made by
// agent code between steps, and the fork boundary that must preserve the state
// entering the fork point. These were originally found by the adversarial review.

const META = { newId: () => 'fixed-id', nowIso: () => '2020-01-01T00:00:00.000Z' };

function isObj(v: unknown): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function textModel(text = 'done'): ModelClient {
  return {
    async complete(_req: ModelClientRequest): Promise<ModelResponse> {
      return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
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

describe('determinism edges', () => {
  it('reproduces a trailing draw (made after the last primitive) bit-identically', async () => {
    const run: AgentFn = async (io) => {
      await io.model.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 10 });
      io.state['tail'] = io.ctx.uuid(); // trailing draw — stepIdx === number of primitives
      return io.state['tail'] as JsonValue;
    };
    const agent: AgentDefinition = { name: 'trail', systemPrompt: 'S', tools: [], run };
    const client = textModel();

    const rec = await runAgent({ agent, input: null, mode: { kind: 'record' }, client, modelId: 'stub', ...META });
    expect(rec.trace.nondeterminism).toHaveLength(1);
    expect(rec.trace.nondeterminism[0]!.stepIdx).toBe(1); // tagged past the last step (idx 0)

    const rep = await runAgent({ agent, input: null, mode: { kind: 'replay' }, client, modelId: 'stub', source: rec.trace, ...META });
    assertReplayIdentical(rec.trace, rep.trace);
  });

  it('reproduces interleaved internal (tool body) and leading (agent) draws bit-identically', async () => {
    const tools: ToolDefinition[] = [{ name: 't', kind: 'read_only', run: (_a, ctx) => ({ inner: ctx.uuid() }) }];
    const run: AgentFn = async (io) => {
      await io.model.complete({ messages: [{ role: 'user', content: 'a' }], tools: [], maxTokens: 10 }); // step 0
      await io.tools.run('t', {}); // step 1 — internal draw (stepIdx 1)
      io.state['lead'] = io.ctx.uuid(); // leading draw for step 2 (stepIdx 2)
      await io.model.complete({ messages: [{ role: 'user', content: 'b' }], tools: [], maxTokens: 10 }); // step 2
      return null;
    };
    const agent: AgentDefinition = { name: 'order', systemPrompt: 'S', tools, run };
    const client = textModel();

    const rec = await runAgent({ agent, input: null, mode: { kind: 'record' }, client, modelId: 'stub', ...META });
    expect(rec.trace.nondeterminism.map((d) => d.stepIdx)).toEqual([1, 2]);

    const rep = await runAgent({ agent, input: null, mode: { kind: 'replay' }, client, modelId: 'stub', source: rec.trace, ...META });
    assertReplayIdentical(rec.trace, rep.trace);
  });

  it('serves a side-effecting tool’s internal draw on replay (drain) without re-executing it', async () => {
    let realRuns = 0;
    const tools: ToolDefinition[] = [
      {
        name: 'commit',
        kind: 'side_effecting',
        run: (_a, ctx) => {
          realRuns++;
          return { id: ctx.uuid(), ok: true };
        },
        simulate: (_a, ctx) => ({ id: ctx.uuid(), ok: false }),
      },
    ];
    const run: AgentFn = async (io) => {
      await io.tools.run('commit', {});
      return null;
    };
    const agent: AgentDefinition = { name: 'se', systemPrompt: 'S', tools, run };
    const client = textModel();

    const rec = await runAgent({ agent, input: null, mode: { kind: 'record' }, client, modelId: 'stub', ...META });
    expect(realRuns).toBe(1);
    expect(rec.trace.nondeterminism).toHaveLength(1); // the tool's internal uuid

    const rep = await runAgent({ agent, input: null, mode: { kind: 'replay' }, client, modelId: 'stub', source: rec.trace, ...META });
    expect(realRuns).toBe(1); // not re-executed on replay
    assertReplayIdentical(rec.trace, rep.trace);
  });

  it('fork at a tool step preserves the inter-step draw made just before it (stateBefore[k] intact)', async () => {
    const tools: ToolDefinition[] = [
      { name: 'lookup', kind: 'read_only', run: (args, ctx) => ({ fact: 'f', innerId: ctx.uuid(), q: (args as { q: string }).q }) },
    ];
    const model: ModelClient = {
      async complete(req: ModelClientRequest): Promise<ModelResponse> {
        const turns = countToolUseTurns(req.messages);
        const usage = { inputTokens: req.messages.length, outputTokens: 3 };
        if (turns < 2) {
          return { content: [{ type: 'tool_use', id: `tu_${turns}`, name: 'lookup', input: { q: `t${turns}` } }], stopReason: 'tool_use', usage };
        }
        return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage };
      },
    };
    const run: AgentFn = async (io) => {
      const messages: JsonValue[] = [{ role: 'user', content: 'start' }];
      io.state['messages'] = messages;
      io.state['preIds'] = [];
      for (let i = 0; i < 10; i++) {
        const resp = await io.model.complete({ messages, tools: [], maxTokens: 100 });
        messages.push({ role: 'assistant', content: resp.content as unknown as JsonValue });
        const toolUses = resp.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
        if (toolUses.length === 0) {
          io.state['final'] = 'end';
          return 'end';
        }
        const results: JsonValue[] = [];
        for (const tu of toolUses) {
          (io.state['preIds'] as JsonValue[]).push(io.ctx.uuid()); // inter-step draw, just before the tool call
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: await io.tools.run(tu.name, tu.input) });
        }
        messages.push({ role: 'user', content: results });
      }
      return null;
    };
    const agent: AgentDefinition = { name: 'fork-boundary', systemPrompt: 'S', tools, run };

    const rec = await runAgent({ agent, input: {}, mode: { kind: 'record' }, client: model, modelId: 'stub', ...META });
    expect(rec.trace.steps.map((s) => s.type)).toEqual(['llm', 'tool', 'llm', 'tool', 'llm']);

    const k = 3; // fork at the SECOND tool step
    const forked = await runAgent({
      agent,
      input: {},
      mode: { kind: 'fork', fromStep: k, mutation: { system: null } },
      client: model,
      modelId: 'stub',
      source: rec.trace,
      ...META,
    });

    // comparePrefix now also asserts stateBefore[k] — the inter-step uuid drawn just
    // before the forked tool step is served, so the state entering the fork is intact.
    const cmp = comparePrefix(rec.trace, forked.trace, k);
    expect(cmp.differences).toEqual([]);
    expect(cmp.identical).toBe(true);
  });
});
