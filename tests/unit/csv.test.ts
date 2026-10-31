import { describe, it, expect, vi } from 'vitest';
import { parse } from 'csv-parse/sync';
import { encodeCsv, PROVISIONAL_MAX_CSV_BYTES, type EncodeCsvOptions } from '../../src/export/csv.ts';
import type { Cell, Rect } from '../../src/contracts/domain.ts';

function parseCsv(bytes: Uint8Array): string[][] {
  return parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
    bom: true,
    columns: false,
    cast: false,
    skip_empty_lines: false,
    record_delimiter: '\r\n'
  });
}

function createOptions(maxBytes = PROVISIONAL_MAX_CSV_BYTES, signal = new AbortController().signal): EncodeCsvOptions {
  return { maxBytes, signal };
}

describe('T26 Safe Single-Rectangle CSV Row Encoder', () => {
  it('encodes exact Unicode, commas, quotes, CRLF, tabs, and whitespace preserving 00123', () => {
    const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 7 };
    const cells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: '00123' },
      { r: 0, c: 1, kind: 'string', value: 'café 🌟' },
      { r: 0, c: 2, kind: 'string', value: 'a,b,c' },
      { r: 0, c: 3, kind: 'string', value: 'He said "Hello"!' },
      { r: 0, c: 4, kind: 'string', value: 'Line1\r\nLine2' },
      { r: 0, c: 5, kind: 'string', value: 'col1\tcol2' },
      { r: 0, c: 6, kind: 'string', value: '   surrounded by spaces   ' }
    ];

    const res = encodeCsv(rect, cells, createOptions());
    expect(res.policy).toBe('apostrophe_prefix_v1');
    expect(res.transformedCells).toBe(0);

    const parsed = parseCsv(res.bytes);
    expect(parsed).toEqual([[
      '00123',
      'café 🌟',
      'a,b,c',
      'He said "Hello"!',
      'Line1\r\nLine2',
      'col1\tcol2',
      '   surrounded by spaces   '
    ]]);
  });

  it('handles full blank gaps and nonzero-origin rectangle C5:D6 emitting 2x2', () => {
    // C5:D6 is r0=4, c0=2, r1=6, c1=4
    const rect: Rect = { sheetId: 1, r0: 4, c0: 2, r1: 6, c1: 4 };
    const cells: Cell[] = [
      { r: 4, c: 2, kind: 'string', value: 'top-left' },
      { r: 5, c: 3, kind: 'string', value: 'bottom-right' }
    ];

    const res = encodeCsv(rect, cells, createOptions());
    const parsed = parseCsv(res.bytes);

    expect(parsed).toEqual([
      ['top-left', ''],
      ['', 'bottom-right']
    ]);
  });

  it('formats typed numeric negatives without prefix, booleans TRUE/FALSE, dates, and inert error text', () => {
    const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 5 };
    const cells: Cell[] = [
      { r: 0, c: 0, kind: 'number', value: -42 },
      { r: 0, c: 1, kind: 'boolean', value: true },
      { r: 0, c: 2, kind: 'boolean', value: false },
      { r: 0, c: 3, kind: 'number', value: 45678.5, numberFormatType: 'DATE_TIME' },
      { r: 0, c: 4, kind: 'error', value: { code: '#DIV/0!', message: 'Division by zero' } }
    ];

    const res = encodeCsv(rect, cells, createOptions());
    expect(res.transformedCells).toBe(0);

    const parsed = parseCsv(res.bytes);
    expect(parsed).toEqual([['-42', 'TRUE', 'FALSE', '45678.5', '#ERROR[#DIV/0!]: Division by zero']]);
  });

  it('prefixes dangerous string corpus with apostrophe_prefix_v1, counts exact transforms, and preserves benign source', () => {
    const dangerous = [
      '=SUM(A1:B10)',
      '+12345',
      '-42.5', // string cell with leading minus
      '@SUM(A1)',
      '\tLeadingTab',
      '\rLeadingCR',
      '\nLeadingLF',
      '   =SpacesLeadingFormula',
      '\u0000=NullControlLeadingFormula',
      '\uFEFF@BomLeadingFormula',
      '\u200B+ZeroWidthLeadingFormula'
    ];
    const benign = [
      'Normal Text',
      '12345',
      '00123',
      "'AlreadyQuoted",
      'A=B',
      'foo\tbar',
      '   ',
      ''
    ];

    const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: dangerous.length + benign.length };
    const cells: Cell[] = [
      ...dangerous.map((v, i): Cell => ({ r: 0, c: i, kind: 'string', value: v })),
      ...benign.map((v, i): Cell => ({ r: 0, c: dangerous.length + i, kind: 'string', value: v }))
    ];

    const sourceSnapshot = JSON.stringify(cells);
    const res = encodeCsv(rect, cells, createOptions());

    expect(JSON.stringify(cells)).toBe(sourceSnapshot);
    expect(res.transformedCells).toBe(dangerous.length);

    const parsed = parseCsv(res.bytes)[0];
    for (let i = 0; i < dangerous.length; i++) {
      expect(parsed[i]).toBe("'" + dangerous[i]);
    }
    for (let i = 0; i < benign.length; i++) {
      expect(parsed[dangerous.length + i]).toBe(benign[i]);
    }
  });

  it('generates sparse A1, D50, Z90000 on demand without dense allocation', { timeout: 15000 }, () => {
    const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 90000, c1: 26 };
    const cells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: '00123' },
      { r: 49, c: 3, kind: 'string', value: 'middle' },
      { r: 89999, c: 25, kind: 'number', value: 42 }
    ];

    const res = encodeCsv(rect, cells, createOptions());
    expect(res.transformedCells).toBe(0);

    const parsed = parseCsv(res.bytes);
    expect(parsed.length).toBe(90000);
    expect(parsed[0].length).toBe(26);
    expect(parsed[0][0]).toBe('00123');
    expect(parsed[0][1]).toBe('');
    expect(parsed[49][3]).toBe('middle');
    expect(parsed[89999][25]).toBe('42');
    expect(parsed[89999][24]).toBe('');
  });

  it('handles 1x30000 blank row without caching >64KiB template or making oversized TextEncoder calls', { timeout: 15000 }, () => {
    const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 30000 };
      const signal = new AbortController().signal;

      const res = encodeCsv(rect, [], createOptions(PROVISIONAL_MAX_CSV_BYTES, signal));
      expect(res.transformedCells).toBe(0);

      // Assert no >64KiB (65536 bytes) TextEncoder call was made for empty-row template
      for (const call of encodeSpy.mock.calls) {
        const arg = call[0];
        if (typeof arg === 'string') {
          expect(arg.length).toBeLessThanOrEqual(65536);
        }
      }

      // Independent parser verification: csv-parse confirms exact 1x30000 blank row
      const parsed = parseCsv(res.bytes);
      expect(parsed.length).toBe(1);
      expect(parsed[0].length).toBe(30000);
      expect(parsed[0].every((val) => val === '')).toBe(true);
    } finally {
      encodeSpy.mockRestore();
    }
  });

  it('preflights escaped UTF-8 field bytes before allocating oversized escaped strings or buffers', () => {
    const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 1 };
      const signal = new AbortController().signal;

      // 1. CJK string: JS length is 20, but UTF-8 escaped bytes = 2 (quotes) + 20*3 (60) = 62 bytes.
      // With BOM (3) + CRLF (2), total would be 67 bytes.
      // Budget = 30 bytes.
      // Notice: JS string length (20) fits within remaining budget (30 - 3 = 27),
      // but escaped UTF-8 bytes (62) exceed it.
      const cjkString = '漢字'.repeat(10);
      const cjkCell: Cell = { r: 0, c: 0, kind: 'string', value: cjkString };

      encodeSpy.mockClear();
      expect(() => encodeCsv(rect, [cjkCell], createOptions(30, signal))).toThrowError(
        expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' })
      );
      // Prove that TextEncoder.encode was never called with the oversized cell text
      expect(encodeSpy).not.toHaveBeenCalled();
      // Source cell data preserved exact and typed
      expect(cjkCell.value).toBe(cjkString);

      // 2. Quote-heavy string: JS length is 20 quotes, but escaped UTF-8 bytes = 2 (quotes) + 20*2 (40) = 42 bytes.
      // With BOM (3) + CRLF (2), total would be 47 bytes.
      // Budget = 30 bytes.
      // JS string length (20) fits within remaining budget (27),
      // but escaped UTF-8 bytes (42) exceed it.
      const quoteString = '"'.repeat(20);
      const quoteCell: Cell = { r: 0, c: 0, kind: 'string', value: quoteString };

      encodeSpy.mockClear();
      expect(() => encodeCsv(rect, [quoteCell], createOptions(30, signal))).toThrowError(
        expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' })
      );
      // Prove that TextEncoder.encode was never called with the oversized cell text
      expect(encodeSpy).not.toHaveBeenCalled();
      // Source cell data preserved exact and typed
      expect(quoteCell.value).toBe(quoteString);
    } finally {
      encodeSpy.mockRestore();
    }
  });

  it('enforces exact byte cap vs cap-1 including BOM, quotes, delimiters, and safety prefix', () => {
    const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 1 };
    const cell: Cell = { r: 0, c: 0, kind: 'string', value: '=cmd' };
    // BOM (3) + "\"'=cmd\"" (7) + \r\n (2) = 12 bytes
    const exactCap = 12;

    const passRes = encodeCsv(rect, [cell], createOptions(exactCap));
    expect(passRes.bytes.length).toBe(exactCap);
    expect(passRes.transformedCells).toBe(1);

    expect(() => encodeCsv(rect, [cell], createOptions(exactCap - 1))).toThrowError(
      expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' })
    );
  });

  it('preflights enormous empty rectangle and rejects with BYTE_LIMIT_EXCEEDED before traversal', () => {
    const hugeRect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 10_000_000, c1: 10_000 };
    expect(() => encodeCsv(hugeRect, [], createOptions())).toThrowError(
      expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' })
    );
  });

  it('rejects duplicate, out-of-bounds, non-safe coords, empty rect, and invalid rects', () => {
    const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 2, c1: 2 };

    // Duplicate coordinates
    const dupCells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: 'a' },
      { r: 0, c: 0, kind: 'string', value: 'b' }
    ];
    expect(() => encodeCsv(rect, dupCells, createOptions())).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );

    // Out-of-bounds cell
    const outCell: Cell = { r: 2, c: 0, kind: 'string', value: 'out' };
    expect(() => encodeCsv(rect, [outCell], createOptions())).toThrowError(
      expect.objectContaining({ code: 'RANGE_OUT_OF_BOUNDS' })
    );

    // Non-safe coords
    const badCoordCell = { r: 1.5, c: 0, kind: 'string', value: 'x' } as unknown as Cell;
    expect(() => encodeCsv(rect, [badCoordCell], createOptions())).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );

    // Empty rect
    const emptyRect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 0, c1: 2 };
    expect(() => encodeCsv(emptyRect, [], createOptions())).toThrowError(
      expect.objectContaining({ code: 'RANGE_EMPTY' })
    );

    // Invalid rect (r1 < r0)
    const reversedRect: Rect = { sheetId: 0, r0: 5, c0: 0, r1: 2, c1: 2 };
    expect(() => encodeCsv(reversedRect, [], createOptions())).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
  });

  it('rejects bad types, NaN, Infinity, Date objects, and lone surrogate strings with FORMAT_UNSUPPORTED', () => {
    const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 1 };

    const badKind = { r: 0, c: 0, kind: 'date', value: new Date() } as unknown as Cell;
    expect(() => encodeCsv(rect, [badKind], createOptions())).toThrowError(
      expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' })
    );

    const nanCell: Cell = { r: 0, c: 0, kind: 'number', value: NaN };
    expect(() => encodeCsv(rect, [nanCell], createOptions())).toThrowError(
      expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' })
    );

    const infCell: Cell = { r: 0, c: 0, kind: 'number', value: Infinity };
    expect(() => encodeCsv(rect, [infCell], createOptions())).toThrowError(
      expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' })
    );

    const loneSurrogateCell: Cell = { r: 0, c: 0, kind: 'string', value: 'bad\uD800cell' };
    expect(() => encodeCsv(rect, [loneSurrogateCell], createOptions())).toThrowError(
      expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' })
    );

    const loneSurrogateErrorCell: Cell = {
      r: 0,
      c: 0,
      kind: 'error',
      value: { code: '#ERR\uDC00', message: 'err' }
    };
    expect(() => encodeCsv(rect, [loneSurrogateErrorCell], createOptions())).toThrowError(
      expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' })
    );
  });

  it('validates signal shape, propagates static OPERATION_ABORTED without leaking token data', () => {
    const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 1 };

    // Missing signal
    expect(() => encodeCsv(rect, [], { maxBytes: 1000 } as unknown as EncodeCsvOptions)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );

    // Invalid signal shape (not an object with aborted boolean & addEventListener function)
    expect(() => encodeCsv(rect, [], { maxBytes: 1000, signal: {} } as unknown as EncodeCsvOptions)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() => encodeCsv(rect, [], { maxBytes: 1000, signal: 'abort' } as unknown as EncodeCsvOptions)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );

    // Signal pre-aborted with sensitive token string in reason must propagate static OPERATION_ABORTED
    const preAbortedWithSecret = AbortSignal.abort(new Error('ya29.secret_auth_token_leak'));
    let thrownError: unknown;
    try {
      encodeCsv(rect, [], { maxBytes: 1000, signal: preAbortedWithSecret });
    } catch (e) {
      thrownError = e;
    }
    expect(thrownError).toBeDefined();
    expect((thrownError as { code: string }).code).toBe('OPERATION_ABORTED');
    expect((thrownError as { message: string }).message).toBe('Operation was aborted.');
    expect(JSON.stringify(thrownError)).not.toContain('ya29.secret_auth_token_leak');
  });

  it('honors row loop boundary cancellation code polling across independent repeated calls', () => {
    const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 3, c1: 2 };
    const controller = new AbortController();
    let pollCount = 0;

    // Simulate abortion triggered after initial checks, at row loop boundary
    const pollingSignal = new Proxy(controller.signal, {
      get(target, prop, receiver) {
        if (prop === 'aborted') {
          pollCount++;
          if (pollCount >= 3) {
            controller.abort();
          }
        }
        return Reflect.get(target, prop, receiver);
      }
    });

    expect(() => encodeCsv(rect, [], { maxBytes: 1000, signal: pollingSignal })).toThrowError(
      expect.objectContaining({ code: 'OPERATION_ABORTED' })
    );
    expect(controller.signal.aborted).toBe(true);
    expect(pollCount).toBeGreaterThanOrEqual(3);

    // Independent repeated calls with distinct valid signals produce identical independent output
    const res1 = encodeCsv(rect, [], createOptions(1000));
    const res2 = encodeCsv(rect, [], createOptions(1000));
    expect(res1.bytes).not.toBe(res2.bytes);
    expect(res1.bytes).toEqual(res2.bytes);
  });
});
