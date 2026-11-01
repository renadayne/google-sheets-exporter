import { describe, it, expect } from 'vitest';
import type {
  Cell, ExportReport, ExportMode, VisibilityMode, NormalizedChunk,
  ExcludedIntervals, SheetMeta, ReportSourceObservations
} from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { isExportReport, isJsonExportDocument } from '../../src/contracts/validation.ts';
import { snapshotWriterContext, PROVISIONAL_MAX_SHEETS } from '../../src/export/context.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import { PROVISIONAL_MAX_CHUNKS } from '../../src/export/coverage.ts';
import { PROVISIONAL_MAX_INTERVALS } from '../../src/export/exclusions.ts';
import { PROVISIONAL_MAX_CELLS } from '../../src/export/cells.ts';
import { buildCompleteExportReport, PROVISIONAL_MAX_WARNINGS } from '../../src/export/report.ts';
import { buildJsonExportDocument } from '../../src/export/json-document.ts';

function makeRealFixture(
  mode: ExportMode = 'raw',
  visibility: VisibilityMode = 'include_all',
  customCells?: Cell[],
  customExclusions?: ExcludedIntervals,
  sourceObservations?: ReportSourceObservations
) {
  const signal = new AbortController().signal;
  const meta1: SheetMeta = { id: 10, title: 'Data', index: 0, type: 'GRID', hidden: false, rows: 20, columns: 10 };
  const meta2: SheetMeta = { id: 20, title: 'Summary', index: 1, type: 'GRID', hidden: false, rows: 20, columns: 10 };
  const scope1 = { sheetId: 10, rect: { sheetId: 10, r0: 2, c0: 1, r1: 10, c1: 5 } };
  const scope2 = { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 5, c1: 5 } };

  const rawContext: WriterContext = {
    sourceId: 'src_report_test',
    title: 'Report Test Workbook',
    locale: 'en_US',
    timeZone: 'America/New_York',
    scopes: [scope1, scope2],
    mode,
    format: 'json',
    visibility,
    limitsVersion: '1.0',
    sheetOrder: [10, 20],
    sheets: [meta1, meta2]
  };

  const context = snapshotWriterContext(rawContext, { maxSheets: PROVISIONAL_MAX_SHEETS, signal });

  const excl = customExclusions ?? { rows: [], columns: [] };
  const cells: Cell[] = customCells ?? [
    { r: 2, c: 1, kind: 'string', value: '00123' },
    { r: 3, c: 2, kind: 'number', value: 42 }
  ];

  const chunk1: NormalizedChunk = {
    jobId: 'j1',
    chunkId: 'chunk_10',
    rect: { sheetId: 10, r0: 2, c0: 1, r1: 10, c1: 5 },
    cells,
    excludedIntervals: excl,
    byteCount: 64
  };

  const chunk2: NormalizedChunk = {
    jobId: 'j1',
    chunkId: 'chunk_20',
    rect: { sheetId: 20, r0: 0, c0: 0, r1: 5, c1: 5 },
    cells: [],
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 32
  };

  const prepared = prepareWriterData(context, [chunk1, chunk2], {
    maxChunks: PROVISIONAL_MAX_CHUNKS,
    maxIntervals: PROVISIONAL_MAX_INTERVALS,
    maxCells: PROVISIONAL_MAX_CELLS,
    signal
  });

  const repExclusions = customExclusions && (customExclusions.rows.length > 0 || customExclusions.columns.length > 0)
    ? [{ sheetId: 10, excludedRows: customExclusions.rows, excludedColumns: customExclusions.columns }]
    : [];

  const report: ExportReport = {
    schemaVersion: '1.0',
    source: { id: 'src_report_test', title: 'Report Test Workbook', locale: 'en_US', timeZone: 'America/New_York' },
    export: {
      startedAt: '2026-10-30T12:00:00.000Z',
      producedAt: '2026-10-30T12:00:03.500Z',
      mode,
      format: 'json',
      visibility,
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: []
    },
    selectedScopes: [scope1, scope2],
    sheetOrder: [10, 20],
    limitsVersion: '1.0',
    nameMappings: [
      { sheetId: 10, originalTitle: 'Data', exportedName: 'Data' },
      { sheetId: 20, originalTitle: 'Summary', exportedName: 'Summary' }
    ],
    exclusions: repExclusions,
    ...(sourceObservations !== undefined ? { sourceObservations } : {})
  };

  return { context, prepared, report };
}

