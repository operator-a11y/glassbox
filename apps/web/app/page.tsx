'use client';

import { useEffect, useState } from 'react';
import { listAgents, listTraces, record, type TraceSummary } from '@/lib/api';

const SAMPLE_INPUT: Record<string, string> = {
  'research-emailer': JSON.stringify({ topic: 'vector databases', recipient: 'team@example.com' }, null, 2),
  'support-triage': JSON.stringify({ customer: 'c-42', ticket: 'login is broken, cannot access account' }, null, 2),
};

export default function Home() {
  const [agents, setAgents] = useState<string[]>([]);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [agent, setAgent] = useState<string>('');
  const [input, setInput] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setTraces(await listTraces());
  }

  useEffect(() => {
    listAgents()
      .then((a) => {
        setAgents(a);
        const first = a[0] ?? '';
        setAgent(first);
        setInput(SAMPLE_INPUT[first] ?? '{}');
      })
      .catch((e: unknown) => setError(String(e)));
    refresh().catch((e: unknown) => setError(String(e)));
  }, []);

  function onAgentChange(next: string) {
    setAgent(next);
    setInput(SAMPLE_INPUT[next] ?? '{}');
  }

  async function onRecord() {
    setBusy(true);
    setError(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input);
      } catch {
        throw new Error('input is not valid JSON');
      }
      const trace = await record(agent, parsed);
      await refresh();
      window.location.href = `/traces/${trace.id}`;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Record a run</h2>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="sm:w-56">
            <label className="mb-1 block text-xs text-zinc-500">agent</label>
            <select
              value={agent}
              onChange={(e) => onAgentChange(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            >
              {agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <button
              onClick={onRecord}
              disabled={busy || !agent}
              className="mt-3 w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? 'recording…' : 'Record'}
            </button>
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs text-zinc-500">input (JSON)</label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={6}
              spellCheck={false}
              className="mono w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            />
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Traces</h2>
        {traces.length === 0 ? (
          <p className="text-sm text-zinc-500">No traces yet. Record one above.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-2 font-medium">id</th>
                  <th className="px-4 py-2 font-medium">agent</th>
                  <th className="px-4 py-2 font-medium">steps</th>
                  <th className="px-4 py-2 font-medium">status</th>
                  <th className="px-4 py-2 font-medium">kind</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {traces.map((t) => (
                  <tr key={t.id} className="hover:bg-zinc-900/40">
                    <td className="px-4 py-2">
                      <a href={`/traces/${t.id}`} className="mono text-emerald-400 hover:underline">
                        {t.id.slice(0, 8)}
                      </a>
                    </td>
                    <td className="px-4 py-2">{t.agent}</td>
                    <td className="px-4 py-2 tabular-nums">{t.steps}</td>
                    <td className="px-4 py-2">{t.status}</td>
                    <td className="px-4 py-2">
                      {t.parentId ? (
                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-400">fork</span>
                      ) : (
                        <span className="text-xs text-zinc-600">root</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
