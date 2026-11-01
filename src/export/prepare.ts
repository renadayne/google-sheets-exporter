import type { Cell, DimensionInterval, ExcludedIntervals, NormalizedChunk, Rect, SheetMeta } from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { assertWriterCoverage, PROVISIONAL_MAX_CHUNKS } from './coverage.ts';
import { collectWriterExclusions, PROVISIONAL_MAX_INTERVALS } from './exclusions.ts';
import { collectWriterCells, PROVISIONAL_MAX_CELLS } from './cells.ts';

export interface PreparedSheet {
  readonly metadata: SheetMeta;
  readonly scope: Rect;
  readonly cells: readonly Cell[];
  readonly excludedIntervals: ExcludedIntervals;
}

export interface PrepareWriterOptions {
  readonly maxChunks: number;
  readonly maxIntervals: number;
  readonly maxCells: number;
  readonly signal: AbortSignal;
}

function isSafe(val: unknown, max: number): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && val <= max && !Object.is(val, -0);
}

function isExcluded(intervals: readonly DimensionInterval[], val: number): boolean {
  let low = 0, high = intervals.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const iv = intervals[mid];
    if (val < iv.start) high = mid - 1;
    else if (val >= iv.end) low = mid + 1;
    else return true;
  }
  return false;
}

export function prepareWriterData(
  context: WriterContext,
  chunks: readonly NormalizedChunk[],
  options: PrepareWriterOptions
): readonly PreparedSheet[] {
  let maxChunks: number, maxIntervals: number, maxCells: number, signal: AbortSignal;
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');
    const { maxChunks: c, maxIntervals: i, maxCells: m, signal: s } = options;
    if (
      !isSafe(c, PROVISIONAL_MAX_CHUNKS) || !isSafe(i, PROVISIONAL_MAX_INTERVALS) || !isSafe(m, PROVISIONAL_MAX_CELLS) ||
      !s || typeof s !== 'object' || typeof s.aborted !== 'boolean' ||
      typeof (s as any).addEventListener !== 'function' || typeof (s as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (s.aborted) throw new DomainError('OPERATION_ABORTED');
    maxChunks = c; maxIntervals = i; maxCells = m; signal = s;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('CONFIG_INVALID');
  }

  try {
    assertWriterCoverage(context, chunks, { maxChunks, signal });
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

    const exclusions = collectWriterExclusions(context, chunks, { maxIntervals, signal });
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

    const cellSheets = collectWriterCells(context, chunks, { maxCells, signal });
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

    const preparedSheets: PreparedSheet[] = [];
    for (let i = 0; i < context.sheets.length; i++) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const meta = context.sheets[i];
      const scopeRect = context.scopes[i].rect;
      const sheetCells = cellSheets[i].cells;
      const excludedRows = exclusions[i].excludedRows;
      const excludedCols = exclusions[i].excludedColumns;

      for (let c = 0; c < sheetCells.length; c++) {
        if ((c & 127) === 0 && signal.aborted) throw new DomainError('OPERATION_ABORTED');
        const cell = sheetCells[c];
        if (isExcluded(excludedRows, cell.r) || isExcluded(excludedCols, cell.c)) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
      }

      const metaObj: { id: number; title: string; index: number; type: string; hidden: boolean; rows?: number; columns?: number } = {
        id: meta.id, title: meta.title, index: meta.index, type: meta.type, hidden: meta.hidden
      };
      if (typeof meta.rows === 'number') metaObj.rows = meta.rows;
      if (typeof meta.columns === 'number') metaObj.columns = meta.columns;
      const metadata: SheetMeta = Object.freeze(metaObj);
      const scope: Rect = Object.freeze({
        sheetId: scopeRect.sheetId, r0: scopeRect.r0, c0: scopeRect.c0, r1: scopeRect.r1, c1: scopeRect.c1
      });
      const excludedIntervals: ExcludedIntervals = Object.freeze({ rows: excludedRows, columns: excludedCols });

      preparedSheets.push(Object.freeze({ metadata, scope, cells: sheetCells, excludedIntervals }));
    }

    return Object.freeze(preparedSheets);
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
