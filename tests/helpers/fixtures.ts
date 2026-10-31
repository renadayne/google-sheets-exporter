/**
 * T10a Shared Synthetic Fixture and Oracle Catalog
 *
 * Provides hand-authored, fresh-copy typed synthetic fixtures and a small catalog
 * linking reviewed T03 GridData fixtures/oracles and T09 JSON export examples.
 *
 * Rules:
 * - Factories return fresh nested copies (via structuredClone) to prevent cross-test contamination.
 * - Input objects are never mutated.
 * - Explicitly uses fake principal/email/test token strings only, never real credentials.
 * - Does not invent production normalizer/A1/scope algorithms to generate expectations.
 * - T03 GridData transport payloads remain unvalidated transport data (payload: unknown).
 * - No unchecked casts that hide shape errors.
 */

import type {
  SourceRef,
  AccountContext,
  PermittedEligibility,
  WorkbookMeta,
  SheetMeta,
  Rect,
  ExportScope,
  ExportRequest,
  Cell,
  ExportReport,
  JsonExportDocument,
  JsonExportSheet
} from '../../src/contracts/domain.ts';

import type {
  WriterContext,
  GridTransportPayload
} from '../../src/contracts/ports.ts';

// Reviewed T03 GridData fixtures
import multisheetFidelityTransport from '../fixtures/grid/multisheet-fidelity.json';
import multisheetFidelityOracle from '../fixtures/grid/multisheet-fidelity.oracle.json';
import unavailableVisibilityTransport from '../fixtures/grid/unavailable-visibility.json';
import unavailableVisibilityOracle from '../fixtures/grid/unavailable-visibility.oracle.json';

// Reviewed T09 JSON export fixtures
import rawMultiTabExport from '../fixtures/exports/raw-multitab.json';
import formattedStringsExport from '../fixtures/exports/formatted-strings.json';
import formulaTextExport from '../fixtures/exports/formula-text.json';
import metadataReportOnlyExport from '../fixtures/exports/metadata-report-only.json';

// --- Canonical Identifiers and Constants ---

export const CANONICAL_SPREADSHEET_ID = 'synthetic-canonical-wb-001';
export const CANONICAL_PRINCIPAL_KEY = 'synthetic-test-principal-001';
export const CANONICAL_DISPLAY_EMAIL = 'test-user@synthetic.example.com';
export const CANONICAL_EVIDENCE_REVISION = 'synthetic-evidence-rev-1';
export const CANONICAL_LIMITS_VERSION = '1.0';

/**
 * Stable NON-consecutive sheet IDs.
 * Gaps between IDs (101, 205, 309) ensure implementations do not assume
 * sheetId equals index or that sheet IDs are consecutive.
 */
export const CANONICAL_SPARSE_SHEET_ID = 101;
export const CANONICAL_EMPTY_SHEET_ID = 205;
export const CANONICAL_HIDDEN_SHEET_ID = 309;

// --- Manual Sparse Raw-Mode Oracle Cells ---

/**
 * Hand-authored sparse normalized raw-mode oracle cells.
 * Tiny list of 3 cells with absolute 0-based coordinates, never dense 90,000-row arrays.
 * - A1: row 0, col 0, string '00123' (preserves leading zero)
 * - D50: row 49, col 3, string 'middle'
 * - Z90000: row 89999, col 25, number 42
 */
export const CANONICAL_SPARSE_RAW_ORACLE_CELLS: readonly Cell[] = Object.freeze([
  Object.freeze({ r: 0, c: 0, kind: 'string' as const, value: '00123' }),
  Object.freeze({ r: 49, c: 3, kind: 'string' as const, value: 'middle' }),
  Object.freeze({ r: 89999, c: 25, kind: 'number' as const, value: 42 })
]);

/**
 * Returns a fresh, mutable array of the canonical sparse raw-mode oracle cells.
 */
export function createCanonicalSparseRawOracleCells(): Cell[] {
  return structuredClone([...CANONICAL_SPARSE_RAW_ORACLE_CELLS]);
}

// --- Canonical Sheet and Workbook Definitions ---

const CANONICAL_SHEETS: readonly SheetMeta[] = [
  {
    id: CANONICAL_SPARSE_SHEET_ID,
    title: 'SparseTab',
    index: 0,
    type: 'GRID',
    hidden: false,
    rows: 90000,
    columns: 26
  },
  {
    id: CANONICAL_EMPTY_SHEET_ID,
    title: 'EmptyTab',
    index: 1,
    type: 'GRID',
    hidden: false,
    rows: 1000,
    columns: 26
  },
  {
    id: CANONICAL_HIDDEN_SHEET_ID,
    title: 'HiddenTab',
    index: 2,
    type: 'GRID',
    hidden: true,
    rows: 100,
    columns: 10
  }
];

const CANONICAL_WORKBOOK: WorkbookMeta = {
  id: CANONICAL_SPREADSHEET_ID,
  title: 'Canonical Test Workbook',
  locale: 'en_US',
  timeZone: 'UTC',
  sheets: CANONICAL_SHEETS,
  sourceVersionObservation: 'synthetic-v1'
};

