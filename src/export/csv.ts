/**
 * T26 Safe Single-Rectangle CSV Row Encoder
 *
 * Encodes a single rectangular grid region into RFC 4180-compliant CSV with:
 * - UTF-8 BOM
 * - Comma delimiter
 * - CRLF line endings (\r\n) on all rows including the last row
 * - Quote-all fields with doubled embedded quotes
 * - Spreadsheet formula injection defense (apostrophe_prefix_v1)
 * - Safe preflight minimum byte checking and chunked memory buffering
 *
 * Manual spreadsheet importer compatibility (Excel / LibreOffice) remains pending.
 */

import type { Cell, Rect } from '../contracts/domain.ts';
import { DomainError } from '../contracts/errors.ts';

export interface EncodeCsvOptions {
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

export interface EncodeCsvResult {
  readonly bytes: Uint8Array;
  readonly transformedCells: number;
  readonly policy: 'apostrophe_prefix_v1';
}

export const PROVISIONAL_MAX_CSV_BYTES = 64 * 1024 * 1024; // 64 MiB
const MAX_CACHED_EMPTY_ROW_BYTES = 64 * 1024; // 64 KiB
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const COMMA_BYTES = new Uint8Array([0x2c]);
const CRLF_BYTES = new Uint8Array([0x0d, 0x0a]);
const EMPTY_QUOTES = new Uint8Array([0x22, 0x22]);

/**
 * Regex for apostrophe_prefix_v1 detection:
 * Matches if first character is =, +, -, @, \t, \r, \n, OR leading
 * Unicode White_Space, Cc, or Cf characters lead to =, +, -, @.
 */
const DANGEROUS_PREFIX_REGEX = /^[\p{White_Space}\p{Cc}\p{Cf}]*[=+\-@]|^[\t\r\n]/u;

function isNonNegativeSafeInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
}

function hasUnpairedSurrogates(s: string): boolean {
  const candidate = s as unknown as { isWellFormed?: () => boolean };
  if (typeof candidate.isWellFormed === 'function') {
    return !candidate.isWellFormed();
  }
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

function isValidAbortSignal(signal: unknown): signal is AbortSignal {
  return (
    typeof signal === 'object' &&
    signal !== null &&
    typeof (signal as AbortSignal).aborted === 'boolean' &&
    typeof (signal as AbortSignal).addEventListener === 'function'
  );
}

class ByteAccumulator {
  private readonly chunks: Uint8Array[] = [];
  private current: Uint8Array;
  private offset = 0;
  private total = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number, chunkSize = 65536) {
    this.maxBytes = maxBytes;
    this.current = new Uint8Array(chunkSize);
  }

  get totalBytes(): number {
    return this.total;
  }

  get remainingBytes(): number {
    return this.maxBytes - this.total;
  }

  append(src: Uint8Array): void {
    if (this.total + src.length > this.maxBytes) {
      throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }
    let srcOffset = 0;
    while (srcOffset < src.length) {
      if (this.offset === this.current.length) {
        this.chunks.push(this.current);
        this.current = new Uint8Array(this.current.length);
        this.offset = 0;
      }
      const toCopy = Math.min(src.length - srcOffset, this.current.length - this.offset);
      this.current.set(src.subarray(srcOffset, srcOffset + toCopy), this.offset);
      this.offset += toCopy;
      srcOffset += toCopy;
      this.total += toCopy;
    }
  }

  build(): Uint8Array {
    const result = new Uint8Array(this.total);
    let outOffset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, outOffset);
      outOffset += chunk.length;
    }
    if (this.offset > 0) {
      result.set(this.current.subarray(0, this.offset), outOffset);
    }
    return result;
  }
}

function buildEmptyRow(cols: number, encoder: TextEncoder): Uint8Array {
  return encoder.encode('""' + ',""'.repeat(cols - 1) + '\r\n');
}

function countEscapedCodeUnits(s: string, currentBytes: number, maxBudget: number): number {
  let bytes = currentBytes;
  if (bytes > maxBudget) {
    throw new DomainError('BYTE_LIMIT_EXCEEDED');
  }
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += code === 0x22 ? 2 : 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < len) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++;
          bytes += 4;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maxBudget) {
      throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }
  }
  return bytes;
}

function preflightCellBytes(cell: Cell, maxBudget: number): boolean {
  if (cell.kind === 'string') {
    const raw = cell.value;
    const transformed = raw.length > 0 && DANGEROUS_PREFIX_REGEX.test(raw);
    countEscapedCodeUnits(raw, 2 + (transformed ? 1 : 0), maxBudget);
    return transformed;
  }
  if (cell.kind === 'number') {
    if (2 + String(cell.value).length > maxBudget) {
      throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }
    return false;
  }
  if (cell.kind === 'boolean') {
    if ((cell.value ? 6 : 7) > maxBudget) {
      throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }
    return false;
  }
  // cell.kind === 'error': `#ERROR[${code}]: ${message}` -> framing 2 + '#ERROR[' (7) + ']: ' (3) = 12
  let bytes = 12;
  bytes = countEscapedCodeUnits(cell.value.code, bytes, maxBudget);
  bytes = countEscapedCodeUnits(cell.value.message, bytes, maxBudget);
  return false;
}

function formatCell(cell: Cell, transformed: boolean): string {
  if (cell.kind === 'string') {
    const raw = cell.value;
    const text = transformed ? "'" + raw : raw;
    return '"' + text.replaceAll('"', '""') + '"';
  }
  if (cell.kind === 'number') return `"${cell.value}"`;
  if (cell.kind === 'boolean') return cell.value ? '"TRUE"' : '"FALSE"';
  const errText = `#ERROR[${cell.value.code}]: ${cell.value.message}`;
  return '"' + errText.replaceAll('"', '""') + '"';
}