describe('T24b3a buildCompleteExportReport', () => {
  const signal = new AbortController().signal;
  const opts = { maxWarnings: PROVISIONAL_MAX_WARNINGS, signal };

  it('JSON wrapper uses the same captured options during validation and sheet assembly', () => {
    const { context, prepared, report } = makeRealFixture();
    let signalReads = 0, limitReads = 0;
    const changingOptions = {
      get maxWarnings() { limitReads++; return PROVISIONAL_MAX_WARNINGS; },
      get signal() { return ++signalReads === 1 ? signal : AbortSignal.abort(); }
    };
    expect(isJsonExportDocument(buildJsonExportDocument(context, prepared, report, changingOptions))).toBe(true);
    expect(signalReads).toBe(1);
    expect(limitReads).toBe(1);
  });

  it('outputs metadata ONLY with no sheets/cells matching complete independent expected report deep equality', () => {
    const { context, prepared, report } = makeRealFixture('raw');
    const result = buildCompleteExportReport(context, prepared, report, opts);

    // Metadata ONLY verification: no sheets or cells present on result
    expect('sheets' in (result as any)).toBe(false);
    expect('cells' in (result as any)).toBe(false);
    expect(isExportReport(result)).toBe(true);
    expect(isJsonExportDocument(result)).toBe(false);

    const expectedIndependent: ExportReport = {
      schemaVersion: '1.0',
      source: {
        id: 'src_report_test',
        title: 'Report Test Workbook',
        locale: 'en_US',
        timeZone: 'America/New_York'
      },
      export: {
        startedAt: '2026-10-30T12:00:00.000Z',
        producedAt: '2026-10-30T12:00:03.500Z',
        mode: 'raw',
        format: 'json',
        visibility: 'include_all',
        complete: true,
        consistency: 'not_atomic_no_change_detected',
        warnings: []
      },
      selectedScopes: [
        { sheetId: 10, rect: { sheetId: 10, r0: 2, c0: 1, r1: 10, c1: 5 } },
        { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 5, c1: 5 } }
      ],
      sheetOrder: [10, 20],
      limitsVersion: '1.0',
      nameMappings: [
        { sheetId: 10, originalTitle: 'Data', exportedName: 'Data' },
        { sheetId: 20, originalTitle: 'Summary', exportedName: 'Summary' }
      ],
      exclusions: []
    };

    expect(result).toEqual(expectedIndependent);
    expect(result.source.id).toBe('src_report_test');
    expect(result.source.timeZone).toBe('America/New_York');
    expect(result.export.mode).toBe('raw');
    expect(result.export.format).toBe('json');
    expect(result.export.complete).toBe(true);
    expect(result.nameMappings).toHaveLength(2);
    expect(result.nameMappings[0].exportedName).toBe('Data');
    expect(result.nameMappings[1].exportedName).toBe('Summary');
  });

  it('guarantees deep nested immutability and post-call input mutation isolation', () => {
    const obs: ReportSourceObservations = {
      before: { observedAt: '2026-10-30T12:00:00.000Z', version: 'v10', modifiedTime: '2026-10-30T11:59:00Z' },
      after: { observedAt: '2026-10-30T12:00:04.000Z', version: 'v10', modifiedTime: '2026-10-30T11:59:00.000Z' }
    };
    const excl: ExcludedIntervals = { rows: [{ start: 3, end: 5 }], columns: [] };
    const cells: Cell[] = [{ r: 2, c: 1, kind: 'string', value: '00123' }];
    const { context, prepared, report } = makeRealFixture('raw', 'api_visible', cells, excl, obs);

    const result = buildCompleteExportReport(context, prepared, report, opts);

    // Deep freeze assertions across all levels
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(Object.isFrozen(result.export)).toBe(true);
    expect(Object.isFrozen(result.export.warnings)).toBe(true);
    expect(Object.isFrozen(result.selectedScopes)).toBe(true);
    expect(Object.isFrozen(result.selectedScopes[0])).toBe(true);
    expect(Object.isFrozen(result.selectedScopes[0].rect)).toBe(true);
    expect(Object.isFrozen(result.sheetOrder)).toBe(true);
    expect(Object.isFrozen(result.nameMappings)).toBe(true);
    expect(Object.isFrozen(result.nameMappings[0])).toBe(true);
    expect(Object.isFrozen(result.exclusions)).toBe(true);
    expect(Object.isFrozen(result.exclusions[0])).toBe(true);
    expect(Object.isFrozen(result.exclusions[0].excludedRows)).toBe(true);
    expect(Object.isFrozen(result.exclusions[0].excludedRows[0])).toBe(true);
    expect(Object.isFrozen(result.sourceObservations)).toBe(true);
    expect(Object.isFrozen(result.sourceObservations?.before)).toBe(true);
    expect(Object.isFrozen(result.sourceObservations?.after)).toBe(true);

    // Mutate inputs after call
    (report.source as any).title = 'MutatedWorkbook';
    (report.sheetOrder as any)[0] = 999;
    (report.nameMappings as any)[0].exportedName = 'Hacked';
    (report.export.warnings as any).push({ code: 'W_LATE', message: 'late warning' });

    // Output remains isolated and unmutated
    expect(result.source.title).toBe('Report Test Workbook');
    expect(result.sheetOrder).toEqual([10, 20]);
    expect(result.nameMappings[0].exportedName).toBe('Data');
    expect(result.export.warnings).toHaveLength(0);
  });

  it('rejects pre-aborted signal, invalid option bounds, and warning limit overflow', () => {
    const { context, prepared, report } = makeRealFixture();

    // Pre-aborted signal -> OPERATION_ABORTED
    const abortedSignal = AbortSignal.abort();
    expect(() => buildCompleteExportReport(context, prepared, report, { maxWarnings: 10, signal: abortedSignal }))
      .toThrowError(expect.objectContaining({ code: 'OPERATION_ABORTED' }));

    // Options invalid config bounds -> CONFIG_INVALID
    expect(() => buildCompleteExportReport(context, prepared, report, null as any))
      .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => buildCompleteExportReport(context, prepared, report, { maxWarnings: -1, signal } as any))
      .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => buildCompleteExportReport(context, prepared, report, { maxWarnings: 4097, signal } as any))
      .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => buildCompleteExportReport(context, prepared, report, { maxWarnings: 10, signal: {} } as any))
      .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));

    // Warning overflow -> SIZE_LIMIT_EXCEEDED
    const repWithWarnings: ExportReport = {
      ...report,
      export: {
        ...report.export,
        warnings: [
          { code: 'W1', message: 'Warning 1' },
          { code: 'W2', message: 'Warning 2' }
        ]
      }
    };
    expect(() => buildCompleteExportReport(context, prepared, repWithWarnings, { maxWarnings: 1, signal }))
      .toThrowError(expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' }));
  });

  it('rejects known concurrent changes, version mismatches, and inverted timestamps', () => {
    const { context, prepared, report } = makeRealFixture();

    // Consistency marked as changes detected
    const changedRep: ExportReport = {
      ...report,
      export: { ...report.export, consistency: 'not_atomic_changes_detected' }
    };
    expect(() => buildCompleteExportReport(context, prepared, changedRep, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_CHANGED_CONCURRENTLY' }));

    // Differing source observation versions
    const versionMismatchRep: ExportReport = {
      ...report,
      sourceObservations: {
        before: { observedAt: '2026-10-30T12:00:00Z', version: 'v1' },
        after: { observedAt: '2026-10-30T12:00:02Z', version: 'v2' }
      }
    };
    expect(() => buildCompleteExportReport(context, prepared, versionMismatchRep, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_CHANGED_CONCURRENTLY' }));

    // Differing modifiedTime timestamps beyond Date.parse precision
    const modTimeMismatchRep: ExportReport = {
      ...report,
      sourceObservations: {
        before: { observedAt: '2026-10-30T12:00:00Z', modifiedTime: '2026-10-30T11:59:00.123456789Z' },
        after: { observedAt: '2026-10-30T12:00:02Z', modifiedTime: '2026-10-30T11:59:00.123456788Z' }
      }
    };
    expect(() => buildCompleteExportReport(context, prepared, modTimeMismatchRep, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_CHANGED_CONCURRENTLY' }));

    // Inverted export timestamps (producedAt before startedAt)
    const invertedExportTimes: ExportReport = {
      ...report,
      export: {
        ...report.export,
        startedAt: '2026-10-30T12:00:05.000Z',
        producedAt: '2026-10-30T12:00:01.000Z'
      }
    };
    expect(() => buildCompleteExportReport(context, prepared, invertedExportTimes, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Inverted sourceObservations timestamps (after before before)
    const invertedObsTimes: ExportReport = {
      ...report,
      sourceObservations: {
        before: { observedAt: '2026-10-30T12:00:05Z' },
        after: { observedAt: '2026-10-30T12:00:01Z' }
      }
    };
    expect(() => buildCompleteExportReport(context, prepared, invertedObsTimes, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
  });

  it('rejects context/report relational mismatches, foreign warning sheetIds, and exclusion discrepancies', () => {
    const excl: ExcludedIntervals = { rows: [{ start: 3, end: 5 }], columns: [] };
    const cells: Cell[] = [{ r: 2, c: 1, kind: 'string', value: '00123' }];
    const { context, prepared, report } = makeRealFixture('raw', 'api_visible', cells, excl);

    // Source ID mismatch
    expect(() => buildCompleteExportReport(context, prepared, { ...report, source: { ...report.source, id: 'wrong_id' } }, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Export mode mismatch
    expect(() => buildCompleteExportReport(context, prepared, { ...report, export: { ...report.export, mode: 'formatted' } }, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // LimitsVersion mismatch
    expect(() => buildCompleteExportReport(context, prepared, { ...report, limitsVersion: '9.9' }, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Scope rect coordinate mismatch
    const badScopeRect: ExportReport = {
      ...report,
      selectedScopes: [
        { sheetId: 10, rect: { sheetId: 10, r0: 0, c0: 0, r1: 10, c1: 5 } },
        report.selectedScopes[1]
      ]
    };
    expect(() => buildCompleteExportReport(context, prepared, badScopeRect, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Name mapping exportedName !== title in JSON mode
    const badNameMapping: ExportReport = {
      ...report,
      nameMappings: [
        { sheetId: 10, originalTitle: 'Data', exportedName: 'RenamedData' },
        report.nameMappings[1]
      ]
    };
    expect(() => buildCompleteExportReport(context, prepared, badNameMapping, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Warning referencing unknown sheetId
    const foreignWarn: ExportReport = {
      ...report,
      export: { ...report.export, warnings: [{ code: 'W_UNKNOWN', message: 'Unknown sheet', sheetId: 999 }] }
    };
    expect(() => buildCompleteExportReport(context, prepared, foreignWarn, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Omission of nonempty prepared exclusions
    const omittedExcl: ExportReport = { ...report, exclusions: [] };
    expect(() => buildCompleteExportReport(context, prepared, omittedExcl, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Exclusion interval bounds mismatch
    const mismatchedExcl: ExportReport = {
      ...report,
      exclusions: [{ sheetId: 10, excludedRows: [{ start: 3, end: 6 }], excludedColumns: [] }]
    };
    expect(() => buildCompleteExportReport(context, prepared, mismatchedExcl, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Foreign sheetId in exclusions
    const foreignExcl: ExportReport = {
      ...report,
      exclusions: [...report.exclusions, { sheetId: 888, excludedRows: [], excludedColumns: [] }]
    };
    expect(() => buildCompleteExportReport(context, prepared, foreignExcl, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
  });
});
