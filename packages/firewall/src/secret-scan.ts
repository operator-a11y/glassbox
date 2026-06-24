/**
 * Secret detection. Two tiers:
 *  - high-confidence PREFIXED detectors (sk-ant-, ghp_, AKIA, JWT, PEM, …) — distinctive
 *    prefixes give very low false positives.
 *  - a generic high-ENTROPY tier for unknown-format keys, gated to avoid flagging git
 *    SHAs / UUIDs / hashes (low alphabet) as secrets.
 *
 * Every regex is linear and bounded (single character classes, no nested quantifiers),
 * so a crafted megabyte input cannot trigger catastrophic backtracking.
 */

import { alphabetSize, shannonEntropy } from './normalize.ts';

export interface SecretMatch {
  rule: string;
  label: string;
  /** Raw value — used only for hashing/dedup, never emitted in a Finding. */
  secret: string;
  index: number;
}

interface PrefixedDetector {
  rule: string;
  label: string;
  re: RegExp;
}

const PREFIXED: PrefixedDetector[] = [
  { rule: 'anthropic-key', label: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{24,128}/g },
  { rule: 'openai-key', label: 'OpenAI API key', re: /sk-(?:proj|svcacct|live)-[A-Za-z0-9_-]{20,128}/g },
  { rule: 'openai-key-legacy', label: 'OpenAI API key', re: /sk-[A-Za-z0-9]{32,64}/g },
  { rule: 'github-token', label: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,255}/g },
  { rule: 'aws-access-key', label: 'AWS access key id', re: /(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  { rule: 'slack-token', label: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,200}/g },
  { rule: 'google-key', label: 'Google API key', re: /AIza[A-Za-z0-9_-]{35}/g },
  { rule: 'jwt', label: 'JWT', re: /eyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,2000}/g },
  { rule: 'pem-private-key', label: 'PEM private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
];

const TOKEN_RE = /[A-Za-z0-9+/_=-]{24,512}/g;
const HEX_ONLY = /^[0-9a-f]+$/i;
const MAX_SCAN_LEN = 64 * 1024;

export function scanSecrets(text: string): SecretMatch[] {
  const t = text.length > MAX_SCAN_LEN ? text.slice(0, MAX_SCAN_LEN) : text;
  const out: SecretMatch[] = [];

  for (const d of PREFIXED) {
    for (const m of t.matchAll(d.re)) {
      out.push({ rule: d.rule, label: d.label, secret: m[0], index: m.index ?? 0 });
    }
  }

  for (const m of t.matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (isHighEntropySecret(tok)) {
      out.push({ rule: 'high-entropy', label: 'high-entropy token', secret: tok, index: m.index ?? 0 });
    }
  }

  return out;
}

function isHighEntropySecret(tok: string): boolean {
  if (alphabetSize(tok) < 20) return false; // hex hashes, decimal ids, repetitive strings
  if (HEX_ONLY.test(tok)) return false; // md5/sha/uuid-ish — usually benign
  return shannonEntropy(tok) >= 4.0;
}
