/**
 * Public surface of the research-emailer example: a CLI `registration` (build +
 * client) so the generic `glassbox` CLI can drive it, plus the pieces tests use.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRegistration } from '@glassbox/engine';
import { buildAgent } from './agent.ts';
import { selectModel } from './anthropic.ts';
import { fileOutboxSink } from './sink.ts';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTBOX_PATH = join(PKG_DIR, 'outbox.json');

/** The side effect (email) writes to a real outbox only at record time; the engine
 *  never calls it on replay/fork, so a single registration is safe for all modes. */
export function registration(): AgentRegistration {
  return {
    build: () => buildAgent(fileOutboxSink(OUTBOX_PATH)),
    client: () => selectModel(),
  };
}

export { buildAgent, DEFAULT_SYSTEM_PROMPT, researchInputSchema } from './agent.ts';
export { stubModel } from './stub-model.ts';
export { fileOutboxSink, memoryOutboxSink, readOutbox } from './sink.ts';
