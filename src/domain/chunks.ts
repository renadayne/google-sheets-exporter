/**
 * T14a Deterministic 2D Tiling and Chunk Splitting
 *
 * Implements pure 2D partitioning and binary chunk splitting over half-open Rect intervals.
 *
 * Invariants & Guarantees:
 * 1. Pure functions: no side-effects, no input mutation, no network, no clock or random dependencies.
 * 2. Deterministic IDs: stable strings encoding sheet ID and absolute bounds [r0, c0, r1, c1).
 * 3. Bounded: every planned chunk has positive area <= maxPositions.
 * 4. Coordinate preservation: retains absolute sheet offsets; row-major deterministic ordering.
 * 5. Provisional default: DEFAULT_MAX_POSITIONS = 20,000 is an uncalibrated default pending T06/T41.
 * 6. Binary splitting: splits longer dimension (ties broken towards rows) at safe difference midpoint.
 *    Cannot split 1x1 chunk; throws RANGE_INVALID.
 * 7. Validation: rejects empty, reversed, fractional, negative, non-finite, and unsafe coordinates/budgets.
 */

import type { Rect } from '../contracts/domain.ts';
import { DomainError } from '../contracts/errors.ts';

/**
 * Provisional, uncalibrated default chunk position budget pending T06/T41 benchmarks.
 */
export const DEFAULT_MAX_POSITIONS = 20_000;

export interface PlannedChunk {
  readonly id: string;
  readonly rect: Rect;
}

export function createChunkId(rect: Rect): string {
  return `chunk_${rect.sheetId}_${rect.r0}_${rect.c0}_${rect.r1}_${rect.c1}`;
}

function validateRect(rect: unknown): Rect {
  if (!rect || typeof rect !== 'object') {
    throw new DomainError('RANGE_INVALID');
  }
  const r = rect as Record<string, unknown>;
  const { sheetId, r0, c0, r1, c1 } = r;

  if (
    typeof sheetId !== 'number' ||
    !Number.isSafeInteger(sheetId) ||
    sheetId < 0 ||
    typeof r0 !== 'number' ||
    !Number.isSafeInteger(r0) ||
    r0 < 0 ||
    typeof c0 !== 'number' ||
    !Number.isSafeInteger(c0) ||
    c0 < 0 ||
    typeof r1 !== 'number' ||
    !Number.isSafeInteger(r1) ||
    r1 < 0 ||
    typeof c1 !== 'number' ||
    !Number.isSafeInteger(c1) ||
    c1 < 0
  ) {
    throw new DomainError('RANGE_INVALID');
  }

  if (r1 < r0 || c1 < c0) {
    throw new DomainError('RANGE_INVALID');
  }
  if (r1 === r0 || c1 === c0) {
    throw new DomainError('RANGE_EMPTY');
  }

  const height = r1 - r0;
  const width = c1 - c0;
  if (!Number.isSafeInteger(width * height)) {
    throw new DomainError('RANGE_INVALID');
  }

  return { sheetId, r0, c0, r1, c1 };
}

function validateBudget(maxPositions: unknown): number {
  if (
    typeof maxPositions !== 'number' ||
    !Number.isSafeInteger(maxPositions) ||
    maxPositions < 1
  ) {
    throw new DomainError('RANGE_INVALID');
  }
  return maxPositions;
}

function freezeChunk(sheetId: number, r0: number, c0: number, r1: number, c1: number): PlannedChunk {
  const rect: Rect = Object.freeze({ sheetId, r0, c0, r1, c1 });
  return Object.freeze({
    id: createChunkId(rect),
    rect
  });
}

/**
 * Plans a deterministic 2D tiling of a rectangular coordinate range into chunks
 * each having a cell position count <= maxPositions.
 */
export function planChunks(
  rect: Rect,
  maxPositions: number = DEFAULT_MAX_POSITIONS
): readonly PlannedChunk[] {
  const validRect = validateRect(rect);
  const budget = validateBudget(maxPositions);

  const totalCols = validRect.c1 - validRect.c0;

  const stepCols = Math.min(totalCols, budget);
  const stepRows = Math.max(1, Math.floor(budget / stepCols));

  const chunks: PlannedChunk[] = [];
  for (let r = validRect.r0; r < validRect.r1;) {
    const rEnd = r + Math.min(stepRows, validRect.r1 - r);
    for (let c = validRect.c0; c < validRect.c1;) {
      const cEnd = c + Math.min(stepCols, validRect.c1 - c);
      chunks.push(freezeChunk(validRect.sheetId, r, c, rEnd, cEnd));
      c = cEnd;
    }
    r = rEnd;
  }

  return Object.freeze(chunks);
}

/**
 * Deterministically splits a chunk into two non-overlapping children whose exact union equals parent.
 * Splits longer dimension, ties broken towards rows.
 */
export function splitChunk(chunk: PlannedChunk): readonly [PlannedChunk, PlannedChunk] {
  if (!chunk || typeof chunk !== 'object') {
    throw new DomainError('RANGE_INVALID');
  }
  const validRect = validateRect(chunk.rect);
  if (chunk.id !== createChunkId(validRect)) throw new DomainError('RANGE_INVALID');
  const height = validRect.r1 - validRect.r0;
  const width = validRect.c1 - validRect.c0;

  if (height === 1 && width === 1) {
    throw new DomainError('RANGE_INVALID');
  }

  if (height >= width) {
    const mid = validRect.r0 + Math.floor(height / 2);
    const child1 = freezeChunk(validRect.sheetId, validRect.r0, validRect.c0, mid, validRect.c1);
    const child2 = freezeChunk(validRect.sheetId, mid, validRect.c0, validRect.r1, validRect.c1);
    return Object.freeze([child1, child2]);
  } else {
    const mid = validRect.c0 + Math.floor(width / 2);
    const child1 = freezeChunk(validRect.sheetId, validRect.r0, validRect.c0, validRect.r1, mid);
    const child2 = freezeChunk(validRect.sheetId, validRect.r0, mid, validRect.r1, validRect.c1);
    return Object.freeze([child1, child2]);
  }
}
