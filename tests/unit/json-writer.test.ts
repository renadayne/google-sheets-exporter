import { describe, it, expect } from 'vitest';
import type { Cell, ExportReport, NormalizedChunk } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import { isJsonExportDocument } from '../../src/contracts/validation.ts';
import { createJsonWriter, type JsonWriterOptions } from '../../src/export/json.ts';

const defaultOpts: JsonWriterOptions = Object.freeze({
  maxChunks: 10,
  maxCells: 1000,
  maxIntervals: 100,
  maxDecodedBytes: 1024 * 1024,
  maxWarnings: 100,
  maxBytes: 1024 * 1024
});

function makeFixture() {
  const meta1 = { id: 10, title: 'Data', index: 0, type: 'GRID', hidden: false, rows: 90001, columns: 26 };
  const meta2 = { id: 20, title: 'Empty', index: 1, type: 'GRID', hidden: false, rows: 10, columns: 10 };
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

function makeFreshFixture() {
  const meta = { id: 10, title: 'FreshData', index: 0, type: 'GRID', hidden: false, rows: 10, columns: 10 };
  const scope = { sheetId: 10, rect: { sheetId: 10, r0: 0, c0: 0, r1: 10, c1: 10 } };
  const ctx: WriterContext = {
    sourceId: 'src_fresh', title: 'Fresh Workbook', locale: 'en_US', timeZone: 'UTC',
    scopes: [scope], mode: 'raw', format: 'json', visibility: 'include_all',
    limitsVersion: '1.0', sheetOrder: [10], sheets: [meta]
  };
  const rep: ExportReport = {
    schemaVersion: '1.0',
    source: { id: 'src_fresh', title: 'Fresh Workbook', locale: 'en_US', timeZone: 'UTC' },
    export: {
      startedAt: '2026-11-01T00:00:00.000Z', producedAt: '2026-11-01T00:01:00.000Z',
      mode: 'raw', format: 'json', visibility: 'include_all', complete: true,
      consistency: 'not_atomic_no_change_detected', warnings: []
    },
    selectedScopes: [scope], sheetOrder: [10], limitsVersion: '1.0',
    nameMappings: [{ sheetId: 10, originalTitle: 'FreshData', exportedName: 'FreshData' }],
    exclusions: []
  };
  const chunk: NormalizedChunk = {
    jobId: 'fresh_job_1', chunkId: 'fresh_chunk_1', rect: { sheetId: 10, r0: 0, c0: 0, r1: 10, c1: 10 },
    cells: [{ r: 0, c: 0, kind: 'string', value: 'fresh_data' }],
    excludedIntervals: { rows: [], columns: [] }, byteCount: 32
  };
  return { ctx, rep, chunk };
}

describe('T24c1c JSON WriterPort lifecycle and private artifact staging', () => {
  const signal = new AbortController().signal;

  it('successful export: 2 tabs, 3 chunks, A1/D50/Z90000 + empty tab, input immutability, parse & isJsonExportDocument', async () => {
    const { ctx, rep, chunk1, chunk2, chunk3 } = makeFixture();
    const writer = createJsonWriter(defaultOpts);

    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    await writer.append(chunk2, signal);
    await writer.append(chunk3, signal);

    (ctx as any).title = 'MUTATED';
    (chunk1.cells as Cell[]).push({ r: 1, c: 1, kind: 'string', value: 'LEAK' });

    const artifacts = await writer.finalize(rep, signal);
    expect(artifacts).toHaveLength(1);
    const art = artifacts[0];
    expect(Object.isFrozen(artifacts) && Object.isFrozen(art)).toBe(true);
    expect(Object.isFrozen(art.data)).toBe(false);
    expect(art.filename).toBe('Test Workbook.json');
    expect(art.mimeType).toBe('application/json');
    expect(art.byteLength).toBe((art.data as Uint8Array).byteLength);
    expect(art.safeSummary).toBe('JSON export document');

    const json = JSON.parse(new TextDecoder().decode(art.data as Uint8Array));
    expect(isJsonExportDocument(json)).toBe(true);
    expect(json.source.title).toBe('Test Workbook');
    expect(json.sheets).toHaveLength(2);
    expect(json.sheets[0].cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: '00123' },
      { r: 49, c: 3, kind: 'string', value: 'middle' },
      { r: 89999, c: 25, kind: 'number', value: 42 }
    ]);
    expect(json.sheets[1].cells).toEqual([]);
  });

  it('order and state negatives: before begin, duplicate begin, append after finalize', async () => {
    const { ctx, rep, chunk1 } = makeFixture();
    const writer = createJsonWriter(defaultOpts);

    await expect(writer.append(chunk1, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
    await expect(writer.finalize(rep, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

    await writer.begin(ctx, signal);
    await expect(writer.begin(ctx, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    await writer.abort();
    await expect(writer.append(chunk1, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
  });

  it('duplicate chunk IDs and mixed jobs reject with FORMAT_SERIALIZATION_FAILED', async () => {
    const { ctx, chunk1, chunk2 } = makeFixture();
    const writer = createJsonWriter(defaultOpts);

    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    await expect(writer.append(chunk1, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    const mixedJobChunk = { ...chunk2, jobId: 'different_job' };
    await expect(writer.append(mixedJobChunk, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
  });

  it('missing coverage or invalid report yields no artifact, fresh begin recovers', async () => {
    const { ctx, rep, chunk1, chunk2, chunk3 } = makeFixture();
    const writer = createJsonWriter(defaultOpts);

    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    await expect(writer.finalize(rep, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    await writer.append(chunk2, signal);
    await writer.append(chunk3, signal);
    const badReport = { ...rep, export: { ...rep.export, complete: false } };
    await expect(writer.finalize(badReport as any, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    await writer.append(chunk2, signal);
    await writer.append(chunk3, signal);
    const arts = await writer.finalize(rep, signal);
    expect(arts).toHaveLength(1);
    await expect(writer.append(chunk1, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });
  });

  it('enforces aggregate budgets: maxChunks, maxCells, maxIntervals, maxDecodedBytes, maxWarnings, maxBytes', async () => {
    const { ctx, rep, chunk1, chunk2, chunk3 } = makeFixture();

    const wChunks = createJsonWriter({ ...defaultOpts, maxChunks: 2 });
    await wChunks.begin(ctx, signal);
    await wChunks.append(chunk1, signal);
    await wChunks.append(chunk2, signal);
    await expect(wChunks.append(chunk3, signal)).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' });

    const wCells = createJsonWriter({ ...defaultOpts, maxCells: 2 });
    await wCells.begin(ctx, signal);
    await wCells.append(chunk1, signal);
    await expect(wCells.append(chunk2, signal)).rejects.toMatchObject({ code: 'CELL_LIMIT_EXCEEDED' });

    const apiVisibleCtx: WriterContext = { ...ctx, visibility: 'api_visible' };
    const wInt = createJsonWriter({ ...defaultOpts, maxIntervals: 1 });
    await wInt.begin(apiVisibleCtx, signal);
    const chunkInt1: NormalizedChunk = {
      ...chunk1,
      excludedIntervals: { rows: [{ start: 1, end: 2 }], columns: [] }
    };
    const chunkInt2: NormalizedChunk = {
      ...chunk2,
      excludedIntervals: { rows: [{ start: 50001, end: 50002 }], columns: [] }
    };
    await wInt.append(chunkInt1, signal);
    await expect(wInt.append(chunkInt2, signal)).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' });

    const wDecoded = createJsonWriter({ ...defaultOpts, maxDecodedBytes: 100 });
    await wDecoded.begin(ctx, signal);
    await wDecoded.append(chunk1, signal);
    await expect(wDecoded.append(chunk2, signal)).rejects.toMatchObject({ code: 'BYTE_LIMIT_EXCEEDED' });

    const wWarn = createJsonWriter({ ...defaultOpts, maxWarnings: 1 });
    await wWarn.begin(ctx, signal);
    await wWarn.append(chunk1, signal);
    await wWarn.append(chunk2, signal);
    await wWarn.append(chunk3, signal);
    const repWarn = { ...rep, export: { ...rep.export, warnings: [{ code: 'W1', message: 'm1' }, { code: 'W2', message: 'm2' }] } };
    await expect(wWarn.finalize(repWarn, signal)).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' });

    const wBytes = createJsonWriter({ ...defaultOpts, maxBytes: 50 });
    await wBytes.begin(ctx, signal);
    await wBytes.append(chunk1, signal);
    await wBytes.append(chunk2, signal);
    await wBytes.append(chunk3, signal);
    await expect(wBytes.finalize(rep, signal)).rejects.toMatchObject({ code: 'BYTE_LIMIT_EXCEEDED' });
  });

  it('propagates known source changes and produces independent buffers across runs', async () => {
    const { ctx, rep, chunk1, chunk2, chunk3 } = makeFixture();
    const writer = createJsonWriter(defaultOpts);

    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    await writer.append(chunk2, signal);
    await writer.append(chunk3, signal);
    const repChanged = { ...rep, export: { ...rep.export, consistency: 'not_atomic_changes_detected' as const } };
    await expect(writer.finalize(repChanged, signal)).rejects.toMatchObject({ code: 'SOURCE_CHANGED_CONCURRENTLY' });

    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    await writer.append(chunk2, signal);
    await writer.append(chunk3, signal);
    const res1 = await writer.finalize(rep, signal);

    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    await writer.append(chunk2, signal);
    await writer.append(chunk3, signal);
    const res2 = await writer.finalize(rep, signal);

    expect(res1[0].data).not.toBe(res2[0].data);
    expect(res1[0]).not.toBe(res2[0]);
    expect(res1[0].byteLength).toBe(res2[0].byteLength);
    expect(res1[0].data).toEqual(res2[0].data);
  });

  it('required race: abort and begin called synchronously during pending finalize, old rejects without wiping fresh session', async () => {
    const { ctx: oldCtx, rep: oldRep, chunk1, chunk2, chunk3 } = makeFixture();
    const { ctx: freshCtx, rep: freshRep, chunk: freshChunk } = makeFreshFixture();
    const writer = createJsonWriter(defaultOpts);

    await writer.begin(oldCtx, signal);
    await writer.append(chunk1, signal);
    await writer.append(chunk2, signal);
    await writer.append(chunk3, signal);

    const pendingFinalize = writer.finalize(oldRep, signal);
    let oldErr: any = null;
    const observer = pendingFinalize.catch(err => { oldErr = err; });

    // Synchronously invoke abort() and begin(freshCtx) without awaiting between them
    const abortPromise = writer.abort();
    const beginPromise = writer.begin(freshCtx, signal);

    await abortPromise;
    await beginPromise;
    await writer.append(freshChunk, signal);
    const freshArts = await writer.finalize(freshRep, signal);

    await observer;
    expect(oldErr).toBeInstanceOf(DomainError);
    expect(oldErr.code).toBe('OPERATION_ABORTED');

    expect(freshArts).toHaveLength(1);
    expect(freshArts[0].filename).toBe('Fresh Workbook.json');
    const freshDoc = JSON.parse(new TextDecoder().decode(freshArts[0].data as Uint8Array));
    expect(isJsonExportDocument(freshDoc)).toBe(true);
    expect(freshDoc.source.title).toBe('Fresh Workbook');
    expect(freshDoc.sheets[0].cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: 'fresh_data' }
    ]);
  });

  it('synchronous reentrant begin-context getter calling abort()+begin: stale rejects OPERATION_ABORTED and fresh session exports', async () => {
    const { ctx: baseCtx } = makeFixture();
    const { ctx: freshCtx, rep: freshRep, chunk: freshChunk } = makeFreshFixture();
    const writer = createJsonWriter(defaultOpts);

    let reentered = false;
    let freshBeginPromise: Promise<void> | null = null;
    const hostileCtx: WriterContext = {
      ...baseCtx,
      get title(): string {
        if (!reentered) {
          reentered = true;
          void writer.abort();
          freshBeginPromise = writer.begin(freshCtx, signal);
        }
        return 'Hostile Title';
      }
    };

    let staleErr: any = null;
    const stalePromise = writer.begin(hostileCtx, signal).catch(err => { staleErr = err; });

    await stalePromise;
    expect(staleErr).toBeInstanceOf(DomainError);
    expect(staleErr.code).toBe('OPERATION_ABORTED');

    expect(freshBeginPromise).not.toBeNull();
    await freshBeginPromise;
    await writer.append(freshChunk, signal);
    const freshArts = await writer.finalize(freshRep, signal);

    expect(freshArts).toHaveLength(1);
    const doc = JSON.parse(new TextDecoder().decode(freshArts[0].data as Uint8Array));
    expect(doc.source.title).toBe('Fresh Workbook');
  });

  it('synchronous reentrant append-cell getter calling abort()+begin: stale rejects OPERATION_ABORTED and fresh session exports', async () => {
    const { ctx: oldCtx, chunk1 } = makeFixture();
    const { ctx: freshCtx, rep: freshRep, chunk: freshChunk } = makeFreshFixture();
    const writer = createJsonWriter(defaultOpts);

    await writer.begin(oldCtx, signal);

    let reentered = false;
    let freshBeginPromise: Promise<void> | null = null;
    const hostileCell: Cell = {
      r: 0, c: 0, kind: 'string',
      get value(): string {
        if (!reentered) {
          reentered = true;
          void writer.abort();
          freshBeginPromise = writer.begin(freshCtx, signal);
        }
        return 'hostile_cell_value';
      }
    };
    const hostileChunk: NormalizedChunk = {
      ...chunk1,
      cells: [hostileCell]
    };

    let staleErr: any = null;
    const stalePromise = writer.append(hostileChunk, signal).catch(err => { staleErr = err; });

    await stalePromise;
    expect(staleErr).toBeInstanceOf(DomainError);
    expect(staleErr.code).toBe('OPERATION_ABORTED');

    expect(freshBeginPromise).not.toBeNull();
    await freshBeginPromise;
    await writer.append(freshChunk, signal);
    const freshArts = await writer.finalize(freshRep, signal);

    expect(freshArts).toHaveLength(1);
    const doc = JSON.parse(new TextDecoder().decode(freshArts[0].data as Uint8Array));
    expect(doc.source.title).toBe('Fresh Workbook');
  });

  it('final signal getter reentry after staging: stale rejects OPERATION_ABORTED and does not wipe fresh session', async () => {
    const { ctx: oldCtx, rep: oldRep, chunk1, chunk2, chunk3 } = makeFixture();
    const { ctx: freshCtx, rep: freshRep, chunk: freshChunk } = makeFreshFixture();
    const writer = createJsonWriter(defaultOpts);

    await writer.begin(oldCtx, signal);
    await writer.append(chunk1, signal);
    await writer.append(chunk2, signal);
    await writer.append(chunk3, signal);

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
          freshBeginPromise = writer.begin(freshCtx, signal);
          return false;
        }
        return false;
      }
    } as unknown as AbortSignal;

    let staleErr: any = null;
    const finalizePromise = writer.finalize(oldRep, hostileSignal).catch(err => { staleErr = err; });

    // Staging completed synchronously; arm trigger for post-staging check
    triggerReentry = true;

    await finalizePromise;
    expect(staleErr).toBeInstanceOf(DomainError);
    expect(staleErr.code).toBe('OPERATION_ABORTED');
    expect(reentered).toBe(true);

    expect(freshBeginPromise).not.toBeNull();
    await freshBeginPromise;
    await writer.append(freshChunk, signal);
    const freshArts = await writer.finalize(freshRep, signal);

    expect(freshArts).toHaveLength(1);
    const doc = JSON.parse(new TextDecoder().decode(freshArts[0].data as Uint8Array));
    expect(doc.source.title).toBe('Fresh Workbook');
  });

  it('rejects context when raw format getter returns non-json during snapshot', async () => {
    const { ctx: baseCtx } = makeFixture();
    const writer = createJsonWriter(defaultOpts);

    let calls = 0;
    const changingFormatCtx: WriterContext = {
      ...baseCtx,
      get format(): any {
        calls++;
        return calls === 1 ? 'json' : 'csv';
      }
    };

    // Caller observation saw 'json' initially, but format changes to 'csv' during snapshot
    expect(changingFormatCtx.format).toBe('json');
    await expect(writer.begin(changingFormatCtx, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

    // Directly non-json format also rejected
    const csvCtx: WriterContext = { ...baseCtx, format: 'csv' as any };
    await expect(writer.begin(csvCtx, signal)).rejects.toMatchObject({ code: 'FORMAT_SERIALIZATION_FAILED' });

    // Only the value captured by the validated snapshot may select the format.
    // A raw pre-read followed by another snapshot read would observe two values.
    let snapshotReads = 0;
    const singleReadCtx: WriterContext = {
      ...baseCtx,
      get format(): 'json' | 'csv' { return ++snapshotReads === 1 ? 'json' : 'csv'; }
    };
    await writer.begin(singleReadCtx, signal);
    expect(snapshotReads).toBe(1);
    await writer.abort();

    // Writer recovers to idle and can begin valid context
    await writer.begin(baseCtx, signal);
    await writer.abort();
  });

  it('explicit pre-aborted begin and append clean up and allow immediate session recovery', async () => {
    const { ctx, rep, chunk1, chunk2, chunk3 } = makeFixture();
    const writer = createJsonWriter(defaultOpts);

    const preAborted = new AbortController();
    preAborted.abort();

    // Pre-aborted begin rejects and resets session
    await expect(writer.begin(ctx, preAborted.signal)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });

    // Session recovery: can begin, append, finalize normally
    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);

    // Pre-aborted append rejects and resets session
    await expect(writer.append(chunk2, preAborted.signal)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });

    // Session recovery: can begin fresh session and export
    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    await writer.append(chunk2, signal);
    await writer.append(chunk3, signal);
    const arts = await writer.finalize(rep, signal);
    expect(arts).toHaveLength(1);
    expect(arts[0].filename).toBe('Test Workbook.json');
  });

  it('signal cancellation at staging yield and abort idempotency', async () => {
    const { ctx, rep, chunk1, chunk2, chunk3 } = makeFixture();
    const writer = createJsonWriter(defaultOpts);

    const ac = new AbortController();
    await writer.begin(ctx, signal);
    await writer.append(chunk1, signal);
    await writer.append(chunk2, signal);
    await writer.append(chunk3, signal);

    const p = writer.finalize(rep, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });

    await writer.abort();
    await writer.abort();
    await writer.abort();
  });

  it('validates config: rejects invalid budgets, negative zero, and hostile getters with static CONFIG_INVALID', () => {
    expect(() => createJsonWriter(null as any)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => createJsonWriter({ ...defaultOpts, maxChunks: 0 })).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => createJsonWriter({ ...defaultOpts, maxChunks: 5000 })).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => createJsonWriter({ ...defaultOpts, maxCells: -1 })).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => createJsonWriter({ ...defaultOpts, maxCells: -0 })).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    const hostile = {
      get maxChunks(): number { throw new Error('hostile error text'); },
      maxCells: 10, maxIntervals: 10, maxDecodedBytes: 10, maxWarnings: 10, maxBytes: 10
    };
    try {
      createJsonWriter(hostile as any);
      expect.fail('should throw');
    } catch (err: any) {
      expect(err.code).toBe('CONFIG_INVALID');
      expect(err.message).not.toContain('hostile error text');
    }
  });
});
