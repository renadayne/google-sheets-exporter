import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';

import type { Cell, ExportReport, NormalizedChunk } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import { createCsvWriter, type CsvWriterOptions } from '../../src/export/csv-writer.ts';
import { createXlsxWriter, type XlsxWriterOptions } from '../../src/export/xlsx-writer.ts';
import { PROVISIONAL_MAX_CSV_ZIP_BYTES } from '../../src/export/csv-zip.ts';
import { PROVISIONAL_MAX_XLSX_BYTES } from '../../src/export/xlsx.ts';
import {
  XLSX_MIME_TYPE,
  JSON_MIME_TYPE,
  XLSX_PRIMARY_SAFE_SUMMARY,
  XLSX_COMPANION_SAFE_SUMMARY
} from '../../src/export/xlsx-package.ts';
import { parseZipArchive } from '../helpers/zip-reader.ts';

function asBytes(data: unknown): Uint8Array {
  if (!(data instanceof Uint8Array)) throw new Error('Expected Uint8Array');
  return data;
}

const parseCsv = (b: unknown) => {
  const u8 = asBytes(b);
  return parse(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength), { bom: true, record_delimiter: '\r\n' });
};

const defaultCsvOpts: CsvWriterOptions = Object.freeze({
  maxChunks: 10, maxCells: 1000, maxIntervals: 100, maxDecodedBytes: 1024 * 1024,
  maxUncompressedBytes: 1024 * 1024, maxBytes: 1024 * 1024, maxWarnings: 100
});

const defaultXlsxOpts: XlsxWriterOptions = Object.freeze({
  maxChunks: 10, maxCells: 1000, maxIntervals: 100, maxDecodedBytes: 1024 * 1024,
  maxInputTextUnits: 500_000, maxBytes: 1024 * 1024, maxWarnings: 100
});

function makeWorkbookFixture(
  format: 'csv' | 'xlsx',
  sheets: Array<{ id: number; title: string; rows: number; cols: number; cells: Cell[] }>
) {
  const order = sheets.map(s => s.id);
  const metas = sheets.map((s, idx) => ({
    id: s.id, title: s.title, index: idx, type: 'GRID' as const, hidden: false, rows: s.rows, columns: s.cols
  }));
  const scopes = sheets.map(s => ({ sheetId: s.id, rect: { sheetId: s.id, r0: 0, c0: 0, r1: s.rows, c1: s.cols } }));
  const nameMappings = sheets.map(s => ({
    sheetId: s.id, originalTitle: s.title, exportedName: format === 'xlsx' ? s.title : `${s.title}.csv`
  }));

  const ctx: WriterContext = {
    sourceId: 'src_1', title: 'TestWorkbook', locale: 'en_US', timeZone: 'UTC',
    scopes, mode: 'raw', format, visibility: 'include_all', limitsVersion: '1.0',
    sheetOrder: order, sheets: metas
  };

  const rep: ExportReport = {
    schemaVersion: '1.0',
    source: { id: 'src_1', title: 'TestWorkbook', locale: 'en_US', timeZone: 'UTC' },
    export: {
      startedAt: '2026-11-01T00:00:00.000Z', producedAt: '2026-11-01T00:01:00.000Z',
      mode: 'raw', format, visibility: 'include_all', complete: true,
      consistency: 'not_atomic_no_change_detected', warnings: []
    },
    selectedScopes: scopes, sheetOrder: order, limitsVersion: '1.0', nameMappings, exclusions: []
  };

  const chunks: NormalizedChunk[] = sheets.map(s => ({
    jobId: 'job_1', chunkId: `c_${s.id}`,
    rect: { sheetId: s.id, r0: 0, c0: 0, r1: s.rows, c1: s.cols },
    cells: s.cells, excludedIntervals: { rows: [], columns: [] }, byteCount: 64
  }));

  return { ctx, rep, chunks };
}

