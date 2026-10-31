import { describe, it, expect } from 'vitest';
import { projectCell } from '../../src/domain/cell';
import type { ExportMode, Cell } from '../../src/contracts/domain';

describe('T15a projectCell', () => {
  it('keeps display-only text, including explicit empty strings, without dropping unknown raw values', () => {
    for (const value of ['display-only', '']) {
      expect(projectCell({ formattedValue: value }, 2, 3, 'formatted')).toEqual({ r: 2, c: 3, kind: 'string', value });
      for (const mode of ['raw', 'formula_text'] as const) {
        expect(() => projectCell({ formattedValue: value }, 2, 3, mode)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
      }
    }
  });

  it('does not guess effective number format from user formatting', () => {
    expect(projectCell({ effectiveValue: { numberValue: 1 }, userEnteredFormat: { numberFormat: { type: 'DATE' } } }, 0, 0, 'raw')).toEqual({ r: 0, c: 0, kind: 'number', value: 1 });
  });

  it('rejects non-JSON records and unknown value variants instead of treating them as blank', () => {
    for (const input of [new Date(), new Map(), { effectiveValue: new Date() }, { effectiveValue: { futureValue: 'must not disappear' } }]) {
      expect(() => projectCell(input, 0, 0, 'raw')).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    }
  });
  const FIDELITY_CELLS: Array<{
    readonly r: number;
    readonly c: number;
    readonly input: unknown;
    readonly expected: Record<ExportMode, Cell | null>;
  }> = [
    {
      r: 0,
      c: 0,
      input: {
        userEnteredValue: { stringValue: 'A1 Header' },
        effectiveValue: { stringValue: 'A1 Header' },
        formattedValue: 'A1 Header'
      },
      expected: {
        raw: { r: 0, c: 0, kind: 'string', value: 'A1 Header' },
        formatted: { r: 0, c: 0, kind: 'string', value: 'A1 Header' },
        formula_text: { r: 0, c: 0, kind: 'string', value: 'A1 Header' }
      }
    },
    {
      r: 49,
      c: 3,
      input: {
        userEnteredValue: { numberValue: 42.5 },
        effectiveValue: { numberValue: 42.5 },
        formattedValue: '$42.50'
      },
      expected: {
        raw: { r: 49, c: 3, kind: 'number', value: 42.5 },
        formatted: { r: 49, c: 3, kind: 'string', value: '$42.50' },
        formula_text: { r: 49, c: 3, kind: 'number', value: 42.5 }
      }
    },
    {
      r: 89999,
      c: 25,
      input: {
        userEnteredValue: { boolValue: true },
        effectiveValue: { boolValue: true },
        formattedValue: 'TRUE'
      },
      expected: {
        raw: { r: 89999, c: 25, kind: 'boolean', value: true },
        formatted: { r: 89999, c: 25, kind: 'string', value: 'TRUE' },
        formula_text: { r: 89999, c: 25, kind: 'boolean', value: true }
      }
    },
    {
      r: 4,
      c: 2,
      input: {
        userEnteredValue: { stringValue: 'Anchor Cell C5' },
        effectiveValue: { stringValue: 'Anchor Cell C5' },
        formattedValue: 'Anchor Cell C5'
      },
      expected: {
        raw: { r: 4, c: 2, kind: 'string', value: 'Anchor Cell C5' },
        formatted: { r: 4, c: 2, kind: 'string', value: 'Anchor Cell C5' },
        formula_text: { r: 4, c: 2, kind: 'string', value: 'Anchor Cell C5' }
      }
    },
    {
      r: 4,
      c: 3,
      input: {},
      expected: { raw: null, formatted: null, formula_text: null }
    },
    {
      r: 4,
      c: 4,
      input: {
        userEnteredValue: { stringValue: '' },
        effectiveValue: { stringValue: '' },
        formattedValue: ''
      },
      expected: {
        raw: { r: 4, c: 4, kind: 'string', value: '' },
        formatted: { r: 4, c: 4, kind: 'string', value: '' },
        formula_text: { r: 4, c: 4, kind: 'string', value: '' }
      }
    },
    {
      r: 5,
      c: 2,
      input: {
        userEnteredValue: { numberValue: 45200 },
        effectiveValue: { numberValue: 45200 },
        formattedValue: '2023-10-01',
        effectiveFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } }
      },
      expected: {
        raw: { r: 5, c: 2, kind: 'number', value: 45200, numberFormatType: 'DATE' },
        formatted: { r: 5, c: 2, kind: 'string', value: '2023-10-01', numberFormatType: 'DATE' },
        formula_text: { r: 5, c: 2, kind: 'number', value: 45200, numberFormatType: 'DATE' }
      }
    },
    {
      r: 5,
      c: 3,
      input: {
        userEnteredValue: { formulaValue: '=SUM(10, 20)' },
        effectiveValue: { numberValue: 30 },
        formattedValue: '30'
      },
      expected: {
        raw: { r: 5, c: 3, kind: 'number', value: 30 },
        formatted: { r: 5, c: 3, kind: 'string', value: '30' },
        formula_text: { r: 5, c: 3, kind: 'string', value: '=SUM(10, 20)', formulaText: '=SUM(10, 20)' }
      }
    },
    {
      r: 5,
      c: 4,
      input: {
        userEnteredValue: { formulaValue: '=IF(TRUE, "", "fallback")' },
        effectiveValue: { stringValue: '' },
        formattedValue: ''
      },
      expected: {
        raw: { r: 5, c: 4, kind: 'string', value: '' },
        formatted: { r: 5, c: 4, kind: 'string', value: '' },
        formula_text: { r: 5, c: 4, kind: 'string', value: '=IF(TRUE, "", "fallback")', formulaText: '=IF(TRUE, "", "fallback")' }
      }
    },
    {
      r: 5,
      c: 5,
      input: {
        userEnteredValue: { formulaValue: '=1/0' },
        effectiveValue: {
          errorValue: { type: 'DIVIDE_BY_ZERO', message: 'Evaluation Error: divide by zero' }
        },
        formattedValue: '#DIV/0!'
      },
      expected: {
        raw: { r: 5, c: 5, kind: 'error', value: { code: 'DIVIDE_BY_ZERO', message: 'Evaluation Error: divide by zero' } },
        formatted: { r: 5, c: 5, kind: 'string', value: '#DIV/0!' },
        formula_text: { r: 5, c: 5, kind: 'string', value: '=1/0', formulaText: '=1/0' }
      }
    }
  ];

  it('projects all reviewed oracle cells across raw, formatted, and formula_text modes', () => {
    const modes: ExportMode[] = ['raw', 'formatted', 'formula_text'];
    for (const cell of FIDELITY_CELLS) {
      for (const mode of modes) {
        const result = projectCell(cell.input, cell.r, cell.c, mode);
        expect(result).toEqual(cell.expected[mode]);
      }
    }
  });

  it('handles scalars, blanks, format-only, and ordinary formula-like strings', () => {
    // Formatting-only cell returns null
    const fmtOnly = { effectiveFormat: { numberFormat: { type: 'CURRENCY' } } };
    expect(projectCell(fmtOnly, 1, 1, 'raw')).toBeNull();
    expect(projectCell(fmtOnly, 1, 1, 'formatted')).toBeNull();
    expect(projectCell(fmtOnly, 1, 1, 'formula_text')).toBeNull();

    // Bool false, zero, negative number
    const boolFalse = { effectiveValue: { boolValue: false }, formattedValue: 'FALSE' };
    expect(projectCell(boolFalse, 0, 0, 'raw')).toEqual({ r: 0, c: 0, kind: 'boolean', value: false });
    const numZero = { effectiveValue: { numberValue: 0 }, formattedValue: '0' };
    expect(projectCell(numZero, 0, 1, 'raw')).toEqual({ r: 0, c: 1, kind: 'number', value: 0 });
    const negNum = { effectiveValue: { numberValue: -123.45 }, formattedValue: '-123.45' };
    expect(projectCell(negNum, 0, 2, 'raw')).toEqual({ r: 0, c: 2, kind: 'number', value: -123.45 });

    // Stays numeric serial, never cast to Date
    const dateCell = projectCell(
      { effectiveValue: { numberValue: 45200 }, formattedValue: '2023-10-01', effectiveFormat: { numberFormat: { type: 'DATE' } } },
      2,
      2,
      'raw'
    );
    expect(dateCell).toEqual({ r: 2, c: 2, kind: 'number', value: 45200, numberFormatType: 'DATE' });
    expect(typeof (dateCell as { value: unknown }).value).toBe('number');

    // Ordinary string starting with = is never formula metadata unless explicit formulaValue
    const fakeFormula = {
      userEnteredValue: { stringValue: '=SUM(A1:A2)' },
      effectiveValue: { stringValue: '=SUM(A1:A2)' },
      formattedValue: '=SUM(A1:A2)'
    };
    const projected = projectCell(fakeFormula, 3, 3, 'formula_text');
    expect(projected).toEqual({ r: 3, c: 3, kind: 'string', value: '=SUM(A1:A2)' });
    expect('formulaText' in (projected ?? {})).toBe(false);

    // Tagged error cell without formula yields error cell in formula_text mode
    const taggedErr = {
      effectiveValue: { errorValue: { type: 'N_A', message: 'Error N/A' } },
      formattedValue: '#N/A'
    };
    expect(projectCell(taggedErr, 4, 4, 'formula_text')).toEqual({
      r: 4,
      c: 4,
      kind: 'error',
      value: { code: 'N_A', message: 'Error N/A' }
    });
  });

  it('preserves exact Unicode, leading zeros, CRLF, and token-resembling strings without leakage', () => {
    const rawTokens = [
      '00123',
      'ya29.a0AfH6SMB_secret_access_token_12345',
      'Bearer ya29.token_string',
      'Xin chào thế giới ☕ 🚀 日本語',
      'line1\r\nline2 with "quotes" and \'single\''
    ];
    for (const str of rawTokens) {
      const input = { effectiveValue: { stringValue: str }, formattedValue: str };
      const res = projectCell(input, 10, 20, 'raw');
      expect(res).toEqual({ r: 10, c: 20, kind: 'string', value: str });
      expect((res as { value: string }).value).toBe(str);
    }
  });

  it('never spreads raw API properties and never mutates input', () => {
    const unselected = Object.freeze({
      effectiveValue: Object.freeze({ numberValue: 1 }),
      formattedValue: '1',
      hyperlink: 'https://malicious.example.com',
      note: 'private author note',
      textFormatRuns: [{ startIndex: 0 }],
      authHeader: 'Bearer secret_token'
    });
    const res = projectCell(unselected, 0, 0, 'raw');
    expect(res).toEqual({ r: 0, c: 0, kind: 'number', value: 1 });
    expect(Object.keys(res ?? {})).toEqual(['r', 'c', 'kind', 'value']);
  });

  it('rejects invalid coordinates with RANGE_INVALID', () => {
    const valid = { effectiveValue: { numberValue: 1 } };
    const invalidCoords: Array<[number, number]> = [
      [-1, 0],
      [0, -1],
      [-0, 0],
      [0, -0],
      [1.5, 0],
      [0, 2.7],
      [NaN, 0],
      [0, Infinity],
      [Number.MAX_SAFE_INTEGER + 1, 0]
    ];
    for (const [r, c] of invalidCoords) {
      expect(() => projectCell(valid, r, c, 'raw')).toThrowError(
        expect.objectContaining({ code: 'RANGE_INVALID' })
      );
    }
  });

  it('rejects malformed inputs, unions, nonfinites, and missing representations with SOURCE_UNSUPPORTED', () => {
    const invalids: unknown[] = [
      null,
      undefined,
      'invalid',
      42,
      [],
      // Union with multiple value members
      { effectiveValue: { numberValue: 1, stringValue: '1' } },
      // formulaValue on effectiveValue
      { effectiveValue: { formulaValue: '=1+1' } },
      // Nonfinite numbers
      { effectiveValue: { numberValue: NaN } },
      { effectiveValue: { numberValue: Infinity } },
      { effectiveValue: { numberValue: -Infinity } },
      // Wrong types
      { effectiveValue: { numberValue: 'not a number' } },
      { effectiveValue: { stringValue: 123 } },
      { effectiveValue: { boolValue: 'true' } },
      { effectiveValue: { errorValue: 'DIV0' } },
      { effectiveValue: { errorValue: { type: 1, message: 'm' } } },
      { effectiveValue: { errorValue: { type: 'T', message: 2 } } },
      { effectiveValue: { numberValue: 1 }, formattedValue: 123 },
      { effectiveValue: { numberValue: 1 }, effectiveFormat: { numberFormat: { type: 42 } } },
      // userEnteredValue has multiple members
      { userEnteredValue: { formulaValue: '=1', numberValue: 1 }, effectiveValue: { numberValue: 1 } }
    ];
    for (const input of invalids) {
      expect(() => projectCell(input, 0, 0, 'raw')).toThrowError(
        expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' })
      );
    }

    // Missing needed representations
    // 1. Missing formattedValue in formatted mode
    expect(() =>
      projectCell({ effectiveValue: { numberValue: 10 } }, 0, 0, 'formatted')
    ).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // 2. userEnteredValue has value, but effective representation missing in raw mode
    expect(() =>
      projectCell({ userEnteredValue: { formulaValue: '=1+1' } }, 0, 0, 'raw')
    ).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    expect(() =>
      projectCell({ userEnteredValue: { numberValue: 5 } }, 0, 0, 'raw')
    ).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // Invalid mode
    expect(() => projectCell({ effectiveValue: { numberValue: 1 } }, 0, 0, 'unknown' as ExportMode)).toThrowError(
      expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' })
    );
  });
});
