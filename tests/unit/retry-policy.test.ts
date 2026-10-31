import { describe, it, expect } from 'vitest';
import { DomainError } from '../../src/contracts/errors.ts';
import { createDeterministicRandom } from '../helpers/deterministic.ts';
import {
  classifyHttp,
  parseRetryAfterMs,
  computeRetryDelayMs,
  MAX_ATTEMPTS,
  BASE_RETRY_DELAYS_MS
} from '../../src/jobs/retry-policy.ts';

describe('HTTP retry policy and classification (T19a)', () => {
  it('rejects unsafe time/header syntax and stops expired budgets without consulting RNG', () => {
    for (const now of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(parseRetryAfterMs('1', now)).toBeNull();
    for (const header of ['1.0001', '1\n', 'Wed, 21 Oct 2015 07:28:00 GMT\n']) expect(parseRetryAfterMs(header, 0)).toBeNull();
    const neverRandom = createDeterministicRandom([]);
    expect(computeRetryDelayMs(1, null, 0, neverRandom)).toBeNull();
    expect(computeRetryDelayMs(1, null, -100, neverRandom)).toBeNull();
    expect(computeRetryDelayMs(1, null, 500, neverRandom)).toBeNull();
    expect(computeRetryDelayMs(1, 5000, 4000, neverRandom)).toBeNull();
    expect(() => computeRetryDelayMs(1, null, 0.5, neverRandom)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => computeRetryDelayMs(1, 0.5, 2000, neverRandom)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('contains hostile body and random-provider exceptions without diagnostic leakage', () => {
    expect(classifyHttp(403, { get error() { throw new Error('synthetic-private-body'); } })).toEqual({ kind: 'fail', code: 'UNCERTAIN_PERMISSION' });
    try {
      computeRetryDelayMs(1, null, 5000, { next() { throw new Error('synthetic-private-random'); } });
      expect.unreachable('random provider must fail');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('CONFIG_INVALID');
      expect((error as Error).message).not.toContain('synthetic-private');
    }
  });
  describe('classifyHttp', () => {
    it.each([
      [200, { kind: 'success' }],
      [204, { kind: 'success' }],
      [401, { kind: 'renew_auth', code: 'AUTH_EXPIRED' }],
      [404, { kind: 'fail', code: 'SOURCE_NOT_FOUND' }],
      [408, { kind: 'retry', code: 'NETWORK_TIMEOUT' }],
      [429, { kind: 'retry', code: 'RATE_LIMITED' }],
      [500, { kind: 'retry', code: 'NETWORK_SERVER_ERROR' }],
      [503, { kind: 'retry', code: 'NETWORK_SERVER_ERROR' }],
      [400, { kind: 'fail', code: 'SOURCE_UNSUPPORTED' }],
      [405, { kind: 'fail', code: 'SOURCE_UNSUPPORTED' }],
      [NaN, { kind: 'fail', code: 'INTERNAL_ERROR' }],
      [-1, { kind: 'fail', code: 'INTERNAL_ERROR' }],
      [600, { kind: 'fail', code: 'INTERNAL_ERROR' }],
      [200.5, { kind: 'fail', code: 'INTERNAL_ERROR' }]
    ])('status %s maps to %j', (status, expected) => {
      expect(classifyHttp(status, null)).toEqual(expected);
    });

    it('classifies 403 Google error body machine reasons accurately', () => {
      const mkBody = (reasons: string[]) => ({
        error: { errors: reasons.map((r) => ({ reason: r, message: 'secret-msg' })) }
      });

      expect(classifyHttp(403, mkBody(['rateLimitExceeded']))).toEqual({ kind: 'retry', code: 'RATE_LIMITED' });
      expect(classifyHttp(403, mkBody(['userRateLimitExceeded']))).toEqual({ kind: 'retry', code: 'RATE_LIMITED' });
      expect(classifyHttp(403, mkBody(['rateLimitExceeded', 'userRateLimitExceeded']))).toEqual({
        kind: 'retry',
        code: 'RATE_LIMITED'
      });
      expect(classifyHttp(403, mkBody(['domainPolicy']))).toEqual({ kind: 'fail', code: 'ADMIN_RESTRICTED' });
      expect(classifyHttp(403, mkBody(['domainPolicy', 'rateLimitExceeded']))).toEqual({
        kind: 'fail',
        code: 'ADMIN_RESTRICTED'
      });
      expect(classifyHttp(403, mkBody(['dailyLimitExceeded']))).toEqual({ kind: 'fail', code: 'QUOTA_EXCEEDED' });
      expect(classifyHttp(403, mkBody(['dailyLimitExceeded', 'rateLimitExceeded']))).toEqual({
        kind: 'fail',
        code: 'QUOTA_EXCEEDED'
      });

      // Malformed, unknown, or mixed-with-unknown fail UNCERTAIN_PERMISSION
      expect(classifyHttp(403, mkBody(['unknownReason']))).toEqual({ kind: 'fail', code: 'UNCERTAIN_PERMISSION' });
      expect(classifyHttp(403, mkBody(['rateLimitExceeded', 'unknownReason']))).toEqual({
        kind: 'fail',
        code: 'UNCERTAIN_PERMISSION'
      });
      expect(classifyHttp(403, mkBody(['domainPolicy', 'unknownReason']))).toEqual({
        kind: 'fail',
        code: 'UNCERTAIN_PERMISSION'
      });
      expect(classifyHttp(403, { error: { message: 'rateLimitExceeded' } })).toEqual({
        kind: 'fail',
        code: 'UNCERTAIN_PERMISSION'
      });
      expect(classifyHttp(403, { error: { errors: [] } })).toEqual({ kind: 'fail', code: 'UNCERTAIN_PERMISSION' });
      expect(classifyHttp(403, null)).toEqual({ kind: 'fail', code: 'UNCERTAIN_PERMISSION' });
      expect(classifyHttp(403, 'raw string')).toEqual({ kind: 'fail', code: 'UNCERTAIN_PERMISSION' });
    });

    it('does not echo token-like or diagnostic strings in returned decision', () => {
      const decision = classifyHttp(403, {
        error: { errors: [{ reason: 'rateLimitExceeded', token: 'ya29.secret' }] }
      });
      expect(Object.keys(decision).sort()).toEqual(['code', 'kind']);
      expect(JSON.stringify(decision)).toBe('{"kind":"retry","code":"RATE_LIMITED"}');
    });
  });

  describe('parseRetryAfterMs', () => {
    const fixedNowMs = Date.UTC(2015, 9, 21, 7, 27, 50); // 10s before 07:28:00

    it.each([
      ['120', 1000, 120000],
      ['1.5', 1000, null],
      ['0', 1000, 0],
      ['Wed, 21 Oct 2015 07:28:00 GMT', fixedNowMs, 10000],
      ['Wed, 21 Oct 2015 07:28:00 GMT', fixedNowMs + 20000, 0], // past date -> 0
      ['9999999999999999999999999999', 1000, Number.MAX_SAFE_INTEGER], // overflow saturation
      [null, 1000, null],
      ['', 1000, null],
      ['   ', 1000, null],
      ['invalid', 1000, null],
      ['-5', 1000, null],
      ['Wed, 21 Oct 2015 07:28:00 PST', fixedNowMs, null],
      ['Thu, 21 Oct 2015 07:28:00 GMT', fixedNowMs, null], // wrong weekday
      ['Sun, 31 Feb 2021 12:00:00 GMT', fixedNowMs, null] // non-existent date
    ])('parseRetryAfterMs(%j, %s) -> %s', (header, nowMs, expected) => {
      expect(parseRetryAfterMs(header, nowMs)).toBe(expected);
    });

    it('returns null on non-finite nowMs', () => {
      expect(parseRetryAfterMs('10', NaN)).toBeNull();
      expect(parseRetryAfterMs('10', Infinity)).toBeNull();
    });
  });

  describe('computeRetryDelayMs', () => {
    it('computes exact retry delays with sequenceRandom', () => {
      const rng1 = createDeterministicRandom([0.0]);
      expect(computeRetryDelayMs(1, null, 10000, rng1)).toBe(1000);

      const rng2 = createDeterministicRandom([0.5]);
      expect(computeRetryDelayMs(1, null, 10000, rng2)).toBe(1125);

      const rng3 = createDeterministicRandom([0.996]);
      expect(computeRetryDelayMs(1, null, 10000, rng3)).toBe(1249);

      const rng4 = createDeterministicRandom([0.0]);
      expect(computeRetryDelayMs(2, null, 10000, rng4)).toBe(2000);

      const rng5 = createDeterministicRandom([0.0]);
      expect(computeRetryDelayMs(3, null, 10000, rng5)).toBe(4000);
    });

    it('stops at 4 attempts and consumes no RNG on stopped retry', () => {
      const emptyRng = createDeterministicRandom([]);
      expect(computeRetryDelayMs(4, null, 10000, emptyRng)).toBeNull();
      expect(computeRetryDelayMs(5, null, 10000, emptyRng)).toBeNull();
      expect(emptyRng.remaining()).toBe(0);
    });

    it('handles header > budget stops vs fits and never clamps downward', () => {
      const rngFits = createDeterministicRandom([0.0]);
      // delay = max(1000, 5000) = 5000; budget = 6000 -> fits
      expect(computeRetryDelayMs(1, 5000, 6000, rngFits)).toBe(5000);

      const rngStops = createDeterministicRandom([0.0]);
      // delay = max(1000, 5000) = 5000; budget = 4000 -> stops (null), does not clamp to 4000
      expect(computeRetryDelayMs(1, 5000, 4000, rngStops)).toBeNull();
    });

    it('stops at boundary equal to budget', () => {
      const rngEqual = createDeterministicRandom([0.0]); // delay 1000
      expect(computeRetryDelayMs(1, null, 1000, rngEqual)).toBeNull();

      const rngFits = createDeterministicRandom([0.0]); // delay 1000
      expect(computeRetryDelayMs(1, null, 1001, rngFits)).toBe(1000);
    });

    it('rejects invalid inputs with safe CONFIG_INVALID error', () => {
      const validRng = { next: () => 0.1 };
      const expectConfigInvalid = (fn: () => void) => {
        expect(fn).toThrow(DomainError);
        try {
          fn();
        } catch (err) {
          expect((err as DomainError).code).toBe('CONFIG_INVALID');
        }
      };

      expectConfigInvalid(() => computeRetryDelayMs(0, null, 5000, validRng));
      expectConfigInvalid(() => computeRetryDelayMs(-1, null, 5000, validRng));
      expectConfigInvalid(() => computeRetryDelayMs(1.5, null, 5000, validRng));
      expectConfigInvalid(() => computeRetryDelayMs(NaN, null, 5000, validRng));
      expectConfigInvalid(() => computeRetryDelayMs(1, null, NaN, validRng));
      expectConfigInvalid(() => computeRetryDelayMs(1, null, Infinity, validRng));
      expectConfigInvalid(() => computeRetryDelayMs(1, -1, 5000, validRng));
      expectConfigInvalid(() => computeRetryDelayMs(1, NaN, 5000, validRng));
      expectConfigInvalid(() => computeRetryDelayMs(1, null, 5000, null as unknown as Parameters<typeof computeRetryDelayMs>[3]));
      expectConfigInvalid(() => computeRetryDelayMs(1, null, 5000, { next: () => -0.1 }));
      expectConfigInvalid(() => computeRetryDelayMs(1, null, 5000, { next: () => 1.0 }));
      expectConfigInvalid(() => computeRetryDelayMs(1, null, 5000, { next: () => NaN }));
    });

    it('exports clear reviewed policy constants', () => {
      expect(MAX_ATTEMPTS).toBe(4);
      expect(BASE_RETRY_DELAYS_MS).toEqual([1000, 2000, 4000]);
    });
  });
});
