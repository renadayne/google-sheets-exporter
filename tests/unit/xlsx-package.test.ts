import { describe, it, expect, vi } from 'vitest';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';

import type {
  Cell,
  ExportReport,
  ExportFormat,
  ExportMode,
  VisibilityMode,
  NormalizedChunk,
  ExcludedIntervals,
  SheetMeta
} from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { isExportReport } from '../../src/contracts/validation.ts';
import { snapshotWriterContext, PROVISIONAL_MAX_SHEETS } from '../../src/export/context.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import { PROVISIONAL_MAX_CHUNKS } from '../../src/export/coverage.ts';
import { PROVISIONAL_MAX_INTERVALS } from '../../src/export/exclusions.ts';
import { PROVISIONAL_MAX_CELLS } from '../../src/export/cells.ts';
import { mapWorksheetNames } from '../../src/export/names.ts';
import {
  PROVISIONAL_MAX_XLSX_BYTES,
  PROVISIONAL_MAX_XLSX_CELLS,
  PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS
} from '../../src/export/xlsx.ts';
import { PROVISIONAL_MAX_WARNINGS } from '../../src/export/report.ts';
import {
  packageXlsx,
  type PackageXlsxOptions,
  XLSX_MIME_TYPE,
  JSON_MIME_TYPE,
  XLSX_PRIMARY_SAFE_SUMMARY,
  XLSX_COMPANION_SAFE_SUMMARY
} from '../../src/export/xlsx-package.ts';

interface TestFixtureOptions {
  title?: string;
  format?: ExportFormat;
  mode?: ExportMode;
  visibility?: VisibilityMode;
  sheets?: Array<{
    id: number;
    title: string;
    scopeRect: { r0: number; c0: number; r1: number; c1: number };
    cells: Cell[];
  }>;
}

function createTestFixture(options: TestFixtureOptions = {}) {
  const signal = new AbortController().signal;
  const title = options.title ?? 'Test Workbook';
  const format = options.format ?? 'xlsx';
  const mode = options.mode ?? 'raw';
  const visibility = options.visibility ?? 'include_all';

  const sheetDefs = options.sheets ?? [
    {
      id: 101,
      title: '_x0041_',
      scopeRect: { r0: 0, c0: 0, r1: 10, c1: 6 },
      cells: [
        { r: 0, c: 0, kind: 'string', value: 'FirstCell' },
        { r: 0, c: 2, kind: 'number', value: 3.14159 },
        { r: 2, c: 0, kind: 'boolean', value: false },
        { r: 8, c: 5, kind: 'string', value: 'Corner' }
      ]
    },
    {
      id: 102,
      title: 'BlankTab',
      scopeRect: { r0: 0, c0: 0, r1: 5, c1: 5 },
      cells: []
    },
    {
      id: 103,
      title: 'DenseData',
      scopeRect: { r0: 5, c0: 2, r1: 7, c1: 4 },
      cells: [
        { r: 5, c: 2, kind: 'string', value: 'Row5Col2' },
        { r: 6, c: 3, kind: 'number', value: 999 }
      ]
    }
  ];

  const metas: SheetMeta[] = sheetDefs.map((s, idx) => ({
    id: s.id,
    title: s.title,
    index: idx,
    type: 'GRID',
    hidden: false,
    rows: s.scopeRect.r1,
    columns: s.scopeRect.c1
  }));

  const scopes = sheetDefs.map(s => ({
    sheetId: s.id,
    rect: { sheetId: s.id, ...s.scopeRect }
  }));

  const sheetOrder = sheetDefs.map(s => s.id);

  const rawContext: WriterContext = {
    sourceId: 'src_xlsx_test',
    title,
    locale: 'en_US',
    timeZone: 'America/New_York',
    scopes,
    mode,
    format,
    visibility,
    limitsVersion: '1.0',
    sheetOrder,
    sheets: metas
  };

  const context = snapshotWriterContext(rawContext, { maxSheets: PROVISIONAL_MAX_SHEETS, signal });

  const emptyExcl: ExcludedIntervals = { rows: [], columns: [] };
  const chunks: NormalizedChunk[] = sheetDefs.map(s => ({
    jobId: 'j_xlsx',
    chunkId: `c_${s.id}`,
    rect: { sheetId: s.id, ...s.scopeRect },
    cells: s.cells,
    excludedIntervals: emptyExcl,
    byteCount: 256
  }));

  const prepared = prepareWriterData(context, chunks, {
    maxChunks: PROVISIONAL_MAX_CHUNKS,
    maxIntervals: PROVISIONAL_MAX_INTERVALS,
    maxCells: PROVISIONAL_MAX_CELLS,
    signal
  });

  const nameMappings = mapWorksheetNames(sheetDefs.map(s => ({ id: s.id, title: s.title })));

  const report: ExportReport = {
    schemaVersion: '1.0',
    source: {
      id: 'src_xlsx_test',
      title,
      locale: 'en_US',
      timeZone: 'America/New_York'
    },
    export: {
      startedAt: '2026-10-31T10:00:00.000Z',
      producedAt: '2026-10-31T10:00:02.000Z',
      mode,
      format,
      visibility,
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: []
    },
    selectedScopes: scopes,
    sheetOrder,
    limitsVersion: '1.0',
    nameMappings,
    exclusions: []
  };

  const defaultOptions: PackageXlsxOptions = {
    maxBytes: PROVISIONAL_MAX_XLSX_BYTES,
    maxCells: PROVISIONAL_MAX_XLSX_CELLS,
    maxInputTextUnits: PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS,
    maxWarnings: PROVISIONAL_MAX_WARNINGS,
    signal
  };

  return { context, prepared, report, defaultOptions, signal, sheetDefs };
}

