/**
 * The `glassbox` developer CLI entrypoint.
 *
 * It registers BOTH demo agents over a single SQLite trace store and hands them to
 * the engine's generic `runCli`. The second agent (support-triage) required zero
 * engine or CLI changes — it is just another registration.
 *
 *   pnpm glassbox record --agent research-emailer --input '{"topic":"x","recipient":"y@z.com"}'
 *   pnpm glassbox record --agent support-triage   --input '{"customer":"c-42","ticket":"login is broken"}'
 *   pnpm glassbox list
 *   pnpm glassbox steps  --trace <id>
 *   pnpm glassbox replay --trace <id>
 *   pnpm glassbox fork   --trace <id> --step <n> --system "<edited prompt>"
 *   pnpm glassbox scan   --trace <id>      # firewall audit: secrets / injection / taint
 */

import './suppress-experimental-warning.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, sqliteTraceStore } from '@glassbox/engine';
import type { TraceStore } from '@glassbox/engine';
import { scanTrace } from '@glassbox/firewall';
import { registration as researchEmailer } from '@glassbox/example-research-emailer';
import { registration as supportTriage } from '@glassbox/example-support-triage';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(HERE, '.glassbox', 'traces.db');

const argv = process.argv.slice(2);
const store = sqliteTraceStore(DB_PATH);
try {
  if (argv[0] === 'scan') {
    cmdScan(argv.slice(1), store);
  } else {
    await runCli({
      agents: {
        'research-emailer': researchEmailer(),
        'support-triage': supportTriage(),
      },
      store,
    });
  }
} finally {
  store.close();
}

function cmdScan(args: string[], store: TraceStore): void {
  const i = args.indexOf('--trace');
  const id = i >= 0 ? args[i + 1] : undefined;
  if (!id) {
    console.error('usage: glassbox scan --trace <id>');
    process.exitCode = 1;
    return;
  }
  const trace = store.get(id);
  if (!trace) {
    console.error(`error: no trace ${id} in store`);
    process.exitCode = 1;
    return;
  }
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
