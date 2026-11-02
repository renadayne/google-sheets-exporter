import { describe, it, expect, vi } from 'vitest';
import type { Cell, ExportReport, NormalizedChunk, Artifact } from '../../src/contracts/domain.ts';
import type { WriterContext, WriterPort } from '../../src/contracts/ports.ts';
import type { WorkerResponse } from '../../src/contracts/messages.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import { createWorkerSession } from '../../src/runtime/worker-session.ts';
import { createJsonWriter } from '../../src/export/json.ts';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFixture() {
  const meta1 = { id: 10, title: 'Data', index: 0, type: 'GRID' as const, hidden: false, rows: 90001, columns: 26 };
  const meta2 = { id: 20, title: 'Empty', index: 1, type: 'GRID' as const, hidden: false, rows: 10, columns: 10 };
  const scope1 = { sheetId: 10, rect: { sheetId: 10, r0: 0, c0: 0, r1: 90000, c1: 26 } };
  const scope2 = { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 10, c1: 10 } };
  const ctx: WriterContext = {
    sourceId: 'src_1', title: 'Test Workbook', locale: 'en_US', timeZone: 'UTC',
    scopes: [scope1, scope2], mode: 'raw', format: 'json', visibility: 'include_all',
    limitsVersion: '1.0', sheetOrder: [10, 20], sheets: [meta1, meta2]
  };
  const rep: ExportReport = {
    schemaVersion: '1.0',
    source: { id: 'src_1', title: 'Test Workbook', locale: 'en_US', timeZone: 'UTC' },
    export: {
      startedAt: '2026-11-01T00:00:00.000Z', producedAt: '2026-11-01T00:01:00.000Z',
      mode: 'raw', format: 'json', visibility: 'include_all', complete: true,
      consistency: 'not_atomic_no_change_detected', warnings: []
    },
    selectedScopes: [scope1, scope2], sheetOrder: [10, 20], limitsVersion: '1.0',
    nameMappings: [
      { sheetId: 10, originalTitle: 'Data', exportedName: 'Data' },
      { sheetId: 20, originalTitle: 'Empty', exportedName: 'Empty' }
    ],
    exclusions: []
  };

  const a1: Cell = { r: 0, c: 0, kind: 'string', value: '00123' };
  const d50: Cell = { r: 49, c: 3, kind: 'string', value: 'middle' };
  const z90000: Cell = { r: 89999, c: 25, kind: 'number', value: 42 };

  const chunk1: NormalizedChunk = {
    jobId: 'job_1', chunkId: 'c1', rect: { sheetId: 10, r0: 0, c0: 0, r1: 50000, c1: 26 },
    cells: [a1, d50], excludedIntervals: { rows: [], columns: [] }, byteCount: 64
  };
  const chunk2: NormalizedChunk = {
    jobId: 'job_1', chunkId: 'c2', rect: { sheetId: 10, r0: 50000, c0: 0, r1: 90000, c1: 26 },
    cells: [z90000], excludedIntervals: { rows: [], columns: [] }, byteCount: 64
  };
  const chunk3: NormalizedChunk = {
    jobId: 'job_1', chunkId: 'c3', rect: { sheetId: 20, r0: 0, c0: 0, r1: 10, c1: 10 },
    cells: [], excludedIntervals: { rows: [], columns: [] }, byteCount: 64
  };

  return { ctx, rep, chunk1, chunk2, chunk3 };
}

function makeSimpleFixture(jobId = 'job_1') {
  const meta = { id: 10, title: 'Data', index: 0, type: 'GRID' as const, hidden: false, rows: 10, columns: 10 };
  const scope = { sheetId: 10, rect: { sheetId: 10, r0: 0, c0: 0, r1: 10, c1: 10 } };
  const ctx: WriterContext = {
    sourceId: 'src_1', title: 'Test', locale: 'en_US', timeZone: 'UTC',
    scopes: [scope], mode: 'raw', format: 'json', visibility: 'include_all',
    limitsVersion: '1.0', sheetOrder: [10], sheets: [meta]
  };
  const rep: ExportReport = {
    schemaVersion: '1.0',
    source: { id: 'src_1', title: 'Test', locale: 'en_US', timeZone: 'UTC' },
    export: {
      startedAt: '2026-11-01T00:00:00.000Z', producedAt: '2026-11-01T00:01:00.000Z',
      mode: 'raw', format: 'json', visibility: 'include_all', complete: true,
      consistency: 'not_atomic_no_change_detected', warnings: []
    },
    selectedScopes: [scope], sheetOrder: [10], limitsVersion: '1.0',
    nameMappings: [{ sheetId: 10, originalTitle: 'Data', exportedName: 'Data' }],
    exclusions: []
  };
  const chunk: NormalizedChunk = {
    jobId, chunkId: 'c1', rect: { sheetId: 10, r0: 0, c0: 0, r1: 10, c1: 10 },
    cells: [{ r: 0, c: 0, kind: 'string', value: 'hello' }],
    excludedIntervals: { rows: [], columns: [] }, byteCount: 32
  };
  return { ctx, rep, chunk };
}

