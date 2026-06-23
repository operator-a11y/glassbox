/**
 * `glassbox dev` — run the daemon and the web app together.
 *
 *   pnpm dev      # daemon on :4319, web on http://localhost:3000
 *
 * Each child is launched as its own process group (detached) so shutdown kills the
 * whole tree (including next-server workers) instead of orphaning them.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let shuttingDown = false;
let exitCode = 0;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (c.pid) {
      try {
        process.kill(-c.pid, 'SIGTERM'); // negative pid → kill the whole process group
      } catch {
        /* already gone */
      }
    }
  }
  process.exit(exitCode);
}

function run(label: string, args: string[]): ChildProcess {
  const child = spawn('pnpm', args, { cwd: ROOT, stdio: 'inherit', detached: true });
  child.on('error', (err) => console.error(`[${label}] ${err.message}`));
  // If either child dies, tear the other down — but surface WHICH died and with
  // what status, and propagate a non-zero exit so a crash isn't masked as success.
  child.on('exit', (code, signal) => {
    if (!shuttingDown) console.error(`[${label}] exited (code=${code ?? 'null'} signal=${signal ?? 'null'}) — stopping`);
    if (exitCode === 0) exitCode = signal ? 1 : (code ?? 0);
    shutdown();
  });
  return child;
}

const children: ChildProcess[] = [
  run('daemon', ['exec', 'tsx', 'examples/glassbox/src/daemon.ts']),
  run('web', ['--filter', '@glassbox/web', 'dev']),
];

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('glassbox dev → daemon :4319 + web http://localhost:3000  (Ctrl-C to stop)');