/**
 * Returns a fresh deep copy of the canonical 3-tab WorkbookMeta:
 * - Tab 0 (id: 101, index: 0): visible populated sparse tab containing Z90000 ([0, 90000) x [0, 26))
 * - Tab 1 (id: 205, index: 1): visible empty tab ([0, 1000) x [0, 26))
 * - Tab 2 (id: 309, index: 2): hidden tab ([0, 100) x [0, 10))
 */
export function createCanonicalWorkbookMeta(): WorkbookMeta {
  return structuredClone(CANONICAL_WORKBOOK);
}

/**
 * Returns a fresh copy of the matching SourceRef.
 */
export function createCanonicalSourceRef(): SourceRef {
  return {
    spreadsheetId: CANONICAL_SPREADSHEET_ID,
    highlightedSheetId: CANONICAL_SPARSE_SHEET_ID
  };
}

/**
 * Returns a fresh copy of synthetic AccountContext.
 * Explicitly uses fake principal/email strings only; never real credentials.
 */
export function createSyntheticAccountContext(): AccountContext {
  return {
    principalKey: CANONICAL_PRINCIPAL_KEY,
    displayEmail: CANONICAL_DISPLAY_EMAIL
  };
}

/**
 * Returns a fresh copy of PermittedEligibility bound to canonical source and principal.
 * Local synthetic evidence revision; not a claim of live Google permissions.
 */
export function createSyntheticPermittedEligibility(): PermittedEligibility {
  return {
    status: 'permitted',
    sourceId: CANONICAL_SPREADSHEET_ID,
    principalKey: CANONICAL_PRINCIPAL_KEY,
    checkedAt: '2026-10-31T00:00:00.000Z',
    evidenceRevision: CANONICAL_EVIDENCE_REVISION,
    reasonCode: 'SYNTHETIC_TEST_PERMITTED'
  };
}

// --- Canonical Scopes and Export Request ---

function buildCanonicalScopes(): readonly ExportScope[] {
  const sparseRect: Rect = {
    sheetId: CANONICAL_SPARSE_SHEET_ID,
    r0: 0,
    c0: 0,
    r1: 90000,
    c1: 26
  };
  const emptyRect: Rect = {
    sheetId: CANONICAL_EMPTY_SHEET_ID,
    r0: 0,
    c0: 0,
    r1: 1000,
    c1: 26
  };
  return [
    { sheetId: CANONICAL_SPARSE_SHEET_ID, rect: sparseRect },
    { sheetId: CANONICAL_EMPTY_SHEET_ID, rect: emptyRect }
  ];
}

/**
 * Returns a fresh copy of default include_all ExportRequest for the two visible tabs in source order.
 */
export function createCanonicalExportRequest(): ExportRequest {
  return {
    sourceId: CANONICAL_SPREADSHEET_ID,
    principalKey: CANONICAL_PRINCIPAL_KEY,
    scopes: structuredClone(buildCanonicalScopes()),
    mode: 'raw',
    format: 'json',
    visibility: 'include_all',
    limitsVersion: CANONICAL_LIMITS_VERSION
  };
}

/**
 * Returns a fresh copy of sanitized WriterContext for the two visible tabs in source order.
 * Strictly excludes principal and auth fields via optional never types in WriterContext.
 */
export function createCanonicalWriterContext(): WriterContext {
  const visibleSheets: SheetMeta[] = [
    { ...CANONICAL_SHEETS[0] },
    { ...CANONICAL_SHEETS[1] }
  ];

  return {
    sourceId: CANONICAL_SPREADSHEET_ID,
    title: CANONICAL_WORKBOOK.title,
    locale: CANONICAL_WORKBOOK.locale,
    timeZone: CANONICAL_WORKBOOK.timeZone,
    scopes: structuredClone(buildCanonicalScopes()),
    mode: 'raw',
    format: 'json',
    visibility: 'include_all',
    limitsVersion: CANONICAL_LIMITS_VERSION,
    sheetOrder: [CANONICAL_SPARSE_SHEET_ID, CANONICAL_EMPTY_SHEET_ID],
    sheets: structuredClone(visibleSheets)
  };
}

/**
 * Returns a fresh copy of metadata-only ExportReport matching the canonical export.
 * Validates against report.schema.json.
 */
