/**
 * Deterministic prompt-conditioned planner for the support-triage agent. Output is
 * a pure function of (system prompt, conversation); the system prompt's `STYLE:`
 * directive flavors the created ticket, so a fork that edits STYLE diverges with
 * zero network. Mirrors the research-emailer stub but for a different domain —
 * proof that the contract, not the engine, is what each agent customizes.
 */

import type { JsonValue, ModelClient, ModelClientRequest, ModelResponse } from '@glassbox/engine';

interface Style {
  titlePrefix: string;
  greeting: string;
  closing: string;
}

const STYLES: Record<string, Style> = {
  standard: { titlePrefix: '', greeting: 'Support ticket.', closing: 'Triaged by Support-Triage.' },
  urgent: { titlePrefix: '🚨 URGENT: ', greeting: 'Escalating immediately!', closing: 'Needs attention NOW.' },
  friendly: { titlePrefix: '🙂 ', greeting: 'Hi! Thanks for reaching out.', closing: 'We are on it!' },
};

export function stubModel(): ModelClient {
  return {
    async complete(req: ModelClientRequest): Promise<ModelResponse> {
      const style = extractStyle(req.system);
      const turns = countToolUseTurns(req.messages);
      const { customer, ticket } = parseTask(req.messages);
      const usage = { inputTokens: req.messages.length, outputTokens: 3 };

      if (turns === 0) {
        return { content: [{ type: 'tool_use', id: 'tu_0', name: 'classify', input: { text: ticket } }], stopReason: 'tool_use', usage };
      }
      if (turns === 1) {
        return { content: [{ type: 'tool_use', id: 'tu_1', name: 'lookup_customer', input: { id: customer } }], stopReason: 'tool_use', usage };
      }
      if (turns === 2) {
        // Honor a REDACT directive (so a firewall-style counterfactual can show the
        // exfiltration being stopped). A real model would redact when instructed.
        const redact = /REDACT/i.test(req.system);
        const ticketArgs = composeTicket(customer, ticket, req.messages, style, redact);
        return { content: [{ type: 'tool_use', id: 'tu_2', name: 'create_ticket', input: ticketArgs }], stopReason: 'tool_use', usage };
      }
      return {
        content: [{ type: 'text', text: `Triaged ${customer}'s ${styleName(style)} ticket and created it.` }],
        stopReason: 'end_turn',
        usage,
      };
    },
  };
}

function extractStyle(system: string): Style {
  const m = system.match(/STYLE:\s*([A-Za-z]+)/);
  const key = m ? m[1]!.toLowerCase() : 'standard';
  return STYLES[key] ?? STYLES['standard']!;
}

function styleName(style: Style): string {
  return (Object.keys(STYLES).find((k) => STYLES[k] === style) ?? 'standard');
}

function parseTask(messages: JsonValue[]): { customer: string; ticket: string } {
  const first = messages[0];
  const text = isObj(first) && typeof first['content'] === 'string' ? first['content'] : '';
  // Anchor on the fixed ". Ticket text:" delimiter so the customer id never
  // swallows the trailing period.
  const customer = text.match(/Customer ID:\s*([\s\S]+?)\.\s*Ticket text:/)?.[1]?.trim() ?? 'unknown';
  const ticket = (text.match(/Ticket text:\s*([\s\S]+)$/)?.[1] ?? '').replace(/\.\s*$/, '').trim() || 'no details';
  return { customer, ticket };
}

function composeTicket(
  customer: string,
  ticket: string,
  messages: JsonValue[],
  style: Style,
  redact: boolean,
): { customer: string; title: string; body: string } {
  const classification = findResultWith(messages, 'category');
  const account = findResultWith(messages, 'plan');
  const priority = typeof classification?.['priority'] === 'string' ? classification['priority'] : 'normal';
  const category = typeof classification?.['category'] === 'string' ? classification['category'] : 'general';
  const plan = typeof account?.['plan'] === 'string' ? account['plan'] : 'unknown';

  const safeTicket = redact ? redactSecrets(ticket) : ticket;
  const title = `${style.titlePrefix}[${priority}/${category}] ${shortSummary(safeTicket)}`;
  const body = `${style.greeting} Customer ${customer} on the ${plan} plan reports: ${safeTicket}. ${style.closing}`;
  return { customer, title, body };
}

function redactSecrets(s: string): string {
  return s.replace(/sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]+|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]+/g, '[redacted]');
}

function shortSummary(ticket: string): string {
  return ticket.split(/\s+/).slice(0, 8).join(' ');
}

function countToolUseTurns(messages: JsonValue[]): number {
  let n = 0;
  for (const m of messages) {
    if (!isObj(m) || m['role'] !== 'assistant') continue;
    const content = m['content'];
    if (Array.isArray(content) && content.some((b) => isObj(b) && b['type'] === 'tool_use')) n++;
  }
  return n;
}

function findResultWith(messages: JsonValue[], key: string): { [k: string]: JsonValue } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isObj(m) || !Array.isArray(m['content'])) continue;
    for (const block of m['content']) {
      if (isObj(block) && block['type'] === 'tool_result' && isObj(block['content']) && key in block['content']) {
        return block['content'];
      }
    }
  }
  return undefined;
}

function isObj(v: unknown): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
