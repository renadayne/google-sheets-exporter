import { describe, it, expect } from 'vitest';
import type { Artifact, ExportReport, NormalizedChunk } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import {
  createBufferedWriter,
  type BufferedWriterOptions,
  type PreparedSerializer
} from '../../src/export/buffered-writer.ts';
import { PROVISIONAL_MAX_CHUNKS } from '../../src/export/coverage.ts';
import type { PreparedSheet } from '../../src/export/prepare.ts';

const defaultOpts: BufferedWriterOptions = Object.freeze({
  maxChunks: 10,
  maxCells: 1000,
  maxIntervals: 100,
  maxDecodedBytes: 1024 * 1024
});

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFixtures() {
  const metaA = { id: 1, title: 'Sheet1', index: 0, type: 'GRID' as const, hidden: false, rows: 100, columns: 10 };
  const scopeA = { sheetId: 1, rect: { sheetId: 1, r0: 0, c0: 0, r1: 100, c1: 10 } };
  const ctxA: WriterContext = {
    sourceId: 'src_a', title: 'Workbook A', locale: 'en_US', timeZone: 'UTC',
    scopes: [scopeA], mode: 'raw', format: 'csv', visibility: 'include_all',
    limitsVersion: '1.0', sheetOrder: [1], sheets: [metaA]
  };
  const repA: ExportReport = {
    schemaVersion: '1.0',
    source: { id: 'src_a', title: 'Workbook A', locale: 'en_US', timeZone: 'UTC' },
    export: {
      startedAt: '2026-11-01T00:00:00.000Z', producedAt: '2026-11-01T00:01:00.000Z',
      mode: 'raw', format: 'csv', visibility: 'include_all', complete: true,
      consistency: 'not_atomic_no_change_detected', warnings: []
    },
    selectedScopes: [scopeA], sheetOrder: [1], limitsVersion: '1.0',
    nameMappings: [{ sheetId: 1, originalTitle: 'Sheet1', exportedName: 'Sheet1.csv' }],
    exclusions: []
  };
  const chunkA: NormalizedChunk = {
    jobId: 'job_a', chunkId: 'ca1', rect: { sheetId: 1, r0: 0, c0: 0, r1: 100, c1: 10 },
    cells: [{ r: 0, c: 0, kind: 'string', value: 'val_a' }],
    excludedIntervals: { rows: [], columns: [] }, byteCount: 32
  };

  const metaB = { id: 2, title: 'FreshTab', index: 0, type: 'GRID' as const, hidden: false, rows: 50, columns: 5 };
  const scopeB = { sheetId: 2, rect: { sheetId: 2, r0: 0, c0: 0, r1: 50, c1: 5 } };
  const ctxB: WriterContext = {
    sourceId: 'src_b', title: 'Fresh Workbook B', locale: 'en_US', timeZone: 'UTC',
    scopes: [scopeB], mode: 'raw', format: 'csv', visibility: 'include_all',
    limitsVersion: '1.0', sheetOrder: [2], sheets: [metaB]
  };
  const repB: ExportReport = {
    schemaVersion: '1.0',
    source: { id: 'src_b', title: 'Fresh Workbook B', locale: 'en_US', timeZone: 'UTC' },
    export: {
      startedAt: '2026-11-01T00:02:00.000Z', producedAt: '2026-11-01T00:03:00.000Z',
      mode: 'raw', format: 'csv', visibility: 'include_all', complete: true,
      consistency: 'not_atomic_no_change_detected', warnings: []
    },
    selectedScopes: [scopeB], sheetOrder: [2], limitsVersion: '1.0',
    nameMappings: [{ sheetId: 2, originalTitle: 'FreshTab', exportedName: 'FreshTab.csv' }],
    exclusions: []
  };
  const chunkB: NormalizedChunk = {
    jobId: 'job_b', chunkId: 'cb1', rect: { sheetId: 2, r0: 0, c0: 0, r1: 50, c1: 5 },
    cells: [{ r: 5, c: 2, kind: 'number', value: 999 }],
    excludedIntervals: { rows: [], columns: [] }, byteCount: 32
  };

  return { ctxA, repA, chunkA, ctxB, repB, chunkB };
}