describe('T29c Bounded XLSX and Companion Metadata Packaging', () => {
  it('1. packages multi-tab workbook with SheetJS order, typed cells, absolute sparse gaps, blank tab, and parses companion metadata with isExportReport and independent expectations', async () => {
    const { context, prepared, report, defaultOptions } = createTestFixture();

    const artifacts = await packageXlsx(context, prepared, report, defaultOptions);

    expect(artifacts).toHaveLength(2);
    const [primary, companion] = artifacts;

    // Primary XLSX Artifact assertions
    expect(primary.filename).toBe('Test Workbook.xlsx');
    expect(primary.mimeType).toBe(XLSX_MIME_TYPE);
    expect(primary.safeSummary).toBe(XLSX_PRIMARY_SAFE_SUMMARY);
    expect(primary.byteLength).toBe((primary.data as Uint8Array).byteLength);
    expect(primary.byteLength).toBeGreaterThan(0);
    expect(primary.data).toBeInstanceOf(Uint8Array);

    // Independent SheetJS inspection
    const wb = XLSX.read(primary.data as Uint8Array, { type: 'array' });
    // Tab order matches sheetOrder [101, 102, 103], and _x0041_ sanitized to -x0041_
    expect(wb.SheetNames).toEqual(['-x0041_', 'BlankTab', 'DenseData']);

    // Tab 1: typed cells and absolute sparse gaps
    const ws1 = wb.Sheets['-x0041_'];
    expect(ws1['A1']).toMatchObject({ t: 's', v: 'FirstCell' });
    expect(ws1['B1']).toBeUndefined(); // sparse gap preserved
    expect(ws1['C1']).toMatchObject({ t: 'n', v: 3.14159 });
    expect(ws1['A2']).toBeUndefined(); // sparse gap preserved
    expect(ws1['A3']).toMatchObject({ t: 'b', v: false });
    expect(ws1['F9']).toMatchObject({ t: 's', v: 'Corner' });

    // Tab 2: Blank tab has no cell data
    const ws2 = wb.Sheets['BlankTab'];
    const cellKeys = Object.keys(ws2).filter(k => !k.startsWith('!'));
    expect(cellKeys).toEqual([]);
    expect(ws2['A1']).toBeUndefined();

    // Tab 3: absolute offset coordinates preserved (r: 5, c: 2 is C6; r: 6, c: 3 is D7)
    const ws3 = wb.Sheets['DenseData'];
    expect(ws3['C6']).toMatchObject({ t: 's', v: 'Row5Col2' });
    expect(ws3['D7']).toMatchObject({ t: 'n', v: 999 });

    // Companion Metadata Artifact assertions
    expect(companion.filename).toBe('Test Workbook.metadata.json');
    expect(companion.mimeType).toBe(JSON_MIME_TYPE);
    expect(companion.safeSummary).toBe(XLSX_COMPANION_SAFE_SUMMARY);
    expect(companion.byteLength).toBe((companion.data as Uint8Array).byteLength);
    expect(companion.byteLength).toBeGreaterThan(0);
    expect(companion.data).toBeInstanceOf(Uint8Array);

    // Companion JSON parsing and full independent expectation
    const jsonText = new TextDecoder().decode(companion.data as Uint8Array);
    const parsed = JSON.parse(jsonText);

    expect(isExportReport(parsed)).toBe(true);
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.source).toEqual({
      id: 'src_xlsx_test',
      title: 'Test Workbook',
      locale: 'en_US',
      timeZone: 'America/New_York'
    });
    expect(parsed.export).toEqual({
      startedAt: '2026-10-31T10:00:00.000Z',
      producedAt: '2026-10-31T10:00:02.000Z',
      mode: 'raw',
      format: 'xlsx',
      visibility: 'include_all',
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: []
    });
    expect(parsed.sheetOrder).toEqual([101, 102, 103]);
    expect(parsed.selectedScopes).toEqual([
      { sheetId: 101, rect: { sheetId: 101, r0: 0, c0: 0, r1: 10, c1: 6 } },
      { sheetId: 102, rect: { sheetId: 102, r0: 0, c0: 0, r1: 5, c1: 5 } },
      { sheetId: 103, rect: { sheetId: 103, r0: 5, c0: 2, r1: 7, c1: 4 } }
    ]);
    expect(parsed.limitsVersion).toBe('1.0');
    expect(parsed.exclusions).toEqual([]);
    expect(parsed.csvTransformCounts).toBeUndefined();

    // Critical: worksheet literal '_x0041_' evidence:
    // originalTitle is '_x0041_' while exportedName is '-x0041_' across encoder + report
    expect(parsed.nameMappings).toEqual([
      { sheetId: 101, originalTitle: '_x0041_', exportedName: '-x0041_' },
      { sheetId: 102, originalTitle: 'BlankTab', exportedName: 'BlankTab' },
      { sheetId: 103, originalTitle: 'DenseData', exportedName: 'DenseData' }
    ]);
  });

  it('2. handles dangerous formula text in actual formula_text mode as inert strings without formula evaluation', async () => {
    const dangerousCells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: '=SUM(1,2)', formulaText: '=SUM(1,2)' },
      { r: 1, c: 0, kind: 'string', value: '=HYPERLINK("https://evil.com","click")', formulaText: '=HYPERLINK("https://evil.com","click")' },
      { r: 2, c: 0, kind: 'string', value: '+cmd|"/C calc"!A0' },
      { r: 3, c: 0, kind: 'string', value: '@SUM(A1:A2)' }
    ];

    const { context, prepared, report, defaultOptions } = createTestFixture({
      mode: 'formula_text',
      sheets: [
        {
          id: 1,
          title: 'Formulas',
          scopeRect: { r0: 0, c0: 0, r1: 5, c1: 2 },
          cells: dangerousCells
        }
      ]
    });

    const artifacts = await packageXlsx(context, prepared, report, defaultOptions);
    const [primary] = artifacts;

    // Independent SheetJS verification with cellFormula enabled
    const wb = XLSX.read(primary.data as Uint8Array, { type: 'array', cellFormula: true });
    const ws = wb.Sheets['Formulas'];

    expect(ws['A1']).toMatchObject({ t: 's', v: '=SUM(1,2)' });
    expect(ws['A1'].f).toBeUndefined();

    expect(ws['A2']).toMatchObject({ t: 's', v: '=HYPERLINK("https://evil.com","click")' });
    expect(ws['A2'].f).toBeUndefined();

    expect(ws['A3']).toMatchObject({ t: 's', v: '+cmd|"/C calc"!A0' });
    expect(ws['A3'].f).toBeUndefined();

    expect(ws['A4']).toMatchObject({ t: 's', v: '@SUM(A1:A2)' });
    expect(ws['A4'].f).toBeUndefined();

    // Independent low-level OOXML verification: assert NO <f> or <hyperlink> XML tags exist
    const unzipped = unzipSync(primary.data as Uint8Array);
    const sheetXml = new TextDecoder().decode(unzipped['xl/worksheets/sheet1.xml']);
    expect(sheetXml).not.toContain('<f>');
    expect(sheetXml).not.toContain('</f>');
    expect(sheetXml).not.toContain('<f ');
    expect(sheetXml).not.toContain('<hyperlink');

    const xmlParser = new XMLParser({ ignoreAttributes: false });
    const parsedXml = xmlParser.parse(sheetXml);
    const rowList = Array.isArray(parsedXml.worksheet.sheetData.row)
      ? parsedXml.worksheet.sheetData.row
      : [parsedXml.worksheet.sheetData.row];

    for (const r of rowList) {
      const cList = Array.isArray(r.c) ? r.c : [r.c];
      for (const c of cList) {
        expect(c.f).toBeUndefined();
      }
    }
    expect(parsedXml.worksheet.hyperlinks).toBeUndefined();
  });

  it('3. formats long primary and companion filenames under portable cap while preserving original source title unchanged', async () => {
    // 160-character repetitive title exceeding 120-byte portable cap
    const longTitle = 'VeryLongWorkbookTitle_WithDetailedDescription_AndUnicode_测试_'.repeat(3);

    const { context, prepared, report, defaultOptions } = createTestFixture({
      title: longTitle,
      sheets: [
        {
          id: 1,
          title: 'Sheet1',
          scopeRect: { r0: 0, c0: 0, r1: 1, c1: 1 },
          cells: [{ r: 0, c: 0, kind: 'string', value: 'data' }]
        }
      ]
    });

    const artifacts = await packageXlsx(context, prepared, report, defaultOptions);
    const [primary, companion] = artifacts;

    // Portable cap: <= 120 UTF-8 bytes
    const encoder = new TextEncoder();
    expect(primary.filename.endsWith('.xlsx')).toBe(true);
    expect(encoder.encode(primary.filename).length).toBeLessThanOrEqual(120);

    expect(companion.filename.endsWith('.metadata.json')).toBe(true);
    expect(encoder.encode(companion.filename).length).toBeLessThanOrEqual(120);

    // Companion metadata must preserve original source title completely un-truncated
    const parsed = JSON.parse(new TextDecoder().decode(companion.data as Uint8Array));
    expect(parsed.source.title).toBe(longTitle);
  });

  it('4. enforces aggregate exact cap, exact cap - 1 rejection, and metadata cap', async () => {
    const { context, prepared, report, defaultOptions } = createTestFixture({
      sheets: [
        {
          id: 1,
          title: 'CapTest',
          scopeRect: { r0: 0, c0: 0, r1: 2, c1: 2 },
          cells: [
            { r: 0, c: 0, kind: 'string', value: 'hello' },
            { r: 0, c: 1, kind: 'number', value: 100 }
          ]
        }
      ]
    });

    // 1. Metadata cap: maxBytes smaller than companion metadata JSON alone
    await expect(
      packageXlsx(context, prepared, report, {
        ...defaultOptions,
        maxBytes: 100
      })
    ).rejects.toMatchObject({ code: 'BYTE_LIMIT_EXCEEDED' });

    // 2. Aggregate exact cap / cap-1 test with Date frozen to ensure deterministic byte counts
    // Timers remain real (only Date is faked)
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'));

    try {
      // First baseline run with generous budget to determine exact output byte counts
      const baseline = await packageXlsx(context, prepared, report, defaultOptions);
      const exactTotal = baseline[0].byteLength + baseline[1].byteLength;

      // Exact aggregate cap must pass
      const exactResult = await packageXlsx(context, prepared, report, {
        ...defaultOptions,
        maxBytes: exactTotal
      });
      expect(exactResult[0].byteLength + exactResult[1].byteLength).toBe(exactTotal);

      // Exact aggregate cap - 1 must reject with BYTE_LIMIT_EXCEEDED
      await expect(
        packageXlsx(context, prepared, report, {
          ...defaultOptions,
          maxBytes: exactTotal - 1
        })
      ).rejects.toMatchObject({ code: 'BYTE_LIMIT_EXCEEDED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('5. rejects invalid format, mismapped names/order, and known concurrent change before workbook spy is invoked', async () => {
    const { context, prepared, report, defaultOptions } = createTestFixture();
    const addWorksheetSpy = vi.spyOn(ExcelJS.Workbook.prototype, 'addWorksheet');

    try {
      // A. Invalid context format
      const badContext = { ...context, format: 'csv' as const };
      await expect(packageXlsx(badContext, prepared, report, defaultOptions))
        .rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
      expect(addWorksheetSpy).not.toHaveBeenCalled();

      // B. Invalid report format
      const badReportFormat = {
        ...report,
        export: { ...report.export, format: 'csv' as const }
      };
      await expect(packageXlsx(context, prepared, badReportFormat, defaultOptions))
        .rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
      expect(addWorksheetSpy).not.toHaveBeenCalled();

      // C. Mismapped sheet name
      const badMappings = {
        ...report,
        nameMappings: [
          { sheetId: 101, originalTitle: '_x0041_', exportedName: 'WrongName' },
          report.nameMappings[1],
          report.nameMappings[2]
        ]
      };
      await expect(packageXlsx(context, prepared, badMappings, defaultOptions))
        .rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
      expect(addWorksheetSpy).not.toHaveBeenCalled();

      // D. Reversed sheetOrder
      const badOrder = {
        ...report,
        sheetOrder: [103, 102, 101]
      };
      await expect(packageXlsx(context, prepared, badOrder, defaultOptions))
        .rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
      expect(addWorksheetSpy).not.toHaveBeenCalled();

      // E. Known concurrent change via consistency status
      const changeConsistency = {
        ...report,
        export: {
          ...report.export,
          consistency: 'not_atomic_changes_detected' as const
        }
      };
      await expect(packageXlsx(context, prepared, changeConsistency, defaultOptions))
        .rejects.toMatchObject({ code: 'SOURCE_CHANGED_CONCURRENTLY' });
      expect(addWorksheetSpy).not.toHaveBeenCalled();

      // F. Known concurrent change via observed version mismatch
      const changeVersion = {
        ...report,
        sourceObservations: {
          before: { observedAt: '2026-10-31T10:00:00.000Z', version: 'v1' },
          after: { observedAt: '2026-10-31T10:00:02.000Z', version: 'v2' }
        }
      };
      await expect(packageXlsx(context, prepared, changeVersion, defaultOptions))
        .rejects.toMatchObject({ code: 'SOURCE_CHANGED_CONCURRENTLY' });
      expect(addWorksheetSpy).not.toHaveBeenCalled();

      // G. Non-CSV report containing csvTransformCounts must be rejected
      const reportWithCsvCounts = {
        ...report,
        csvTransformCounts: {
          totalTransformedCells: 1,
          bySheet: [{ sheetId: 101, transformedCells: 1 }]
        }
      };
      await expect(packageXlsx(context, prepared, reportWithCsvCounts as any, defaultOptions))
        .rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
      expect(addWorksheetSpy).not.toHaveBeenCalled();
    } finally {
      addWorksheetSpy.mockRestore();
    }
  });

  it('6. fails whole operation when cell has invalid XML characters, out-of-bounds coordinates, or unrepresentable values', async () => {
    // A. Invalid XML character (U+0000)
    const fixXml = createTestFixture({
      sheets: [
        {
          id: 1,
          title: 'Sheet1',
          scopeRect: { r0: 0, c0: 0, r1: 1, c1: 1 },
          cells: [{ r: 0, c: 0, kind: 'string', value: 'null\u0000char' }]
        }
      ]
    });
    await expect(packageXlsx(fixXml.context, fixXml.prepared, fixXml.report, fixXml.defaultOptions))
      .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });

    // B. Cell text exceeding 32,767 limit
    const fixLongText = createTestFixture({
      sheets: [
        {
          id: 1,
          title: 'Sheet1',
          scopeRect: { r0: 0, c0: 0, r1: 1, c1: 1 },
          cells: [{ r: 0, c: 0, kind: 'string', value: 'x'.repeat(32768) }]
        }
      ]
    });
    await expect(packageXlsx(fixLongText.context, fixLongText.prepared, fixLongText.report, fixLongText.defaultOptions))
      .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });

    // C. Non-representable number magnitude (1e-310 is below XLSX_MIN_NUMERIC_MAGNITUDE)
    const fixSmallNum = createTestFixture({
      sheets: [
        {
          id: 1,
          title: 'Sheet1',
          scopeRect: { r0: 0, c0: 0, r1: 1, c1: 1 },
          cells: [{ r: 0, c: 0, kind: 'number', value: 1e-310 }]
        }
      ]
    });
    await expect(packageXlsx(fixSmallNum.context, fixSmallNum.prepared, fixSmallNum.report, fixSmallNum.defaultOptions))
      .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });

    // D. Out-of-bounds column coordinate (> 16,384)
    const fixOutCols = createTestFixture({
      sheets: [
        {
          id: 1,
          title: 'Sheet1',
          scopeRect: { r0: 0, c0: 0, r1: 1, c1: 16385 },
          cells: []
        }
      ]
    });
    await expect(packageXlsx(fixOutCols.context, fixOutCols.prepared, fixOutCols.report, fixOutCols.defaultOptions))
      .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
  });

  it('7. aborts cleanly on pre-aborted signal and during pending serialization, returning no partial artifacts', async () => {
    const { context, prepared, report, defaultOptions } = createTestFixture();

    // A. Pre-aborted signal
    const preAc = new AbortController();
    preAc.abort();
    await expect(packageXlsx(context, prepared, report, { ...defaultOptions, signal: preAc.signal }))
      .rejects.toMatchObject({ code: 'OPERATION_ABORTED' });

    // B. Abort during synchronous workbook population
    const inFlightAc = new AbortController();
    const origAddWorksheet = ExcelJS.Workbook.prototype.addWorksheet;
    ExcelJS.Workbook.prototype.addWorksheet = function (name?: string) {
      inFlightAc.abort();
      return origAddWorksheet.call(this, name);
    };

    try {
      await expect(
        packageXlsx(context, prepared, report, { ...defaultOptions, signal: inFlightAc.signal })
      ).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    } finally {
      ExcelJS.Workbook.prototype.addWorksheet = origAddWorksheet;
    }
  });

  it('observes a genuine pending serialization rejection after cancellation without returning artifacts', async () => {
    const { context, prepared, report, defaultOptions } = createTestFixture();
    const controller = new AbortController();
    let entered!: () => void, release!: () => void, finished!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const done = new Promise<void>(resolve => { finished = resolve; });
    const proto = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx);
    const original = proto.writeBuffer;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    proto.writeBuffer = async () => {
      entered();
      try { await held; throw new Error('SYNTHETIC_LATE_PROVIDER_FAILURE'); }
      finally { finished(); }
    };
    try {
      const outcome = packageXlsx(context, prepared, report, { ...defaultOptions, signal: controller.signal })
        .then(artifacts => ({ artifacts }), error => ({ error }));
      await started;
      controller.abort();
      expect(await outcome).toMatchObject({ error: { code: 'OPERATION_ABORTED' } });
      release();
      await done;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      release();
      proto.writeBuffer = original;
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('8. ensures input mutation isolation and single-read options capture, rejecting invalid options', async () => {
    const { context, prepared, report, defaultOptions } = createTestFixture();

    // A. Input mutation isolation
    const reportSnapshot = JSON.stringify(report);
    const contextSnapshot = JSON.stringify(context);

    const artifacts = await packageXlsx(context, prepared, report, defaultOptions);

    expect(JSON.stringify(report)).toBe(reportSnapshot);
    expect(JSON.stringify(context)).toBe(contextSnapshot);

    // Returned array and artifacts must be frozen
    expect(Object.isFrozen(artifacts)).toBe(true);
    expect(Object.isFrozen(artifacts[0])).toBe(true);
    expect(Object.isFrozen(artifacts[1])).toBe(true);

    // Buffers must be fresh Uint8Arrays
    const u8Primary = artifacts[0].data as Uint8Array;
    const u8Companion = artifacts[1].data as Uint8Array;
    expect(u8Primary).toBeInstanceOf(Uint8Array);
    expect(u8Companion).toBeInstanceOf(Uint8Array);
    const originalTitle = report.source.title;
    (report.source as { title: string }).title = 'Changed after serialization';
    expect(JSON.parse(new TextDecoder().decode(u8Companion)).source.title).toBe(originalTitle);
    (report.source as { title: string }).title = originalTitle;

    // B. Single-read options capture: getters must be invoked exactly once
    let readBytes = 0;
    let readCells = 0;
    let readUnits = 0;
    let readWarnings = 0;
    let readSignal = 0;

    const monitoredOptions: PackageXlsxOptions = {
      get maxBytes() {
        readBytes++;
        return PROVISIONAL_MAX_XLSX_BYTES;
      },
      get maxCells() {
        readCells++;
        return PROVISIONAL_MAX_XLSX_CELLS;
      },
      get maxInputTextUnits() {
        readUnits++;
        return PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS;
      },
      get maxWarnings() {
        readWarnings++;
        return PROVISIONAL_MAX_WARNINGS;
      },
      get signal() {
        readSignal++;
        return defaultOptions.signal;
      }
    };

    const another = await packageXlsx(context, prepared, report, monitoredOptions);
    expect(another[0].data).not.toBe(u8Primary);
    expect(another[1].data).not.toBe(u8Companion);
    expect(readBytes).toBe(1);
    expect(readCells).toBe(1);
    expect(readUnits).toBe(1);
    expect(readWarnings).toBe(1);
    expect(readSignal).toBe(1);

    // C. Getter changing value on second read does not affect captured value
    let changingReads = 0;
    const changingOptions: PackageXlsxOptions = {
      get maxBytes() {
        changingReads++;
        return changingReads === 1 ? PROVISIONAL_MAX_XLSX_BYTES : -999;
      },
      maxCells: PROVISIONAL_MAX_XLSX_CELLS,
      maxInputTextUnits: PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS,
      maxWarnings: PROVISIONAL_MAX_WARNINGS,
      signal: defaultOptions.signal
    };
    await packageXlsx(context, prepared, report, changingOptions);
    expect(changingReads).toBe(1);

    // D. Static CONFIG_INVALID errors on invalid options
    const invalidConfigs = [
      { ...defaultOptions, maxBytes: -1 },
      { ...defaultOptions, maxBytes: -0 },
      { ...defaultOptions, maxBytes: 1.5 },
      { ...defaultOptions, maxBytes: PROVISIONAL_MAX_XLSX_BYTES + 1 },
      { ...defaultOptions, maxCells: -1 },
      { ...defaultOptions, maxCells: -0 },
      { ...defaultOptions, maxCells: PROVISIONAL_MAX_XLSX_CELLS + 1 },
      { ...defaultOptions, maxInputTextUnits: -1 },
      { ...defaultOptions, maxInputTextUnits: -0 },
      { ...defaultOptions, maxInputTextUnits: PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS + 1 },
      { ...defaultOptions, maxWarnings: -1 },
      { ...defaultOptions, maxWarnings: -0 },
      { ...defaultOptions, maxWarnings: PROVISIONAL_MAX_WARNINGS + 1 },
      { ...defaultOptions, signal: null as any },
      { ...defaultOptions, signal: {} as any },
      { ...defaultOptions, signal: { aborted: 'not-a-bool' } as any }
    ];

    for (const badCfg of invalidConfigs) {
      await expect(packageXlsx(context, prepared, report, badCfg))
        .rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    }
  });
});
