/**
 * T12 Pure A1 Notation Parser and Canonical Bounds Resolution
 *
 * Implements strict A1 parsing and resolves ranges into zero-based half-open
 * rectangular coordinates: [r0, r1) x [c0, c1).
 *
 * Invariants:
 * - Pure function: no side effects, no mutations of inputs, no network or I/O.
 * - Bare source strings or tokens are NEVER reflected in thrown DomainError objects.
 * - Uses exact catalog error codes:
 *     - RANGE_INVALID for syntax errors, malformed input, sheet mismatch, cross-sheet ranges.
 *     - RANGE_OUT_OF_BOUNDS for syntactically valid ranges extending beyond sheet dimensions.
 *     - SOURCE_UNSUPPORTED for non-GRID or invalid/missing/zero sheet dimensions.
 * - Does not enforce XLSX format caps (1048576 rows, 16384 cols); relies strictly
 *   on the known allocated sheet dimensions and safe integer bounds.
 */

import type { Rect, SheetMeta } from '../contracts/domain.ts';
import { DomainError } from '../contracts/errors.ts';

/**
 * Regex for cell endpoint: optional $, column letters, optional $, 1-based row digits.
 * Row digits must not have leading zeroes (/^[1-9]\d*$/).
 */
const CELL_REGEX = /^(\$?)([A-Za-z]+)(\$?)([1-9]\d*)$/;

/**
 * Regex for whole-column endpoint: optional $, column letters.
 */
const COL_REGEX = /^(\$?)([A-Za-z]+)$/;

/**
 * Regex for whole-row endpoint: optional $, 1-based row digits without leading zeroes.
 */
const ROW_REGEX = /^(\$?)([1-9]\d*)$/;

/**
 * Regex for unquoted simple sheet title prefix:
 * Starts with Unicode letter or underscore, followed by letters, digits, or underscores.
 * This parser requires quoted syntax for titles outside this supported subset.
 */
const UNQUOTED_SHEET_REGEX = /^[\p{L}_][\p{L}\p{N}_]*$/u;

interface CellEndpoint {
  readonly kind: 'CELL';
  readonly col: number;
  readonly row: number;
}

interface ColEndpoint {
  readonly kind: 'COL';
  readonly col: number;
}

interface RowEndpoint {
  readonly kind: 'ROW';
  readonly row: number;
}

type Endpoint = CellEndpoint | ColEndpoint | RowEndpoint;

/**
 * Validates sheet metadata invariants.
 * Throws SOURCE_UNSUPPORTED if sheet is non-GRID, missing, or has invalid/zero dimensions.
 */
function validateGridSheet(sheet: SheetMeta): void {
  if (
    !sheet ||
    typeof sheet !== 'object' ||
    typeof sheet.id !== 'number' ||
    !Number.isSafeInteger(sheet.id) ||
    sheet.id < 0 ||
    typeof sheet.title !== 'string' ||
    sheet.type !== 'GRID' ||
    typeof sheet.rows !== 'number' ||
    !Number.isSafeInteger(sheet.rows) ||
    sheet.rows <= 0 ||
    typeof sheet.columns !== 'number' ||
    !Number.isSafeInteger(sheet.columns) ||
    sheet.columns <= 0
  ) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
}

/**
 * Parses column letters (case-insensitive) into a 0-based column index.
 * Throws RANGE_INVALID on overflow, excessive length, or unsafe integer values.
 */
function parseColumn(colStr: string): number {
  if (colStr.length === 0) {
    throw new DomainError('RANGE_INVALID');
  }

  const upper = colStr.toUpperCase();
  let value = 0;

  for (let i = 0; i < upper.length; i++) {
    const code = upper.charCodeAt(i);
    if (code < 65 || code > 90) {
      throw new DomainError('RANGE_INVALID');
    }
    const digit = code - 64; // 'A' -> 1, ..., 'Z' -> 26
    value = value * 26 + digit;

    if (!Number.isSafeInteger(value)) {
      throw new DomainError('RANGE_INVALID');
    }
  }

  const colIndex = value - 1;
  if (!Number.isSafeInteger(colIndex) || colIndex < 0) {
    throw new DomainError('RANGE_INVALID');
  }

  return colIndex;
}

