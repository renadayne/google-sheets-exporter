import { DomainError, isDomainError, isErrorCode, type ErrorCode } from '../contracts/errors.ts';
import type { Clock, Random } from '../contracts/ports.ts';
import { computeRetryDelayMs, MAX_ATTEMPTS } from './retry-policy.ts';

/**
 * Outcome of a single idempotent attempt.
 * Adapter owns payload credentials; generic T cannot enforce.
 * Must NOT contain credentials, authorization tokens, or raw response bodies.
 */
export type AttemptOutcome<T> =
  | { readonly kind: 'success'; readonly value: T }
  | { readonly kind: 'retry'; readonly code: ErrorCode; readonly retryAfterMs?: number | null }
  | { readonly kind: 'renew_auth'; readonly code: 'AUTH_EXPIRED'; readonly retryAfterMs?: number | null }
  | { readonly kind: 'fail'; readonly code: ErrorCode; readonly retryAfterMs?: number | null };

export interface RetryOptions {
  readonly signal: AbortSignal;
  readonly clock: Clock;
  readonly random: Random;
  readonly deadlineMs: number;
  readonly attemptTimeoutMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
export const MAX_ATTEMPT_TIMEOUT_MS = 60_000;
export const MAX_RUNNER_WINDOW_MS = 600_000; // 10 minutes client policy

const RETRYABLE_CODES = [
  'NETWORK_TIMEOUT',
  'NETWORK_OFFLINE',
  'NETWORK_SERVER_ERROR',
  'RATE_LIMITED'
] as const;

function isRetryableCode(code: ErrorCode): boolean {
  return (RETRYABLE_CODES as readonly string[]).includes(code);
}

async function executeSleep(
  delayMs: number,
  parentSignal: AbortSignal,
  customSleep: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined,
  effectiveDeadlineMs: number,
  getMonotonicNow: () => number
): Promise<void> {
  // Parent pre-abort should win before consulting clock/provider
  if (parentSignal.aborted) throw new DomainError('OPERATION_ABORTED');

  let startMs: number;
  try {
    startMs = getMonotonicNow();
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }
  if (parentSignal.aborted) throw new DomainError('OPERATION_ABORTED');
  const remainingBudget = effectiveDeadlineMs - startMs;
  if (remainingBudget <= 0) throw new DomainError('NETWORK_TIMEOUT');

  const sleepController = new AbortController();
  let sleepTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let settled = false;

  const cleanup = () => {
    if (sleepTimer !== undefined) { clearTimeout(sleepTimer); sleepTimer = undefined; }
    if (deadlineTimer !== undefined) { clearTimeout(deadlineTimer); deadlineTimer = undefined; }
    if (abortListener !== undefined) { parentSignal.removeEventListener('abort', abortListener); abortListener = undefined; }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (err?: DomainError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) {
          sleepController.abort();
          reject(err);
        } else {
          resolve();
        }
      };

      abortListener = () => {
        finish(new DomainError('OPERATION_ABORTED'));
      };
      parentSignal.addEventListener('abort', abortListener, { once: true });
      // Register listener then recheck aborted state to close race if clock/provider side effects abort the signal
      if (parentSignal.aborted) {
        finish(new DomainError('OPERATION_ABORTED'));
        return;
      }

      const boundedBudget = Math.min(remainingBudget, MAX_RUNNER_WINDOW_MS);
      deadlineTimer = setTimeout(() => finish(new DomainError('NETWORK_TIMEOUT')), boundedBudget);

      if (!customSleep) {
        const targetMs = startMs + delayMs;
        const scheduleNativeSleep = (remainingWaitMs: number) => {
          sleepTimer = setTimeout(() => {
            if (settled) return;
            if (parentSignal.aborted) {
              finish(new DomainError('OPERATION_ABORTED'));
              return;
            }
            let currentNow: number;
            try {
              currentNow = getMonotonicNow();
            } catch {
              finish(new DomainError('CONFIG_INVALID'));
              return;
            }
            if (parentSignal.aborted) {
              finish(new DomainError('OPERATION_ABORTED'));
              return;
            }
            if (currentNow >= effectiveDeadlineMs) {
              finish(new DomainError('NETWORK_TIMEOUT'));
              return;
            }
            if (currentNow < targetMs) {
              scheduleNativeSleep(targetMs - currentNow);
              return;
            }
            finish();
          }, remainingWaitMs);
        };

        scheduleNativeSleep(delayMs);
      } else {
        if (parentSignal.aborted) {
          finish(new DomainError('OPERATION_ABORTED'));
          return;
        }
        let nowBeforeSleep: number;
        try {
          nowBeforeSleep = getMonotonicNow();
        } catch {
          finish(new DomainError('CONFIG_INVALID'));
          return;
        }
        if (parentSignal.aborted) {
          finish(new DomainError('OPERATION_ABORTED'));
          return;
        }
        if (nowBeforeSleep >= effectiveDeadlineMs) {
          finish(new DomainError('NETWORK_TIMEOUT'));
          return;
        }

        Promise.resolve()
          .then(() => {
            if (settled || parentSignal.aborted) {
              if (!settled) finish(new DomainError('OPERATION_ABORTED'));
              return;
            }
            let nowInMicrotask: number;
            try {
              nowInMicrotask = getMonotonicNow();
            } catch {
              finish(new DomainError('CONFIG_INVALID'));
              return;
            }
            if (parentSignal.aborted) {
              finish(new DomainError('OPERATION_ABORTED'));
              return;
            }
            if (nowInMicrotask >= effectiveDeadlineMs) {
              finish(new DomainError('NETWORK_TIMEOUT'));
              return;
            }
            nowBeforeSleep = nowInMicrotask;
            return customSleep(delayMs, sleepController.signal);
          })
          .then(
            () => {
              if (settled) return;
              if (parentSignal.aborted) {
                finish(new DomainError('OPERATION_ABORTED'));
                return;
              }
              let nowAfterSleep: number;
              try {
                nowAfterSleep = getMonotonicNow();
              } catch {
                finish(new DomainError('CONFIG_INVALID'));
                return;
              }
              if (parentSignal.aborted) {
                finish(new DomainError('OPERATION_ABORTED'));
                return;
              }
              if (nowAfterSleep - nowBeforeSleep < delayMs) {
                finish(new DomainError('CONFIG_INVALID'));
                return;
              }
              if (nowAfterSleep >= effectiveDeadlineMs) {
                finish(new DomainError('NETWORK_TIMEOUT'));
                return;
              }
              finish();
            },
            () => {
              if (settled) return;
              finish(new DomainError(parentSignal.aborted ? 'OPERATION_ABORTED' : 'INTERNAL_ERROR'));
            }
          )
          .catch(() => {
            if (settled) return;
            finish(new DomainError('INTERNAL_ERROR'));
          });
      }
    });
  } finally {
    cleanup();
  }

  if (parentSignal.aborted) throw new DomainError('OPERATION_ABORTED');
  let postNow: number;
  try {
    postNow = getMonotonicNow();
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }
  if (parentSignal.aborted) throw new DomainError('OPERATION_ABORTED');
  if (postNow >= effectiveDeadlineMs) throw new DomainError('NETWORK_TIMEOUT');
}

