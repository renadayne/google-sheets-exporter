import { describe, it, expect } from 'vitest';
import type { NormalizedChunk } from '../../src/contracts/domain.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import { normalizeGrid } from '../../src/domain/normalize.ts';
import { applyVisibility } from '../../src/domain/visibility.ts';
import fidelity from '../fixtures/grid/multisheet-fidelity.json';
import unavailableFidelity from '../fixtures/grid/unavailable-visibility.json';

const SPREADSHEET_ID = 'synthetic-fidelity-spreadsheet-001';

function makeChunk(overrides: Partial<NormalizedChunk> = {}): NormalizedChunk {
  return {
    jobId: 'job-1',
    chunkId: 'chunk-1',
    rect: { sheetId: 101, r0: 4, c0: 2, r1: 7, c1: 6 },
    cells: [],
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 2048,
    ...overrides
  };
}

function makePayload(data: unknown[], sheetType = 'GRID', sheetId = 101, spreadsheetId = SPREADSHEET_ID) {
  return { spreadsheetId, sheets: [{ properties: { sheetId, sheetType }, data }] };
}

describe('T16 applyVisibility', () => {
  it('rejects cells outside declared scope even with include_all', () => {
    for (const cell of [{ r: 3, c: 2 }, { r: 4, c: 6 }, { r: 7, c: 2 }, { r: 4.5, c: 2 }]) {
      const chunk = makeChunk({ cells: [{ ...cell, kind: 'string', value: 'outside' }] });
      expect(() => applyVisibility(chunk, undefined, { sourceId: SPREADSHEET_ID, visibility: 'include_all' })).toThrow(DomainError);
    }
  });

  it('copies nested error values instead of sharing them with the source chunk', () => {
    const value = { code: 'N_A', message: 'original' };
    const chunk = makeChunk({ cells: [{ r: 4, c: 2, kind: 'error', value }] });
    const result = applyVisibility(chunk, undefined, { sourceId: SPREADSHEET_ID, visibility: 'include_all' });
    expect(result.cells[0].value).not.toBe(value);
    value.message = 'caller changed';
    expect(result.cells[0].value).toEqual({ code: 'N_A', message: 'original' });
  });

  it('rejects hidden or extraneous sheets and accepts equivalent absent/false column filter flags', () => {
    const chunk = makeChunk({ rect: { sheetId: 101, r0: 4, c0: 2, r1: 5, c1: 3 } });
    const block = { startRow: 4, startColumn: 2, rowMetadata: [{ hiddenByUser: false, hiddenByFilter: false }], columnMetadata: [{ hiddenByUser: false }] };
    const payload = makePayload([block]);
    expect(() => applyVisibility(chunk, { ...payload, sheets: [{ ...payload.sheets[0], properties: { sheetId: 101, hidden: true } }] }, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' })).toThrow(DomainError);
    expect(() => applyVisibility(chunk, { ...payload, sheets: [...payload.sheets, { properties: { sheetId: 999 }, data: [] }] }, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' })).toThrow(DomainError);
    const repeated = makePayload([block, { ...block, columnMetadata: [{ hiddenByUser: false, hiddenByFilter: false }] }]);
    expect(applyVisibility(chunk, repeated, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' }).excludedIntervals).toEqual({ rows: [], columns: [] });
  });
  it('applies API visibility to T03 ValuesAndVisibility scope [4,7)x[2,6) without compaction', () => {
    const sheet101 = fidelity.sheets[1];
    const fullPayload = { spreadsheetId: SPREADSHEET_ID, sheets: [sheet101] };
    const normalized = normalizeGrid(fullPayload, {
      sourceId: SPREADSHEET_ID,
      jobId: 'job-1',
      chunkId: 'chunk-1',
      rect: { sheetId: 101, r0: 4, c0: 2, r1: 7, c1: 6 },
      mode: 'raw',
      byteCount: 1024
    });

    const result = applyVisibility(normalized, fullPayload, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' });
    expect(result.jobId).toBe('job-1');
    expect(result.chunkId).toBe('chunk-1');
    expect(result.byteCount).toBe(1024);
    expect(result.rect).toEqual({ sheetId: 101, r0: 4, c0: 2, r1: 7, c1: 6 });
    expect(result.excludedIntervals).toEqual({
      rows: [{ start: 5, end: 7 }],
      columns: [{ start: 3, end: 4 }]
    });
    // Surviving cells: C5 and E5 at absolute coords (4,2) and (4,4), preserving empty E5
    expect(result.cells).toEqual([
      { r: 4, c: 2, kind: 'string', value: 'Anchor Cell C5' },
      { r: 4, c: 4, kind: 'string', value: '' }
    ]);
  });

  it('preserves absolute coords of a later visible cell after hidden gap without compaction', () => {
    const chunk = makeChunk({
      rect: { sheetId: 1, r0: 0, c0: 0, r1: 3, c1: 2 },
      cells: [
        { r: 0, c: 0, kind: 'string', value: 'top' },
        { r: 2, c: 0, kind: 'string', value: 'after-gap' }
      ]
    });
    const payload = makePayload([
      {
        startRow: 0,
        startColumn: 0,
        rowMetadata: [
          { hiddenByUser: false, hiddenByFilter: false },
          { hiddenByUser: true, hiddenByFilter: false },
          { hiddenByUser: false, hiddenByFilter: false }
        ],
        columnMetadata: [{ hiddenByUser: false }, { hiddenByUser: false }]
      }
    ], 'GRID', 1);

    const result = applyVisibility(chunk, payload, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' });
    expect(result.excludedIntervals.rows).toEqual([{ start: 1, end: 2 }]);
    expect(result.cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: 'top' },
      { r: 2, c: 0, kind: 'string', value: 'after-gap' }
    ]);
  });

  it('include_all matches full normalized cells even with unavailable metadata or undefined payload', () => {
    const norm = normalizeGrid(unavailableFidelity, {
      sourceId: unavailableFidelity.spreadsheetId,
      jobId: 'job-u',
      chunkId: 'chunk-u',
      rect: { sheetId: 200, r0: 0, c0: 0, r1: 2, c1: 2 },
      mode: 'raw',
      byteCount: 512
    });

    const r1 = applyVisibility(norm, unavailableFidelity, { sourceId: unavailableFidelity.spreadsheetId, visibility: 'include_all' });
    expect(r1.cells).toEqual(norm.cells);
    expect(r1.excludedIntervals).toEqual({ rows: [], columns: [] });

    const r2 = applyVisibility(norm, undefined, { sourceId: unavailableFidelity.spreadsheetId, visibility: 'include_all' });
    expect(r2.cells).toEqual(norm.cells);
    expect(r2.excludedIntervals).toEqual({ rows: [], columns: [] });
  });

  it('rejects prefiltered input and invalid visibility mode', () => {
    const prefiltered = makeChunk({ excludedIntervals: { rows: [{ start: 5, end: 6 }], columns: [] } });
    expect(() => applyVisibility(prefiltered, undefined, { sourceId: SPREADSHEET_ID, visibility: 'include_all' })).toThrow(DomainError);
    const chunk = makeChunk();
    expect(() => applyVisibility(chunk, undefined, { sourceId: SPREADSHEET_ID, visibility: 'bad_mode' as any })).toThrow(DomainError);
  });

  it('rejects missing or gapped row/column coverage and missing metadata arrays', () => {
    const chunk = makeChunk();
    const gapped = makePayload([{
      startRow: 4, startColumn: 2,
      rowMetadata: [{ hiddenByUser: false, hiddenByFilter: false }, { hiddenByUser: false, hiddenByFilter: false }],
      columnMetadata: [{ hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }]
    }]);
    expect(() => applyVisibility(chunk, gapped, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' })).toThrow(DomainError);

    const noMeta = makePayload([{ startRow: 4, startColumn: 2 }]);
    expect(() => applyVisibility(chunk, noMeta, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' })).toThrow(DomainError);
  });

  it('rejects omitted or invalid row and column flags', () => {
    const chunk = makeChunk();
    const missingFilter = makePayload([{
      startRow: 4, startColumn: 2,
      rowMetadata: [{ hiddenByUser: false }, { hiddenByUser: false, hiddenByFilter: false }, { hiddenByUser: false, hiddenByFilter: false }],
      columnMetadata: [{ hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }]
    }]);
    expect(() => applyVisibility(chunk, missingFilter, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' })).toThrow(DomainError);

    const invalidCol = makePayload([{
      startRow: 4, startColumn: 2,
      rowMetadata: [{ hiddenByUser: false, hiddenByFilter: false }, { hiddenByUser: false, hiddenByFilter: false }, { hiddenByUser: false, hiddenByFilter: false }],
      columnMetadata: [{ hiddenByUser: false, hiddenByFilter: 'yes' }, { hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }]
    }]);
    expect(() => applyVisibility(chunk, invalidCol, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' })).toThrow(DomainError);
  });

  it('rejects out-of-bounds positions and handles overlapping blocks (conflicting vs consistent)', () => {
    const chunk = makeChunk();
    const oob = makePayload([{
      startRow: 3, startColumn: 2,
      rowMetadata: [{ hiddenByUser: false, hiddenByFilter: false }],
      columnMetadata: [{ hiddenByUser: false }]
    }]);
    expect(() => applyVisibility(chunk, oob, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' })).toThrow(DomainError);

    const conflict = makePayload([
      {
        startRow: 4, startColumn: 2,
        rowMetadata: [{ hiddenByUser: false, hiddenByFilter: false }, { hiddenByUser: true, hiddenByFilter: false }],
        columnMetadata: [{ hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }]
      },
      {
        startRow: 5, startColumn: 2,
        rowMetadata: [{ hiddenByUser: false, hiddenByFilter: false }, { hiddenByUser: false, hiddenByFilter: true }],
        columnMetadata: [{ hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }]
      }
    ]);
    expect(() => applyVisibility(chunk, conflict, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' })).toThrow(DomainError);

    const consistent = makePayload([
      {
        startRow: 4, startColumn: 2,
        rowMetadata: [{ hiddenByUser: false, hiddenByFilter: false }, { hiddenByUser: true, hiddenByFilter: false }],
        columnMetadata: [{ hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }]
      },
      {
        startRow: 5, startColumn: 2,
        rowMetadata: [{ hiddenByUser: true, hiddenByFilter: false }, { hiddenByUser: false, hiddenByFilter: true }],
        columnMetadata: [{ hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }]
      }
    ]);
    const res = applyVisibility(chunk, consistent, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' });
    expect(res.excludedIntervals.rows).toEqual([{ start: 5, end: 7 }]);
  });

  it('handles all-hidden dimensions and multi-interval merging with nonzero origin', () => {
    const chunk = makeChunk({
      rect: { sheetId: 1, r0: 10, c0: 5, r1: 15, c1: 7 },
      cells: [{ r: 10, c: 5, kind: 'string', value: 'hidden-col' }]
    });
    const payload = makePayload([
      {
        startRow: 10, startColumn: 5,
        rowMetadata: [
          { hiddenByUser: false, hiddenByFilter: false },
          { hiddenByUser: true, hiddenByFilter: false },
          { hiddenByUser: false, hiddenByFilter: true },
          { hiddenByUser: false, hiddenByFilter: false },
          { hiddenByUser: true, hiddenByFilter: false }
        ],
        columnMetadata: [
          { hiddenByUser: true },
          { hiddenByUser: false, hiddenByFilter: true }
        ]
      }
    ], 'GRID', 1);

    const res = applyVisibility(chunk, payload, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' });
    expect(res.excludedIntervals).toEqual({
      rows: [{ start: 11, end: 13 }, { start: 14, end: 15 }],
      columns: [{ start: 5, end: 7 }]
    });
    expect(res.cells).toEqual([]);
  });

  it('rejects mismatched IDs, non-GRID sheets, and guarantees purity/no-mutation', () => {
    const chunk = makeChunk({ cells: [{ r: 4, c: 2, kind: 'string', value: 'Anchor' }] });
    const payload = makePayload([
      {
        startRow: 4, startColumn: 2,
        rowMetadata: [
          { hiddenByUser: false, hiddenByFilter: false },
          { hiddenByUser: false, hiddenByFilter: false },
          { hiddenByUser: false, hiddenByFilter: false }
        ],
        columnMetadata: [{ hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }, { hiddenByUser: false }]
      }
    ]);

    expect(() => applyVisibility(chunk, payload, { sourceId: 'wrong-id', visibility: 'api_visible' })).toThrow(DomainError);
    expect(() => applyVisibility(chunk, makePayload([], 'OBJECT'), { sourceId: SPREADSHEET_ID, visibility: 'api_visible' })).toThrow(DomainError);

    const originalCells = [...chunk.cells];
    const originalRect = { ...chunk.rect };
    const res = applyVisibility(chunk, payload, { sourceId: SPREADSHEET_ID, visibility: 'api_visible' });
    expect(res).not.toBe(chunk);
    expect(res.cells).not.toBe(chunk.cells);
    expect(res.rect).not.toBe(chunk.rect);
    expect(chunk.cells).toEqual(originalCells);
    expect(chunk.rect).toEqual(originalRect);
  });
});
