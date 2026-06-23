/**
 * The local glassbox daemon entrypoint — registers both demo agents over a SQLite
 * store and serves the REST API the web app consumes. Localhost only.
 *
 *   pnpm daemon            # → http://127.0.0.1:4319
 *   GLASSBOX_PORT=5000 pnpm daemon
 */

import './suppress-experimental-warning.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemon } from '@glassbox/daemon';
import { sqliteTraceStore } from '@glassbox/engine';
import { registration as researchEmailer } from '@glassbox/example-research-emailer';
import { registration as supportTriage } from '@glassbox/example-support-triage';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(HERE, '.glassbox', 'traces.db');
const PORT = Number(process.env['GLASSBOX_PORT'] ?? 4319);

const store = sqliteTraceStore(DB_PATH);
const daemon = createDaemon({
  agents: {
    'research-emailer': researchEmailer(),
    'support-triage': supportTriage(),
  },
  store,
});

let port: number;
try {
  port = await daemon.listen(PORT);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`glassbox daemon: port ${PORT} is already in use — set GLASSBOX_PORT to a free port.`);
    store.close();
    process.exit(1);
  }
  throw err;
}
console.log(`glassbox daemon → http://127.0.0.1:${port}  (db: ${DB_PATH})`);

const shutdown = (): void => {
  daemon.close().finally(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
