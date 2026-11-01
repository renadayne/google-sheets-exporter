/**
 * T24c1a Reusable WriterContext Snapshot and Validation
 * Prerequisite of T24 JSON Writer lifecycle (WriterPort.begin).
 * Validates sanitized WriterContext metadata and returns deep-frozen,
 * known-field-only copies without fabricating blank chunks.
 * Carries NO coverage proof or publication authority.
 */

import type { Rect, ExportScope, SheetMeta } from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';

export const PROVISIONAL_MAX_SHEETS = 4096;

const CONTEXT_KEYS = ['sourceId', 'title', 'locale', 'timeZone', 'scopes', 'mode', 'format', 'visibility', 'limitsVersion', 'sheetOrder', 'sheets'] as const;
const SHEET_META_KEYS = ['id', 'title', 'index', 'type', 'hidden', 'rows', 'columns'] as const;
const SCOPE_KEYS = ['sheetId', 'rect'] as const;
const RECT_KEYS = ['sheetId', 'r0', 'c0', 'r1', 'c1'] as const;

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
  for (let i = 0; i < keys.length; i++) {
    if (!expectedKeys.includes(keys[i])) return false;
  }
  return expectedKeys.every(k => Object.prototype.hasOwnProperty.call(obj, k));
}

export function snapshotWriterContext(
  context: WriterContext,
  options: { readonly maxSheets: number; readonly signal: AbortSignal }
): WriterContext {
  let maxSheets: number;
  let signal: AbortSignal;
  let aborted = false;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');
    const rawMaxSheets = options.maxSheets;
    const rawSignal = options.signal;
    if (
      typeof rawMaxSheets !== 'number' || !Number.isSafeInteger(rawMaxSheets) ||
      rawMaxSheets <= 0 || rawMaxSheets > PROVISIONAL_MAX_SHEETS || Object.is(rawMaxSheets, -0) ||
      !rawSignal || typeof rawSignal !== 'object' || typeof (rawSignal as any).aborted !== 'boolean' ||
      typeof (rawSignal as any).addEventListener !== 'function' ||
      typeof (rawSignal as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    aborted = rawSignal.aborted;
    maxSheets = rawMaxSheets;
    signal = rawSignal;
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }
  if (aborted) throw new DomainError('OPERATION_ABORTED');

  try {
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    if (!hasExactKeys(context, CONTEXT_KEYS)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

    const scopes = context.scopes;
    if (!Array.isArray(scopes)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    const sheetCount = scopes.length;
    if (sheetCount === 0) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    if (sheetCount > maxSheets) throw new DomainError('SIZE_LIMIT_EXCEEDED');

    const sourceId = context.sourceId, title = context.title, locale = context.locale;
    const timeZone = context.timeZone, limitsVersion = context.limitsVersion;
    const mode = context.mode, format = context.format, visibility = context.visibility;
    const sheetOrder = context.sheetOrder, sheets = context.sheets;

    if (
      !isNonEmptyString(sourceId) || typeof title !== 'string' ||
      !isNonEmptyString(locale) || !isNonEmptyString(timeZone) || !isNonEmptyString(limitsVersion) ||
      (mode !== 'formatted' && mode !== 'raw' && mode !== 'formula_text') ||
      (format !== 'xlsx' && format !== 'csv' && format !== 'json') ||
      (visibility !== 'include_all' && visibility !== 'api_visible')
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (!Array.isArray(sheetOrder) || !Array.isArray(sheets)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    if (sheetOrder.length !== sheetCount || sheets.length !== sheetCount) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

    const seenSheetIds = new Set<number>();
    const seenIndices = new Set<number>();
    const copiedSheetOrder: number[] = [];
    const copiedScopes: ExportScope[] = [];
    const copiedSheets: SheetMeta[] = [];

    for (let i = 0; i < sheetCount; i++) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const sheetId = sheetOrder[i];
      const scope = scopes[i];
      const meta = sheets[i];

      if (!isNonNegativeSafeInt(sheetId) || seenSheetIds.has(sheetId)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      seenSheetIds.add(sheetId);
      if (!hasExactKeys(scope, SCOPE_KEYS) || !hasExactKeys(meta, SHEET_META_KEYS)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      const { id, title: sheetTitle, index, type, hidden, rows, columns } = meta;
      const scopeId = scope.sheetId, rect = scope.rect;
      if (id !== sheetId || scopeId !== sheetId || typeof sheetTitle !== 'string' || !isNonNegativeSafeInt(index)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if ((i > 0 && index <= copiedSheets[i - 1].index) || seenIndices.has(index)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      seenIndices.add(index);

      if (type !== 'GRID' || typeof hidden !== 'boolean') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      if (hidden && visibility === 'api_visible') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      if (!isPositiveSafeInt(rows) || !isPositiveSafeInt(columns)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

      if (!hasExactKeys(rect, RECT_KEYS)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      const { sheetId: rectId, r0, c0, r1, c1 } = rect;
      if (rectId !== sheetId) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      if (!isNonNegativeSafeInt(r0) || !isNonNegativeSafeInt(c0) || !isNonNegativeSafeInt(r1) || !isNonNegativeSafeInt(c1)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (r0 >= r1 || c0 >= c1 || r1 > rows || c1 > columns) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

      copiedSheetOrder.push(sheetId);
      const copiedRect: Rect = Object.freeze({ sheetId, r0, c0, r1, c1 });
      copiedScopes.push(Object.freeze({ sheetId, rect: copiedRect }));
      copiedSheets.push(Object.freeze({
        id: sheetId, title: sheetTitle, index, type: 'GRID', hidden, rows, columns
      }));
    }

    return Object.freeze({
      sourceId, title, locale, timeZone,
      scopes: Object.freeze(copiedScopes),
      mode, format, visibility, limitsVersion,
      sheetOrder: Object.freeze(copiedSheetOrder),
      sheets: Object.freeze(copiedSheets)
    });
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
