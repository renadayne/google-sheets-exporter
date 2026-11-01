import { describe, it, expect } from 'vitest';
import { parse } from 'csv-parse/sync';
import { encodeCsvSheets } from '../../src/export/csv-sheets.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import { PROVISIONAL_MAX_CSV_BYTES } from '../../src/export/csv.ts';
import type { Cell, ExcludedIntervals, NormalizedChunk, Rect, SheetMeta, VisibilityMode } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';

const parseCsv = (b: Uint8Array) => parse(Buffer.from(b.buffer, b.byteOffset, b.byteLength), { bom: true, record_delimiter: '\r\n' });
const mkChunk = (sheetId: number, r: [number, number, number, number], cells: Cell[], excl: ExcludedIntervals = { rows: [], columns: [] }): NormalizedChunk =>
  ({ jobId: 'j', chunkId: `c_${sheetId}`, rect: { sheetId, r0: r[0], c0: r[1], r1: r[2], c1: r[3] }, cells, excludedIntervals: excl, byteCount: 1 });
const mkMeta = (id: number, title: string, index: number, rows = 10, columns = 10): SheetMeta =>
  ({ id, title, index, type: 'GRID', hidden: false, rows, columns });
const mkCtx = (sheetOrder: number[], scopes: { sheetId: number; rect: Rect }[], sheets: SheetMeta[], vis: VisibilityMode = 'include_all'): WriterContext =>
  ({ sourceId: 'src', title: 'T', locale: 'en', timeZone: 'UTC', mode: 'raw', format: 'csv', visibility: vis, limitsVersion: '1.0', sheetOrder, scopes, sheets });
const defOpts = { maxChunks: 100, maxIntervals: 100, maxCells: 100, signal: new AbortController().signal };

