import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parse } from 'csv-parse/sync';

import type { Cell, ExportFormat, ExportReport, NormalizedChunk } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import { snapshotWriterContext } from '../../src/export/context.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import { buildCompleteExportReport } from '../../src/export/report.ts';
import {
  CANONICAL_SPREADSHEET_ID,
  CANONICAL_SPARSE_SHEET_ID,
  createCanonicalExportReport,
  createCanonicalWriterContext
} from '../helpers/fixtures.ts';
import {
  createWorkerWriter,
  PROVISIONAL_WORKER_LIMITS
} from '../../src/runtime/worker-writers.ts';

function asBytes(data: unknown): Uint8Array {
  if (!(data instanceof Uint8Array)) throw new Error('Expected Uint8Array');
  return data;
}

function parseJsonBytes(data: unknown): any {
  const u8 = asBytes(data);
  return JSON.parse(new TextDecoder().decode(u8));
}

function makeSmallContext(format: ExportFormat, signal: AbortSignal): WriterContext {
  const base = createCanonicalWriterContext();
  const rawContext: WriterContext = {
    sourceId: base.sourceId,
    title: base.title,
    locale: base.locale,
    timeZone: base.timeZone,
    scopes: [
      {
        sheetId: CANONICAL_SPARSE_SHEET_ID,
        rect: { sheetId: CANONICAL_SPARSE_SHEET_ID, r0: 0, c0: 0, r1: 2, c1: 2 }
      }
    ],
    mode: 'raw',
    format,
    visibility: 'include_all',
    limitsVersion: base.limitsVersion,
    sheetOrder: [CANONICAL_SPARSE_SHEET_ID],
    sheets: [
      {
        id: CANONICAL_SPARSE_SHEET_ID,
        title: 'SparseTab',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: 2,
        columns: 2
      }
    ]
  };

  return snapshotWriterContext(rawContext, {
    maxSheets: 10,
    signal
  });
}

function makeReportForContext(context: WriterContext, format: ExportFormat): ExportReport {
  const base = createCanonicalExportReport();
  return {
    schemaVersion: '1.0',
    source: {
      id: context.sourceId,
      title: context.title,
      locale: context.locale,
      timeZone: context.timeZone
    },
    export: {
      startedAt: base.export.startedAt,
      producedAt: base.export.producedAt,
      mode: context.mode,
      format,
      visibility: context.visibility,
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: []
    },
    selectedScopes: context.scopes,
    sheetOrder: context.sheetOrder,
    limitsVersion: context.limitsVersion,
    nameMappings: context.sheetOrder.map((sheetId) => {
      const sheet = context.sheets.find((s) => s.id === sheetId)!;
      return {
        sheetId: sheet.id,
        originalTitle: sheet.title,
        exportedName: format === 'xlsx' ? sheet.title : format === 'csv' ? `${sheet.title}.csv` : sheet.title
      };
    }),
    exclusions: []
  };
}

function makeChunk(sheetId: number, cells: Cell[], jobId = 'canonical-job-1'): NormalizedChunk {
  return {
    jobId,
    chunkId: `chunk_${sheetId}`,
    rect: { sheetId, r0: 0, c0: 0, r1: 2, c1: 2 },
    cells,
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 64
  };
}

