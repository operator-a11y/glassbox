/**
 * Redaction is the firewall's most important property: a finding must prove a match
 * without re-leaking the value. For secrets we emit only a type label + length + an
 * 8-hex sha256 prefix — no substring of the secret of any length. The hash is
 * deterministic so two findings for the same secret correlate and dedupe.
 *
 * Injection phrases are NOT secret (the whole point is to see the hijack text), so
 * they are shown — but markup-neutralized and length-bounded.
 */

import { createHash } from 'node:crypto';

export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
}

export function redactSecret(secret: string, label: string): string {
  return `${label} ⟨len ${secret.length}, sha256:${secretFingerprint(secret)}⟩`;
}

export function neutralizePhrase(phrase: string): string {
  const flat = phrase.replace(/\s+/g, ' ').trim();
  const bounded = flat.length <= 140 ? flat : flat.slice(0, 139) + '…';
  // Neutralize angle brackets so a UI can't be tricked into rendering markup.
  return bounded.replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));
}
