import type { Step } from '@/lib/api';
import { stepSummary } from '@/lib/format';
import { Badge } from './Badge';

export function Timeline({
  steps,
  selected,
  onSelect,
}: {
  steps: Step[];
  selected: number;
  onSelect: (idx: number) => void;
}) {
  return (
    <ol className="space-y-1">
      {steps.map((s) => {
        const sel = s.idx === selected;
        const simulated = s.type === 'tool' && s.simulated;
        const refire = s.type === 'tool' && s.kind === 'side_effecting' && s.executionMode === 'live';
        return (
          <li key={s.idx}>
            <button
              onClick={() => onSelect(s.idx)}
              className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                sel ? 'border-emerald-600 bg-emerald-600/10' : 'border-zinc-800 hover:bg-zinc-900/50'
              }`}
            >
              <span className="mono w-7 shrink-0 text-xs text-zinc-500">#{s.idx}</span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase ${
                  s.type === 'llm' ? 'bg-violet-500/15 text-violet-300' : 'bg-zinc-700/40 text-zinc-300'
                }`}
              >
                {s.type}
              </span>
              <span className="truncate text-zinc-200">{stepSummary(s)}</span>
              {simulated && <Badge className="ml-auto shrink-0 bg-sky-500/15 text-sky-300">SIMULATED</Badge>}
              {refire && <Badge className="ml-auto shrink-0 bg-red-500/15 text-red-300">LIVE-REFIRE</Badge>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
