import { describe, expect, it, vi } from 'vitest';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import { countJsonStringBytes, MAX_JSON_BYTES } from '../../src/export/json-string-bytes.ts';

describe('countJsonStringBytes', () => {
  const sig = new AbortController().signal;
  const oracle = (s: string) => new TextEncoder().encode(JSON.stringify(s)).length;

  it('matches manual byte oracles and native corpus parity with exact and one-under budget', () => {
    const cases: [string, number][] = [
      ['', 2], ['hello', 7], ['"\\', 6], ['\b\f\n\r\t', 12], ['\x00\x1f', 14],
      ['中', 5], ['\uD83D\uDE00', 6], ['\uD800', 8], ['\uDC00', 8],
      ['\uD800x', 9], ['x\uDC00', 9], ['\uD800\uD800', 14], ['\u2028\u2029', 8]
    ];
    for (const [s, expected] of cases) {
      expect(countJsonStringBytes(s, MAX_JSON_BYTES, sig)).toBe(expected);
      expect(expected).toBe(oracle(s));
      expect(countJsonStringBytes(s, expected, sig)).toBe(expected);
      expect(() => countJsonStringBytes(s, expected - 1, sig)).toThrowError(SAFE_ERROR_MESSAGES.BYTE_LIMIT_EXCEEDED);
    }
  });

  it('enforces preabort, periodic abort, config validation, and static getter diagnostics', () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(() => countJsonStringBytes('', 10, aborted.signal)).toThrowError(SAFE_ERROR_MESSAGES.OPERATION_ABORTED);
    let polls = 0;
    const midSig = { addEventListener: () => {}, removeEventListener: () => {}, get aborted() { return ++polls > 2; } };
    expect(() => countJsonStringBytes('a'.repeat(4000), MAX_JSON_BYTES, midSig as any)).toThrowError(SAFE_ERROR_MESSAGES.OPERATION_ABORTED);
    for (const badVal of [123, null, undefined, {}, new String('x')]) {
      expect(() => countJsonStringBytes(badVal as any, 10, sig)).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    }
    for (const badMax of [-1, 1.5, NaN, -0, MAX_JSON_BYTES + 1, '10']) {
      expect(() => countJsonStringBytes('', badMax as any, sig)).toThrowError(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
    }
    for (const badSig of [null, {}, { aborted: false }, { aborted: 'no', addEventListener: () => {}, removeEventListener: () => {} }]) {
      expect(() => countJsonStringBytes('', 10, badSig as any)).toThrowError(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
    }
    const hostile = {
      addEventListener: () => {}, removeEventListener: () => {},
      get aborted(): boolean { throw new Error('LEAK_SECRET'); }
    };
    try {
      countJsonStringBytes('', 10, hostile as any);
      expect.fail('should throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.message).toBe(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
      expect(err.message).not.toContain('LEAK_SECRET');
    }
    const mutated = new DomainError('CONFIG_INVALID');
    (mutated as any).message = 'MUTATED_LEAK';
    const hostileMutated = {
      addEventListener: () => {}, removeEventListener: () => {},
      get aborted(): boolean { throw mutated; }
    };
    try {
      countJsonStringBytes('', 10, hostileMutated as any);
      expect.fail('should throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err).not.toBe(mutated);
      expect(err.message).toBe(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
      expect(err.message).not.toContain('MUTATED_LEAK');
    }
  });

  it('exits early on oversized input without production encoder or stringifier calls', () => {
    const strSpy = vi.spyOn(JSON, 'stringify');
    const encSpy = vi.spyOn(TextEncoder.prototype, 'encode');
    let pollCount = 0;
    const spySig = {
      addEventListener: () => {}, removeEventListener: () => {},
      get aborted(): boolean { pollCount++; return false; }
    };
    const huge = 'a'.repeat(200_000);
    expect(() => countJsonStringBytes(huge, 10, spySig as any)).toThrowError(SAFE_ERROR_MESSAGES.BYTE_LIMIT_EXCEEDED);
    expect(pollCount).toBeLessThanOrEqual(2);
    expect(strSpy).not.toHaveBeenCalled();
    expect(encSpy).not.toHaveBeenCalled();
    strSpy.mockRestore();
    encSpy.mockRestore();
  });

  it('polls cancellation even when surrogate pairs skip exact 1024-unit offsets', () => {
    let polls = 0;
    const signal = { addEventListener() {}, removeEventListener() {}, get aborted() { return ++polls > 2; } };
    expect(() => countJsonStringBytes('a' + '😀'.repeat(3000), MAX_JSON_BYTES, signal as any))
      .toThrowError(SAFE_ERROR_MESSAGES.OPERATION_ABORTED);
    expect(polls).toBe(3);
    const injected = new DomainError('CONFIG_INVALID');
    Object.defineProperty(injected, 'code', { get() { throw new Error('SECRET_CODE_GETTER'); } });
    const hostile = { addEventListener() {}, removeEventListener() {}, get aborted() { throw injected; } };
    expect(() => countJsonStringBytes('', 10, hostile as any)).toThrowError(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
  });
});
