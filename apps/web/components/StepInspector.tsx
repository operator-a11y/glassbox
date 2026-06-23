import type { ReactNode } from 'react';
import type { Draw, Step } from '@/lib/api';
import { execClass } from '@/lib/format';
import { Badge } from './Badge';
import { Json } from './Json';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      {children}
    </div>
  );
}

export function StepInspector({ step, draws }: { step: Step; draws: Draw[] }) {
  const stepDraws = draws.filter((d) => d.stepIdx === step.idx);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="mono text-zinc-500">#{step.idx}</span>
        <span className="font-medium">{step.type === 'llm' ? 'LLM call' : `tool · ${step.toolName}`}</span>
        <span className={`text-xs ${execClass(step.executionMode)}`}>[{step.executionMode}]</span>
        {step.type === 'tool' && <Badge className="bg-zinc-700/40 text-zinc-300">{step.kind}</Badge>}
        {step.type === 'tool' && step.simulated && <Badge className="bg-sky-500/15 text-sky-300">SIMULATED</Badge>}
        <span className="ml-auto text-xs text-zinc-500">{step.latencyMs}ms</span>
      </div>

      {step.type === 'llm' ? (
        <>
          <Field label="system prompt">
            <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
              {step.input.system}
            </pre>
          </Field>
          <Field label="messages in">
            <Json value={step.input.messages} />
          </Field>
          <Field label="completion (served on replay)">
            <Json value={step.output.content} />
          </Field>
          <Field label="tokens">
            <span className="mono text-xs text-zinc-400">
              in {step.tokens.inputTokens} · out {step.tokens.outputTokens} · stop {step.output.stopReason}
            </span>
          </Field>
        </>
      ) : (
        <>
          <Field label="args">
            <Json value={step.input} />
          </Field>
          <Field label="result">
            <Json value={step.output} />
          </Field>
          <Field label="effect">
            <span className="mono text-xs text-zinc-400">
              wasRealEffect={String(step.wasRealEffect)} · simulated={String(step.simulated)}
            </span>
          </Field>
        </>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Field label="state before">
          <Json value={step.stateBefore} />
        </Field>
        <Field label="state after">
          <Json value={step.stateAfter} />
        </Field>
      </div>

      {stepDraws.length > 0 && (
        <Field label="nondeterminism (captured & served)">
          <Json value={stepDraws} />
        </Field>
      )}
    </div>
  );
}