describe('T27a encodeCsvSheets', () => {
  it('encodes 3 sheets in source order (30,10,20), handles collisions, quotes, unicode, -42, dangerous formula, empty tab', () => {
    const ctx = mkCtx([30, 10, 20], [
      { sheetId: 30, rect: { sheetId: 30, r0: 2, c0: 1, r1: 5, c1: 4 } },
      { sheetId: 10, rect: { sheetId: 10, r0: 0, c0: 0, r1: 2, c1: 2 } },
      { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 2, c1: 2 } }
    ], [mkMeta(30, 'Data', 0), mkMeta(10, 'data', 2), mkMeta(20, 'Empty', 5)]);
    const s30Cells: Cell[] = [
      { r: 2, c: 1, kind: 'string', value: '00123' },
      { r: 2, c: 2, kind: 'string', value: 'He said "Hello"' },
      { r: 2, c: 3, kind: 'string', value: 'café 🌟' },
      { r: 3, c: 1, kind: 'string', value: '=SUM(A1)' },
      { r: 3, c: 2, kind: 'number', value: -42 }
    ];
    const chunks = [
      mkChunk(30, [2, 1, 5, 4], s30Cells),
      mkChunk(10, [0, 0, 2, 2], [{ r: 0, c: 0, kind: 'string', value: 'tab10' }]),
      mkChunk(20, [0, 0, 2, 2], [])
    ];
    const prepared = prepareWriterData(ctx, chunks, defOpts);
    const res = encodeCsvSheets(prepared, { maxBytes: PROVISIONAL_MAX_CSV_BYTES, signal: new AbortController().signal });

    expect(res.sheets).toHaveLength(3);
    expect(res.nameMappings).toEqual([
      { sheetId: 30, originalTitle: 'Data', exportedName: 'Data.csv' },
      { sheetId: 10, originalTitle: 'data', exportedName: 'data_10.csv' },
      { sheetId: 20, originalTitle: 'Empty', exportedName: 'Empty.csv' }
    ]);
    expect(res.sheets.map(s => s.filename)).toEqual(['Data.csv', 'data_10.csv', 'Empty.csv']);
    expect(res.sheets.map(s => s.sheetId)).toEqual([30, 10, 20]);
    expect(res.totalByteLength).toBe(res.sheets.reduce((sum, s) => sum + s.bytes.byteLength, 0));
    expect(res.csvTransformCounts).toEqual({
      policy: 'apostrophe_prefix_v1',
      totalTransformedCells: 1,
      bySheet: [{ sheetId: 30, transformedCells: 1 }, { sheetId: 10, transformedCells: 0 }, { sheetId: 20, transformedCells: 0 }]
    });

    expect(parseCsv(res.sheets[0].bytes)).toEqual([
      ['00123', 'He said "Hello"', 'café 🌟'],
      ["'=SUM(A1)", '-42', ''],
      ['', '', '']
    ]);
    expect(parseCsv(res.sheets[1].bytes)).toEqual([['tab10', ''], ['', '']]);
    expect(parseCsv(res.sheets[2].bytes)).toEqual([['', ''], ['', '']]);
  });

  it('enforces exact cumulative byte budget and cap-1 rejection with no partial result', () => {
    const ctx = mkCtx([1, 2], [
      { sheetId: 1, rect: { sheetId: 1, r0: 0, c0: 0, r1: 1, c1: 1 } },
      { sheetId: 2, rect: { sheetId: 2, r0: 0, c0: 0, r1: 1, c1: 1 } }
    ], [mkMeta(1, 'S1', 0), mkMeta(2, 'S2', 1)]);
    // S1: BOM(3) + "A"(3) + \r\n(2) = 8 bytes. S2: BOM(3) + ""(2) + \r\n(2) = 7 bytes. Total = 15 bytes.
    const chunks = [mkChunk(1, [0, 0, 1, 1], [{ r: 0, c: 0, kind: 'string', value: 'A' }]), mkChunk(2, [0, 0, 1, 1], [])];
    const prepared = prepareWriterData(ctx, chunks, defOpts);

    const exactRes = encodeCsvSheets(prepared, { maxBytes: 15, signal: new AbortController().signal });
    expect(exactRes.totalByteLength).toBe(15);
    expect(exactRes.sheets[0].bytes.byteLength).toBe(8);
    expect(exactRes.sheets[1].bytes.byteLength).toBe(7);

    expect(() => encodeCsvSheets(prepared, { maxBytes: 14, signal: new AbortController().signal })).toThrowError(
      expect.objectContaining({ name: 'DomainError', code: 'BYTE_LIMIT_EXCEEDED' })
    );
  });

  it('retains dense blank rows/cols under api_visible exclusions', () => {
    const ctx = mkCtx([5], [{ sheetId: 5, rect: { sheetId: 5, r0: 0, c0: 0, r1: 3, c1: 3 } }], [mkMeta(5, 'Excl', 0)], 'api_visible');
    const excl = { rows: [{ start: 1, end: 2 }], columns: [{ start: 1, end: 2 }] };
    const chunks = [mkChunk(5, [0, 0, 3, 3], [{ r: 0, c: 0, kind: 'string', value: 'corner' }], excl)];
    const prepared = prepareWriterData(ctx, chunks, defOpts);
    const res = encodeCsvSheets(prepared, { maxBytes: PROVISIONAL_MAX_CSV_BYTES, signal: new AbortController().signal });
    expect(parseCsv(res.sheets[0].bytes)).toEqual([
      ['corner', '', ''],
      ['', '', ''],
      ['', '', '']
    ]);
  });

  it('preserves source immutability, independent byte buffers, and single sheet single result', () => {
    const ctx = mkCtx([1], [{ sheetId: 1, rect: { sheetId: 1, r0: 0, c0: 0, r1: 1, c1: 1 } }], [mkMeta(1, 'Single', 0)]);
    const prepared = prepareWriterData(ctx, [mkChunk(1, [0, 0, 1, 1], [{ r: 0, c: 0, kind: 'string', value: 'val' }])], defOpts);
    const res1 = encodeCsvSheets(prepared, { maxBytes: PROVISIONAL_MAX_CSV_BYTES, signal: new AbortController().signal });
    const res2 = encodeCsvSheets(prepared, { maxBytes: PROVISIONAL_MAX_CSV_BYTES, signal: new AbortController().signal });
    expect(res1.sheets).toHaveLength(1);
    expect(res1.sheets[0].bytes).toEqual(res2.sheets[0].bytes);
    expect(res1.sheets[0].bytes).not.toBe(res2.sheets[0].bytes);
    res1.sheets[0].bytes[0] = 0;
    expect(res2.sheets[0].bytes[0]).toBe(0xef);
    expect(prepared[0].metadata.title).toBe('Single');
  });

  it('rejects invalid config, pre-abort, empty sheets, and throws safe domain errors', () => {
    const validSignal = new AbortController().signal;
    const ctx = mkCtx([1], [{ sheetId: 1, rect: { sheetId: 1, r0: 0, c0: 0, r1: 1, c1: 1 } }], [mkMeta(1, 'S', 0)]);
    const prep = prepareWriterData(ctx, [mkChunk(1, [0, 0, 1, 1], [])], defOpts);

    const badConfigs = [
      null, {}, { maxBytes: -1, signal: validSignal }, { maxBytes: -0, signal: validSignal },
      { maxBytes: 1.5, signal: validSignal }, { maxBytes: PROVISIONAL_MAX_CSV_BYTES + 1, signal: validSignal },
      { maxBytes: 100, signal: null }
    ];
    for (const bad of badConfigs) {
      expect(() => encodeCsvSheets(prep, bad as any)).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'CONFIG_INVALID' }));
    }
    expect(() => encodeCsvSheets(prep, { maxBytes: 100, signal: AbortSignal.abort() })).toThrowError(
      expect.objectContaining({ name: 'DomainError', code: 'OPERATION_ABORTED' })
    );
    expect(() => encodeCsvSheets([], { maxBytes: 100, signal: validSignal })).toThrowError(
      expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' })
    );
    expect(() => encodeCsvSheets(null as any, { maxBytes: 100, signal: validSignal })).toThrowError(
      expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });
});
