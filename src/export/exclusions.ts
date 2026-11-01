/**
 * T24b1b Pure Exclusion Interval Consistency Helper
 * Shared serializer prerequisite for T24 JSON Writer.
 */

import type { DimensionInterval, NormalizedChunk, SheetExclusions } from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';

export const PROVISIONAL_MAX_INTERVALS = 250000;

const RECT_KEYS = ['sheetId', 'r0', 'c0', 'r1', 'c1'] as const;
const INTERVAL_KEYS = ['start', 'end'] as const;
const EXCLUDED_INTERVALS_KEYS = ['rows', 'columns'] as const;

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
  return expectedKeys.every(k => Object.prototype.hasOwnProperty.call(obj, k));
}

function mergeIntervals(intervals: readonly DimensionInterval[], signal?: AbortSignal): DimensionInterval[] {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: DimensionInterval[] = [];
  let curr = { start: sorted[0].start, end: sorted[0].end };
  for (let i = 1; i < sorted.length; i++) {
    if (signal && (i & 127) === 0 && signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }
    const next = sorted[i];
    if (next.start <= curr.end) {
      curr.end = Math.max(curr.end, next.end);
    } else {
      merged.push(curr);
      curr = { start: next.start, end: next.end };
    }
  }
  merged.push(curr);
  return merged;
}

function deriveVisible(spanStart: number, spanEnd: number, hidden: readonly DimensionInterval[]): DimensionInterval[] {
  const visible: DimensionInterval[] = [];
  let curr = spanStart;
  for (let i = 0; i < hidden.length; i++) {
    const h = hidden[i];
    if (h.start > curr) visible.push({ start: curr, end: h.start });
    curr = h.end;
  }
  if (curr < spanEnd) visible.push({ start: curr, end: spanEnd });
  return visible;
}

function hasOverlap(hidden: readonly DimensionInterval[], visible: readonly DimensionInterval[], signal?: AbortSignal): boolean {
  let i = 0;
  let j = 0;
  let step = 0;
  while (i < hidden.length && j < visible.length) {
    if (signal && (++step & 127) === 0 && signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }
    const h = hidden[i];
    const v = visible[j];
    if (Math.max(h.start, v.start) < Math.min(h.end, v.end)) return true;
    if (h.end <= v.end) i++;
    else j++;
  }
  return false;
}

/**
 * Pure exclusion interval consistency helper for serializer output.
 *
 * NOTE: Requires prior verification by `assertWriterCoverage` to ensure
 * exact partition coverage over all selected scopes. This function validates
 * exclusion interval consistency, merging, and bounds across chunks; it is NOT
 * proof of 2D geometry coverage, individual cell validity, or report authorization.
 *
 * @param context Writer context containing visibility mode and sheet order
 * @param chunks Normalized chunk array containing rects and excludedIntervals
 * @param options Bounds and cancellation signal configuration
 * @returns Immutable array of SheetExclusions per sheet in context.sheetOrder
 * @throws DomainError('CONFIG_INVALID') if options or signal are invalid
 * @throws DomainError('OPERATION_ABORTED') if cancellation is requested
 * @throws DomainError('SIZE_LIMIT_EXCEEDED') if total intervals exceed maxIntervals
 * @throws DomainError('FORMAT_SERIALIZATION_FAILED') on malformed structures or exclusion conflicts
 */
