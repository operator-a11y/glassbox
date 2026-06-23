/**
 * Glassbox Phase-0 harness for the research-emailer demo.
 *
 *   record  — run the agent live, write the trace, append the real email to outbox.json
 *   replay  — replay the trace; assert bit-identical; prove the LLM was NOT re-called and
 *             the email tool was served from the recording (SIMULATED), outbox unchanged
 *   fork    — fork at a step with an edited system prompt; show original vs forked, prove
 *             pre-fork steps are identical and the email step is SIMULATED, outbox unchanged
 *   steps   — list the recorded steps with fork-point hints
 *   demo    — record → replay → fork, end to end
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPrefixIdentical,
  assertReplayIdentical,
  canonicalize,
  loadTrace,
  runAgent,
  saveTrace,
  stepIdentity,
  summarizeStep,
} from '@glassbox/engine';
import type { JsonValue, ModelClient, Step, Trace } from '@glassbox/engine';
import { buildAgent, DEFAULT_SYSTEM_PROMPT } from './agent.ts';
import { selectModel } from './anthropic.ts';
import { fileOutboxSink, memoryOutboxSink, readOutbox } from './sink.ts';

const EXAMPLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GLASSBOX_DIR = join(EXAMPLE_DIR, '.glassbox');
const TRACE_PATH = join(GLASSBOX_DIR, 'trace.json');
const FORK_PATH = join(GLASSBOX_DIR, 'fork.json');
const OUTBOX_PATH = join(EXAMPLE_DIR, 'outbox.json');

const DEFAULT_TOPIC = 'transformer models';
const DEFAULT_RECIPIENT = 'team@example.com';

const throwingClient: ModelClient = {
  async complete() {
    throw new Error('replay must not call the model — the recorded completion should be served instead');
  },
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case 'record':
      await cmdRecord(flags);
      break;
    case 'replay':
      await cmdReplay();
      break;
    case 'fork':
      await cmdFork(flags);
      break;
    case 'steps':
      cmdSteps();
      break;
    case 'demo':
      await cmdDemo(flags);
      break;
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
}

// ---- record -----------------------------------------------------------------

async function cmdRecord(flags: Flags): Promise<Trace> {
  const topic = flags['topic'] ?? DEFAULT_TOPIC;
  const recipient = flags['recipient'] ?? DEFAULT_RECIPIENT;
  const { client, modelId, usingStub } = await selectModel();
  const sink = fileOutboxSink(OUTBOX_PATH);
  const agent = buildAgent(sink);

  const before = readOutbox(OUTBOX_PATH).length;
  const { trace } = await runAgent({ agent, input: { topic, recipient }, mode: { kind: 'record' }, client, modelId });
  saveTrace(TRACE_PATH, trace);
  const after = readOutbox(OUTBOX_PATH).length;

  header('RECORD');
  line(`model         ${usingStub ? 'stub (deterministic, offline)' : modelId}`);
  line(`topic         "${topic}"  →  ${recipient}`);
  line(`steps         ${trace.steps.length}   status: ${trace.status}`);
  line(`outbox.json   +${after - before} email (real side effect fired)`);
  line(`trace         ${rel(TRACE_PATH)}`);
  blank();
  printTimeline(trace);
  return trace;
}

// ---- replay -----------------------------------------------------------------

async function cmdReplay(): Promise<void> {
  const original = requireTrace();
  const sink = memoryOutboxSink();
  const agent = buildAgent(sink);

  const before = readOutbox(OUTBOX_PATH).length;
  // A throwing client proves the LLM is never called during replay.
  const { trace: replay } = await runAgent({
    agent,
    input: original.input,
    mode: { kind: 'replay' },
    client: throwingClient,
    modelId: original.config.model,
    source: original,
  });
  const after = readOutbox(OUTBOX_PATH).length;

  assertReplayIdentical(original, replay);
  const email = findStep(replay, 'send_email');

  header('REPLAY');
  line(`bit-identical   ✓  (every recorded value served back; LLM not re-called)`);
  line(`LLM calls       0  (used a client that throws if invoked)`);
  line(`outbox.json     unchanged (${before} → ${after} emails)`);
  if (email && email.type === 'tool') {
    line(`send_email      [${email.executionMode}] simulated=${email.simulated}  wasRealEffect=${email.wasRealEffect}`);
    line(`                → SIMULATED: served from the recording, never re-sent`);
  }
}

// ---- fork -------------------------------------------------------------------

async function cmdFork(flags: Flags): Promise<void> {
  const original = requireTrace();
  const step = flags['step'] != null ? Number.parseInt(flags['step'], 10) : defaultForkStep(original);
  if (!Number.isInteger(step) || step < 0 || step > original.steps.length - 1) {
    fail(`--step must be an integer in [0, ${original.steps.length - 1}]`);
  }
  const system = flags['system'] ?? mutatedPrompt('enthusiastic');
  const promptChanged = system !== original.config.systemPrompt;
  const { client, modelId, usingStub } = await selectModel();
  const sink = memoryOutboxSink();
  const agent = buildAgent(sink);

  const before = readOutbox(OUTBOX_PATH).length;
  const { trace: forked } = await runAgent({
    agent,
    input: original.input,
    mode: { kind: 'fork', fromStep: step, mutation: { system } },
    client,
    modelId,
    source: original,
  });
  saveTrace(FORK_PATH, forked);
  const after = readOutbox(OUTBOX_PATH).length;
  assertPrefixIdentical(original, forked, step);

  header('FORK');
  line(`fork at step    #${step}   (${describeStepType(original, step)})`);
  line(
    promptChanged
      ? `mutation        system prompt edited`
      : `mutation        none — system prompt unchanged (suffix re-runs live but won't diverge from the prompt)`,
  );
  line(`model (suffix)  ${usingStub ? 'stub (deterministic, offline)' : modelId}`);
  line(`pre-fork        ✓ identical to the original (steps 0..${step - 1} untouched)`);
  line(`outbox.json     unchanged (${before} → ${after} emails)`);
  blank();
  printForkDiff(original, forked, step);
  blank();
  printEmailDivergence(original, forked);
}

// ---- steps ------------------------------------------------------------------

function cmdSteps(): void {
  const trace = requireTrace();
  header('STEPS');
  printTimeline(trace);
  blank();
  line(`fork-point hint: ${defaultForkStep(trace)} (the LLM that drafts the email)`);
  line(`try:  pnpm fork --step ${defaultForkStep(trace)} --system "...TONE: enthusiastic"`);
}

// ---- demo -------------------------------------------------------------------

async function cmdDemo(flags: Flags): Promise<void> {
  await cmdRecord(flags);
  blank();
  await cmdReplay();
  blank();
  await cmdFork(flags);
  blank();
  header('THESIS');
  line('record → bit-identical replay → fork (edited prompt) → divergent continuation,');
  line('with the email SIMULATED on replay/fork and outbox.json written only at record. ✓');
}

// ---- helpers ----------------------------------------------------------------

type Flags = Record<string, string>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      // Every flag here takes a value; a valueless flag is treated as not-provided
      // (rather than the literal "true"), so `--system` with no value falls back to
      // the default instead of silently using "true" as the prompt.
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      }
    }
  }
  return flags;
}

function requireTrace(): Trace {
  try {
    return loadTrace(TRACE_PATH);
  } catch {
    fail(`no recorded trace at ${rel(TRACE_PATH)} — run \`pnpm record\` first`);
  }
}

function defaultForkStep(trace: Trace): number {
  const emailIdx = trace.steps.findIndex((s) => s.type === 'tool' && s.toolName === 'send_email');
  if (emailIdx > 0) return emailIdx - 1; // the llm step that drafts the email
  return Math.max(0, trace.steps.length - 1);
}

function describeStepType(trace: Trace, idx: number): string {
  const s = trace.steps[idx];
  if (!s) return 'unknown';
  return s.type === 'llm' ? 'llm — drafts the next action' : `tool ${s.toolName}`;
}

function mutatedPrompt(tone: string): string {
  return DEFAULT_SYSTEM_PROMPT.replace(/TONE:\s*\w+/, `TONE: ${tone}`);
}

function findStep(trace: Trace, toolName: string): Step | undefined {
  return trace.steps.find((s) => s.type === 'tool' && s.toolName === toolName);
}

function printTimeline(trace: Trace): void {
  for (const step of trace.steps) line('  ' + summarizeStep(step));
}

function printForkDiff(original: Trace, forked: Trace, forkStep: number): void {
  line('  original                                        forked');
  const n = Math.max(original.steps.length, forked.steps.length);
  for (let i = 0; i < n; i++) {
    const o = original.steps[i];
    const f = forked.steps[i];
    const diverged = o && f && canonicalize(stepIdentity(o)) !== canonicalize(stepIdentity(f));
    const marker = i === forkStep ? '▶' : diverged ? '≠' : ' ';
    line(`${marker} ${pad(o ? summarizeStep(o) : '—', 46)}  ${f ? summarizeStep(f) : '—'}`);
  }
}

function printEmailDivergence(original: Trace, forked: Trace): void {
  const o = findStep(original, 'send_email');
  const f = findStep(forked, 'send_email');
  line('EMAIL DIVERGENCE (the side-effecting step):');
  line(`  original (SENT)       ${emailLine(o)}`);
  line(`  forked   (SIMULATED)  ${emailLine(f)}`);
}

function emailLine(step: Step | undefined): string {
  if (!step || step.type !== 'tool') return '—';
  const input = step.input;
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const subject = input['subject'];
    return typeof subject === 'string' ? `"${subject}"` : canonicalize(input);
  }
  return canonicalize(input as JsonValue);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function rel(p: string): string {
  return p.startsWith(EXAMPLE_DIR) ? '.' + p.slice(EXAMPLE_DIR.length) : p;
}

function header(title: string): void {
  console.log(`\n=== ${title} ${'='.repeat(Math.max(0, 56 - title.length))}`);
}
function line(s: string): void {
  console.log(s);
}
function blank(): void {
  console.log('');
}
function usage(): void {
  console.log('usage: <record|replay|fork|steps|demo> [--topic T] [--recipient R] [--step N] [--system "..."]');
}
function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
