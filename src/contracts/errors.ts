/**
 * T08b Safe Domain Errors
 * Safe error codes, retry classifications, fixed catalog messages, and sanitizers.
 * Crucial invariant: Arbitrary Error.message, raw HTTP bodies, cause objects, or token strings
 * are NEVER echoed into domain error messages or UI logs.
 */

export type ErrorCategory =
  | 'config'
  | 'auth'
  | 'admin'
  | 'restricted'
  | 'uncertain'
  | 'source'
  | 'range'
  | 'size'
  | 'format'
  | 'quota'
  | 'network'
  | 'cancel'
  | 'changed'
  | 'internal';

export type ConfigErrorCode = 'CONFIG_INVALID' | 'CONFIG_REQUIRED';

export type AuthErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'AUTH_PRINCIPAL_MISMATCH'
  | 'AUTH_USER_CANCELLED';

export type AdminErrorCode =
  | 'ADMIN_APPROVAL_REQUIRED'
  | 'ADMIN_RESTRICTED';

export type RestrictedErrorCode =
  | 'RESTRICTED_ACCESS'
  | 'RESTRICTED_EXPORT_DENIED';

export type UncertainErrorCode = 'UNCERTAIN_PERMISSION';

export type SourceErrorCode =
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_INACCESSIBLE'
  | 'SOURCE_UNSUPPORTED';

export type RangeErrorCode =
  | 'RANGE_OUT_OF_BOUNDS'
  | 'RANGE_EMPTY'
  | 'RANGE_INVALID';

export type SizeErrorCode =
  | 'SIZE_LIMIT_EXCEEDED'
  | 'CELL_LIMIT_EXCEEDED'
  | 'BYTE_LIMIT_EXCEEDED';

export type FormatErrorCode =
  | 'FORMAT_UNSUPPORTED'
  | 'FORMAT_SERIALIZATION_FAILED';

export type QuotaErrorCode = 'QUOTA_EXCEEDED' | 'RATE_LIMITED';

export type NetworkErrorCode =
  | 'NETWORK_TIMEOUT'
  | 'NETWORK_OFFLINE'
  | 'NETWORK_SERVER_ERROR';

export type CancelErrorCode = 'JOB_CANCELLED' | 'OPERATION_ABORTED';

export type ChangedErrorCode = 'SOURCE_CHANGED_CONCURRENTLY';

export type InternalErrorCode = 'INTERNAL_ERROR';

export type ErrorCode =
  | ConfigErrorCode
  | AuthErrorCode
  | AdminErrorCode
  | RestrictedErrorCode
  | UncertainErrorCode
  | SourceErrorCode
  | RangeErrorCode
  | SizeErrorCode
  | FormatErrorCode
  | QuotaErrorCode
  | NetworkErrorCode
  | CancelErrorCode
  | ChangedErrorCode
  | InternalErrorCode;

export type RetryClassification = 'none' | 'network' | 'rate_limit' | 'auth_refresh';

/** Fixed safe user-facing catalog messages; strictly static, no variable interpolation. */
export const SAFE_ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  CONFIG_INVALID: 'Extension configuration is invalid.',
  CONFIG_REQUIRED: 'Required extension configuration is missing.',
  AUTH_REQUIRED: 'Authentication is required. Please sign in.',
  AUTH_EXPIRED: 'Authentication session expired. Re-authentication required.',
  AUTH_PRINCIPAL_MISMATCH: 'Authenticated account does not match the active session.',
  AUTH_USER_CANCELLED: 'Authentication prompt was cancelled by user.',
  ADMIN_APPROVAL_REQUIRED: 'Access requires Google Workspace administrator approval.',
  ADMIN_RESTRICTED: 'Access is restricted by organizational policy.',
  RESTRICTED_ACCESS: 'Access to this spreadsheet is restricted.',
  RESTRICTED_EXPORT_DENIED: 'Export or download is restricted by file owner or policy.',
  UNCERTAIN_PERMISSION: 'Access permission could not be verified with confidence.',
  SOURCE_NOT_FOUND: 'The spreadsheet is missing or inaccessible.',
  SOURCE_INACCESSIBLE: 'The spreadsheet is inaccessible with current credentials.',
  SOURCE_UNSUPPORTED: 'The source contains unsupported features or non-grid content.',
  RANGE_OUT_OF_BOUNDS: 'Requested export range exceeds sheet boundaries.',
  RANGE_EMPTY: 'Select a nonempty coordinate range. Blank data is allowed.',
  RANGE_INVALID: 'Requested export coordinates are invalid.',
  SIZE_LIMIT_EXCEEDED: 'Export exceeds configured size limits.',
  CELL_LIMIT_EXCEEDED: 'Export exceeds maximum allowed cell count.',
  BYTE_LIMIT_EXCEEDED: 'Export exceeds maximum allowed byte count.',
  FORMAT_UNSUPPORTED: 'The requested export format is not supported.',
  FORMAT_SERIALIZATION_FAILED: 'Failed to serialize export format.',
  QUOTA_EXCEEDED: 'Google API quota exceeded. Please try again later.',
  RATE_LIMITED: 'Request rate limit reached. Backing off before retry.',
  NETWORK_TIMEOUT: 'Network request timed out. Please check your connection.',
  NETWORK_OFFLINE: 'Network is unreachable or offline.',
  NETWORK_SERVER_ERROR: 'Remote server encountered a temporary error.',
  JOB_CANCELLED: 'Export job was cancelled.',
  OPERATION_ABORTED: 'Operation was aborted.',
  SOURCE_CHANGED_CONCURRENTLY: 'Spreadsheet was modified during export. Please run again.',
  INTERNAL_ERROR: 'An unexpected internal error occurred.'
});

