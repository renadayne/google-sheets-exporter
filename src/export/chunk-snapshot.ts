/**
 * T24c1b Normalized Chunk Snapshot and Validation
 * Prerequisite of T24 JSON Writer lifecycle (WriterPort.append).
 * Validates one NormalizedChunk against a validated WriterContext,
 * bounds, cancellation, and internal interval/cell consistency.
 * Carries NO coverage proof or publication authority.
 */

import type { NormalizedChunk, DimensionInterval } from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { isCell } from '../contracts/validation.ts';
import { collectWriterCells, PROVISIONAL_MAX_CELLS } from './cells.ts';
import { collectWriterExclusions, PROVISIONAL_MAX_INTERVALS } from './exclusions.ts';

export { PROVISIONAL_MAX_CELLS } from './cells.ts';
export { PROVISIONAL_MAX_INTERVALS } from './exclusions.ts';
export const PROVISIONAL_MAX_DECODED_BYTES = 64 * 1024 * 1024; // 64 MiB

const CHUNK_KEYS = ['jobId', 'chunkId', 'rect', 'cells', 'excludedIntervals', 'byteCount'] as const;
const RECT_KEYS = ['sheetId', 'r0', 'c0', 'r1', 'c1'] as const;
const EXCLUDED_INTERVALS_KEYS = ['rows', 'columns'] as const;

function isNonNegativeSafeInt(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && !Object.is(val, -0);
}
function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.length > 0;
}
function hasExactKeys(obj: unknown, expectedKeys: readonly string[]): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.getOwnPropertySymbols(obj).length > 0) return false;
  const keys = Object.keys(obj);
  return keys.length === expectedKeys.length && keys.every(k => expectedKeys.includes(k)) &&
    expectedKeys.every(k => Object.prototype.hasOwnProperty.call(obj, k));
}

function isExcluded(intervals: readonly DimensionInterval[], val: number): boolean {
  let low = 0, high = intervals.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1, iv = intervals[mid];
    if (val < iv.start) high = mid - 1;
    else if (val >= iv.end) low = mid + 1;
    else return true;
  }
  return false;
}

export function snapshotWriterChunk(
  context: WriterContext,
  chunk: NormalizedChunk,
  options: {
    readonly maxCells: number;
    readonly maxIntervals: number;
    readonly maxDecodedBytes: number;
    readonly signal: AbortSignal;
  }
): NormalizedChunk {
  let maxCells: number, maxIntervals: number, maxDecodedBytes: number, signal: AbortSignal;
  let aborted = false;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');
    const { maxCells: c, maxIntervals: i, maxDecodedBytes: b, signal: s } = options;
    if (
      !isNonNegativeSafeInt(c) || c > PROVISIONAL_MAX_CELLS ||
      !isNonNegativeSafeInt(i) || i > PROVISIONAL_MAX_INTERVALS ||
      !isNonNegativeSafeInt(b) || b > PROVISIONAL_MAX_DECODED_BYTES ||
      !s || typeof s !== 'object' || typeof (s as any).aborted !== 'boolean' ||
      typeof (s as any).addEventListener !== 'function' ||
      typeof (s as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    aborted = s.aborted; maxCells = c; maxIntervals = i; maxDecodedBytes = b; signal = s;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('CONFIG_INVALID');
  }
  if (aborted) throw new DomainError('OPERATION_ABORTED');

  try {
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    if (!hasExactKeys(chunk, CHUNK_KEYS)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

    const { jobId, chunkId, rect, cells: rawCells, excludedIntervals: rawExcl, byteCount } = chunk;
    if (!isNonEmptyString(jobId) || !isNonEmptyString(chunkId) || !isNonNegativeSafeInt(byteCount)) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    if (byteCount > maxDecodedBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');
    if (!Array.isArray(rawCells)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    if (rawCells.length > maxCells) throw new DomainError('CELL_LIMIT_EXCEEDED');

    if (!hasExactKeys(rawExcl, EXCLUDED_INTERVALS_KEYS)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    const { rows: rawRows, columns: rawCols } = rawExcl;
    if (!Array.isArray(rawRows) || !Array.isArray(rawCols)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    if (rawRows.length + rawCols.length > maxIntervals) throw new DomainError('SIZE_LIMIT_EXCEEDED');

    if (!hasExactKeys(rect, RECT_KEYS)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    const { sheetId, r0, c0, r1, c1 } = rect;
    if (
      !isNonNegativeSafeInt(sheetId) || !isNonNegativeSafeInt(r0) || !isNonNegativeSafeInt(c0) ||
      !isNonNegativeSafeInt(r1) || !isNonNegativeSafeInt(c1) || r0 >= r1 || c0 >= c1
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (!Array.isArray(context.scopes) || !Array.isArray(context.sheetOrder)) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    const matchingScopes = context.scopes.filter(s => s && typeof s === 'object' && s.sheetId === sheetId);
    if (matchingScopes.length !== 1 || !context.sheetOrder.includes(sheetId)) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    const scopeRect = matchingScopes[0].rect;
    if (
      !scopeRect || typeof scopeRect !== 'object' ||
      r0 < scopeRect.r0 || r1 > scopeRect.r1 || c0 < scopeRect.c0 || c1 > scopeRect.c1
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    const tempChunk: NormalizedChunk = {
      jobId, chunkId, rect: Object.freeze({ sheetId, r0, c0, r1, c1 }),
      cells: rawCells, excludedIntervals: Object.freeze({ rows: rawRows, columns: rawCols }), byteCount
    };

    const cellSheets = collectWriterCells(context, [tempChunk], { maxCells, signal });
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

    const exclusionSheets = collectWriterExclusions(context, [tempChunk], { maxIntervals, signal });
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

    const cellEntry = cellSheets.find(e => e.sheetId === sheetId);
    if (!cellEntry) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    const cells = cellEntry.cells;

    const exclEntry = exclusionSheets.find(e => e.sheetId === sheetId);
    if (!exclEntry) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    const { excludedRows, excludedColumns } = exclEntry;

    for (let i = 0; i < cells.length; i++) {
      if ((i & 127) === 0 && signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const cell = cells[i];
      if (!isCell(cell) || isExcluded(excludedRows, cell.r) || isExcluded(excludedColumns, cell.c)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
    }

    return Object.freeze({
      jobId, chunkId, rect: Object.freeze({ sheetId, r0, c0, r1, c1 }),
      cells, excludedIntervals: Object.freeze({ rows: excludedRows, columns: excludedColumns }),
      byteCount
    });
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