/**
 * Runs an idempotent operation with bounded attempts, per-attempt timeout,
 * exponential jittered backoff, deadline budgeting, and strict cancellation.
 *
 * Contract:
 * - The operation callback MUST encompass the ENTIRE idempotent read, including
 *   fetch AND bounded response body parsing, not merely headers.
 * - Outgoing outcomes must contain NO credentials, request tokens, or raw response bodies.
 *   Adapter owns the credential boundary; runner does not inspect or serialize payload value T.
 * - This runner carries NO publication or permission authority. Success does not
 *   prove source access or permission.
 * - Caller must supply a compliant Fetch adapter; runner aborts and discards lingering attempts.
 */
export async function runWithRetry<T>(
  operation: (attemptSignal: AbortSignal) => Promise<AttemptOutcome<T>>,
  options: RetryOptions
): Promise<T> {
  let parentSignal: AbortSignal;
  let clock: Clock;
  let random: Random;
  let deadlineMs: number;
  let resolvedTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS;
  let customSleep: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;

  try {
    if (typeof operation !== 'function' || typeof options !== 'object' || options === null) {
      throw new DomainError('CONFIG_INVALID');
    }
    const rawSignal = options.signal;
    const rawClock = options.clock;
    const rawRandom = options.random;
    const rawDeadline = options.deadlineMs;
    const rawAttemptTimeout = options.attemptTimeoutMs;
    const rawSleep = options.sleep;

    if (
      !rawSignal ||
      typeof rawSignal.aborted !== 'boolean' ||
      typeof rawSignal.addEventListener !== 'function' ||
      typeof rawSignal.removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (!rawClock || typeof rawClock.now !== 'function') {
      throw new DomainError('CONFIG_INVALID');
    }
    if (!rawRandom || typeof rawRandom.next !== 'function') {
      throw new DomainError('CONFIG_INVALID');
    }
    if (!Number.isSafeInteger(rawDeadline) || rawDeadline < 0) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (rawAttemptTimeout !== undefined) {
      if (!Number.isSafeInteger(rawAttemptTimeout) || rawAttemptTimeout <= 0 || rawAttemptTimeout > MAX_ATTEMPT_TIMEOUT_MS) {
        throw new DomainError('CONFIG_INVALID');
      }
      resolvedTimeoutMs = rawAttemptTimeout;
    }
    if (rawSleep !== undefined) {
      if (typeof rawSleep !== 'function') {
        throw new DomainError('CONFIG_INVALID');
      }
      customSleep = rawSleep;
    }
    parentSignal = rawSignal;
    clock = rawClock;
    random = rawRandom;
    deadlineMs = rawDeadline;
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }

  // Pre-abort before invoking providers (clock.now)
  if (parentSignal.aborted) throw new DomainError('OPERATION_ABORTED');

  let lastClockMs: number;
  try { lastClockMs = clock.now(); } catch { throw new DomainError('CONFIG_INVALID'); }
  if (!Number.isSafeInteger(lastClockMs) || lastClockMs < 0) {
    throw new DomainError('CONFIG_INVALID');
  }

  const getMonotonicNow = (): number => {
    let currentMs: number;
    try { currentMs = clock.now(); } catch { throw new DomainError('CONFIG_INVALID'); }
    if (!Number.isSafeInteger(currentMs) || currentMs < lastClockMs) {
      throw new DomainError('CONFIG_INVALID');
    }
    lastClockMs = currentMs;
    return currentMs;
  };

  const effectiveDeadlineMs = Math.min(deadlineMs, lastClockMs + MAX_RUNNER_WINDOW_MS);
  if (parentSignal.aborted) throw new DomainError('OPERATION_ABORTED');
  if (lastClockMs >= effectiveDeadlineMs) throw new DomainError('NETWORK_TIMEOUT');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (parentSignal.aborted) throw new DomainError('OPERATION_ABORTED');
    const attemptStartMs = getMonotonicNow();
    if (attemptStartMs >= effectiveDeadlineMs) throw new DomainError('NETWORK_TIMEOUT');

    const remainingBudgetMs = effectiveDeadlineMs - attemptStartMs;
    const timeoutMs = Math.min(resolvedTimeoutMs, remainingBudgetMs);
    const attemptController = new AbortController();
    let timerHandle: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let settled = false;

    type AttemptResult =
      | { kind: 'success'; value: T }
      | { kind: 'retryable'; code: ErrorCode; retryAfterMs: number | null };

    let attemptOutcome: AttemptResult;

    try {
      attemptOutcome = await new Promise<AttemptResult>((resolve, reject) => {
        const cleanup = () => {
          if (timerHandle !== undefined) { clearTimeout(timerHandle); timerHandle = undefined; }
          if (abortListener !== undefined) { parentSignal.removeEventListener('abort', abortListener); abortListener = undefined; }
        };

        const finish = (result: { ok: true; outcome: AttemptResult } | { ok: false; error: DomainError }) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (result.ok) {
            resolve(result.outcome);
          } else {
            attemptController.abort();
            reject(result.error);
          }
        };

        abortListener = () => {
          finish({ ok: false, error: new DomainError('OPERATION_ABORTED') });
        };
        parentSignal.addEventListener('abort', abortListener, { once: true });
        // Register listener then recheck aborted state to close race if clock/provider side effects abort the signal
        if (parentSignal.aborted) {
          finish({ ok: false, error: new DomainError('OPERATION_ABORTED') });
          return;
        }

        timerHandle = setTimeout(() => {
          attemptController.abort();
          finish({ ok: true, outcome: { kind: 'retryable', code: 'NETWORK_TIMEOUT', retryAfterMs: null } });
        }, timeoutMs);

        // Recheck parent abort and deadline immediately before executing scheduled operation
        if (parentSignal.aborted) {
          finish({ ok: false, error: new DomainError('OPERATION_ABORTED') });
          return;
        }
        let nowBeforeOp: number;
        try {
          nowBeforeOp = getMonotonicNow();
        } catch {
          finish({ ok: false, error: new DomainError('CONFIG_INVALID') });
          return;
        }
        if (parentSignal.aborted) {
          finish({ ok: false, error: new DomainError('OPERATION_ABORTED') });
          return;
        }
        if (nowBeforeOp >= effectiveDeadlineMs) {
          finish({ ok: false, error: new DomainError('NETWORK_TIMEOUT') });
          return;
        }

        const handleFulfilled = (res: unknown) => {
          // Late outcomes must be ignored BEFORE reading their properties
          if (settled) return;
          try {
            if (parentSignal.aborted) {
              finish({ ok: false, error: new DomainError('OPERATION_ABORTED') });
              return;
            }

            let nowAfterOp: number;
            try {
              nowAfterOp = getMonotonicNow();
            } catch {
              finish({ ok: false, error: new DomainError('CONFIG_INVALID') });
              return;
            }
            if (parentSignal.aborted) {
              finish({ ok: false, error: new DomainError('OPERATION_ABORTED') });
              return;
            }
            if (nowAfterOp >= effectiveDeadlineMs) {
              finish({ ok: false, error: new DomainError('NETWORK_TIMEOUT') });
              return;
            }

            if (typeof res !== 'object' || res === null) {
              finish({ ok: false, error: new DomainError('INTERNAL_ERROR') });
              return;
            }

            const kind = (res as { kind?: unknown }).kind;
            if (kind === 'success') {
              // Validate success actually has OWN value property (inherited value rejected)
              if (!Object.prototype.hasOwnProperty.call(res, 'value')) {
                finish({ ok: false, error: new DomainError('INTERNAL_ERROR') });
                return;
              }
              // Enforce per-attempt effective timeout via injected clock before accepting success
              if (nowAfterOp - attemptStartMs >= timeoutMs) {
                attemptController.abort();
                finish({ ok: true, outcome: { kind: 'retryable', code: 'NETWORK_TIMEOUT', retryAfterMs: null } });
                return;
              }
              finish({ ok: true, outcome: { kind: 'success', value: (res as { value: T }).value } });
            } else if (kind === 'renew_auth') {
              finish({ ok: false, error: new DomainError('AUTH_EXPIRED') });
            } else if (kind === 'fail') {
              const rawCode = (res as { code?: unknown }).code;
              const code = isErrorCode(rawCode) ? rawCode : 'INTERNAL_ERROR';
              finish({ ok: false, error: new DomainError(code) });
            } else if (kind === 'retry') {
              const rawCode = (res as { code?: unknown }).code;
              const code = isErrorCode(rawCode) ? rawCode : 'INTERNAL_ERROR';
              if (!isRetryableCode(code)) {
                finish({ ok: false, error: new DomainError(code) });
              } else {
                const rawRetryAfter = (res as { retryAfterMs?: unknown }).retryAfterMs;
                let retryAfter: number | null = null;
                if (rawRetryAfter !== undefined && rawRetryAfter !== null) {
                  if (!Number.isSafeInteger(rawRetryAfter) || (rawRetryAfter as number) < 0) {
                    finish({ ok: false, error: new DomainError('CONFIG_INVALID') });
                    return;
                  }
                  retryAfter = rawRetryAfter as number;
                }
                finish({ ok: true, outcome: { kind: 'retryable', code, retryAfterMs: retryAfter } });
              }
            } else {
              finish({ ok: false, error: new DomainError('INTERNAL_ERROR') });
            }
          } catch {
            finish({ ok: false, error: new DomainError('INTERNAL_ERROR') });
          }
        };

        const handleRejected = (err: unknown) => {
          // Late outcomes must be ignored BEFORE reading their properties
          if (settled) return;
          try {
            if (parentSignal.aborted) {
              finish({ ok: false, error: new DomainError('OPERATION_ABORTED') });
              return;
            }
            if (isDomainError(err) && isRetryableCode(err.code)) {
              finish({ ok: true, outcome: { kind: 'retryable', code: err.code, retryAfterMs: null } });
            } else if (isDomainError(err)) {
              finish({ ok: false, error: new DomainError(err.code) });
            } else {
              finish({ ok: false, error: new DomainError('INTERNAL_ERROR') });
            }
          } catch {
            finish({ ok: false, error: new DomainError('INTERNAL_ERROR') });
          }
        };

        // Normalize operation results with Promise.resolve().then(...), catch ALL handler/provider/config exceptions
        // into static safe DomainError, observe derived promise.
        Promise.resolve()
          .then(() => {
            if (settled || parentSignal.aborted) {
              if (!settled) finish({ ok: false, error: new DomainError('OPERATION_ABORTED') });
              return;
            }
            let nowInMicrotask: number;
            try {
              nowInMicrotask = getMonotonicNow();
            } catch {
              finish({ ok: false, error: new DomainError('CONFIG_INVALID') });
              return;
            }
            if (parentSignal.aborted) {
              finish({ ok: false, error: new DomainError('OPERATION_ABORTED') });
              return;
            }
            if (nowInMicrotask >= effectiveDeadlineMs) {
              finish({ ok: false, error: new DomainError('NETWORK_TIMEOUT') });
              return;
            }
            return operation(attemptController.signal);
          })
          .then(handleFulfilled, handleRejected)
          .catch(() => {
            if (settled) return;
            finish({ ok: false, error: new DomainError('INTERNAL_ERROR') });
          });
      });
    } finally {
      if (timerHandle !== undefined) { clearTimeout(timerHandle); timerHandle = undefined; }
      if (abortListener !== undefined) { parentSignal.removeEventListener('abort', abortListener); abortListener = undefined; }
    }

    if (attemptOutcome.kind === 'success') {
      if (parentSignal.aborted) {
        attemptController.abort();
        throw new DomainError('OPERATION_ABORTED');
      }
      let finalNow: number;
      try {
        finalNow = getMonotonicNow();
      } catch {
        attemptController.abort();
        throw new DomainError('CONFIG_INVALID');
      }
      if (parentSignal.aborted) {
        attemptController.abort();
        throw new DomainError('OPERATION_ABORTED');
      }
      if (finalNow >= effectiveDeadlineMs) {
        attemptController.abort();
        throw new DomainError('NETWORK_TIMEOUT');
      }
      return attemptOutcome.value;
    }

    attemptController.abort();
    if (attempt >= MAX_ATTEMPTS) {
      throw new DomainError(attemptOutcome.code);
    }

    const nowAfterAttempt = getMonotonicNow();
    const budgetRemaining = effectiveDeadlineMs - nowAfterAttempt;
    if (budgetRemaining <= 0) {
      throw new DomainError(attemptOutcome.code);
    }

    const delayMs = computeRetryDelayMs(attempt, attemptOutcome.retryAfterMs, budgetRemaining, random);
    if (delayMs === null) {
      throw new DomainError(attemptOutcome.code);
    }

    await executeSleep(delayMs, parentSignal, customSleep, effectiveDeadlineMs, getMonotonicNow);
  }

  throw new DomainError('INTERNAL_ERROR');
}
