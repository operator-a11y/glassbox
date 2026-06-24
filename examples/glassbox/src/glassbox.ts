/**
 * The `glassbox` developer CLI entrypoint — every view over the record-replay-fork
 * engine, wired to both demo agents over one SQLite store.
 *
 *   record / list / steps / replay / fork   (the engine's generic CLI)
 *   scan    --trace <id>                     firewall audit (secrets / injection / taint)
 *   regress --trace <golden> [--system "…"]  re-run with a config variation, diff vs golden (gate)
 *   eval    --agent <name>                   run the agent's eval suite (assertions + scoring)
 */

import './suppress-experimental-warning.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, runCli, sqliteTraceStore } from '@glassbox/engine';
import type { AgentDefinition, AgentRegistration, ModelClient, TraceStore } from '@glassbox/engine';
import { scanTrace } from '@glassbox/firewall';
import { compareRuns, finalContains, runEvals, statusIs, stepCountIs, toolCalled, type Assertion, type EvalCase } from '@glassbox/evals';
import { investigate, runProbes, watchToolCalls, assertSideEffectsTracked, assertArgsUnder } from '@glassbox/probes';
import * as RE from '@glassbox/example-research-emailer';
import * as ST from '@glassbox/example-support-triage';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(HERE, '.glassbox', 'traces.db');

const registry: Record<string, AgentRegistration> = {
  'research-emailer': RE.registration(),
  'support-triage': ST.registration(),
};

// A custom assertion that ties evals to the firewall.
const firewallNoCritical: Assertion = (t) => {
  const findings = scanTrace(t);
  return { name: 'no critical firewall findings', pass: !findings.some((f) => f.severity === 'critical'), detail: `${findings.length} findings` };
};
const firewallFlagsCritical: Assertion = (t) => {
  const findings = scanTrace(t);
  return { name: 'firewall flags a critical exfiltration', pass: findings.some((f) => f.severity === 'critical'), detail: `${findings.length} findings` };
};

// Eval agents use throwaway (in-memory) sinks so scoring never performs real side effects.
const evalSuites: Record<string, { build: () => AgentDefinition; client: () => Promise<{ client: ModelClient; modelId: string }>; cases: EvalCase[] }> = {
  'research-emailer': {
    build: () => RE.buildAgent(RE.memoryOutboxSink()),
    client: () => RE.registration().client(),
    cases: [
      {
        name: 'researches a topic and emails a summary',
        input: { topic: 'vector databases', recipient: 'team@example.com' },
        assertions: [toolCalled('search'), toolCalled('read'), toolCalled('send_email'), statusIs('completed'), stepCountIs(7), finalContains('Done'), firewallNoCritical],
      },
    ],
  },
  'support-triage': {
    build: () => ST.buildAgent(ST.memoryTicketSink()),
    client: () => ST.registration().client(),
    cases: [
      {
        name: 'classifies and files a ticket',
        input: { customer: 'c-42', ticket: 'login is broken, cannot access account' },
        assertions: [toolCalled('classify'), toolCalled('lookup_customer'), toolCalled('create_ticket'), statusIs('completed'), stepCountIs(7), firewallNoCritical],
      },
      {
        name: 'firewall catches a leaked key flowing into the filed ticket',
        input: { customer: 'c-1', ticket: 'my key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked, urgent' },
        assertions: [firewallFlagsCritical],
      },
    ],
  },
};

const argv = process.argv.slice(2);
const store = sqliteTraceStore(DB_PATH);
try {
  const cmd = argv[0];
  if (cmd === 'scan') cmdScan(argv.slice(1), store);
  else if (cmd === 'regress') await cmdRegress(argv.slice(1), store);
  else if (cmd === 'eval') await cmdEval(argv.slice(1));
  else if (cmd === 'investigate') await cmdInvestigate(argv.slice(1), store);
  else if (cmd === 'probe') cmdProbe(argv.slice(1), store);
  else await runCli({ agents: registry, store });
} finally {
  store.close();
}

function flagVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function cmdScan(args: string[], store: TraceStore): void {
  const id = flagVal(args, '--trace');
  if (!id) return usageErr('glassbox scan --trace <id>');
  const trace = store.get(id);
  if (!trace) return notFound(id);
  const findings = scanTrace(trace);
  if (findings.length === 0) {
    console.log(`scan ${id}: no findings ✓`);
    return;
  }
  console.log(`scan ${id}: ${findings.length} finding(s)`);
  for (const f of findings) {
    console.log(`  [${f.severity.toUpperCase().padEnd(8)}] ${f.kind.padEnd(9)} ${f.message}`);
    console.log(`              ${f.location.pointer}   ${f.match}`);
  }
}

