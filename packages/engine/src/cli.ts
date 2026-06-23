/**
 * The generic `glassbox` developer CLI — reusable across ANY registered agent.
 *
 *   record  --agent <name> [--input '<json>']
 *   list
 *   steps   --trace <id>
 *   replay  --trace <id>
 *   fork    --trace <id> [--step N] [--system "<prompt>"] [--live-tools a,b]
 *
 * `runCli` is agent-agnostic: it drives record/replay/fork over a TraceStore and an
 * agent registry, so a new agent works with zero CLI/engine changes — just register
 * its factory. Replay uses a throwing model client to prove the LLM is not re-called.
 */

import { runAgent } from './runner.ts';
import type { AgentDefinition } from './runner.ts';
import type { ModelClient } from './model.ts';
import type { TraceStore } from './store.ts';
import type { Step, Trace } from './trace.ts';
import { canonicalize } from './json.ts';
import type { JsonValue } from './json.ts';
import { assertPrefixIdentical, assertReplayIdentical, stepIdentity, summarizeStep } from './diff.ts';

export interface GlassboxCliConfig {
  /** Registry of agent factories, keyed by agent name (must equal AgentDefinition.name). */
  agents: Record<string, () => AgentDefinition>;
  store: TraceStore;
  /** Resolve the live model client (real when a key is set, else a stub). */
  selectClient: () => Promise<{ client: ModelClient; modelId: string; label?: string }>;
  argv?: string[];
  out?: (line: string) => void;
}

class CliError extends Error {}

const throwingClient: ModelClient = {
  async complete() {
    throw new Error('replay must not call the model — the recorded completion should be served instead');
  },
};