export function collectWriterExclusions(
  context: WriterContext,
  chunks: readonly NormalizedChunk[],
  options: { readonly maxIntervals: number; readonly signal: AbortSignal }
): readonly SheetExclusions[] {
  let maxIntervals: number;
  let signal: AbortSignal;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');
    const rawMax = options.maxIntervals;
    const rawSig = options.signal;
    if (
      typeof rawMax !== 'number' || !Number.isSafeInteger(rawMax) || rawMax < 0 ||
      rawMax > PROVISIONAL_MAX_INTERVALS || Object.is(rawMax, -0) || !rawSig ||
      typeof rawSig !== 'object' || typeof rawSig.aborted !== 'boolean' ||
      typeof (rawSig as any).addEventListener !== 'function' || typeof (rawSig as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (rawSig.aborted) throw new DomainError('OPERATION_ABORTED');
    maxIntervals = rawMax;
    signal = rawSig;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('CONFIG_INVALID');
  }

  try {
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    if (!context || typeof context !== 'object' || Array.isArray(context) ||
        (context.visibility !== 'include_all' && context.visibility !== 'api_visible') ||
        !Array.isArray(context.sheetOrder) || !Array.isArray(chunks)) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    const sheetOrderSet = new Set<number>();
    for (let i = 0; i < context.sheetOrder.length; i++) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const id = context.sheetOrder[i];
      if (!isNonNegativeSafeInt(id) || sheetOrderSet.has(id)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      sheetOrderSet.add(id);
    }

    // Initial preflight: validate rect bounds, non-emptiness, selected sheet, and interval counts for ALL visibility modes.
    // Never silently ignore foreign or malformed chunks.
    let totalIntervals = 0;
    for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const chunk = chunks[cIdx];
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (!hasExactKeys(chunk.rect, RECT_KEYS)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      const { sheetId, r0, c0, r1, c1 } = chunk.rect;
      if (
        !isNonNegativeSafeInt(sheetId) ||
        !sheetOrderSet.has(sheetId) ||
        !isNonNegativeSafeInt(r0) ||
        !isNonNegativeSafeInt(c0) ||
        !isNonNegativeSafeInt(r1) ||
        !isNonNegativeSafeInt(c1) ||
        r1 <= r0 ||
        c1 <= c0
      ) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (
        !hasExactKeys(chunk.excludedIntervals, EXCLUDED_INTERVALS_KEYS) ||
        !Array.isArray(chunk.excludedIntervals.rows) ||
        !Array.isArray(chunk.excludedIntervals.columns)
      ) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      const rowLen = chunk.excludedIntervals.rows.length;
      const colLen = chunk.excludedIntervals.columns.length;
      if (!isNonNegativeSafeInt(rowLen) || !isNonNegativeSafeInt(colLen)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      totalIntervals += rowLen + colLen;
      if (totalIntervals > maxIntervals) {
        throw new DomainError('SIZE_LIMIT_EXCEEDED');
      }
    }

    if (context.visibility === 'include_all') {
      if (totalIntervals > 0) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      return Object.freeze(context.sheetOrder.map(sheetId => Object.freeze({
        sheetId,
        excludedRows: Object.freeze([]),
        excludedColumns: Object.freeze([])
      })));
    }

    const sheetMap = new Map<number, {
      hiddenRows: DimensionInterval[];
      visibleRows: DimensionInterval[];
      hiddenCols: DimensionInterval[];
      visibleCols: DimensionInterval[];
    }>();
    for (let i = 0; i < context.sheetOrder.length; i++) {
      sheetMap.set(context.sheetOrder[i], {
        hiddenRows: [],
        visibleRows: [],
        hiddenCols: [],
        visibleCols: []
      });
    }

    const validateIntervals = (raw: readonly DimensionInterval[], span0: number, span1: number): DimensionInterval[] => {
      const validated: DimensionInterval[] = [];
      for (let i = 0; i < raw.length; i++) {
        if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
        const iv = raw[i];
        if (
          !hasExactKeys(iv, INTERVAL_KEYS) ||
          !isNonNegativeSafeInt(iv.start) ||
          !isNonNegativeSafeInt(iv.end) ||
          iv.start >= iv.end ||
          iv.start < span0 ||
          iv.end > span1
        ) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        validated.push({ start: iv.start, end: iv.end });
      }
      return validated;
    };

    for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const chunk = chunks[cIdx];
      const { sheetId, r0, c0, r1, c1 } = chunk.rect;
      const data = sheetMap.get(sheetId)!;

      const cHiddenRows = mergeIntervals(validateIntervals(chunk.excludedIntervals.rows, r0, r1), signal);
      const cVisibleRows = deriveVisible(r0, r1, cHiddenRows);
      for (let i = 0; i < cHiddenRows.length; i++) {
        data.hiddenRows.push(cHiddenRows[i]);
      }
      for (let i = 0; i < cVisibleRows.length; i++) {
        data.visibleRows.push(cVisibleRows[i]);
      }

      const cHiddenCols = mergeIntervals(validateIntervals(chunk.excludedIntervals.columns, c0, c1), signal);
      const cVisibleCols = deriveVisible(c0, c1, cHiddenCols);
      for (let i = 0; i < cHiddenCols.length; i++) {
        data.hiddenCols.push(cHiddenCols[i]);
      }
      for (let i = 0; i < cVisibleCols.length; i++) {
        data.visibleCols.push(cVisibleCols[i]);
      }
    }

    const result: SheetExclusions[] = [];
    for (let i = 0; i < context.sheetOrder.length; i++) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const id = context.sheetOrder[i];
      const data = sheetMap.get(id)!;

      const mergedRows = mergeIntervals(data.hiddenRows, signal);
      const mergedVisibleRows = mergeIntervals(data.visibleRows, signal);
      if (hasOverlap(mergedRows, mergedVisibleRows, signal)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      const mergedCols = mergeIntervals(data.hiddenCols, signal);
      const mergedVisibleCols = mergeIntervals(data.visibleCols, signal);
      if (hasOverlap(mergedCols, mergedVisibleCols, signal)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      result.push(Object.freeze({
        sheetId: id,
        excludedRows: Object.freeze(mergedRows.map(iv => Object.freeze({ start: iv.start, end: iv.end }))),
        excludedColumns: Object.freeze(mergedCols.map(iv => Object.freeze({ start: iv.start, end: iv.end })))
      }));
    }

    return Object.freeze(result);
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
