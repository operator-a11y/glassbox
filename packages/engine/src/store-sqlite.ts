/**
 * SQLite-backed TraceStore using Node's built-in `node:sqlite` (zero extra deps).
 *
 * The full trace is stored as validated JSON in one column; the columns we query
 * on (id, parent_id, agent, status, created_at) are denormalized for listing.
 * Loads are re-validated through the zod schema, so a stale-schema or corrupt row
 * fails loudly rather than flowing bad data into replay/fork.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { traceSchema } from './trace.ts';
import type { Trace } from './trace.ts';
import type { TraceStore, TraceSummary } from './store.ts';

interface SummaryRow {
  id: string;
  parent_id: string | null;
  agent: string;
  model: string;
  created_at: string;
  status: string;
  steps: number;
}

const SUMMARY_COLS = 'id, parent_id, agent, model, created_at, status, steps';

export function sqliteTraceStore(path: string): TraceStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      id         TEXT PRIMARY KEY,
      parent_id  TEXT,
      agent      TEXT NOT NULL,
      model      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status     TEXT NOT NULL,
      steps      INTEGER NOT NULL,
      json       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_traces_parent  ON traces(parent_id);
    CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at);
  `);

  const upsert = db.prepare(`
    INSERT INTO traces (id, parent_id, agent, model, created_at, status, steps, json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      parent_id = excluded.parent_id, agent = excluded.agent, model = excluded.model,
      created_at = excluded.created_at, status = excluded.status, steps = excluded.steps,
      json = excluded.json
  `);
  const selectJson = db.prepare('SELECT json FROM traces WHERE id = ?');
  // rowid DESC is the stable tie-break so same-millisecond traces stay newest-first.
  const selectAll = db.prepare(`SELECT ${SUMMARY_COLS} FROM traces ORDER BY created_at DESC, rowid DESC`);
  const selectForks = db.prepare(`SELECT ${SUMMARY_COLS} FROM traces WHERE parent_id = ? ORDER BY created_at DESC, rowid DESC`);

  const toSummary = (r: SummaryRow): TraceSummary => ({
    id: r.id,
    parentId: r.parent_id,
    agent: r.agent,
    model: r.model,
    createdAtIso: r.created_at,
    status: traceSchema.shape.status.parse(r.status),
    steps: r.steps,
  });

  return {
    save(trace: Trace) {
      const valid = traceSchema.parse(trace);
      upsert.run(
        valid.id,
        valid.parentId,
        valid.config.agent,
        valid.config.model,
        valid.createdAtIso,
        valid.status,
        valid.steps.length,
        JSON.stringify(valid),
      );
    },
    get(id: string): Trace | null {
      const row = selectJson.get(id) as { json: string } | undefined;
      if (!row) return null;
      return traceSchema.parse(JSON.parse(row.json));
    },
    list(): TraceSummary[] {
      return (selectAll.all() as unknown as SummaryRow[]).map(toSummary);
    },
    listForks(parentId: string): TraceSummary[] {
      return (selectForks.all(parentId) as unknown as SummaryRow[]).map(toSummary);
    },
    close() {
      db.close();
    },
  };
}
