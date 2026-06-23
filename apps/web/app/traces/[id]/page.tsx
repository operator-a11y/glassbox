'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getTrace, replay, type ReplayResult, type Trace } from '@/lib/api';
import { Timeline } from '@/components/Timeline';
import { StepInspector } from '@/components/StepInspector';
import { ForkPanel } from '@/components/ForkPanel';

export default function TracePage() {
  const id = useParams<{ id: string }>().id;
  const [trace, setTrace] = useState<Trace | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [replaying, setReplaying] = useState(false);

  useEffect(() => {
    setTrace(null);
    setReplayResult(null);
    setSelected(0);
    getTrace(id)
      .then(setTrace)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  async function onReplay() {
    setReplaying(true);
    try {
      setReplayResult(await replay(id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReplaying(false);
    }
  }

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!trace) return <p className="text-sm text-zinc-500">loading…</p>;

  const step = trace.steps[selected] ?? trace.steps[0];

  return (
    <div className="space-y-6">
      <a href="/" className="text-sm text-zinc-500 hover:underline">
        ← all traces
      </a>

      <header className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-semibold">{trace.config.agent}</span>
          <span className="text-zinc-500">model {trace.config.model}</span>
          <span className="text-zinc-500">{trace.steps.length} steps</span>
          <span className="text-zinc-500">{trace.status}</span>
          <span className="mono text-xs text-zinc-600">{trace.id}</span>
          <button
            onClick={onReplay}
            disabled={replaying}
            className="ml-auto rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50"
          >
            {replaying ? 'replaying…' : 'Replay'}
          </button>
        </div>

        {trace.parentId && (
          <div className="mt-2 text-xs text-amber-400">
            forked from{' '}
            <a href={`/traces/${trace.parentId}`} className="underline">
              {trace.parentId.slice(0, 8)}
            </a>{' '}
            at step #{trace.fork?.fromStep}
            {trace.fork?.mutation.system != null ? ' · system prompt edited' : ''}
          </div>
        )}

        {replayResult && (
          <div className="mt-2 text-sm">
            {replayResult.identical ? (
              <span className="text-emerald-400">
                ✓ replay is bit-identical (LLM not re-called; side effects served / SIMULATED)
              </span>
            ) : (
              <span className="text-red-400">✗ replay diverged: {replayResult.differences.join('; ')}</span>
            )}
          </div>
        )}
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[20rem_1fr]">
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Timeline</h2>
          <Timeline steps={trace.steps} selected={step.idx} onSelect={setSelected} />
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <StepInspector step={step} draws={trace.nondeterminism} />
        </div>
      </div>

      <section className="rounded-lg border border-amber-900/40 bg-amber-950/10 p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">Fork &amp; replay</h2>
        <ForkPanel trace={trace} atStep={step.idx} />
      </section>
    </div>
  );
}
