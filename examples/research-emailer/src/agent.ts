/**
 * The research-emailer demo agent — a structured, Anthropic-style tool loop:
 *
 *   topic → search → read → draft summary → send_email (side-effecting) → confirm
 *
 * It is written in the inline-io resumable shape the engine records: it awaits
 * `io.model.complete(...)` and `io.tools.run(...)` and mutates `io.state`. The
 * system prompt is injected by the engine (never baked into messages), so a fork
 * that mutates the prompt actually changes the next model call.
 */

import { z } from 'zod';
import type { AgentDefinition, AgentFn, JsonValue, ToolDefinition, ToolUseBlock } from '@glassbox/engine';
import { searchCorpus, readCorpus } from './fixtures.ts';
import type { OutboxSink } from './sink.ts';

export const DEFAULT_SYSTEM_PROMPT = `You are Research-Emailer, a meticulous research assistant.

Given a topic and a recipient, you:
1. search for the topic,
2. read the most relevant results,
3. draft a concise summary,
4. email the summary to the recipient with the send_email tool,
5. confirm what you sent.

Email exactly once. Keep the summary faithful to what you read.

TONE: neutral`;

export const researchInputSchema = z.object({
  topic: z.string().min(1),
  recipient: z.string().min(1),
});
export type ResearchInput = z.infer<typeof researchInputSchema>;

// JSON-Schema tool definitions, shaped for the Anthropic Messages API. The stub
// model ignores these; the real adapter forwards them.
export const TOOL_SCHEMAS: JsonValue[] = [
  {
    name: 'search',
    description: 'Search for a topic and return result links.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'read',
    description: 'Read the contents of one or more result URLs.',
    input_schema: {
      type: 'object',
      properties: { urls: { type: 'array', items: { type: 'string' } } },
      required: ['urls'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email. This performs a real side effect.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

const searchArgs = z.object({ query: z.string() });
const readArgs = z.object({ urls: z.array(z.string()) });
const sendEmailArgs = z.object({ to: z.string(), subject: z.string(), body: z.string() });

export function buildTools(sink: OutboxSink): ToolDefinition[] {
  return [
    {
      name: 'search',
      kind: 'read_only',
      run: (args) => {
        const { query } = searchArgs.parse(args);
        return { results: searchCorpus(query) as unknown as JsonValue };
      },
    },
    {
      name: 'read',
      kind: 'read_only',
      run: (args) => {
        const { urls } = readArgs.parse(args);
        return { documents: urls.map(readCorpus) as unknown as JsonValue };
      },
    },
    {
      name: 'send_email',
      kind: 'side_effecting',
      // Real send — only ever runs in record mode. messageId/sentAt come from the
      // injected ctx so they are captured as nondeterminism and served on replay.
      run: (args, ctx) => {
        const email = sendEmailArgs.parse(args);
        const messageId = ctx.uuid();
        const sentAt = ctx.now();
        sink.append({ ...email, messageId, sentAt, status: 'sent' });
        return { status: 'sent', messageId, sentAt, to: email.to };
      },
      // Pure synthesis for the fork suffix — no email is sent.
      simulate: (args, ctx) => {
        const email = sendEmailArgs.parse(args);
        return { status: 'simulated', messageId: ctx.uuid(), sentAt: ctx.now(), to: email.to };
      },
    },
  ];
}

export const agentRun: AgentFn = async (io) => {
  const input = researchInputSchema.parse(io.input);
  io.state['runId'] = io.ctx.uuid();
  io.state['startedAt'] = io.ctx.now();

  const messages: JsonValue[] = [
    {
      role: 'user',
      content: `Research the topic "${input.topic}" and email a concise summary to ${input.recipient}.`,
    },
  ];
  io.state['messages'] = messages;
  io.state['toolCalls'] = 0;

  for (let i = 0; i < 12; i++) {
    const resp = await io.model.complete({ messages, tools: TOOL_SCHEMAS, maxTokens: 1024 });
    messages.push({ role: 'assistant', content: resp.content as unknown as JsonValue });

    const toolUses = resp.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
      io.state['final'] = text;
      return { confirmation: text };
    }

    const results: JsonValue[] = [];
    for (const tu of toolUses) {
      const result = await io.tools.run(tu.name, tu.input);
      io.state['toolCalls'] = (io.state['toolCalls'] as number) + 1;
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    messages.push({ role: 'user', content: results });
  }

  return { confirmation: (io.state['final'] as JsonValue) ?? null };
};

export function buildAgent(sink: OutboxSink, systemPrompt: string = DEFAULT_SYSTEM_PROMPT): AgentDefinition {
  return { name: 'research-emailer', systemPrompt, tools: buildTools(sink), run: agentRun };
}
