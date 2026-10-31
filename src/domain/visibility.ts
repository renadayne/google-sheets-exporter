/**
 * T16 Explicit API Visibility without coordinate compaction.
 * Filters a freshly normalized chunk by applying Google Sheets dimension metadata visibility.
 */

import type { Cell, DimensionInterval, NormalizedChunk, VisibilityMode } from '../contracts/domain.ts';
import { DomainError } from '../contracts/errors.ts';

export interface ApplyVisibilityOptions {
  readonly sourceId: string;
  readonly visibility: VisibilityMode;
}

interface DimensionFlag {
  readonly hiddenByUser: boolean;
  readonly hiddenByFilter: boolean;
}

function copyCell(cell: Cell): Cell {
  return cell.kind === 'error' ? { ...cell, value: { ...cell.value } } : { ...cell };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function isPosInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
}

function validateChunk(chunk: unknown): asserts chunk is NormalizedChunk {
  if (!isRecord(chunk) || typeof chunk.jobId !== 'string' || !chunk.jobId ||
      typeof chunk.chunkId !== 'string' || !chunk.chunkId ||
      !isPosInt(chunk.byteCount) || !Array.isArray(chunk.cells) || !isRecord(chunk.rect)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  const { sheetId, r0, c0, r1, c1 } = chunk.rect;
  if (!isPosInt(sheetId) || !isPosInt(r0) || !isPosInt(c0) || !isPosInt(r1) || !isPosInt(c1) || r1 <= r0 || c1 <= c0) {
    throw new DomainError('RANGE_INVALID');
  }
  const exc = chunk.excludedIntervals;
  if (!isRecord(exc) || !Array.isArray(exc.rows) || !Array.isArray(exc.columns) || exc.rows.length > 0 || exc.columns.length > 0) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  for (const cell of chunk.cells) {
    if (!isRecord(cell) || !isPosInt(cell.r) || !isPosInt(cell.c) ||
        cell.r < r0 || cell.r >= r1 || cell.c < c0 || cell.c >= c1) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
  }
}

function deriveIntervals(indices: readonly number[]): DimensionInterval[] {
  const intervals: DimensionInterval[] = [];
  if (indices.length === 0) return intervals;
  let start = indices[0];
  let end = start + 1;
  for (let i = 1; i < indices.length; i++) {
    const idx = indices[i];
    if (idx === end) {
      end++;
    } else {
      intervals.push({ start, end });
      start = idx;
      end = start + 1;
    }
  }
  intervals.push({ start, end });
  return intervals;
}

export function applyVisibility(
  chunk: NormalizedChunk,
  payload: unknown,
  options: ApplyVisibilityOptions
): NormalizedChunk {
  validateChunk(chunk);
  if (!isRecord(options) || typeof options.sourceId !== 'string' || !options.sourceId ||
      (options.visibility !== 'include_all' && options.visibility !== 'api_visible')) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  if (options.visibility === 'include_all') {
    return {
      jobId: chunk.jobId,
      chunkId: chunk.chunkId,
      rect: { ...chunk.rect },
      cells: chunk.cells.map(copyCell),
      excludedIntervals: { rows: [], columns: [] },
      byteCount: chunk.byteCount
    };
  }

  if (!isRecord(payload) || payload.spreadsheetId !== options.sourceId || !Array.isArray(payload.sheets) || payload.sheets.length !== 1) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  const matchingSheets = payload.sheets.filter(
    (s: unknown) => isRecord(s) && isRecord(s.properties) && s.properties.sheetId === chunk.rect.sheetId
  );
  if (matchingSheets.length !== 1) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  const sheet = matchingSheets[0] as Record<string, unknown>;
  const props = sheet.properties as Record<string, unknown>;
  if (props.sheetType !== undefined && props.sheetType !== 'GRID') {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (props.hidden === true || (props.hidden !== undefined && typeof props.hidden !== 'boolean')) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (!Array.isArray(sheet.data)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  const rowMap = new Map<number, DimensionFlag>();
  const colMap = new Map<number, DimensionFlag>();

  for (const block of sheet.data) {
    if (!isRecord(block)) throw new DomainError('SOURCE_UNSUPPORTED');
    const { startRow, startColumn, rowMetadata, columnMetadata } = block;
    if (!isPosInt(startRow) || !isPosInt(startColumn) || !Array.isArray(rowMetadata) || !Array.isArray(columnMetadata) ||
        startRow < chunk.rect.r0 || startRow >= chunk.rect.r1 ||
        startColumn < chunk.rect.c0 || startColumn >= chunk.rect.c1) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }

    for (let rIdx = 0; rIdx < rowMetadata.length; rIdx++) {
      const r = startRow + rIdx;
      const item = rowMetadata[rIdx];
      if (r >= chunk.rect.r1 || !isRecord(item) ||
          typeof item.hiddenByUser !== 'boolean' || typeof item.hiddenByFilter !== 'boolean') {
        throw new DomainError('SOURCE_UNSUPPORTED');
      }
      const existing = rowMap.get(r);
      if (existing) {
        if (existing.hiddenByUser !== item.hiddenByUser || existing.hiddenByFilter !== item.hiddenByFilter) {
          throw new DomainError('SOURCE_UNSUPPORTED');
        }
      } else {
        rowMap.set(r, { hiddenByUser: item.hiddenByUser, hiddenByFilter: item.hiddenByFilter });
      }
    }

    for (let cIdx = 0; cIdx < columnMetadata.length; cIdx++) {
      const c = startColumn + cIdx;
      const item = columnMetadata[cIdx];
      if (c >= chunk.rect.c1 || !isRecord(item) || typeof item.hiddenByUser !== 'boolean' ||
          (item.hiddenByFilter !== undefined && typeof item.hiddenByFilter !== 'boolean')) {
        throw new DomainError('SOURCE_UNSUPPORTED');
      }
      const existing = colMap.get(c);
      const hiddenByFilter = item.hiddenByFilter === true;
      if (existing) {
        if (existing.hiddenByUser !== item.hiddenByUser || existing.hiddenByFilter !== hiddenByFilter) {
          throw new DomainError('SOURCE_UNSUPPORTED');
        }
      } else {
        colMap.set(c, { hiddenByUser: item.hiddenByUser, hiddenByFilter });
      }
    }
  }

  if (rowMap.size !== (chunk.rect.r1 - chunk.rect.r0) || colMap.size !== (chunk.rect.c1 - chunk.rect.c0)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  const hiddenRows: number[] = [];
  for (let r = chunk.rect.r0; r < chunk.rect.r1; r++) {
    const meta = rowMap.get(r)!;
    if (meta.hiddenByUser || meta.hiddenByFilter) hiddenRows.push(r);
  }

  const hiddenCols: number[] = [];
  for (let c = chunk.rect.c0; c < chunk.rect.c1; c++) {
    const meta = colMap.get(c)!;
    if (meta.hiddenByUser || meta.hiddenByFilter === true) hiddenCols.push(c);
  }

  const isRowHidden = (r: number): boolean => {
    const m = rowMap.get(r);
    if (!m) throw new DomainError('SOURCE_UNSUPPORTED');
    return m.hiddenByUser || m.hiddenByFilter;
  };
  const isColHidden = (c: number): boolean => {
    const m = colMap.get(c);
    if (!m) throw new DomainError('SOURCE_UNSUPPORTED');
    return m.hiddenByUser || m.hiddenByFilter;
  };

  const survivingCells: Cell[] = [];
  for (const cell of chunk.cells) {
    if (!isRowHidden(cell.r) && !isColHidden(cell.c)) {
      survivingCells.push(copyCell(cell));
    }
  }

  return {
    jobId: chunk.jobId,
    chunkId: chunk.chunkId,
    rect: { ...chunk.rect },
    cells: survivingCells,
    excludedIntervals: {
      rows: deriveIntervals(hiddenRows),
      columns: deriveIntervals(hiddenCols)
    },
    byteCount: chunk.byteCount
  };
}
