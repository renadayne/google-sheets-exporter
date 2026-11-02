/**
 * T36a Dedicated Module Worker for Real MV3 Writer Browser Smoke Harness.
 * Runs inside dedicated Web Worker under strict MV3 CSP (script-src 'self').
 * Imports actual root writer modules, executes real formatting and packaging,
 * and transfers owned artifact Uint8Array buffers back to the parent page.
 */

import type {
  Artifact,
  NormalizedChunk
} from '../../../src/contracts/domain.ts';
import { DomainError } from '../../../src/contracts/errors.ts';
import { createJsonWriter } from '../../../src/export/json.ts';
import { packageCsv } from '../../../src/export/csv-package.ts';
import { packageXlsx } from '../../../src/export/xlsx-package.ts';
import { prepareWriterData } from '../../../src/export/prepare.ts';
import {
  chunk30,
  chunk10,
  chunk20,
  createContext,
  createReport
} from './fixture.ts';

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