export async function runCli(config: GlassboxCliConfig): Promise<void> {
  const out = config.out ?? ((s: string) => console.log(s));
  const argv = config.argv ?? process.argv.slice(2);
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  try {
    switch (command) {
      case 'record':
        await cmdRecord(config, flags, out);
        break;
      case 'list':
        cmdList(config, out);
        break;
      case 'steps':
        cmdSteps(config, flags, out);
        break;
      case 'replay':
        await cmdReplay(config, flags, out);
        break;
      case 'fork':
        await cmdFork(config, flags, out);
        break;
      default:
        out('usage: glassbox <record|list|steps|replay|fork> [--agent N] [--input JSON] [--trace ID] [--step N] [--system "..."] [--live-tools a,b]');
        if (command) process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof CliError) {
      out(`error: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    config.store.close();
  }
}

async function cmdRecord(config: GlassboxCliConfig, flags: Flags, out: Out): Promise<void> {
  const name = req(flags, 'agent');
  const build = config.agents[name];
  if (!build) throw new CliError(`unknown agent "${name}" (registered: ${Object.keys(config.agents).join(', ')})`);
  const input = flags['input'] ? safeJson(flags['input']) : {};
  const { client, modelId, label } = await config.selectClient();

  const { trace } = await runAgent({ agent: build(), input, mode: { kind: 'record' }, client, modelId });
  config.store.save(trace);

  out(`recorded ${trace.id}`);
  out(`  agent ${name}   steps ${trace.steps.length}   status ${trace.status}   model ${label ?? modelId}`);
  printTimeline(trace, out);
}

function cmdList(config: GlassboxCliConfig, out: Out): void {
  const rows = config.store.list();
  if (!rows.length) {
    out('no traces yet — run `record --agent <name>`');
    return;
  }
  out(`${pad('id', 38)}${pad('agent', 18)}${pad('steps', 7)}${pad('status', 11)}parent`);
  for (const r of rows) {
    out(`${pad(r.id, 38)}${pad(r.agent, 18)}${pad(String(r.steps), 7)}${pad(r.status, 11)}${r.parentId ?? '-'}`);
  }
}

function cmdSteps(config: GlassboxCliConfig, flags: Flags, out: Out): void {
  const trace = loadOrThrow(config, req(flags, 'trace'));
  printTimeline(trace, out);
  out(`fork-point hint: --step ${defaultForkStep(trace)}`);
}

async function cmdReplay(config: GlassboxCliConfig, flags: Flags, out: Out): Promise<void> {
  const original = loadOrThrow(config, req(flags, 'trace'));
  const agent = rebuild(config, original);

  const { trace: replay } = await runAgent({
    agent,
    input: original.input,
    mode: { kind: 'replay' },
    client: throwingClient,
    modelId: original.config.model,
    source: original,
  });
  assertReplayIdentical(original, replay);

  out(`replay ${original.id}: bit-identical ✓   (LLM not re-called; side effects served/SIMULATED)`);
  for (const s of replay.steps) {
    if (s.type === 'tool' && s.kind === 'side_effecting') {
      out(`  ${s.toolName}: executionMode=${s.executionMode} simulated=${s.simulated} (never re-fired)`);
    }
  }
}

async function cmdFork(config: GlassboxCliConfig, flags: Flags, out: Out): Promise<void> {
  const original = loadOrThrow(config, req(flags, 'trace'));
  const step = flags['step'] != null ? Number.parseInt(flags['step'], 10) : defaultForkStep(original);
  if (!Number.isInteger(step) || step < 0 || step > original.steps.length - 1) {
    throw new CliError(`--step must be an integer in [0, ${original.steps.length - 1}]`);
  }
  const system = flags['system'] ?? null;
  const liveTools = flags['live-tools'] ? flags['live-tools'].split(',').map((s) => s.trim()) : undefined;
  const agent = rebuild(config, original);
  const { client, modelId } = await config.selectClient();

  const { trace: forked } = await runAgent({
    agent,
    input: original.input,
    mode: { kind: 'fork', fromStep: step, mutation: { system } },
    client,
    modelId,
    source: original,
    ...(liveTools ? { liveTools } : {}),
  });
  config.store.save(forked);
  assertPrefixIdentical(original, forked, step);

  out(`forked ${original.id} → ${forked.id}   at step #${step}`);
  out(system === null ? '  mutation: none (suffix re-runs live)' : '  mutation: system prompt edited');
  out(`  pre-fork steps 0..${step - 1}: identical ✓`);
  printForkDiff(original, forked, step, out);
}

// ---- helpers ----------------------------------------------------------------

type Flags = Record<string, string>;
type Out = (line: string) => void;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function req(flags: Flags, key: string): string {
  const v = flags[key];
  if (v === undefined) throw new CliError(`missing required flag --${key}`);
  return v;
}

function safeJson(s: string): JsonValue {
  try {
    return JSON.parse(s) as JsonValue;
  } catch {
    throw new CliError(`--input is not valid JSON: ${s}`);
  }
}

function loadOrThrow(config: GlassboxCliConfig, id: string): Trace {
  const t = config.store.get(id);
  if (!t) throw new CliError(`no trace ${id} in store`);
  return t;
}

function rebuild(config: GlassboxCliConfig, trace: Trace): AgentDefinition {
  const build = config.agents[trace.config.agent];
  if (!build) {
    throw new CliError(`trace's agent "${trace.config.agent}" is not registered (have: ${Object.keys(config.agents).join(', ')})`);
  }
  return build();
}

function defaultForkStep(trace: Trace): number {
  const sideEffect = trace.steps.findIndex((s) => s.type === 'tool' && s.kind === 'side_effecting');
  if (sideEffect > 0) return sideEffect - 1; // the llm that drafts the side-effecting call
  for (let i = trace.steps.length - 1; i >= 0; i--) if (trace.steps[i]!.type === 'llm') return i;
  return Math.max(0, trace.steps.length - 1);
}

function printTimeline(trace: Trace, out: Out): void {
  for (const s of trace.steps) out('  ' + summarizeStep(s));
}

function printForkDiff(original: Trace, forked: Trace, forkStep: number, out: Out): void {
  const n = Math.max(original.steps.length, forked.steps.length);
  for (let i = 0; i < n; i++) {
    const o = original.steps[i] as Step | undefined;
    const f = forked.steps[i] as Step | undefined;
    const diverged = o && f && canonicalize(stepIdentity(o)) !== canonicalize(stepIdentity(f));
    const marker = i === forkStep ? '▶' : diverged ? '≠' : ' ';
    out(`${marker} ${pad(o ? summarizeStep(o) : '—', 46)}  ${f ? summarizeStep(f) : '—'}`);
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length);
}
