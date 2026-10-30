import { describe, it, expect } from 'vitest';
import {
  DomainError,
  toSafeDomainError,
  SAFE_ERROR_MESSAGES,
  getErrorCategory,
  getDefaultRetryClassification,
  isRetryable,
  isErrorCode,
  isDomainError,
  type ErrorCode
} from '../../src/contracts/errors';

describe('Safe Domain Errors', () => {
  describe('Adversarial string and secret suppression', () => {
    const LEAK_SAMPLES = [
      'ya29.a0AfH6SMB_secret_access_token_12345',
      'AIzaSyD-raw-google-api-key-leaked',
      'Bearer ya29.very_secret_token_value',
      'client_secret_xyz_987654321',
      '<script>alert("xss")</script>',
      'https://accounts.google.com/o/oauth2/token?code=secret_code_123'
    ];

    it('does not leak arbitrary raw Error.message text or tokens into safe error', () => {
      for (const secret of LEAK_SAMPLES) {
        const rawError = new Error(`Network failed with token ${secret} on endpoint https://example.com`);
        const safe = toSafeDomainError(rawError);

        expect(safe.message).not.toContain(secret);
        expect(safe.safeMessage).not.toContain(secret);
        expect(safe.safeMessage).toBe(SAFE_ERROR_MESSAGES.INTERNAL_ERROR);
        expect(JSON.stringify(safe)).not.toContain(secret);
      }
    });

    it('does not leak raw strings or primitives passed as errors', () => {
      for (const secret of LEAK_SAMPLES) {
        const safe = toSafeDomainError(secret);

        expect(safe.message).not.toContain(secret);
        expect(safe.safeMessage).toBe(SAFE_ERROR_MESSAGES.INTERNAL_ERROR);
      }
    });

    it('discards adversarial message properties when code is recognized', () => {
      const adversary = {
        code: 'RATE_LIMITED' as ErrorCode,
        message: 'Bearer ya29.secret_token leaked in custom payload'
      };

      const safe = toSafeDomainError(adversary);
      expect(safe.code).toBe('RATE_LIMITED');
      expect(safe.message).toBe(SAFE_ERROR_MESSAGES.RATE_LIMITED);
      expect(safe.message).not.toContain('ya29');
      expect(safe.message).not.toContain('secret_token');
    });

    it('sanitizes AbortError into OPERATION_ABORTED without echoing custom properties', () => {
      const abortError = {
        name: 'AbortError',
        message: 'Aborted while reading token ya29.secret'
      };

      const safe = toSafeDomainError(abortError);
      expect(safe.code).toBe('OPERATION_ABORTED');
      expect(safe.category).toBe('cancel');
      expect(safe.retryable).toBe(false);
      expect(safe.message).not.toContain('ya29');
    });

    it('sanitizes null, undefined, and non-object errors into INTERNAL_ERROR', () => {
      expect(toSafeDomainError(null).code).toBe('INTERNAL_ERROR');
      expect(toSafeDomainError(undefined).code).toBe('INTERNAL_ERROR');
      expect(toSafeDomainError(12345).code).toBe('INTERNAL_ERROR');
      expect(toSafeDomainError(true).code).toBe('INTERNAL_ERROR');
    });
  });

  describe('Code and retry classification retention', () => {
    it('preserves known codes while rebuilding safe errors', () => {
      const original = new DomainError('RATE_LIMITED');
      const safe = toSafeDomainError(original);
      expect(safe).not.toBe(original);
      expect(safe.code).toBe('RATE_LIMITED');
      expect(safe.category).toBe('quota');
      expect(safe.retryClassification).toBe('rate_limit');
      expect(safe.retryable).toBe(true);
    });

    it('does not trust a mutated DomainError message or attached private properties', () => {
      const original = new DomainError('RESTRICTED_EXPORT_DENIED');
      original.message = 'Bearer synthetic-private-value';
      Object.assign(original, { accessToken: 'synthetic-private-value' });
      const safe = toSafeDomainError(original);
      expect(safe.message).toBe(SAFE_ERROR_MESSAGES.RESTRICTED_EXPORT_DENIED);
      expect(JSON.stringify(safe)).not.toContain('synthetic-private-value');
      expect(safe.retryClassification).toBe('none');
    });

    it('handles hostile getters without echoing their thrown message', () => {
      const hostile = { get name(): string { throw new Error('synthetic-private-value'); } };
      const safe = toSafeDomainError(hostile);
      expect(safe.code).toBe('INTERNAL_ERROR');
      expect(safe.message).not.toContain('synthetic-private-value');
    });

    it('classifies retry categories correctly across representative codes', () => {
      // Rate limit / Quota
      expect(getDefaultRetryClassification('RATE_LIMITED')).toBe('rate_limit');
      expect(getDefaultRetryClassification('QUOTA_EXCEEDED')).toBe('rate_limit');
      expect(isRetryable('RATE_LIMITED')).toBe(true);

      // Transient network
      expect(getDefaultRetryClassification('NETWORK_TIMEOUT')).toBe('network');
      expect(getDefaultRetryClassification('NETWORK_OFFLINE')).toBe('network');
      expect(getDefaultRetryClassification('NETWORK_SERVER_ERROR')).toBe('network');
      expect(isRetryable('NETWORK_TIMEOUT')).toBe(true);

      // Auth refresh
      expect(getDefaultRetryClassification('AUTH_EXPIRED')).toBe('auth_refresh');
      expect(isRetryable('AUTH_EXPIRED')).toBe(true);

      // Non-retryable
      const nonRetryableCodes: ErrorCode[] = [
        'CONFIG_INVALID',
        'AUTH_REQUIRED',
        'ADMIN_APPROVAL_REQUIRED',
        'RESTRICTED_ACCESS',
        'UNCERTAIN_PERMISSION',
        'SOURCE_NOT_FOUND',
        'RANGE_OUT_OF_BOUNDS',
        'SIZE_LIMIT_EXCEEDED',
        'FORMAT_UNSUPPORTED',
        'JOB_CANCELLED',
        'OPERATION_ABORTED',
        'SOURCE_CHANGED_CONCURRENTLY',
        'INTERNAL_ERROR'
      ];

      for (const code of nonRetryableCodes) {
        expect(getDefaultRetryClassification(code)).toBe('none');
        expect(isRetryable(code)).toBe(false);
      }
    });

    it('maps all error codes to their declared category', () => {
      expect(getErrorCategory('CONFIG_INVALID')).toBe('config');
      expect(getErrorCategory('AUTH_REQUIRED')).toBe('auth');
      expect(getErrorCategory('ADMIN_RESTRICTED')).toBe('admin');
      expect(getErrorCategory('RESTRICTED_ACCESS')).toBe('restricted');
      expect(getErrorCategory('UNCERTAIN_PERMISSION')).toBe('uncertain');
      expect(getErrorCategory('SOURCE_NOT_FOUND')).toBe('source');
      expect(getErrorCategory('RANGE_OUT_OF_BOUNDS')).toBe('range');
      expect(getErrorCategory('SIZE_LIMIT_EXCEEDED')).toBe('size');
      expect(getErrorCategory('FORMAT_UNSUPPORTED')).toBe('format');
      expect(getErrorCategory('QUOTA_EXCEEDED')).toBe('quota');
      expect(getErrorCategory('NETWORK_TIMEOUT')).toBe('network');
      expect(getErrorCategory('JOB_CANCELLED')).toBe('cancel');
      expect(getErrorCategory('SOURCE_CHANGED_CONCURRENTLY')).toBe('changed');
      expect(getErrorCategory('INTERNAL_ERROR')).toBe('internal');
    });

    it('provides type guards isDomainError and isErrorCode', () => {
      const err = new DomainError('AUTH_REQUIRED');
      expect(isDomainError(err)).toBe(true);
      expect(isDomainError(new Error('test'))).toBe(false);
      expect(isDomainError(null)).toBe(false);

      expect(isErrorCode('AUTH_REQUIRED')).toBe(true);
      expect(isErrorCode('UNKNOWN_CODE')).toBe(false);
      expect(isErrorCode(42)).toBe(false);
    });
  });

  describe('Catalog invariant checks (without mirroring strings)', () => {
    it('ensures every catalog entry is a non-empty string without template artifacts', () => {
      for (const [code, msg] of Object.entries(SAFE_ERROR_MESSAGES)) {
        expect(typeof msg).toBe('string');
        expect(msg.length).toBeGreaterThan(10);
        expect(msg).not.toContain('${');
        expect(msg).not.toContain('undefined');
        expect(msg).not.toContain('null');
        // Validates that getErrorCategory handles each catalog code without throwing
        expect(getErrorCategory(code as ErrorCode)).toBeDefined();
      }
    });
  });
});