/**
 * Parses 1-based decimal row string into a 0-based row index.
 * Throws RANGE_INVALID on overflow or unsafe integer values.
 */
function parseRow(rowStr: string): number {
  if (rowStr.length === 0 || rowStr.length > 16) {
    throw new DomainError('RANGE_INVALID');
  }

  const big = BigInt(rowStr);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big <= 0n) {
    throw new DomainError('RANGE_INVALID');
  }

  const num = Number(rowStr);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new DomainError('RANGE_INVALID');
  }

  return num - 1;
}

/**
 * Parses a single endpoint token (cell, column, or row).
 */
function parseEndpoint(str: string): Endpoint {
  if (/\s/u.test(str)) {
    throw new DomainError('RANGE_INVALID');
  }
  const cellMatch = CELL_REGEX.exec(str);
  if (cellMatch) {
    const col = parseColumn(cellMatch[2]);
    const row = parseRow(cellMatch[4]);
    return { kind: 'CELL', col, row };
  }

  const colMatch = COL_REGEX.exec(str);
  if (colMatch) {
    const col = parseColumn(colMatch[2]);
    return { kind: 'COL', col };
  }

  const rowMatch = ROW_REGEX.exec(str);
  if (rowMatch) {
    const row = parseRow(rowMatch[2]);
    return { kind: 'ROW', row };
  }

  throw new DomainError('RANGE_INVALID');
}

/**
 * Extracts and validates optional sheet title prefix from input.
 * Returns the range portion after the prefix (if any).
 */
function extractRangePart(input: string, expectedTitle: string): string {
  if (input.startsWith("'")) {
    let i = 1;
    let extractedTitle = '';
    let closed = false;

    while (i < input.length) {
      if (input[i] === "'") {
        if (i + 1 < input.length && input[i + 1] === "'") {
          extractedTitle += "'";
          i += 2;
        } else {
          closed = true;
          i += 1;
          break;
        }
      } else {
        extractedTitle += input[i];
        i += 1;
      }
    }

    if (!closed) {
      // Unterminated quote
      throw new DomainError('RANGE_INVALID');
    }

    // Must be immediately followed by '!'
    if (i >= input.length || input[i] !== '!') {
      throw new DomainError('RANGE_INVALID');
    }

    if (extractedTitle.length === 0) {
      throw new DomainError('RANGE_INVALID');
    }

    if (extractedTitle !== expectedTitle) {
      throw new DomainError('RANGE_INVALID');
    }

    const rangePart = input.slice(i + 1);
    if (rangePart.length === 0) {
      throw new DomainError('RANGE_INVALID');
    }

    return rangePart;
  }

  const firstExcl = input.indexOf('!');
  if (firstExcl !== -1) {
    // Unquoted sheet prefix must have exactly one '!' delimiter
    if (input.indexOf('!', firstExcl + 1) !== -1) {
      throw new DomainError('RANGE_INVALID');
    }

    const unquotedTitle = input.slice(0, firstExcl);
    const rangePart = input.slice(firstExcl + 1);

    if (unquotedTitle.length === 0 || rangePart.length === 0) {
      throw new DomainError('RANGE_INVALID');
    }

    if (!UNQUOTED_SHEET_REGEX.test(unquotedTitle)) {
      throw new DomainError('RANGE_INVALID');
    }

    if (unquotedTitle !== expectedTitle) {
      throw new DomainError('RANGE_INVALID');
    }

    return rangePart;
  }

  if (input.length === 0) {
    throw new DomainError('RANGE_INVALID');
  }

  return input;
}

