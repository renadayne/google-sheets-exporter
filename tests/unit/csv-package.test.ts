import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fflate from 'fflate';
import { parse } from 'csv-parse/sync';

vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>();
  return {
    ...actual,
    zipSync: vi.fn((...args: Parameters<typeof actual.zipSync>) => actual.zipSync(...args)),
  };
});

import { packageCsv, type PackageCsvOptions } from '../../src/export/csv-package.ts';
import {
  PROVISIONAL_MAX_CSV_ZIP_BYTES,
  PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
} from '../../src/export/csv-zip.ts';
import { PROVISIONAL_MAX_WARNINGS } from '../../src/export/report.ts';
import { snapshotWriterContext, PROVISIONAL_MAX_SHEETS } from '../../src/export/context.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import { PROVISIONAL_MAX_CHUNKS } from '../../src/export/coverage.ts';
import { PROVISIONAL_MAX_INTERVALS } from '../../src/export/exclusions.ts';
import { PROVISIONAL_MAX_CELLS } from '../../src/export/cells.ts';
import { mapCsvFilenames, formatWorkbookArtifactFilename } from '../../src/export/names.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import { isExportReport } from '../../src/contracts/validation.ts';
import { parseZipArchive } from '../helpers/zip-reader.ts';
import type {
  Cell,
  ExportReport,
  ExcludedIntervals,
  NormalizedChunk,
  SheetMeta,
} from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';

const parseCsv = (b: Uint8Array) =>
  parse(Buffer.from(b.buffer, b.byteOffset, b.byteLength), { bom: true, record_delimiter: '\r\n' });

const defPrepareOpts = {
  maxChunks: PROVISIONAL_MAX_CHUNKS,
  maxIntervals: PROVISIONAL_MAX_INTERVALS,
  maxCells: PROVISIONAL_MAX_CELLS,
  signal: new AbortController().signal,
};

function makeSingleSheetFixture(title = 'Sales 2026') {
  const signal = new AbortController().signal;
  const meta: SheetMeta = {
    id: 42,
    title,
    index: 0,
    type: 'GRID',
    hidden: false,
    rows: 10,
    columns: 10,
  };
  const scope = { sheetId: 42, rect: { sheetId: 42, r0: 1, c0: 1, r1: 4, c1: 4 } };

  const rawContext: WriterContext = {
    sourceId: 'src_single_test',
    title: 'Single Sheet Workbook',
    locale: 'en',
    timeZone: 'UTC',
    mode: 'raw',
    format: 'csv',
    visibility: 'include_all',
    limitsVersion: '1.0',
    sheetOrder: [42],
    scopes: [scope],
    sheets: [meta],
  };

  const context = snapshotWriterContext(rawContext, {
    maxSheets: PROVISIONAL_MAX_SHEETS,
    signal,
  });

  const cells: Cell[] = [
    { r: 1, c: 1, kind: 'string', value: '=HYPERLINK("http://bad")' },
    { r: 1, c: 2, kind: 'string', value: 'hello "world"' },
    { r: 2, c: 3, kind: 'number', value: 123.45 },
  ];

  const chunk: NormalizedChunk = {
    jobId: 'j_single',
    chunkId: 'chunk_42',
    rect: { sheetId: 42, r0: 1, c0: 1, r1: 4, c1: 4 },
    cells,
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 64,
  };

  const prepared = prepareWriterData(context, [chunk], defPrepareOpts);
  const nameMappings = mapCsvFilenames([{ id: 42, title }]);

  const report: ExportReport = {
    schemaVersion: '1.0',
    source: {
      id: 'src_single_test',
      title: 'Single Sheet Workbook',
      locale: 'en',
      timeZone: 'UTC',
    },
    export: {
      startedAt: '2026-11-01T10:00:00.000Z',
      producedAt: '2026-11-01T10:00:01.000Z',
      mode: 'raw',
      format: 'csv',
      visibility: 'include_all',
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: [],
    },
    selectedScopes: [scope],
    sheetOrder: [42],
    limitsVersion: '1.0',
    nameMappings,
    exclusions: [],
  };

  return { context, prepared, report, signal };
}