export function encodeCsv(
  rect: Rect,
  cells: readonly Cell[],
  options: EncodeCsvOptions
): EncodeCsvResult {
  // 1. Validate options
  if (!options || typeof options !== 'object' || !isValidAbortSignal(options.signal)) {
    throw new DomainError('CONFIG_INVALID');
  }
  if (
    typeof options.maxBytes !== 'number' ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0 ||
    options.maxBytes > PROVISIONAL_MAX_CSV_BYTES
  ) {
    throw new DomainError('BYTE_LIMIT_EXCEEDED');
  }
  if (options.signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // 2. Validate rectangle
  if (!rect || typeof rect !== 'object') {
    throw new DomainError('RANGE_INVALID');
  }
  const { sheetId, r0, c0, r1, c1 } = rect;
  if (
    !isNonNegativeSafeInteger(sheetId) ||
    !isNonNegativeSafeInteger(r0) ||
    !isNonNegativeSafeInteger(c0) ||
    !isNonNegativeSafeInteger(r1) ||
    !isNonNegativeSafeInteger(c1)
  ) {
    throw new DomainError('RANGE_INVALID');
  }
  if (r1 < r0 || c1 < c0) {
    throw new DomainError('RANGE_INVALID');
  }
  if (r1 === r0 || c1 === c0) {
    throw new DomainError('RANGE_EMPTY');
  }

  // 3. Preflight minimum byte check using BigInt safe arithmetic
  const rowCount = BigInt(r1 - r0);
  const colCount = BigInt(c1 - c0);
  const minBytes = 3n + rowCount * (3n * colCount + 1n);
  if (minBytes > BigInt(options.maxBytes)) {
    throw new DomainError('BYTE_LIMIT_EXCEEDED');
  }

  // 4. Validate and index sparse cells
  if (!Array.isArray(cells)) {
    throw new DomainError('FORMAT_UNSUPPORTED');
  }
  const cellsByRow = new Map<number, Map<number, Cell>>();
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object') {
      throw new DomainError('FORMAT_UNSUPPORTED');
    }
    if (!isNonNegativeSafeInteger(cell.r) || !isNonNegativeSafeInteger(cell.c)) {
      throw new DomainError('RANGE_INVALID');
    }
    if (cell.r < r0 || cell.r >= r1 || cell.c < c0 || cell.c >= c1) {
      throw new DomainError('RANGE_OUT_OF_BOUNDS');
    }
    let rowMap = cellsByRow.get(cell.r);
    if (!rowMap) {
      rowMap = new Map();
      cellsByRow.set(cell.r, rowMap);
    }
    if (rowMap.has(cell.c)) {
      throw new DomainError('RANGE_INVALID');
    }
    switch (cell.kind) {
      case 'string':
        if (typeof cell.value !== 'string' || hasUnpairedSurrogates(cell.value)) {
          throw new DomainError('FORMAT_UNSUPPORTED');
        }
        break;
      case 'number':
        if (typeof cell.value !== 'number' || !Number.isFinite(cell.value)) {
          throw new DomainError('FORMAT_UNSUPPORTED');
        }
        break;
      case 'boolean':
        if (typeof cell.value !== 'boolean') {
          throw new DomainError('FORMAT_UNSUPPORTED');
        }
        break;
      case 'error':
        if (
          !cell.value ||
          typeof cell.value !== 'object' ||
          typeof cell.value.code !== 'string' ||
          typeof cell.value.message !== 'string' ||
          hasUnpairedSurrogates(cell.value.code) ||
          hasUnpairedSurrogates(cell.value.message)
        ) {
          throw new DomainError('FORMAT_UNSUPPORTED');
        }
        break;
      default:
        throw new DomainError('FORMAT_UNSUPPORTED');
    }
    rowMap.set(cell.c, cell);
  }

  // 5. Stream row-major emission into chunked buffer
  const encoder = new TextEncoder();
  const acc = new ByteAccumulator(options.maxBytes);
  acc.append(UTF8_BOM);

  const cols = c1 - c0;
  const emptyRowBytesCount = 3 * cols + 1;
  let cachedEmptyRow: Uint8Array | null = null;
  let transformedCells = 0;

  for (let r = r0; r < r1; r++) {
    if (options.signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }
    const rowMap = cellsByRow.get(r);
    if (!rowMap) {
      if (emptyRowBytesCount <= MAX_CACHED_EMPTY_ROW_BYTES) {
        if (!cachedEmptyRow) {
          cachedEmptyRow = buildEmptyRow(cols, encoder);
        }
        acc.append(cachedEmptyRow);
      } else {
        for (let c = 0; c < cols; c++) {
          if (c > 0) {
            acc.append(COMMA_BYTES);
          }
          acc.append(EMPTY_QUOTES);
        }
        acc.append(CRLF_BYTES);
      }
      continue;
    }
    for (let c = c0; c < c1; c++) {
      if (c > c0) {
        acc.append(COMMA_BYTES);
      }
      const cell = rowMap.get(c);
      if (!cell) {
        acc.append(EMPTY_QUOTES);
      } else {
        const transformed = preflightCellBytes(cell, acc.remainingBytes);
        if (transformed) {
          transformedCells++;
        }
        acc.append(encoder.encode(formatCell(cell, transformed)));
      }
    }
    acc.append(CRLF_BYTES);
  }

  return {
    bytes: acc.build(),
    transformedCells,
    policy: 'apostrophe_prefix_v1'
  };
}