/**
 * Parses an A1 notation string and resolves it into canonical zero-based half-open
 * rectangular coordinates bounded by the provided SheetMeta.
 *
 * @param input Raw A1 range string, e.g. "A1", "C5:D6", "B:D", "5:6", "'Sheet1'!A1".
 * @param sheet Known selected GRID SheetMeta providing allocated bounds.
 * @returns Rect with zero-based half-open intervals [r0, r1) x [c0, c1).
 */
export function parseA1(input: string, sheet: SheetMeta): Rect {
  if (typeof input !== 'string' || input.length === 0 || input.trim().length === 0) {
    throw new DomainError('RANGE_INVALID');
  }

  validateGridSheet(sheet);

  const rangePart = extractRangePart(input, sheet.title);

  // Range expression itself cannot contain quotes, exclamation marks, or union separators
  if (
    rangePart.includes("'") ||
    rangePart.includes('!') ||
    rangePart.includes(',') ||
    rangePart.includes(';')
  ) {
    throw new DomainError('RANGE_INVALID');
  }

  const colonCount = (rangePart.match(/:/g) || []).length;
  if (colonCount > 1) {
    throw new DomainError('RANGE_INVALID');
  }

  if (colonCount === 0) {
    const ep = parseEndpoint(rangePart);
    if (ep.kind !== 'CELL') {
      // Single bare column/row tokens are ambiguous named ranges and rejected
      throw new DomainError('RANGE_INVALID');
    }

    if (ep.row >= sheet.rows! || ep.col >= sheet.columns!) {
      throw new DomainError('RANGE_OUT_OF_BOUNDS');
    }

    return {
      sheetId: sheet.id,
      r0: ep.row,
      c0: ep.col,
      r1: ep.row + 1,
      c1: ep.col + 1
    };
  }

  const [startStr, endStr] = rangePart.split(':');
  if (!startStr || !endStr) {
    throw new DomainError('RANGE_INVALID');
  }

  const startEp = parseEndpoint(startStr);
  const endEp = parseEndpoint(endStr);

  if (startEp.kind !== endEp.kind) {
    // Mixed endpoint kinds (e.g. A1:B, A:B2, 1:A2, A1:2)
    throw new DomainError('RANGE_INVALID');
  }

  if (startEp.kind === 'CELL' && endEp.kind === 'CELL') {
    if (startEp.row > endEp.row || startEp.col > endEp.col) {
      // Reverse endpoints (e.g. D5:C4, D5:C5, C6:C5)
      throw new DomainError('RANGE_INVALID');
    }

    if (endEp.row >= sheet.rows! || endEp.col >= sheet.columns!) {
      throw new DomainError('RANGE_OUT_OF_BOUNDS');
    }

    return {
      sheetId: sheet.id,
      r0: startEp.row,
      c0: startEp.col,
      r1: endEp.row + 1,
      c1: endEp.col + 1
    };
  }

  if (startEp.kind === 'COL' && endEp.kind === 'COL') {
    if (startEp.col > endEp.col) {
      // Reverse column endpoints (e.g. D:B)
      throw new DomainError('RANGE_INVALID');
    }

    if (endEp.col >= sheet.columns!) {
      throw new DomainError('RANGE_OUT_OF_BOUNDS');
    }

    return {
      sheetId: sheet.id,
      r0: 0,
      c0: startEp.col,
      r1: sheet.rows!,
      c1: endEp.col + 1
    };
  }

  if (startEp.kind === 'ROW' && endEp.kind === 'ROW') {
    if (startEp.row > endEp.row) {
      // Reverse row endpoints (e.g. 6:5)
      throw new DomainError('RANGE_INVALID');
    }

    if (endEp.row >= sheet.rows!) {
      throw new DomainError('RANGE_OUT_OF_BOUNDS');
    }

    return {
      sheetId: sheet.id,
      r0: startEp.row,
      c0: 0,
      r1: endEp.row + 1,
      c1: sheet.columns!
    };
  }

  throw new DomainError('RANGE_INVALID');
}
