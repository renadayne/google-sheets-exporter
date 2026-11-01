/**
 * T36a Dedicated Module Worker for Real MV3 Writer Browser Smoke Harness.
 * Runs inside dedicated Web Worker under strict MV3 CSP (script-src 'self').
 * Imports actual root writer modules, executes real formatting and packaging,
 * and transfers owned artifact Uint8Array buffers back to the parent page.
 */

import type {
  Cell,
  ExportReport,
  NormalizedChunk,
  Rect,
  SheetMeta,
  ExportScope,
  Artifact
} from '../../../src/contracts/domain.ts';
import type { WriterContext } from '../../../src/contracts/ports.ts';
import { DomainError } from '../../../src/contracts/errors.ts';
import { createJsonWriter } from '../../../src/export/json.ts';
import { packageCsv } from '../../../src/export/csv-package.ts';
import { packageXlsx } from '../../../src/export/xlsx-package.ts';
import { snapshotWriterContext, PROVISIONAL_MAX_SHEETS } from '../../../src/export/context.ts';
import { prepareWriterData } from '../../../src/export/prepare.ts';
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

const chunk30: NormalizedChunk = {
  jobId: 'smoke_job_1',
  chunkId: 'chunk_30',
  rect: rect30,
  cells: cells30,
  excludedIntervals: { rows: [], columns: [] },
  byteCount: 256
};

// Middle blank tab: zero cells in chunk
const chunk10: NormalizedChunk = {
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

const chunk20: NormalizedChunk = {
  jobId: 'smoke_job_1',
  chunkId: 'chunk_20',
  rect: rect20,
  cells: cells20,
  excludedIntervals: { rows: [], columns: [] },
  byteCount: 128
};

function createContext(format: 'json' | 'csv' | 'xlsx', signal: AbortSignal): WriterContext {
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

function createReport(
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

async function runSmokeTests() {
  const signal = new AbortController().signal;

  // 1. JSON Export via WriterPort begin / append / finalize
  const ctxJson = createContext('json', signal);
  const reportJson = createReport(ctxJson, 'json');
  const jsonWriter = createJsonWriter({
    maxChunks: 100,
    maxCells: 10000,
    maxIntervals: 100,
    maxDecodedBytes: 10 * 1024 * 1024,
    maxWarnings: 100,
    maxBytes: 10 * 1024 * 1024
  });

  await jsonWriter.begin(ctxJson, signal);
  await jsonWriter.append(chunk30, signal);
  await jsonWriter.append(chunk10, signal);
  await jsonWriter.append(chunk20, signal);
  const jsonArtifacts = await jsonWriter.finalize(reportJson, signal);

  // 2. CSV Export via prepareWriterData + packageCsv (produces multi-tab ZIP)
  const ctxCsv = createContext('csv', signal);
  const reportCsv = createReport(ctxCsv, 'csv');
  const prepCsv = prepareWriterData(ctxCsv, [chunk30, chunk10, chunk20], {
    maxChunks: 100,
    maxIntervals: 100,
    maxCells: 10000,
    signal
  });
  const csvArtifacts = packageCsv(ctxCsv, prepCsv, reportCsv, {
    maxUncompressedBytes: 10 * 1024 * 1024,
    maxBytes: 10 * 1024 * 1024,
    maxWarnings: 100,
    signal
  });

  // 3. XLSX Export via prepareWriterData + packageXlsx (produces workbook + companion report)
  const ctxXlsx = createContext('xlsx', signal);
  const reportXlsx = createReport(ctxXlsx, 'xlsx');
  const prepXlsx = prepareWriterData(ctxXlsx, [chunk30, chunk10, chunk20], {
    maxChunks: 100,
    maxIntervals: 100,
    maxCells: 10000,
    signal
  });
  const xlsxArtifacts = await packageXlsx(ctxXlsx, prepXlsx, reportXlsx, {
    maxBytes: 10 * 1024 * 1024,
    maxCells: 10000,
    maxInputTextUnits: 100000,
    maxWarnings: 100,
    signal
  });

  // 4. Negative test: incomplete chunk coverage must fail with FORMAT_SERIALIZATION_FAILED
  // Set incomplete chunk jobId SAME 'smoke_job_1' so it reaches coverage gap instead of mixed-job rejection
  let caughtNegativeErrorCode: string | null = null;
  try {
    const incompleteChunk: NormalizedChunk = {
      jobId: 'smoke_job_1',
      chunkId: 'chunk_incomplete_coverage',
      rect: { sheetId: 30, r0: 2, c0: 1, r1: 3, c1: 4 }, // only 1 row covered out of 3 required in scope
      cells: [],
      excludedIntervals: { rows: [], columns: [] },
      byteCount: 0
    };
    prepareWriterData(ctxCsv, [incompleteChunk, chunk10, chunk20], {
      maxChunks: 100,
      maxIntervals: 100,
      maxCells: 10000,
      signal
    });
  } catch (err: unknown) {
    if (err instanceof DomainError) {
      caughtNegativeErrorCode = err.code;
    } else if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
      caughtNegativeErrorCode = (err as { code: string }).code;
    }
  }

  // 5. Build transferable buffers list and post message
  const jsonBuf = (jsonArtifacts[0].data as Uint8Array).buffer;
  const csvBuf = (csvArtifacts[0].data as Uint8Array).buffer;
  const xlsxBuf = (xlsxArtifacts[0].data as Uint8Array).buffer;
  const companionBuf = (xlsxArtifacts[1].data as Uint8Array).buffer;

  const transferList: Transferable[] = [jsonBuf, csvBuf, xlsxBuf, companionBuf];

  const responsePayload = {
    type: 'SMOKE_COMPLETE',
    success: true,
    jsonArtifact: {
      filename: jsonArtifacts[0].filename,
      mimeType: jsonArtifacts[0].mimeType,
      data: jsonArtifacts[0].data,
      byteLength: jsonArtifacts[0].byteLength
    },
    csvArtifacts: csvArtifacts.map((a: Artifact) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      data: a.data,
      byteLength: a.byteLength
    })),
    xlsxArtifacts: xlsxArtifacts.map((a: Artifact) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      data: a.data,
      byteLength: a.byteLength
    })),
    negativeResult: {
      caughtErrorCode: caughtNegativeErrorCode
    }
  };

  const workerPost = (self as unknown as {
    postMessage: (msg: unknown, transfer?: Transferable[]) => void;
  }).postMessage.bind(self);

  workerPost(responsePayload, transferList);

  // 6. Genuine native transfer observation:
  // Inspect actual four buffers.byteLength after detachment and post second message
  const observedLengths = [
    jsonBuf.byteLength,
    csvBuf.byteLength,
    xlsxBuf.byteLength,
    companionBuf.byteLength
  ];

  workerPost({
    type: 'TRANSFER_OBSERVATION',
    transferredBufferByteLengths: observedLengths
  });
}

self.onmessage = async (event: MessageEvent) => {
  if (event.data?.type === 'START') {
    try {
      await runSmokeTests();
    } catch {
      // Static worker error code on failure (no raw provider message)
      (self as unknown as { postMessage: (msg: unknown) => void }).postMessage({
        type: 'SMOKE_ERROR',
        error: 'WORKER_SMOKE_EXECUTION_FAILED'
      });
    }
  }
};
