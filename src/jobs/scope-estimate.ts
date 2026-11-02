/**
 * T23a Bounded Offline Scope Estimator
 *
 * Computes exact coordinate geometry preview metrics (selected positions and initial
 * chunk count matching reviewed 2D tiling) over requested ExportScopes without
 * allocating chunk plans, cell arrays, or inspecting cell values.
 *
 * Invariants & Guarantees:
 * 1. Pure offline estimator: no network, no clock, no auth/permission evaluation,
 *    no memory allocation for planned chunks or cell grids.
 * 2. BigInt arithmetic: coordinate intervals and chunk counts are calculated in BigInt;
 *    valid safe coordinates whose products exceed Number.MAX_SAFE_INTEGER are previewed
 *    accurately without integer overflow or premature plan materialization.
 * 3. 2D Tiling fidelity: initialChunks strictly replicates reviewed planChunks tiling logic:
 *    colsStep = min(width, budget), rowsStep = max(1, floor(budget / colsStep)),
 *    perScope = ceil(height / rowsStep) * ceil(width / colsStep).
 * 4. Closed shape validation: strictly requires exact own enumerable keys for scopes and rects;
 *    rejects Symbol keys, inherited properties, extra keys, reversed bounds, negative coordinates,
 *    -0, non-safe integers, duplicate sheet IDs, and mismatched scope/rect sheet IDs.
 * 5. Safe error reconstruction: hostile throwing getters and unknown errors are converted
 *    to safe catalog DomainErrors with static messages; raw diagnostics are never leaked.
 * 6. Immutability: caller inputs are never mutated or frozen; returned estimate is freshly frozen.
 * 7. Cancellation: AbortSignal is validated, pre-checked, polled per scope, and gated at a final fence.
 * 8. Uncalibrated provisional limits: limits are provisional pending T06/T41 benchmarks;
 *    this module does not make production acquisition, permission, or release claims.
 */

import type { ExportScope, Rect } from '../contracts/domain.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { PROVISIONAL_MAX_CHUNKS } from '../export/coverage.ts';

/**
 * Provisional uncalibrated cap on total selected positions per job pending T06/T41.
 */
export const PROVISIONAL_MAX_SELECTED_POSITIONS = 10_000_000;

/**
 * Provisional warning threshold for large scope selection (>= 1M positions) pending T06/T41.
 */
export const PROVISIONAL_WARN_POSITIONS = 1_000_000;

/**
 * Closed options contract for offline scope estimation.
 */
export interface EstimateScopeOptions {
  readonly maxPositions: number;
  readonly maxChunks: number;
  readonly chunkPositions: number;
  readonly signal: AbortSignal;
}

/**
 * Immutable offline scope estimation result.
 * Note: decodedBytes and outputBytes are explicitly null because runtime byte sizes
 * cannot be guessed from coordinate bounds alone before retrieval.
 */
export interface ScopeEstimate {
  readonly selectedPositions: bigint;
  readonly initialChunks: bigint;
  readonly exceedsPositionLimit: boolean;
  readonly exceedsChunkLimit: boolean;
  readonly largeScopeWarning: boolean;
  readonly decodedBytes: null;
  readonly outputBytes: null;
}

const SCOPE_KEYS = ['sheetId', 'rect'] as const;
const RECT_KEYS = ['sheetId', 'r0', 'c0', 'r1', 'c1'] as const;

function isNonNegativeSafeInt(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && !Object.is(val, -0);
}

function hasExactKeys(obj: unknown, expectedKeys: readonly string[]): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (Object.getOwnPropertySymbols(obj).length > 0) return false;
  const keys = Object.keys(obj);
  if (keys.length !== expectedKeys.length) return false;
  for (let i = 0; i < keys.length; i++) {
    if (!expectedKeys.includes(keys[i])) return false;
  }
  for (let i = 0; i < expectedKeys.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(obj, expectedKeys[i])) return false;
  }
  for (const k in obj) {
    if (!expectedKeys.includes(k)) return false;
  }
  return true;
}

function checkSignal(signal: AbortSignal): void {
  let isAborted = false;
  try {
    isAborted = signal.aborted;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('CONFIG_INVALID');
  }
  if (isAborted) {
    throw new DomainError('OPERATION_ABORTED');
  }
}

/**
 * Estimates total selected coordinate positions and initial chunk counts for requested scopes.
 *
 * @param scopes Caller-provided array of export scopes.
 * @param options Validated estimation options including limits and abort signal.
 * @returns Freshly frozen ScopeEstimate preview.
 */
