/**
 * Anthropic SDK adapter — an opt-in ModelClient over `@anthropic-ai/sdk`.
 *
 * The engine CORE never imports the SDK; this adapter is a separate module the
 * SDK is lazily imported by, so the engine loads (and tests run) without it. Use
 * `selectAnthropicOrStub` to pick the real client when a key is set and fall back
 * to a deterministic stub otherwise — replay never calls the model either way.
 */

import type { ContentBlock, ModelClient, ModelClientRequest } from '../model.ts';
import type { JsonValue } from '../json.ts';

interface AnthropicLike {
  messages: {
    create(body: unknown): Promise<{
      content: unknown[];
      stop_reason: string | null;
      usage?: { input_tokens: number; output_tokens: number };
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
      const usage = message.usage ?? { input_tokens: 0, output_tokens: 0 };
      return {
        content: fromAnthropicContent(message.content),
        stopReason: message.stop_reason ?? 'end_turn',
        usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
      };
    },
  };
}

export interface ClientSelection {
  client: ModelClient;
  modelId: string;
  label: string;
}

/** Real Anthropic client when ANTHROPIC_API_KEY is set, else the given stub. */
export async function selectAnthropicOrStub(
  stub: () => ModelClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClientSelection> {
  const key = env['ANTHROPIC_API_KEY'];
  const modelId = env['GLASSBOX_MODEL_ID'] || 'claude-sonnet-4-6';
  if (key) {
    return { client: await anthropicClient({ apiKey: key, model: modelId }), modelId, label: modelId };
  }
  return { client: stub(), modelId: 'stub', label: 'stub (deterministic, offline)' };
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

// Text + tool_use only. Other block kinds (thinking, server_tool_use, …) are
// dropped — so do NOT pair this adapter with extended thinking until passthrough
// is added, or assistant history would lose blocks.
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
