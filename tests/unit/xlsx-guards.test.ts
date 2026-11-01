import { describe, it, expect } from 'vitest';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import {
  XLSX_MAX_ROWS,
  XLSX_MAX_COLUMNS,
  XLSX_MAX_TEXT_UTF16_UNITS,
  assertXlsxRectRepresentable,
  assertXlsxTextRepresentable
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
});
