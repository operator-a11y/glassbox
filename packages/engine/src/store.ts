/**
 * On-disk trace store. Phase 0 uses plain JSON files (SQLite arrives in Phase 1).
 * Traces are written with sorted keys so a trace file is stable and diffable, and
 * are zod-validated on load — a corrupt or stale-schema trace fails loudly.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { toPrettyJson } from './json.ts';
import { traceSchema } from './trace.ts';
import type { Trace, TraceStatus } from './trace.ts';

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

/** Lightweight row for listing traces without loading every step. */
export interface TraceSummary {
  id: string;
  parentId: string | null;
  agent: string;
  model: string;
  createdAtIso: string;
  status: TraceStatus;
  steps: number;
}

export interface TraceStore {
  save(trace: Trace): void;
  get(id: string): Trace | null;
  /** All traces, newest first. */
  list(): TraceSummary[];
  /** Forks of a given trace, newest first. */
  listForks(parentId: string): TraceSummary[];
  close(): void;
}

export function traceSummary(trace: Trace): TraceSummary {
  return {
    id: trace.id,
    parentId: trace.parentId,
    agent: trace.config.agent,
    model: trace.config.model,
    createdAtIso: trace.createdAtIso,
    status: trace.status,
    steps: trace.steps.length,
  };
}

/** In-memory store — for tests and ephemeral runs. */
export function memoryTraceStore(): TraceStore {
  const byId = new Map<string, Trace>();
  const sorted = (filter: (t: Trace) => boolean): TraceSummary[] =>
    [...byId.values()]
      .filter(filter)
      .sort((a, b) => (a.createdAtIso < b.createdAtIso ? 1 : a.createdAtIso > b.createdAtIso ? -1 : 0))
      .map(traceSummary);
  return {
    save(trace) {
      byId.set(trace.id, traceSchema.parse(trace));
    },
    get(id) {
      return byId.get(id) ?? null;
    },
    list() {
      return sorted(() => true);
    },
    listForks(parentId) {
      return sorted((t) => t.parentId === parentId);
    },
    close() {
      byId.clear();
    },
  };
}
