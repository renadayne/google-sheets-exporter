/**
 * T24b1a Shared Writer Context and Geometry Validation
 * Prerequisite of T24 JSON Writer.
 *
 * Validates sanitized WriterContext and proves exact 2D partition coverage
 * over all selected scopes using BigInt area arithmetic and pairwise disjointness.
 * Cell and exclusion validation is explicitly deferred.
 */

import type { NormalizedChunk, ExportScope } from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';

/** Provisional resource guard bounding pairwise comparison complexity, not a benchmark claim. */
export const PROVISIONAL_MAX_CHUNKS = 4096;

const CONTEXT_KEYS = [
  'sourceId',
  'title',
  'locale',
  'timeZone',
  'scopes',
  'mode',
  'format',
  'visibility',
  'limitsVersion',
  'sheetOrder',
  'sheets'
] as const;

const SHEET_META_KEYS = ['id', 'title', 'index', 'type', 'hidden', 'rows', 'columns'] as const;
const SCOPE_KEYS = ['sheetId', 'rect'] as const;
const RECT_KEYS = ['sheetId', 'r0', 'c0', 'r1', 'c1'] as const;
const CHUNK_KEYS = ['jobId', 'chunkId', 'rect', 'cells', 'excludedIntervals', 'byteCount'] as const;

function isNonNegativeSafeInt(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && !Object.is(val, -0);
}

function isPositiveSafeInt(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val > 0 && !Object.is(val, -0);
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.length > 0;
}

function hasExactKeys(obj: unknown, expectedKeys: readonly string[]): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (Object.getOwnPropertySymbols(obj).length > 0) return false;
  const keys = Object.keys(obj);
  if (keys.length !== expectedKeys.length) return false;
  for (const k of keys) {
    if (!expectedKeys.includes(k)) return false;
  }
  return expectedKeys.every(k => Object.prototype.hasOwnProperty.call(obj, k));
}

