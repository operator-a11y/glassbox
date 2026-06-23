/**
 * Model selection for support-triage: real Anthropic client when a key is set,
 * else this agent's deterministic stub.
 */

import { selectAnthropicOrStub } from '@glassbox/engine';
import type { ClientSelection } from '@glassbox/engine';
import { stubModel } from './stub-model.ts';

export function selectModel(env: NodeJS.ProcessEnv = process.env): Promise<ClientSelection> {
  return selectAnthropicOrStub(stubModel, env);
}
