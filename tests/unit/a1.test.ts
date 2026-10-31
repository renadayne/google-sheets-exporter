/**
 * T12 Unit Tests: Pure A1 Parsing and Canonical Bounds Resolution
 *
 * Verifies strict parsing, zero-based half-open rectangular coordinates,
 * grid bounds resolution, sheet prefix validation, and safe domain errors.
 *
 * Rules:
 * - Exact expected Rect literals only; never use production conversion helpers to build oracles.
 * - Independent expected values for Z/AA/AZ/BA column transitions and row coordinates.
 * - No allocated dense arrays.
 * - Negative tests verify DomainError code and assert raw inputs are never echoed in error messages.
 * - Preservation of input metadata (Object.freeze test).
 */

import { describe, it, expect } from 'vitest';
import { parseA1 } from '../../src/source/a1.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import type { SheetMeta } from '../../src/contracts/domain.ts';
import { createCanonicalWorkbookMeta } from '../helpers/fixtures.ts';

describe('T12 parseA1: Pure A1 Notation Parser and Bounds Resolution', () => {
  it('rejects negative sheet IDs and terminal line breaks', () => {
    const sheet = createCanonicalWorkbookMeta().sheets[0];
    expect(() => parseA1('A1', { ...sheet, id: -1 })).toThrowError(
      expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' })
    );
    for (const input of ['A1\n', 'A1\r', 'A1\u2028', 'A:B\n', '1:2\n']) {
      expect(() => parseA1(input, sheet)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    }
  });

  it('supports every safe row endpoint and safe 11-letter columns without format caps', () => {
    const sheet = { ...createCanonicalWorkbookMeta().sheets[0], rows: Number.MAX_SAFE_INTEGER, columns: Number.MAX_SAFE_INTEGER };
    expect(parseA1('A9007199254740991', sheet)).toEqual({ sheetId: 101, r0: 9007199254740990, c0: 0, r1: 9007199254740991, c1: 1 });
    expect(parseA1('AAAAAAAAAAA1', sheet)).toEqual({ sheetId: 101, r0: 0, c0: 146813779479510, r1: 1, c1: 146813779479511 });
    expect(() => parseA1('A9007199254740992', sheet)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
  });
  // Use canonical fixtures from T10a
  const workbook = createCanonicalWorkbookMeta();
  const sparseTab = workbook.sheets[0]; // id: 101, title: 'SparseTab', rows: 90000, columns: 26 (A-Z)
  const emptyTab = workbook.sheets[1];  // id: 205, title: 'EmptyTab', rows: 1000, columns: 26
  const hiddenTab = workbook.sheets[2]; // id: 309, title: 'HiddenTab', rows: 100, columns: 10

  // Mock wider grid sheet for multi-letter column transitions (up to AAA / 1000 columns)
  const wideSheet: SheetMeta = Object.freeze({
    id: 501,
    title: 'WideTab',
    index: 3,
    type: 'GRID',
    hidden: false,
    rows: 1000,
    columns: 1000
  });

  // Mock ultra-large grid sheet exceeding Excel limits (1,048,576 rows, 16,384 columns)
  // to prove no hard Excel caps are enforced
  const ultraLargeSheet: SheetMeta = Object.freeze({
    id: 777,
    title: 'UltraTab',
    index: 4,
    type: 'GRID',
    hidden: false,
    rows: 2_000_000,
    columns: 20_000
  });

  describe('Single cell coordinates and case insensitivity', () => {
    it('resolves A1 to [0, 1) x [0, 1)', () => {
      const result = parseA1('A1', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 0,
        r1: 1,
        c1: 1
      });
    });

    it('resolves lowercase a1 identically to A1', () => {
      const result = parseA1('a1', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 0,
        r1: 1,
        c1: 1
      });
    });

    it('resolves exact last allocated cell Z90000 on SparseTab', () => {
      const result = parseA1('Z90000', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 89999,
        c0: 25,
        r1: 90000,
        c1: 26
      });
    });

    it('resolves lowercase z90000 on SparseTab', () => {
      const result = parseA1('z90000', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 89999,
        c0: 25,
        r1: 90000,
        c1: 26
      });
    });

    it('resolves single cell with absolute $ notations: $A$1, $A1, A$1', () => {
      expect(parseA1('$A$1', sparseTab)).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 0,
        r1: 1,
        c1: 1
      });
      expect(parseA1('$A1', sparseTab)).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 0,
        r1: 1,
        c1: 1
      });
      expect(parseA1('A$1', sparseTab)).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 0,
        r1: 1,
        c1: 1
      });
    });
  });

  describe('Bounded rectangles: C5:D6 and exact coordinates', () => {
    it('resolves C5:D6 to r0=4, c0=2, r1=6, c1=4', () => {
      const result = parseA1('C5:D6', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 4,
        c0: 2,
        r1: 6,
        c1: 4
      });
    });

    it('resolves lowercase c5:d6', () => {
      const result = parseA1('c5:d6', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 4,
        c0: 2,
        r1: 6,
        c1: 4
      });
    });

    it('resolves $C$5:$D$6 with absolute signs', () => {
      const result = parseA1('$C$5:$D$6', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 4,
        c0: 2,
        r1: 6,
        c1: 4
      });
    });

    it('resolves identical start and end cell C5:C5 as single-cell rectangle', () => {
      const result = parseA1('C5:C5', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 4,
        c0: 2,
        r1: 5,
        c1: 3
      });
    });

    it('resolves A1:Z90000 spanning the entire allocated SparseTab grid', () => {
      const result = parseA1('A1:Z90000', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 0,
        r1: 90000,
        c1: 26
      });
    });
  });

  describe('Column transitions: Z, AA, AZ, BA, ZZ, AAA', () => {
    // Independent expected column indices (0-based):
    // Z   -> 25
    // AA  -> 26
    // AZ  -> 51
    // BA  -> 52
    // ZZ  -> 701
    // AAA -> 702
    it('resolves boundary transitions Z1 and AA1', () => {
      expect(parseA1('Z1', wideSheet)).toEqual({
        sheetId: 501,
        r0: 0,
        c0: 25,
        r1: 1,
        c1: 26
      });
      expect(parseA1('AA1', wideSheet)).toEqual({
        sheetId: 501,
        r0: 0,
        c0: 26,
        r1: 1,
        c1: 27
      });
    });

    it('resolves boundary transitions AZ1 and BA1', () => {
      expect(parseA1('AZ1', wideSheet)).toEqual({
        sheetId: 501,
        r0: 0,
        c0: 51,
        r1: 1,
        c1: 52
      });
      expect(parseA1('BA1', wideSheet)).toEqual({
        sheetId: 501,
        r0: 0,
        c0: 52,
        r1: 1,
        c1: 53
      });
    });

    it('resolves boundary transitions ZZ1 and AAA1', () => {
      expect(parseA1('ZZ1', wideSheet)).toEqual({
        sheetId: 501,
        r0: 0,
        c0: 701,
        r1: 1,
        c1: 702
      });
      expect(parseA1('AAA1', wideSheet)).toEqual({
        sheetId: 501,
        r0: 0,
        c0: 702,
        r1: 1,
        c1: 703
      });
    });

    it('resolves whole-column range spanning Z:AA transition', () => {
      expect(parseA1('Z:AA', wideSheet)).toEqual({
        sheetId: 501,
        r0: 0,
        c0: 25,
        r1: 1000,
        c1: 27
      });
    });

    it('resolves whole-column range spanning AZ:BA transition', () => {
      expect(parseA1('AZ:BA', wideSheet)).toEqual({
        sheetId: 501,
        r0: 0,
        c0: 51,
        r1: 1000,
        c1: 53
      });
    });
  });

  describe('Whole-column range expansion', () => {
    it('resolves B:D to span all allocated rows on SparseTab', () => {
      const result = parseA1('B:D', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 1,
        r1: 90000,
        c1: 4
      });
    });

    it('resolves single whole-column A:A', () => {
      const result = parseA1('A:A', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 0,
        r1: 90000,
        c1: 1
      });
    });

    it('resolves whole column with $ notation $B:$D', () => {
      const result = parseA1('$B:$D', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 1,
        r1: 90000,
        c1: 4
      });
    });

    it('resolves whole-column on EmptyTab with 1000 rows', () => {
      const result = parseA1('B:D', emptyTab);
      expect(result).toEqual({
        sheetId: 205,
        r0: 0,
        c0: 1,
        r1: 1000,
        c1: 4
      });
    });
  });

  describe('Whole-row range expansion', () => {
    it('resolves 5:6 to span all allocated columns on SparseTab', () => {
      const result = parseA1('5:6', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 4,
        c0: 0,
        r1: 6,
        c1: 26
      });
    });

    it('resolves single whole-row 1:1', () => {
      const result = parseA1('1:1', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 0,
        r1: 1,
        c1: 26
      });
    });

    it('resolves whole row with $ notation $5:$6', () => {
      const result = parseA1('$5:$6', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 4,
        c0: 0,
        r1: 6,
        c1: 26
      });
    });

    it('resolves whole-row on HiddenTab with 10 columns', () => {
      const result = parseA1('5:6', hiddenTab);
      expect(result).toEqual({
        sheetId: 309,
        r0: 4,
        c0: 0,
        r1: 6,
        c1: 10
      });
    });
  });

  describe('Sheet title prefixes: unquoted and quoted with Unicode/apostrophes/!', () => {
    it('matches exact unquoted simple sheet prefix SparseTab!A1', () => {
      const result = parseA1('SparseTab!A1', sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 0,
        r1: 1,
        c1: 1
      });
    });

    it('matches exact quoted sheet prefix \'SparseTab\'!A1', () => {
      const result = parseA1("'SparseTab'!A1", sparseTab);
      expect(result).toEqual({
        sheetId: 101,
        r0: 0,
        c0: 0,
        r1: 1,
        c1: 1
      });
    });

    it('matches quoted sheet with doubled apostrophes, emoji, and literal ! inside title', () => {
      const complexSheet: SheetMeta = Object.freeze({
        id: 888,
        title: "O'Brien !😀",
        index: 5,
        type: 'GRID',
        hidden: false,
        rows: 50,
        columns: 10
      });

      const result = parseA1("'O''Brien !😀'!$A$1", complexSheet);
      expect(result).toEqual({
        sheetId: 888,
        r0: 0,
        c0: 0,
        r1: 1,
        c1: 1
      });
    });

    it('matches quoted sheet with spaces and punctuation: \'Café & Data!\'!C5:D6', () => {
      const punctuationSheet: SheetMeta = Object.freeze({
        id: 889,
        title: 'Café & Data!',
        index: 6,
        type: 'GRID',
        hidden: false,
        rows: 100,
        columns: 10
      });

      const result = parseA1("'Café & Data!'!C5:D6", punctuationSheet);
      expect(result).toEqual({
        sheetId: 889,
        r0: 4,
        c0: 2,
        r1: 6,
        c1: 4
      });
    });

    it('matches unquoted Unicode sheet title prefix Bảng_1!B:D', () => {
      const unicodeSheet: SheetMeta = Object.freeze({
        id: 890,
        title: 'Bảng_1',
        index: 7,
        type: 'GRID',
        hidden: false,
        rows: 100,
        columns: 10
      });

      const result = parseA1('Bảng_1!B:D', unicodeSheet);
      expect(result).toEqual({
        sheetId: 890,
        r0: 0,
        c0: 1,
        r1: 100,
        c1: 4
      });
    });
  });

  describe('No hard Excel caps (mocked large GRID sheet)', () => {
    it('resolves coordinates far beyond Excel row cap 1048576', () => {
      const result = parseA1('A1500000', ultraLargeSheet);
      expect(result).toEqual({
        sheetId: 777,
        r0: 1499999,
        c0: 0,
        r1: 1500000,
        c1: 1
      });
    });

    it('resolves column XFE (index 16384) exceeding Excel column cap XFD (16384)', () => {
      // X = 24, F = 6, E = 5 -> (24 * 26^2 + 6 * 26 + 5) - 1 = 16385 - 1 = 16384
      const result = parseA1('XFE1', ultraLargeSheet);
      expect(result).toEqual({
        sheetId: 777,
        r0: 0,
        c0: 16384,
        r1: 1,
        c1: 16385
      });
    });

    it('resolves whole-column range XFE:XFE spanning 2,000,000 rows', () => {
      const result = parseA1('XFE:XFE', ultraLargeSheet);
      expect(result).toEqual({
        sheetId: 777,
        r0: 0,
        c0: 16384,
        r1: 2000000,
        c1: 16385
      });
    });
  });

  describe('Input immutability and metadata preservation', () => {
    it('does not mutate the input SheetMeta object', () => {
      const sheetCopy: SheetMeta = {
        id: 101,
        title: 'SparseTab',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: 90000,
        columns: 26
      };
      Object.freeze(sheetCopy);

      expect(() => parseA1('A1:B2', sheetCopy)).not.toThrow();
      expect(sheetCopy.id).toBe(101);
      expect(sheetCopy.rows).toBe(90000);
      expect(sheetCopy.columns).toBe(26);
    });
  });

  describe('Negative: RANGE_INVALID for syntax, prefix mismatch, and unsupported formats', () => {
    function expectRangeInvalid(input: string, sheet: SheetMeta = sparseTab): void {
      try {
        parseA1(input, sheet);
        expect.unreachable(`Expected RANGE_INVALID for input: ${input}`);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(DomainError);
        const domainErr = err as DomainError;
        expect(domainErr.code).toBe('RANGE_INVALID');
        if (typeof input === 'string' && input.length > 0 && input.trim().length > 0) {
          expect(domainErr.message).not.toContain(input);
        }
      }
    }

    it('rejects empty string and whitespace-only strings', () => {
      expectRangeInvalid('');
      expectRangeInvalid('   ');
      expectRangeInvalid('\t\n');
    });

    it('rejects single bare column tokens (ambiguous named ranges)', () => {
      expectRangeInvalid('A');
      expectRangeInvalid('$A');
      expectRangeInvalid('B');
      expectRangeInvalid('AA');
    });

    it('rejects single bare row tokens (ambiguous named ranges)', () => {
      expectRangeInvalid('1');
      expectRangeInvalid('$1');
      expectRangeInvalid('5');
      expectRangeInvalid('90000');
    });

    it('rejects named ranges', () => {
      expectRangeInvalid('SalesTotal');
      expectRangeInvalid('MyRange');
      expectRangeInvalid('TAX_RATE');
    });

    it('rejects R1C1 notation', () => {
      expectRangeInvalid('R1C1');
      expectRangeInvalid('R1C1:R5C5');
      expectRangeInvalid('R[1]C[1]');
    });

    it('rejects reversed endpoints', () => {
      expectRangeInvalid('D:B');     // reversed columns
      expectRangeInvalid('6:5');     // reversed rows
      expectRangeInvalid('D5:C4');   // reversed row and col
      expectRangeInvalid('D5:C5');   // reversed col, same row
      expectRangeInvalid('C6:C5');   // reversed row, same col
    });

    it('rejects mixed endpoint kinds', () => {
      expectRangeInvalid('A1:B');
      expectRangeInvalid('A:B2');
      expectRangeInvalid('1:A2');
      expectRangeInvalid('A1:2');
      expectRangeInvalid('A:5');
      expectRangeInvalid('5:A');
    });

    it('rejects unions, comma, and semicolon', () => {
      expectRangeInvalid('A1,B2');
      expectRangeInvalid('A1;B2');
      expectRangeInvalid('A1:B2,C3:D4');
      expectRangeInvalid('A1:B2;C3:D4');
    });

    it('rejects mismatched sheet prefix', () => {
      expectRangeInvalid('EmptyTab!A1', sparseTab);
      expectRangeInvalid("'EmptyTab'!A1", sparseTab);
      expectRangeInvalid('NonExistent!A1', sparseTab);
    });

    it('rejects cross-sheet ranges', () => {
      expectRangeInvalid("'SparseTab'!A1:'EmptyTab'!B2", sparseTab);
      expectRangeInvalid("'SparseTab'!A1:EmptyTab!B2", sparseTab);
      expectRangeInvalid('SparseTab!A1:EmptyTab!B2', sparseTab);
    });

    it('rejects malformed quotes and unquoted spaces/punctuation', () => {
      expectRangeInvalid("'SparseTab!A1");                  // unterminated quote
      expectRangeInvalid("'SparseTab'A1");                   // missing ! after quote
      expectRangeInvalid("''!A1");                           // empty quoted sheet title
      expectRangeInvalid("'SparseTab''!A1");                 // trailing unclosed escaped quote
      expectRangeInvalid("O'Brien !😀!$A$1", wideSheet);     // unquoted with apostrophe/space/emoji
    });

    it('rejects malformed $ notation', () => {
      expectRangeInvalid('$$A1');
      expectRangeInvalid('A$$1');
      expectRangeInvalid('A1$');
      expectRangeInvalid('$A$1$');
      expectRangeInvalid('$$B');
      expectRangeInvalid('B$');
      expectRangeInvalid('$$5');
      expectRangeInvalid('5$');
      expectRangeInvalid('$');
    });

    it('rejects zero, negative, and decimal rows', () => {
      expectRangeInvalid('A0');
      expectRangeInvalid('A-1');
      expectRangeInvalid('0:5');
      expectRangeInvalid('-1:5');
      expectRangeInvalid('A01');
      expectRangeInvalid('A1.5');
    });

    it('rejects giant digit and letter strings exceeding safe integers', () => {
      expectRangeInvalid(`A${'9'.repeat(30)}`);
      expectRangeInvalid(`${'Z'.repeat(30)}1`);
      expectRangeInvalid(`1:${'9'.repeat(30)}`);
      expectRangeInvalid(`A:${'Z'.repeat(30)}`);
    });

    it('rejects workbook external references', () => {
      expectRangeInvalid('[Workbook.xlsx]Sheet1!A1');
      expectRangeInvalid('[Book1]!A1');
    });

    it('rejects non-string input type', () => {
      expectRangeInvalid(null as unknown as string);
      expectRangeInvalid(undefined as unknown as string);
      expectRangeInvalid(123 as unknown as string);
    });
  });

  describe('Negative: RANGE_OUT_OF_BOUNDS for coordinates outside sheet bounds', () => {
    function expectRangeOutOfBounds(input: string, sheet: SheetMeta = sparseTab): void {
      try {
        parseA1(input, sheet);
        expect.unreachable(`Expected RANGE_OUT_OF_BOUNDS for input: ${input}`);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(DomainError);
        const domainErr = err as DomainError;
        expect(domainErr.code).toBe('RANGE_OUT_OF_BOUNDS');
        expect(domainErr.message).not.toContain(input);
      }
    }

    it('rejects cell column beyond sheet bounds (SparseTab has 26 columns: A-Z)', () => {
      expectRangeOutOfBounds('AA1', sparseTab); // col AA is index 26 >= 26
    });

    it('rejects cell row beyond sheet bounds (SparseTab has 90,000 rows)', () => {
      expectRangeOutOfBounds('A90001', sparseTab);
      expectRangeOutOfBounds('Z90001', sparseTab);
    });

    it('rejects rectangle endpoint exceeding columns or rows', () => {
      expectRangeOutOfBounds('A1:AA10', sparseTab);
      expectRangeOutOfBounds('A1:Z90001', sparseTab);
    });

    it('rejects whole-column range exceeding sheet columns', () => {
      expectRangeOutOfBounds('AA:AB', sparseTab);
      expectRangeOutOfBounds('A:AA', sparseTab);
    });

    it('rejects whole-row range exceeding sheet rows', () => {
      expectRangeOutOfBounds('90001:90002', sparseTab);
      expectRangeOutOfBounds('1:90001', sparseTab);
    });

    it('rejects out of bounds on small sheet (HiddenTab: rows 100, cols 10)', () => {
      expectRangeOutOfBounds('K1', hiddenTab);  // col K is 10 >= 10
      expectRangeOutOfBounds('A101', hiddenTab); // row 101 is 100 >= 100
    });
  });

  describe('Negative: SOURCE_UNSUPPORTED for invalid or non-GRID sheet metadata', () => {
    function expectSourceUnsupported(sheet: SheetMeta): void {
      try {
        parseA1('A1', sheet);
        expect.unreachable('Expected SOURCE_UNSUPPORTED for invalid sheet');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(DomainError);
        const domainErr = err as DomainError;
        expect(domainErr.code).toBe('SOURCE_UNSUPPORTED');
      }
    }

    it('rejects non-GRID sheet types OBJECT and DATA_SOURCE', () => {
      expectSourceUnsupported({
        id: 991,
        title: 'ChartSheet',
        index: 0,
        type: 'OBJECT',
        hidden: false,
        rows: 100,
        columns: 10
      });
      expectSourceUnsupported({
        id: 992,
        title: 'BigQueryTab',
        index: 0,
        type: 'DATA_SOURCE',
        hidden: false,
        rows: 100,
        columns: 10
      });
    });

    it('rejects missing or undefined dimensions', () => {
      expectSourceUnsupported({
        id: 993,
        title: 'MissingRows',
        index: 0,
        type: 'GRID',
        hidden: false,
        columns: 10
      });
      expectSourceUnsupported({
        id: 994,
        title: 'MissingCols',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: 100
      });
    });

    it('rejects zero or negative dimensions', () => {
      expectSourceUnsupported({
        id: 995,
        title: 'ZeroRows',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: 0,
        columns: 10
      });
      expectSourceUnsupported({
        id: 996,
        title: 'ZeroCols',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: 100,
        columns: 0
      });
      expectSourceUnsupported({
        id: 997,
        title: 'NegativeRows',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: -10,
        columns: 10
      });
    });

    it('rejects non-integer, NaN, or non-safe integer dimensions', () => {
      expectSourceUnsupported({
        id: 998,
        title: 'FloatRows',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: 10.5,
        columns: 10
      });
      expectSourceUnsupported({
        id: 999,
        title: 'NaNRows',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: Number.NaN,
        columns: 10
      });
      expectSourceUnsupported({
        id: 1000,
        title: 'InfRows',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: Number.POSITIVE_INFINITY,
        columns: 10
      });
    });

    it('rejects null or non-object sheet parameter', () => {
      expectSourceUnsupported(null as unknown as SheetMeta);
      expectSourceUnsupported(undefined as unknown as SheetMeta);
    });
  });
});
