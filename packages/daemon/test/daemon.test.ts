import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { memoryTraceStore, toolLoopAgent } from '@glassbox/engine';
import type { AgentRegistration, ModelClient } from '@glassbox/engine';
import { createDaemon } from '../src/index.ts';

function stubClient(): ModelClient {
  return {
    async complete(req) {
      const tone = req.system.match(/TONE:\s*(\w+)/)?.[1] ?? 'plain';
      return { content: [{ type: 'text', text: `done ${tone}` }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

function tinyAgent(): AgentRegistration {
  return {
    build: () =>
      toolLoopAgent({
        name: 'tiny',
        systemPrompt: 'You are tiny. TONE: neutral',
        tools: [],
        toolSchemas: [],
        userMessage: () => 'go',
        finalize: (text) => ({ text }),
      }),
    client: async () => ({ client: stubClient(), modelId: 'stub', label: 'stub' }),
  };
}

const store = memoryTraceStore();
const daemon = createDaemon({ agents: { tiny: tinyAgent() }, store });
let base = '';

beforeAll(async () => {
  const port = await daemon.listen(0);
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await daemon.close();
  store.close();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

describe('daemon REST API', () => {
  it('health and agents', async () => {
    expect((await call('GET', '/api/health')).body.ok).toBe(true);
    expect((await call('GET', '/api/agents')).body.agents).toEqual(['tiny']);
  });

  it('record → list → get → replay → fork', async () => {
    const rec = await call('POST', '/api/record', { agent: 'tiny', input: {} });
    expect(rec.status).toBe(200);
    const id: string = rec.body.trace.id;
    expect(rec.body.trace.steps).toHaveLength(1);
    expect(rec.body.trace.final).toEqual({ text: 'done neutral' });

    const list = await call('GET', '/api/traces');
    expect(list.body.traces.map((t: { id: string }) => t.id)).toContain(id);

    const got = await call('GET', `/api/traces/${id}`);
    expect(got.body.trace.id).toBe(id);

    const rep = await call('POST', `/api/traces/${id}/replay`);
    expect(rep.body.identical).toBe(true);

    const fork = await call('POST', `/api/traces/${id}/fork`, { fromStep: 0, system: 'You are tiny. TONE: WILD' });
    expect(fork.body.prefixIdentical).toBe(true);
    expect(fork.body.trace.parentId).toBe(id);
    expect(fork.body.trace.final).toEqual({ text: 'done WILD' });

    const forks = await call('GET', `/api/traces/${id}/forks`);
    expect(forks.body.traces).toHaveLength(1);
  });

  it('errors: unknown agent → 400, missing trace → 404, bad route → 404', async () => {
    expect((await call('POST', '/api/record', { agent: 'nope' })).status).toBe(400);
    expect((await call('GET', '/api/traces/does-not-exist')).status).toBe(404);
    expect((await call('GET', '/api/nope')).status).toBe(404);
  });
});
