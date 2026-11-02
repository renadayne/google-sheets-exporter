import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parse } from 'csv-parse/sync';

import type { Cell, ExportFormat, ExportReport, NormalizedChunk } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import type { WorkerResponse } from '../../src/contracts/messages.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import { snapshotWriterContext } from '../../src/export/context.ts';
import {
  CANONICAL_SPREADSHEET_ID,
  CANONICAL_SPARSE_SHEET_ID,
  createCanonicalExportReport,
  createCanonicalWriterContext
} from '../helpers/fixtures.ts';
import { createWorkerHost } from '../../src/runtime/worker-host.ts';

function asBytes(data: unknown): Uint8Array {
  if (!(data instanceof Uint8Array)) throw new Error('Expected Uint8Array');
  return data;
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

function makeChunk(sheetId: number, cells: Cell[], jobId: string): NormalizedChunk {
  return {
    jobId,
    chunkId: `chunk_${sheetId}`,
    rect: { sheetId, r0: 0, c0: 0, r1: 2, c1: 2 },
    cells,
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 64
  };
}

interface RecordedEmission {
  readonly response: WorkerResponse;
  readonly transfer: Transferable[];
  readonly cloned: WorkerResponse;
  readonly senderBuffers: readonly ArrayBuffer[];
}

function createHarness() {
  const emissions: RecordedEmission[] = [];
  const host = createWorkerHost((response, transfer) => {
    const senderBuffers: ArrayBuffer[] = [];
    if (response.type === 'STAGED_ARTIFACTS') {
      for (let i = 0; i < response.artifacts.length; i++) {
        const art = response.artifacts[i]!;
        if (art.data instanceof Uint8Array && art.data.buffer instanceof ArrayBuffer) {
          senderBuffers.push(art.data.buffer);
        }
      }
    }
    const cloned = structuredClone(response, { transfer });
    emissions.push({
      response,
      transfer,
      cloned,
      senderBuffers
    });
  });
  return { host, emissions };
}

describe('T36c1 Dedicated Worker Host Composition', () => {
  const signal = new AbortController().signal;

  it('JSON roundtrip host: transfers owned ArrayBuffer, detaches sender, parses valid document with expected source coordinates', async () => {
    const { host, emissions } = createHarness();
    const jobId = 'job_json_01';
    const context = makeSmallContext('json', signal);
    const cells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: 'json_val_A1' },
      { r: 1, c: 1, kind: 'number', value: 123 }
    ];
    const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells, jobId);
    const report = makeReportForContext(context, 'json');

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'BEGIN',
      context
    });

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'APPEND',
      chunk
    });

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'FINALIZE',
      report
    });

    expect(emissions).toHaveLength(4);

    // 1. ACK begin
    const ackBegin = emissions[0]!;
    expect(ackBegin.response.type).toBe('ACK');
    expect(ackBegin.transfer).toEqual([]);
    expect(ackBegin.response).toEqual({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'ACK',
      phase: 'begin'
    });
    expect('percent' in ackBegin.response).toBe(false);
    expect('percentage' in ackBegin.response).toBe(false);

    // 2. ACK append
    const ackAppend = emissions[1]!;
    expect(ackAppend.response.type).toBe('ACK');
    expect(ackAppend.transfer).toEqual([]);
    expect(ackAppend.response).toEqual({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'ACK',
      phase: 'append',
      chunksCompleted: 1
    });
    expect('percent' in ackAppend.response).toBe(false);

    // 3. PROGRESS serializing
    const progress = emissions[2]!;
    expect(progress.response.type).toBe('PROGRESS');
    expect(progress.transfer).toEqual([]);
    expect(progress.response).toEqual({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'PROGRESS',
      phase: 'serializing',
      chunksCompleted: 1
    });
    expect('percent' in progress.response).toBe(false);

    // 4. STAGED_ARTIFACTS
    const staged = emissions[3]!;
    expect(staged.response.type).toBe('STAGED_ARTIFACTS');
    expect(staged.transfer).toHaveLength(1);
    expect(staged.senderBuffers).toHaveLength(1);
    // Real transfer via structuredClone detaches the sender ArrayBuffer
    expect(staged.senderBuffers[0]!.byteLength).toBe(0);

    // Assert cloned response integrity
    const stagedClone = staged.cloned;
    if (stagedClone.type !== 'STAGED_ARTIFACTS') throw new Error('Expected STAGED_ARTIFACTS');
    expect(stagedClone.protocolVersion).toBe(1);
    expect(stagedClone.jobId).toBe(jobId);
    expect(stagedClone.generation).toBe(1);
    expect(stagedClone.artifacts).toHaveLength(1);

    const art = stagedClone.artifacts[0]!;
    expect(art.filename).toBe('Canonical Test Workbook.json');
    expect(art.mimeType).toBe('application/json');
    const u8 = asBytes(art.data);
    expect(art.byteLength).toBe(u8.byteLength);
    expect(art.byteLength).toBeGreaterThan(0);

    const parsed = JSON.parse(new TextDecoder().decode(u8));
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.source.id).toBe(CANONICAL_SPREADSHEET_ID);
    expect(parsed.sheets).toHaveLength(1);
    expect(parsed.sheets[0]!.title).toBe('SparseTab');
    expect(parsed.sheets[0]!.cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: 'json_val_A1' },
      { r: 1, c: 1, kind: 'number', value: 123 }
    ]);
  });

  it('CSV roundtrip host: transfers primary CSV and private companion metadata ArrayBuffers with deduplication and detachment', async () => {
    const { host, emissions } = createHarness();
    const jobId = 'job_csv_01';
    const context = makeSmallContext('csv', signal);
    const cells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: 'csv_val_A1' },
      { r: 1, c: 1, kind: 'number', value: 456 }
    ];
    const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells, jobId);
    const report = makeReportForContext(context, 'csv');

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'BEGIN',
      context
    });

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'APPEND',
      chunk
    });

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'FINALIZE',
      report
    });

    expect(emissions).toHaveLength(4);
    const staged = emissions[3]!;
    expect(staged.response.type).toBe('STAGED_ARTIFACTS');

    // Single-tab CSV produces 2 artifacts: primary CSV + private staged companion metadata
    expect(staged.transfer).toHaveLength(2);
    expect(staged.senderBuffers).toHaveLength(2);
    expect(staged.senderBuffers[0]!.byteLength).toBe(0);
    expect(staged.senderBuffers[1]!.byteLength).toBe(0);

    const stagedClone = staged.cloned;
    if (stagedClone.type !== 'STAGED_ARTIFACTS') throw new Error('Expected STAGED_ARTIFACTS');
    expect(stagedClone.artifacts).toHaveLength(2);

    // Primary CSV
    const csvArt = stagedClone.artifacts[0]!;
    expect(csvArt.filename).toBe('SparseTab.csv');
    expect(csvArt.mimeType).toBe('text/csv');
    const csvBytes = asBytes(csvArt.data);
    expect(csvArt.byteLength).toBe(csvBytes.byteLength);
    const rows = parse(Buffer.from(csvBytes.buffer, csvBytes.byteOffset, csvBytes.byteLength), {
      bom: true,
      record_delimiter: '\r\n'
    });
    expect(rows).toEqual([['csv_val_A1', ''], ['', '456']]);

    // Private companion metadata
    const metaArt = stagedClone.artifacts[1]!;
    expect(metaArt.filename).toBe('SparseTab.metadata.json');
    expect(metaArt.mimeType).toBe('application/json');
    const metaBytes = asBytes(metaArt.data);
    expect(metaArt.byteLength).toBe(metaBytes.byteLength);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes));
    expect(meta.export.format).toBe('csv');
    expect(meta.source.id).toBe(CANONICAL_SPREADSHEET_ID);
  });

  it('XLSX roundtrip host: transfers workbook and companion metadata, detaches senders, parses exact cells and types via SheetJS', async () => {
    const { host, emissions } = createHarness();
    const jobId = 'job_xlsx_01';
    const context = makeSmallContext('xlsx', signal);
    const cells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: 'xlsx_val_A1' },
      { r: 1, c: 1, kind: 'number', value: 789 }
    ];
    const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells, jobId);
    const report = makeReportForContext(context, 'xlsx');

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'BEGIN',
      context
    });

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'APPEND',
      chunk
    });

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'FINALIZE',
      report
    });

    expect(emissions).toHaveLength(4);
    const staged = emissions[3]!;
    expect(staged.response.type).toBe('STAGED_ARTIFACTS');

    expect(staged.transfer).toHaveLength(2);
    expect(staged.senderBuffers).toHaveLength(2);
    expect(staged.senderBuffers[0]!.byteLength).toBe(0);
    expect(staged.senderBuffers[1]!.byteLength).toBe(0);

    const stagedClone = staged.cloned;
    if (stagedClone.type !== 'STAGED_ARTIFACTS') throw new Error('Expected STAGED_ARTIFACTS');
    expect(stagedClone.artifacts).toHaveLength(2);

    // Primary XLSX
    const xlsxArt = stagedClone.artifacts[0]!;
    expect(xlsxArt.filename).toBe('Canonical Test Workbook.xlsx');
    expect(xlsxArt.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const xlsxBytes = asBytes(xlsxArt.data);
    expect(xlsxArt.byteLength).toBe(xlsxBytes.byteLength);

    const wb = XLSX.read(Buffer.from(xlsxBytes.buffer, xlsxBytes.byteOffset, xlsxBytes.byteLength), {
      type: 'buffer'
    });
    expect(wb.SheetNames).toEqual(['SparseTab']);
    const ws = wb.Sheets['SparseTab']!;
    expect(ws['A1']?.v).toBe('xlsx_val_A1');
    expect(ws['B2']?.v).toBe(789);
    expect(ws['A1']?.t).toBe('s');
    expect(ws['B2']?.t).toBe('n');
    expect(ws['A1']?.f).toBeUndefined();
    expect(ws['B2']?.f).toBeUndefined();
    expect(ws['A2']).toBeUndefined();
    expect(ws['B1']).toBeUndefined();

    // Companion metadata
    const metaArt = stagedClone.artifacts[1]!;
    expect(metaArt.filename).toBe('Canonical Test Workbook.metadata.json');
    expect(metaArt.mimeType).toBe('application/json');
    const metaBytes = asBytes(metaArt.data);
    expect(metaArt.byteLength).toBe(metaBytes.byteLength);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes));
    expect(meta.export.format).toBe('xlsx');
    expect(meta.source.id).toBe(CANONICAL_SPREADSHEET_ID);
  });

  it('cancellation and session close: no stage, empty transfer, exact envelopes without percent or raw error leak', async () => {
    const { host, emissions } = createHarness();
    const jobId = 'job_cancel_01';
    const context = makeSmallContext('json', signal);

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'BEGIN',
      context
    });

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'CANCEL'
    });

    expect(emissions).toHaveLength(2);

    const ack = emissions[0]!;
    expect(ack.response.type).toBe('ACK');
    expect(ack.transfer).toEqual([]);

    const cancelled = emissions[1]!;
    expect(cancelled.response.type).toBe('CANCELLED');
    expect(cancelled.transfer).toEqual([]);
    expect(cancelled.response).toEqual({
      protocolVersion: 1,
      jobId,
      generation: 1,
      type: 'CANCELLED'
    });
    expect('percent' in cancelled.response).toBe(false);
    expect('message' in cancelled.response).toBe(false);
    expect('stack' in cancelled.response).toBe(false);

    // Close session permanently: further commands ignored, no staged artifacts
    await host.close();

    await host.handle({
      protocolVersion: 1,
      jobId: 'job_new',
      generation: 2,
      type: 'BEGIN',
      context
    });

    expect(emissions).toHaveLength(2);
  });

  it('stale generation and malformed inputs: drops stale, fails malformed with sanitized ERROR code and no stage', async () => {
    const { host, emissions } = createHarness();
    const jobId = 'job_stale_01';
    const context = makeSmallContext('json', signal);

    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 5,
      type: 'BEGIN',
      context
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]!.response.type).toBe('ACK');

    // Stale generation BEGIN ignored
    await host.handle({
      protocolVersion: 1,
      jobId: 'job_old',
      generation: 3,
      type: 'BEGIN',
      context
    });
    expect(emissions).toHaveLength(1);

    // Stale generation APPEND ignored
    const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, [], jobId);
    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 4,
      type: 'APPEND',
      chunk
    });
    expect(emissions).toHaveLength(1);

    // Malformed chunk (chunk.jobId mismatch) emits safe ERROR code with empty transfer
    const mismatchedChunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, [], 'job_mismatch');
    await host.handle({
      protocolVersion: 1,
      jobId,
      generation: 5,
      type: 'APPEND',
      chunk: mismatchedChunk
    });

    expect(emissions).toHaveLength(2);
    const errorEmission = emissions[1]!;
    expect(errorEmission.response.type).toBe('ERROR');
    expect(errorEmission.transfer).toEqual([]);
    expect(errorEmission.response).toEqual({
      protocolVersion: 1,
      jobId,
      generation: 5,
      type: 'ERROR',
      code: 'FORMAT_SERIALIZATION_FAILED'
    });

    // Verify error envelope does not leak raw exception, stack, cause, or tokens
    const errResp = errorEmission.response;
    expect('message' in errResp).toBe(false);
    expect('stack' in errResp).toBe(false);
    expect('cause' in errResp).toBe(false);
    expect('body' in errResp).toBe(false);
    expect('token' in errResp).toBe(false);
  });

  it('guards post callback parameter and ensures independent host instances', async () => {
    expect(() => createWorkerHost(null as unknown as () => void)).toThrow(DomainError);
    expect(() => createWorkerHost(undefined as unknown as () => void)).toThrow(DomainError);
    expect(() => createWorkerHost(42 as unknown as () => void)).toThrow(DomainError);

    // Two host instances operate independently
    const h1 = createHarness();
    const h2 = createHarness();
    const ctx = makeSmallContext('json', signal);

    await h1.host.handle({
      protocolVersion: 1,
      jobId: 'job_h1',
      generation: 1,
      type: 'BEGIN',
      context: ctx
    });

    expect(h1.emissions).toHaveLength(1);
    expect(h2.emissions).toHaveLength(0);

    await h1.host.close();
    await h2.host.close();
  });
});
