/**
 * T15b GridData offsets and sparse chunk assembly.
 * Normalizes a single sheet chunk from parsed Google Sheets GridData into a domain NormalizedChunk.
 */

import type { Cell, ExportMode, NormalizedChunk, Rect } from '../contracts/domain.ts';
import { DomainError } from '../contracts/errors.ts';
import { projectCell } from './cell.ts';

export interface NormalizeGridOptions {
  readonly sourceId: string;
  readonly jobId: string;
  readonly chunkId: string;
  readonly rect: Rect;
  readonly mode: ExportMode;
  readonly byteCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonNegativeSafeInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
}

function validateRect(rect: unknown): asserts rect is Rect {
  if (!isRecord(rect)) {
    throw new DomainError('RANGE_INVALID');
  }
  const { sheetId, r0, c0, r1, c1 } = rect;
  if (
    !isNonNegativeSafeInteger(sheetId) ||
    !isNonNegativeSafeInteger(r0) ||
    !isNonNegativeSafeInteger(c0) ||
    !isNonNegativeSafeInteger(r1) ||
    !isNonNegativeSafeInteger(c1) ||
    r1 <= r0 ||
    c1 <= c0
  ) {
    throw new DomainError('RANGE_INVALID');
  }
}

function validateOptions(options: unknown): asserts options is NormalizeGridOptions {
  if (!isRecord(options)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  const { sourceId, jobId, chunkId, mode, byteCount, rect } = options;
  if (
    typeof sourceId !== 'string' ||
    sourceId.length === 0 ||
    typeof jobId !== 'string' ||
    jobId.length === 0 ||
    typeof chunkId !== 'string' ||
    chunkId.length === 0
  ) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (mode !== 'raw' && mode !== 'formatted' && mode !== 'formula_text') {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (!isNonNegativeSafeInteger(byteCount)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  validateRect(rect);
}

function validatePayload(
  payload: unknown,
  expectedSpreadsheetId: string,
  expectedSheetId: number
): unknown[] {
  if (!isRecord(payload)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (typeof payload.spreadsheetId !== 'string' || payload.spreadsheetId !== expectedSpreadsheetId) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (!Array.isArray(payload.sheets) || payload.sheets.length !== 1) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  const sheet = payload.sheets[0];
  if (!isRecord(sheet)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (!('properties' in sheet) || !isRecord(sheet.properties)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (sheet.properties.sheetId !== expectedSheetId) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (
    'sheetType' in sheet.properties &&
    sheet.properties.sheetType !== undefined &&
    sheet.properties.sheetType !== 'GRID'
  ) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (!('data' in sheet) || !Array.isArray(sheet.data)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  return sheet.data;
}

export function normalizeGrid(payload: unknown, options: NormalizeGridOptions): NormalizedChunk {
  validateOptions(options);
  const data = validatePayload(payload, options.sourceId, options.rect.sheetId);

  const seenPositions = new Set<string>();
  const cells: Cell[] = [];

  for (const block of data) {
    if (!isRecord(block)) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    if (
      !('startRow' in block) ||
      !isNonNegativeSafeInteger(block.startRow) ||
      !('startColumn' in block) ||
      !isNonNegativeSafeInteger(block.startColumn)
    ) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }

    const { startRow, startColumn } = block;

    if (
      startRow < options.rect.r0 ||
      startRow >= options.rect.r1 ||
      startColumn < options.rect.c0 ||
      startColumn >= options.rect.c1
    ) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }

    if (!('rowData' in block) || block.rowData === undefined) {
      continue;
    }
    if (!Array.isArray(block.rowData)) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }

    for (let rIdx = 0; rIdx < block.rowData.length; rIdx++) {
      const r = startRow + rIdx;
      if (r < options.rect.r0 || r >= options.rect.r1) {
        throw new DomainError('SOURCE_UNSUPPORTED');
      }

      const row = block.rowData[rIdx];
      if (!isRecord(row)) {
        throw new DomainError('SOURCE_UNSUPPORTED');
      }

      if (!('values' in row) || row.values === undefined) {
        continue;
      }
      if (!Array.isArray(row.values)) {
        throw new DomainError('SOURCE_UNSUPPORTED');
      }

      for (let cIdx = 0; cIdx < row.values.length; cIdx++) {
        const c = startColumn + cIdx;
        if (c < options.rect.c0 || c >= options.rect.c1) {
          throw new DomainError('SOURCE_UNSUPPORTED');
        }

        const posKey = `${r}:${c}`;
        if (seenPositions.has(posKey)) {
          throw new DomainError('SOURCE_UNSUPPORTED');
        }
        seenPositions.add(posKey);

        const cellValue = row.values[cIdx];
        const cell = projectCell(cellValue, r, c, options.mode);
        if (cell !== null) {
          cells.push(cell);
        }
      }
    }
  }

  cells.sort((a, b) => {
    if (a.r !== b.r) return a.r - b.r;
    return a.c - b.c;
  });

  return {
    jobId: options.jobId,
    chunkId: options.chunkId,
    rect: {
      sheetId: options.rect.sheetId,
      r0: options.rect.r0,
      c0: options.rect.c0,
      r1: options.rect.r1,
      c1: options.rect.c1
    },
    cells,
    excludedIntervals: {
      rows: [],
      columns: []
    },
    byteCount: options.byteCount
  };
}
