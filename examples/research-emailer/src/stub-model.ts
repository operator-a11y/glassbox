/**
 * The deterministic stub model — a prompt-conditioned PLANNER, not a hasher.
 *
 * It emits valid, parseable, terminating tool_use / text blocks that are a pure
 * function of (system prompt, conversation). The system prompt's `TONE:` directive
 * flavors the drafted email, so forking with a mutated TONE yields a genuinely
 * divergent-but-valid continuation — fully offline, no API key. The stub is what
 * lets all four thesis properties be demonstrated headlessly.
 */

import type { ContentBlock, JsonValue, ModelClient, ModelClientRequest, ModelResponse } from '@glassbox/engine';

interface Style {
  subjectPrefix: string;
  greeting: string;
  bullet: string;
  bang: string;
  signoff: string;
}

const STYLES: Record<string, Style> = {
  neutral: { subjectPrefix: 'Summary:', greeting: 'Hello,', bullet: '-', bang: '.', signoff: 'Regards,\nResearch-Emailer' },
  enthusiastic: { subjectPrefix: '🎉 Exciting findings on', greeting: 'Hi there!', bullet: '✨', bang: '!', signoff: 'Cheers!\nResearch-Emailer' },
  formal: { subjectPrefix: 'Research Summary —', greeting: 'Dear colleague,', bullet: '•', bang: '.', signoff: 'Sincerely,\nResearch-Emailer' },
  terse: { subjectPrefix: 're:', greeting: '', bullet: '*', bang: '', signoff: '— RE' },
};

export function stubModel(): ModelClient {
  return {
    async complete(req: ModelClientRequest): Promise<ModelResponse> {
      const tone = extractTone(req.system);
      const turns = countToolUseTurns(req.messages);
      const { topic, recipient } = parseTask(req.messages);

      let content: ContentBlock[];
      let stopReason: string;

      if (turns === 0) {
        content = [{ type: 'tool_use', id: 'tu_0', name: 'search', input: { query: topic } }];
        stopReason = 'tool_use';
      } else if (turns === 1) {
        const urls = searchUrls(req.messages).slice(0, 3);
        content = [{ type: 'tool_use', id: 'tu_1', name: 'read', input: { urls } }];
        stopReason = 'tool_use';
      } else if (turns === 2) {
        const email = composeEmail(topic, recipient, readDocs(req.messages), tone);
        content = [{ type: 'tool_use', id: 'tu_2', name: 'send_email', input: email }];
        stopReason = 'tool_use';
      } else {
        content = [
          { type: 'text', text: `Done — I researched "${topic}" and emailed a ${tone} summary to ${recipient}.` },
        ];
        stopReason = 'end_turn';
      }

      return {
        content,
        stopReason,
        usage: { inputTokens: approxTokens(req.messages), outputTokens: approxTokens(content) },
      };
    },
  };
}

function extractTone(system: string): string {
  const m = system.match(/TONE:\s*([A-Za-z]+)/);
  const tone = m ? m[1]!.toLowerCase() : 'neutral';
  return tone in STYLES ? tone : 'neutral';
}

function parseTask(messages: JsonValue[]): { topic: string; recipient: string } {
  const first = messages[0];
  const text = isObj(first) && typeof first['content'] === 'string' ? first['content'] : '';
  const m = text.match(/topic "([^"]+)" and email a concise summary to (.+?)\.?$/);
  return { topic: m ? m[1]! : 'the topic', recipient: m ? m[2]! : 'someone' };
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

function searchUrls(messages: JsonValue[]): string[] {
  const results = findToolResult(messages, 'results');
  if (!Array.isArray(results)) return [];
  const urls: string[] = [];
  for (const r of results) {
    if (isObj(r) && typeof r['url'] === 'string') urls.push(r['url']);
  }
  return urls;
}

function readDocs(messages: JsonValue[]): Array<{ title: string; content: string }> {
  const docs = findToolResult(messages, 'documents');
  if (!Array.isArray(docs)) return [];
  const out: Array<{ title: string; content: string }> = [];
  for (const d of docs) {
    if (isObj(d) && typeof d['title'] === 'string' && typeof d['content'] === 'string') {
      out.push({ title: d['title'], content: d['content'] });
    }
  }
  return out;
}

/** Find the most recent tool_result whose content object has the given key. */
function findToolResult(messages: JsonValue[], key: string): JsonValue | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isObj(m) || !Array.isArray(m['content'])) continue;
    for (const block of m['content']) {
      if (isObj(block) && block['type'] === 'tool_result' && isObj(block['content']) && key in block['content']) {
        return block['content'][key];
      }
    }
  }
  return undefined;
}

function composeEmail(
  topic: string,
  recipient: string,
  docs: Array<{ title: string; content: string }>,
  tone: string,
): { to: string; subject: string; body: string } {
  const style = STYLES[tone] ?? STYLES['neutral']!;
  const bullets = docs.map((d) => `${style.bullet} ${firstSentence(d.content)}`).join('\n');
  const subject = `${style.subjectPrefix} ${topic}`;
  const lines = [style.greeting, '', `Here is a summary of "${topic}"${style.bang}`, '', bullets, '', style.signoff];
  return { to: recipient, subject, body: lines.filter((l) => l !== undefined).join('\n').trim() };
}

function firstSentence(content: string): string {
  const idx = content.indexOf('. ');
  return idx === -1 ? content : content.slice(0, idx + 1);
}

function approxTokens(value: JsonValue | ContentBlock[]): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function isObj(v: unknown): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
