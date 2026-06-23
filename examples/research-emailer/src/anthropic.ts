/**
 * The real Anthropic adapter — conforms to the engine's ModelClient so the engine
 * never imports `@anthropic-ai/sdk` itself. Used automatically when ANTHROPIC_API_KEY
 * is set; otherwise the deterministic stub is used. The SDK is lazily imported so
 * the package loads (and tests run) without it.
 *
 * On replay the model is never called, so the offline stub demonstrates the full
 * thesis with no key. With a key, record and the fork suffix call the real model.
 */

import type { ContentBlock, JsonValue, ModelClient, ModelClientRequest } from '@glassbox/engine';
import { stubModel } from './stub-model.ts';

interface AnthropicLike {
  messages: {
    create(body: unknown): Promise<{
      content: unknown[];
      stop_reason: string | null;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export async function anthropicClient(opts: { apiKey: string; model: string }): Promise<ModelClient> {
  const mod = (await import('@anthropic-ai/sdk')) as unknown as {
    default: new (o: { apiKey: string }) => AnthropicLike;
  };
  const client = new mod.default({ apiKey: opts.apiKey });
  return {
    async complete(req: ModelClientRequest) {
      const message = await client.messages.create({
        model: opts.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        tools: req.tools,
      });
      return {
        content: fromAnthropicContent(message.content),
        stopReason: message.stop_reason ?? 'end_turn',
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      };
    },
  };
}

export interface ModelSelection {
  client: ModelClient;
  modelId: string;
  usingStub: boolean;
}

/** Real model when ANTHROPIC_API_KEY is set, else the deterministic stub. */
export async function selectModel(env: NodeJS.ProcessEnv = process.env): Promise<ModelSelection> {
  const key = env['ANTHROPIC_API_KEY'];
  const modelId = env['GLASSBOX_MODEL_ID'] || 'claude-sonnet-4-6';
  if (key) {
    return { client: await anthropicClient({ apiKey: key, model: modelId }), modelId, usingStub: false };
  }
  return { client: stubModel(), modelId: 'stub', usingStub: true };
}

function toAnthropicMessages(messages: JsonValue[]): unknown[] {
  return messages.map((m) => {
    if (!isObj(m)) return m;
    const content = m['content'];
    if (Array.isArray(content)) return { role: m['role'], content: content.map(toAnthropicBlock) };
    return { role: m['role'], content };
  });
}

function toAnthropicBlock(b: JsonValue): unknown {
  if (!isObj(b)) return b;
  if (b['type'] === 'tool_result') {
    const inner = b['content'];
    return {
      type: 'tool_result',
      tool_use_id: b['tool_use_id'],
      content: typeof inner === 'string' ? inner : JSON.stringify(inner),
    };
  }
  return b; // text and tool_use blocks are already API-shaped
}

function fromAnthropicContent(content: unknown[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b['type'] === 'text' && typeof b['text'] === 'string') {
      out.push({ type: 'text', text: b['text'] });
    } else if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
      out.push({ type: 'tool_use', id: b['id'], name: b['name'], input: isObj(b['input']) ? b['input'] : {} });
    }
  }
  return out;
}

function isObj(v: unknown): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
