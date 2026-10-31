import type { Clock, Random } from '../../src/contracts/ports.ts';

export interface ManualClock extends Clock {
  readonly now: () => number;
  readonly set: (ms: number) => number;
  readonly advance: (ms: number) => number;
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a safe non-negative integer: ${value}`);
  }
}

export function createManualClock(initialMs = 0): ManualClock {
  assertSafeNonNegativeInteger(initialMs, 'Clock initial time');
  let currentMs = initialMs;

  return {
    now: () => currentMs,
    set: (ms: number) => {
      assertSafeNonNegativeInteger(ms, 'Clock time');
      return (currentMs = ms);
    },
    advance: (ms: number) => {
      assertSafeNonNegativeInteger(ms, 'Clock advance ms');
      const nextMs = currentMs + ms;
      assertSafeNonNegativeInteger(nextMs, 'Clock advance overflow');
      return (currentMs = nextMs);
    }
  };
}

export interface DeterministicRandom extends Random {
  readonly next: () => number;
  readonly remaining: () => number;
}

export function createDeterministicRandom(sequence: readonly number[]): DeterministicRandom {
  for (const n of sequence) {
    if (!Number.isFinite(n) || n < 0 || n >= 1) {
      throw new RangeError(`Random value must be a finite number in [0, 1): ${n}`);
    }
  }
  const values = [...sequence];
  let index = 0;

  return {
    next: () => {
      if (index >= values.length) {
        throw new Error(`Deterministic random sequence exhausted after ${index} calls`);
      }
      return values[index++]!;
    },
    remaining: () => values.length - index
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly isSettled: () => boolean;
}

export function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T | PromiseLike<T>) => void;
  let rejectFn!: (reason?: unknown) => void;
  let settled = false;

  const promise = new Promise<T>((res, rej) => {
    resolveFn = (val) => {
      if (!settled) {
        settled = true;
        res(val);
      }
    };
    rejectFn = (err) => {
      if (!settled) {
        settled = true;
        rej(err);
      }
    };
  });

  return {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
    isSettled: () => settled
  };
}

export function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      void promise.catch(() => {});
      reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export type ScriptedStep<T> = (signal?: AbortSignal | undefined) => Promise<T>;

export class AsyncResultQueue<T> {
  private readonly queue: Array<ScriptedStep<T>> = [];
  private callCount = 0;

  constructor(initialSteps?: Iterable<ScriptedStep<T>> | undefined) {
    if (initialSteps) {
      for (const step of initialSteps) {
        this.queue.push(step);
      }
    }
  }

  enqueue(step: ScriptedStep<T>): this {
    this.queue.push(step);
    return this;
  }

  enqueueValue(value: T): this {
    this.queue.push(() => Promise.resolve(value));
    return this;
  }

  enqueueError(error: unknown): this {
    this.queue.push(() => Promise.reject(error));
    return this;
  }

  enqueueDeferred(deferred: Deferred<T>): this {
    this.queue.push(() => deferred.promise);
    return this;
  }

  async next(signal?: AbortSignal | undefined): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    }

    const step = this.queue.shift();
    if (!step) {
      this.callCount++;
      throw new Error(`Scripted async queue exhausted at call ${this.callCount}`);
    }
    this.callCount++;

    const executionPromise = Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return step(signal);
    });
    return awaitWithSignal(executionPromise, signal);
  }

  get remaining(): number {
    return this.queue.length;
  }

  get consumed(): number {
    return this.callCount;
  }
}