describe('T36b2 Worker Session Dispatcher', () => {
  it('reserves the replacement before old abort callbacks can start a newer job', async () => {
    const { ctx, rep } = makeSimpleFixture();
    const emitted: WorkerResponse[] = [];
    let session!: ReturnType<typeof createWorkerSession>;
    let nested: Promise<void> | undefined;
    const fresh: WriterPort = { begin: vi.fn().mockResolvedValue(undefined), append: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockResolvedValue([]), abort: vi.fn().mockResolvedValue(undefined) };
    const old: WriterPort = { ...fresh, abort: vi.fn(() => {
      nested = session.handle({ protocolVersion: 1, jobId: 'newest', generation: 3, type: 'BEGIN', context: ctx });
      return Promise.resolve();
    }) };
    let factories = 0;
    session = createWorkerSession({ createWriter: () => ++factories === 1 ? old : fresh, emit: r => emitted.push(r) });
    await session.handle({ protocolVersion: 1, jobId: 'old', generation: 1, type: 'BEGIN', context: ctx });
    await session.handle({ protocolVersion: 1, jobId: 'superseded', generation: 2, type: 'BEGIN', context: ctx });
    await nested;
    expect(factories).toBe(2);
    expect(emitted.filter(r => r.jobId === 'superseded')).toEqual([]);
    expect(emitted.at(-1)).toEqual({ protocolVersion: 1, jobId: 'newest', generation: 3, type: 'ACK', phase: 'begin' });
    await session.handle({ protocolVersion: 1, jobId: 'newest', generation: 3, type: 'FINALIZE', report: rep });
    expect(emitted.at(-1)).toEqual({ protocolVersion: 1, jobId: 'newest', generation: 3, type: 'STAGED_ARTIFACTS', artifacts: [] });
  });

  it('marks append busy before descriptor traps can reenter another append', async () => {
    const { ctx, chunk } = makeSimpleFixture();
    const emitted: WorkerResponse[] = [];
    const append = vi.fn().mockResolvedValue(undefined);
    const session = createWorkerSession({ createWriter: () => ({ begin: async () => {}, append,
      finalize: async () => [], abort: async () => {} }), emit: r => emitted.push(r) });
    await session.handle({ protocolVersion: 1, jobId: chunk.jobId, generation: 1, type: 'BEGIN', context: ctx });
    let touched = 0;
    let nested: Promise<void> | undefined;
    const proxy = new Proxy(chunk, { getOwnPropertyDescriptor(target, key) {
      if (key === 'jobId') {
        touched++;
        nested = session.handle({ protocolVersion: 1, jobId: chunk.jobId, generation: 1, type: 'APPEND', chunk });
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    await session.handle({ protocolVersion: 1, jobId: chunk.jobId, generation: 1, type: 'APPEND', chunk: proxy });
    await nested;
    expect(touched).toBe(1);
    expect(append).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toEqual({ protocolVersion: 1, jobId: chunk.jobId, generation: 1, type: 'ERROR', code: 'INTERNAL_ERROR' });
  });

  it('Group 1: Valid BEGIN APPEND FINALIZE exact order/replies and true counters', async () => {
    const emitted: WorkerResponse[] = [];
    const { ctx, rep, chunk } = makeSimpleFixture('job-1');

    const fakeWriter: WriterPort = {
      begin: vi.fn().mockResolvedValue(undefined),
      append: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockResolvedValue([
        {
          filename: 'export.json',
          mimeType: 'application/json',
          data: new Uint8Array([1, 2, 3]),
          byteLength: 3,
          safeSummary: 'staged',
        },
      ]),
      abort: vi.fn().mockResolvedValue(undefined),
    };

    const session = createWorkerSession({
      createWriter: () => fakeWriter,
      emit: (res) => emitted.push(res),
    });

    // 1. BEGIN
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 0,
      type: 'BEGIN',
      context: ctx,
    });

    expect(emitted).toEqual([
      {
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'ACK',
        phase: 'begin',
      },
    ]);

    // 2. APPEND chunk 1
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 0,
      type: 'APPEND',
      chunk,
    });

    expect(emitted[1]).toEqual({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 0,
      type: 'ACK',
      phase: 'append',
      chunksCompleted: 1,
    });

    // 3. APPEND chunk 2
    const chunk2 = { ...chunk, chunkId: 'c2' };
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 0,
      type: 'APPEND',
      chunk: chunk2,
    });

    expect(emitted[2]).toEqual({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 0,
      type: 'ACK',
      phase: 'append',
      chunksCompleted: 2,
    });

    // 4. FINALIZE
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 0,
      type: 'FINALIZE',
      report: rep,
    });

    expect(emitted).toHaveLength(5);
    expect(emitted[3]).toEqual({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 0,
      type: 'PROGRESS',
      phase: 'serializing',
      chunksCompleted: 2,
    });
    expect(emitted[4]).toEqual({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 0,
      type: 'STAGED_ARTIFACTS',
      artifacts: [
        {
          filename: 'export.json',
          mimeType: 'application/json',
          data: new Uint8Array([1, 2, 3]),
          byteLength: 3,
          safeSummary: 'staged',
        },
      ],
    });
  });

  it('Group 2: Malformed and stale envelopes are ignored', async () => {
    const emitted: WorkerResponse[] = [];
    const { ctx } = makeSimpleFixture('job-1');

    const session = createWorkerSession({
      createWriter: () => ({
        begin: vi.fn(),
        append: vi.fn(),
        finalize: vi.fn(),
        abort: vi.fn(),
      }),
      emit: (res) => emitted.push(res),
    });

    // Invalid envelope types / primitives
    await session.handle(null);
    await session.handle(undefined);
    await session.handle('bad input');
    await session.handle({ invalid: true });
    await session.handle({ protocolVersion: 2, jobId: 'j', generation: 0, type: 'CANCEL' });

    // Stale generation BEGIN (generation -0 or negative rejected by parseWorkerCommand; equal/lower ignored)
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 10,
      type: 'BEGIN',
      context: ctx,
    });
    expect(emitted).toHaveLength(1); // ACK for gen 10

    // Equal generation BEGIN (stale)
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 10,
      type: 'BEGIN',
      context: ctx,
    });
    // Lower generation BEGIN (stale)
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-2',
      generation: 9,
      type: 'BEGIN',
      context: ctx,
    });

    // Stale or unknown jobId/generation APPEND/FINALIZE/CANCEL
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 5, // wrong generation
      type: 'CANCEL',
    });
    await session.handle({
      protocolVersion: 1,
      jobId: 'wrong-job',
      generation: 10, // wrong jobId
      type: 'CANCEL',
    });

    expect(emitted).toHaveLength(1);
  });

  it('Group 3: Payload auth rejected by actual context helper', async () => {
    const emitted: WorkerResponse[] = [];
    const { ctx } = makeSimpleFixture('job-1');
    const authContext = { ...ctx, accessToken: 'secret-token' };

    const session = createWorkerSession({
      createWriter: () => ({
        begin: vi.fn(),
        append: vi.fn(),
        finalize: vi.fn(),
        abort: vi.fn(),
      }),
      emit: (res) => emitted.push(res),
    });

    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 1,
      type: 'BEGIN',
      context: authContext,
    });

    expect(emitted).toEqual([
      {
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'ERROR',
        code: 'FORMAT_SERIALIZATION_FAILED',
      },
    ]);
  });

  it('Group 4: Captured chunk jobId mismatch, accessor, and extras reject without append', async () => {
    const { ctx, chunk } = makeSimpleFixture('job-1');

    // Case A: jobId mismatch
    {
      const emitted: WorkerResponse[] = [];
      const appendMock = vi.fn();
      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: appendMock,
          finalize: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'BEGIN',
        context: ctx,
      });

      const mismatchedChunk = { ...chunk, jobId: 'job-wrong' };
      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'APPEND',
        chunk: mismatchedChunk,
      });

      expect(appendMock).not.toHaveBeenCalled();
      expect(emitted[1]).toEqual({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'ERROR',
        code: 'FORMAT_SERIALIZATION_FAILED',
      });
    }

    // Case B: Accessor / getter trap on chunk
    {
      const emitted: WorkerResponse[] = [];
      const appendMock = vi.fn();
      let getterCalled = false;
      const accessorChunk = {
        get jobId() {
          getterCalled = true;
          return 'job-1';
        },
        chunkId: 'c1',
        rect: chunk.rect,
        cells: chunk.cells,
        excludedIntervals: chunk.excludedIntervals,
        byteCount: chunk.byteCount,
      };

      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: appendMock,
          finalize: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'BEGIN',
        context: ctx,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'APPEND',
        chunk: accessorChunk,
      });

      expect(getterCalled).toBe(false);
      expect(appendMock).not.toHaveBeenCalled();
      expect(emitted[1]).toEqual({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'ERROR',
        code: 'FORMAT_SERIALIZATION_FAILED',
      });
    }

    // Case C: Extra property on chunk
    {
      const emitted: WorkerResponse[] = [];
      const appendMock = vi.fn();
      const extraChunk = { ...chunk, extraProperty: 'unauthorized' };

      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: appendMock,
          finalize: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'BEGIN',
        context: ctx,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'APPEND',
        chunk: extraChunk,
      });

      expect(appendMock).not.toHaveBeenCalled();
      expect(emitted[1]).toEqual({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'ERROR',
        code: 'FORMAT_SERIALIZATION_FAILED',
      });
    }
  });

  it('Group 5: Writer begin, append, finalize failures emit static codes with no token/leakage', async () => {
    const { ctx, rep, chunk } = makeSimpleFixture('job-1');

    // Case A: createWriter throws
    {
      const emitted: WorkerResponse[] = [];
      const session = createWorkerSession({
        createWriter: () => {
          throw new DomainError('CONFIG_INVALID');
        },
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'BEGIN',
        context: ctx,
      });

      expect(emitted).toEqual([
        {
          protocolVersion: 1,
          jobId: 'job-1',
          generation: 0,
          type: 'ERROR',
          code: 'CONFIG_INVALID',
        },
      ]);
      expect(Object.keys(emitted[0])).toEqual(['protocolVersion', 'jobId', 'generation', 'type', 'code']);
    }

    // Case B: begin rejects
    {
      const emitted: WorkerResponse[] = [];
      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockRejectedValue(new DomainError('FORMAT_SERIALIZATION_FAILED')),
          append: vi.fn(),
          finalize: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'BEGIN',
        context: ctx,
      });

      expect(emitted).toEqual([
        {
          protocolVersion: 1,
          jobId: 'job-1',
          generation: 0,
          type: 'ERROR',
          code: 'FORMAT_SERIALIZATION_FAILED',
        },
      ]);
    }

    // Case C: append rejects with SIZE_LIMIT_EXCEEDED
    {
      const emitted: WorkerResponse[] = [];
      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: vi.fn().mockRejectedValue(new DomainError('SIZE_LIMIT_EXCEEDED')),
          finalize: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'BEGIN',
        context: ctx,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'APPEND',
        chunk,
      });

      expect(emitted[1]).toEqual({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'ERROR',
        code: 'SIZE_LIMIT_EXCEEDED',
      });
    }

    // Case D: finalize rejects with arbitrary error -> sanitizes to INTERNAL_ERROR
    {
      const emitted: WorkerResponse[] = [];
      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: vi.fn().mockResolvedValue(undefined),
          finalize: vi.fn().mockRejectedValue(new Error('leak: secret bearer token')),
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'BEGIN',
        context: ctx,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'FINALIZE',
        report: rep,
      });

      expect(emitted).toHaveLength(3); // ACK, PROGRESS, ERROR
      expect(emitted[2]).toEqual({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'ERROR',
        code: 'INTERNAL_ERROR',
      });
      // Verifies no leak of secret bearer token anywhere in response
      const serialized = JSON.stringify(emitted[2]);
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('bearer');
    }
  });

  it('Group 6: Cancel during deferred begin, append, finalize produces only CANCELLED and no late output', async () => {
    const { ctx, rep, chunk } = makeSimpleFixture('job-1');

    // Case A: Cancel during deferred begin
    {
      const emitted: WorkerResponse[] = [];
      const deferredBegin = createDeferred<void>();
      const session = createWorkerSession({
        createWriter: () => ({
          begin: () => deferredBegin.promise,
          append: vi.fn(),
          finalize: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      const beginPromise = session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'BEGIN',
        context: ctx,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'CANCEL',
      });

      expect(emitted).toEqual([
        {
          protocolVersion: 1,
          jobId: 'job-1',
          generation: 0,
          type: 'CANCELLED',
        },
      ]);

      // Resolve begin late
      deferredBegin.resolve();
      await beginPromise;

      // No late ACK
      expect(emitted).toHaveLength(1);
    }

    // Case B: Cancel during deferred append
    {
      const emitted: WorkerResponse[] = [];
      const deferredAppend = createDeferred<void>();
      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: () => deferredAppend.promise,
          finalize: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'BEGIN',
        context: ctx,
      });

      const appendPromise = session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'APPEND',
        chunk,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'CANCEL',
      });

      expect(emitted[1]).toEqual({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'CANCELLED',
      });

      // Reject append late
      deferredAppend.reject(new Error('late abort'));
      await appendPromise;

      // No late ACK or ERROR
      expect(emitted).toHaveLength(2);
    }

    // Case C: Cancel during deferred finalize
    {
      const emitted: WorkerResponse[] = [];
      const deferredFinalize = createDeferred<readonly Artifact[]>();
      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: vi.fn().mockResolvedValue(undefined),
          finalize: () => deferredFinalize.promise,
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'BEGIN',
        context: ctx,
      });

      const finalizePromise = session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'FINALIZE',
        report: rep,
      });

      expect(emitted[1]).toEqual({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'PROGRESS',
        phase: 'serializing',
        chunksCompleted: 0,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'CANCEL',
      });

      expect(emitted[2]).toEqual({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 0,
        type: 'CANCELLED',
      });

      // Resolve finalize late
      deferredFinalize.resolve([]);
      await finalizePromise;

      // No late STAGED_ARTIFACTS
      expect(emitted).toHaveLength(3);
    }
  });

  it('Group 7: Newer generation BEGIN while old finalize pending does not allow stale completion to erase fresh job', async () => {
    const emitted: WorkerResponse[] = [];
    const { ctx, rep } = makeSimpleFixture('job-1');
    const { ctx: ctx2, rep: rep2 } = makeSimpleFixture('job-2');

    const deferredFinalize1 = createDeferred<readonly Artifact[]>();
    const abort1 = vi.fn().mockResolvedValue(undefined);

    const writer1: WriterPort = {
      begin: vi.fn().mockResolvedValue(undefined),
      append: vi.fn().mockResolvedValue(undefined),
      finalize: () => deferredFinalize1.promise,
      abort: abort1,
    };

    const writer2: WriterPort = {
      begin: vi.fn().mockResolvedValue(undefined),
      append: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockResolvedValue([{
        filename: 'job2.json',
        mimeType: 'application/json',
        data: new Uint8Array([2]),
        byteLength: 1,
        safeSummary: 'job2',
      }]),
      abort: vi.fn().mockResolvedValue(undefined),
    };

    let callCount = 0;
    const session = createWorkerSession({
      createWriter: () => {
        callCount++;
        return callCount === 1 ? writer1 : writer2;
      },
      emit: (res) => emitted.push(res),
    });

    // 1. Start job 1
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 1,
      type: 'BEGIN',
      context: ctx,
    });

    // 2. Finalize job 1 (deferred)
    const finalize1Promise = session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 1,
      type: 'FINALIZE',
      report: rep,
    });

    // 3. New BEGIN for job 2 with generation 2 arrives while job 1 is finalizing
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-2',
      generation: 2,
      type: 'BEGIN',
      context: ctx2,
    });

    expect(abort1).toHaveBeenCalled();

    // 4. Job 1 finalize resolves late
    deferredFinalize1.resolve([{
      filename: 'stale.json',
      mimeType: 'application/json',
      data: new Uint8Array([1]),
      byteLength: 1,
      safeSummary: 'stale',
    }]);
    await finalize1Promise;

    // Verify job 1 staged artifacts were NOT emitted
    const staged1 = emitted.find((e) => e.jobId === 'job-1' && e.type === 'STAGED_ARTIFACTS');
    expect(staged1).toBeUndefined();

    // 5. Job 2 completes normally
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-2',
      generation: 2,
      type: 'FINALIZE',
      report: rep2,
    });

    const staged2 = emitted.find((e) => e.jobId === 'job-2' && e.type === 'STAGED_ARTIFACTS');
    expect(staged2).toBeDefined();
    expect(staged2?.jobId).toBe('job-2');
  });

  it('Group 8: Duplicate and out-of-order commands fail with static INTERNAL_ERROR', async () => {
    const { ctx, rep, chunk } = makeSimpleFixture('job-1');

    // Case A: Out-of-order APPEND while beginning
    {
      const emitted: WorkerResponse[] = [];
      const deferredBegin = createDeferred<void>();
      const session = createWorkerSession({
        createWriter: () => ({
          begin: () => deferredBegin.promise,
          append: vi.fn(),
          finalize: vi.fn(),
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      const beginPromise = session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'BEGIN',
        context: ctx,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'APPEND',
        chunk,
      });

      expect(emitted).toEqual([
        {
          protocolVersion: 1,
          jobId: 'job-1',
          generation: 1,
          type: 'ERROR',
          code: 'INTERNAL_ERROR',
        },
      ]);

      deferredBegin.resolve();
      await beginPromise;
    }

    // Case B: Duplicate FINALIZE while finalizing
    {
      const emitted: WorkerResponse[] = [];
      const deferredFinalize = createDeferred<readonly Artifact[]>();
      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: vi.fn().mockResolvedValue(undefined),
          finalize: () => deferredFinalize.promise,
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'BEGIN',
        context: ctx,
      });

      const fin1 = session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'FINALIZE',
        report: rep,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'FINALIZE',
        report: rep,
      });

      expect(emitted.find((e) => e.type === 'ERROR')).toEqual({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'ERROR',
        code: 'INTERNAL_ERROR',
      });

      deferredFinalize.resolve([]);
      await fin1;
    }
  });

  it('Group 9: close() is idempotent, permanent, and silences all future commands and emits', async () => {
    const emitted: WorkerResponse[] = [];
    const { ctx } = makeSimpleFixture('job-1');
    const abortMock = vi.fn().mockResolvedValue(undefined);

    const session = createWorkerSession({
      createWriter: () => ({
        begin: vi.fn().mockResolvedValue(undefined),
        append: vi.fn().mockResolvedValue(undefined),
        finalize: vi.fn().mockResolvedValue([]),
        abort: abortMock,
      }),
      emit: (res) => emitted.push(res),
    });

    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 1,
      type: 'BEGIN',
      context: ctx,
    });

    expect(emitted).toHaveLength(1);

    // Call close()
    await session.close();
    expect(abortMock).toHaveBeenCalled();

    // Call close() second time (idempotent)
    await session.close();

    // Future commands ignored
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-2',
      generation: 2,
      type: 'BEGIN',
      context: ctx,
    });

    expect(emitted).toHaveLength(1);
  });

  it('Group 10: emit failure cleans up active job, swallows error, and does not corrupt newer job', async () => {
    const { ctx } = makeSimpleFixture('job-1');
    const abortMock = vi.fn().mockResolvedValue(undefined);

    const session = createWorkerSession({
      createWriter: () => ({
        begin: vi.fn().mockResolvedValue(undefined),
        append: vi.fn().mockResolvedValue(undefined),
        finalize: vi.fn().mockResolvedValue([]),
        abort: abortMock,
      }),
      emit: () => {
        throw new Error('Hostile postMessage failure');
      },
    });

    // Should not throw
    await expect(
      session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'BEGIN',
        context: ctx,
      })
    ).resolves.toBeUndefined();

    // Active job was aborted and cleaned up
    expect(abortMock).toHaveBeenCalled();
  });

  it('Group 11: Responses strictly forbid percentage, total progress fabrication, or token transport', async () => {
    const emitted: WorkerResponse[] = [];
    const { ctx, rep, chunk } = makeSimpleFixture('job-1');

    const session = createWorkerSession({
      createWriter: () => ({
        begin: vi.fn().mockResolvedValue(undefined),
        append: vi.fn().mockResolvedValue(undefined),
        finalize: vi.fn().mockResolvedValue([]),
        abort: vi.fn().mockResolvedValue(undefined),
      }),
      emit: (res) => emitted.push(res),
    });

    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 1,
      type: 'BEGIN',
      context: ctx,
    });
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 1,
      type: 'APPEND',
      chunk,
    });
    await session.handle({
      protocolVersion: 1,
      jobId: 'job-1',
      generation: 1,
      type: 'FINALIZE',
      report: rep,
    });

    for (const res of emitted) {
      expect(res).not.toHaveProperty('percent');
      expect(res).not.toHaveProperty('percentage');
      expect(res).not.toHaveProperty('totalChunks');
      expect(res).not.toHaveProperty('token');
      expect(res).not.toHaveProperty('accessToken');
      expect(res).not.toHaveProperty('message');
      expect(res).not.toHaveProperty('stack');
    }
  });

  it('Group 12: Full successful roundtrip using actual createJsonWriter and predecessor fixtures', async () => {
    const emitted: WorkerResponse[] = [];
    const { ctx, rep, chunk1, chunk2, chunk3 } = makeFixture();

    const session = createWorkerSession({
      createWriter: (format) => {
        expect(format).toBe('json');
        return createJsonWriter({
          maxChunks: 10,
          maxCells: 1000,
          maxIntervals: 100,
          maxDecodedBytes: 1024 * 1024,
          maxWarnings: 100,
          maxBytes: 1024 * 1024,
        });
      },
      emit: (res) => emitted.push(res),
    });

    // 1. BEGIN
    await session.handle({
      protocolVersion: 1,
      jobId: 'job_1',
      generation: 0,
      type: 'BEGIN',
      context: ctx,
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      protocolVersion: 1,
      jobId: 'job_1',
      generation: 0,
      type: 'ACK',
      phase: 'begin',
    });

    // 2. APPEND chunk 1
    await session.handle({
      protocolVersion: 1,
      jobId: 'job_1',
      generation: 0,
      type: 'APPEND',
      chunk: chunk1,
    });

    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual({
      protocolVersion: 1,
      jobId: 'job_1',
      generation: 0,
      type: 'ACK',
      phase: 'append',
      chunksCompleted: 1,
    });

    // 3. APPEND chunk 2
    await session.handle({
      protocolVersion: 1,
      jobId: 'job_1',
      generation: 0,
      type: 'APPEND',
      chunk: chunk2,
    });

    expect(emitted).toHaveLength(3);
    expect(emitted[2]).toEqual({
      protocolVersion: 1,
      jobId: 'job_1',
      generation: 0,
      type: 'ACK',
      phase: 'append',
      chunksCompleted: 2,
    });

    // 4. APPEND chunk 3
    await session.handle({
      protocolVersion: 1,
      jobId: 'job_1',
      generation: 0,
      type: 'APPEND',
      chunk: chunk3,
    });

    expect(emitted).toHaveLength(4);
    expect(emitted[3]).toEqual({
      protocolVersion: 1,
      jobId: 'job_1',
      generation: 0,
      type: 'ACK',
      phase: 'append',
      chunksCompleted: 3,
    });

    // 5. FINALIZE
    await session.handle({
      protocolVersion: 1,
      jobId: 'job_1',
      generation: 0,
      type: 'FINALIZE',
      report: rep,
    });

    expect(emitted).toHaveLength(6);
    expect(emitted[4]).toEqual({
      protocolVersion: 1,
      jobId: 'job_1',
      generation: 0,
      type: 'PROGRESS',
      phase: 'serializing',
      chunksCompleted: 3,
    });

    const staged = emitted[5];
    expect(staged.type).toBe('STAGED_ARTIFACTS');
    if (staged.type === 'STAGED_ARTIFACTS') {
      expect(staged.artifacts).toHaveLength(1);
      const artifact = staged.artifacts[0];
      expect(artifact.mimeType).toBe('application/json');
      expect(artifact.filename).toBe('Test Workbook.json');
      expect(artifact.byteLength).toBeGreaterThan(0);
      expect(artifact.data).toBeInstanceOf(Uint8Array);
      const decodedJson = JSON.parse(new TextDecoder().decode(artifact.data as Uint8Array));
      expect(decodedJson.source.id).toBe('src_1');
      expect(decodedJson.sheets).toHaveLength(2);
      expect(decodedJson.sheets[0].cells).toHaveLength(3); // A1, D50, Z90000
    }
  });

  describe('Group 13: Regression - FINALIZE PROGRESS emit hooks prevent writer.finalize', () => {
    it('does not invoke writer.finalize if PROGRESS emit throws', async () => {
      const { ctx, rep } = makeSimpleFixture('job-1');
      const finalizeMock = vi.fn().mockResolvedValue([]);
      const abortMock = vi.fn().mockResolvedValue(undefined);

      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: vi.fn().mockResolvedValue(undefined),
          finalize: finalizeMock,
          abort: abortMock,
        }),
        emit: (res) => {
          if (res.type === 'PROGRESS') {
            throw new Error('Hostile PROGRESS emit failure');
          }
        },
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'BEGIN',
        context: ctx,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'FINALIZE',
        report: rep,
      });

      expect(finalizeMock).not.toHaveBeenCalled();
      expect(abortMock).toHaveBeenCalled();
    });

    it('does not invoke writer.finalize if PROGRESS emit cancels or closes', async () => {
      const { ctx, rep } = makeSimpleFixture('job-1');
      const finalizeMock = vi.fn().mockResolvedValue([]);

      let session!: ReturnType<typeof createWorkerSession>;
      session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: vi.fn().mockResolvedValue(undefined),
          finalize: finalizeMock,
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => {
          if (res.type === 'PROGRESS') {
            void session.handle({
              protocolVersion: 1,
              jobId: 'job-1',
              generation: 1,
              type: 'CANCEL',
            });
          }
        },
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'BEGIN',
        context: ctx,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'FINALIZE',
        report: rep,
      });

      expect(finalizeMock).not.toHaveBeenCalled();
    });
  });

  describe('Group 14: Regression - BEGIN reentrancy and cancellation during helpers', () => {
    it('aborts and discards late factory writer if reentrant BEGIN replaces job during createWriter', async () => {
      const { ctx } = makeSimpleFixture('job-1');
      const { ctx: ctx2 } = makeSimpleFixture('job-2');
      const emitted: WorkerResponse[] = [];

      const abort1 = vi.fn().mockResolvedValue(undefined);
      const writer1: WriterPort = {
        begin: vi.fn().mockResolvedValue(undefined),
        append: vi.fn().mockResolvedValue(undefined),
        finalize: vi.fn().mockResolvedValue([]),
        abort: abort1,
      };

      const writer2: WriterPort = {
        begin: vi.fn().mockResolvedValue(undefined),
        append: vi.fn().mockResolvedValue(undefined),
        finalize: vi.fn().mockResolvedValue([]),
        abort: vi.fn().mockResolvedValue(undefined),
      };

      let session!: ReturnType<typeof createWorkerSession>;
      let createWriterCalls = 0;

      session = createWorkerSession({
        createWriter: () => {
          createWriterCalls++;
          if (createWriterCalls === 1) {
            // Reentrantly start job 2 with higher generation
            void session.handle({
              protocolVersion: 1,
              jobId: 'job-2',
              generation: 2,
              type: 'BEGIN',
              context: ctx2,
            });
            return writer1;
          }
          return writer2;
        },
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'BEGIN',
        context: ctx,
      });

      // writer1 was returned after job-1 was superseded, so writer1 must be aborted and never begun
      expect(abort1).toHaveBeenCalled();
      expect(writer1.begin).not.toHaveBeenCalled();

      // job 2 completed begin successfully
      expect(writer2.begin).toHaveBeenCalled();
      const acks = emitted.filter((e) => e.type === 'ACK' && (e as any).phase === 'begin');
      expect(acks).toHaveLength(1);
      expect(acks[0].jobId).toBe('job-2');
    });

    it('aborts and discards factory writer if close() is called during createWriter', async () => {
      const { ctx } = makeSimpleFixture('job-1');
      const emitted: WorkerResponse[] = [];
      const abort1 = vi.fn().mockResolvedValue(undefined);

      const writer1: WriterPort = {
        begin: vi.fn().mockResolvedValue(undefined),
        append: vi.fn().mockResolvedValue(undefined),
        finalize: vi.fn().mockResolvedValue([]),
        abort: abort1,
      };

      let session!: ReturnType<typeof createWorkerSession>;
      session = createWorkerSession({
        createWriter: () => {
          void session.close();
          return writer1;
        },
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'BEGIN',
        context: ctx,
      });

      expect(abort1).toHaveBeenCalled();
      expect(writer1.begin).not.toHaveBeenCalled();
      expect(emitted).toHaveLength(0);
    });
  });

  describe('Group 15: Regression - APPEND Proxy descriptor traps with cancel or reentrant BEGIN', () => {
    it('halts append cleanly without calling writer.append or failing stale job when Proxy trap cancels', async () => {
      const { ctx, chunk } = makeSimpleFixture('job-1');
      const emitted: WorkerResponse[] = [];
      const appendMock = vi.fn().mockResolvedValue(undefined);

      let session!: ReturnType<typeof createWorkerSession>;
      session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: appendMock,
          finalize: vi.fn().mockResolvedValue([]),
          abort: vi.fn().mockResolvedValue(undefined),
        }),
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'BEGIN',
        context: ctx,
      });

      // Hostile proxy chunk whose descriptor trap cancels the job
      const hostileChunk = new Proxy({ ...chunk }, {
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'rect') {
            void session.handle({
              protocolVersion: 1,
              jobId: 'job-1',
              generation: 1,
              type: 'CANCEL',
            });
          }
          return Object.getOwnPropertyDescriptor(target, prop);
        },
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'APPEND',
        chunk: hostileChunk,
      });

      expect(appendMock).not.toHaveBeenCalled();
      // Emitted CANCELLED, but NO late ERROR or ACK
      const cancelled = emitted.filter((e) => e.type === 'CANCELLED');
      expect(cancelled).toHaveLength(1);
      const errors = emitted.filter((e) => e.type === 'ERROR');
      expect(errors).toHaveLength(0);
    });
  });

  describe('Group 16: Regression - Synchronous throw in writer.abort does not lose CANCELLED and avoids double abort', () => {
    it('handles synchronous throw in writer.abort without dropping CANCELLED emission', async () => {
      const { ctx } = makeSimpleFixture('job-1');
      const emitted: WorkerResponse[] = [];

      let abortCalls = 0;
      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: vi.fn().mockResolvedValue(undefined),
          finalize: vi.fn().mockResolvedValue([]),
          abort: () => {
            abortCalls++;
            throw new Error('Immediate sync throw in abort');
          },
        }),
        emit: (res) => emitted.push(res),
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'BEGIN',
        context: ctx,
      });

      // CANCEL should succeed and emit CANCELLED despite sync throw
      await expect(
        session.handle({
          protocolVersion: 1,
          jobId: 'job-1',
          generation: 1,
          type: 'CANCEL',
        })
      ).resolves.toBeUndefined();

      expect(abortCalls).toBe(1);
      expect(emitted.find((e) => e.type === 'CANCELLED')).toBeDefined();
    });

    it('avoids double aborting the same writer when failJob safeEmit throws', async () => {
      const { ctx, chunk } = makeSimpleFixture('job-1');
      let abortCalls = 0;

      const session = createWorkerSession({
        createWriter: () => ({
          begin: vi.fn().mockResolvedValue(undefined),
          append: vi.fn().mockRejectedValue(new DomainError('FORMAT_SERIALIZATION_FAILED')),
          finalize: vi.fn().mockResolvedValue([]),
          abort: () => {
            abortCalls++;
            return Promise.resolve();
          },
        }),
        emit: (res) => {
          if (res.type === 'ERROR') {
            throw new Error('Emit error throw');
          }
        },
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'BEGIN',
        context: ctx,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'APPEND',
        chunk,
      });

      expect(abortCalls).toBe(1);
    });
  });

  describe('Group 17: Regression - Late old completion cannot clear fresh newer job', () => {
    it('ensures newer job completes and is not cleared by late settling of superseded job', async () => {
      const { ctx, rep } = makeSimpleFixture('job-1');
      const { ctx: ctx2, rep: rep2, chunk: chunk2 } = makeSimpleFixture('job-2');
      const emitted: WorkerResponse[] = [];

      const deferredFinalize1 = createDeferred<readonly Artifact[]>();
      let callCount = 0;

      const session = createWorkerSession({
        createWriter: () => {
          callCount++;
          if (callCount === 1) {
            return {
              begin: vi.fn().mockResolvedValue(undefined),
              append: vi.fn().mockResolvedValue(undefined),
              finalize: () => deferredFinalize1.promise,
              abort: vi.fn().mockResolvedValue(undefined),
            };
          }
          return {
            begin: vi.fn().mockResolvedValue(undefined),
            append: vi.fn().mockResolvedValue(undefined),
            finalize: vi.fn().mockResolvedValue([{
              filename: 'job2.json',
              mimeType: 'application/json',
              data: new Uint8Array([2]),
              byteLength: 1,
              safeSummary: 'job2 artifact',
            }]),
            abort: vi.fn().mockResolvedValue(undefined),
          };
        },
        emit: (res) => emitted.push(res),
      });

      // 1. Begin and finalize job 1 (deferred)
      await session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'BEGIN',
        context: ctx,
      });
      const fin1Promise = session.handle({
        protocolVersion: 1,
        jobId: 'job-1',
        generation: 1,
        type: 'FINALIZE',
        report: rep,
      });

      // 2. Begin job 2 with generation 2
      await session.handle({
        protocolVersion: 1,
        jobId: 'job-2',
        generation: 2,
        type: 'BEGIN',
        context: ctx2,
      });

      // 3. Late finalize 1 resolves
      deferredFinalize1.resolve([]);
      await fin1Promise;

      // 4. Job 2 appends and finalizes - must succeed!
      await session.handle({
        protocolVersion: 1,
        jobId: 'job-2',
        generation: 2,
        type: 'APPEND',
        chunk: chunk2,
      });

      await session.handle({
        protocolVersion: 1,
        jobId: 'job-2',
        generation: 2,
        type: 'FINALIZE',
        report: rep2,
      });

      const staged2 = emitted.find((e) => e.jobId === 'job-2' && e.type === 'STAGED_ARTIFACTS');
      expect(staged2).toBeDefined();
    });
  });
});
