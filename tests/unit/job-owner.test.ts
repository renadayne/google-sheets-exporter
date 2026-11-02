/**
 * T30b Job Ownership and Generation Fences Unit Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { createJobOwner, type JobLease } from '../../src/jobs/job-owner.ts';
import { DomainError } from '../../src/contracts/errors.ts';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('T30b job ownership and generation fences', () => {
  it('adopts a cleanup thenable once and waits for its actual settlement', async () => {
    const owner = createJobOwner();
    let reads = 0;
    let release!: () => void;
    const cleanup = { get then() {
      reads++;
      if (reads !== 1) throw new Error('Unexpected then reread');
      return (resolve: () => void) => { release = resolve; };
    } } as unknown as Promise<void>;
    const lease = owner.begin('thenable-cleanup', () => cleanup);
    const finished = lease.finish();
    let settled = false;
    void finished.then(() => { settled = true; });
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(settled).toBe(false);
    expect(typeof release).toBe('function');
    release();
    await finished;
    expect(settled).toBe(true);
    expect(lease.finish()).toBe(finished);
  });
  it('group 1: generations, current guards, and invalid args do not cancel current lease', () => {
    const owner = createJobOwner();
    expect(Object.isFrozen(owner)).toBe(true);

    const cleanup0 = vi.fn();
    const lease0 = owner.begin('job-0', cleanup0);

    expect(Object.isFrozen(lease0)).toBe(true);
    expect(lease0.jobId).toBe('job-0');
    expect(lease0.generation).toBe(0);
    expect(lease0.signal.aborted).toBe(false);
    expect(() => lease0.assertCurrent()).not.toThrow();

    // Invalid arguments throw static DomainError('CONFIG_INVALID')
    expect(() => owner.begin('', () => {})).toThrowError(DomainError);
    try {
      owner.begin('', () => {});
    } catch (e) {
      expect((e as DomainError).code).toBe('CONFIG_INVALID');
    }

    expect(() => owner.begin(null as unknown as string, () => {})).toThrowError(DomainError);
    expect(() => owner.begin(undefined as unknown as string, () => {})).toThrowError(DomainError);
    expect(() => owner.begin(123 as unknown as string, () => {})).toThrowError(DomainError);
    expect(() => owner.begin({} as unknown as string, () => {})).toThrowError(DomainError);

    expect(() => owner.begin('valid-job-id', null as unknown as () => void)).toThrowError(DomainError);
    try {
      owner.begin('valid-job-id', null as unknown as () => void);
    } catch (e) {
      expect((e as DomainError).code).toBe('CONFIG_INVALID');
    }

    expect(() => owner.begin('valid-job-id', undefined as unknown as () => void)).toThrowError(DomainError);
    expect(() => owner.begin('valid-job-id', 'not-a-fn' as unknown as () => void)).toThrowError(DomainError);
    expect(() => owner.begin('valid-job-id', {} as unknown as () => void)).toThrowError(DomainError);

    // CRITICAL: lease0 is STILL current; invalid calls did not cancel, advance generation, or invoke cleanup
    expect(cleanup0).not.toHaveBeenCalled();
    expect(lease0.signal.aborted).toBe(false);
    expect(() => lease0.assertCurrent()).not.toThrow();

    // Whitespace in jobId is preserved (non-empty opaque string primitive)
    const cleanup1 = vi.fn();
    const lease1 = owner.begin('   opaque-id \t  ', cleanup1);
    expect(lease1.jobId).toBe('   opaque-id \t  ');
    expect(lease1.generation).toBe(1);
    expect(lease1.signal.aborted).toBe(false);
    expect(() => lease1.assertCurrent()).not.toThrow();

    // lease0 is now superseded and its assertCurrent throws DomainError('OPERATION_ABORTED')
    expect(() => lease0.assertCurrent()).toThrowError(DomainError);
    try {
      lease0.assertCurrent();
    } catch (e) {
      expect((e as DomainError).code).toBe('OPERATION_ABORTED');
    }

    const cleanup2 = vi.fn();
    const lease2 = owner.begin('job-2', cleanup2);
    expect(lease2.generation).toBe(2);
  });

  it('group 2: supersede aborts old lease and invokes cleanup exactly once', async () => {
    const owner = createJobOwner();
    const cleanup0 = vi.fn();
    const lease0 = owner.begin('job-0', cleanup0);

    let abortEventTriggered = false;
    lease0.signal.addEventListener('abort', () => {
      abortEventTriggered = true;
    });

    expect(cleanup0).not.toHaveBeenCalled();
    expect(lease0.signal.aborted).toBe(false);

    const cleanup1 = vi.fn();
    const lease1 = owner.begin('job-1', cleanup1);

    expect(abortEventTriggered).toBe(true);
    expect(lease0.signal.aborted).toBe(true);
    expect(cleanup0).toHaveBeenCalledTimes(1);

    expect(() => lease0.assertCurrent()).toThrowError(DomainError);
    try {
      lease0.assertCurrent();
    } catch (e) {
      expect((e as DomainError).code).toBe('OPERATION_ABORTED');
    }

    expect(lease1.generation).toBe(1);
    expect(lease1.signal.aborted).toBe(false);
    expect(cleanup1).not.toHaveBeenCalled();
    expect(() => lease1.assertCurrent()).not.toThrow();

    // Calling finish on old superseded lease does not reinvoke cleanup
    await lease0.finish();
    expect(cleanup0).toHaveBeenCalledTimes(1);
    expect(() => lease1.assertCurrent()).not.toThrow();
  });

  it('group 3: old async cleanup settling after new begin cannot clear fresh lease', async () => {
    const owner = createJobOwner();
    const deferred0 = createDeferred<void>();

    const cleanup0 = vi.fn(() => deferred0.promise);
    const lease0 = owner.begin('job-0', cleanup0);

    const cleanup1 = vi.fn();
    const lease1 = owner.begin('job-1', cleanup1);

    expect(cleanup0).toHaveBeenCalledTimes(1);
    expect(lease0.signal.aborted).toBe(true);

    // Lease 1 is current while Lease 0 cleanup is still pending
    expect(lease1.signal.aborted).toBe(false);
    expect(() => lease1.assertCurrent()).not.toThrow();

    // Now resolve Lease 0 async cleanup
    deferred0.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Lease 1 must remain completely unaffected after Lease 0 settles
    expect(lease1.signal.aborted).toBe(false);
    expect(() => lease1.assertCurrent()).not.toThrow();
    expect(cleanup1).not.toHaveBeenCalled();
  });

  it('group 4: reentry from old abort callback or cleanup starts new generation and outer begin fails', () => {
    // Subcase 4A: Reentry from old lease's signal abort event listener
    const ownerA = createJobOwner();
    let reentrantLeaseA: JobLease | null = null;
    const cleanupA0 = vi.fn();

    const leaseA0 = ownerA.begin('job-A0', cleanupA0);
    leaseA0.signal.addEventListener('abort', () => {
      // Reentrantly begin during invalidation of old lease
      reentrantLeaseA = ownerA.begin('reentrant-job-A2', vi.fn());
    });

    // Outer begin allocates generation 1, supersedes A0, but A0 abort triggers reentrant begin (generation 2)
    let outerThrewA = false;
    try {
      ownerA.begin('outer-job-A1', vi.fn());
    } catch (err) {
      outerThrewA = true;
      expect((err as DomainError).code).toBe('OPERATION_ABORTED');
    }
    expect(outerThrewA).toBe(true);

    // Reentrant lease (generation 2) must be the active current lease
    expect(reentrantLeaseA).not.toBeNull();
    expect(reentrantLeaseA!.generation).toBe(2);
    expect(reentrantLeaseA!.signal.aborted).toBe(false);
    expect(() => reentrantLeaseA!.assertCurrent()).not.toThrow();

    // Subcase 4B: Reentry from old lease's cleanup callback
    const ownerB = createJobOwner();
    let reentrantLeaseB: JobLease | null = null;

    const cleanupB0 = vi.fn(() => {
      reentrantLeaseB = ownerB.begin('reentrant-job-B2', vi.fn());
    });

    ownerB.begin('job-B0', cleanupB0);

    let outerThrewB = false;
    try {
      ownerB.begin('outer-job-B1', vi.fn());
    } catch (err) {
      outerThrewB = true;
      expect((err as DomainError).code).toBe('OPERATION_ABORTED');
    }
    expect(outerThrewB).toBe(true);

    expect(reentrantLeaseB).not.toBeNull();
    expect(reentrantLeaseB!.generation).toBe(2);
    expect(reentrantLeaseB!.signal.aborted).toBe(false);
    expect(() => reentrantLeaseB!.assertCurrent()).not.toThrow();

    // Subcase 4C: Reentry where old abort listener calls cancel
    const ownerC = createJobOwner();
    const leaseC0 = ownerC.begin('job-C0', vi.fn());
    leaseC0.signal.addEventListener('abort', () => {
      void ownerC.cancel();
    });

    let outerThrewC = false;
    try {
      ownerC.begin('outer-job-C1', vi.fn());
    } catch (err) {
      outerThrewC = true;
      expect((err as DomainError).code).toBe('OPERATION_ABORTED');
    }
    expect(outerThrewC).toBe(true);

    // A fresh begin can now succeed after cancel
    const fresh = ownerC.begin('fresh-job', vi.fn());
    expect(fresh.generation).toBe(2);
    expect(() => fresh.assertCurrent()).not.toThrow();
  });

  it('group 5: reentrant finish returns same cleanupPromise established before callback', async () => {
    const owner = createJobOwner();
    let innerPromiseAbort: Promise<void> | null = null;
    let innerPromiseCleanup: Promise<void> | null = null;
    let cleanupCalls = 0;

    let leaseHandle!: JobLease;
    const cleanup = vi.fn(() => {
      cleanupCalls++;
      innerPromiseCleanup = leaseHandle.finish();
    });

    leaseHandle = owner.begin('job-5', cleanup);
    leaseHandle.signal.addEventListener('abort', () => {
      innerPromiseAbort = leaseHandle.finish();
    });

    const outerPromise = leaseHandle.finish();

    expect(innerPromiseAbort).not.toBeNull();
    expect(innerPromiseAbort).toBe(outerPromise);

    expect(innerPromiseCleanup).not.toBeNull();
    expect(innerPromiseCleanup).toBe(outerPromise);

    expect(cleanupCalls).toBe(1);

    await outerPromise;
    expect(cleanupCalls).toBe(1);

    const afterPromise = leaseHandle.finish();
    expect(afterPromise).toBe(outerPromise);
  });

  it('group 6: cancel allows fresh begin vs dispose is permanent and idempotent', async () => {
    const owner = createJobOwner();
    const cleanup0 = vi.fn();
    const lease0 = owner.begin('job-0', cleanup0);

    // Cancel ends current lease
    await owner.cancel();
    expect(cleanup0).toHaveBeenCalledTimes(1);
    expect(lease0.signal.aborted).toBe(true);
    expect(() => lease0.assertCurrent()).toThrowError(DomainError);

    // Fresh begin succeeds after cancel
    const cleanup1 = vi.fn();
    const lease1 = owner.begin('job-1', cleanup1);
    expect(lease1.generation).toBe(1);
    expect(lease1.signal.aborted).toBe(false);
    expect(() => lease1.assertCurrent()).not.toThrow();

    // Calling cancel when no lease is active returns resolved promise
    await owner.cancel();
    expect(cleanup1).toHaveBeenCalledTimes(1);

    // Dispose permanently closes owner
    const cleanup2 = vi.fn();
    const lease2 = owner.begin('job-2', cleanup2);

    const disposePromise1 = owner.dispose();
    const disposePromise2 = owner.dispose();
    expect(disposePromise2).toBe(disposePromise1);

    await disposePromise1;
    expect(cleanup2).toHaveBeenCalledTimes(1);
    expect(lease2.signal.aborted).toBe(true);
    expect(() => lease2.assertCurrent()).toThrowError(DomainError);

    // Subsequent begin after dispose throws OPERATION_ABORTED
    expect(() => owner.begin('job-3', vi.fn())).toThrowError(DomainError);
    try {
      owner.begin('job-3', vi.fn());
    } catch (e) {
      expect((e as DomainError).code).toBe('OPERATION_ABORTED');
    }

    // Invalid args on disposed owner still throws OPERATION_ABORTED
    expect(() => owner.begin('', vi.fn())).toThrowError(DomainError);
    try {
      owner.begin('', vi.fn());
    } catch (e) {
      expect((e as DomainError).code).toBe('OPERATION_ABORTED');
    }

    // Stale handles from old leases cannot affect new owner/leases
    const ownerNew = createJobOwner();
    const freshLease = ownerNew.begin('fresh', vi.fn());
    await lease0.finish();
    await lease1.finish();
    await lease2.finish();
    expect(() => freshLease.assertCurrent()).not.toThrow();
  });

  it('group 7: sync throw and rejected cleanup observed, no source leaks, reference not recalled', async () => {
    const owner = createJobOwner();

    // Subcase 7A: Synchronous throw in cleanup
    let syncLease!: JobLease;
    syncLease = owner.begin('sync-throw-job', () => {
      throw new Error('deliberate synchronous error in cleanup');
    });

    // finish() must observe the throw, not propagate raw error, and resolve void
    await expect(syncLease.finish()).resolves.toBeUndefined();
    expect(syncLease.signal.aborted).toBe(true);
    expect(() => syncLease.assertCurrent()).toThrowError(DomainError);

    // Subcase 7B: Rejected promise in cleanup
    const asyncLease = owner.begin('async-reject-job', () => {
      return Promise.reject(new Error('deliberate async rejection in cleanup'));
    });

    // finish() must observe rejection, avoid unhandled rejection, and resolve void
    await expect(asyncLease.finish()).resolves.toBeUndefined();
    expect(asyncLease.signal.aborted).toBe(true);
    expect(() => asyncLease.assertCurrent()).toThrowError(DomainError);

    // Subcase 7C: Reference cleared after capture and not recalled
    let invocationCount = 0;
    const spyCleanup = vi.fn(() => {
      invocationCount++;
    });

    const leakCheckLease = owner.begin('leak-check-job', spyCleanup);
    await leakCheckLease.finish();
    expect(invocationCount).toBe(1);

    // Repeated finish/cancel/dispose does not recall cleanup
    await leakCheckLease.finish();
    await owner.cancel();
    await owner.dispose();
    expect(invocationCount).toBe(1);
    expect(spyCleanup).toHaveBeenCalledTimes(1);
  });
});
