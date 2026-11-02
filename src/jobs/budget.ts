/**
 * T23b Bounded Pure Offline Job Budget Counter
 *
 * Tracks cumulative chunks, emitted cells, decoded bytes, and output bytes
 * against provisional architectural ceilings with atomic preflight checks,
 * overflow safety, and permanent error latching.
 *
 * Invariants & Guarantees:
 * 1. Pure offline counter: no network, no clock/timers, no auth/permissions,
 *    no memory/heap estimation, and no AbortSignal or streaming/adapter responsibility.
 * 2. Provisional ceilings:
 *    - maxChunks: 1..4096 (PROVISIONAL_MAX_CHUNKS)
 *    - maxCells: 0..250,000 (PROVISIONAL_MAX_CELLS)
 *    - maxDecodedBytes: 0..64 MiB (PROVISIONAL_MAX_DECODED_BYTES)
 *    - maxOutputBytes: 0..128 MiB (PROVISIONAL_MAX_OUTPUT_BYTES, proposed architectural cap)
 * 3. Single-capture configuration: options are read exactly once in a protective boundary;
 *    hostile getters and invalid numbers throw static DomainError('CONFIG_INVALID').
 * 4. Deltas: strictly primitive safe non-negative integers (no -0). Objects and Proxies
 *    are never probed for properties, getters, or valueOf coercion. Malformed deltas
 *    latch and throw DomainError('INTERNAL_ERROR').
 * 5. Atomic preflight: recordChunk verifies +1 chunk, +cells, and +decodedBytes before
 *    mutating any counter. If any check fails, zero increments commit.
 * 6. Overflow safety: limits are preflighted using `delta > cap - current` prior to addition.
 * 7. Permanent error latching: on any recording failure, the safe ErrorCode is permanently
 *    latched. No subsequent record call may advance; each throws a fresh DomainError.
 * 8. Immutable snapshot: snapshot() returns a freshly frozen primitive copy of accepted counts,
 *    readable at any time (including after failure).
 * 9. No reuse: counter does not provide reset(); new jobs require a fresh counter instance.
 */

import { DomainError, type ErrorCode } from '../contracts/errors.ts';
import { PROVISIONAL_MAX_CHUNKS } from '../export/coverage.ts';
import { PROVISIONAL_MAX_CELLS } from '../export/cells.ts';
import { PROVISIONAL_MAX_DECODED_BYTES } from '../export/chunk-snapshot.ts';

/** Provisional ceiling on total chunk count per job. */
export { PROVISIONAL_MAX_CHUNKS };

/** Provisional ceiling on total emitted cells per job. */
export { PROVISIONAL_MAX_CELLS };

/** Provisional ceiling on cumulative decoded grid bytes per job (64 MiB). */
export { PROVISIONAL_MAX_DECODED_BYTES };

/** Provisional architectural ceiling on cumulative output bytes per job (128 MiB). */
export const PROVISIONAL_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

/** Closed options contract for job budget creation. */
export interface JobBudgetOptions {
  readonly maxChunks: number;
  readonly maxCells: number;
  readonly maxDecodedBytes: number;
  readonly maxOutputBytes: number;
}

/** Immutable snapshot of current accepted job budget counts. */
export interface JobBudgetSnapshot {
  readonly chunks: number;
  readonly cells: number;
  readonly decodedBytes: number;
  readonly outputBytes: number;
}

/** Pure offline job budget counter interface. */
export interface JobBudget {
  recordChunk(decodedBytes: number, emittedCells: number): void;
  recordOutput(bytes: number): void;
  snapshot(): JobBudgetSnapshot;
}

function isSafeIntegerInRange(val: unknown, min: number, max: number): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= min && val <= max && !Object.is(val, -0);
}

function isNonNegativeSafeInt(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && !Object.is(val, -0);
}

/**
 * Creates a bounded, pure offline job budget counter.
 *
 * @param options Explicit ceiling limits for chunks, cells, decoded bytes, and output bytes.
 * @returns Frozen JobBudget instance.
 * @throws DomainError('CONFIG_INVALID') if options or limits are invalid.
 */
export function createJobBudget(options: JobBudgetOptions): JobBudget {
  let maxChunks: number;
  let maxCells: number;
  let maxDecodedBytes: number;
  let maxOutputBytes: number;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new DomainError('CONFIG_INVALID');
    }
    maxChunks = options.maxChunks;
    maxCells = options.maxCells;
    maxDecodedBytes = options.maxDecodedBytes;
    maxOutputBytes = options.maxOutputBytes;
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }

  if (
    !isSafeIntegerInRange(maxChunks, 1, PROVISIONAL_MAX_CHUNKS) ||
    !isSafeIntegerInRange(maxCells, 0, PROVISIONAL_MAX_CELLS) ||
    !isSafeIntegerInRange(maxDecodedBytes, 0, PROVISIONAL_MAX_DECODED_BYTES) ||
    !isSafeIntegerInRange(maxOutputBytes, 0, PROVISIONAL_MAX_OUTPUT_BYTES)
  ) {
    throw new DomainError('CONFIG_INVALID');
  }

  let currentChunks = 0;
  let currentCells = 0;
  let currentDecodedBytes = 0;
  let currentOutputBytes = 0;
  let latchedErrorCode: ErrorCode | null = null;

  function recordChunk(decodedBytes: number, emittedCells: number): void {
    if (latchedErrorCode !== null) {
      throw new DomainError(latchedErrorCode);
    }

    if (!isNonNegativeSafeInt(decodedBytes) || !isNonNegativeSafeInt(emittedCells)) {
      latchedErrorCode = 'INTERNAL_ERROR';
      throw new DomainError('INTERNAL_ERROR');
    }

    // Atomic preflight: +1 chunk
    if (1 > maxChunks - currentChunks) {
      latchedErrorCode = 'SIZE_LIMIT_EXCEEDED';
      throw new DomainError('SIZE_LIMIT_EXCEEDED');
    }

    // Atomic preflight: +cells
    if (emittedCells > maxCells - currentCells) {
      latchedErrorCode = 'CELL_LIMIT_EXCEEDED';
      throw new DomainError('CELL_LIMIT_EXCEEDED');
    }

    // Atomic preflight: +actual decoded bytes
    if (decodedBytes > maxDecodedBytes - currentDecodedBytes) {
      latchedErrorCode = 'BYTE_LIMIT_EXCEEDED';
      throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }

    // All preflights passed: atomically commit all increments
    currentChunks += 1;
    currentCells += emittedCells;
    currentDecodedBytes += decodedBytes;
  }

  function recordOutput(bytes: number): void {
    if (latchedErrorCode !== null) {
      throw new DomainError(latchedErrorCode);
    }

    if (!isNonNegativeSafeInt(bytes)) {
      latchedErrorCode = 'INTERNAL_ERROR';
      throw new DomainError('INTERNAL_ERROR');
    }

    // Overflow-safe preflight: +output bytes
    if (bytes > maxOutputBytes - currentOutputBytes) {
      latchedErrorCode = 'BYTE_LIMIT_EXCEEDED';
      throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }

    // Commit cumulative output bytes
    currentOutputBytes += bytes;
  }

  function snapshot(): JobBudgetSnapshot {
    return Object.freeze({
      chunks: currentChunks,
      cells: currentCells,
      decodedBytes: currentDecodedBytes,
      outputBytes: currentOutputBytes
    });
  }

  return Object.freeze({
    recordChunk,
    recordOutput,
    snapshot
  });
}
