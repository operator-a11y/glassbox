/**
 * The side-effect sink for the email tool, injected rather than hard-coded.
 *
 * In `record` mode the CLI wires the real file sink → the email is appended to
 * outbox.json exactly once. In `replay`/`fork` the CLI wires an in-memory sink,
 * and the engine never executes the side-effecting tool anyway — so outbox.json
 * is only ever written during record. Two independent guarantees, by design.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JsonObject } from '@glassbox/engine';

export interface OutboxSink {
  readonly label: string;
  append(entry: JsonObject): void;
  list(): JsonObject[];
}

export function fileOutboxSink(path: string): OutboxSink {
  return {
    label: `file:${path}`,
    append(entry) {
      const current = readOutbox(path);
      current.push(entry);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(current, null, 2) + '\n', 'utf8');
    },
    list() {
      return readOutbox(path);
    },
  };
}

export function memoryOutboxSink(): OutboxSink {
  const entries: JsonObject[] = [];
  return {
    label: 'memory',
    append(entry) {
      entries.push(entry);
    },
    list() {
      return entries.slice();
    },
  };
}

export function readOutbox(path: string): JsonObject[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as JsonObject[]) : [];
}