async function cmdRegress(args: string[], store: TraceStore): Promise<void> {
  const id = flagVal(args, '--trace');
  const system = flagVal(args, '--system');
  if (!id) return usageErr('glassbox regress --trace <golden-id> [--system "<new prompt>"]');
  const golden = store.get(id);
  if (!golden) return notFound(id);
  const reg = registry[golden.config.agent];
  if (!reg) return usageErr(`agent "${golden.config.agent}" is not registered`);

  const sel = await reg.client();
  const { trace: candidate } = await runAgent({
    agent: reg.build(),
    input: golden.input,
    mode: { kind: 'fork', fromStep: 0, mutation: { system: system ?? null } },
    client: sel.client,
    modelId: sel.modelId,
    source: golden,
  });
  store.save(candidate);

  const diff = compareRuns(golden, candidate);
  console.log(`regress ${id} → ${candidate.id}   (${system ? 'edited system prompt' : 're-run, same config'})`);
  console.log(`  ${diff.summary}`);
  for (const c of diff.changes) {
    const mark = c.kind === 'changed' ? '≠' : c.kind === 'added' ? '+' : '-';
    console.log(`  ${mark} #${c.idx}  ${c.summary}`);
  }
  console.log(diff.identical ? '  PASS — no behavioral regression' : '  FAIL — behavior changed (gate)');
  process.exitCode = diff.identical ? 0 : 1;
}

async function cmdEval(args: string[]): Promise<void> {
  const name = flagVal(args, '--agent');
  const suite = name ? evalSuites[name] : undefined;
  if (!name || !suite) return usageErr(`glassbox eval --agent <${Object.keys(evalSuites).join('|')}>`);

  const sel = await suite.client();
  const report = await runEvals({ agent: suite.build(), client: sel.client, modelId: sel.modelId, cases: suite.cases });
  console.log(`eval ${name}: ${report.passed}/${report.results.length} cases passed`);
  for (const r of report.results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}`);
    for (const c of r.checks) {
      if (!c.pass) console.log(`      ✗ ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
    }
  }
  process.exitCode = report.ok ? 0 : 1;
}

async function cmdInvestigate(args: string[], store: TraceStore): Promise<void> {
  const id = flagVal(args, '--trace');
  const system = flagVal(args, '--system');
  const stepArg = flagVal(args, '--step');
  if (!id) return usageErr('glassbox investigate --trace <id> [--step N] [--system "<counterfactual prompt>"]');
  const original = store.get(id);
  if (!original) return notFound(id);
  const reg = registry[original.config.agent];
  if (!reg) return usageErr(`agent "${original.config.agent}" is not registered`);

  const fromStep = stepArg != null ? Number.parseInt(stepArg, 10) : 0;
  if (!Number.isInteger(fromStep) || fromStep < 0 || fromStep > original.steps.length - 1) {
    return usageErr(`--step must be an integer in [0, ${original.steps.length - 1}]`);
  }
  const sel = await reg.client();
  const { investigation: inv, fork } = await investigate({
    original,
    fromStep,
    mutation: { system: system ?? null },
    agent: reg.build(),
    client: sel.client,
    modelId: sel.modelId,
  });
  store.save(fork);

  console.log(`investigate ${id} → ${fork.id}   (fork at step #${fromStep}${system ? ', edited prompt' : ''})`);
  console.log(`  behavior: ${inv.diff.summary}`);
  for (const f of inv.resolved) console.log(`  ✓ resolved:   [${f.severity}] ${f.message}`);
  for (const sc of inv.severityChanges) console.log(`  ⤓ downgraded: ${sc.before.message}  (${sc.before.severity} → ${sc.after.severity})`);
  for (const f of inv.introduced) console.log(`  ⚠ introduced: [${f.severity}] ${f.message}`);
  if (!inv.resolved.length && !inv.severityChanges.length && !inv.introduced.length) console.log('  firewall findings: unchanged');
  // Gate: a counterfactual that INTRODUCES a critical/high risk fails.
  process.exitCode = inv.introduced.some((f) => f.severity === 'critical' || f.severity === 'high') ? 1 : 0;
}

function cmdProbe(args: string[], store: TraceStore): void {
  const id = flagVal(args, '--trace');
  if (!id) return usageErr('glassbox probe --trace <id>');
  const trace = store.get(id);
  if (!trace) return notFound(id);
  const report = runProbes(trace, [watchToolCalls(), assertSideEffectsTracked(), assertArgsUnder(50_000)]);
  console.log(`probe ${id}: ${report.assertionsPassed} passed, ${report.assertionsFailed} failed`);
  for (const h of report.hits) {
    const mark = h.mode === 'assert' ? (h.ok ? '✓' : '✗') : '·';
    console.log(`  ${mark} #${h.stepIdx} ${h.probe}   ${h.note}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

function usageErr(msg: string): void {
  console.error(`usage: ${msg}`);
  process.exitCode = 1;
}
function notFound(id: string): void {
  console.error(`error: no trace ${id} in store`);
  process.exitCode = 1;
}