export function estimateScopes(
  scopes: readonly ExportScope[],
  options: EstimateScopeOptions
): ScopeEstimate {
  // 1. Single capture and validation of options
  let maxPositions: number;
  let maxChunks: number;
  let chunkPositions: number;
  let signal: AbortSignal;
  let aborted = false;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new DomainError('CONFIG_INVALID');
    }

    const rawMaxPositions = options.maxPositions;
    const rawMaxChunks = options.maxChunks;
    const rawChunkPositions = options.chunkPositions;
    const rawSignal = options.signal;

    if (
      typeof rawMaxPositions !== 'number' ||
      !Number.isSafeInteger(rawMaxPositions) ||
      Object.is(rawMaxPositions, -0) ||
      rawMaxPositions < 1 ||
      rawMaxPositions > PROVISIONAL_MAX_SELECTED_POSITIONS
    ) {
      throw new DomainError('CONFIG_INVALID');
    }

    if (
      typeof rawMaxChunks !== 'number' ||
      !Number.isSafeInteger(rawMaxChunks) ||
      Object.is(rawMaxChunks, -0) ||
      rawMaxChunks < 1 ||
      rawMaxChunks > PROVISIONAL_MAX_CHUNKS
    ) {
      throw new DomainError('CONFIG_INVALID');
    }

    if (
      typeof rawChunkPositions !== 'number' ||
      !Number.isSafeInteger(rawChunkPositions) ||
      Object.is(rawChunkPositions, -0) ||
      rawChunkPositions < 1
    ) {
      throw new DomainError('CONFIG_INVALID');
    }

    if (
      !rawSignal ||
      typeof rawSignal !== 'object' ||
      typeof (rawSignal as any).aborted !== 'boolean' ||
      typeof (rawSignal as any).addEventListener !== 'function' ||
      typeof (rawSignal as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }

    aborted = rawSignal.aborted;
    maxPositions = rawMaxPositions;
    maxChunks = rawMaxChunks;
    chunkPositions = rawChunkPositions;
    signal = rawSignal;
  } catch (err) {
    throw new DomainError('CONFIG_INVALID');
  }

  // Pre-abort check
  if (aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // 2. Validate scopes container bounds
  let scopeCount: number;
  try {
    if (!Array.isArray(scopes)) {
      throw new DomainError('RANGE_INVALID');
    }
    scopeCount = scopes.length;
    if (!Number.isSafeInteger(scopeCount) || scopeCount < 0) throw new DomainError('RANGE_INVALID');
    if (scopeCount === 0) {
      throw new DomainError('RANGE_EMPTY');
    }
    if (scopeCount > PROVISIONAL_MAX_CHUNKS) {
      throw new DomainError('RANGE_INVALID');
    }
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('RANGE_INVALID');
  }

  // 3. Process scopes in source order with BigInt aggregation
  const budget = BigInt(chunkPositions);
  let totalPositions = 0n;
  let totalChunks = 0n;
  const seenSheetIds = new Set<number>();

  for (let i = 0; i < scopeCount; i++) {
    checkSignal(signal);

    let scopeSheetId: number;
    let rect: Rect;
    let rectSheetId: number;
    let r0: number;
    let c0: number;
    let r1: number;
    let c1: number;

    try {
      const scope = scopes[i];
      if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
        throw new DomainError('RANGE_INVALID');
      }
      if (!hasExactKeys(scope, SCOPE_KEYS)) {
        throw new DomainError('RANGE_INVALID');
      }

      scopeSheetId = scope.sheetId;
      rect = scope.rect;

      if (!isNonNegativeSafeInt(scopeSheetId)) {
        throw new DomainError('RANGE_INVALID');
      }

      if (seenSheetIds.has(scopeSheetId)) {
        throw new DomainError('RANGE_INVALID');
      }

      if (!rect || typeof rect !== 'object' || Array.isArray(rect)) {
        throw new DomainError('RANGE_INVALID');
      }
      if (!hasExactKeys(rect, RECT_KEYS)) {
        throw new DomainError('RANGE_INVALID');
      }

      rectSheetId = rect.sheetId;
      r0 = rect.r0;
      c0 = rect.c0;
      r1 = rect.r1;
      c1 = rect.c1;

      if (rectSheetId !== scopeSheetId) {
        throw new DomainError('RANGE_INVALID');
      }

      if (
        !isNonNegativeSafeInt(r0) ||
        !isNonNegativeSafeInt(c0) ||
        !isNonNegativeSafeInt(r1) ||
        !isNonNegativeSafeInt(c1)
      ) {
        throw new DomainError('RANGE_INVALID');
      }

      if (r1 < r0 || c1 < c0) {
        throw new DomainError('RANGE_INVALID');
      }
      if (r1 === r0 || c1 === c0) {
        throw new DomainError('RANGE_EMPTY');
      }
    } catch (err) {
      if (err instanceof DomainError) {
        throw toSafeDomainError(err);
      }
      throw new DomainError('RANGE_INVALID');
    }

    seenSheetIds.add(scopeSheetId);

    const width = BigInt(c1) - BigInt(c0);
    const height = BigInt(r1) - BigInt(r0);
    const scopePositions = width * height;

    const colsStep = width < budget ? width : budget;
    const rawRowsStep = budget / colsStep;
    const rowsStep = rawRowsStep > 1n ? rawRowsStep : 1n;

    const colChunks = (width + colsStep - 1n) / colsStep;
    const rowChunks = (height + rowsStep - 1n) / rowsStep;
    const scopeChunks = colChunks * rowChunks;

    totalPositions += scopePositions;
    totalChunks += scopeChunks;
  }

  // 4. Final fence check
  checkSignal(signal);

  // 5. Evaluate limit flags and freeze result
  const exceedsPositionLimit = totalPositions > BigInt(maxPositions);
  const exceedsChunkLimit = totalChunks > BigInt(maxChunks);
  const largeScopeWarning = totalPositions >= BigInt(PROVISIONAL_WARN_POSITIONS);

  const estimate: ScopeEstimate = Object.freeze({
    selectedPositions: totalPositions,
    initialChunks: totalChunks,
    exceedsPositionLimit,
    exceedsChunkLimit,
    largeScopeWarning,
    decodedBytes: null,
    outputBytes: null
  });

  return estimate;
}
