/**
 * Determinism primitives.
 *
 * The single most important lesson from designing this engine: there is exactly
 * ONE canonical representation of any recorded value — sorted-key JSON — and it
 * is the source of truth for cloning, hashing, serialization, AND comparison.
 * Mixing representations (e.g. `structuredClone` in memory vs JSON on disk) is
 * how a record/replay engine reports "bit-identical" while state has actually
 * diverged. Everything here exists to prevent that.
 */

import { createHash } from 'node:crypto';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * Validate that `value` is strictly JSON-serializable with no information loss.
 *
 * Rejects the values that make `structuredClone` and `JSON.stringify` disagree:
 * `undefined` (dropped by JSON), `Date`/`Map`/`Set`/`RegExp`/class instances
 * (silently mangled by JSON), `NaN`/`Infinity` (become `null`), `BigInt`,
 * `Symbol`, and functions. Agent state must be plain JSON; this turns a silent
 * false-green into a loud, located error.
 */
export function assertJsonValue(value: unknown, path = '$'): void {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`assertJsonValue: non-finite number (${String(value)}) at ${path}`);
    }
    return;
  }
  if (t === 'undefined') {
    throw new Error(`assertJsonValue: undefined at ${path} — use omission, not undefined`);
  }
  if (t === 'bigint' || t === 'symbol' || t === 'function') {
    throw new Error(`assertJsonValue: ${t} at ${path} is not JSON-serializable`);
  }
  if (Array.isArray(value)) {
    value.forEach((el, i) => {
      if (el === undefined) {
        throw new Error(
          `assertJsonValue: undefined array element at ${path}[${i}] (JSON would coerce it to null)`,
        );
      }
      assertJsonValue(el, `${path}[${i}]`);
    });
    return;
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as object).constructor?.name ?? 'unknown';
      throw new Error(
        `assertJsonValue: non-plain object (${name}) at ${path} — agent state must be plain JSON`,
      );
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(v, `${path}.${k}`);
    }
    return;
  }
  throw new Error(`assertJsonValue: unsupported type ${t} at ${path}`);
}

/**
 * Deep-clone via a JSON round-trip after validating losslessness. Used for every
 * state snapshot so the in-memory snapshot and the on-disk form are byte-identical
 * by construction (unlike `structuredClone`, which preserves things JSON cannot).
 */
export function jsonClone<T>(value: T): T {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * TRUE recursive canonical serializer: sorts object keys at *every* depth and
 * preserves array order. Do NOT replace this with `JSON.stringify(obj, sortedKeys)`
 * — the replacer-array form is an allowlist applied at every depth that silently
 * deletes nested keys, producing false "bit-identical" passes.
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`canonicalize: non-finite number (${String(v)})`);
    }
    // JSON.stringify collapses -0 to "0" and renders integers/floats canonically.
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return '[' + v.map(serialize).join(',') + ']';
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const name = (v as object).constructor?.name ?? 'unknown';
      throw new Error(`canonicalize: non-plain object (${name}) cannot be canonicalized`);
    }
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const val = obj[k];
      if (val === undefined) continue; // mirror JSON.stringify, which drops undefined-valued keys
      parts.push(JSON.stringify(k) + ':' + serialize(val));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonicalize: unsupported type ${t}`);
}

/** Structural equality via canonical form. The one true equality for traces. */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

/**
 * Pretty, sorted-key JSON for on-disk traces. Uses the replacer *function* form
 * (safe — it rewrites each object with sorted keys); never the array form.
 */
export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, sortKeysReplacer, 2) + '\n';
}

function sortKeysReplacer(_key: string, val: unknown): unknown {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  }
  return val;
}

/**
 * systemPromptHash, pinned precisely: sha256 over the NFC-normalized UTF-8 bytes
 * of the raw prompt string (no trimming), lowercase hex. NFC normalization is
 * applied identically at record and replay so a prompt that is visually identical
 * but differently composed cannot falsely read as "no fork divergence".
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(Buffer.from(input.normalize('NFC'), 'utf8')).digest('hex');
}
