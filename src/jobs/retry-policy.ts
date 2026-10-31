import { DomainError, type ErrorCode } from '../contracts/errors.ts';
import type { Random } from '../contracts/ports.ts';

export type HttpDecision =
  | { readonly kind: 'success' }
  | { readonly kind: 'retry'; readonly code: ErrorCode }
  | { readonly kind: 'renew_auth'; readonly code: 'AUTH_EXPIRED' }
  | { readonly kind: 'fail'; readonly code: ErrorCode };

export const MAX_ATTEMPTS = 4;
export const BASE_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000] as const);
export const MAX_JITTER_MS = 250;

const KNOWN_403_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'domainPolicy',
  'dailyLimitExceeded'
]);

const IMF_FIXDATE_REGEX =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-3]\d) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) ([0-2]\d):([0-5]\d):([0-5]\d) GMT$/;

const MONTH_INDEX: Readonly<Record<string, number>> = Object.freeze({
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
});

const DAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const);

function classify403(parsedBody: unknown): HttpDecision {
  if (typeof parsedBody !== 'object' || parsedBody === null || !('error' in parsedBody)) {
    return { kind: 'fail', code: 'UNCERTAIN_PERMISSION' };
  }
  const errorObj = (parsedBody as { error?: unknown }).error;
  if (typeof errorObj !== 'object' || errorObj === null || !('errors' in errorObj)) {
    return { kind: 'fail', code: 'UNCERTAIN_PERMISSION' };
  }
  const errors = (errorObj as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return { kind: 'fail', code: 'UNCERTAIN_PERMISSION' };
  }

  const reasons: string[] = [];
  for (const entry of errors) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { reason?: unknown }).reason !== 'string'
    ) {
      return { kind: 'fail', code: 'UNCERTAIN_PERMISSION' };
    }
    const reason = (entry as { reason: string }).reason;
    if (!KNOWN_403_REASONS.has(reason)) {
      return { kind: 'fail', code: 'UNCERTAIN_PERMISSION' };
    }
    reasons.push(reason);
  }

  if (reasons.includes('domainPolicy')) {
    return { kind: 'fail', code: 'ADMIN_RESTRICTED' };
  }
  if (reasons.includes('dailyLimitExceeded')) {
    return { kind: 'fail', code: 'QUOTA_EXCEEDED' };
  }
  return { kind: 'retry', code: 'RATE_LIMITED' };
}

export function classifyHttp(status: number, parsedBody: unknown): HttpDecision {
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    return { kind: 'fail', code: 'INTERNAL_ERROR' };
  }
  if (status >= 200 && status <= 299) {
    return { kind: 'success' };
  }
  if (status === 401) {
    return { kind: 'renew_auth', code: 'AUTH_EXPIRED' };
  }
  if (status === 404) {
    return { kind: 'fail', code: 'SOURCE_NOT_FOUND' };
  }
  if (status === 408) {
    return { kind: 'retry', code: 'NETWORK_TIMEOUT' };
  }
  if (status === 429) {
    return { kind: 'retry', code: 'RATE_LIMITED' };
  }
  if (status >= 500 && status <= 599) {
    return { kind: 'retry', code: 'NETWORK_SERVER_ERROR' };
  }
  if (status === 403) {
    try { return classify403(parsedBody); }
    catch { return { kind: 'fail', code: 'UNCERTAIN_PERMISSION' }; }
  }
  return { kind: 'fail', code: 'SOURCE_UNSUPPORTED' };
}

export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || typeof header !== 'string') {
    return null;
  }
  const trimmed = header.replace(/^[ \t]+|[ \t]+$/g, '');
  if (trimmed === '') {
    return null;
  }

  if (!/[^0-9]/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds > Number.MAX_SAFE_INTEGER / 1000) {
      return Number.MAX_SAFE_INTEGER;
    }
    const delayMs = Math.round(seconds * 1000);
    return delayMs > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : delayMs;
  }

  const match = IMF_FIXDATE_REGEX.exec(trimmed);
  if (!match || match[0] !== trimmed) {
    return null;
  }

  const [, dayName, dayStr, monStr, yearStr, hourStr, minStr, secStr] = match;
  const day = Number(dayStr);
  const month = MONTH_INDEX[monStr];
  const year = Number(yearStr);
  const hour = Number(hourStr);
  const minute = Number(minStr);
  const second = Number(secStr);

  const targetMs = Date.UTC(year, month, day, hour, minute, second);
  const dateObj = new Date(targetMs);
  if (
    dateObj.getUTCFullYear() !== year ||
    dateObj.getUTCMonth() !== month ||
    dateObj.getUTCDate() !== day ||
    dateObj.getUTCHours() !== hour ||
    dateObj.getUTCMinutes() !== minute ||
    dateObj.getUTCSeconds() !== second ||
    DAY_NAMES[dateObj.getUTCDay()] !== dayName
  ) {
    return null;
  }

  if (targetMs <= nowMs) {
    return 0;
  }
  const diffMs = targetMs - nowMs;
  return !Number.isFinite(diffMs) || diffMs > Number.MAX_SAFE_INTEGER
    ? Number.MAX_SAFE_INTEGER
    : diffMs;
}

export function computeRetryDelayMs(
  failedAttempt: number,
  retryAfterMs: number | null,
  remainingBudgetMs: number,
  random: Random
): number | null {
  if (
    typeof failedAttempt !== 'number' ||
    !Number.isSafeInteger(failedAttempt) ||
    failedAttempt < 1
  ) {
    throw new DomainError('CONFIG_INVALID');
  }
  if (failedAttempt >= MAX_ATTEMPTS) {
    return null;
  }
  if (!Number.isSafeInteger(remainingBudgetMs)) {
    throw new DomainError('CONFIG_INVALID');
  }
  if (
    retryAfterMs !== null &&
    (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)
  ) {
    throw new DomainError('CONFIG_INVALID');
  }
  if (remainingBudgetMs <= 0) return null;
  const baseDelayMs = BASE_RETRY_DELAYS_MS[failedAttempt - 1];
  if (Math.max(baseDelayMs, retryAfterMs ?? 0) >= remainingBudgetMs) return null;
  let r: number;
  try {
    if (!random || typeof random.next !== 'function') throw new Error();
    r = random.next();
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r >= 1) {
    throw new DomainError('CONFIG_INVALID');
  }

  const jitterMs = Math.floor(r * MAX_JITTER_MS);
  const jitteredBackoffMs = baseDelayMs + jitterMs;
  const requiredWaitMs =
    retryAfterMs !== null ? Math.max(jitteredBackoffMs, retryAfterMs) : jitteredBackoffMs;

  return requiredWaitMs < remainingBudgetMs ? requiredWaitMs : null;
}