describe('T36b4 Local Worker Writer Factory', () => {
  const signal = new AbortController().signal;

  it('asserts captured exported limits and freeze immutability', () => {
    expect(Object.isFrozen(PROVISIONAL_WORKER_LIMITS)).toBe(true);
    expect(PROVISIONAL_WORKER_LIMITS).toEqual({
      maxChunks: 4096,
      maxCells: 250000,
      maxIntervals: 250000,
      maxDecodedBytes: 64 * 1024 * 1024,
      maxWarnings: 4096,
      maxOutputBytes: 64 * 1024 * 1024,
      maxUncompressedBytes: 64 * 1024 * 1024,
      maxInputTextUnits: 8000000
    });
  });

  it('rejects unsupported or hostile runtime format with static FORMAT_UNSUPPORTED without invoking hooks', () => {
    let hookCalled = false;
    const hostileObject = {
      get toString() {
        hookCalled = true;
        throw new Error('hostile toString called');
      },
      get valueOf() {
        hookCalled = true;
        throw new Error('hostile valueOf called');
      },
      [Symbol.toPrimitive]() {
        hookCalled = true;
        throw new Error('hostile toPrimitive called');
      }
    };

    expect(() => createWorkerWriter(hostileObject as unknown as ExportFormat)).toThrow(DomainError);
    try {
      createWorkerWriter(hostileObject as unknown as ExportFormat);
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('FORMAT_UNSUPPORTED');
    }
    expect(hookCalled).toBe(false);

    const hostileProxy = new Proxy({}, {
      get() {
        hookCalled = true;
        throw new Error('hostile proxy trap triggered');
      },
      has() {
        hookCalled = true;
        throw new Error('hostile proxy trap triggered');
      }
    });

    expect(() => createWorkerWriter(hostileProxy as unknown as ExportFormat)).toThrow(DomainError);
    try {
      createWorkerWriter(hostileProxy as unknown as ExportFormat);
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('FORMAT_UNSUPPORTED');
    }
    expect(hookCalled).toBe(false);

    const badFormats = ['xml', 'pdf', 'yaml', '', 'JSON', 'CSV', 'XLSX', null, undefined, 42, true, []];
    for (const bad of badFormats) {
      expect(() => createWorkerWriter(bad as unknown as ExportFormat)).toThrow(DomainError);
      try {
        createWorkerWriter(bad as unknown as ExportFormat);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_UNSUPPORTED');
      }
    }
  });

  it('JSON factory wiring: produces valid JSON document with expected selected value and source coords', async () => {
    const writer = createWorkerWriter('json');
    const context = makeSmallContext('json', signal);
    const cells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: 'json_val_A1' },
      { r: 1, c: 1, kind: 'number', value: 123 }
    ];
    const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells);
    const report = makeReportForContext(context, 'json');

    // Verify prepared report matching context through reviewed helper
    const prepared = prepareWriterData(context, [chunk], {
      maxChunks: PROVISIONAL_WORKER_LIMITS.maxChunks,
      maxIntervals: PROVISIONAL_WORKER_LIMITS.maxIntervals,
      maxCells: PROVISIONAL_WORKER_LIMITS.maxCells,
      signal
    });
    const completeReport = buildCompleteExportReport(context, prepared, report, {
      maxWarnings: PROVISIONAL_WORKER_LIMITS.maxWarnings,
      signal
    });
    expect(completeReport.export.format).toBe('json');
    expect(completeReport.export.complete).toBe(true);

    await writer.begin(context, signal);
    await writer.append(chunk, signal);
    const artifacts = await writer.finalize(completeReport, signal);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filename).toBe('Canonical Test Workbook.json');
    expect(artifacts[0].mimeType).toBe('application/json');

    const parsed = parseJsonBytes(artifacts[0].data);
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.source.id).toBe(CANONICAL_SPREADSHEET_ID);
    expect(parsed.sheets).toHaveLength(1);
    expect(parsed.sheets[0].title).toBe('SparseTab');
    expect(parsed.sheets[0].cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: 'json_val_A1' },
      { r: 1, c: 1, kind: 'number', value: 123 }
    ]);
  });

  it('CSV factory wiring: produces primary CSV with expected cell value and staged companion metadata', async () => {
    const writer = createWorkerWriter('csv');
    const context = makeSmallContext('csv', signal);
    const cells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: 'csv_val_A1' },
      { r: 1, c: 1, kind: 'number', value: 456 }
    ];
    const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells);
    const report = makeReportForContext(context, 'csv');

    await writer.begin(context, signal);
    await writer.append(chunk, signal);
    const artifacts = await writer.finalize(report, signal);

    // Single-tab CSV produces 2 artifacts: primary CSV + private staged companion metadata
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].filename).toBe('SparseTab.csv');
    expect(artifacts[0].mimeType).toBe('text/csv');

    const csvBytes = asBytes(artifacts[0].data);
    const rows = parse(Buffer.from(csvBytes.buffer, csvBytes.byteOffset, csvBytes.byteLength), { bom: true, record_delimiter: '\r\n' });
    expect(rows).toEqual([['csv_val_A1', ''], ['', '456']]);

    // Staged companion metadata remains private
    expect(artifacts[1].filename).toBe('SparseTab.metadata.json');
    expect(artifacts[1].mimeType).toBe('application/json');
    const meta = parseJsonBytes(artifacts[1].data);
    expect(meta.export.format).toBe('csv');
    expect(meta.source.id).toBe(CANONICAL_SPREADSHEET_ID);
  });

  it('XLSX factory wiring: produces valid workbook and companion report with expected selected value', async () => {
    const writer = createWorkerWriter('xlsx');
    const context = makeSmallContext('xlsx', signal);
    const cells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: 'xlsx_val_A1' },
      { r: 1, c: 1, kind: 'number', value: 789 }
    ];
    const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells);
    const report = makeReportForContext(context, 'xlsx');

    await writer.begin(context, signal);
    await writer.append(chunk, signal);
    const artifacts = await writer.finalize(report, signal);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].filename).toBe('Canonical Test Workbook.xlsx');
    expect(artifacts[0].mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const xlsxBytes = asBytes(artifacts[0].data);
    const wb = XLSX.read(Buffer.from(xlsxBytes.buffer, xlsxBytes.byteOffset, xlsxBytes.byteLength), { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['SparseTab']);
    const ws = wb.Sheets['SparseTab'];
    expect(ws['A1']?.v).toBe('xlsx_val_A1');
    expect(ws['B2']?.v).toBe(789);
    expect(ws['A1']?.t).toBe('s');
    expect(ws['B2']?.t).toBe('n');
    expect(ws['A1']?.f).toBeUndefined();
    expect(ws['B2']?.f).toBeUndefined();
    expect(ws['A2']).toBeUndefined();
    expect(ws['B1']).toBeUndefined();

    expect(artifacts[1].filename).toBe('Canonical Test Workbook.metadata.json');
    expect(artifacts[1].mimeType).toBe('application/json');
    const rep = parseJsonBytes(artifacts[1].data);
    expect(rep.export.format).toBe('xlsx');
    expect(rep.source.id).toBe(CANONICAL_SPREADSHEET_ID);
  });

  it('proves two factory instances of the same format are completely independent', async () => {
    // JSON independence
    const w1 = createWorkerWriter('json');
    const w2 = createWorkerWriter('json');
    expect(w1).not.toBe(w2);

    const ctx1 = makeSmallContext('json', signal);
    const ctx2 = makeSmallContext('json', signal);

    const c1 = makeChunk(CANONICAL_SPARSE_SHEET_ID, [{ r: 0, c: 0, kind: 'string', value: 'instance_1_exclusive' }], 'job-inst-1');
    const c2 = makeChunk(CANONICAL_SPARSE_SHEET_ID, [{ r: 0, c: 0, kind: 'string', value: 'instance_2_exclusive' }], 'job-inst-2');

    const rep1 = makeReportForContext(ctx1, 'json');
    const rep2 = makeReportForContext(ctx2, 'json');

    await w1.begin(ctx1, signal);
    await w2.begin(ctx2, signal);

    await w1.append(c1, signal);
    await w2.append(c2, signal);

    const [art1, art2] = await Promise.all([
      w1.finalize(rep1, signal),
      w2.finalize(rep2, signal)
    ]);

    const parsed1 = parseJsonBytes(art1[0].data);
    const parsed2 = parseJsonBytes(art2[0].data);

    expect(parsed1.sheets[0].cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: 'instance_1_exclusive' }
    ]);
    expect(parsed2.sheets[0].cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: 'instance_2_exclusive' }
    ]);

    // CSV independence
    const csvW1 = createWorkerWriter('csv');
    const csvW2 = createWorkerWriter('csv');
    expect(csvW1).not.toBe(csvW2);

    const csvCtx1 = makeSmallContext('csv', signal);
    const csvCtx2 = makeSmallContext('csv', signal);

    await csvW1.begin(csvCtx1, signal);
    await csvW2.begin(csvCtx2, signal);

    await csvW1.append(makeChunk(CANONICAL_SPARSE_SHEET_ID, [{ r: 0, c: 0, kind: 'string', value: 'csv_inst_1' }], 'job-csv-1'), signal);
    await csvW2.append(makeChunk(CANONICAL_SPARSE_SHEET_ID, [{ r: 0, c: 0, kind: 'string', value: 'csv_inst_2' }], 'job-csv-2'), signal);

    const [csvArt1, csvArt2] = await Promise.all([
      csvW1.finalize(makeReportForContext(csvCtx1, 'csv'), signal),
      csvW2.finalize(makeReportForContext(csvCtx2, 'csv'), signal)
    ]);

    const csvBytes1 = asBytes(csvArt1[0].data);
    const csvRows1 = parse(Buffer.from(csvBytes1.buffer, csvBytes1.byteOffset, csvBytes1.byteLength), { bom: true, record_delimiter: '\r\n' });
    expect(csvRows1[0][0]).toBe('csv_inst_1');

    const csvBytes2 = asBytes(csvArt2[0].data);
    const csvRows2 = parse(Buffer.from(csvBytes2.buffer, csvBytes2.byteOffset, csvBytes2.byteLength), { bom: true, record_delimiter: '\r\n' });
    expect(csvRows2[0][0]).toBe('csv_inst_2');

    // XLSX independence
    const xlsxW1 = createWorkerWriter('xlsx');
    const xlsxW2 = createWorkerWriter('xlsx');
    expect(xlsxW1).not.toBe(xlsxW2);

    const xlsxCtx1 = makeSmallContext('xlsx', signal);
    const xlsxCtx2 = makeSmallContext('xlsx', signal);

    await xlsxW1.begin(xlsxCtx1, signal);
    await xlsxW2.begin(xlsxCtx2, signal);

    await xlsxW1.append(makeChunk(CANONICAL_SPARSE_SHEET_ID, [{ r: 0, c: 0, kind: 'string', value: 'xlsx_inst_1' }], 'job-xlsx-1'), signal);
    await xlsxW2.append(makeChunk(CANONICAL_SPARSE_SHEET_ID, [{ r: 0, c: 0, kind: 'string', value: 'xlsx_inst_2' }], 'job-xlsx-2'), signal);

    const [xlsxArt1, xlsxArt2] = await Promise.all([
      xlsxW1.finalize(makeReportForContext(xlsxCtx1, 'xlsx'), signal),
      xlsxW2.finalize(makeReportForContext(xlsxCtx2, 'xlsx'), signal)
    ]);

    const xlsxBytes1 = asBytes(xlsxArt1[0].data);
    const wb1 = XLSX.read(Buffer.from(xlsxBytes1.buffer, xlsxBytes1.byteOffset, xlsxBytes1.byteLength), { type: 'buffer' });
    expect(wb1.Sheets['SparseTab']['A1']?.v).toBe('xlsx_inst_1');

    const xlsxBytes2 = asBytes(xlsxArt2[0].data);
    const wb2 = XLSX.read(Buffer.from(xlsxBytes2.buffer, xlsxBytes2.byteOffset, xlsxBytes2.byteLength), { type: 'buffer' });
    expect(wb2.Sheets['SparseTab']['A1']?.v).toBe('xlsx_inst_2');
  });
});
