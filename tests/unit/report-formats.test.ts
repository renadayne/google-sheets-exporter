import { describe, it, expect } from 'vitest';
import type {
  Cell, ExportReport, ExportFormat, ExportMode, VisibilityMode, NormalizedChunk,
  ExcludedIntervals, SheetMeta, ReportCsvTransforms
} from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { isExportReport, isJsonExportDocument } from '../../src/contracts/validation.ts';
import { snapshotWriterContext, PROVISIONAL_MAX_SHEETS } from '../../src/export/context.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import { encodeCsvSheets } from '../../src/export/csv-sheets.ts';
import { mapCsvFilenames, mapWorksheetNames } from '../../src/export/names.ts';
import { PROVISIONAL_MAX_CHUNKS } from '../../src/export/coverage.ts';
import { PROVISIONAL_MAX_INTERVALS } from '../../src/export/exclusions.ts';
import { PROVISIONAL_MAX_CELLS } from '../../src/export/cells.ts';
import { buildCompleteExportReport } from '../../src/export/report.ts';
import { buildJsonExportDocument } from '../../src/export/json-document.ts';

function createMultiSheetFixture(
  format: ExportFormat = 'csv',
  mode: ExportMode = 'raw',
  visibility: VisibilityMode = 'include_all',
  dangerousText = true
) {
  const signal = new AbortController().signal;

  // At least 2 sheets with shuffled source IDs (50 before 20) and collision on sanitized name
  const meta1: SheetMeta = { id: 50, title: 'Report/Data', index: 0, type: 'GRID', hidden: false, rows: 20, columns: 10 };
  const meta2: SheetMeta = { id: 20, title: 'Report:Data', index: 1, type: 'GRID', hidden: false, rows: 20, columns: 10 };
  const scope1 = { sheetId: 50, rect: { sheetId: 50, r0: 2, c0: 1, r1: 6, c1: 4 } };
  const scope2 = { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 4, c1: 3 } };

  const rawContext: WriterContext = {
    sourceId: 'src_format_test',
    title: 'Format Test Workbook',
    locale: 'en_US',
    timeZone: 'America/New_York',
    scopes: [scope1, scope2],
    mode,
    format,
    visibility,
    limitsVersion: '1.0',
    sheetOrder: [50, 20],
    sheets: [meta1, meta2]
  };

  const context = snapshotWriterContext(rawContext, { maxSheets: PROVISIONAL_MAX_SHEETS, signal });

  // Cells for sheet 50: contains string starting with '=' (triggers CSV apostrophe prefix)
  const cells1: Cell[] = [
    { r: 2, c: 1, kind: 'string', value: dangerousText ? '=SUM(A1:A5)' : 'sum text' },
    { r: 3, c: 1, kind: 'string', value: 'RegularText' },
    { r: 3, c: 2, kind: 'number', value: 42 }
  ];

  // Cells for sheet 20: contains strings starting with '-' and '+' (trigger CSV apostrophe prefix) and a true negative number
  const cells2: Cell[] = [
    { r: 0, c: 0, kind: 'string', value: dangerousText ? '-minusText' : 'minusText' },
    { r: 1, c: 0, kind: 'string', value: dangerousText ? '+plusText' : 'plusText' },
    { r: 2, c: 0, kind: 'number', value: -99 }
  ];

  const emptyExcl: ExcludedIntervals = { rows: [], columns: [] };

  const chunk1: NormalizedChunk = {
    jobId: 'j_fmt',
    chunkId: 'chunk_50',
    rect: { sheetId: 50, r0: 2, c0: 1, r1: 6, c1: 4 },
    cells: cells1,
    excludedIntervals: emptyExcl,
    byteCount: 128
  };

  const chunk2: NormalizedChunk = {
    jobId: 'j_fmt',
    chunkId: 'chunk_20',
    rect: { sheetId: 20, r0: 0, c0: 0, r1: 4, c1: 3 },
    cells: cells2,
    excludedIntervals: emptyExcl,
    byteCount: 128
  };

  const prepared = prepareWriterData(context, [chunk1, chunk2], {
    maxChunks: PROVISIONAL_MAX_CHUNKS,
    maxIntervals: PROVISIONAL_MAX_INTERVALS,
    maxCells: PROVISIONAL_MAX_CELLS,
    signal
  });

  return { context, prepared, signal };
}

