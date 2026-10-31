import { describe, it, expect } from 'vitest';
import type {
  AuthPort,
  PermissionPort,
  SheetsPort,
  SourceObservationPort,
  WriterPort,
  DownloadPort,
  DownloadResult
} from '../../src/contracts/ports.ts';
import type { NormalizedChunk, Eligibility, Artifact } from '../../src/contracts/domain.ts';
import { createDeferred } from '../helpers/deterministic.ts';
import {
  createSyntheticAccountContext,
  createSyntheticPermittedEligibility,
  createCanonicalSourceRef,
  createCanonicalWorkbookMeta,
  createCanonicalWriterContext,
  createCanonicalExportReport
} from '../helpers/fixtures.ts';
import {
  createFakeAuthPort,
  createFakePermissionPort,
  createFakeSheetsPort,
  createFakeSourceObservationPort,
  createFakeWriterPort,
  createFakeDownloadPort,
  type EventLog
} from '../helpers/fake-ports.ts';

describe('T10c Scripted Fake Ports', () => {
  it('preserves scripted denial, source changes and auth lifecycle without inventing policy', async () => {
    const signal = new AbortController().signal;
    const source = createCanonicalSourceRef();
    const account = createSyntheticAccountContext();
    const permitted = createSyntheticPermittedEligibility();
    const restricted: Eligibility = { status: 'restricted', reasonCode: 'SYNTHETIC_DENIAL', checkedAt: permitted.checkedAt };
    const permission = createFakePermissionPort();
    permission.checkQueue.enqueueValue(permitted).enqueueValue(restricted);
    expect(await permission.check(source, account, signal)).toBe(permitted);
    expect(await permission.check(source, account, signal)).toBe(restricted);
    const observation = createFakeSourceObservationPort();
    const before = { observedAt: permitted.checkedAt, version: '1' };
    const after = { observedAt: permitted.checkedAt, version: '2' };
    observation.observeQueue.enqueueValue(before).enqueueValue(after);
    expect(await observation.observe(source, permitted, signal)).toBe(before);
    expect(await observation.observe(source, permitted, signal)).toBe(after);
    const auth = createFakeAuthPort();
    auth.signInQueue.enqueueValue(account);
    auth.signOutQueue.enqueueValue(undefined);
    expect(await auth.signIn(signal)).toBe(account);
    await auth.signOut(signal);
    expect(auth.calls.map(call => call.method)).toEqual(['signIn', 'signOut']);
  });
  it('assigns to contracts, yields FIFO outcomes, and forwards arguments', async () => {
    const auth: AuthPort = createFakeAuthPort();
    const fakeAuth = auth as ReturnType<typeof createFakeAuthPort>;
    const account1 = createSyntheticAccountContext();
    const account2 = { ...account1, principalKey: 'principal-2' };
    const deferredToken = createDeferred<string>();

    fakeAuth.getContextQueue.enqueueValue(account1).enqueueValue(account2);
    fakeAuth.getTokenQueue.enqueueDeferred(deferredToken).enqueueError(new Error('token expired'));

    const signal = new AbortController().signal;
    expect(await auth.getContext(signal)).toBe(account1);
    expect(await auth.getContext(signal)).toBe(account2);

    const pendingToken = auth.getToken('principal-1', signal);
    deferredToken.resolve('synthetic-token-val');
    expect(await pendingToken).toBe('synthetic-token-val');
    await expect(auth.getToken('principal-1', signal)).rejects.toThrow('token expired');

    expect(fakeAuth.calls.map((c) => c.method)).toEqual(['getContext', 'getContext', 'getToken', 'getToken']);
    expect(fakeAuth.calls[2]).toEqual({ method: 'getToken', expectedPrincipalKey: 'principal-1', signal });
  });

  it('fails when unconfigured and forwards explicitly scripted metadata and unknown payloads', async () => {
    const fake = createFakeSheetsPort();
    const sheets: SheetsPort = fake;
    const source = createCanonicalSourceRef();
    const permitted = createSyntheticPermittedEligibility();
    const signal = new AbortController().signal;

    await expect(sheets.getMetadata(source, permitted, signal)).rejects.toThrow(/queue exhausted at call 1/);

    const metadata = createCanonicalWorkbookMeta();
    const transport = { payload: { synthetic: 'deliberately unvalidated' }, byteCount: 37 };
    const rect = { sheetId: 101, r0: 0, c0: 0, r1: 1, c1: 1 };
    fake.getMetadataQueue.enqueueValue(metadata);
    fake.readGridQueue.enqueueValue(transport);
    expect(await sheets.getMetadata(source, permitted, signal)).toBe(metadata);
    expect(await sheets.readGrid(source, permitted, rect, signal)).toBe(transport);
    expect(fake.calls[2]).toEqual({ method: 'readGrid', source, permitted, rect, signal });
  });

  it('honors pre-aborted and mid-await cancel, ignoring late results', async () => {
    const perm: PermissionPort = createFakePermissionPort();
    const fakePerm = perm as ReturnType<typeof createFakePermissionPort>;
    const deferred = createDeferred<Eligibility>();
    fakePerm.checkQueue.enqueueDeferred(deferred);

    const preAborted = AbortSignal.abort(new DOMException('Pre-aborted', 'AbortError'));
    await expect(perm.check(createCanonicalSourceRef(), createSyntheticAccountContext(), preAborted)).rejects.toThrow(
      'Pre-aborted'
    );
    expect(fakePerm.checkQueue.remaining).toBe(1);

    const ac = new AbortController();
    const inFlight = perm.check(createCanonicalSourceRef(), createSyntheticAccountContext(), ac.signal);
    ac.abort();
    await expect(inFlight).rejects.toThrow('This operation was aborted');

    deferred.resolve(createSyntheticPermittedEligibility());
    expect(fakePerm.calls.length).toBe(2);
  });

  it('handles writer lifecycle, cancel on finalize, and abort without signal', async () => {
    const writer: WriterPort = createFakeWriterPort();
    const fakeWriter = writer as ReturnType<typeof createFakeWriterPort>;
    const deferredFinalize = createDeferred<readonly Artifact[]>();
    fakeWriter.beginQueue.enqueueValue(undefined);
    fakeWriter.appendQueue.enqueueValue(undefined);
    fakeWriter.finalizeQueue.enqueueDeferred(deferredFinalize);
    fakeWriter.abortQueue.enqueueValue(undefined);

    const ac = new AbortController();
    const ctx = createCanonicalWriterContext();
    await writer.begin(ctx, ac.signal);
    const chunk: NormalizedChunk = {
      jobId: 'job-1',
      chunkId: 'chunk-1',
      rect: { sheetId: 101, r0: 0, c0: 0, r1: 1, c1: 1 },
      cells: [],
      excludedIntervals: { rows: [], columns: [] },
      byteCount: 0
    };
    await writer.append(chunk, ac.signal);

    const finalizePromise = writer.finalize(createCanonicalExportReport(), ac.signal);
    ac.abort();
    await expect(finalizePromise).rejects.toThrow('This operation was aborted');
    deferredFinalize.resolve([]);

    await writer.abort();
    expect(fakeWriter.calls.map((c) => c.method)).toEqual(['begin', 'append', 'finalize', 'abort']);
  });

  it('keeps download calls isolated, preserves interrupted results, and logs observations', async () => {
    const d1: DownloadPort = createFakeDownloadPort();
    const d2: DownloadPort = createFakeDownloadPort();
    const fakeD1 = d1 as ReturnType<typeof createFakeDownloadPort>;
    const fakeD2 = d2 as ReturnType<typeof createFakeDownloadPort>;
    const signal = new AbortController().signal;
    const interruptedResult: DownloadResult = {
      filename: 'test.csv',
      outcome: 'interrupted',
      error: 'NETWORK_SERVER_ERROR'
    };
    fakeD1.publishQueue.enqueueValue([interruptedResult]);

    expect(fakeD1.calls.length).toBe(0);
    expect(fakeD2.calls.length).toBe(0);

    const outcome = await d1.publish([], signal);
    expect(outcome).toEqual([interruptedResult]);
    expect(fakeD1.calls.length).toBe(1);
    expect(fakeD2.calls.length).toBe(0);

    const obs: SourceObservationPort = createFakeSourceObservationPort();
    const fakeObs = obs as ReturnType<typeof createFakeSourceObservationPort>;
    const snapshot = { observedAt: '2026-10-31T00:00:00Z', version: 'v1', modifiedTime: '2026-10-30T00:00:00Z' };
    fakeObs.observeQueue.enqueueValue(snapshot);
    expect(await obs.observe(createCanonicalSourceRef(), createSyntheticPermittedEligibility(), signal)).toBe(snapshot);
  });

  it('records multi-port event log to assert final permission check precedes publish', async () => {
    const eventLog: EventLog = [];
    const perm = createFakePermissionPort({ eventLog });
    const writer = createFakeWriterPort({ eventLog });
    const download = createFakeDownloadPort({ eventLog });
    const signal = new AbortController().signal;
    const permitted = createSyntheticPermittedEligibility();
    const source = createCanonicalSourceRef();
    const account = createSyntheticAccountContext();

    perm.checkQueue.enqueueValue(permitted).enqueueValue(permitted);
    writer.beginQueue.enqueueValue(undefined);
    writer.finalizeQueue.enqueueValue([]);
    download.publishQueue.enqueueValue([{ filename: 'export.json', outcome: 'completed' }]);

    await perm.check(source, account, signal);
    await writer.begin(createCanonicalWriterContext(), signal);
    await writer.finalize(createCanonicalExportReport(), signal);
    await perm.check(source, account, signal);
    await download.publish([], signal);

    const sequence = eventLog.map((e) => `${e.port}.${e.method}`);
    expect(sequence).toEqual([
      'permission.check',
      'writer.begin',
      'writer.finalize',
      'permission.check',
      'download.publish'
    ]);
  });
});
