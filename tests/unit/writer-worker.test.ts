/**
 * T36c2 Dedicated Production Writer Worker Entry Tests
 *
 * Verifies production writer worker wiring:
 * - Real worker host composition and real JSON writer lifecycle.
 * - Native EventTarget fake scope with actual structuredClone transfer detachment.
 * - Sequential BEGIN, APPEND, FINALIZE with event-driven resolution (no sleeps).
 * - Full JSON typed value and coordinate assertions.
 * - Malformed and stale commands are ignored.
 * - Idempotent close removes listener, suppresses late outputs, and prevents new work.
 * - Binding preservation on scope.postMessage.
 * - Environment safety: no auto-install in Node, no global leaks.
 */

import { describe, it, expect, vi } from 'vitest';

import type { Cell, ExportFormat, ExportReport, NormalizedChunk } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import type { WorkerResponse, WorkerStagedArtifactsResponse } from '../../src/contracts/messages.ts';
import { snapshotWriterContext } from '../../src/export/context.ts';
import {
  CANONICAL_SPREADSHEET_ID,
  CANONICAL_SPARSE_SHEET_ID,
  createCanonicalExportReport,
  createCanonicalWriterContext
} from '../helpers/fixtures.ts';
import {
  installWriterWorker,
  type WriterWorkerScope
} from '../../src/runtime/writer-worker.ts';

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
        rect: { sheetId: CANONICAL_SPARSE_SHEET_ID, r0: 0, c0: 0, r1: 3, c1: 2 }
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
        rows: 3,
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
    rect: { sheetId, r0: 0, c0: 0, r1: 3, c1: 2 },
    cells,
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 64
  };
}

interface PostedRecord {
  readonly message: WorkerResponse;
  readonly transfer: Transferable[];
  readonly senderBuffersDetached: boolean[];
}

class FakeWorkerScope implements WriterWorkerScope {
  private readonly target = new EventTarget();
  readonly posted: PostedRecord[] = [];
  removeEventListenerCalls = 0;
  private messageWaiters: Array<(record: PostedRecord) => void> = [];

  postMessage(message: WorkerResponse, transfer: Transferable[]): void {
    if (!(this instanceof FakeWorkerScope)) {
      throw new TypeError('Illegal invocation: postMessage called without scope binding');
    }

    // Capture buffers before transfer to check sender detachment after structuredClone
    const buffersBefore = transfer.filter((t): t is ArrayBuffer => t instanceof ArrayBuffer);

    // Native structuredClone with transfer list simulates dedicated worker postMessage
    const cloned = structuredClone(message, { transfer: [...transfer] });

    // Validate actual detachment of sender buffers
    const senderBuffersDetached = buffersBefore.map((b) => b.byteLength === 0);

    const record: PostedRecord = {
      message: cloned as WorkerResponse,
      transfer,
      senderBuffersDetached
    };

    this.posted.push(record);

    const pending = this.messageWaiters.splice(0, this.messageWaiters.length);
    for (const waiter of pending) {
      waiter(record);
    }
  }

  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void
  ): void {
    this.target.addEventListener(type, listener as EventListener);
  }

  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void
  ): void {
    this.removeEventListenerCalls++;
    this.target.removeEventListener(type, listener as EventListener);
  }

  waitForNextMessage(): Promise<PostedRecord> {
    return new Promise<PostedRecord>((resolve) => {
      this.messageWaiters.push(resolve);
    });
  }

  dispatchCommand(command: unknown): void {
    this.target.dispatchEvent(new MessageEvent('message', { data: command }));
  }
}

