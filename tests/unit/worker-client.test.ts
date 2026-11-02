import { describe, it, expect, vi } from 'vitest';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';

import type { Cell, ExportFormat, ExportReport, NormalizedChunk } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { snapshotWriterContext } from '../../src/export/context.ts';
import { createWorkerHost } from '../../src/runtime/worker-host.ts';
import {
  createWorkerWriterClient,
  type WorkerEndpoint,
} from '../../src/runtime/worker-client.ts';
import {
  CANONICAL_SPARSE_SHEET_ID,
  createCanonicalExportReport,
  createCanonicalWriterContext,
} from '../helpers/fixtures.ts';

class FakeWorker implements WorkerEndpoint {
  private listeners: {
    message: Set<EventListenerOrEventListenerObject>;
    error: Set<EventListenerOrEventListenerObject>;
    messageerror: Set<EventListenerOrEventListenerObject>;
  } = {
    message: new Set(),
    error: new Set(),
    messageerror: new Set(),
  };

  public terminated = false;
  public terminateCalls = 0;
  public postMessageCalls: any[] = [];
  public customPostMessage?: (
    message: any,
    transferOrOptions?: Transferable[] | StructuredSerializeOptions
  ) => void;

  postMessage(message: any, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
    this.postMessageCalls.push(message);
    if (this.customPostMessage) {
      this.customPostMessage(message, transferOrOptions);
    }
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    _options?: boolean | AddEventListenerOptions
  ): void {
    if (type === 'message' || type === 'error' || type === 'messageerror') {
      this.listeners[type].add(listener);
    }
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    _options?: boolean | EventListenerOptions
  ): void {
    if (type === 'message' || type === 'error' || type === 'messageerror') {
      this.listeners[type].delete(listener);
    }
  }

  terminate(): void {
    this.terminated = true;
    this.terminateCalls++;
  }

  emitMessage(data: any): void {
    for (const listener of Array.from(this.listeners.message)) {
      if (typeof listener === 'function') {
        listener({ data } as MessageEvent);
      } else if (listener && typeof listener.handleEvent === 'function') {
        listener.handleEvent({ data } as MessageEvent);
      }
    }
  }

  emitError(event: any): void {
    for (const listener of Array.from(this.listeners.error)) {
      if (typeof listener === 'function') {
        listener(event);
      } else if (listener && typeof listener.handleEvent === 'function') {
        listener.handleEvent(event);
      }
    }
  }

  emitMessageError(event: any): void {
    for (const listener of Array.from(this.listeners.messageerror)) {
      if (typeof listener === 'function') {
        listener(event);
      } else if (listener && typeof listener.handleEvent === 'function') {
        listener.handleEvent(event);
      }
    }
  }

  listenerCount(type: 'message' | 'error' | 'messageerror'): number {
    return this.listeners[type].size;
  }
}

function makeContext(format: ExportFormat, signal: AbortSignal): WriterContext {
  const base = createCanonicalWriterContext();
  const rawContext: WriterContext = {
    sourceId: base.sourceId,
    title: base.title,
    locale: base.locale,
    timeZone: base.timeZone,
    scopes: [
      {
        sheetId: CANONICAL_SPARSE_SHEET_ID,
        rect: { sheetId: CANONICAL_SPARSE_SHEET_ID, r0: 0, c0: 0, r1: 2, c1: 2 },
      },
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
        columns: 2,
      },
    ],
  };

  return snapshotWriterContext(rawContext, {
    maxSheets: 10,
    signal,
  });
}

function makeReport(context: WriterContext, format: ExportFormat): ExportReport {
  const base = createCanonicalExportReport();
  return {
    schemaVersion: '1.0',
    source: {
      id: context.sourceId,
      title: context.title,
      locale: context.locale,
      timeZone: context.timeZone,
    },
    export: {
      startedAt: base.export.startedAt,
      producedAt: base.export.producedAt,
      mode: context.mode,
      format,
      visibility: context.visibility,
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: [],
    },
    selectedScopes: context.scopes,
    sheetOrder: context.sheetOrder,
    limitsVersion: context.limitsVersion,
    nameMappings: context.sheetOrder.map((sheetId) => {
      const sheet = context.sheets.find((s) => s.id === sheetId)!;
      return {
        sheetId: sheet.id,
        originalTitle: sheet.title,
        exportedName: format === 'xlsx' ? sheet.title : format === 'csv' ? `${sheet.title}.csv` : sheet.title,
      };
    }),
    exclusions: [],
  };
}

function makeChunk(sheetId: number, cells: Cell[], jobId: string): NormalizedChunk {
  return {
    jobId,
    chunkId: `chunk_${sheetId}`,
    rect: { sheetId, r0: 0, c0: 0, r1: 2, c1: 2 },
    cells,
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 64,
  };
}

