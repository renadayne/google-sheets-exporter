/**
 * Side-effect-free fixture definitions for Writer Smoke Harness.
 * Extracted from worker.ts (T36c3a).
 */

import type {
  Cell,
  ExportReport,
  ExportScope,
  NormalizedChunk,
  Rect,
  SheetMeta
} from '../../../src/contracts/domain.ts';
import type { WriterContext } from '../../../src/contracts/ports.ts';
import { snapshotWriterContext, PROVISIONAL_MAX_SHEETS } from '../../../src/export/context.ts';
import { mapCsvFilenames, mapWorksheetNames } from '../../../src/export/names.ts';

// 3 selected tabs sourceIDs [30, 10, 20] in index order
const meta30: SheetMeta = {
  id: 30,
  title: 'Input/Data',
  index: 0,
  type: 'GRID',
  hidden: false,
  rows: 10,
  columns: 10
};

const meta10: SheetMeta = {
  id: 10,
  title: 'EmptyTab',
  index: 1,
  type: 'GRID',
  hidden: false,
  rows: 10,
  columns: 10
};

const meta20: SheetMeta = {
  id: 20,
  title: 'Summary:Final',
  index: 2,
  type: 'GRID',
  hidden: false,
  rows: 10,
  columns: 10
};

// One nonzero-origin scope on sheet 30: r0=2, c0=1, r1=5, c1=4
const rect30: Rect = { sheetId: 30, r0: 2, c0: 1, r1: 5, c1: 4 };
const scope30: ExportScope = { sheetId: 30, rect: rect30 };

// Middle blank tab on sheet 10: r0=0, c0=0, r1=2, c1=2
const rect10: Rect = { sheetId: 10, r0: 0, c0: 0, r1: 2, c1: 2 };
const scope10: ExportScope = { sheetId: 10, rect: rect10 };

// Third tab on sheet 20: r0=0, c0=0, r1=3, c1=3
const rect20: Rect = { sheetId: 20, r0: 0, c0: 0, r1: 3, c1: 3 };
const scope20: ExportScope = { sheetId: 20, rect: rect20 };

// Cells for sheet 30: typed scalar, date serial (numberFormatType: 'DATE_TIME'),
// dangerous formulaText, Unicode, literal _x000D_, CRLF
const cells30: Cell[] = [
  { r: 2, c: 1, kind: 'string', value: 'Unicode: \u00e9 \u{1F31F}' },
  { r: 2, c: 2, kind: 'number', value: 45678.5, numberFormatType: 'DATE_TIME' },
  { r: 2, c: 3, kind: 'string', value: '=HYPERLINK("http://evil.com")', formulaText: '=HYPERLINK("http://evil.com")' },
  { r: 3, c: 1, kind: 'string', value: 'Literal _x000D_ test' },
  { r: 3, c: 2, kind: 'string', value: 'Line1\r\nLine2' },
  { r: 4, c: 2, kind: 'boolean', value: true }
];

export const chunk30: NormalizedChunk = {
  jobId: 'smoke_job_1',
  chunkId: 'chunk_30',
  rect: rect30,
  cells: cells30,
  excludedIntervals: { rows: [], columns: [] },
  byteCount: 256
};

// Middle blank tab: zero cells in chunk
export const chunk10: NormalizedChunk = {
  jobId: 'smoke_job_1',
  chunkId: 'chunk_10',
  rect: rect10,
  cells: [],
  excludedIntervals: { rows: [], columns: [] },
  byteCount: 0
};

// Cells for sheet 20
const cells20: Cell[] = [
  { r: 0, c: 0, kind: 'string', value: 'Summary Title' },
  { r: 1, c: 1, kind: 'number', value: 100 },
  { r: 2, c: 2, kind: 'string', value: '=SUM(A1:B2)', formulaText: '=SUM(A1:B2)' }
];

export const chunk20: NormalizedChunk = {
  jobId: 'smoke_job_1',
  chunkId: 'chunk_20',
  rect: rect20,
  cells: cells20,
  excludedIntervals: { rows: [], columns: [] },
  byteCount: 128
};

export function createContext(format: 'json' | 'csv' | 'xlsx', signal: AbortSignal): WriterContext {
  const rawContext: WriterContext = {
    sourceId: 'smoke-test-source',
    title: 'Smoke Test Workbook',
    locale: 'en',
    timeZone: 'UTC',
    scopes: [scope30, scope10, scope20],
    mode: 'formula_text',
    format,
    visibility: 'include_all',
    limitsVersion: '1.0',
    sheetOrder: [30, 10, 20],
    sheets: [meta30, meta10, meta20]
  };

  return snapshotWriterContext(rawContext, {
    maxSheets: PROVISIONAL_MAX_SHEETS,
    signal
  });
}

export function createReport(
  context: WriterContext,
  format: 'json' | 'csv' | 'xlsx'
): ExportReport {
  const sheetInputs = [
    { id: 30, title: 'Input/Data' },
    { id: 10, title: 'EmptyTab' },
    { id: 20, title: 'Summary:Final' }
  ];

  let nameMappings;
  if (format === 'json') {
    nameMappings = sheetInputs.map(s => Object.freeze({
      sheetId: s.id,
      originalTitle: s.title,
      exportedName: s.title
    }));
  } else if (format === 'csv') {
    nameMappings = mapCsvFilenames(sheetInputs);
  } else {
    nameMappings = mapWorksheetNames(sheetInputs);
  }

  return {
    schemaVersion: '1.0',
    source: {
      id: context.sourceId,
      title: context.title,
      locale: context.locale,
      timeZone: context.timeZone
    },
    export: {
      startedAt: '2026-11-02T00:00:00.000Z',
      producedAt: '2026-11-02T00:00:01.000Z',
      mode: 'formula_text',
      format,
      visibility: 'include_all',
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: []
    },
    selectedScopes: context.scopes,
    sheetOrder: context.sheetOrder,
    limitsVersion: context.limitsVersion,
    nameMappings,
    exclusions: []
  };
}