describe('T24d1 Shared Buffered Writer Lifecycle', () => {
  const signal = new AbortController().signal;

  it('does not invoke an obsolete serializer if preparation reenters a fresh session', async () => {
    const { ctxA, repA, chunkA, ctxB, repB, chunkB } = makeFixtures();
    let oldCalls = 0;
    const serializer: PreparedSerializer = (context, prepared) => {
      if (context.sourceId === 'src_a') oldCalls++;
      expect(context.sourceId).toBe('src_b');
      expect(prepared[0].cells).toEqual([{ r: 5, c: 2, kind: 'number', value: 999 }]);
      return Object.freeze([{ filename: 'Fresh.csv', mimeType: 'text/csv', data: Uint8Array.of(1), byteLength: 1, safeSummary: 'Synthetic core fixture' }]);
    };
    const writer = createBufferedWriter('csv', defaultOpts, serializer);
    await writer.begin(ctxA, signal);
    await writer.append(chunkA, signal);
    let reads = 0;
    let freshBegin: Promise<void> | undefined;
    const reenteringSignal = {
      addEventListener() {}, removeEventListener() {},
      get aborted() {
        if (++reads === 2) {
          void writer.abort();
          freshBegin = writer.begin(ctxB, signal);
        }
        return false;
      }
    } as unknown as AbortSignal;
    await expect(writer.finalize(repA, reenteringSignal)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(reads).toBeGreaterThan(1);
    expect(oldCalls).toBe(0);
    await freshBegin;
    await writer.append(chunkB, signal);
    expect((await writer.finalize(repB, signal))[0].filename).toBe('Fresh.csv');
  });

  describe('Group 1: Async held finalize race with late success and late failure', () => {
    it('holds old finalize asynchronously then synchronous abort+begin fresh; late success rejects OPERATION_ABORTED and fresh session succeeds', async () => {
      const { ctxA, repA, chunkA, ctxB, repB, chunkB } = makeFixtures();
      const oldDeferred = createDeferred<readonly Artifact[]>();

      interface SerializerInvocation {
        context: WriterContext;
        prepared: readonly PreparedSheet[];
        report: ExportReport;
      }
      let freshInvocation: SerializerInvocation | null = null;

      const serializer: PreparedSerializer = (context, prepared, report) => {
        if (context.sourceId === 'src_a') {
          return oldDeferred.promise;
        }
        freshInvocation = { context, prepared, report };
        const freshArtifact: Artifact = Object.freeze({
          filename: 'Fresh.csv',
          mimeType: 'text/csv',
          data: new Uint8Array([49, 50, 51]),
          byteLength: 3,
          safeSummary: 'Fresh CSV'
        });
        return Object.freeze([freshArtifact]);
      };

      const writer = createBufferedWriter('csv', defaultOpts, serializer);

      await writer.begin(ctxA, signal);
      await writer.append(chunkA, signal);

      // Start old finalize; serializer holds deferred promise
      const oldFinalize = writer.finalize(repA, signal);
      let oldErr: any = null;
      const oldObserver = oldFinalize.catch(err => { oldErr = err; });

      // Synchronously abort and begin fresh session
      const abortPromise = writer.abort();
      const beginPromise = writer.begin(ctxB, signal);
      await abortPromise;
      await beginPromise;
      await writer.append(chunkB, signal);

      const freshFinalize = writer.finalize(repB, signal);

      // Resolve old serializer (late success)
      const oldArtifact: Artifact = Object.freeze({
        filename: 'Old.csv',
        mimeType: 'text/csv',
        data: new Uint8Array([99]),
        byteLength: 1,
        safeSummary: 'Old CSV'
      });
      oldDeferred.resolve(Object.freeze([oldArtifact]));

      await oldObserver;
      expect(oldErr).toBeInstanceOf(DomainError);
      expect(oldErr.code).toBe('OPERATION_ABORTED');

      const freshArtifacts = await freshFinalize;
      expect(freshArtifacts).toHaveLength(1);
      expect(freshArtifacts[0].filename).toBe('Fresh.csv');
      expect(freshArtifacts[0].safeSummary).toBe('Fresh CSV');

      // Verify actual fresh context/cells passed to serializer as independent expected fixture
      expect(freshInvocation).not.toBeNull();
      expect(freshInvocation!.context.sourceId).toBe('src_b');
      expect(freshInvocation!.context.title).toBe('Fresh Workbook B');
      expect(freshInvocation!.prepared).toHaveLength(1);
      expect(freshInvocation!.prepared[0].metadata.id).toBe(2);
      expect(freshInvocation!.prepared[0].metadata.title).toBe('FreshTab');
      expect(freshInvocation!.prepared[0].cells).toEqual([
        { r: 5, c: 2, kind: 'number', value: 999 }
      ]);
      expect(freshInvocation!.report.source.title).toBe('Fresh Workbook B');
    });

    it('holds old finalize asynchronously then synchronous abort+begin fresh; late failure rejects safely without wiping fresh session', async () => {
      const { ctxA, repA, chunkA, ctxB, repB, chunkB } = makeFixtures();
      const oldDeferred = createDeferred<readonly Artifact[]>();

      interface SerializerInvocation {
        context: WriterContext;
        prepared: readonly PreparedSheet[];
        report: ExportReport;
      }
      let freshInvocation: SerializerInvocation | null = null;

      const serializer: PreparedSerializer = (context, prepared, report) => {
        if (context.sourceId === 'src_a') {
          return oldDeferred.promise;
        }
        freshInvocation = { context, prepared, report };
        const freshArtifact: Artifact = Object.freeze({
          filename: 'Fresh.csv',
          mimeType: 'text/csv',
          data: new Uint8Array([49, 50, 51]),
          byteLength: 3,
          safeSummary: 'Fresh CSV'
        });
        return Object.freeze([freshArtifact]);
      };

      const writer = createBufferedWriter('csv', defaultOpts, serializer);

      await writer.begin(ctxA, signal);
      await writer.append(chunkA, signal);

      // Start old finalize; serializer holds deferred promise
      const oldFinalize = writer.finalize(repA, signal);
      let oldErr: any = null;
      const oldObserver = oldFinalize.catch(err => { oldErr = err; });

      // Synchronously abort and begin fresh session
      const abortPromise = writer.abort();
      const beginPromise = writer.begin(ctxB, signal);
      await abortPromise;
      await beginPromise;
      await writer.append(chunkB, signal);

      const freshFinalize = writer.finalize(repB, signal);

      // Reject old serializer (late failure with hostile error text)
      oldDeferred.reject(new Error('hostile serializer crash detail'));

      await oldObserver;
      expect(oldErr).toBeInstanceOf(DomainError);
      expect(oldErr.code).toBe('INTERNAL_ERROR');
      expect(oldErr.message).not.toContain('hostile serializer crash detail');

      // Fresh finalize succeeds unaffected by old failure
      const freshArtifacts = await freshFinalize;
      expect(freshArtifacts).toHaveLength(1);
      expect(freshArtifacts[0].filename).toBe('Fresh.csv');

      // Verify actual fresh context/cells fixture
      expect(freshInvocation).not.toBeNull();
      expect(freshInvocation!.context.sourceId).toBe('src_b');
      expect(freshInvocation!.context.title).toBe('Fresh Workbook B');
      expect(freshInvocation!.prepared).toHaveLength(1);
      expect(freshInvocation!.prepared[0].cells).toEqual([
        { r: 5, c: 2, kind: 'number', value: 999 }
      ]);
    });
  });

  describe('Group 2: Repeated finalize and phase negatives', () => {
    it('enforces strict phase transitions: rejects operations out of order or repeated finalize', async () => {
      const { ctxA, repA, chunkA } = makeFixtures();
      const dummyArtifact: Artifact = Object.freeze({
        filename: 'out.csv',
        mimeType: 'text/csv',
        data: new Uint8Array([]),
        byteLength: 0,
        safeSummary: 'test'
      });
      const serializer: PreparedSerializer = () => Object.freeze([dummyArtifact]);
      const writer = createBufferedWriter('csv', defaultOpts, serializer);

      // append / finalize before begin
      await expect(writer.append(chunkA, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
      await expect(writer.finalize(repA, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

      // begin transitions to open
      await writer.begin(ctxA, signal);
      // duplicate begin while open rejects
      await expect(writer.begin(ctxA, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

      // Re-begin valid session
      await writer.begin(ctxA, signal);
      await writer.append(chunkA, signal);

      // finalize transitions to finalizing then idle
      const arts = await writer.finalize(repA, signal);
      expect(arts).toHaveLength(1);

      // repeated finalize after completion rejects
      await expect(writer.finalize(repA, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

      // append after finalize rejects
      await expect(writer.append(chunkA, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

      // abort resets to idle
      await writer.abort();
      await expect(writer.append(chunkA, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
    });

    it('rejects concurrent second finalize call while first finalize is running', async () => {
      const { ctxA, repA, chunkA } = makeFixtures();
      const deferred = createDeferred<readonly Artifact[]>();
      const serializer: PreparedSerializer = () => deferred.promise;
      const writer = createBufferedWriter('csv', defaultOpts, serializer);

      await writer.begin(ctxA, signal);
      await writer.append(chunkA, signal);

      const finalize1 = writer.finalize(repA, signal);
      let finalize1Err: any = null;
      finalize1.catch(err => { finalize1Err = err; });

      // Concurrent second finalize on the same session while phase is finalizing
      await expect(writer.finalize(repA, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

      // Resolve first finalize promise
      const dummyArtifact: Artifact = Object.freeze({
        filename: 'out.csv',
        mimeType: 'text/csv',
        data: new Uint8Array([]),
        byteLength: 0,
        safeSummary: 'test'
      });
      deferred.resolve(Object.freeze([dummyArtifact]));

      await expect(finalize1).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
      expect(finalize1Err).toBeInstanceOf(DomainError);
    });
  });

  describe('Group 3: Config, options, and callback throws safety', () => {
    const dummySerializer: PreparedSerializer = () => [];

    it('validates format, options limits, and non-function serializer with static CONFIG_INVALID', () => {
      // Invalid format
      expect(() => createBufferedWriter('unsupported' as any, defaultOpts, dummySerializer))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      const hostileFormat = {
        toString() { throw new Error('hostile format text'); }
      };
      expect(() => createBufferedWriter(hostileFormat as any, defaultOpts, dummySerializer))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));

      // Invalid options object
      expect(() => createBufferedWriter('csv', null as any, dummySerializer))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      expect(() => createBufferedWriter('csv', [] as any, dummySerializer))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));

      // Options limits: min/max bounds and negative zero
      expect(() => createBufferedWriter('csv', { ...defaultOpts, maxChunks: 0 }, dummySerializer))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      expect(() => createBufferedWriter('csv', { ...defaultOpts, maxChunks: PROVISIONAL_MAX_CHUNKS + 1 }, dummySerializer))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      expect(() => createBufferedWriter('csv', { ...defaultOpts, maxCells: -1 }, dummySerializer))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      expect(() => createBufferedWriter('csv', { ...defaultOpts, maxCells: -0 }, dummySerializer))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      expect(() => createBufferedWriter('csv', { ...defaultOpts, maxIntervals: -1 }, dummySerializer))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      expect(() => createBufferedWriter('csv', { ...defaultOpts, maxDecodedBytes: -1 }, dummySerializer))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));

      // Hostile getter on options
      const hostileOpts = {
        get maxChunks(): number { throw new Error('hostile option message'); },
        maxCells: 10, maxIntervals: 10, maxDecodedBytes: 10
      };
      try {
        createBufferedWriter('csv', hostileOpts as any, dummySerializer);
        expect.fail('should throw');
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_INVALID');
        expect(err.message).not.toContain('hostile option message');
      }

      // Invalid serializer
      expect(() => createBufferedWriter('csv', defaultOpts, null as any))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      expect(() => createBufferedWriter('csv', defaultOpts, 42 as any))
        .toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    });

    it('safely catches synchronous throws and asynchronous rejections in serializer callback', async () => {
      const { ctxA, repA, chunkA } = makeFixtures();

      // Synchronous throw in serializer
      const syncThrowSerializer: PreparedSerializer = () => {
        throw new Error('hostile sync serializer exception');
      };
      const syncWriter = createBufferedWriter('csv', defaultOpts, syncThrowSerializer);
      await syncWriter.begin(ctxA, signal);
      await syncWriter.append(chunkA, signal);

      let syncErr: any = null;
      await syncWriter.finalize(repA, signal).catch(err => { syncErr = err; });
      expect(syncErr).toBeInstanceOf(DomainError);
      expect(syncErr.code).toBe('INTERNAL_ERROR');
      expect(syncErr.message).not.toContain('hostile sync serializer exception');

      // Session reset allows recovery
      await syncWriter.begin(ctxA, signal);
      await syncWriter.abort();

      // Asynchronous rejection with DomainError
      const asyncDomainErrSerializer: PreparedSerializer = () => {
        return Promise.reject(new DomainError('FORMAT_SERIALIZATION_FAILED'));
      };
      const asyncWriter = createBufferedWriter('csv', defaultOpts, asyncDomainErrSerializer);
      await asyncWriter.begin(ctxA, signal);
      await asyncWriter.append(chunkA, signal);

      await expect(asyncWriter.finalize(repA, signal)).rejects.toMatchObject({
        code: 'FORMAT_SERIALIZATION_FAILED'
      });

      // Session reset allows recovery
      await asyncWriter.begin(ctxA, signal);
      await asyncWriter.abort();
    });
  });

  describe('Group 4: Cancellation after await and no private artifacts returned', () => {
    it('cancellation during await: finalize rejects OPERATION_ABORTED and does not return private staged artifacts', async () => {
      const { ctxA, repA, chunkA, ctxB, repB, chunkB } = makeFixtures();
      const deferred = createDeferred<readonly Artifact[]>();

      const secretArtifact: Artifact = Object.freeze({
        filename: 'secret.csv',
        mimeType: 'text/csv',
        data: new Uint8Array([1, 2, 3]),
        byteLength: 3,
        safeSummary: 'private secret artifact'
      });

      const serializer: PreparedSerializer = (context) => {
        if (context.sourceId === 'src_a') {
          return deferred.promise;
        }
        return Object.freeze([{
          filename: 'Fresh.csv',
          mimeType: 'text/csv',
          data: new Uint8Array([]),
          byteLength: 0,
          safeSummary: 'Fresh'
        }]);
      };

      const writer = createBufferedWriter('csv', defaultOpts, serializer);
      const ac = new AbortController();

      await writer.begin(ctxA, ac.signal);
      await writer.append(chunkA, ac.signal);

      const finalizePromise = writer.finalize(repA, ac.signal);
      let finalizeErr: any = null;
      let finalizeResult: readonly Artifact[] | null = null;
      const observer = finalizePromise
        .then(res => { finalizeResult = res; })
        .catch(err => { finalizeErr = err; });

      // Cancel while serializer is pending
      ac.abort();

      // Serializer produces secret artifact after abort
      deferred.resolve(Object.freeze([secretArtifact]));

      await observer;
      expect(finalizeResult).toBeNull();
      expect(finalizeErr).toBeInstanceOf(DomainError);
      expect(finalizeErr.code).toBe('OPERATION_ABORTED');

      // Writer recovers to idle and fresh session completes
      await writer.begin(ctxB, signal);
      await writer.append(chunkB, signal);
      const freshArts = await writer.finalize(repB, signal);
      expect(freshArts).toHaveLength(1);
      expect(freshArts[0].filename).toBe('Fresh.csv');
    });

    it('hostile signal getter reentering abort()+begin() on post-await check rejects OPERATION_ABORTED without wiping fresh session', async () => {
      const { ctxA, repA, chunkA, ctxB, repB, chunkB } = makeFixtures();

      const serializer: PreparedSerializer = (context) => {
        return Object.freeze([{
          filename: `${context.title}.csv`,
          mimeType: 'text/csv',
          data: new Uint8Array([42]),
          byteLength: 1,
          safeSummary: `${context.title} summary`
        }]);
      };

      const writer = createBufferedWriter('csv', defaultOpts, serializer);

      await writer.begin(ctxA, signal);
      await writer.append(chunkA, signal);

      let triggerReentry = false;
      let reentered = false;
      let freshBeginPromise: Promise<void> | null = null;

      const hostileSignal = {
        addEventListener: () => {},
        removeEventListener: () => {},
        get aborted(): boolean {
          if (triggerReentry && !reentered) {
            reentered = true;
            void writer.abort();
            freshBeginPromise = writer.begin(ctxB, signal);
            return false;
          }
          return false;
        }
      } as unknown as AbortSignal;

      let staleErr: any = null;
      const finalizePromise = writer.finalize(repA, hostileSignal).catch(err => { staleErr = err; });

      // Staging finished; arm trigger for post-await fence
      triggerReentry = true;

      await finalizePromise;
      expect(staleErr).toBeInstanceOf(DomainError);
      expect(staleErr.code).toBe('OPERATION_ABORTED');
      expect(reentered).toBe(true);

      expect(freshBeginPromise).not.toBeNull();
      await freshBeginPromise;
      await writer.append(chunkB, signal);
      const freshArts = await writer.finalize(repB, signal);

      expect(freshArts).toHaveLength(1);
      expect(freshArts[0].filename).toBe('Fresh Workbook B.csv');
    });
  });
});
