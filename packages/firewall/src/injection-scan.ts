/**
 * Prompt-injection detection — explicitly best-effort, not a complete filter. A fast
 * normalized-phrase pass plus a couple of structural markers (role impersonation,
 * "your instructions"). Matching runs on the lowercased, whitespace-collapsed,
 * format-stripped text, so spacing / case / zero-width evasions are already defeated.
 *
 * Severity is NOT decided here — the same phrase is benign in the user's own turn and
 * dangerous in a tool result. scanTrace scores by provenance.
 */

import { normalizeForPhrase } from './normalize.ts';

export interface InjectionMatch {
  rule: string;
  phrase: string;
  index: number;
}

const PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: 'ignore-instructions', re: /ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|messages?|directions)/g },
  { rule: 'disregard', re: /disregard (?:all |the |any )?(?:previous|prior|above|system)(?: instructions| prompt)?/g },
  { rule: 'override-instructions', re: /(?:new|updated|revised) (?:instructions|system prompt|directive)s?\s?:/g },
  { rule: 'reveal-system-prompt', re: /(?:reveal|print|show|repeat|output|tell me)(?: your| the)? (?:system )?(?:prompt|instructions)/g },
  { rule: 'role-impersonation', re: /(?:system|assistant|developer)\s?:\s?(?:you|ignore|now|do|from now)/g },
  { rule: 'you-are-now', re: /you are now (?:a |an |the |in )/g },
  { rule: 'exfiltrate', re: /(?:exfiltrate|forward|leak|email|post|upload) (?:all |the |any )?(?:data|secrets?|credentials?|api keys?|passwords?|private keys?)/g },
  { rule: 'do-not-tell', re: /do not (?:tell|inform|notify|alert|mention to) the (?:user|human|operator|customer)/g },
];

const MAX_SCAN_LEN = 64 * 1024;

export function scanInjections(text: string): InjectionMatch[] {
  const t = normalizeForPhrase(text.length > MAX_SCAN_LEN ? text.slice(0, MAX_SCAN_LEN) : text);
  const out: InjectionMatch[] = [];
  for (const p of PATTERNS) {
    for (const m of t.matchAll(p.re)) {
      out.push({ rule: p.rule, phrase: m[0].trim(), index: m.index ?? 0 });
    }
  }
  return out;
}