export function getErrorCategory(code: ErrorCode): ErrorCategory {
  switch (code) {
    case 'CONFIG_INVALID':
    case 'CONFIG_REQUIRED':
      return 'config';
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
    case 'AUTH_PRINCIPAL_MISMATCH':
    case 'AUTH_USER_CANCELLED':
      return 'auth';
    case 'ADMIN_APPROVAL_REQUIRED':
    case 'ADMIN_RESTRICTED':
      return 'admin';
    case 'RESTRICTED_ACCESS':
    case 'RESTRICTED_EXPORT_DENIED':
      return 'restricted';
    case 'UNCERTAIN_PERMISSION':
      return 'uncertain';
    case 'SOURCE_NOT_FOUND':
    case 'SOURCE_INACCESSIBLE':
    case 'SOURCE_UNSUPPORTED':
      return 'source';
    case 'RANGE_OUT_OF_BOUNDS':
    case 'RANGE_EMPTY':
    case 'RANGE_INVALID':
      return 'range';
    case 'SIZE_LIMIT_EXCEEDED':
    case 'CELL_LIMIT_EXCEEDED':
    case 'BYTE_LIMIT_EXCEEDED':
      return 'size';
    case 'FORMAT_UNSUPPORTED':
    case 'FORMAT_SERIALIZATION_FAILED':
      return 'format';
    case 'QUOTA_EXCEEDED':
    case 'RATE_LIMITED':
      return 'quota';
    case 'NETWORK_TIMEOUT':
    case 'NETWORK_OFFLINE':
    case 'NETWORK_SERVER_ERROR':
      return 'network';
    case 'JOB_CANCELLED':
    case 'OPERATION_ABORTED':
      return 'cancel';
    case 'SOURCE_CHANGED_CONCURRENTLY':
      return 'changed';
    case 'INTERNAL_ERROR':
    default:
      return 'internal';
  }
}

export function getDefaultRetryClassification(code: ErrorCode): RetryClassification {
  switch (code) {
    case 'AUTH_EXPIRED':
      return 'auth_refresh';
    case 'RATE_LIMITED':
    case 'QUOTA_EXCEEDED':
      return 'rate_limit';
    case 'NETWORK_TIMEOUT':
    case 'NETWORK_OFFLINE':
    case 'NETWORK_SERVER_ERROR':
      return 'network';
    default:
      return 'none';
  }
}

export function isRetryable(code: ErrorCode): boolean {
  return getDefaultRetryClassification(code) !== 'none';
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SAFE_ERROR_MESSAGES, value);
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly retryClassification: RetryClassification;
  readonly retryable: boolean;
  readonly safeMessage: string;

  constructor(code: ErrorCode) {
    const safeCode = isErrorCode(code) ? code : 'INTERNAL_ERROR';
    const safeMessage = SAFE_ERROR_MESSAGES[safeCode];
    super(safeMessage);
    this.name = 'DomainError';
    this.code = safeCode;
    this.category = getErrorCategory(safeCode);
    this.retryClassification = getDefaultRetryClassification(safeCode);
    this.retryable = this.retryClassification !== 'none';
    this.safeMessage = safeMessage;

    // Discard any raw causes or untrusted parameters; avoid secret leakage in stacks/logs.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

/**
 * Converts an arbitrary unknown error into a safe DomainError.
 * Arbitrary error messages, HTTP response bodies, cause objects, and token strings
 * are NEVER copied or leaked into the returned error or UI logs.
 */
export function toSafeDomainError(error: unknown): DomainError {
  try {
    if (isDomainError(error)) {
      // Rebuild even our own errors: message/stack/extra properties may have been mutated.
      return new DomainError(isErrorCode(error.code) ? error.code : 'INTERNAL_ERROR');
    }
    if (typeof error === 'object' && error !== null) {
      if ('name' in error && error.name === 'AbortError') {
        return new DomainError('OPERATION_ABORTED');
      }
      if ('code' in error && isErrorCode(error.code)) {
        return new DomainError(error.code);
      }
    }
  } catch {
    // Unknown getters/proxies must not break the final sanitization boundary.
  }

  // All other unknown errors map strictly to INTERNAL_ERROR with fixed catalog message
  return new DomainError('INTERNAL_ERROR');
}
