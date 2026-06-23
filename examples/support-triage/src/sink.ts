/**
 * The side-effect sink for create_ticket, injected (not hard-coded). Real file
 * sink at record time; the engine never executes the side-effecting tool on
 * replay/fork, so tickets.json is only ever written during record.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JsonObject } from '@glassbox/engine';

export interface TicketSink {
  readonly label: string;
  append(entry: JsonObject): void;
  list(): JsonObject[];
}

export function fileTicketSink(path: string): TicketSink {
  return {
    label: `file:${path}`,
    append(entry) {
      const current = readTickets(path);
      current.push(entry);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(current, null, 2) + '\n', 'utf8');
    },
    list() {
      return readTickets(path);
    },
  };
}

export function memoryTicketSink(): TicketSink {
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

export function readTickets(path: string): JsonObject[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as JsonObject[]) : [];
}