describe('T36d1 Worker Writer Client', () => {
  it('rebuilds a mutated CONFIG_INVALID error instead of exposing its message or fields', () => {
    const worker = new FakeWorker();
    const original = new DomainError('CONFIG_INVALID');
    original.message = 'private configuration diagnostic';
    Object.assign(original, { privateField: 'private token fixture' });
    let thrown: unknown;
    try {
      createWorkerWriterClient({ worker, get jobId(): string { throw original; }, generation: 0,
        timeoutMs: 1000, maxBytes: 1024 });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).not.toBe(original);
    expect((thrown as DomainError).message).toBe(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
    expect(Object.hasOwn(thrown as object, 'privateField')).toBe(false);
    expect(worker.listenerCount('message')).toBe(0);
    const { proxy, revoke } = Proxy.revocable({ worker, jobId: 'revoked', generation: 0, timeoutMs: 1000, maxBytes: 1024 }, {});
    revoke();
    expect(() => createWorkerWriterClient(proxy)).toThrowError(expect.objectContaining({
      code: 'CONFIG_INVALID', message: SAFE_ERROR_MESSAGES.CONFIG_INVALID
    }));
  });

  it('does not inspect a thrown signal error and always settles with a static configuration error', async () => {
    const worker = new FakeWorker();
    const client = createWorkerWriterClient({ worker, jobId: 'signal-static', generation: 0, timeoutMs: 1000, maxBytes: 1024 });
    const sourceError = new DomainError('CONFIG_INVALID');
    let codeReads = 0;
    Object.defineProperty(sourceError, 'code', { get() { codeReads++; throw new Error('private error diagnostic'); } });
    const signal = { get aborted(): boolean { throw sourceError; }, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
    let pending: Promise<void> | undefined;
    expect(() => { pending = client.begin(makeContext('json', new AbortController().signal), signal); }).not.toThrow();
    await expect(pending).rejects.toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID', message: SAFE_ERROR_MESSAGES.CONFIG_INVALID }));
    expect(codeReads).toBe(0);
    expect(worker.postMessageCalls).toEqual([]);
    expect(worker.terminated).toBe(true);
  });
  const defaultSignal = new AbortController().signal;

  describe('1. Constructor options validation', () => {
    it('rejects invalid configuration with static CONFIG_INVALID before adopting worker', () => {
      const worker = new FakeWorker();

      const invalidOptions: any[] = [
        null,
        undefined,
        [],
        'string',
        { worker, jobId: '', generation: 0, timeoutMs: 5000, maxBytes: 1024 }, // empty jobId
        { worker, jobId: 'job1', generation: -1, timeoutMs: 5000, maxBytes: 1024 }, // negative generation
        { worker, jobId: 'job1', generation: -0, timeoutMs: 5000, maxBytes: 1024 }, // -0 generation
        { worker, jobId: 'job1', generation: 1.5, timeoutMs: 5000, maxBytes: 1024 }, // float generation
        { worker, jobId: 'job1', generation: 0, timeoutMs: 0, maxBytes: 1024 }, // timeoutMs < 1
        { worker, jobId: 'job1', generation: 0, timeoutMs: 600001, maxBytes: 1024 }, // timeoutMs > 600000
        { worker, jobId: 'job1', generation: 0, timeoutMs: -0, maxBytes: 1024 }, // -0 timeoutMs
        { worker, jobId: 'job1', generation: 0, timeoutMs: 5000, maxBytes: -1 }, // negative maxBytes
        { worker, jobId: 'job1', generation: 0, timeoutMs: 5000, maxBytes: -0 }, // -0 maxBytes
        { worker, jobId: 'job1', generation: 0, timeoutMs: 5000, maxBytes: 64 * 1024 * 1024 + 1 }, // maxBytes > 64MiB
        { worker, jobId: 'job1', generation: 0, timeoutMs: 5000, maxBytes: 1024, onProgress: 'not-a-fn' }, // bad onProgress
        { worker: null, jobId: 'job1', generation: 0, timeoutMs: 5000, maxBytes: 1024 }, // null worker
        { worker: {}, jobId: 'job1', generation: 0, timeoutMs: 5000, maxBytes: 1024 }, // incomplete worker
      ];

      for (const opt of invalidOptions) {
        expect(() => createWorkerWriterClient(opt)).toThrowError(
          expect.objectContaining({ code: 'CONFIG_INVALID' })
        );
      }

      // Worker was not adopted: zero listeners registered
      expect(worker.listenerCount('message')).toBe(0);
      expect(worker.listenerCount('error')).toBe(0);
      expect(worker.listenerCount('messageerror')).toBe(0);
    });

    it('rejects options with throwing getter or revoked Proxy with static CONFIG_INVALID without adopting worker', () => {
      const worker = new FakeWorker();
      const throwingOptions = {
        worker,
        get jobId(): string {
          throw new Error('hostile getter detonation');
        },
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      };
      expect(() => createWorkerWriterClient(throwingOptions as any)).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(worker.listenerCount('message')).toBe(0);
      expect(worker.listenerCount('error')).toBe(0);
      expect(worker.listenerCount('messageerror')).toBe(0);
    });

    it('returns frozen WriterPort on valid configuration and installs 3 listeners', () => {
      const worker = new FakeWorker();
      const client = createWorkerWriterClient({
        worker,
        jobId: 'job_ok',
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      expect(Object.isFrozen(client)).toBe(true);
      expect(typeof client.begin).toBe('function');
      expect(typeof client.append).toBe('function');
      expect(typeof client.finalize).toBe('function');
      expect(typeof client.abort).toBe('function');

      expect(worker.listenerCount('message')).toBe(1);
      expect(worker.listenerCount('error')).toBe(1);
      expect(worker.listenerCount('messageerror')).toBe(1);
    });
  });

  describe('2. Real host loopback with structuredClone and transfer list', () => {
    it('executes full begin/append/finalize roundtrip against actual WorkerHost with typed value oracle', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_real_01';

      const host = createWorkerHost((response, transfer) => {
        const cloned = structuredClone(response, { transfer });
        queueMicrotask(() => {
          worker.emitMessage(cloned);
        });
      });

      worker.customPostMessage = (message) => {
        const cloned = structuredClone(message);
        queueMicrotask(() => {
          void host.handle(cloned);
        });
      };

      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 1,
        timeoutMs: 10000,
        maxBytes: 64 * 1024 * 1024,
      });

      const context = makeContext('json', defaultSignal);
      const cells: Cell[] = [
        { r: 0, c: 0, kind: 'string', value: '00123' },
        { r: 1, c: 1, kind: 'number', value: 456 },
      ];
      const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells, jobId);
      const report = makeReport(context, 'json');

      await client.begin(context, defaultSignal);
      await client.append(chunk, defaultSignal);
      const artifacts = await client.finalize(report, defaultSignal);

      expect(artifacts).toHaveLength(1);
      const doc = JSON.parse(new TextDecoder().decode(artifacts[0]!.data as Uint8Array));
      expect(doc.schemaVersion).toBe('1.0');
      expect(doc.source.id).toBe(context.sourceId);
      expect(doc.sheets[0].title).toBe('SparseTab');
      expect(doc.sheets[0].cells).toEqual([
        { r: 0, c: 0, kind: 'string', value: '00123' },
        { r: 1, c: 1, kind: 'number', value: 456 },
      ]);

      // Lifecycle terminal after successful finalize: worker terminated, listeners cleared
      expect(worker.terminated).toBe(true);
      expect(worker.terminateCalls).toBe(1);
      expect(worker.listenerCount('message')).toBe(0);
      expect(worker.listenerCount('error')).toBe(0);
      expect(worker.listenerCount('messageerror')).toBe(0);

      // Later operations reject with INTERNAL_ERROR
      await expect(client.begin(context, defaultSignal)).rejects.toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
      await expect(client.append(chunk, defaultSignal)).rejects.toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
      await expect(client.finalize(report, defaultSignal)).rejects.toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
    });
  });

  describe('3. Outgoing projection: no auth or unknown fields before post', () => {
    it('projects clean protocolVersion 1 envelopes with exact known keys for all 3 operations', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_proj_01';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 2,
        timeoutMs: 5000,
        maxBytes: 1024 * 1024,
      });

      const context = makeContext('json', defaultSignal);
      const cells: Cell[] = [{ r: 0, c: 0, kind: 'string', value: 'test' }];
      const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells, jobId);
      const report = makeReport(context, 'json');

      // 1. BEGIN
      const beginPromise = client.begin(context, defaultSignal);
      expect(worker.postMessageCalls).toHaveLength(1);
      const beginMsg = worker.postMessageCalls[0];
      expect(Object.keys(beginMsg).sort()).toEqual(['context', 'generation', 'jobId', 'protocolVersion', 'type'].sort());
      expect(beginMsg.protocolVersion).toBe(1);
      expect(beginMsg.jobId).toBe(jobId);
      expect(beginMsg.generation).toBe(2);
      expect(beginMsg.type).toBe('BEGIN');
      expect((beginMsg as any).token).toBeUndefined();
      expect((beginMsg as any).principalKey).toBeUndefined();

      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 2,
        type: 'ACK',
        phase: 'begin',
      });
      await beginPromise;

      // 2. APPEND
      const appendPromise = client.append(chunk, defaultSignal);
      expect(worker.postMessageCalls).toHaveLength(2);
      const appendMsg = worker.postMessageCalls[1];
      expect(Object.keys(appendMsg).sort()).toEqual(['chunk', 'generation', 'jobId', 'protocolVersion', 'type'].sort());
      expect(appendMsg.protocolVersion).toBe(1);
      expect(appendMsg.jobId).toBe(jobId);
      expect(appendMsg.generation).toBe(2);
      expect(appendMsg.type).toBe('APPEND');
      expect(appendMsg.chunk.jobId).toBe(jobId);

      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 2,
        type: 'ACK',
        phase: 'append',
        chunksCompleted: 1,
      });
      await appendPromise;

      // 3. FINALIZE
      const finalizePromise = client.finalize(report, defaultSignal);
      expect(worker.postMessageCalls).toHaveLength(3);
      const finalizeMsg = worker.postMessageCalls[2];
      expect(Object.keys(finalizeMsg).sort()).toEqual(['generation', 'jobId', 'protocolVersion', 'report', 'type'].sort());
      expect(finalizeMsg.protocolVersion).toBe(1);
      expect(finalizeMsg.jobId).toBe(jobId);
      expect(finalizeMsg.generation).toBe(2);
      expect(finalizeMsg.type).toBe('FINALIZE');

      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 2,
        type: 'STAGED_ARTIFACTS',
        artifacts: [
          {
            filename: 'out.json',
            mimeType: 'application/json',
            data: new Uint8Array([1, 2, 3]),
            byteLength: 3,
            safeSummary: 'summary',
          },
        ],
      });
      const artifacts = await finalizePromise;
      expect(artifacts).toHaveLength(1);
    });
  });

  describe('4. Begin/append/finalize correlation and real counters', () => {
    it('correlates multi-chunk sequential appends and emits progress on finalize', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_count_01';
      const progressEmissions: any[] = [];

      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024 * 1024,
        onProgress: (p) => progressEmissions.push(p),
      });

      const context = makeContext('json', defaultSignal);
      const chunk1 = makeChunk(CANONICAL_SPARSE_SHEET_ID, [{ r: 0, c: 0, kind: 'string', value: 'c1' }], jobId);
      const chunk2 = makeChunk(CANONICAL_SPARSE_SHEET_ID, [{ r: 1, c: 1, kind: 'string', value: 'c2' }], jobId);
      const report = makeReport(context, 'json');

      const beginPromise = client.begin(context, defaultSignal);
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'begin' });
      await beginPromise;

      const append1 = client.append(chunk1, defaultSignal);
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'append', chunksCompleted: 1 });
      await append1;

      const append2 = client.append(chunk2, defaultSignal);
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'append', chunksCompleted: 2 });
      await append2;

      const finalizePromise = client.finalize(report, defaultSignal);
      // Progress emitted during finalize with matching acked count 2
      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'PROGRESS',
        phase: 'serializing',
        chunksCompleted: 2,
        totalChunks: 2,
      });

      expect(progressEmissions).toEqual([
        { phase: 'serializing', chunksCompleted: 2, totalChunks: 2 },
      ]);
      expect(Object.isFrozen(progressEmissions[0])).toBe(true);

      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'STAGED_ARTIFACTS',
        artifacts: [
          {
            filename: 'out.json',
            mimeType: 'application/json',
            data: new Uint8Array([1]),
            byteLength: 1,
            safeSummary: 's',
          },
        ],
      });
      await finalizePromise;
    });
  });

  describe('5. Malformed, stale, and unexpected replies ignored', () => {
    it('ignores invalid messages, stale jobId/generation, and unexpected phases without settling', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_stale_01';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 5,
        timeoutMs: 5000,
        maxBytes: 1024 * 1024,
      });

      const context = makeContext('json', defaultSignal);
      const beginPromise = client.begin(context, defaultSignal);

      // Malformed replies
      worker.emitMessage(null);
      worker.emitMessage({});
      worker.emitMessage({ protocolVersion: 2, jobId, generation: 5, type: 'ACK' });
      worker.emitMessage('raw text');

      // Stale jobId or generation
      worker.emitMessage({ protocolVersion: 1, jobId: 'other_job', generation: 5, type: 'ACK', phase: 'begin' });
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 4, type: 'ACK', phase: 'begin' });
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 6, type: 'ACK', phase: 'begin' });

      // Unexpected phase ACK (expecting begin)
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 5, type: 'ACK', phase: 'append', chunksCompleted: 1 });
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 5, type: 'ACK' }); // missing phase

      // Progress and staged artifacts ignored when pending begin
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 5, type: 'PROGRESS', phase: 'begin', chunksCompleted: 0 });
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 5, type: 'STAGED_ARTIFACTS', artifacts: [] });

      // Ensure operation has NOT settled or crashed
      expect(worker.terminated).toBe(false);

      // Now deliver expected begin ACK
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 5, type: 'ACK', phase: 'begin' });
      await expect(beginPromise).resolves.toBeUndefined();
    });
  });

  describe('6. Wrong counter, bad artifacts, and static errors', () => {
    it('fails closed with INTERNAL_ERROR on mismatched append counter', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_bad_counter';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024 * 1024,
      });

      const context = makeContext('json', defaultSignal);
      const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, [], jobId);

      const b = client.begin(context, defaultSignal);
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'begin' });
      await b;

      const appendPromise = client.append(chunk, defaultSignal);
      // Expected chunksCompleted 1, worker sends 2
      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'ACK',
        phase: 'append',
        chunksCompleted: 2,
      });

      await expect(appendPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
      expect(worker.terminated).toBe(true);
    });

    it('fails closed with FORMAT_SERIALIZATION_FAILED on invalid staged artifacts', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_bad_artifacts';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 10,
      });

      const context = makeContext('json', defaultSignal);
      const report = makeReport(context, 'json');

      const b = client.begin(context, defaultSignal);
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'begin' });
      await b;

      const finalizePromise = client.finalize(report, defaultSignal);
      // Send artifact that exceeds maxBytes (10 bytes limit vs 50 bytes)
      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'STAGED_ARTIFACTS',
        artifacts: [
          {
            filename: 'out.json',
            mimeType: 'application/json',
            data: new Uint8Array(50),
            byteLength: 50,
            safeSummary: 's',
          },
        ],
      });

      await expect(finalizePromise).rejects.toThrowError(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
      expect(worker.terminated).toBe(true);
    });

    it('handles worker ERROR with exact catalog code and CANCELLED as OPERATION_ABORTED', async () => {
      const worker1 = new FakeWorker();
      const client1 = createWorkerWriterClient({
        worker: worker1,
        jobId: 'job_err',
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const b1 = client1.begin(makeContext('json', defaultSignal), defaultSignal);
      worker1.emitMessage({
        protocolVersion: 1,
        jobId: 'job_err',
        generation: 0,
        type: 'ERROR',
        code: 'BYTE_LIMIT_EXCEEDED',
      });
      await expect(b1).rejects.toThrowError(
        expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' })
      );
      expect(worker1.terminated).toBe(true);

      const worker2 = new FakeWorker();
      const client2 = createWorkerWriterClient({
        worker: worker2,
        jobId: 'job_canc',
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });
      const b2 = client2.begin(makeContext('json', defaultSignal), defaultSignal);
      worker2.emitMessage({
        protocolVersion: 1,
        jobId: 'job_canc',
        generation: 0,
        type: 'CANCELLED',
      });
      await expect(b2).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
      expect(worker2.terminated).toBe(true);
    });

    it('suppresses resolution and raw handler throws if artifact descriptor trap calls client.abort() during parseWorkerArtifacts', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_trap_abort';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const context = makeContext('json', defaultSignal);
      const b = client.begin(context, defaultSignal);
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'begin' });
      await b;

      const finalizePromise = client.finalize(makeReport(context, 'json'), defaultSignal);

      const target = {
        filename: 'detonated.json',
        mimeType: 'application/json',
        data: new Uint8Array([1]),
        byteLength: 1,
        safeSummary: 'summary',
      };
      const hostileArtifact = new Proxy(target, {
        getOwnPropertyDescriptor(t, prop) {
          void client.abort();
          return Object.getOwnPropertyDescriptor(t, prop);
        },
      });

      expect(() => {
        worker.emitMessage({
          protocolVersion: 1,
          jobId,
          generation: 0,
          type: 'STAGED_ARTIFACTS',
          artifacts: [hostileArtifact],
        });
      }).not.toThrow();

      await expect(finalizePromise).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
      expect(worker.terminated).toBe(true);
    });
  });

  describe('7. Pre-abort, deferred cancel, and client.abort across all 3 phases', () => {
    it('rejects pre-aborted signal immediately and terminates worker', async () => {
      const worker = new FakeWorker();
      const client = createWorkerWriterClient({
        worker,
        jobId: 'job_preabort',
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const context = makeContext('json', defaultSignal);
      const ac = new AbortController();
      ac.abort();

      await expect(client.begin(context, ac.signal)).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
      expect(worker.terminated).toBe(true);
      expect(worker.postMessageCalls).toHaveLength(0);
    });

    it('aborts during deferred begin/append/finalize without allowing late outcomes', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_deferred_abort';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const context = makeContext('json', defaultSignal);
      const ac = new AbortController();
      const beginPromise = client.begin(context, ac.signal);

      // Abort while begin is deferred
      ac.abort();
      await expect(beginPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
      expect(worker.terminated).toBe(true);

      // Late message cannot alter outcome
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'begin' });
      await expect(client.begin(makeContext('json', defaultSignal), defaultSignal)).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
    });

    it('client.abort immediately resolves and cancels pending operation', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_abort_call';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const beginPromise = client.begin(makeContext('json', defaultSignal), defaultSignal);
      const abortPromise = client.abort();

      await expect(abortPromise).resolves.toBeUndefined();
      await expect(beginPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
      expect(worker.terminated).toBe(true);

      // Idempotent: repeated abort resolves
      await expect(client.abort()).resolves.toBeUndefined();
    });

    it('permanently preserves OPERATION_ABORTED terminal latch; late worker ERROR and crash cannot overwrite', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_latch_abort';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });
      const beginPromise = client.begin(makeContext('json', defaultSignal), defaultSignal);
      await client.abort();
      await expect(beginPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
      expect(worker.terminateCalls).toBe(1);

      // Worker sends late ERROR
      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'ERROR',
        code: 'BYTE_LIMIT_EXCEEDED',
      });
      // Worker emits error event (crash)
      worker.emitError({ preventDefault: () => {} });

      // Latched error code remains OPERATION_ABORTED, worker terminate not repeated
      await expect(client.begin(makeContext('json', defaultSignal), defaultSignal)).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
      expect(worker.terminateCalls).toBe(1);
    });

    it('permanently preserves terminal closed state after successful finalize; late ERROR and crash cannot overwrite', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_latch_success';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });
      const context = makeContext('json', defaultSignal);
      const b = client.begin(context, defaultSignal);
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'begin' });
      await b;

      const finalizePromise = client.finalize(makeReport(context, 'json'), defaultSignal);
      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'STAGED_ARTIFACTS',
        artifacts: [
          {
            filename: 'out.json',
            mimeType: 'application/json',
            data: new Uint8Array([1]),
            byteLength: 1,
            safeSummary: 's',
          },
        ],
      });
      await finalizePromise;
      expect(worker.terminateCalls).toBe(1);

      // Worker emits late ERROR and crash
      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'ERROR',
        code: 'RATE_LIMITED',
      });
      worker.emitError({ preventDefault: () => {} });

      // State remains terminal closed (INTERNAL_ERROR)
      await expect(client.finalize(makeReport(context, defaultSignal as any), defaultSignal)).rejects.toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
      expect(worker.terminateCalls).toBe(1);
    });

    it('handles removeEventListener wrapper that calls client.abort() during ACK cleanup without hanging', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_reentry_abort';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const ac = new AbortController();
      const origRemove = ac.signal.removeEventListener.bind(ac.signal);
      ac.signal.removeEventListener = function (type: string, listener: any, options?: any) {
        origRemove(type, listener, options);
        if (type === 'abort') {
          void client.abort();
        }
      };

      const context = makeContext('json', defaultSignal);
      const beginPromise = client.begin(context, ac.signal);

      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'ACK',
        phase: 'begin',
      });

      // begin promise must resolve cleanly, not hang
      await expect(beginPromise).resolves.toBeUndefined();
      expect(worker.terminated).toBe(true);

      // Client is now aborted
      await expect(client.append(makeChunk(CANONICAL_SPARSE_SHEET_ID, [], jobId), defaultSignal)).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
    });

    it('handles removeEventListener wrapper that starts next client.append() during ACK cleanup without state or timer corruption', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_reentry_append';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, [], jobId);
      let appendPromise: Promise<void> | null = null;

      const origRemove = ac1.signal.removeEventListener.bind(ac1.signal);
      ac1.signal.removeEventListener = function (type: string, listener: any, options?: any) {
        origRemove(type, listener, options);
        if (type === 'abort' && !appendPromise) {
          appendPromise = client.append(chunk, ac2.signal);
        }
      };

      const context = makeContext('json', defaultSignal);
      const beginPromise = client.begin(context, ac1.signal);

      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'ACK',
        phase: 'begin',
      });

      // begin resolves cleanly
      await expect(beginPromise).resolves.toBeUndefined();
      expect(appendPromise).not.toBeNull();
      // append message was posted to worker (2 calls total: BEGIN and APPEND)
      expect(worker.postMessageCalls).toHaveLength(2);
      expect(worker.postMessageCalls[1].type).toBe('APPEND');

      // append resolves when ACK arrives
      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'ACK',
        phase: 'append',
        chunksCompleted: 1,
      });
      await expect(appendPromise!).resolves.toBeUndefined();
    });

    it('rejects with OPERATION_ABORTED and prevents postMessage if signal addEventListener aborts client during registration', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_reg_abort';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const hostileSignal = {
        get aborted() {
          return false;
        },
        addEventListener: (type: string, _listener: any) => {
          if (type === 'abort') {
            void client.abort();
          }
        },
        removeEventListener: () => {},
      };

      const beginPromise = client.begin(makeContext('json', defaultSignal), hostileSignal as any);

      await expect(beginPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
      expect(worker.postMessageCalls).toHaveLength(0);
      expect(worker.terminated).toBe(true);
    });

    it('rejects with OPERATION_ABORTED and prevents postMessage if signal aborted getter calls client.abort()', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_getter_abort';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const hostileSignal = {
        get aborted() {
          void client.abort();
          return false;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      };

      const beginPromise = client.begin(makeContext('json', defaultSignal), hostileSignal as any);

      await expect(beginPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
      expect(worker.postMessageCalls).toHaveLength(0);
      expect(worker.terminated).toBe(true);
    });

    it('rejects with CONFIG_INVALID if signal is malformed or aborted getter throws', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_bad_signal';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const throwingSignal = {
        get aborted(): boolean {
          throw new Error('signal read failure');
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      };

      await expect(client.begin(makeContext('json', defaultSignal), throwingSignal as any)).rejects.toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(worker.terminated).toBe(true);
    });
  });

  describe('8. Timeout with fake timers and progress does not extend timer', () => {
    it('times out with FORMAT_SERIALIZATION_FAILED and progress does not extend timeout', async () => {
      vi.useFakeTimers();
      try {
        const worker = new FakeWorker();
        const jobId = 'job_timeout';
        const client = createWorkerWriterClient({
          worker,
          jobId,
          generation: 0,
          timeoutMs: 1000,
          maxBytes: 1024,
        });

        const context = makeContext('json', defaultSignal);
        const report = makeReport(context, 'json');

        const b = client.begin(context, defaultSignal);
        worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'begin' });
        await b;

        const finalizePromise = client.finalize(report, defaultSignal);

        // Advance 500ms and deliver progress
        vi.advanceTimersByTime(500);
        worker.emitMessage({
          protocolVersion: 1,
          jobId,
          generation: 0,
          type: 'PROGRESS',
          phase: 'serializing',
          chunksCompleted: 0,
        });

        // Advance another 501ms (total 1001ms from post)
        vi.advanceTimersByTime(501);

        await expect(finalizePromise).rejects.toThrowError(
          expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
        );
        expect(worker.terminated).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('9. Crash, messageerror, and synchronous post throw', () => {
    it('handles worker error event with preventDefault and FORMAT_SERIALIZATION_FAILED without leaking raw message', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_crash';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const beginPromise = client.begin(makeContext('json', defaultSignal), defaultSignal);

      let prevented = false;
      worker.emitError({
        preventDefault: () => {
          prevented = true;
        },
        message: 'secret token leaked in uncaught script error',
      });

      expect(prevented).toBe(true);
      await expect(beginPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
      expect(worker.terminated).toBe(true);
    });

    it('handles messageerror event with FORMAT_SERIALIZATION_FAILED', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_msg_err';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const beginPromise = client.begin(makeContext('json', defaultSignal), defaultSignal);
      worker.emitMessageError({});

      await expect(beginPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
      expect(worker.terminated).toBe(true);
    });

    it('handles synchronous postMessage throw with FORMAT_SERIALIZATION_FAILED', async () => {
      const worker = new FakeWorker();
      worker.postMessage = () => {
        throw new Error('DataCloneError: failed to clone');
      };

      const client = createWorkerWriterClient({
        worker,
        jobId: 'job_post_throw',
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      await expect(client.begin(makeContext('json', defaultSignal), defaultSignal)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
      expect(worker.terminated).toBe(true);
    });
  });

  describe('10. Concurrency and out-of-order calls fail closed with INTERNAL_ERROR', () => {
    it('rejects concurrent operation and terminates worker', async () => {
      const worker = new FakeWorker();
      const client = createWorkerWriterClient({
        worker,
        jobId: 'job_concurrency',
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const context = makeContext('json', defaultSignal);
      const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, [], 'job_concurrency');

      const beginPromise = client.begin(context, defaultSignal);
      // Call append while begin is in-flight
      const appendPromise = client.append(chunk, defaultSignal);

      await expect(beginPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
      await expect(appendPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
      expect(worker.terminated).toBe(true);
    });

    it('rejects out-of-order operation and fails closed', async () => {
      const worker = new FakeWorker();
      const client = createWorkerWriterClient({
        worker,
        jobId: 'job_ooo',
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, [], 'job_ooo');
      // Append called before begin
      await expect(client.append(chunk, defaultSignal)).rejects.toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
      expect(worker.terminated).toBe(true);
    });
  });

  describe('11. Snapshot reentrancy abort prevents POST', () => {
    it('prevents postMessage if property getter invokes client.abort() during context snapshot', async () => {
      const worker = new FakeWorker();
      const client = createWorkerWriterClient({
        worker,
        jobId: 'job_reentrancy',
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
      });

      const context = makeContext('json', defaultSignal);
      // Install reentrant getter on title
      let aborted = false;
      const poisonedContext = {
        ...context,
        get title() {
          void client.abort();
          aborted = true;
          return 'poisoned';
        },
      };

      const beginPromise = client.begin(poisonedContext as any, defaultSignal);

      await expect(beginPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
      expect(aborted).toBe(true);
      expect(worker.postMessageCalls).toHaveLength(0);
      expect(worker.terminated).toBe(true);
    });
  });

  describe('12. onProgress callback error or abort', () => {
    it('fails closed with INTERNAL_ERROR if onProgress throws', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_prog_throw';
      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
        onProgress: () => {
          throw new Error('callback exception');
        },
      });

      const context = makeContext('json', defaultSignal);
      const report = makeReport(context, 'json');

      const b = client.begin(context, defaultSignal);
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'begin' });
      await b;

      const finalizePromise = client.finalize(report, defaultSignal);
      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'PROGRESS',
        phase: 'serializing',
        chunksCompleted: 0,
      });

      await expect(finalizePromise).rejects.toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
      expect(worker.terminated).toBe(true);
    });

    it('suppresses late artifacts if onProgress calls client.abort()', async () => {
      const worker = new FakeWorker();
      const jobId = 'job_prog_abort';
      let clientRef!: ReturnType<typeof createWorkerWriterClient>;

      const client = createWorkerWriterClient({
        worker,
        jobId,
        generation: 0,
        timeoutMs: 5000,
        maxBytes: 1024,
        onProgress: () => {
          void clientRef.abort();
        },
      });
      clientRef = client;

      const context = makeContext('json', defaultSignal);
      const report = makeReport(context, 'json');

      const b = client.begin(context, defaultSignal);
      worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'begin' });
      await b;

      const finalizePromise = client.finalize(report, defaultSignal);
      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'PROGRESS',
        phase: 'serializing',
        chunksCompleted: 0,
      });

      await expect(finalizePromise).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
      expect(worker.terminated).toBe(true);

      // Late artifacts emitted by worker
      worker.emitMessage({
        protocolVersion: 1,
        jobId,
        generation: 0,
        type: 'STAGED_ARTIFACTS',
        artifacts: [
          {
            filename: 'late.json',
            mimeType: 'application/json',
            data: new Uint8Array([1]),
            byteLength: 1,
            safeSummary: 's',
          },
        ],
      });

      // State remains terminal, no unhandled rejection
      await expect(client.finalize(report, defaultSignal)).rejects.toThrowError(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
    });
  });

  describe('13. Synchronous worker replies and single terminate call', () => {
    it('handles synchronous postMessage reply, clears timers immediately, and terminates once', async () => {
      vi.useFakeTimers();
      try {
        const worker = new FakeWorker();
        const jobId = 'job_sync';

        // Worker synchronously replies during postMessage
        worker.customPostMessage = (msg) => {
          if (msg.type === 'BEGIN') {
            worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'begin' });
          } else if (msg.type === 'APPEND') {
            worker.emitMessage({ protocolVersion: 1, jobId, generation: 0, type: 'ACK', phase: 'append', chunksCompleted: 1 });
          } else if (msg.type === 'FINALIZE') {
            worker.emitMessage({
              protocolVersion: 1,
              jobId,
              generation: 0,
              type: 'STAGED_ARTIFACTS',
              artifacts: [
                {
                  filename: 'sync.json',
                  mimeType: 'application/json',
                  data: new Uint8Array([9]),
                  byteLength: 1,
                  safeSummary: 's',
                },
              ],
            });
          }
        };

        const client = createWorkerWriterClient({
          worker,
          jobId,
          generation: 0,
          timeoutMs: 5000,
          maxBytes: 1024,
        });

        const context = makeContext('json', defaultSignal);
        const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, [], jobId);
        const report = makeReport(context, 'json');

        await client.begin(context, defaultSignal);
        await client.append(chunk, defaultSignal);
        const artifacts = await client.finalize(report, defaultSignal);

        expect(artifacts).toHaveLength(1);
        expect(worker.terminateCalls).toBe(1);
        expect(worker.listenerCount('message')).toBe(0);

        // Advance timers by large amount; no timer fires
        vi.advanceTimersByTime(100000);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
