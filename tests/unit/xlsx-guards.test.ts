import { describe, it, expect } from 'vitest';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import {
  XLSX_MAX_ROWS,
  XLSX_MAX_COLUMNS,
  XLSX_MAX_TEXT_UTF16_UNITS,
  XLSX_MAX_LINE_FEEDS,
  XLSX_MIN_NUMERIC_MAGNITUDE,
  XLSX_MAX_NUMERIC_MAGNITUDE,
  XLSX_MAX_SIGNIFICANT_DIGITS,
  assertXlsxRectRepresentable,
  assertXlsxTextRepresentable,
  assertXlsxNumberRepresentable
} from '../../src/export/xlsx-guards.ts';

describe('T29a XLSX Representability Guards', () => {
  it('validates rect boundaries, large nonzero origins outside Excel, reversals, and empties', () => {
    // Exact edges and full sheet blank scope boundary
    expect(() => assertXlsxRectRepresentable({ sheetId: 0, r0: 0, c0: 0, r1: XLSX_MAX_ROWS, c1: XLSX_MAX_COLUMNS })).not.toThrow();
    expect(() => assertXlsxRectRepresentable({ sheetId: 1, r0: XLSX_MAX_ROWS - 1, c0: XLSX_MAX_COLUMNS - 1, r1: XLSX_MAX_ROWS, c1: XLSX_MAX_COLUMNS })).not.toThrow();

    // Bounds exceeded (+1) & large nonzero origin with small extent outside Excel
    for (const r of [
      { sheetId: 0, r0: 0, c0: 0, r1: XLSX_MAX_ROWS + 1, c1: 1 },
      { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: XLSX_MAX_COLUMNS + 1 },
      { sheetId: 0, r0: XLSX_MAX_ROWS - 1, c0: 0, r1: XLSX_MAX_ROWS + 1, c1: 1 },
      { sheetId: 0, r0: 0, c0: XLSX_MAX_COLUMNS - 1, r1: 1, c1: XLSX_MAX_COLUMNS + 1 }
    ]) {
      expect(() => assertXlsxRectRepresentable(r)).toThrowError(expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' }));
    }

    // Reversals -> RANGE_INVALID; Empties -> RANGE_EMPTY
    expect(() => assertXlsxRectRepresentable({ sheetId: 0, r0: 5, c0: 0, r1: 4, c1: 10 })).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => assertXlsxRectRepresentable({ sheetId: 0, r0: 0, c0: 5, r1: 10, c1: 4 })).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => assertXlsxRectRepresentable({ sheetId: 0, r0: 5, c0: 0, r1: 5, c1: 10 })).toThrowError(expect.objectContaining({ code: 'RANGE_EMPTY' }));
    expect(() => assertXlsxRectRepresentable({ sheetId: 0, r0: 0, c0: 5, r1: 10, c1: 5 })).toThrowError(expect.objectContaining({ code: 'RANGE_EMPTY' }));
  });

  it('validates rect shape, non-negative safe ints, rejects -0, extra/missing keys, and leaks', () => {
    for (const bad of [
      null, undefined, [], 'rect', { sheetId: -0, r0: 0, c0: 0, r1: 1, c1: 1 },
      { sheetId: 0, r0: -0, c0: 0, r1: 1, c1: 1 }, { sheetId: 0, r0: -1, c0: 0, r1: 1, c1: 1 },
      { sheetId: 0, r0: 1.5, c0: 0, r1: 1, c1: 1 }, { sheetId: 0, r0: NaN, c0: 0, r1: 1, c1: 1 },
      { sheetId: 0, r0: '0', c0: 0, r1: 1, c1: 1 }, { sheetId: 0, r0: 0, c0: 0, r1: 1 },
      { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 1, extra: 1 }
    ]) {
      expect(() => assertXlsxRectRepresentable(bad as any)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    }

    // Hostile getter / mutated error leaks
    const sneaky = { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 1, accessToken: 'synthetic' };
    Object.defineProperty(sneaky, 'r0', { enumerable: false });
    expect(() => assertXlsxRectRepresentable(sneaky)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    const mutated = new DomainError('RANGE_INVALID');
    mutated.message = 'SECRET_PASS';
    const hostile = {
      sheetId: 0, c0: 0, r1: 1, c1: 1,
      get r0(): number { throw mutated; }
    };
    try {
      assertXlsxRectRepresentable(hostile as any);
      expect.unreachable();
    } catch (e: any) {
      expect(e).not.toBe(mutated);
      expect(e.message).toBe(SAFE_ERROR_MESSAGES.RANGE_INVALID);
      expect(e.message).not.toContain('SECRET_PASS');
    }
  });

  it('validates text lengths 32767 vs 32768, paired emoji policy, and preserves input without mutation', () => {
    expect(XLSX_MAX_TEXT_UTF16_UNITS).toBe(32767);
    const text32767 = 'a'.repeat(32767);
    expect(() => assertXlsxTextRepresentable(text32767)).not.toThrow();
    expect(() => assertXlsxTextRepresentable(text32767 + 'a')).toThrowError(expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' }));

    // Paired emoji (2 UTF-16 units each): 16383 emoji + 1 ascii = 32767; 16384 emoji = 32768
    expect(() => assertXlsxTextRepresentable('😀')).not.toThrow();
    expect(() => assertXlsxTextRepresentable('😀'.repeat(16383) + 'x')).not.toThrow();
    expect(() => assertXlsxTextRepresentable('😀'.repeat(16384))).toThrowError(expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' }));

    // Preserved without mutation: leading zeros, spaces, CRLF
    const input = '  00123 \r\n\t ';
    assertXlsxTextRepresentable(input);
    expect(input).toBe('  00123 \r\n\t ');
  });

  it('validates XML1.0 char boundaries, rejects lone surrogates/controls, and protects secrets', () => {
    for (const valid of ['\t', '\n', '\r', ' ', '\uD7FF', '\uE000', '\uFFFD', '\u{10000}', '\u{10FFFF}']) {
      expect(() => assertXlsxTextRepresentable(valid)).not.toThrow();
    }

    for (const bad of [
      '\0', '\x01', '\x08', '\x0B', '\x0C', '\x1F', '\uFFFE', '\uFFFF',
      '\uD800', '\uDBFF', '\uDC00', '\uDFFF', '\uD800xyz', 'abc\uDC00'
    ]) {
      expect(() => assertXlsxTextRepresentable(bad)).toThrowError(expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' }));
    }

    for (const nonStr of [123, true, new Date(), { toString: () => 'abc' }, null, undefined]) {
      expect(() => assertXlsxTextRepresentable(nonStr as any)).toThrowError(expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' }));
    }

    try {
      assertXlsxTextRepresentable('\0');
    } catch (e: any) {
      expect(e.message).toBe(SAFE_ERROR_MESSAGES.FORMAT_UNSUPPORTED);
      expect(e.message).not.toContain('SECRET_LEAK');
    }
  });

  it('validates numbers: 15-digit screen, exponents, bounds, zeros +/-0, and rejects 16 digits/nonfinites', () => {
    expect(XLSX_MAX_SIGNIFICANT_DIGITS).toBe(15);
    for (const valid of [
      0, -0, 123456789012345, -123456789012345, 1234567890123450,
      0.1, 45678.5, 0.000012345, 1.23e20,
      XLSX_MIN_NUMERIC_MAGNITUDE, -XLSX_MIN_NUMERIC_MAGNITUDE,
      XLSX_MAX_NUMERIC_MAGNITUDE, -XLSX_MAX_NUMERIC_MAGNITUDE
    ]) {
      expect(() => assertXlsxNumberRepresentable(valid)).not.toThrow();
    }

    const testVal1 = 1e-308;
    const testVal2 = 1e308;
    const testVal3 = Number.MIN_VALUE;
    for (const bad of [
      1234567890123456, -1234567890123456, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER,
      0.30000000000000004, testVal1, -testVal1, testVal2, -testVal2,
      testVal3, -testVal3, NaN, Infinity, -Infinity,
      '123', '0', new Date(), null, undefined, {}
    ]) {
      expect(() => assertXlsxNumberRepresentable(bad as any)).toThrowError(
        expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' })
      );
    }
    expect(testVal1).toBe(1e-308);
    expect(testVal2).toBe(1e308);
    expect(testVal3).toBe(Number.MIN_VALUE);
  });

  it('validates line feeds: LF 253/254, CRLF 253 exact, and preserves input text', () => {
    expect(XLSX_MAX_LINE_FEEDS).toBe(253);
    expect(() => assertXlsxTextRepresentable('\n'.repeat(253))).not.toThrow();
    expect(() => assertXlsxTextRepresentable('\n'.repeat(254))).toThrowError(
      expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' })
    );
    expect(() => assertXlsxTextRepresentable('\r\n'.repeat(253))).not.toThrow();
    expect(() => assertXlsxTextRepresentable('\r\n'.repeat(254))).toThrowError(
      expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' })
    );
    const crlfText = 'row\r\n'.repeat(100);
    assertXlsxTextRepresentable(crlfText);
    expect(crlfText).toBe('row\r\n'.repeat(100));
  });
});
