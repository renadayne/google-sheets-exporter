import { describe, expect, it, vi } from 'vitest';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import { encodeFrozenJson, MAX_JSON_DEPTH, MAX_JSON_NODES } from '../../src/export/json-encoding.ts';
import { MAX_JSON_BYTES } from '../../src/export/json-string-bytes.ts';

function freeze<T>(val: T): T {
  if (val && typeof val === 'object' && !Object.isFrozen(val)) {
    Object.freeze(val);
    for (const k of Object.getOwnPropertyNames(val)) freeze((val as any)[k]);
  }
  return val;
}

describe('encodeFrozenJson', () => {
  const signal = new AbortController().signal;
  const oracle = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

  it('matches native JSON.stringify and TextEncoder oracle with exact and one-under budget', () => {
    const doc = freeze({
      ['😀"\\\uD800']: '00123',
      version: '0.1.0',
      tabs: [
        { name: 'Empty', gid: 0, rows: [] },
        {
          name: 'Data',
          gid: 1,
          rows: [
            { r: 1, cells: [{ c: 1, v: 'hello "world"\b\f\n\r\t\x00\x1f' }, { c: 2, v: -42.5 }, { c: 3, v: null }, { c: 4, v: true }] },
            { r: 2, cells: [{ c: 1, v: '中文测试 \uD800\uDC00 \uD800 lone \uDC00 😀' }, { c: 2, v: -0 }, { c: 3, v: false }] }
          ]
        }
      ]
    });
    const docExpected = oracle(doc);
    const docOut = encodeFrozenJson(doc, { maxBytes: MAX_JSON_BYTES, signal });
    expect(docOut).toEqual(docExpected);
    expect(JSON.parse(new TextDecoder().decode(docOut))).toEqual(JSON.parse(JSON.stringify(doc)));
    expect(encodeFrozenJson(doc, { maxBytes: docExpected.length, signal })).toEqual(docExpected);
    expect(() => encodeFrozenJson(doc, { maxBytes: docExpected.length - 1, signal })).toThrowError(SAFE_ERROR_MESSAGES.BYTE_LIMIT_EXCEEDED);

    for (const prim of [null, true, false, 0, -0, -123.45, 1e20, '', 'plain', 'quote " \\ \n \uD800', []]) {
      const pFrozen = freeze(prim);
      const expected = oracle(pFrozen);
      const out = encodeFrozenJson(pFrozen, { maxBytes: MAX_JSON_BYTES, signal });
      expect(out).toEqual(expected);
      expect(JSON.parse(new TextDecoder().decode(out))).toEqual(Object.is(prim, -0) ? 0 : prim);
      expect(encodeFrozenJson(pFrozen, { maxBytes: expected.length, signal })).toEqual(expected);
      if (expected.length > 0) {
        expect(() => encodeFrozenJson(pFrozen, { maxBytes: expected.length - 1, signal })).toThrowError(SAFE_ERROR_MESSAGES.BYTE_LIMIT_EXCEEDED);
      }
    }
  });

  it('fails preflight on budget excess before ANY encoder or stringifier call', () => {
    const doc = freeze({ a: 'a'.repeat(100), b: [1, 2, 3] });
    const expected = oracle(doc).length;
    const strSpy = vi.spyOn(JSON, 'stringify');
    const encSpy = vi.spyOn(TextEncoder.prototype, 'encode');
    const intoSpy = vi.spyOn(TextEncoder.prototype, 'encodeInto');
    expect(() => encodeFrozenJson(doc, { maxBytes: expected - 1, signal })).toThrowError(SAFE_ERROR_MESSAGES.BYTE_LIMIT_EXCEEDED);
    expect(strSpy).not.toHaveBeenCalled();
    expect(encSpy).not.toHaveBeenCalled();
    expect(intoSpy).not.toHaveBeenCalled();
    strSpy.mockRestore();
    encSpy.mockRestore();
    intoSpy.mockRestore();
  });

  it('rejects unfrozen, accessors, and toJSON hooks with ZERO invocation count', () => {
    expect(() => encodeFrozenJson({ a: 1 }, { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(() => encodeFrozenJson([1], { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);

    let getterCalls = 0;
    const withGetter = Object.freeze(Object.defineProperty({}, 'a', { get() { getterCalls++; return 1; }, enumerable: true }));
    expect(() => encodeFrozenJson(withGetter, { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    const arrGetter = Object.freeze(Object.defineProperty([1], '0', { get() { getterCalls++; return 1; }, enumerable: true }));
    expect(() => encodeFrozenJson(arrGetter, { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(getterCalls).toBe(0);

    let toJSONCalls = 0;
    const withToJSON = Object.freeze({ toJSON() { toJSONCalls++; return {}; } });
    expect(() => encodeFrozenJson(withToJSON, { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    const arrToJSON = Object.freeze(Object.assign([], { toJSON() { toJSONCalls++; return []; } }));
    expect(() => encodeFrozenJson(arrToJSON, { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(toJSONCalls).toBe(0);
  });

  it('rejects holes, extra array keys, non-enumerable props, nonfinite, invalid types, and cycles', () => {
    expect(() => encodeFrozenJson(Object.freeze([1, , 3]), { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(() => encodeFrozenJson(Object.freeze(new Array(3)), { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(() => encodeFrozenJson(Object.freeze(Object.assign([1], { extra: 2 })), { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(() => encodeFrozenJson(Object.freeze(Object.assign([1], { '-1': 2 })), { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    const nonEnum = Object.freeze(Object.defineProperty({}, 'k', { value: 1, enumerable: false }));
    expect(() => encodeFrozenJson(nonEnum, { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);

    for (const bad of [NaN, Infinity, -Infinity, undefined, Symbol(), 10n, () => {}, new Date(), /regex/]) {
      expect(() => encodeFrozenJson(bad, { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    }
    const cyc: any = {}; cyc.self = cyc; Object.freeze(cyc);
    expect(() => encodeFrozenJson(cyc, { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    const cycArr: any = []; cycArr.push(cycArr); Object.freeze(cycArr);
    expect(() => encodeFrozenJson(cycArr, { maxBytes: 100, signal })).toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
  });

  it('allows shared frozen references in different branches and null-prototype objects', () => {
    const shared = freeze({ leaf: 'value' });
    const root = freeze({ branchA: shared, branchB: shared, list: [shared, shared] });
    const out = encodeFrozenJson(root, { maxBytes: 1000, signal });
    expect(out).toEqual(oracle(root));

    const nullProto = freeze(Object.assign(Object.create(null), { key: 'val' }));
    const nullOut = encodeFrozenJson(nullProto, { maxBytes: 1000, signal });
    expect(JSON.parse(new TextDecoder().decode(nullOut))).toEqual({ key: 'val' });
  });

  it('enforces depth and node guards early using huge sparse arrays without enumerating positions', () => {
    let deep: any = { leaf: 1 };
    for (let i = 0; i <= MAX_JSON_DEPTH; i++) deep = { next: deep };
    freeze(deep);
    expect(() => encodeFrozenJson(deep, { maxBytes: MAX_JSON_BYTES, signal })).toThrowError(SAFE_ERROR_MESSAGES.SIZE_LIMIT_EXCEEDED);

    const hugeSparse = Object.freeze(new Array(MAX_JSON_NODES + 1));
    expect(() => encodeFrozenJson(hugeSparse, { maxBytes: MAX_JSON_BYTES, signal })).toThrowError(SAFE_ERROR_MESSAGES.SIZE_LIMIT_EXCEEDED);

    const byteExceededSparse = Object.freeze(new Array(100_000));
    expect(() => encodeFrozenJson(byteExceededSparse, { maxBytes: 10, signal })).toThrowError(SAFE_ERROR_MESSAGES.BYTE_LIMIT_EXCEEDED);
  });

  it('validates options, enforces preabort and periodic abort, and sanitizes hostile exceptions', () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(() => encodeFrozenJson(freeze({}), { maxBytes: 100, signal: aborted.signal })).toThrowError(SAFE_ERROR_MESSAGES.OPERATION_ABORTED);

    let polls = 0;
    const midSig = { addEventListener() {}, removeEventListener() {}, get aborted() { return ++polls > 2; } };
    const multi = freeze({ a: 1, b: 2, c: 3, d: 4 });
    expect(() => encodeFrozenJson(multi, { maxBytes: 100, signal: midSig as any })).toThrowError(SAFE_ERROR_MESSAGES.OPERATION_ABORTED);

    for (const badMax of [-1, 1.5, NaN, -0, MAX_JSON_BYTES + 1, '10']) {
      expect(() => encodeFrozenJson(freeze({}), { maxBytes: badMax as any, signal })).toThrowError(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
    }
    for (const badSig of [null, {}, { aborted: false }, { aborted: 'no', addEventListener() {}, removeEventListener() {} }]) {
      expect(() => encodeFrozenJson(freeze({}), { maxBytes: 100, signal: badSig as any })).toThrowError(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
    }
    for (const badOpts of [null, undefined, 123, 'opts']) {
      expect(() => encodeFrozenJson(freeze({}), badOpts as any)).toThrowError(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
    }

    const hostile = { maxBytes: 100, signal: { addEventListener() {}, removeEventListener() {}, get aborted(): boolean { throw new Error('LEAK_SECRET'); } } };
    try {
      encodeFrozenJson(freeze({}), hostile as any);
      expect.fail('should throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.message).toBe(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
      expect(err.message).not.toContain('LEAK_SECRET');
    }

    const mutated = new DomainError('CONFIG_INVALID');
    (mutated as any).message = 'MUTATED_LEAK';
    const hostileMutated = { maxBytes: 100, signal: { addEventListener() {}, removeEventListener() {}, get aborted(): boolean { throw mutated; } } };
    try {
      encodeFrozenJson(freeze({}), hostileMutated as any);
      expect.fail('should throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err).not.toBe(mutated);
      expect(err.message).toBe(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
      expect(err.message).not.toContain('MUTATED_LEAK');
    }
  });
});
