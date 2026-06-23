/**
 * Public surface of the support-triage example: a CLI `registration` for the
 * generic `glassbox` CLI, plus the pieces tests use.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRegistration } from '@glassbox/engine';
import { buildAgent } from './agent.ts';
import { selectModel } from './anthropic.ts';
import { fileTicketSink } from './sink.ts';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TICKETS_PATH = join(PKG_DIR, 'tickets.json');

export function registration(): AgentRegistration {
  return {
    build: () => buildAgent(fileTicketSink(TICKETS_PATH)),
    client: () => selectModel(),
  };
}

export { buildAgent, DEFAULT_SYSTEM_PROMPT, supportInputSchema } from './agent.ts';
export { stubModel } from './stub-model.ts';
export { fileTicketSink, memoryTicketSink, readTickets } from './sink.ts';
