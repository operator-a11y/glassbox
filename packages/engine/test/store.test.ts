import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { memoryTraceStore, sqliteTraceStore } from '../src/index.ts';
import type { Trace, TraceStore } from '../src/index.ts';

function fakeTrace(id: string, parentId: string | null, createdAtIso: string): Trace {
  return {
    schemaVersion: 1,
    id,
    parentId,
    fork: parentId ? { fromStep: 1, mutation: { system: 'edited' } } : null,
    createdAtIso,
    config: {
      agent: 'demo',
      model: 'stub',
      systemPrompt: 'S',
      systemPromptHash: 'abc',
      hashAlgo: 'sha256',
      toolset: [{ name: 't', kind: 'read_only' }],
      maxSteps: 32,
    },
    input: { q: 1 },
    steps: [
      {
        idx: 0,
        type: 'tool',
        toolName: 't',
        kind: 'read_only',
        input: { q: 1 },
        output: { ok: true },
        wasRealEffect: false,
        simulated: false,
        latencyMs: 1,
        stateBefore: {},
        stateAfter: { done: true },
        executionMode: 'recorded',
      },
    ],
    nondeterminism: [{ kind: 'uuid', value: 'u', stepIdx: 0 }],
    status: 'completed',
    cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    final: { ok: true },
  };
}

const stores: Array<{ label: string; make: () => TraceStore; cleanup?: () => void }> = [
  { label: 'memory', make: () => memoryTraceStore() },
  {
    label: 'sqlite',
    make: () => sqliteTraceStore(join(tmpdir(), `glassbox-test-${process.pid}-${Math.floor(performance.now())}.db`)),
  },
];

for (const variant of stores) {
  describe(`TraceStore (${variant.label})`, () => {
    let store: TraceStore;
    const dbFiles: string[] = [];

    afterEach(() => {
      store?.close();
      for (const f of dbFiles) {
        try {
          rmSync(f, { force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it('round-trips a trace and validates on load', () => {
      store = variant.make();
      const t = fakeTrace('a', null, '2020-01-01T00:00:00.000Z');
      store.save(t);
      const got = store.get('a');
      expect(got).not.toBeNull();
      expect(got!.id).toBe('a');
      expect(got!.steps[0]!.type).toBe('tool');
      expect(store.get('missing')).toBeNull();
    });

    it('lists newest-first and finds forks by parent', () => {
      store = variant.make();
      store.save(fakeTrace('a', null, '2020-01-01T00:00:00.000Z'));
      store.save(fakeTrace('b', 'a', '2020-01-02T00:00:00.000Z'));
      store.save(fakeTrace('c', 'a', '2020-01-03T00:00:00.000Z'));

      const list = store.list();
      expect(list.map((s) => s.id)).toEqual(['c', 'b', 'a']); // newest first
      expect(list[0]!.steps).toBe(1);

      const forks = store.listForks('a');
      expect(forks.map((s) => s.id)).toEqual(['c', 'b']);
    });

    it('save is an idempotent upsert (same id overwrites)', () => {
      store = variant.make();
      store.save(fakeTrace('a', null, '2020-01-01T00:00:00.000Z'));
      store.save(fakeTrace('a', null, '2020-01-09T00:00:00.000Z'));
      expect(store.list()).toHaveLength(1);
      expect(store.get('a')!.createdAtIso).toBe('2020-01-09T00:00:00.000Z');
    });
  });
}
