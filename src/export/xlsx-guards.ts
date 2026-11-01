/**
 * T29a Pure XLSX Dimension and Text Representability Guards.
 * Excel dimensions: 1,048,576 rows by 16,384 columns.
 * Conservative product text cap: 32,767 UTF-16 units (Excel documents 32,767 characters).
 * XML 1.0 Char grammar: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
 */

import type { Rect } from '../contracts/domain.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';

export const XLSX_MAX_ROWS = 1048576;
export const XLSX_MAX_COLUMNS = 16384;
export const XLSX_MAX_TEXT_UTF16_UNITS = 32767;

const RECT_KEYS = ['sheetId', 'r0', 'c0', 'r1', 'c1'] as const;

function isNonNegativeSafeInt(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && !Object.is(val, -0);
}

export function assertXlsxRectRepresentable(rect: Rect): void {
  try {
    if (!rect || typeof rect !== 'object' || Array.isArray(rect) || Object.getOwnPropertySymbols(rect).length > 0) {
      throw new DomainError('RANGE_INVALID');
    }
    const keys = Object.keys(rect);
    if (keys.length !== 5 || keys.some(k => !(RECT_KEYS as readonly string[]).includes(k)) ||
        !RECT_KEYS.every(k => Object.prototype.hasOwnProperty.call(rect, k))) {
      throw new DomainError('RANGE_INVALID');
    }
    const { sheetId, r0, c0, r1, c1 } = rect;
    if (
      !isNonNegativeSafeInt(sheetId) ||
      !isNonNegativeSafeInt(r0) ||
      !isNonNegativeSafeInt(c0) ||
      !isNonNegativeSafeInt(r1) ||
      !isNonNegativeSafeInt(c1)
    ) {
      throw new DomainError('RANGE_INVALID');
    }
    if (r1 < r0 || c1 < c0) throw new DomainError('RANGE_INVALID');
    if (r1 === r0 || c1 === c0) throw new DomainError('RANGE_EMPTY');
    if (r1 > XLSX_MAX_ROWS || c1 > XLSX_MAX_COLUMNS) throw new DomainError('FORMAT_UNSUPPORTED');
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('RANGE_INVALID');
  }
}

export function assertXlsxTextRepresentable(value: string): void {
  try {
    if (typeof value !== 'string' || value.length > XLSX_MAX_TEXT_UTF16_UNITS) {
      throw new DomainError('FORMAT_UNSUPPORTED');
    }
    for (const ch of value) {
      const cp = ch.codePointAt(0);
      if (
        cp === undefined ||
        !(
          cp === 0x9 ||
          cp === 0xa ||
          cp === 0xd ||
          (cp >= 0x20 && cp <= 0xd7ff) ||
          (cp >= 0xe000 && cp <= 0xfffd) ||
          (cp >= 0x10000 && cp <= 0x10ffff)
        )
      ) {
        throw new DomainError('FORMAT_UNSUPPORTED');
      }
    }
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('FORMAT_UNSUPPORTED');
  }
}
