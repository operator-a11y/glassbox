'use client';

import { useEffect, useState } from 'react';
import { scan, type FirewallFinding } from '@/lib/api';

const SEV: Record<string, string> = {
  critical: 'border-red-500/40 bg-red-500/10 text-red-200',
  high: 'border-orange-500/40 bg-orange-500/10 text-orange-200',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  low: 'border-zinc-700 bg-zinc-800/40 text-zinc-300',
};

export function FirewallPanel({ traceId, onSelectStep }: { traceId: string; onSelectStep?: (idx: number) => void }) {
  const [findings, setFindings] = useState<FirewallFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFindings(null);
    setError(null);
    scan(traceId)
      .then(setFindings)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [traceId]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!findings) return <p className="text-sm text-zinc-500">scanning…</p>;
  if (findings.length === 0) {
    return <p className="text-sm text-emerald-400">✓ no secrets, prompt-injection, or taint flows detected</p>;
  }

  return (
    <ul className="space-y-2">
      {findings.map((f, i) => (
        <li key={i} className={`rounded-md border px-3 py-2 text-sm ${SEV[f.severity] ?? SEV['low']}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase">{f.severity}</span>
            <span className="text-[10px] uppercase opacity-70">{f.kind}</span>
            {f.location.stepIdx != null && onSelectStep && (
              <button onClick={() => onSelectStep(f.location.stepIdx!)} className="text-[11px] underline opacity-80">
                step #{f.location.stepIdx}
              </button>
            )}
            <span className="mono ml-auto text-[11px] opacity-60">{f.location.pointer}</span>
          </div>
          <div className="mt-1">{f.message}</div>
          <div className="mono mt-1 text-[11px] opacity-70">
            {f.match}
            {f.also && f.also.length > 0 ? ` · also: ${f.also.join(', ')}` : ''}
          </div>
        </li>
      ))}
    </ul>
  );
}
