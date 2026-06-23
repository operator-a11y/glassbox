/**
 * The `glassbox` developer CLI entrypoint.
 *
 * It registers BOTH demo agents over a single SQLite trace store and hands them to
 * the engine's generic `runCli`. The second agent (support-triage) required zero
 * engine or CLI changes — it is just another registration. That is the Phase-1
 * exit criterion in one file.
 *
 *   pnpm glassbox record --agent research-emailer --input '{"topic":"x","recipient":"y@z.com"}'
 *   pnpm glassbox record --agent support-triage   --input '{"customer":"c-42","ticket":"login is broken"}'
 *   pnpm glassbox list
 *   pnpm glassbox steps  --trace <id>
 *   pnpm glassbox replay --trace <id>
 *   pnpm glassbox fork   --trace <id> --step <n> --system "<edited prompt>"
 */

import './suppress-experimental-warning.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, sqliteTraceStore } from '@glassbox/engine';
import { registration as researchEmailer } from '@glassbox/example-research-emailer';
import { registration as supportTriage } from '@glassbox/example-support-triage';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(HERE, '.glassbox', 'traces.db');

await runCli({
  agents: {
    'research-emailer': researchEmailer(),
    'support-triage': supportTriage(),
  },
  store: sqliteTraceStore(DB_PATH),
});