function make3SheetsFixture(workbookTitle = 'My Report') {
  const signal = new AbortController().signal;

  const meta1: SheetMeta = { id: 30, title: 'Data/Input', index: 0, type: 'GRID', hidden: false, rows: 10, columns: 10 };
  const meta2: SheetMeta = { id: 10, title: 'Data:Input', index: 1, type: 'GRID', hidden: false, rows: 10, columns: 10 };
  const meta3: SheetMeta = { id: 20, title: 'EmptySheet', index: 2, type: 'GRID', hidden: false, rows: 10, columns: 10 };

  const scope1 = { sheetId: 30, rect: { sheetId: 30, r0: 2, c0: 1, r1: 5, c1: 4 } };
  const scope2 = { sheetId: 10, rect: { sheetId: 10, r0: 0, c0: 0, r1: 2, c1: 2 } };
  const scope3 = { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 3, c1: 3 } };

  const rawContext: WriterContext = {
    sourceId: 'src_3sheets',
    title: workbookTitle,
    locale: 'en',
    timeZone: 'UTC',
    mode: 'raw',
    format: 'csv',
    visibility: 'include_all',
    limitsVersion: '1.0',
    sheetOrder: [30, 10, 20],
    scopes: [scope1, scope2, scope3],
    sheets: [meta1, meta2, meta3],
  };

  const context = snapshotWriterContext(rawContext, {
    maxSheets: PROVISIONAL_MAX_SHEETS,
    signal,
  });

  const cells1: Cell[] = [
    { r: 2, c: 1, kind: 'string', value: '00123' },
    { r: 2, c: 2, kind: 'string', value: 'café 🌟' },
    { r: 3, c: 1, kind: 'string', value: '=SUM(A1)' },
    { r: 3, c: 2, kind: 'number', value: -42 },
    { r: 4, c: 3, kind: 'boolean', value: true },
  ];

  const cells2: Cell[] = [
    { r: 0, c: 0, kind: 'string', value: 'tab10' },
  ];

  const emptyExcl: ExcludedIntervals = { rows: [], columns: [] };

  const chunks: NormalizedChunk[] = [
    { jobId: 'j', chunkId: 'c_30', rect: scope1.rect, cells: cells1, excludedIntervals: emptyExcl, byteCount: 64 },
    { jobId: 'j', chunkId: 'c_10', rect: scope2.rect, cells: cells2, excludedIntervals: emptyExcl, byteCount: 32 },
    { jobId: 'j', chunkId: 'c_20', rect: scope3.rect, cells: [], excludedIntervals: emptyExcl, byteCount: 16 },
  ];

  const prepared = prepareWriterData(context, chunks, defPrepareOpts);
  const nameMappings = mapCsvFilenames([
    { id: 30, title: 'Data/Input' },
    { id: 10, title: 'Data:Input' },
    { id: 20, title: 'EmptySheet' },
  ]);

  const report: ExportReport = {
    schemaVersion: '1.0',
    source: {
      id: 'src_3sheets',
      title: workbookTitle,
      locale: 'en',
      timeZone: 'UTC',
    },
    export: {
      startedAt: '2026-11-01T10:00:00.000Z',
      producedAt: '2026-11-01T10:00:01.000Z',
      mode: 'raw',
      format: 'csv',
      visibility: 'include_all',
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: [],
    },
    selectedScopes: [scope1, scope2, scope3],
    sheetOrder: [30, 10, 20],
    limitsVersion: '1.0',
    nameMappings,
    exclusions: [],
  };

  return { context, prepared, report, signal, nameMappings };
}

