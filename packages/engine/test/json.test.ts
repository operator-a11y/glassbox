import { describe, it, expect } from 'vitest';
import { assertJsonValue, canonicalize, canonicalEqual, jsonClone, sha256Hex } from '../src/index.ts';

describe('canonicalize', () => {
  it('sorts object keys at every depth and preserves array order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('is order-insensitive for equal objects', () => {
    expect(canonicalEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
  });

  it('does NOT lose nested keys (the JSON.stringify(obj, sortedKeys) footgun)', () => {
    // The replacer-array form would render both of these as {"scratch":{}} — a
    // false bit-identical pass. The true recursive canonicalizer must distinguish them.
    const a = { scratch: { x: 1, y: 2 }, top: 0 };
    const b = { scratch: { x: 1, z: 9 }, top: 0 };
    expect(canonicalize(a)).not.toBe(canonicalize(b));
    expect(canonicalize(a)).toContain('"x":1');
    expect(canonicalize(a)).toContain('"y":2');
  });

  it('collapses -0 to 0 and rejects non-finite numbers', () => {
    expect(canonicalize(-0)).toBe('0');
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
  });
});

describe('assertJsonValue', () => {
  it('accepts plain JSON', () => {
    expect(() => assertJsonValue({ a: [1, 'two', true, null, { b: 3 }] })).not.toThrow();
  });

  it('rejects the values that make structuredClone and JSON disagree', () => {
    expect(() => assertJsonValue(new Date())).toThrow(/non-plain object \(Date\)/);
    expect(() => assertJsonValue(new Map())).toThrow(/non-plain object \(Map\)/);
    expect(() => assertJsonValue(new Set())).toThrow(/non-plain object \(Set\)/);
    expect(() => assertJsonValue({ a: undefined })).toThrow(/undefined/);
    expect(() => assertJsonValue({ n: NaN })).toThrow(/non-finite/);
    expect(() => assertJsonValue({ n: Infinity })).toThrow(/non-finite/);
    expect(() => assertJsonValue(10n)).toThrow(/bigint/);
    expect(() => assertJsonValue(() => 0)).toThrow(/function/);
    expect(() => assertJsonValue([undefined])).toThrow(/undefined array element/);
  });
});

describe('jsonClone', () => {
  it('deep-clones independently', () => {
    const src = { a: { b: [1, 2] } };
    const copy = jsonClone(src);
    copy.a.b.push(3);
    expect(src.a.b).toEqual([1, 2]);
    expect(copy.a.b).toEqual([1, 2, 3]);
  });
});

describe('sha256Hex', () => {
  it('matches the canonical SHA-256("abc") digest', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('NFC-normalizes so visually identical prompts hash identically', () => {
    const composed = 'é'; // é
    const decomposed = 'é'; // e + combining acute
    expect(composed).not.toBe(decomposed);
    expect(sha256Hex(composed)).toBe(sha256Hex(decomposed));
  });
});
