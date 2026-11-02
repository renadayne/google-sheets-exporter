/**
 * T30b Bounded Job Ownership and Generation Fences Helper
 *
 * Provides single-lease concurrency management, monotonic generation watermarks,
 * synchronous invalidation, reentrancy guards, and safe best-effort cleanup.
 *
 * Invariants & Guarantees:
 * 1. Exactly one active lease per owner (page).
 * 2. Generations are monotonic non-negative safe integers (0, 1, 2...). Counter is private.
 * 3. Non-empty opaque jobId primitive (preserves whitespace). Cleanup function required.
 * 4. Invalid arguments throw static DomainError('CONFIG_INVALID') BEFORE mutating active state.
 * 5. Closed owner begin throws static DomainError('OPERATION_ABORTED').
 * 6. BEGIN reserves generation and installs NEW identity BEFORE invalidating old.
 * 7. Old abort/cleanup callbacks may reenter begin/cancel/dispose: checks new identity
 *    after cleanup start and throws OPERATION_ABORTED if invalidated reentrantly.
 * 8. Reentrant begin with higher generation is never overridden by outer begin.
 * 9. Lease.assertCurrent throws new static DomainError('OPERATION_ABORTED') if not current/ended/disposed/aborted.
 * 10. Invalidate/end synchronously: detach if current, mark ended, establish shared cleanupPromise
 *     BEFORE external abort/cleanup callbacks, abort native AbortController, invoke cleanup exactly once.
 * 11. Cleanup absorbs synchronous throws and promise rejections; resolves void.
 * 12. Cleanup callback reference is cleared after capture to prevent retained memory leaks.
 * 13. Owner and lease wrappers are frozen objects with private internal records.
 */

import { DomainError } from '../contracts/errors.ts';

export interface JobLease {
  readonly jobId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly finish: () => Promise<void>;
}

export interface JobOwner {
  readonly begin: (jobId: string, cleanup: () => void | Promise<void>) => JobLease;
  readonly cancel: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

interface LeaseRecord {
  readonly jobId: string;
  readonly generation: number;
  readonly controller: AbortController;
  readonly lease: JobLease;
  cleanupFn: (() => void | Promise<void>) | null;
  isEnded: boolean;
  cleanupPromise: Promise<void> | null;
}

export function createJobOwner(): JobOwner {
  let isDisposed = false;
  let disposePromise: Promise<void> | null = null;
  let nextGeneration = 0;
  let currentLease: LeaseRecord | null = null;
  let activeCleanupPromise: Promise<void> | null = null;

  function endLease(record: LeaseRecord): Promise<void> {
    if (record.cleanupPromise !== null) {
      return record.cleanupPromise;
    }

    if (currentLease === record) {
      currentLease = null;
    }
    record.isEnded = true;

    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    record.cleanupPromise = promise;
    activeCleanupPromise = promise;

    promise.finally(() => {
      if (activeCleanupPromise === promise) {
        activeCleanupPromise = null;
      }
    });

    if (isDisposed && disposePromise === null) {
      disposePromise = promise;
    }

    if (!record.controller.signal.aborted) {
      try {
        record.controller.abort();
      } catch {
        // Observe a direct failure from abort(). Listener exceptions follow
        // the platform's event dispatch rules.
      }
    }

    const fn = record.cleanupFn;
    record.cleanupFn = null;

    if (fn !== null) {
      void (async () => {
        try { await fn(); }
        catch { /* Best-effort cleanup; observe sync throws and rejections. */ }
        finally { resolvePromise(); }
      })();
    } else {
      resolvePromise();
    }

    return promise;
  }

  function begin(jobId: string, cleanup: () => void | Promise<void>): JobLease {
    if (isDisposed) {
      throw new DomainError('OPERATION_ABORTED');
    }
    if (typeof jobId !== 'string' || jobId.length === 0) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (typeof cleanup !== 'function') {
      throw new DomainError('CONFIG_INVALID');
    }

    if (nextGeneration > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(nextGeneration)) {
      throw new DomainError('INTERNAL_ERROR');
    }
    const generation = nextGeneration;
    if (generation === Number.MAX_SAFE_INTEGER) {
      nextGeneration = Infinity;
    } else {
      nextGeneration += 1;
    }

    const controller = new AbortController();
    let record!: LeaseRecord;

    const lease: JobLease = Object.freeze({
      jobId,
      generation,
      signal: controller.signal,
      assertCurrent(): void {
        if (
          isDisposed ||
          record.isEnded ||
          currentLease !== record ||
          controller.signal.aborted
        ) {
          throw new DomainError('OPERATION_ABORTED');
        }
      },
      finish(): Promise<void> {
        return endLease(record);
      },
    });

    record = {
      jobId,
      generation,
      controller,
      lease,
      cleanupFn: cleanup,
      isEnded: false,
      cleanupPromise: null,
    };

    const oldLease = currentLease;
    currentLease = record;

    if (oldLease !== null) {
      endLease(oldLease);
    }

    if (
      isDisposed ||
      record.isEnded ||
      currentLease !== record ||
      controller.signal.aborted
    ) {
      throw new DomainError('OPERATION_ABORTED');
    }

    return lease;
  }

  function cancel(): Promise<void> {
    if (currentLease !== null) {
      return endLease(currentLease);
    }
    return activeCleanupPromise ?? Promise.resolve();
  }

  function dispose(): Promise<void> {
    if (disposePromise !== null) {
      return disposePromise;
    }
    isDisposed = true;

    if (currentLease !== null) {
      const leaseToDispose = currentLease;
      const promise = endLease(leaseToDispose);
      if (disposePromise !== null) {
        return disposePromise;
      }
      disposePromise = promise;
    } else if (activeCleanupPromise !== null) {
      disposePromise = activeCleanupPromise;
    } else {
      disposePromise = Promise.resolve();
    }

    return disposePromise;
  }

  return Object.freeze({
    begin,
    cancel,
    dispose,
  });
}