export function createCanonicalExportReport(): ExportReport {
  return {
    schemaVersion: '1.0',
    source: {
      id: CANONICAL_SPREADSHEET_ID,
      title: CANONICAL_WORKBOOK.title,
      locale: CANONICAL_WORKBOOK.locale,
      timeZone: CANONICAL_WORKBOOK.timeZone
    },
    export: {
      startedAt: '2026-10-31T00:00:00.000Z',
      producedAt: '2026-10-31T00:00:02.000Z',
      mode: 'raw',
      format: 'json',
      visibility: 'include_all',
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: []
    },
    selectedScopes: structuredClone(buildCanonicalScopes()),
    sheetOrder: [CANONICAL_SPARSE_SHEET_ID, CANONICAL_EMPTY_SHEET_ID],
    limitsVersion: CANONICAL_LIMITS_VERSION,
    nameMappings: [
      {
        sheetId: CANONICAL_SPARSE_SHEET_ID,
        originalTitle: 'SparseTab',
        exportedName: 'SparseTab'
      },
      {
        sheetId: CANONICAL_EMPTY_SHEET_ID,
        originalTitle: 'EmptyTab',
        exportedName: 'EmptyTab'
      }
    ],
    exclusions: [
      {
        sheetId: CANONICAL_SPARSE_SHEET_ID,
        excludedRows: [],
        excludedColumns: []
      },
      {
        sheetId: CANONICAL_EMPTY_SHEET_ID,
        excludedRows: [],
        excludedColumns: []
      }
    ],
    sourceObservations: {
      before: {
        observedAt: '2026-10-31T00:00:00.000Z',
        version: 'synthetic-obs-1',
        modifiedTime: '2026-10-30T23:59:00.000Z'
      },
      after: {
        observedAt: '2026-10-31T00:00:02.000Z',
        version: 'synthetic-obs-1',
        modifiedTime: '2026-10-30T23:59:00.000Z'
      }
    }
  };
}

/**
 * Returns a fresh, fully-typed JsonExportDocument envelope containing the canonical report metadata
 * and two sheets:
 * - SparseTab: contains the 3 canonical sparse oracle cells (A1, D50, Z90000)
 * - EmptyTab: contains empty cells array
 * Validates against export.schema.json without unchecked casts.
 */
export function createCanonicalJsonExportDocument(): JsonExportDocument {
  const report = createCanonicalExportReport();

  const sparseExportSheet: JsonExportSheet = {
    id: CANONICAL_SPARSE_SHEET_ID,
    title: 'SparseTab',
    index: 0,
    scope: {
      sheetId: CANONICAL_SPARSE_SHEET_ID,
      r0: 0,
      c0: 0,
      r1: 90000,
      c1: 26
    },
    visibility: {
      mode: 'include_all',
      excludedRows: [],
      excludedColumns: []
    },
    cells: createCanonicalSparseRawOracleCells()
  };

  const emptyExportSheet: JsonExportSheet = {
    id: CANONICAL_EMPTY_SHEET_ID,
    title: 'EmptyTab',
    index: 1,
    scope: {
      sheetId: CANONICAL_EMPTY_SHEET_ID,
      r0: 0,
      c0: 0,
      r1: 1000,
      c1: 26
    },
    visibility: {
      mode: 'include_all',
      excludedRows: [],
      excludedColumns: []
    },
    cells: []
  };

  return {
    ...report,
    export: {
      ...report.export,
      format: 'json',
      complete: true,
      consistency: 'not_atomic_no_change_detected'
    },
    sheets: [sparseExportSheet, emptyExportSheet]
  };
}

// --- Transport Payload Helpers for T03 Fixtures ---

/**
 * Returns unvalidated transport payload wrapping T03 multisheet-fidelity.json.
 * Kept typed as unknown; does not cast Google JSON to domain models.
 */
export function createMultisheetGridTransportPayload(): GridTransportPayload {
  return {
    payload: structuredClone(multisheetFidelityTransport),
    byteCount: new TextEncoder().encode(JSON.stringify(multisheetFidelityTransport)).byteLength
  };
}

/**
 * Returns unvalidated transport payload wrapping T03 unavailable-visibility.json.
 * Kept typed as unknown; does not cast Google JSON to domain models.
 */
export function createUnavailableVisibilityGridTransportPayload(): GridTransportPayload {
  return {
    payload: structuredClone(unavailableVisibilityTransport),
    byteCount: new TextEncoder().encode(JSON.stringify(unavailableVisibilityTransport)).byteLength
  };
}

// --- Reviewed Fixture Catalog ---

/**
 * Catalog getters return fresh copies so consumers cannot mutate the imported fixtures.
 * Transport byteCount measures the UTF-8 minified synthetic body, not a live response.
 */
export const REVIEWED_FIXTURE_CATALOG = Object.freeze({
  t03GridData: Object.freeze({
    multisheetFidelity: Object.freeze({
      get transport() { return structuredClone(multisheetFidelityTransport); },
      get oracle() { return structuredClone(multisheetFidelityOracle); }
    }),
    unavailableVisibility: Object.freeze({
      get transport() { return structuredClone(unavailableVisibilityTransport); },
      get oracle() { return structuredClone(unavailableVisibilityOracle); }
    })
  }),
  t09JsonExports: Object.freeze({
    get rawMultiTab() { return structuredClone(rawMultiTabExport); },
    get formattedStrings() { return structuredClone(formattedStringsExport); },
    get formulaText() { return structuredClone(formulaTextExport); },
    get metadataReportOnly() { return structuredClone(metadataReportOnlyExport); }
  })
});