describe('T36c2 Dedicated Production Writer Worker Entry', () => {
  it('executes sequential BEGIN, APPEND, FINALIZE with event-driven resolution and checks full JSON typed values and coordinates', async () => {
    const scope = new FakeWorkerScope();
    const worker = installWriterWorker(scope);

    const jobId = 'job-prod-001';
    const generation = 1;
    const controller = new AbortController();
    const context = makeSmallContext('json', controller.signal);
    const report = makeReportForContext(context, 'json');

    // 1. Dispatch BEGIN and await ACK begin
    const nextMsg1 = scope.waitForNextMessage();
    scope.dispatchCommand({
      protocolVersion: 1,
      jobId,
      generation,
      type: 'BEGIN',
      context
    });
    const rec1 = await nextMsg1;
    expect(rec1.transfer).toEqual([]);
    expect(rec1.message).toEqual({
      protocolVersion: 1,
      jobId,
      generation,
      type: 'ACK',
      phase: 'begin'
    });

    // 2. Dispatch APPEND with typed cells at explicit coordinates and await ACK append
    const cells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: 'production_A1' },
      { r: 1, c: 1, kind: 'number', value: 42.75 },
      { r: 2, c: 0, kind: 'boolean', value: true }
    ];
    const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells, jobId);

    const nextMsg2 = scope.waitForNextMessage();
    scope.dispatchCommand({
      protocolVersion: 1,
      jobId,
      generation,
      type: 'APPEND',
      chunk
    });
    const rec2 = await nextMsg2;
    expect(rec2.transfer).toEqual([]);
    expect(rec2.message).toEqual({
      protocolVersion: 1,
      jobId,
      generation,
      type: 'ACK',
      phase: 'append',
      chunksCompleted: 1
    });

    // 3. Dispatch FINALIZE and await PROGRESS (serializing) then STAGED_ARTIFACTS
    const nextMsg3 = scope.waitForNextMessage();
    const nextMsg4Promise = (async () => {
      await nextMsg3;
      return scope.waitForNextMessage();
    })();

    scope.dispatchCommand({
      protocolVersion: 1,
      jobId,
      generation,
      type: 'FINALIZE',
      report
    });

    const rec3 = await nextMsg3;
    expect(rec3.transfer).toEqual([]);
    expect(rec3.message).toEqual({
      protocolVersion: 1,
      jobId,
      generation,
      type: 'PROGRESS',
      phase: 'serializing',
      chunksCompleted: 1
    });

    const rec4 = await nextMsg4Promise;
    expect(rec4.message.type).toBe('STAGED_ARTIFACTS');
    const staged = rec4.message as WorkerStagedArtifactsResponse;
    expect(staged.protocolVersion).toBe(1);
    expect(staged.jobId).toBe(jobId);
    expect(staged.generation).toBe(generation);
    expect(staged.artifacts).toHaveLength(1);

    // Assert transferable detachment: transfer list contained the ArrayBuffer,
    // and sender buffer is detached (byteLength === 0)
    expect(rec4.transfer).toHaveLength(1);
    expect(rec4.transfer[0] instanceof ArrayBuffer).toBe(true);
    expect(rec4.senderBuffersDetached).toEqual([true]);

    // Full JSON content, typed values and coordinates check
    const art = staged.artifacts[0]!;
    expect(art.filename).toBe('Canonical Test Workbook.json');
    expect(art.mimeType).toBe('application/json');
    expect(art.data instanceof Uint8Array).toBe(true);

    const u8 = art.data as Uint8Array;
    expect(art.byteLength).toBe(u8.byteLength);
    const parsed = JSON.parse(new TextDecoder().decode(u8));

    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.source.id).toBe(CANONICAL_SPREADSHEET_ID);
    expect(parsed.sheets).toHaveLength(1);
    expect(parsed.sheets[0]!.title).toBe('SparseTab');
    expect(parsed.sheets[0]!.cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: 'production_A1' },
      { r: 1, c: 1, kind: 'number', value: 42.75 },
      { r: 2, c: 0, kind: 'boolean', value: true }
    ]);

    await worker.close();
  });

  it('ignores malformed and stale commands deterministically without arbitrary sleeps', async () => {
    const scope = new FakeWorkerScope();
    const worker = installWriterWorker(scope);

    const controller = new AbortController();
    const context = makeSmallContext('json', controller.signal);

    // 1. Establish generation 2
    const nextMsg1 = scope.waitForNextMessage();
    scope.dispatchCommand({
      protocolVersion: 1,
      jobId: 'job-002',
      generation: 2,
      type: 'BEGIN',
      context
    });
    const rec1 = await nextMsg1;
    expect(rec1.message.type).toBe('ACK');
    expect(rec1.message.generation).toBe(2);
    expect(scope.posted).toHaveLength(1);

    // 2. Dispatch multiple malformed commands and stale commands:
    // - Not an object / null
    scope.dispatchCommand(null);
    scope.dispatchCommand('string_command');
    scope.dispatchCommand(42);
    // - Unknown command type
    scope.dispatchCommand({ protocolVersion: 1, jobId: 'job-002', generation: 2, type: 'PING' });
    scope.dispatchCommand({ protocolVersion: 1, jobId: 'job-002', generation: 2, type: 'UNKNOWN_TYPE' });
    // - Missing protocolVersion
    scope.dispatchCommand({ jobId: 'job-002', generation: 3, type: 'CANCEL' });
    // - Extra invalid property on envelope
    scope.dispatchCommand({ protocolVersion: 1, jobId: 'job-002', generation: 3, type: 'CANCEL', extra: true });
    // - Stale generation (generation 1 <= 2)
    scope.dispatchCommand({
      protocolVersion: 1,
      jobId: 'job-001',
      generation: 1,
      type: 'BEGIN',
      context
    });
    // - Stale generation matching current watermark (generation 2 <= 2)
    scope.dispatchCommand({
      protocolVersion: 1,
      jobId: 'job-002-stale',
      generation: 2,
      type: 'BEGIN',
      context
    });
    // - Non-matching jobId on APPEND
    scope.dispatchCommand({
      protocolVersion: 1,
      jobId: 'wrong-job-id',
      generation: 2,
      type: 'APPEND',
      chunk: makeChunk(CANONICAL_SPARSE_SHEET_ID, [], 'wrong-job-id')
    });
    // - Non-matching generation on APPEND
    scope.dispatchCommand({
      protocolVersion: 1,
      jobId: 'job-002',
      generation: 1,
      type: 'APPEND',
      chunk: makeChunk(CANONICAL_SPARSE_SHEET_ID, [], 'job-002')
    });
    // - Non-matching jobId on CANCEL
    scope.dispatchCommand({
      protocolVersion: 1,
      jobId: 'wrong-job-id',
      generation: 2,
      type: 'CANCEL'
    });
    // - Non-matching generation on CANCEL
    scope.dispatchCommand({
      protocolVersion: 1,
      jobId: 'job-002',
      generation: 1,
      type: 'CANCEL'
    });

    // 3. Dispatch a valid subsequent command: CANCEL for active job-002
    const nextMsg2 = scope.waitForNextMessage();
    scope.dispatchCommand({
      protocolVersion: 1,
      jobId: 'job-002',
      generation: 2,
      type: 'CANCEL'
    });
    const rec2 = await nextMsg2;

    // The very next message emitted MUST be the CANCELLED response for the valid command.
    // If any malformed or stale command produced output, posted length would exceed 2.
    expect(rec2.message).toEqual({
      protocolVersion: 1,
      jobId: 'job-002',
      generation: 2,
      type: 'CANCELLED'
    });
    expect(scope.posted).toHaveLength(2);

    await worker.close();
  });

  it('close is idempotent, removes listener, and prevents subsequent output or work', async () => {
    const scope = new FakeWorkerScope();
    const worker = installWriterWorker(scope);

    expect(scope.removeEventListenerCalls).toBe(0);

    // Calling close multiple times concurrently and sequentially
    const p1 = worker.close();
    const p2 = worker.close();
    expect(p1).toBe(p2); // Idempotent: returns identical active promise

    await Promise.all([p1, p2]);
    const p3 = worker.close();
    expect(p3).toBe(p1); // Still returns the same promise
    await p3;

    // Listener was removed exactly once
    expect(scope.removeEventListenerCalls).toBe(1);

    // Dispatching a command after close produces no outputs and no errors
    const controller = new AbortController();
    const context = makeSmallContext('json', controller.signal);

    scope.dispatchCommand({
      protocolVersion: 1,
      jobId: 'job-after-close',
      generation: 10,
      type: 'BEGIN',
      context
    });

    expect(scope.posted).toHaveLength(0);
  });

  it('closed fence suppresses late output when closed during pending work', async () => {
    const scope = new FakeWorkerScope();
    const worker = installWriterWorker(scope);

    const controller = new AbortController();
    const context = makeSmallContext('json', controller.signal);

    // Dispatch BEGIN, but close immediately synchronously before microtasks settle
    scope.dispatchCommand({
      protocolVersion: 1,
      jobId: 'job-pending-close',
      generation: 1,
      type: 'BEGIN',
      context
    });

    // Synchronously initiate close
    const closePromise = worker.close();
    await closePromise;

    // No late outputs were delivered to scope.postMessage due to closed fence
    expect(scope.posted).toHaveLength(0);
  });

  it('preserves scope binding on postMessage calls', async () => {
    let capturedThis: unknown = null;
    let resolvePost: () => void = () => {};
    const postedPromise = new Promise<void>((resolve) => {
      resolvePost = resolve;
    });

    const mockScope: WriterWorkerScope = {
      postMessage: function (this: unknown, _message: WorkerResponse, _transfer: Transferable[]) {
        capturedThis = this;
        resolvePost();
      },
      addEventListener: (_type: 'message', listener: (event: MessageEvent<unknown>) => void) => {
        // Trigger a valid command to verify binding during post
        const controller = new AbortController();
        const context = makeSmallContext('json', controller.signal);
        void listener(
          new MessageEvent('message', {
            data: {
              protocolVersion: 1,
              jobId: 'job-binding',
              generation: 1,
              type: 'BEGIN',
              context
            }
          })
        );
      },
      removeEventListener: () => {}
    };

    const worker = installWriterWorker(mockScope);
    await postedPromise;

    expect(capturedThis).toBe(mockScope);
    await worker.close();
  });

  it('installs only for worker-like globals, with no listener in a window or Node', async () => {
    const add = vi.fn();
    try {
      vi.stubGlobal('document', undefined);
      vi.stubGlobal('postMessage', undefined);
      vi.stubGlobal('addEventListener', add);
      vi.stubGlobal('removeEventListener', vi.fn());
      vi.resetModules();
      await import('../../src/runtime/writer-worker.ts');
      expect(add).not.toHaveBeenCalled();

      vi.stubGlobal('postMessage', vi.fn());
      vi.stubGlobal('document', {});
      vi.resetModules();
      await import('../../src/runtime/writer-worker.ts');
      expect(add).not.toHaveBeenCalled();

      vi.stubGlobal('document', undefined);
      vi.resetModules();
      await import('../../src/runtime/writer-worker.ts');
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith('message', expect.any(Function));
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