export function assertWriterCoverage(
  context: WriterContext,
  chunks: readonly NormalizedChunk[],
  options: { readonly maxChunks: number; readonly signal: AbortSignal }
): void {
  let maxChunks: number;
  let signal: AbortSignal;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new DomainError('CONFIG_INVALID');
    }
    const rawMaxChunks = options.maxChunks;
    const rawSignal = options.signal;
    if (
      typeof rawMaxChunks !== 'number' ||
      !Number.isSafeInteger(rawMaxChunks) ||
      rawMaxChunks <= 0 ||
      rawMaxChunks > PROVISIONAL_MAX_CHUNKS ||
      Object.is(rawMaxChunks, -0) ||
      !rawSignal ||
      typeof rawSignal !== 'object' ||
      typeof rawSignal.aborted !== 'boolean' ||
      typeof (rawSignal as any).addEventListener !== 'function' ||
      typeof (rawSignal as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (rawSignal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }
    maxChunks = rawMaxChunks;
    signal = rawSignal;
  } catch (err) {
    if (err instanceof DomainError) {
      throw toSafeDomainError(err);
    }
    throw new DomainError('CONFIG_INVALID');
  }

  try {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    if (chunks.length > maxChunks) {
      throw new DomainError('SIZE_LIMIT_EXCEEDED');
    }

    if (!hasExactKeys(context, CONTEXT_KEYS)) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    if (
      !isNonEmptyString(context.sourceId) ||
      typeof context.title !== 'string' ||
      !isNonEmptyString(context.locale) ||
      !isNonEmptyString(context.timeZone) ||
      !isNonEmptyString(context.limitsVersion)
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    if (
      (context.mode !== 'formatted' && context.mode !== 'raw' && context.mode !== 'formula_text') ||
      (context.format !== 'xlsx' && context.format !== 'csv' && context.format !== 'json') ||
      (context.visibility !== 'include_all' && context.visibility !== 'api_visible')
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (!Array.isArray(context.scopes) || !Array.isArray(context.sheetOrder) || !Array.isArray(context.sheets)) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    const sheetCount = context.scopes.length;
    if (sheetCount === 0 || context.sheetOrder.length !== sheetCount || context.sheets.length !== sheetCount) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    const seenSheetIds = new Set<number>();
    const seenIndices = new Set<number>();
    const scopeMap = new Map<number, ExportScope>();

    for (let i = 0; i < sheetCount; i++) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const sheetId = context.sheetOrder[i];
      const scope = context.scopes[i];
      const meta = context.sheets[i];

      if (!isNonNegativeSafeInt(sheetId) || seenSheetIds.has(sheetId)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      seenSheetIds.add(sheetId);

      if (!scope || scope.sheetId !== sheetId || !meta || meta.id !== sheetId) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      if (!hasExactKeys(meta, SHEET_META_KEYS) || typeof meta.title !== 'string' || !isNonNegativeSafeInt(meta.index)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if ((i > 0 && meta.index <= context.sheets[i - 1].index) || seenIndices.has(meta.index)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      seenIndices.add(meta.index);

      if (meta.type !== 'GRID' || typeof meta.hidden !== 'boolean') {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (meta.hidden && context.visibility === 'api_visible') {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (!isPositiveSafeInt(meta.rows) || !isPositiveSafeInt(meta.columns)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      if (!hasExactKeys(scope, SCOPE_KEYS) || !hasExactKeys(scope.rect, RECT_KEYS) || scope.rect.sheetId !== sheetId) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      const { r0, c0, r1, c1 } = scope.rect;
      if (!isNonNegativeSafeInt(r0) || !isNonNegativeSafeInt(c0) || !isNonNegativeSafeInt(r1) || !isNonNegativeSafeInt(c1)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (r0 >= r1 || c0 >= c1 || r1 > meta.rows || c1 > meta.columns) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      scopeMap.set(sheetId, scope);
    }

    const firstChunk = chunks[0];
    if (!firstChunk || typeof firstChunk !== 'object') {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    const expectedJobId = firstChunk.jobId;
    if (!isNonEmptyString(expectedJobId)) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    const seenChunkIds = new Set<string>();
    const chunksBySheet = new Map<number, NormalizedChunk[]>();
    for (const sheetId of context.sheetOrder) {
      chunksBySheet.set(sheetId, []);
    }

    for (const chunk of chunks) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      if (!hasExactKeys(chunk, CHUNK_KEYS) || chunk.jobId !== expectedJobId) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (!isNonEmptyString(chunk.chunkId) || seenChunkIds.has(chunk.chunkId)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      seenChunkIds.add(chunk.chunkId);

      if (!isNonNegativeSafeInt(chunk.byteCount) || !Array.isArray(chunk.cells)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (!chunk.excludedIntervals || typeof chunk.excludedIntervals !== 'object' || Array.isArray(chunk.excludedIntervals)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      if (!hasExactKeys(chunk.rect, RECT_KEYS)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      const { sheetId, r0, c0, r1, c1 } = chunk.rect;
      if (!isNonNegativeSafeInt(sheetId) || !isNonNegativeSafeInt(r0) || !isNonNegativeSafeInt(c0) || !isNonNegativeSafeInt(r1) || !isNonNegativeSafeInt(c1)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (r0 >= r1 || c0 >= c1) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      const scope = scopeMap.get(sheetId);
      if (!scope || r0 < scope.rect.r0 || r1 > scope.rect.r1 || c0 < scope.rect.c0 || c1 > scope.rect.c1) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      chunksBySheet.get(sheetId)!.push(chunk);
    }

    let comparisonCount = 0;
    for (const sheetId of context.sheetOrder) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const sheetChunks = chunksBySheet.get(sheetId)!;
      if (sheetChunks.length === 0) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      const scopeRect = scopeMap.get(sheetId)!.rect;
      const scopeArea = BigInt(scopeRect.r1 - scopeRect.r0) * BigInt(scopeRect.c1 - scopeRect.c0);
      let areaSum = 0n;
      const count = sheetChunks.length;

      for (let i = 0; i < count; i++) {
        if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
        const a = sheetChunks[i].rect;
        areaSum += BigInt(a.r1 - a.r0) * BigInt(a.c1 - a.c0);

        for (let j = i + 1; j < count; j++) {
          comparisonCount++;
          if ((comparisonCount & 127) === 0 && signal.aborted) {
            throw new DomainError('OPERATION_ABORTED');
          }
          const b = sheetChunks[j].rect;
          if (Math.max(a.r0, b.r0) < Math.min(a.r1, b.r1) && Math.max(a.c0, b.c0) < Math.min(a.c1, b.c1)) {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
        }
      }

      if (areaSum !== scopeArea) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
    }
  } catch (err) {
    if (err instanceof DomainError) {
      throw toSafeDomainError(err);
    }
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
