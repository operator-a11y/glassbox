/**
 * The support-triage demo agent — a SECOND, different structured agent on the same
 * engine, with no engine changes:
 *
 *   ticket → classify → lookup_customer → draft → create_ticket (side-effecting) → confirm
 *
 * Built with `toolLoopAgent`, so it is pure configuration: a different domain,
 * different tools, and a different side-effecting tool than research-emailer.
 */

import { z } from 'zod';
import { toolLoopAgent } from '@glassbox/engine';
import type { AgentDefinition, JsonValue, ToolDefinition } from '@glassbox/engine';
import { classify, lookupCustomer } from './fixtures.ts';
import type { TicketSink } from './sink.ts';

export const DEFAULT_SYSTEM_PROMPT = `You are Support-Triage, a careful support engineer.

Given a customer id and a ticket, you:
1. classify the ticket,
2. look up the customer,
3. draft a ticket title and body,
4. create the ticket with the create_ticket tool,
5. confirm what you filed.

Create exactly one ticket. Stay faithful to the customer's report.

STYLE: standard`;

export const supportInputSchema = z.object({
  customer: z.string().min(1),
  ticket: z.string().min(1),
});
export type SupportInput = z.infer<typeof supportInputSchema>;

export const TOOL_SCHEMAS: JsonValue[] = [
  {
    name: 'classify',
    description: 'Classify a ticket into priority + category.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'lookup_customer',
    description: 'Look up a customer record by id.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'create_ticket',
    description: 'File a support ticket. This performs a real side effect.',
    input_schema: {
      type: 'object',
      properties: { customer: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      required: ['customer', 'title', 'body'],
    },
  },
];

const classifyArgs = z.object({ text: z.string() });
const lookupArgs = z.object({ id: z.string() });
const createTicketArgs = z.object({ customer: z.string(), title: z.string(), body: z.string() });

export function buildTools(sink: TicketSink): ToolDefinition[] {
  return [
    {
      name: 'classify',
      kind: 'read_only',
      run: (args) => classify(classifyArgs.parse(args).text) as unknown as JsonValue,
    },
    {
      name: 'lookup_customer',
      kind: 'read_only',
      run: (args) => lookupCustomer(lookupArgs.parse(args).id) as unknown as JsonValue,
    },
    {
      name: 'create_ticket',
      kind: 'side_effecting',
      run: (args, ctx) => {
        const t = createTicketArgs.parse(args);
        const ticketId = ctx.uuid();
        const createdAt = ctx.now();
        sink.append({ ...t, ticketId, createdAt, status: 'open' });
        return { status: 'created', ticketId, createdAt, customer: t.customer };
      },
      simulate: (args, ctx) => {
        const t = createTicketArgs.parse(args);
        return { status: 'simulated', ticketId: ctx.uuid(), createdAt: ctx.now(), customer: t.customer };
      },
    },
  ];
}

export function buildAgent(sink: TicketSink, systemPrompt: string = DEFAULT_SYSTEM_PROMPT): AgentDefinition {
  return toolLoopAgent({
    name: 'support-triage',
    systemPrompt,
    tools: buildTools(sink),
    toolSchemas: TOOL_SCHEMAS,
    userMessage: (input) => {
      const { customer, ticket } = supportInputSchema.parse(input);
      return `Customer ID: ${customer}. Ticket text: ${ticket}`;
    },
    finalize: (text) => ({ resolution: text }),
  });
}