describe('T27c2 Bounded CSV Artifact Assembly', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const defaultOptions: PackageCsvOptions = {
    maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
    maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
    maxWarnings: PROVISIONAL_MAX_WARNINGS,
    signal: new AbortController().signal,
  };

  it('keeps API-visible exclusions at absolute report coordinates and dense CSV row positions', () => {
    const original = make3SheetsFixture();
    const context = snapshotWriterContext({ ...original.context, visibility: 'api_visible' }, {
      maxSheets: PROVISIONAL_MAX_SHEETS, signal: defaultOptions.signal
    });
    const chunks: NormalizedChunk[] = original.prepared.map((p, index) => ({
      jobId: 'visible_job', chunkId: `visible_${index}`, rect: p.scope,
      cells: index === 0 ? p.cells.filter(cell => cell.r !== 4) : p.cells,
      excludedIntervals: { rows: index === 0 ? [{ start: 4, end: 5 }] : [], columns: [] },
      byteCount: 64
    }));
    const prepared = prepareWriterData(context, chunks, defPrepareOpts);
    const report: ExportReport = {
      ...original.report, export: { ...original.report.export, visibility: 'api_visible' },
      exclusions: [{ sheetId: 30, excludedRows: [{ start: 4, end: 5 }], excludedColumns: [] }]
    };
    const [artifact] = packageCsv(context, prepared, report, defaultOptions);
    const entries = parseZipArchive(artifact.data as Uint8Array);
    expect(parseCsv(entries[0].data)).toEqual([
      ['00123', 'café 🌟', ''], ["'=SUM(A1)", '-42', ''], ['', '', '']
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(entries[3].data));
    expect(manifest.export.visibility).toBe('api_visible');
    expect(manifest.exclusions).toEqual([{ sheetId: 30, excludedRows: [{ start: 4, end: 5 }], excludedColumns: [] }]);
    expect(manifest.selectedScopes[0]).toEqual({ sheetId: 30, rect: { sheetId: 30, r0: 2, c0: 1, r1: 5, c1: 4 } });
  });

  it('1. single-tab produces primary CSV artifact and optional companion metadata artifact with actual mapping, BOM, quote-all, CRLF, and transform warning', () => {
    const { context, prepared, report, signal } = makeSingleSheetFixture('Sales/2026');
    const opts: PackageCsvOptions = {
      maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
      maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
      maxWarnings: PROVISIONAL_MAX_WARNINGS,
      signal,
    };

    const artifacts = packageCsv(context, prepared, report, opts);
    expect(Object.isFrozen(artifacts)).toBe(true);
    expect(artifacts).toHaveLength(2);

    const [csvArt, metaArt] = artifacts;
    expect(Object.isFrozen(csvArt)).toBe(true);
    expect(Object.isFrozen(metaArt)).toBe(true);

    // Buffers themselves must NOT be frozen
    expect(Object.isFrozen(csvArt.data)).toBe(false);
    expect(Object.isFrozen(metaArt.data)).toBe(false);

    // Primary filename: from sheet title mapping (Sales_2026.csv), NOT workbook title
    expect(csvArt.filename).toBe('Sales_2026.csv');
    expect(csvArt.mimeType).toBe('text/csv');
    expect(csvArt.byteLength).toBe((csvArt.data as Uint8Array).byteLength);
    expect(csvArt.safeSummary).toBe('CSV sheet export');

    // Companion metadata filename: formatMetadataArtifactFilename('Sales_2026.csv')
    expect(metaArt.filename).toBe('Sales_2026.metadata.json');
    expect(metaArt.mimeType).toBe('application/json');
    expect(metaArt.byteLength).toBe((metaArt.data as Uint8Array).byteLength);
    expect(metaArt.safeSummary).toBe('CSV export companion metadata');

    // Verify CSV bytes: UTF-8 BOM, CRLF, quote-all, relative dense gaps, formula prefix
    const csvBytes = csvArt.data instanceof Uint8Array ? csvArt.data : new Uint8Array();
    expect(csvBytes[0]).toBe(0xef);
    expect(csvBytes[1]).toBe(0xbb);
    expect(csvBytes[2]).toBe(0xbf);

    const csvText = new TextDecoder('utf-8').decode(csvBytes);
    expect(csvText.endsWith('\r\n')).toBe(true);

    const rows = parseCsv(csvBytes);
    // Scope is r: 1..3, c: 1..3 (3x3 rectangle)
    expect(rows).toEqual([
      ["'=HYPERLINK(\"http://bad\")", 'hello "world"', ''],
      ['', '', '123.45'],
      ['', '', ''],
    ]);

    // Verify companion metadata content: valid ExportReport with CSV transform count & warning
    const metaText = new TextDecoder('utf-8').decode(metaArt.data as Uint8Array);
    const parsedMeta = JSON.parse(metaText);
    expect(isExportReport(parsedMeta)).toBe(true);
    expect(parsedMeta.csvTransformCounts).toEqual({
      policy: 'apostrophe_prefix_v1',
      totalTransformedCells: 1,
      bySheet: [{ sheetId: 42, transformedCells: 1 }],
    });
    expect(parsedMeta.nameMappings).toEqual([
      { sheetId: 42, originalTitle: 'Sales/2026', exportedName: 'Sales_2026.csv' },
    ]);
    expect(parsedMeta.export.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'CSV_TEXT_ESCAPED' })])
    );
  });

  it('2. 3-tab produces single ZIP artifact with workbook naming, entries in source order + manifest.json last, non-zero origins, blank rectangle fills, formula escapes, and full independent manifest verification', () => {
    const { context, prepared, report, signal } = make3SheetsFixture('Q1 Report');
    const opts: PackageCsvOptions = {
      maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
      maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
      maxWarnings: PROVISIONAL_MAX_WARNINGS,
      signal,
    };

    const artifacts = packageCsv(context, prepared, report, opts);
    expect(Object.isFrozen(artifacts)).toBe(true);
    expect(artifacts).toHaveLength(1);

    const zipArt = artifacts[0];
    expect(Object.isFrozen(zipArt)).toBe(true);
    expect(Object.isFrozen(zipArt.data)).toBe(false);

    // Primary ZIP name derived from context title
    expect(zipArt.filename).toBe(formatWorkbookArtifactFilename('Q1 Report', 'zip'));
    expect(zipArt.filename).toBe('Q1 Report.zip');
    expect(zipArt.mimeType).toBe('application/zip');
    expect(zipArt.byteLength).toBe((zipArt.data as Uint8Array).byteLength);
    expect(zipArt.safeSummary).toBe('CSV ZIP export archive');

    // Independent ZIP32 Central Directory reader
    const zipBytes = zipArt.data instanceof Uint8Array ? zipArt.data : new Uint8Array();
    const entries = parseZipArchive(zipBytes);
    expect(entries).toHaveLength(4);

    const entryNames = entries.map((e) => e.filename);
    expect(entryNames).toEqual(['Data_Input.csv', 'Data_Input_10.csv', 'EmptySheet.csv', 'manifest.json']);

    // Entry 0 (Sheet 30): non-zero origin [2, 1, 5, 4] -> 3x3 rectangle
    const s0Rows = parseCsv(entries[0].data);
    expect(s0Rows).toEqual([
      ['00123', 'café 🌟', ''],
      ["'=SUM(A1)", '-42', ''],
      ['', '', 'TRUE'],
    ]);

    // Entry 1 (Sheet 10): origin [0, 0, 2, 2] -> 2x2 rectangle
    const s1Rows = parseCsv(entries[1].data);
    expect(s1Rows).toEqual([
      ['tab10', ''],
      ['', ''],
    ]);

    // Entry 2 (Sheet 20): origin [0, 0, 3, 3] -> 3x3 blank rectangle
    const s2Rows = parseCsv(entries[2].data);
    expect(s2Rows).toEqual([
      ['', '', ''],
      ['', '', ''],
      ['', '', ''],
    ]);

    // Entry 3: manifest.json (must be last entry only)
    const manifestJson = JSON.parse(new TextDecoder('utf-8').decode(entries[3].data));
    expect(isExportReport(manifestJson)).toBe(true);
    expect(manifestJson.schemaVersion).toBe('1.0');
    expect(manifestJson.source).toEqual({
      id: 'src_3sheets',
      title: 'Q1 Report',
      locale: 'en',
      timeZone: 'UTC',
    });
    expect(manifestJson.export).toEqual({
      startedAt: '2026-11-01T10:00:00.000Z', producedAt: '2026-11-01T10:00:01.000Z',
      mode: 'raw', format: 'csv', visibility: 'include_all', complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: [{ code: 'CSV_TEXT_ESCAPED', message: 'Some source strings were prefixed for CSV safety. JSON preserves original values.' }]
    });
    expect(manifestJson.sheetOrder).toEqual([30, 10, 20]);
    expect(manifestJson.selectedScopes).toEqual([
      { sheetId: 30, rect: { sheetId: 30, r0: 2, c0: 1, r1: 5, c1: 4 } },
      { sheetId: 10, rect: { sheetId: 10, r0: 0, c0: 0, r1: 2, c1: 2 } },
      { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 3, c1: 3 } }
    ]);
    expect(manifestJson.limitsVersion).toBe('1.0');
    expect(manifestJson.exclusions).toEqual([]);
    expect(manifestJson.nameMappings).toEqual([
      { sheetId: 30, originalTitle: 'Data/Input', exportedName: 'Data_Input.csv' },
      { sheetId: 10, originalTitle: 'Data:Input', exportedName: 'Data_Input_10.csv' },
      { sheetId: 20, originalTitle: 'EmptySheet', exportedName: 'EmptySheet.csv' }
    ]);
    expect(manifestJson.csvTransformCounts).toEqual({
      policy: 'apostrophe_prefix_v1',
      totalTransformedCells: 1,
      bySheet: [
        { sheetId: 30, transformedCells: 1 },
        { sheetId: 10, transformedCells: 0 },
        { sheetId: 20, transformedCells: 0 },
      ],
    });
  });

  it('3. enforces exact aggregate caps vs cap - 1 on single-branch and compressed boundary on ZIP-branch', () => {
    // Single sheet: checks staged bytes = CSV + metadata against maxBytes
    const single = makeSingleSheetFixture();
    const normalArts = packageCsv(single.context, single.prepared, single.report, defaultOptions);
    const totalStaged = normalArts[0].byteLength + normalArts[1].byteLength;

    // Exact maxBytes: succeeds
    const exactSingle = packageCsv(single.context, single.prepared, single.report, {
      ...defaultOptions,
      maxBytes: totalStaged,
    });
    expect(exactSingle).toHaveLength(2);

    // maxBytes = totalStaged - 1: rejects with BYTE_LIMIT_EXCEEDED
    expect(() =>
      packageCsv(single.context, single.prepared, single.report, {
        ...defaultOptions,
        maxBytes: totalStaged - 1,
      })
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'BYTE_LIMIT_EXCEEDED' }));

    // Multi sheet: compressed archive size check
    const multi = make3SheetsFixture();
    const validZip = packageCsv(multi.context, multi.prepared, multi.report, defaultOptions);
    const archiveSize = validZip[0].byteLength;
    const uncompressedSize = parseZipArchive(validZip[0].data as Uint8Array).reduce((sum, entry) => sum + entry.data.byteLength, 0);
    const exactUncompressed = packageCsv(multi.context, multi.prepared, multi.report, {
      ...defaultOptions, maxUncompressedBytes: uncompressedSize
    });
    expect(exactUncompressed[0].data).toEqual(validZip[0].data);
    const zipCalls = vi.mocked(fflate.zipSync).mock.calls.length;
    expect(() => packageCsv(multi.context, multi.prepared, multi.report, {
      ...defaultOptions, maxUncompressedBytes: uncompressedSize - 1
    })).toThrowError(expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' }));
    expect(vi.mocked(fflate.zipSync).mock.calls.length).toBe(zipCalls);

    // Exact maxBytes = archiveSize: succeeds
    const exactZip = packageCsv(multi.context, multi.prepared, multi.report, {
      ...defaultOptions,
      maxBytes: archiveSize,
    });
    expect(exactZip[0].byteLength).toBe(archiveSize);

    // maxBytes = archiveSize - 1: rejects with BYTE_LIMIT_EXCEEDED
    expect(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        ...defaultOptions,
        maxBytes: archiveSize - 1,
      })
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'BYTE_LIMIT_EXCEEDED' }));
  });

  it('4. rejects with BYTE_LIMIT_EXCEEDED when CSV sheets fit but remaining uncompressed budget cannot fit metadata', () => {
    const single = makeSingleSheetFixture();
    const normalArts = packageCsv(single.context, single.prepared, single.report, defaultOptions);
    const csvByteLen = normalArts[0].byteLength;
    const metaByteLen = normalArts[1].byteLength;

    // Set maxUncompressedBytes to just CSV bytes + a fraction of metadata bytes
    const tightUncompressed = csvByteLen + Math.floor(metaByteLen / 2);
    expect(() =>
      packageCsv(single.context, single.prepared, single.report, {
        ...defaultOptions,
        maxUncompressedBytes: tightUncompressed,
      })
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'BYTE_LIMIT_EXCEEDED' }));

    // In 3-sheet case as well: budget large enough for CSVs but not for manifest
    const multi = make3SheetsFixture();
    const zipSyncMock = vi.mocked(fflate.zipSync);
    zipSyncMock.mockClear();

    // Small uncompressed cap that fits CSVs (~200 bytes) but rejects on manifest (~1200 bytes)
    expect(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        ...defaultOptions,
        maxUncompressedBytes: 250,
      })
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'BYTE_LIMIT_EXCEEDED' }));

    // Pre-zip rejection: zipSync was never invoked!
    expect(zipSyncMock).not.toHaveBeenCalled();
  });

  it('5. rejects knownchange, badreport, mapping mismatch, and unknownauth BEFORE zip helper invocation', () => {
    const multi = make3SheetsFixture();
    const zipSyncMock = vi.mocked(fflate.zipSync);
    zipSyncMock.mockClear();

    // 1. knownchange: consistency indicates concurrent change
    const changedReport: ExportReport = {
      ...multi.report,
      export: {
        ...multi.report.export,
        consistency: 'not_atomic_changes_detected',
      },
    };
    expect(() =>
      packageCsv(multi.context, multi.prepared, changedReport, defaultOptions)
    ).toThrowError(
      expect.objectContaining({ name: 'DomainError', code: 'SOURCE_CHANGED_CONCURRENTLY' })
    );
    expect(zipSyncMock).not.toHaveBeenCalled();

    // 2. badreport: producedAt earlier than startedAt
    const badReport: ExportReport = {
      ...multi.report,
      export: {
        ...multi.report.export,
        producedAt: '2026-11-01T09:00:00.000Z',
        startedAt: '2026-11-01T10:00:00.000Z',
      },
    };
    expect(() =>
      packageCsv(multi.context, multi.prepared, badReport, defaultOptions)
    ).toThrowError(
      expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' })
    );
    expect(zipSyncMock).not.toHaveBeenCalled();

    // 3. mapping mismatch: report has altered exportedName
    const mismatchedReport: ExportReport = {
      ...multi.report,
      nameMappings: [
        { sheetId: 30, originalTitle: 'Data/Input', exportedName: 'Forged_Name.csv' },
        multi.report.nameMappings[1],
        multi.report.nameMappings[2],
      ],
    };
    expect(() =>
      packageCsv(multi.context, multi.prepared, mismatchedReport, defaultOptions)
    ).toThrowError(
      expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' })
    );
    expect(zipSyncMock).not.toHaveBeenCalled();

    // 4. unknownauth: context contains forbidden credentials key
    const authContext = Object.freeze({
      ...multi.context,
      accessToken: 'secret_token_123',
    }) as unknown as WriterContext;
    expect(() =>
      packageCsv(authContext, multi.prepared, multi.report, defaultOptions)
    ).toThrowError(
      expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' })
    );
    expect(zipSyncMock).not.toHaveBeenCalled();
  });

  it('6. validates malformed options, pre-aborted signal, post-helper signal cancellation, and safely handles hostile throwing getters and untrusted provider errors', () => {
    const multi = make3SheetsFixture();
    const sig = new AbortController().signal;

    const expectConfigInvalid = (fn: () => void) => {
      expect(fn).toThrowError(DomainError);
      expect(fn).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'CONFIG_INVALID' }));
    };

    // Malformed option shapes
    expectConfigInvalid(() => packageCsv(multi.context, multi.prepared, multi.report, {
      ...defaultOptions,
      get maxUncompressedBytes(): number { throw new DomainError('OPERATION_ABORTED'); }
    }));
    expectConfigInvalid(() => packageCsv(multi.context, multi.prepared, multi.report, null as any));
    expectConfigInvalid(() => packageCsv(multi.context, multi.prepared, multi.report, [] as any));
    expectConfigInvalid(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        maxUncompressedBytes: -1,
        maxBytes: 1000,
        maxWarnings: 10,
        signal: sig,
      })
    );
    expectConfigInvalid(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        maxUncompressedBytes: -0,
        maxBytes: 1000,
        maxWarnings: 10,
        signal: sig,
      })
    );
    expectConfigInvalid(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        maxUncompressedBytes: 1000,
        maxBytes: -0,
        maxWarnings: 10,
        signal: sig,
      })
    );
    expectConfigInvalid(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES + 1,
        maxBytes: 1000,
        maxWarnings: 10,
        signal: sig,
      })
    );
    expectConfigInvalid(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        maxUncompressedBytes: 1000,
        maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES + 1,
        maxWarnings: 10,
        signal: sig,
      })
    );
    expectConfigInvalid(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        maxUncompressedBytes: 1000,
        maxBytes: 1000,
        maxWarnings: PROVISIONAL_MAX_WARNINGS + 1,
        signal: sig,
      })
    );
    expectConfigInvalid(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        maxUncompressedBytes: 1000,
        maxBytes: 1000,
        maxWarnings: 10,
        signal: {} as any,
      })
    );

    // Hostile throwing getter on config -> static CONFIG_INVALID without leaking diagnostic
    expectConfigInvalid(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        get maxUncompressedBytes(): number {
          throw new Error('Hostile options diagnostic');
        },
        maxBytes: 1000,
        maxWarnings: 10,
        signal: sig,
      } as any)
    );

    // Pre-aborted signal -> static OPERATION_ABORTED without executing helpers
    const preAborted = new AbortController();
    preAborted.abort();
    expect(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        ...defaultOptions,
        signal: preAborted.signal,
      })
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'OPERATION_ABORTED' }));

    // Signal aborted post-helper / during zip helper
    const duringZipAc = new AbortController();
    const actualZip = packageCsv(multi.context, multi.prepared, multi.report, defaultOptions);
    vi.mocked(fflate.zipSync).mockImplementationOnce(() => {
      duringZipAc.abort();
      return new Uint8Array(actualZip[0].data as Uint8Array);
    });

    expect(() =>
      packageCsv(multi.context, multi.prepared, multi.report, {
        ...defaultOptions,
        signal: duringZipAc.signal,
      })
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'OPERATION_ABORTED' }));

    // Hostile provider error from fflate: throwing object with forged .code
    vi.mocked(fflate.zipSync).mockImplementationOnce(() => {
      const forged = new Error('Raw fflate crash');
      (forged as any).code = 'BYTE_LIMIT_EXCEEDED';
      throw forged;
    });
    expect(() =>
      packageCsv(multi.context, multi.prepared, multi.report, defaultOptions)
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Non-frozen context or format mismatch
    expect(() =>
      packageCsv({ ...multi.context } as any, multi.prepared, multi.report, defaultOptions)
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' }));
    expect(() =>
      packageCsv(
        Object.freeze({ ...multi.context, format: 'xlsx' as any }),
        multi.prepared,
        multi.report,
        defaultOptions
      )
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' }));
  });

  it('7. guarantees no input mutation, fresh data ownership, and repeated deterministic output equality', () => {
    const multi = make3SheetsFixture();

    const out1 = packageCsv(multi.context, multi.prepared, multi.report, defaultOptions);
    const out2 = packageCsv(multi.context, multi.prepared, multi.report, defaultOptions);

    // Exact deterministic byte-for-byte equality across multiple runs
    expect(Buffer.compare(Buffer.from(out1[0].data as Uint8Array), Buffer.from(out2[0].data as Uint8Array))).toBe(0);

    // Mutating returned output buffer does not alter subsequent calls
    (out1[0].data as Uint8Array)[0] = 0xee;
    expect((out1[0].data as Uint8Array)[0]).not.toBe((out2[0].data as Uint8Array)[0]);

    // Single sheet repeated equality & input immutability
    const single = makeSingleSheetFixture();
    const sOut1 = packageCsv(single.context, single.prepared, single.report, defaultOptions);
    const sOut2 = packageCsv(single.context, single.prepared, single.report, defaultOptions);

    expect(Buffer.compare(Buffer.from(sOut1[0].data as Uint8Array), Buffer.from(sOut2[0].data as Uint8Array))).toBe(0);
    expect(Buffer.compare(Buffer.from(sOut1[1].data as Uint8Array), Buffer.from(sOut2[1].data as Uint8Array))).toBe(0);

    // Mutating single-sheet output buffers
    (sOut1[0].data as Uint8Array)[0] = 0xaa;
    (sOut1[1].data as Uint8Array)[0] = 0xbb;
    expect((sOut1[0].data as Uint8Array)[0]).not.toBe((sOut2[0].data as Uint8Array)[0]);
    expect((sOut1[1].data as Uint8Array)[0]).not.toBe((sOut2[1].data as Uint8Array)[0]);
  });
});
