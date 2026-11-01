import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DomainError } from '../../src/contracts/errors.ts';
import type { RetryOptions, AttemptOutcome } from '../../src/jobs/retry.ts';
import { runWithRetry } from '../../src/jobs/retry.ts';
import { createDeterministicRandom } from '../helpers/deterministic.ts';

function createTestOptions(overrides: Partial<RetryOptions> = {}): {
  options: RetryOptions;
  controller: AbortController;
} {
  const controller = new AbortController();
  const now = Date.now();
  const options: RetryOptions = {
    signal: controller.signal,
    clock: { now: () => Date.now() },
    random: createDeterministicRandom([0.4, 0.8, 0.2, 0.5]),
    deadlineMs: now + 300_000,
    attemptTimeoutMs: 10_000,
    ...overrides
  };
  return { options, controller };
}

describe('runWithRetry (T19b)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    // Assert all timers are cleaned up before clearAllTimers masks any leak
    expect(vi.getTimerCount()).toBe(0);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('succeeds on first attempt, passes active signal, and clears all timers', async () => {
    const { options } = createTestOptions();
    let passedSignalAborted = true;
    const op = vi.fn(async (attemptSignal: AbortSignal) => {
      passedSignalAborted = attemptSignal.aborted;
      return { kind: 'success', value: 'payload' } as const;
    });

    const result = await runWithRetry(op, options);
    expect(result).toBe('payload');
    expect(passedSignalAborted).toBe(false);
    expect(op).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles two transient failures then success with exact attempts and delays', async () => {
    const { options } = createTestOptions({ random: createDeterministicRandom([0.4, 0.8]) });
    let attempt = 0;
    const op = vi.fn(async () => {
      attempt++;
      if (attempt === 1) return { kind: 'retry', code: 'NETWORK_SERVER_ERROR' } as const;
      if (attempt === 2) return { kind: 'retry', code: 'RATE_LIMITED' } as const;
      return { kind: 'success', value: 42 } as const;
    });

    const promise = runWithRetry(op, options);
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(2200);
    const result = await promise;

    expect(result).toBe(42);
    expect(op).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces 4-attempt cap on continuous retryable errors', async () => {
    const { options } = createTestOptions({ random: createDeterministicRandom([0, 0, 0]) });
    const op = vi.fn(async () => ({ kind: 'retry', code: 'RATE_LIMITED' } as const));

    const promise = runWithRetry(op, options);
    const rejection = expect(promise).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    await rejection;
    expect(op).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops immediately when Retry-After exceeds remaining budget', async () => {
    const now = Date.now();
    const { options } = createTestOptions({ deadlineMs: now + 3000 });
    const op = vi.fn(async () => ({ kind: 'retry', code: 'RATE_LIMITED', retryAfterMs: 5000 } as const));

    await expect(runWithRetry(op, options)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(op).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['401 renew_auth', { kind: 'renew_auth', code: 'AUTH_EXPIRED' } as const, 'AUTH_EXPIRED'],
    ['404 fail', { kind: 'fail', code: 'SOURCE_NOT_FOUND' } as const, 'SOURCE_NOT_FOUND'],
    ['policy fail', { kind: 'fail', code: 'ADMIN_RESTRICTED' } as const, 'ADMIN_RESTRICTED'],
    ['daily quota fail', { kind: 'fail', code: 'QUOTA_EXCEEDED' } as const, 'QUOTA_EXCEEDED']
  ])('terminates after one attempt on %s', async (_, outcome, expectedCode) => {
    const { options } = createTestOptions();
    const op = vi.fn(async () => outcome);
    await expect(runWithRetry(op, options)).rejects.toMatchObject({ code: expectedCode });
    expect(op).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['ADMIN_RESTRICTED', 'ADMIN_RESTRICTED' as const],
    ['RESTRICTED_ACCESS', 'RESTRICTED_ACCESS' as const],
    ['QUOTA_EXCEEDED', 'QUOTA_EXCEEDED' as const]
  ])('rejects spoofed retry with deny code %s without retrying', async (_, code) => {
    const { options } = createTestOptions();
    const op = vi.fn(async () => ({ kind: 'retry', code } as const));
    await expect(runWithRetry(op, options)).rejects.toMatchObject({ code });
    expect(op).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles thrown errors safely: retries allowlist, terminates others without secret leak', async () => {
    const { options: retryOpts } = createTestOptions({ random: createDeterministicRandom([0]) });
    let count = 0;
    const retryOp = vi.fn(async () => {
      count++;
      if (count === 1) throw new DomainError('NETWORK_SERVER_ERROR');
      return { kind: 'success', value: 'recovered' } as const;
    });
    const retryPromise = runWithRetry(retryOp, retryOpts);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await retryPromise).toBe('recovered');
    expect(retryOp).toHaveBeenCalledTimes(2);

    const { options: termOpts } = createTestOptions();
    const termOp = vi.fn(async () => { throw new DomainError('ADMIN_RESTRICTED'); });
    await expect(runWithRetry(termOp, termOpts)).rejects.toMatchObject({ code: 'ADMIN_RESTRICTED' });
    expect(termOp).toHaveBeenCalledTimes(1);

    const { options: secOpts } = createTestOptions();
    const secOp = vi.fn(async () => { throw new TypeError('Connection failed: Bearer secret_token_xyz'); });
    try {
      await runWithRetry(secOp, secOpts);
      expect.unreachable('must reject');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('INTERNAL_ERROR');
      expect((err as Error).message).not.toContain('secret_token');
      expect((err as Error).message).not.toContain('Bearer');
    }
    expect(secOp).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects pre-aborted signal without invoking operation callback or consulting clock', async () => {
    let clockConsulted = false;
    const { options, controller } = createTestOptions({
      clock: {
        now: () => {
          clockConsulted = true;
          return 1_000_000;
        }
      }
    });
    controller.abort();
    const op = vi.fn(async () => ({ kind: 'success', value: 123 } as const));

    await expect(runWithRetry(op, options)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(op).not.toHaveBeenCalled();
    expect(clockConsulted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels immediately during in-flight operation and during backoff sleep', async () => {
    const { options: opOpts, controller: opCtrl } = createTestOptions();
    const pendingOp = vi.fn((attemptSignal: AbortSignal) => new Promise<AttemptOutcome<string>>((_, reject) => {
      attemptSignal.addEventListener('abort', () => reject(new DomainError('OPERATION_ABORTED')));
    }));
    const opPromise = runWithRetry(pendingOp, opOpts);
    await Promise.resolve();
    const opRejection = expect(opPromise).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    opCtrl.abort();
    await opRejection;
    expect(pendingOp).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const { options: sleepOpts, controller: sleepCtrl } = createTestOptions({
      random: createDeterministicRandom([0])
    });
    const backoffOp = vi.fn(async () => ({ kind: 'retry', code: 'RATE_LIMITED' } as const));
    const backoffPromise = runWithRetry(backoffOp, sleepOpts);
    const backoffRejection = expect(backoffPromise).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    await Promise.resolve();
    sleepCtrl.abort();
    await backoffRejection;
    expect(backoffOp).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles per-attempt timer timeout and overall deadline expiration', async () => {
    const { options: timeoutOpts } = createTestOptions({
      attemptTimeoutMs: 5000,
      random: createDeterministicRandom([0])
    });
    let attempt = 0;
    const hangingOp = vi.fn(async () => {
      attempt++;
      if (attempt === 1) return new Promise<AttemptOutcome<string>>(() => {});
      return { kind: 'success', value: 'recovered_timeout' } as const;
    });
    const timeoutPromise = runWithRetry(hangingOp, timeoutOpts);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await timeoutPromise).toBe('recovered_timeout');
    expect(hangingOp).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    const now = Date.now();
    const { options: deadOpts } = createTestOptions({ deadlineMs: now + 2000 });
    const deadlinePromise = runWithRetry(
      () => new Promise<AttemptOutcome<string>>(() => {}),
      deadOpts
    );
    const deadRejection = expect(deadlinePromise).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(2000);
    await deadRejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('safely ignores late hostile resolution after timeout without invoking throwing getters', async () => {
    const { options } = createTestOptions({
      attemptTimeoutMs: 2000,
      random: createDeterministicRandom([0])
    });
    let attempt = 0;
    let lateResolve!: (val: any) => void;
    let hostileGetterCalled = false;

    const hangingOp = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        return new Promise<AttemptOutcome<string>>((res) => {
          lateResolve = res;
        });
      }
      return { kind: 'success', value: 'attempt_2_won' } as const;
    });

    const promise = runWithRetry(hangingOp, options);
    await vi.advanceTimersByTimeAsync(2000); // timeout attempt 1
    await vi.advanceTimersByTimeAsync(1000); // backoff delay
    const result = await promise;
    expect(result).toBe('attempt_2_won');

    // Trigger late hostile resolution on attempt 1 after settlement
    expect(() => {
      lateResolve({
        get kind() {
          hostileGetterCalled = true;
          throw new Error('hostile getter should never be accessed on late outcome');
        }
      });
    }).not.toThrow();

    await Promise.resolve();
    expect(hostileGetterCalled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('safely ignores late hostile rejection after cancellation without unhandled rejection', async () => {
    const { options, controller } = createTestOptions();
    let lateReject!: (err: unknown) => void;
    let hostileGetterCalled = false;

    const pendingOp = vi.fn((_signal: AbortSignal) => new Promise<AttemptOutcome<string>>((_, rej) => {
      lateReject = rej;
    }));

    const promise = runWithRetry(pendingOp, options);
    await Promise.resolve(); // let microtask run and invoke pendingOp
    const rejection = expect(promise).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    controller.abort();
    await rejection;

    // Trigger separate late rejection with a hostile error after cancellation
    expect(() => {
      lateReject({
        get code() {
          hostileGetterCalled = true;
          throw new Error('hostile error code getter should never be accessed on late error');
        }
      });
    }).not.toThrow();

    await Promise.resolve();
    expect(hostileGetterCalled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('catches hostile outcome getters safely and settles with INTERNAL_ERROR', async () => {
    const { options } = createTestOptions();

    // Hostile kind getter
    const hostileKindOp = vi.fn(async () => ({
      get kind(): any {
        throw new Error('exploding kind getter');
      }
    }));
    await expect(runWithRetry(hostileKindOp as any, options)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(vi.getTimerCount()).toBe(0);

    // Hostile value getter
    const hostileValueOp = vi.fn(async () => ({
      kind: 'success' as const,
      get value(): any {
        throw new Error('exploding value getter');
      }
    }));
    await expect(runWithRetry(hostileValueOp, options)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(vi.getTimerCount()).toBe(0);

    // Hostile error code getter
    const hostileErrorCodeOp = vi.fn(async () => {
      const err = new Error('hostile error');
      Object.defineProperty(err, 'code', {
        get() {
          throw new Error('exploding code getter');
        }
      });
      throw err;
    });
    await expect(runWithRetry(hostileErrorCodeOp, options)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects malformed success outcome missing value property but accepts explicitly present undefined', async () => {
    const { options } = createTestOptions();

    // Malformed outcome missing value property entirely
    const missingValueOp = vi.fn(async () => ({ kind: 'success' } as any));
    await expect(runWithRetry(missingValueOp, options)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(vi.getTimerCount()).toBe(0);

    // Explicitly present undefined value
    const explicitUndefinedOp = vi.fn(async () => ({ kind: 'success', value: undefined } as const));
    const res = await runWithRetry(explicitUndefinedOp, options);
    expect(res).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails with CONFIG_INVALID when custom sleep completes earlier than requested delay', async () => {
    let currentTime = 1_000_000;
    const { options } = createTestOptions({
      clock: { now: () => currentTime },
      random: createDeterministicRandom([0]),
      sleep: async () => Promise.resolve() // Completes immediately (0ms) instead of waiting requested delay
    });

    const op = vi.fn(async () => ({ kind: 'retry', code: 'RATE_LIMITED' } as const));
    await expect(runWithRetry(op, options)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(op).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels immediately if parent signal abort is triggered during clock consultation', async () => {
    let controller!: AbortController;
    const clock = {
      now: vi.fn(() => {
        if (controller) {
          controller.abort();
        }
        return 1_000_000;
      })
    };
    const base = createTestOptions({ clock });
    controller = base.controller;
    const op = vi.fn(async () => ({ kind: 'success', value: 'should_not_run' } as const));

    await expect(runWithRetry(op, base.options)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(op).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes per-attempt clock timeout (which retries) from overall deadline expiration', async () => {
    let simulatedOffset = 0;
    const clock = { now: () => Date.now() + simulatedOffset };
    const { options } = createTestOptions({
      clock,
      attemptTimeoutMs: 5_000,
      deadlineMs: 1_100_000,
      random: createDeterministicRandom([0])
    });

    let attempt = 0;
    const op = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        // Clock advanced past 5000ms attemptTimeoutMs during attempt
        simulatedOffset += 6_000;
        return { kind: 'success', value: 'late_attempt_1' } as const;
      }
      simulatedOffset += 100;
      return { kind: 'success', value: 'on_time_attempt_2' } as const;
    });

    const promise = runWithRetry(op, options);
    await vi.advanceTimersByTimeAsync(1000); // Backoff wait
    const result = await promise;
    expect(result).toBe('on_time_attempt_2');
    expect(op).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    // Overall deadline expiration terminates without retry
    simulatedOffset = 0;
    const { options: deadOpts } = createTestOptions({
      clock,
      deadlineMs: 1_005_000
    });
    const deadlineOp = vi.fn(async () => {
      simulatedOffset += 6_000; // Exceeds deadlineMs
      return { kind: 'success', value: 'should_fail_deadline' } as const;
    });
    await expect(runWithRetry(deadlineOp, deadOpts)).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    expect(deadlineOp).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('validates static configuration and provider invariants with CONFIG_INVALID', async () => {
    const { options } = createTestOptions();
    await expect(runWithRetry(null as any, options)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(runWithRetry(123 as any, options)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), null as any)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, signal: null as any })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, clock: null as any })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, random: null as any })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, deadlineMs: -1 })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, deadlineMs: 1.5 })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, attemptTimeoutMs: 0 })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, attemptTimeoutMs: 70_000 })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, sleep: 'not_a_fn' as any })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    let clockTime = 10_000;
    const backwardClock = {
      now: vi.fn(() => {
        clockTime -= 1000;
        return clockTime;
      })
    };
    await expect(runWithRetry(
      async () => ({ kind: 'retry', code: 'RATE_LIMITED' }),
      { ...options, clock: backwardClock }
    )).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles synchronous and malformed callback returns safely', async () => {
    const { options } = createTestOptions();

    // Synchronous success return
    const syncOp = vi.fn((() => ({ kind: 'success', value: 'sync_result' })) as any);
    const res = await runWithRetry(syncOp as any, options);
    expect(res).toBe('sync_result');
    expect(vi.getTimerCount()).toBe(0);

    // Synchronous throw
    const syncThrowOp = vi.fn((() => { throw new Error('sync failure'); }) as any);
    await expect(runWithRetry(syncThrowOp as any, options)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(vi.getTimerCount()).toBe(0);

    // Malformed return null
    const nullOp = vi.fn(async () => null as any);
    await expect(runWithRetry(nullOp, options)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(vi.getTimerCount()).toBe(0);

    // Malformed return invalid kind
    const invalidKindOp = vi.fn(async () => ({ kind: 'unknown_kind' } as any));
    await expect(runWithRetry(invalidKindOp, options)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('races custom sleep ignoring signal against parent abort', async () => {
    const { options, controller } = createTestOptions({
      sleep: () => new Promise(() => {})
    });
    const op = vi.fn(async () => ({ kind: 'retry', code: 'RATE_LIMITED' } as const));
    const promise = runWithRetry(op, options);
    const rejection = expect(promise).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    await Promise.resolve();
    controller.abort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('redacts abort reasons without leaking secrets', async () => {
    const { options } = createTestOptions();
    const secretCtrl = new AbortController();
    const secretPromise = runWithRetry(
      () => new Promise<AttemptOutcome<number>>(() => {}),
      { ...options, signal: secretCtrl.signal }
    );
    secretCtrl.abort('ya29.super-secret-token-reason');
    try {
      await secretPromise;
      expect.unreachable('must reject');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('OPERATION_ABORTED');
      expect((err as Error).message).not.toContain('super-secret');
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects options and provider throwing getters with CONFIG_INVALID', async () => {
    const { options } = createTestOptions();

    // Throwing getter on options.signal
    const badSignalOptions = {
      ...options,
      get signal(): AbortSignal {
        throw new Error('exploding signal getter');
      }
    };
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), badSignalOptions as any))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    // Throwing getter on options.clock
    const badClockOptions = {
      ...options,
      get clock(): any {
        throw new Error('exploding clock getter');
      }
    };
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), badClockOptions as any))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    // Throwing getter on options.random
    const badRandomOptions = {
      ...options,
      get random(): any {
        throw new Error('exploding random getter');
      }
    };
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), badRandomOptions as any))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    // Throwing getter on options.deadlineMs
    const badDeadlineOptions = {
      ...options,
      get deadlineMs(): number {
        throw new Error('exploding deadline getter');
      }
    };
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), badDeadlineOptions as any))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    // Throwing getter on clock.now
    const throwingClock = {
      get now(): any {
        throw new Error('exploding clock.now getter');
      }
    };
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, clock: throwingClock as any }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    // Throwing getter on random.next
    const throwingRandom = {
      get next(): any {
        throw new Error('exploding random.next getter');
      }
    };
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, random: throwingRandom as any }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    // Signal missing removeEventListener
    const signalMissingRemove = {
      aborted: false,
      addEventListener: vi.fn()
    };
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, signal: signalMissingRemove as any }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    // Throwing getter on signal.addEventListener
    const throwingSignal = {
      aborted: false,
      get addEventListener(): any {
        throw new Error('exploding addEventListener getter');
      },
      removeEventListener: vi.fn()
    };
    await expect(runWithRetry(async () => ({ kind: 'success', value: 1 }), { ...options, signal: throwingSignal as any }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects success outcome with inherited value property', async () => {
    const { options } = createTestOptions();
    const proto = { value: 'inherited_payload' };
    const inheritedOutcome = Object.create(proto);
    inheritedOutcome.kind = 'success';

    const op = vi.fn(async () => inheritedOutcome as any);
    await expect(runWithRetry(op, options)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(op).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rebuilds config getter failures even when a DomainError has been mutated', async () => {
    const { options } = createTestOptions();
    const injected = new DomainError('CONFIG_INVALID');
    injected.message = 'Bearer synthetic-secret';
    const hostile = Object.defineProperty({ ...options }, 'clock', { get() { throw injected; } });
    const failure = await runWithRetry(async () => ({ kind: 'success', value: 1 }), hostile)
      .catch(error => error);
    expect(failure).not.toBe(injected);
    expect(failure).toMatchObject({ code: 'CONFIG_INVALID', message: 'Extension configuration is invalid.' });
    expect(JSON.stringify(failure)).not.toContain('synthetic-secret');
  });

  it('aborts queued operation whose deadline expires before microtask executes with zero operation calls', async () => {
    let simulatedTime = 1_000_000;
    const clock = { now: () => simulatedTime };
    const { options } = createTestOptions({
      clock,
      deadlineMs: 1_000_050
    });

    const op = vi.fn(async () => ({ kind: 'success', value: 'never_reached' } as const));
    const promise = runWithRetry(op, options);

    // Before the scheduled microtask executes, advance clock past deadline
    simulatedTime = 1_000_100;

    await expect(promise).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    expect(op).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts when parent signal is aborted during final clock recheck before returning success', async () => {
    let callCount = 0;
    let controller!: AbortController;
    const clock = {
      now: vi.fn(() => {
        callCount++;
        // On the final monotonic clock check after op fulfilled, abort the controller
        if (callCount >= 6 && controller) {
          controller.abort();
        }
        return 1_000_000;
      })
    };
    const base = createTestOptions({ clock });
    controller = base.controller;

    const op = vi.fn(async () => ({ kind: 'success', value: 'payload' } as const));

    await expect(runWithRetry(op, base.options)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(callCount).toBe(6);
    expect(op).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-arms native backoff timer when callback fires with clock still short, completing on second wait', async () => {
    let clockTime = 1_000_000;
    const clock = {
      now: vi.fn(() => clockTime)
    };
    const { options } = createTestOptions({
      clock,
      random: createDeterministicRandom([0]),
      deadlineMs: 2_000_000
    });

    let attempt = 0;
    const op = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        return { kind: 'retry', code: 'RATE_LIMITED' } as const;
      }
      return { kind: 'success', value: 'recovered_after_rearm' } as const;
    });

    const promise = runWithRetry(op, options);

    // Flush microtasks so attempt 1 fails and executeSleep records startMs=1_000_000 and targetMs=1_001_000
    await vi.advanceTimersByTimeAsync(0);

    // Simulate timer callback firing when monotonic clock only advanced 800ms (short by 200ms)
    clockTime = 1_000_800;
    await vi.advanceTimersByTimeAsync(1000);

    // Runner re-armed sleepTimer for remaining 200ms.
    // Operation has NOT run attempt 2 yet.
    expect(op).toHaveBeenCalledTimes(1);

    // Advance clock to target 1_001_000 and advance timers by remaining 200ms.
    clockTime = 1_001_000;
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe('recovered_after_rearm');
    expect(op).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
