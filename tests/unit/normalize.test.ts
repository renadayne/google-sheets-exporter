import { describe, it, expect } from 'vitest';
import { normalizeGrid, type NormalizeGridOptions } from '../../src/domain/normalize.ts';
import fidelity from '../fixtures/grid/multisheet-fidelity.json';

const SPREADSHEET_ID = 'synthetic-fidelity-spreadsheet-001';

function createOpts(overrides: Partial<NormalizeGridOptions> = {}): NormalizeGridOptions {
  return {
    sourceId: SPREADSHEET_ID,
    jobId: 'job-1',
    chunkId: 'chunk-1',
    rect: { sheetId: 100, r0: 0, c0: 0, r1: 100000, c1: 30 },
    mode: 'raw',
    byteCount: 1024,
    ...overrides
  };
}

describe('T15b normalizeGrid', () => {
  it('normalizes SparseTab with 3 sparse coords, trailing omission, mode forwarding, and sorts out-of-order blocks', () => {
    const sheet100 = fidelity.sheets[0];
    const payload = { spreadsheetId: SPREADSHEET_ID, sheets: [sheet100] };

    // Mode raw: exact manual literals for A1, D50, Z90000
    const rawChunk = normalizeGrid(payload, createOpts({ mode: 'raw' }));
    expect(rawChunk.jobId).toBe('job-1');
    expect(rawChunk.chunkId).toBe('chunk-1');
    expect(rawChunk.rect).toEqual({ sheetId: 100, r0: 0, c0: 0, r1: 100000, c1: 30 });
    expect(rawChunk.excludedIntervals).toEqual({ rows: [], columns: [] });
    expect(rawChunk.byteCount).toBe(1024);
    expect(rawChunk.cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: 'A1 Header' },
      { r: 49, c: 3, kind: 'number', value: 42.5 },
      { r: 89999, c: 25, kind: 'boolean', value: true }
    ]);

    // Mode formatted: currency and bool strings
    const fmtChunk = normalizeGrid(payload, createOpts({ mode: 'formatted' }));
    expect(fmtChunk.cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: 'A1 Header' },
      { r: 49, c: 3, kind: 'string', value: '$42.50' },
      { r: 89999, c: 25, kind: 'string', value: 'TRUE' }
    ]);

    // Mode formula_text: nonformula cells retain raw typed values
    const formulaChunk = normalizeGrid(payload, createOpts({ mode: 'formula_text' }));
    expect(formulaChunk.cells).toEqual(rawChunk.cells);

    // Out-of-order blocks: scrambled input produces canonically sorted cells [A1, D50, Z90000]
    const dataBlocks = sheet100.data!;
    const scrambledPayload = {
      spreadsheetId: SPREADSHEET_ID,
      sheets: [{ ...sheet100, data: [dataBlocks[2], dataBlocks[0], dataBlocks[1]] }]
    };
    const sortedChunk = normalizeGrid(scrambledPayload, createOpts({ mode: 'raw' }));
    expect(sortedChunk.cells).toEqual(rawChunk.cells);
  });

  it('normalizes ValuesAndVisibility with nonzero origin, blank merged non-anchor, explicit empty, date serial, errors, formulas', () => {
    const sheet101 = fidelity.sheets[1];
    const payload = { spreadsheetId: SPREADSHEET_ID, sheets: [sheet101] };
    const opts = createOpts({
      rect: { sheetId: 101, r0: 4, c0: 2, r1: 10, c1: 6 },
      mode: 'raw'
    });

    const rawChunk = normalizeGrid(payload, opts);
    expect(rawChunk.cells).toEqual([
      { r: 4, c: 2, kind: 'string', value: 'Anchor Cell C5' },
      // D5 (r: 4, c: 3) merged nonanchor blank {} omitted
      { r: 4, c: 4, kind: 'string', value: '' }, // E5 explicit empty string retained
      { r: 5, c: 2, kind: 'number', value: 45200, numberFormatType: 'DATE' }, // C6 date serial
      { r: 5, c: 3, kind: 'number', value: 30 }, // D6 raw evaluated formula
      { r: 5, c: 4, kind: 'string', value: '' }, // E6 raw formula empty string
      { r: 5, c: 5, kind: 'error', value: { code: 'DIVIDE_BY_ZERO', message: 'Evaluation Error: divide by zero' } } // F6 error
    ]);

    const fmtChunk = normalizeGrid(payload, { ...opts, mode: 'formatted' });
    expect(fmtChunk.cells).toEqual([
      { r: 4, c: 2, kind: 'string', value: 'Anchor Cell C5' },
      { r: 4, c: 4, kind: 'string', value: '' },
      { r: 5, c: 2, kind: 'string', value: '2023-10-01', numberFormatType: 'DATE' },
      { r: 5, c: 3, kind: 'string', value: '30' },
      { r: 5, c: 4, kind: 'string', value: '' },
      { r: 5, c: 5, kind: 'string', value: '#DIV/0!' }
    ]);

    const formulaChunk = normalizeGrid(payload, { ...opts, mode: 'formula_text' });
    expect(formulaChunk.cells).toEqual([
      { r: 4, c: 2, kind: 'string', value: 'Anchor Cell C5' },
      { r: 4, c: 4, kind: 'string', value: '' },
      { r: 5, c: 2, kind: 'number', value: 45200, numberFormatType: 'DATE' },
      { r: 5, c: 3, kind: 'string', value: '=SUM(10, 20)', formulaText: '=SUM(10, 20)' },
      { r: 5, c: 4, kind: 'string', value: '=IF(TRUE, "", "fallback")', formulaText: '=IF(TRUE, "", "fallback")' },
      { r: 5, c: 5, kind: 'string', value: '=1/0', formulaText: '=1/0' }
    ]);
  });

  it('supports blank tab data:[], zero sheet ID, and trailing row/values omissions without shrinking scope', () => {
    const blankPayload = {
      spreadsheetId: SPREADSHEET_ID,
      sheets: [{ properties: { sheetId: 0, sheetType: 'GRID' }, data: [] }]
    };
    const chunk = normalizeGrid(blankPayload, createOpts({
      rect: { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 },
      mode: 'raw',
      byteCount: 0
    }));
    expect(chunk.cells).toEqual([]);
    expect(chunk.rect).toEqual({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 });
    expect(chunk.byteCount).toBe(0);

    // Omitted rowData and row.values sequence within validated block
    const omissionPayload = {
      spreadsheetId: SPREADSHEET_ID,
      sheets: [{
        properties: { sheetId: 10, sheetType: 'GRID' },
        data: [
          { startRow: 1, startColumn: 1 }, // rowData omitted
          { startRow: 2, startColumn: 1, rowData: [{}] } // values omitted in row
        ]
      }]
    };
    const omissionChunk = normalizeGrid(omissionPayload, createOpts({
      rect: { sheetId: 10, r0: 0, c0: 0, r1: 5, c1: 5 }
    }));
    expect(omissionChunk.cells).toEqual([]);
    expect(omissionChunk.rect).toEqual({ sheetId: 10, r0: 0, c0: 0, r1: 5, c1: 5 });
  });

  it('rejects invalid rect with RANGE_INVALID', () => {
    const payload = { spreadsheetId: SPREADSHEET_ID, sheets: [{ properties: { sheetId: 0 }, data: [] }] };
    const invalidRects = [
      null,
      { sheetId: -1, r0: 0, c0: 0, r1: 10, c1: 10 },
      { sheetId: 0, r0: 0, c0: 0, r1: 0, c1: 10 }, // r1 <= r0
      { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 0 }, // c1 <= c0
      { sheetId: 0, r0: -0, c0: 0, r1: 10, c1: 10 },
      { sheetId: 0, r0: 0, c0: 0, r1: 1.5, c1: 10 },
      { sheetId: 0, r0: 0, c0: 0, r1: NaN, c1: 10 }
    ];
    for (const rect of invalidRects) {
      expect(() => normalizeGrid(payload, createOpts({ rect: rect as any }))).toThrowError(
        expect.objectContaining({ code: 'RANGE_INVALID' })
      );
    }
  });

  it('rejects invalid options with SOURCE_UNSUPPORTED', () => {
    const payload = { spreadsheetId: SPREADSHEET_ID, sheets: [{ properties: { sheetId: 100 }, data: [] }] };
    expect(() => normalizeGrid(payload, createOpts({ sourceId: '' }))).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    expect(() => normalizeGrid(payload, createOpts({ jobId: '' }))).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    expect(() => normalizeGrid(payload, createOpts({ chunkId: '' }))).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    expect(() => normalizeGrid(payload, createOpts({ mode: 'invalid' as any }))).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    expect(() => normalizeGrid(payload, createOpts({ byteCount: -1 }))).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    expect(() => normalizeGrid(payload, null as any)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
  });

  it('rejects payload inconsistencies and missing offsets with SOURCE_UNSUPPORTED', () => {
    const validBlock = { startRow: 0, startColumn: 0, rowData: [{ values: [{ formattedValue: 'ok' }] }] };
    const validSheet = { properties: { sheetId: 100, sheetType: 'GRID' }, data: [validBlock] };
    const opts = createOpts({ rect: { sheetId: 100, r0: 0, c0: 0, r1: 10, c1: 10 }, mode: 'formatted' });

    // Missing offsets in offline subset
    expect(() => normalizeGrid({ spreadsheetId: SPREADSHEET_ID, sheets: [{ properties: { sheetId: 100 }, data: [{ startColumn: 0 }] }] }, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    expect(() => normalizeGrid({ spreadsheetId: SPREADSHEET_ID, sheets: [{ properties: { sheetId: 100 }, data: [{ startRow: 0 }] }] }, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // Non-GRID sheetType (e.g. OBJECT sheet from fixture)
    expect(() => normalizeGrid({ spreadsheetId: SPREADSHEET_ID, sheets: [fidelity.sheets[2]] }, createOpts({ rect: { sheetId: 102, r0: 0, c0: 0, r1: 10, c1: 10 } })))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // Mismatched spreadsheetId or sheetId
    expect(() => normalizeGrid({ spreadsheetId: 'wrong-id', sheets: [validSheet] }, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    expect(() => normalizeGrid({ spreadsheetId: SPREADSHEET_ID, sheets: [{ ...validSheet, properties: { sheetId: 999 } }] }, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // Duplicate or multiple sheets
    expect(() => normalizeGrid({ spreadsheetId: SPREADSHEET_ID, sheets: [validSheet, validSheet] }, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // Missing / non-array data
    expect(() => normalizeGrid({ spreadsheetId: SPREADSHEET_ID, sheets: [{ properties: { sheetId: 100 } }] }, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // Malformed rowData / values
    expect(() => normalizeGrid({ spreadsheetId: SPREADSHEET_ID, sheets: [{ ...validSheet, data: [{ startRow: 0, startColumn: 0, rowData: null }] }] }, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    expect(() => normalizeGrid({ spreadsheetId: SPREADSHEET_ID, sheets: [{ ...validSheet, data: [{ startRow: 0, startColumn: 0, rowData: [{ values: null }] }] }] }, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
  });

  it('rejects duplicate positions and outside blocks/rows/values even for blank placeholders', () => {
    const opts = createOpts({ rect: { sheetId: 100, r0: 2, c0: 2, r1: 5, c1: 5 } });

    // Duplicate position between blocks, even when blank {}
    const duplicatePayload = {
      spreadsheetId: SPREADSHEET_ID,
      sheets: [{
        properties: { sheetId: 100 },
        data: [
          { startRow: 3, startColumn: 3, rowData: [{ values: [{}] }] },
          { startRow: 3, startColumn: 3, rowData: [{ values: [{}] }] }
        ]
      }]
    };
    expect(() => normalizeGrid(duplicatePayload, opts)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // Block startRow outside rect (e.g. startRow 0 when r0 is 2)
    const outsideBlockPayload = {
      spreadsheetId: SPREADSHEET_ID,
      sheets: [{
        properties: { sheetId: 100 },
        data: [{ startRow: 0, startColumn: 2, rowData: [] }]
      }]
    };
    expect(() => normalizeGrid(outsideBlockPayload, opts)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // Blank placeholder outside rect (column 5 when c1 is 5)
    const outsidePlaceholderPayload = {
      spreadsheetId: SPREADSHEET_ID,
      sheets: [{
        properties: { sheetId: 100 },
        data: [{
          startRow: 3,
          startColumn: 3,
          rowData: [{ values: [{}, {}, {}] }] // cols 3, 4, 5 (5 is >= c1)
        }]
      }]
    };
    expect(() => normalizeGrid(outsidePlaceholderPayload, opts)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // Row outside rect (row 5 when r1 is 5)
    const outsideRowPayload = {
      spreadsheetId: SPREADSHEET_ID,
      sheets: [{
        properties: { sheetId: 100 },
        data: [{
          startRow: 4,
          startColumn: 2,
          rowData: [{ values: [{}] }, { values: [{}] }] // rows 4, 5 (5 is >= r1)
        }]
      }]
    };
    expect(() => normalizeGrid(outsideRowPayload, opts)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
  });
});
