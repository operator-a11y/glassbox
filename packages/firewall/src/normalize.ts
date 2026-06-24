/**
 * Normalization defeats the cheap evasions (zero-width splits, Unicode homoglyph
 * tricks, whitespace padding) before any matching. All functions are pure and
 * deterministic — entropy uses only the literal characters, never the environment.
 */

// Zero-width + bidi + default-ignorable formatting characters attackers use to
// split tokens ("sk-<ZWSP>ant-…") or hide instructions. Built from escapes so the
// source stays ASCII.
const FORMAT_CHARS = new RegExp('[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]', 'g');

/** NFKC + strip format/zero-width characters. Preserves case and structure. */
export function normalize(text: string): string {
  return text.normalize('NFKC').replace(FORMAT_CHARS, '');
}

/** Lowercased, whitespace-collapsed form for phrase matching. */
export function normalizeForPhrase(text: string): string {
  return normalize(text).toLowerCase().replace(/\s+/g, ' ');
}

/** Shannon entropy in bits/char over the literal string — deterministic. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Number of distinct characters — used to separate real keys from hex hashes. */
export function alphabetSize(s: string): number {
  return new Set(s).size;
}
