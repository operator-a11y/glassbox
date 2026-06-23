/**
 * On-disk trace store. Phase 0 uses plain JSON files (SQLite arrives in Phase 1).
 * Traces are written with sorted keys so a trace file is stable and diffable, and
 * are zod-validated on load — a corrupt or stale-schema trace fails loudly.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { toPrettyJson } from './json.ts';
import { traceSchema } from './trace.ts';
import type { Trace } from './trace.ts';

export function saveTrace(path: string, trace: Trace): void {
  // Validate before persisting — never write an invalid trace.
  const valid = traceSchema.parse(trace);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toPrettyJson(valid), 'utf8');
}

export function loadTrace(path: string): Trace {
  const raw = readFileSync(path, 'utf8');
  return traceSchema.parse(JSON.parse(raw));
}