describe('T24d2 CSV/XLSX WriterPort Format Adapters', () => {
  const signal = new AbortController().signal;

  it('CSV single-tab: naming, companion metadata actual counts and warnings, parsed rows', async () => {
    const writer = createCsvWriter(defaultCsvOpts);
    const { ctx, rep, chunks } = makeWorkbookFixture('csv', [{
      id: 10, title: 'Sales', rows: 2, cols: 2,
      cells: [
        { r: 0, c: 0, kind: 'string', value: 'Item' },
        { r: 0, c: 1, kind: 'string', value: 'Cost' },
        { r: 1, c: 0, kind: 'string', value: '=dangerous' },
        { r: 1, c: 1, kind: 'number', value: 42 }
      ]
    }]);

    await writer.begin(ctx, signal);
    await writer.append(chunks[0], signal);
    const artifacts = await writer.finalize(rep, signal);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].filename).toBe('Sales.csv');
    expect(artifacts[0].mimeType).toBe('text/csv');
    expect(artifacts[0].safeSummary).toBe('CSV sheet export');
    expect(artifacts[1].filename).toBe('Sales.metadata.json');
    expect(artifacts[1].mimeType).toBe('application/json');
    expect(artifacts[1].safeSummary).toBe('CSV export companion metadata');

    const rows = parseCsv(artifacts[0].data);
    expect(rows).toEqual([['Item', 'Cost'], ["'=dangerous", '42']]);

    const meta = JSON.parse(new TextDecoder().decode(asBytes(artifacts[1].data)));
    expect(meta.export.warnings.some((w: any) => w.code === 'CSV_TEXT_ESCAPED')).toBe(true);
    expect(meta.csvTransformCounts.totalTransformedCells).toBe(1);
    expect(meta.csvTransformCounts.bySheet[0].transformedCells).toBe(1);
    expect(meta.nameMappings[0].exportedName).toBe('Sales.csv');
  });

  it('CSV multi-tab ZIP: shuffled source IDs, blank tab, independent parseZipArchive + csv parser full expected rows', async () => {
    const writer = createCsvWriter(defaultCsvOpts);
    const { ctx, rep, chunks } = makeWorkbookFixture('csv', [
      { id: 20, title: 'BlankTab', rows: 2, cols: 2, cells: [] },
      {
        id: 10, title: 'Data', rows: 2, cols: 2,
        cells: [{ r: 0, c: 0, kind: 'string', value: 'Val1' }, { r: 1, c: 1, kind: 'number', value: 99 }]
      }
    ]);

    await writer.begin(ctx, signal);
    // Append in reverse order of source sheetOrder [20, 10] (shuffled arrival)
    await writer.append(chunks[1], signal);
    await writer.append(chunks[0], signal);
    const artifacts = await writer.finalize(rep, signal);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filename).toBe('TestWorkbook.zip');
    expect(artifacts[0].mimeType).toBe('application/zip');
    expect(artifacts[0].safeSummary).toBe('CSV ZIP export archive');

    const entries = parseZipArchive(asBytes(artifacts[0].data));
    expect(entries).toHaveLength(3);
    expect(entries[0].filename).toBe('BlankTab.csv');
    expect(entries[1].filename).toBe('Data.csv');
    expect(entries[2].filename).toBe('manifest.json');

    expect(parseCsv(entries[0].data)).toEqual([['', ''], ['', '']]);
    expect(parseCsv(entries[1].data)).toEqual([['Val1', ''], ['', '99']]);

    const manifest = JSON.parse(new TextDecoder().decode(entries[2].data));
    expect(manifest.sheetOrder).toEqual([20, 10]);
    expect(manifest.export.complete).toBe(true);
    expect(manifest.source.id).toBe('src_1');
  });

  it('XLSX: actual SheetJS + companion expected names, source, scopes, cell types', async () => {
    const writer = createXlsxWriter(defaultXlsxOpts);
    const { ctx, rep, chunks } = makeWorkbookFixture('xlsx', [
      {
        id: 10, title: 'Summary', rows: 2, cols: 2,
        cells: [
          { r: 0, c: 0, kind: 'string', value: 'Revenue' },
          { r: 0, c: 1, kind: 'number', value: 123.45 },
          { r: 1, c: 0, kind: 'boolean', value: true },
          { r: 1, c: 1, kind: 'string', value: 'Finished' }
        ]
      },
      { id: 20, title: 'EmptyTab', rows: 1, cols: 1, cells: [] }
    ]);

    await writer.begin(ctx, signal);
    await writer.append(chunks[0], signal);
    await writer.append(chunks[1], signal);
    const artifacts = await writer.finalize(rep, signal);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].filename).toBe('TestWorkbook.xlsx');
    expect(artifacts[0].mimeType).toBe(XLSX_MIME_TYPE);
    expect(artifacts[0].safeSummary).toBe(XLSX_PRIMARY_SAFE_SUMMARY);
    expect(artifacts[1].filename).toBe('TestWorkbook.metadata.json');
    expect(artifacts[1].mimeType).toBe(JSON_MIME_TYPE);
    expect(artifacts[1].safeSummary).toBe(XLSX_COMPANION_SAFE_SUMMARY);

    const wb = XLSX.read(asBytes(artifacts[0].data), { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['Summary', 'EmptyTab']);
    expect(wb.Sheets['Summary']['A1'].v).toBe('Revenue');
    expect(wb.Sheets['Summary']['A1'].t).toBe('s');
    expect(wb.Sheets['Summary']['B1'].v).toBe(123.45);
    expect(wb.Sheets['Summary']['B1'].t).toBe('n');
    expect(wb.Sheets['Summary']['A2'].v).toBe(true);
    expect(wb.Sheets['Summary']['A2'].t).toBe('b');
    expect(wb.Sheets['Summary']['B2'].v).toBe('Finished');
    expect(wb.Sheets['Summary']['B2'].t).toBe('s');
    expect(wb.Sheets['EmptyTab']['A1']).toBeUndefined();

    const companion = JSON.parse(new TextDecoder().decode(asBytes(artifacts[1].data)));
    expect(companion.source.id).toBe('src_1');
    expect(companion.source.title).toBe('TestWorkbook');
    expect(companion.selectedScopes).toHaveLength(2);
    expect(companion.nameMappings[0].exportedName).toBe('Summary');
    expect(companion.nameMappings[1].exportedName).toBe('EmptyTab');
  });

  it('rejects invalid config, wrong format at begin, missing coverage, and incomplete report without artifacts', async () => {
    // Config validation: safe non-negative integer, no -0, overflow, and getter throws
    const configError = expect.objectContaining({ code: 'CONFIG_INVALID', message: SAFE_ERROR_MESSAGES.CONFIG_INVALID });
    expect(() => createCsvWriter({ ...defaultCsvOpts, maxUncompressedBytes: -0 })).toThrowError(configError);
    expect(() => createCsvWriter({ ...defaultCsvOpts, maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES + 1 })).toThrowError(configError);
    expect(() => createCsvWriter({ ...defaultCsvOpts, get maxWarnings(): number { throw new Error('trap'); } })).toThrowError(configError);

    expect(() => createXlsxWriter({ ...defaultXlsxOpts, maxInputTextUnits: -0 })).toThrowError(configError);
    expect(() => createXlsxWriter({ ...defaultXlsxOpts, maxBytes: PROVISIONAL_MAX_XLSX_BYTES + 1 })).toThrowError(configError);
    expect(() => createXlsxWriter({ ...defaultXlsxOpts, get maxBytes(): number { throw new Error('trap'); } })).toThrowError(configError);

    // Wrong format at begin
    const csvWriter = createCsvWriter(defaultCsvOpts);
    const { ctx: xlsxCtx } = makeWorkbookFixture('xlsx', [{ id: 1, title: 'S', rows: 1, cols: 1, cells: [] }]);
    await expect(csvWriter.begin(xlsxCtx, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

    const xlsxWriter = createXlsxWriter(defaultXlsxOpts);
    const { ctx: csvCtx } = makeWorkbookFixture('csv', [{ id: 1, title: 'S', rows: 1, cols: 1, cells: [] }]);
    await expect(xlsxWriter.begin(csvCtx, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

    // Missing coverage: rect is 2x2 but chunk is 1x1
    const { ctx: covCtx, rep: covRep } = makeWorkbookFixture('csv', [{ id: 1, title: 'S', rows: 2, cols: 2, cells: [] }]);
    const partialChunk: NormalizedChunk = {
      jobId: 'job_1', chunkId: 'c_partial', rect: { sheetId: 1, r0: 0, c0: 0, r1: 1, c1: 1 },
      cells: [], excludedIntervals: { rows: [], columns: [] }, byteCount: 16
    };
    await csvWriter.begin(covCtx, signal);
    await csvWriter.append(partialChunk, signal);
    await expect(csvWriter.finalize(covRep, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

    // Incomplete / mismatched report
    const { ctx: okCtx, rep: okRep, chunks: okChunks } = makeWorkbookFixture('csv', [{ id: 1, title: 'S', rows: 1, cols: 1, cells: [] }]);
    const corruptRep: ExportReport = { ...okRep, source: { ...okRep.source, id: 'mismatched_id' } };
    await csvWriter.begin(okCtx, signal);
    await csvWriter.append(okChunks[0], signal);
    await expect(csvWriter.finalize(corruptRep, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
    for (const [exportMeta, code] of [
      [{ ...okRep.export, complete: false }, 'FORMAT_SERIALIZATION_FAILED'],
      [{ ...okRep.export, consistency: 'not_atomic_changes_detected' as const }, 'SOURCE_CHANGED_CONCURRENTLY']
    ] as const) {
      await csvWriter.begin(okCtx, signal);
      await csvWriter.append(okChunks[0], signal);
      await expect(csvWriter.finalize({ ...okRep, export: exportMeta }, signal)).rejects.toMatchObject({ code });
    }
  });

  it('recovers after abort and produces fresh independent buffer instances across sessions', async () => {
    let byteReads = 0;
    const writer = createCsvWriter({ ...defaultCsvOpts,
      get maxBytes() { return ++byteReads === 1 ? defaultCsvOpts.maxBytes : 0; }
    });
    const { ctx, rep, chunks } = makeWorkbookFixture('csv', [
      { id: 1, title: 'Tab', rows: 1, cols: 1, cells: [{ r: 0, c: 0, kind: 'string', value: 'Data' }] }
    ]);

    // Aborted session
    await writer.begin(ctx, signal);
    await writer.append(chunks[0], signal);
    await writer.abort();

    // Fresh session 1 recovery
    await writer.begin(ctx, signal);
    await writer.append(chunks[0], signal);
    const arts1 = await writer.finalize(rep, signal);

    // Fresh session 2 on same writer
    await writer.begin(ctx, signal);
    await writer.append(chunks[0], signal);
    const arts2 = await writer.finalize(rep, signal);

    expect(arts1[0].data).not.toBe(arts2[0].data);
    expect(arts1[1].data).not.toBe(arts2[1].data);
    expect(arts1[0].byteLength).toBe(arts2[0].byteLength);
    expect(byteReads).toBe(1);
  });

  it('handles genuine XLSX pending serialize cancellation and immediate fresh session', async () => {
    const writer = createXlsxWriter(defaultXlsxOpts);
    const { ctx: ctx1, rep: rep1, chunks: chunks1 } = makeWorkbookFixture('xlsx', [
      { id: 1, title: 'S1', rows: 1, cols: 1, cells: [{ r: 0, c: 0, kind: 'string', value: 'First' }] }
    ]);
    const { ctx: ctx2, rep: rep2, chunks: chunks2 } = makeWorkbookFixture('xlsx', [
      { id: 2, title: 'S2', rows: 1, cols: 1, cells: [{ r: 0, c: 0, kind: 'string', value: 'Second' }] }
    ]);

    const sampleWb = new ExcelJS.Workbook();
    const XLSXProto = Object.getPrototypeOf(sampleWb.xlsx);
    const origWrite = XLSXProto.writeBuffer;

    let gateResolve!: () => void;
    const gatePromise = new Promise<void>(r => { gateResolve = r; });
    let reachedResolve!: () => void;
    const reachedPromise = new Promise<void>(r => { reachedResolve = r; });

    try {
      XLSXProto.writeBuffer = async function() {
        reachedResolve();
        await gatePromise;
        return origWrite.apply(this);
      };

      const ac1 = new AbortController();
      await writer.begin(ctx1, ac1.signal);
      await writer.append(chunks1[0], ac1.signal);
      const finalizeP1 = writer.finalize(rep1, ac1.signal);
      const oldOutcome = finalizeP1.catch(error => error);

      // Wait until serialization enters writeBuffer
      await reachedPromise;
      // Cancel session 1 mid-serialization
      ac1.abort();
      // Install the fresh session synchronously before old cleanup can run.
      const ac2 = new AbortController();
      const aborted = writer.abort();
      const begun = writer.begin(ctx2, ac2.signal);
      await aborted;
      await begun;
      expect(await oldOutcome).toMatchObject({ code: 'OPERATION_ABORTED' });
      await writer.append(chunks2[0], ac2.signal);

      // Unblock delayed writeBuffer from session 1 (late promise settling)
      gateResolve();

      const arts2 = await writer.finalize(rep2, ac2.signal);
      expect(arts2).toHaveLength(2);
      expect(arts2[0].safeSummary).toBe(XLSX_PRIMARY_SAFE_SUMMARY);

      const wb2 = XLSX.read(asBytes(arts2[0].data), { type: 'buffer' });
      expect(wb2.SheetNames).toEqual(['S2']);
      expect(wb2.Sheets['S2']['A1'].v).toBe('Second');
    } finally {
      gateResolve();
      XLSXProto.writeBuffer = origWrite;
    }
  });
});
