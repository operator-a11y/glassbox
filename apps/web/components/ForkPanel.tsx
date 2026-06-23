'use client';

import { useState } from 'react';
import type { Trace } from '@/lib/api';
import { fork } from '@/lib/api';
import { stepDiverged, stepSummary } from '@/lib/format';

export function ForkPanel({ trace, atStep }: { trace: Trace; atStep: number }) {
  const [system, setSystem] = useState(trace.config.systemPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ forked: Trace; prefixIdentical: boolean } | null>(null);

  async function onFork() {
    setBusy(true);
    setError(null);
    try {
      const r = await fork(trace.id, { fromStep: atStep, system });
      setResult({ forked: r.trace, prefixIdentical: r.prefixIdentical });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-400">Fork from</span>
        <span className="mono rounded bg-zinc-800 px-1.5 py-0.5 text-xs">step #{atStep}</span>
        <span className="text-zinc-500">— edit the system prompt, then replay forward live from here.</span>
      </div>
      <textarea
        value={system}
        onChange={(e) => setSystem(e.target.value)}
        rows={6}
        spellCheck={false}
        className="mono w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs"
      />
      <button
        onClick={onFork}
        disabled={busy}
        className="rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
      >
        {busy ? 'forking…' : `Fork at step ${atStep}`}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {result && (
        <ForkDiff original={trace} forked={result.forked} forkStep={atStep} prefixIdentical={result.prefixIdentical} />
      )}
    </div>
  );
}

function ForkDiff({
  original,
  forked,
  forkStep,
  prefixIdentical,
}: {
  original: Trace;
  forked: Trace;
  forkStep: number;
  prefixIdentical: boolean;
}) {
  const n = Math.max(original.steps.length, forked.steps.length);
  const rows = Array.from({ length: n }, (_, i) => i);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={prefixIdentical ? 'text-emerald-400' : 'text-red-400'}>
          {prefixIdentical ? `✓ pre-fork steps 0..${forkStep - 1} identical` : '✗ pre-fork changed — this is a bug'}
        </span>
        <a href={`/traces/${forked.id}`} className="ml-auto text-emerald-400 hover:underline">
          open fork {forked.id.slice(0, 8)} →
        </a>
      </div>
      <div className="grid grid-cols-2 gap-2 px-2 text-[10px] uppercase tracking-wide text-zinc-500">
        <span>original</span>
        <span>forked</span>
      </div>
      <div className="overflow-hidden rounded-md border border-zinc-800">
        {rows.map((i) => {
          const o = original.steps[i];
          const f = forked.steps[i];
          const diverged = stepDiverged(o, f);
          const isFork = i === forkStep;
          const fSim = f && f.type === 'tool' && f.simulated;
          return (
            <div
              key={i}
              className={`grid grid-cols-[1.25rem_1fr_1fr] items-center gap-2 px-2 py-1 text-xs ${
                isFork ? 'bg-amber-500/10' : diverged ? 'bg-red-500/5' : ''
              }`}
            >
              <span className="mono text-center text-zinc-500">{isFork ? '▶' : diverged ? '≠' : ''}</span>
              <span className="mono truncate text-zinc-400">{o ? `#${o.idx} ${o.type} ${stepSummary(o)}` : '—'}</span>
              <span className="mono truncate text-zinc-200">
                {f ? `#${f.idx} ${f.type} ${stepSummary(f)}` : '—'}
                {fSim ? ' · SIMULATED' : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