describe('T27b Common Report Format Binding', () => {
  const signal = new AbortController().signal;

  it('1. real snapshot/prepare then real encodeCsvSheets produces expected CSV mapping, counts, and controlled warning', () => {
    const { context, prepared } = createMultiSheetFixture('csv');

    // Real CSV encoding through reviewed helper
    const csvResult = encodeCsvSheets(prepared, { maxBytes: 100000, signal });

    // Validate that actual encodeCsvSheets produced transforms:
    // Sheet 50: 1 transformed cell ('=SUM(A1:A5)')
    // Sheet 20: 2 transformed cells ('-minusText', '+plusText')
    // Total transformed: 3
    expect(csvResult.csvTransformCounts.totalTransformedCells).toBe(3);
    expect(csvResult.csvTransformCounts.bySheet).toEqual([
      { sheetId: 50, transformedCells: 1 },
      { sheetId: 20, transformedCells: 2 }
    ]);

    // Independent expected name mappings derived with reviewed mapCsvFilenames
    const expectedNameMappings = mapCsvFilenames([
      { id: 50, title: 'Report/Data' },
      { id: 20, title: 'Report:Data' }
    ]);
    expect(expectedNameMappings[0].exportedName).toBe('Report_Data.csv');
    expect(expectedNameMappings[1].exportedName).toBe('Report_Data_20.csv');

    const report: ExportReport = {
      schemaVersion: '1.0',
      source: { id: 'src_format_test', title: 'Format Test Workbook', locale: 'en_US', timeZone: 'America/New_York' },
      export: {
        startedAt: '2026-10-31T10:00:00.000Z',
        producedAt: '2026-10-31T10:00:02.123Z',
        mode: 'raw',
        format: 'csv',
        visibility: 'include_all',
        complete: true,
        consistency: 'not_atomic_no_change_detected',
        warnings: [{ code: 'CUSTOM_USER_WARN', message: 'Legitimate warning', sheetId: 50 }]
      },
      selectedScopes: [
        { sheetId: 50, rect: { sheetId: 50, r0: 2, c0: 1, r1: 6, c1: 4 } },
        { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 4, c1: 3 } }
      ],
      sheetOrder: [50, 20],
      limitsVersion: '1.0',
      nameMappings: expectedNameMappings,
      exclusions: [],
      csvTransformCounts: csvResult.csvTransformCounts
    };

    const result = buildCompleteExportReport(context, prepared, report, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: csvResult.csvTransformCounts
    });

    // Verification of metadata-only result
    expect(isExportReport(result)).toBe(true);
    expect(isJsonExportDocument(result)).toBe(false);
    expect('sheets' in (result as any)).toBe(false);
    expect('cells' in (result as any)).toBe(false);

    // Deep equality checks on CSV facts and warnings
    expect(result.export.format).toBe('csv');
    expect(result.export.complete).toBe(true);
    expect(result.nameMappings).toEqual(expectedNameMappings);
    expect(result.csvTransformCounts).toEqual(csvResult.csvTransformCounts);

    // Warnings must contain incoming legitimate warning + exactly one controlled CSV_TEXT_ESCAPED warning
    expect(result.export.warnings).toHaveLength(2);
    expect(result.export.warnings[0]).toEqual({
      code: 'CUSTOM_USER_WARN',
      message: 'Legitimate warning',
      sheetId: 50
    });
    expect(result.export.warnings[1]).toEqual({
      code: 'CSV_TEXT_ESCAPED',
      message: 'Some source strings were prefixed for CSV safety. JSON preserves original values.'
    });
  });

  it('2. XLSX names derived from real names helper with explicit expected names without requiring workbook library', () => {
    const { context, prepared } = createMultiSheetFixture('xlsx');

    const expectedXlsxMappings = mapWorksheetNames([
      { id: 50, title: 'Report/Data' },
      { id: 20, title: 'Report:Data' }
    ]);
    expect(expectedXlsxMappings[0].exportedName).toBe('Report_Data');
    expect(expectedXlsxMappings[1].exportedName).toBe('Report_Data~2');

    const report: ExportReport = {
      schemaVersion: '1.0',
      source: { id: 'src_format_test', title: 'Format Test Workbook', locale: 'en_US', timeZone: 'America/New_York' },
      export: {
        startedAt: '2026-10-31T10:00:00.000Z',
        producedAt: '2026-10-31T10:00:01.000Z',
        mode: 'raw',
        format: 'xlsx',
        visibility: 'include_all',
        complete: true,
        consistency: 'not_atomic_no_change_detected',
        warnings: []
      },
      selectedScopes: [
        { sheetId: 50, rect: { sheetId: 50, r0: 2, c0: 1, r1: 6, c1: 4 } },
        { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 4, c1: 3 } }
      ],
      sheetOrder: [50, 20],
      limitsVersion: '1.0',
      nameMappings: expectedXlsxMappings,
      exclusions: []
    };

    const result = buildCompleteExportReport(context, prepared, report, {
      maxWarnings: 10,
      signal
    });

    expect(isExportReport(result)).toBe(true);
    expect(result.export.format).toBe('xlsx');
    expect(result.nameMappings).toEqual(expectedXlsxMappings);
    expect(result.csvTransformCounts).toBeUndefined();
    expect(result.export.warnings).toHaveLength(0);
  });

  it('3. unchanged JSON preserves existing document semantics and rejects supplied CSV facts', () => {
    const { context, prepared } = createMultiSheetFixture('json');

    const jsonMappings = [
      { sheetId: 50, originalTitle: 'Report/Data', exportedName: 'Report/Data' },
      { sheetId: 20, originalTitle: 'Report:Data', exportedName: 'Report:Data' }
    ];

    const report: ExportReport = {
      schemaVersion: '1.0',
      source: { id: 'src_format_test', title: 'Format Test Workbook', locale: 'en_US', timeZone: 'America/New_York' },
      export: {
        startedAt: '2026-10-31T10:00:00.000Z',
        producedAt: '2026-10-31T10:00:01.000Z',
        mode: 'raw',
        format: 'json',
        visibility: 'include_all',
        complete: true,
        consistency: 'not_atomic_no_change_detected',
        warnings: []
      },
      selectedScopes: [
        { sheetId: 50, rect: { sheetId: 50, r0: 2, c0: 1, r1: 6, c1: 4 } },
        { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 4, c1: 3 } }
      ],
      sheetOrder: [50, 20],
      limitsVersion: '1.0',
      nameMappings: jsonMappings,
      exclusions: []
    };

    const reportResult = buildCompleteExportReport(context, prepared, report, { maxWarnings: 10, signal });
    expect(reportResult.export.format).toBe('json');
    expect(reportResult.nameMappings).toEqual(jsonMappings);
    expect(reportResult.csvTransformCounts).toBeUndefined();

    // Successful JSON document assembly
    const docResult = buildJsonExportDocument(context, prepared, report, { maxWarnings: 10, signal });
    expect(isJsonExportDocument(docResult)).toBe(true);
    expect(docResult.sheets).toHaveLength(2);

    // Supplying CSV transform counts to JSON document must be forwarded and rejected
    const dummyCsvFacts: ReportCsvTransforms = {
      policy: 'apostrophe_prefix_v1',
      totalTransformedCells: 0,
      bySheet: [{ sheetId: 50, transformedCells: 0 }, { sheetId: 20, transformedCells: 0 }]
    };
    expect(() => buildJsonExportDocument(context, prepared, report, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: dummyCsvFacts
    })).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
  });

  it('4. rejects format, mode, name, scope, and known concurrent change mismatches', () => {
    const { context, prepared } = createMultiSheetFixture('csv');
    const validMappings = mapCsvFilenames([
      { id: 50, title: 'Report/Data' },
      { id: 20, title: 'Report:Data' }
    ]);
    const validFacts: ReportCsvTransforms = {
      policy: 'apostrophe_prefix_v1',
      totalTransformedCells: 0,
      bySheet: [{ sheetId: 50, transformedCells: 0 }, { sheetId: 20, transformedCells: 0 }]
    };

    const baseReport: ExportReport = {
      schemaVersion: '1.0',
      source: { id: 'src_format_test', title: 'Format Test Workbook', locale: 'en_US', timeZone: 'America/New_York' },
      export: {
        startedAt: '2026-10-31T10:00:00.000Z',
        producedAt: '2026-10-31T10:00:01.000Z',
        mode: 'raw',
        format: 'csv',
        visibility: 'include_all',
        complete: true,
        consistency: 'not_atomic_no_change_detected',
        warnings: []
      },
      selectedScopes: [
        { sheetId: 50, rect: { sheetId: 50, r0: 2, c0: 1, r1: 6, c1: 4 } },
        { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 4, c1: 3 } }
      ],
      sheetOrder: [50, 20],
      limitsVersion: '1.0',
      nameMappings: validMappings,
      exclusions: []
    };

    const opts = { maxWarnings: 10, signal, csvTransformCounts: validFacts };

    // Format mismatch between context and report
    expect(() => buildCompleteExportReport(context, prepared, {
      ...baseReport,
      export: { ...baseReport.export, format: 'json' }
    }, opts)).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Mode mismatch
    expect(() => buildCompleteExportReport(context, prepared, {
      ...baseReport,
      export: { ...baseReport.export, mode: 'formatted' }
    }, opts)).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Incomplete export flag
    expect(() => buildCompleteExportReport(context, prepared, {
      ...baseReport,
      export: { ...baseReport.export, complete: false }
    }, opts)).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Name mappings mismatch (e.g. unescaped raw title instead of sanitized CSV filename)
    expect(() => buildCompleteExportReport(context, prepared, {
      ...baseReport,
      nameMappings: [
        { sheetId: 50, originalTitle: 'Report/Data', exportedName: 'Report/Data' },
        { sheetId: 20, originalTitle: 'Report:Data', exportedName: 'Report:Data' }
      ]
    }, opts)).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Scope mismatch
    expect(() => buildCompleteExportReport(context, prepared, {
      ...baseReport,
      selectedScopes: [
        { sheetId: 50, rect: { sheetId: 50, r0: 0, c0: 0, r1: 6, c1: 4 } },
        { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 4, c1: 3 } }
      ]
    }, opts)).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Concurrent change detected in consistency
    expect(() => buildCompleteExportReport(context, prepared, {
      ...baseReport,
      export: { ...baseReport.export, consistency: 'not_atomic_changes_detected' }
    }, opts)).toThrowError(expect.objectContaining({ code: 'SOURCE_CHANGED_CONCURRENTLY' }));

    // Concurrent change detected in sourceObservations version
    expect(() => buildCompleteExportReport(context, prepared, {
      ...baseReport,
      sourceObservations: {
        before: { observedAt: '2026-10-31T10:00:00Z', version: 'v1' },
        after: { observedAt: '2026-10-31T10:00:01Z', version: 'v2' }
      }
    }, opts)).toThrowError(expect.objectContaining({ code: 'SOURCE_CHANGED_CONCURRENTLY' }));
  });

  it('5. validates CSV transform facts strictly: absent, bad policy, negative, -0, sum mismatch, count overrun, and report discrepancy', () => {
    const { context, prepared } = createMultiSheetFixture('csv');
    const validMappings = mapCsvFilenames([
      { id: 50, title: 'Report/Data' },
      { id: 20, title: 'Report:Data' }
    ]);

    const baseReport: ExportReport = {
      schemaVersion: '1.0',
      source: { id: 'src_format_test', title: 'Format Test Workbook', locale: 'en_US', timeZone: 'America/New_York' },
      export: {
        startedAt: '2026-10-31T10:00:00.000Z',
        producedAt: '2026-10-31T10:00:01.000Z',
        mode: 'raw',
        format: 'csv',
        visibility: 'include_all',
        complete: true,
        consistency: 'not_atomic_no_change_detected',
        warnings: []
      },
      selectedScopes: [
        { sheetId: 50, rect: { sheetId: 50, r0: 2, c0: 1, r1: 6, c1: 4 } },
        { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 4, c1: 3 } }
      ],
      sheetOrder: [50, 20],
      limitsVersion: '1.0',
      nameMappings: validMappings,
      exclusions: []
    };

    // Absent facts for CSV format
    expect(() => buildCompleteExportReport(context, prepared, baseReport, { maxWarnings: 10, signal }))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Non-CSV format with provided facts rejected
    const { context: jsonContext, prepared: jsonPrepared } = createMultiSheetFixture('json');
    const jsonReport: ExportReport = {
      ...baseReport,
      export: { ...baseReport.export, format: 'json' },
      nameMappings: [
        { sheetId: 50, originalTitle: 'Report/Data', exportedName: 'Report/Data' },
        { sheetId: 20, originalTitle: 'Report:Data', exportedName: 'Report:Data' }
      ]
    };
    expect(() => buildCompleteExportReport(jsonContext, jsonPrepared, jsonReport, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: {
        policy: 'apostrophe_prefix_v1',
        totalTransformedCells: 0,
        bySheet: [{ sheetId: 50, transformedCells: 0 }, { sheetId: 20, transformedCells: 0 }]
      }
    })).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Bad policy
    expect(() => buildCompleteExportReport(context, prepared, baseReport, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: {
        policy: 'custom_policy' as any,
        totalTransformedCells: 0,
        bySheet: [{ sheetId: 50, transformedCells: 0 }, { sheetId: 20, transformedCells: 0 }]
      }
    })).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Negative count
    expect(() => buildCompleteExportReport(context, prepared, baseReport, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: {
        policy: 'apostrophe_prefix_v1',
        totalTransformedCells: -1,
        bySheet: [{ sheetId: 50, transformedCells: -1 }, { sheetId: 20, transformedCells: 0 }]
      }
    })).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Negative zero (-0)
    expect(() => buildCompleteExportReport(context, prepared, baseReport, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: {
        policy: 'apostrophe_prefix_v1',
        totalTransformedCells: -0,
        bySheet: [{ sheetId: 50, transformedCells: 0 }, { sheetId: 20, transformedCells: 0 }]
      }
    })).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Sum mismatch (total 5, but sheet counts sum to 1)
    expect(() => buildCompleteExportReport(context, prepared, baseReport, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: {
        policy: 'apostrophe_prefix_v1',
        totalTransformedCells: 5,
        bySheet: [{ sheetId: 50, transformedCells: 1 }, { sheetId: 20, transformedCells: 0 }]
      }
    })).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Count overrun: sheet 50 only has 2 string cells, claiming 3 transformed strings must be rejected
    expect(() => buildCompleteExportReport(context, prepared, baseReport, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: {
        policy: 'apostrophe_prefix_v1',
        totalTransformedCells: 3,
        bySheet: [{ sheetId: 50, transformedCells: 3 }, { sheetId: 20, transformedCells: 0 }]
      }
    })).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    const actualFacts = encodeCsvSheets(prepared, { maxBytes: 100000, signal }).csvTransformCounts;
    const invalidOrders = [
      [...actualFacts.bySheet].reverse(),
      actualFacts.bySheet.slice(0, 1),
      [...actualFacts.bySheet, { sheetId: 999, transformedCells: 0 }],
      [{ sheetId: 999, transformedCells: 1 }, actualFacts.bySheet[1]],
      [{ sheetId: 50, transformedCells: -0 }, actualFacts.bySheet[1]]
    ];
    for (const bySheet of invalidOrders) {
      expect(() => buildCompleteExportReport(context, prepared, baseReport, {
        maxWarnings: 10, signal, csvTransformCounts: { ...actualFacts, bySheet }
      })).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
    }

    // Report csvTransformCounts mismatch with encoder facts (encoder has total 1, report claims total 0)
    const validFacts: ReportCsvTransforms = {
      policy: 'apostrophe_prefix_v1',
      totalTransformedCells: 1,
      bySheet: [{ sheetId: 50, transformedCells: 1 }, { sheetId: 20, transformedCells: 0 }]
    };
    const conflictingReport: ExportReport = {
      ...baseReport,
      csvTransformCounts: {
        policy: 'apostrophe_prefix_v1',
        totalTransformedCells: 0,
        bySheet: [{ sheetId: 50, transformedCells: 0 }, { sheetId: 20, transformedCells: 0 }]
      }
    };
    expect(() => buildCompleteExportReport(context, prepared, conflictingReport, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: validFacts
    })).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
  });

  it('6. rejects reserved CSV_TEXT_ESCAPED warning and enforces maxWarnings on generated + input warnings', () => {
    const { context, prepared } = createMultiSheetFixture('csv');
    const validMappings = mapCsvFilenames([
      { id: 50, title: 'Report/Data' },
      { id: 20, title: 'Report:Data' }
    ]);
    const factsWithTransforms = encodeCsvSheets(prepared, { maxBytes: 100000, signal }).csvTransformCounts;
    const { context: zeroContext, prepared: zeroPrepared } = createMultiSheetFixture('csv', 'raw', 'include_all', false);
    const factsWithZero = encodeCsvSheets(zeroPrepared, { maxBytes: 100000, signal }).csvTransformCounts;

    const baseReport: ExportReport = {
      schemaVersion: '1.0',
      source: { id: 'src_format_test', title: 'Format Test Workbook', locale: 'en_US', timeZone: 'America/New_York' },
      export: {
        startedAt: '2026-10-31T10:00:00.000Z',
        producedAt: '2026-10-31T10:00:01.000Z',
        mode: 'raw',
        format: 'csv',
        visibility: 'include_all',
        complete: true,
        consistency: 'not_atomic_no_change_detected',
        warnings: []
      },
      selectedScopes: [
        { sheetId: 50, rect: { sheetId: 50, r0: 2, c0: 1, r1: 6, c1: 4 } },
        { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 4, c1: 3 } }
      ],
      sheetOrder: [50, 20],
      limitsVersion: '1.0',
      nameMappings: validMappings,
      exclusions: []
    };

    // Forged/incoming reserved warning code CSV_TEXT_ESCAPED must be rejected
    const forgedReport: ExportReport = {
      ...baseReport,
      export: {
        ...baseReport.export,
        warnings: [{ code: 'CSV_TEXT_ESCAPED', message: 'Hacked warning' }]
      }
    };
    expect(() => buildCompleteExportReport(context, prepared, forgedReport, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: factsWithTransforms
    })).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // maxWarnings includes generated warning:
    // Report has 1 warning, transforms > 0 adds 1 warning -> total 2.
    // With maxWarnings: 1, it must exceed size limit!
    const repWithOneWarn: ExportReport = {
      ...baseReport,
      export: {
        ...baseReport.export,
        warnings: [{ code: 'USER_WARN_1', message: 'First warning' }]
      }
    };
    expect(() => buildCompleteExportReport(context, prepared, repWithOneWarn, {
      maxWarnings: 1,
      signal,
      csvTransformCounts: factsWithTransforms
    })).toThrowError(expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' }));

    // With maxWarnings: 2, generated warning fits and both are included
    const successResult = buildCompleteExportReport(context, prepared, repWithOneWarn, {
      maxWarnings: 2,
      signal,
      csvTransformCounts: factsWithTransforms
    });
    expect(successResult.export.warnings).toHaveLength(2);
    expect(successResult.export.warnings[0].code).toBe('USER_WARN_1');
    expect(successResult.export.warnings[1].code).toBe('CSV_TEXT_ESCAPED');

    // Total 0 transforms adds NO generated warning: maxWarnings: 1 succeeds
    const zeroResult = buildCompleteExportReport(zeroContext, zeroPrepared, repWithOneWarn, {
      maxWarnings: 1,
      signal,
      csvTransformCounts: factsWithZero
    });
    expect(zeroResult.export.warnings).toHaveLength(1);
    expect(zeroResult.export.warnings[0].code).toBe('USER_WARN_1');
    expect(zeroResult.csvTransformCounts).toEqual({
      policy: 'apostrophe_prefix_v1', totalTransformedCells: 0,
      bySheet: [{ sheetId: 50, transformedCells: 0 }, { sheetId: 20, transformedCells: 0 }]
    });
  });

  it('7. ensures deep immutability and snapshot isolation against input and facts mutation', () => {
    const { context, prepared } = createMultiSheetFixture('csv');
    const mutableMappings = [
      { sheetId: 50, originalTitle: 'Report/Data', exportedName: 'Report_Data.csv' },
      { sheetId: 20, originalTitle: 'Report:Data', exportedName: 'Report_Data_20.csv' }
    ];
    const mutableFacts = structuredClone(encodeCsvSheets(prepared, { maxBytes: 100000, signal }).csvTransformCounts);

    const report: ExportReport = {
      schemaVersion: '1.0',
      source: { id: 'src_format_test', title: 'Format Test Workbook', locale: 'en_US', timeZone: 'America/New_York' },
      export: {
        startedAt: '2026-10-31T10:00:00.000Z',
        producedAt: '2026-10-31T10:00:01.000Z',
        mode: 'raw',
        format: 'csv',
        visibility: 'include_all',
        complete: true,
        consistency: 'not_atomic_no_change_detected',
        warnings: [{ code: 'INPUT_WARN', message: 'Original' }]
      },
      selectedScopes: [
        { sheetId: 50, rect: { sheetId: 50, r0: 2, c0: 1, r1: 6, c1: 4 } },
        { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 4, c1: 3 } }
      ],
      sheetOrder: [50, 20],
      limitsVersion: '1.0',
      nameMappings: mutableMappings,
      exclusions: [],
      csvTransformCounts: mutableFacts
    };

    const result = buildCompleteExportReport(context, prepared, report, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: mutableFacts
    });

    // Deep freeze verification
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.export)).toBe(true);
    expect(Object.isFrozen(result.export.warnings)).toBe(true);
    expect(Object.isFrozen(result.nameMappings)).toBe(true);
    expect(Object.isFrozen(result.csvTransformCounts)).toBe(true);
    expect(Object.isFrozen(result.csvTransformCounts?.bySheet)).toBe(true);
    expect(Object.isFrozen(result.csvTransformCounts?.bySheet[0])).toBe(true);

    // Mutate source facts and report objects after call
    (mutableFacts as any).totalTransformedCells = 999;
    (mutableFacts.bySheet as any)[0] = { sheetId: 50, transformedCells: 999 };
    (mutableMappings as any)[0] = { sheetId: 50, originalTitle: 'Hacked', exportedName: 'Hacked.csv' };
    (report.export.warnings as any).push({ code: 'LATE_WARN', message: 'late' });

    // Output snapshot remains completely unmutated
    expect(result.csvTransformCounts?.totalTransformedCells).toBe(3);
    expect(result.csvTransformCounts?.bySheet[0].transformedCells).toBe(1);
    expect(result.nameMappings[0].exportedName).toBe('Report_Data.csv');
    expect(result.export.warnings).toHaveLength(2); // INPUT_WARN + CSV_TEXT_ESCAPED
    expect(result.export.warnings[0].code).toBe('INPUT_WARN');
  });

  it('8. handles pre-aborted signal and safely contains adversarial throwing getters without leaking exceptions', () => {
    const { context, prepared } = createMultiSheetFixture('csv');
    const validMappings = mapCsvFilenames([
      { id: 50, title: 'Report/Data' },
      { id: 20, title: 'Report:Data' }
    ]);

    const report: ExportReport = {
      schemaVersion: '1.0',
      source: { id: 'src_format_test', title: 'Format Test Workbook', locale: 'en_US', timeZone: 'America/New_York' },
      export: {
        startedAt: '2026-10-31T10:00:00.000Z',
        producedAt: '2026-10-31T10:00:01.000Z',
        mode: 'raw',
        format: 'csv',
        visibility: 'include_all',
        complete: true,
        consistency: 'not_atomic_no_change_detected',
        warnings: []
      },
      selectedScopes: [
        { sheetId: 50, rect: { sheetId: 50, r0: 2, c0: 1, r1: 6, c1: 4 } },
        { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 4, c1: 3 } }
      ],
      sheetOrder: [50, 20],
      limitsVersion: '1.0',
      nameMappings: validMappings,
      exclusions: []
    };

    // Pre-aborted signal
    const abortedSignal = AbortSignal.abort();
    expect(() => buildCompleteExportReport(context, prepared, report, {
      maxWarnings: 10,
      signal: abortedSignal,
      csvTransformCounts: {
        policy: 'apostrophe_prefix_v1',
        totalTransformedCells: 0,
        bySheet: [{ sheetId: 50, transformedCells: 0 }, { sheetId: 20, transformedCells: 0 }]
      }
    })).toThrowError(expect.objectContaining({ code: 'OPERATION_ABORTED' }));

    // Adversarial throwing getter on options.csvTransformCounts
    const throwingOption = {
      maxWarnings: 10,
      signal,
      get csvTransformCounts() {
        throw new Error('Hostile options getter');
      }
    };
    expect(() => buildCompleteExportReport(context, prepared, report, throwingOption as any))
      .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));

    // Adversarial throwing getter on csvTransformCounts.bySheet
    const throwingFacts = {
      policy: 'apostrophe_prefix_v1' as const,
      totalTransformedCells: 0,
      get bySheet() {
        throw new Error('Hostile facts getter');
      }
    };
    expect(() => buildCompleteExportReport(context, prepared, report, {
      maxWarnings: 10,
      signal,
      csvTransformCounts: throwingFacts as any
    })).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
  });
});
