/**
 * T28a Primitive Browser-Compatible XLSX Encoder
 * Pure data encoder mapping prepared sheets to XLSX bytes via ExcelJS Document Workbook.
 * Precondition: `prepared` is output of reviewed `prepareWriterData`.
 * Does not implement WriterPort, report generation, UI, or download dispatch.
 */

import ExcelJS from 'exceljs';
import type { SheetNameMapping } from '../contracts/domain.ts';
import { DomainError, isErrorCode, type ErrorCode } from '../contracts/errors.ts';
import type { PreparedSheet } from './prepare.ts';
import { mapWorksheetNames } from './names.ts';
import {
  XLSX_MAX_TEXT_UTF16_UNITS,
  assertXlsxRectRepresentable,
  assertXlsxTextRepresentable,
  assertXlsxNumberRepresentable
} from './xlsx-guards.ts';

export const PROVISIONAL_MAX_XLSX_BYTES = 64 * 1024 * 1024; // 64 MiB
export const PROVISIONAL_MAX_XLSX_CELLS = 250_000;
export const PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS = 8_000_000;
const ERROR_FRAMING_UNITS = 10; // '#ERROR[' (7) + ']: ' (3)

export interface EncodeXlsxOptions {
  readonly maxBytes: number;
  readonly maxCells: number;
  readonly maxInputTextUnits: number;
  readonly signal: AbortSignal;
}

export interface EncodeXlsxResult {
  readonly bytes: Uint8Array;
  readonly nameMappings: readonly SheetNameMapping[];
}

interface CellAssignment {
  readonly r: number;
  readonly c: number;
  readonly value: string | number | boolean;
}

function isSafeNonNegInt(val: unknown, max: number): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && val <= max && !Object.is(val, -0);
}

/**
 * Escapes OOXML ST_Xstring characters for cell wire text:
 * 1. Protect literal underscores beginning any _xHHHH_ sequence (case-insensitive hex, 4 digits)
 *    using lookahead matching ONLY the underscore so overlapping starts aren't skipped.
 * 2. Escape literal carriage returns (\r) as _x000D_.
 * Applied AFTER validating and counting original text to ensure wire expansion does not
 * affect cell text or total text unit limit checks.
 */
function escapeOoxmlCellString(s: string): string {
  return s.replace(/_(?=[xX][0-9a-fA-F]{4}_)/g, '_x005F_').replace(/\r/g, '_x000D_');
}

async function encodeXlsxInternal(
  prepared: readonly PreparedSheet[],
  options: EncodeXlsxOptions
): Promise<EncodeXlsxResult> {
  let maxBytes: number;
  let maxCells: number;
  let maxInputTextUnits: number;
  let signal: AbortSignal;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new DomainError('CONFIG_INVALID');
    }
    const { maxBytes: b, maxCells: c, maxInputTextUnits: u, signal: s } = options;
    if (
      !isSafeNonNegInt(b, PROVISIONAL_MAX_XLSX_BYTES) ||
      !isSafeNonNegInt(c, PROVISIONAL_MAX_XLSX_CELLS) ||
      !isSafeNonNegInt(u, PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS) ||
      !s || typeof s !== 'object' || typeof s.aborted !== 'boolean' ||
      typeof (s as any).addEventListener !== 'function' ||
      typeof (s as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (s.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }
    if (!Array.isArray(prepared) || prepared.length === 0) {
      throw new DomainError('CONFIG_INVALID');
    }
    maxBytes = b;
    maxCells = c;
    maxInputTextUnits = u;
    signal = s;
  } catch (err) {
    if (err instanceof DomainError && isErrorCode(err.code)) {
      throw new DomainError(err.code);
    }
    throw new DomainError('CONFIG_INVALID');
  }

  // 1. Count all incoming cells before allocating cell plans; over-count CELL_LIMIT_EXCEEDED
  let totalCellCount = 0;
  for (let i = 0; i < prepared.length; i++) {
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    const sheet = prepared[i];
    if (!sheet || typeof sheet !== 'object' || !Array.isArray(sheet.cells)) {
      throw new DomainError('CONFIG_INVALID');
    }
    totalCellCount += sheet.cells.length;
  }
  if (totalCellCount > maxCells) {
    throw new DomainError('CELL_LIMIT_EXCEEDED');
  }

  // 2. Preflight into bounded sparse scalar assignments
  let totalTextUnits = 0;
  const sheetPlans: CellAssignment[][] = [];
  for (let i = 0; i < prepared.length; i++) {
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    const sheet = prepared[i];
    assertXlsxRectRepresentable(sheet.scope);
    const { r0, c0, r1, c1 } = sheet.scope;
    const assignments: CellAssignment[] = [];

    for (let j = 0; j < sheet.cells.length; j++) {
      if ((j & 127) === 0 && signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const cell = sheet.cells[j];
      if (!cell || typeof cell !== 'object') throw new DomainError('FORMAT_UNSUPPORTED');
      const { r, c, kind } = cell;
      if (
        typeof r !== 'number' || !Number.isSafeInteger(r) || r < 0 || Object.is(r, -0) ||
        typeof c !== 'number' || !Number.isSafeInteger(c) || c < 0 || Object.is(c, -0)
      ) {
        throw new DomainError('RANGE_INVALID');
      }
      if (r < r0 || r >= r1 || c < c0 || c >= c1) {
        throw new DomainError('RANGE_OUT_OF_BOUNDS');
      }

      let capturedValue: string | number | boolean;
      if (kind === 'string') {
        const val = cell.value;
        if (typeof val !== 'string') throw new DomainError('FORMAT_UNSUPPORTED');
        assertXlsxTextRepresentable(val);
        totalTextUnits += val.length;
        capturedValue = escapeOoxmlCellString(val);
      } else if (kind === 'number') {
        const val = cell.value;
        if (typeof val !== 'number') throw new DomainError('FORMAT_UNSUPPORTED');
        assertXlsxNumberRepresentable(val);
        capturedValue = val;
      } else if (kind === 'boolean') {
        const val = cell.value;
        if (typeof val !== 'boolean') throw new DomainError('FORMAT_UNSUPPORTED');
        capturedValue = val;
      } else if (kind === 'error') {
        const errObj = cell.value;
        if (!errObj || typeof errObj !== 'object') throw new DomainError('FORMAT_UNSUPPORTED');
        const { code, message } = errObj;
        if (typeof code !== 'string' || typeof message !== 'string') throw new DomainError('FORMAT_UNSUPPORTED');
        if (ERROR_FRAMING_UNITS + code.length + message.length > XLSX_MAX_TEXT_UTF16_UNITS) {
          throw new DomainError('FORMAT_UNSUPPORTED');
        }
        const rendered = `#ERROR[${code}]: ${message}`;
        assertXlsxTextRepresentable(rendered);
        totalTextUnits += rendered.length;
        capturedValue = escapeOoxmlCellString(rendered);
      } else {
        throw new DomainError('FORMAT_UNSUPPORTED');
      }

      if (totalTextUnits > maxInputTextUnits) {
        throw new DomainError('SIZE_LIMIT_EXCEEDED');
      }
      assignments.push({ r, c, value: capturedValue });
    }
    sheetPlans.push(assignments);
  }

  if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

  // 3. Worksheet name mapping
  let nameMappings: readonly SheetNameMapping[];
  try {
    const sheetInputs = prepared.map(p => {
      if (!p.metadata || typeof p.metadata.id !== 'number' || typeof p.metadata.title !== 'string') {
        throw new DomainError('CONFIG_INVALID');
      }
      return { id: p.metadata.id, title: p.metadata.title };
    });
    nameMappings = mapWorksheetNames(sheetInputs);
  } catch (err) {
    if (signal.aborted || (err instanceof DomainError && err.code === 'OPERATION_ABORTED')) {
      throw new DomainError('OPERATION_ABORTED');
    }
    if (err instanceof DomainError && isErrorCode(err.code)) {
      throw new DomainError(err.code);
    }
    throw new DomainError('CONFIG_INVALID');
  }

  const frozenMappings = Object.freeze(
    nameMappings.map(m =>
      Object.freeze({ sheetId: m.sheetId, originalTitle: m.originalTitle, exportedName: m.exportedName })
    )
  );

  if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

  // 4. Populate ExcelJS Workbook (with exception boundary)
  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    workbook.creator = 'Google Sheets Exporter';
    workbook.lastModifiedBy = 'Google Sheets Exporter';

    for (let i = 0; i < sheetPlans.length; i++) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const ws = workbook.addWorksheet(frozenMappings[i].exportedName);
      const plan = sheetPlans[i];
      for (let k = 0; k < plan.length; k++) {
        if ((k & 127) === 0 && signal.aborted) throw new DomainError('OPERATION_ABORTED');
        const item = plan[k];
        ws.getCell(item.r + 1, item.c + 1).value = item.value;
      }
    }
  } catch (err) {
    if (signal.aborted || (err instanceof DomainError && err.code === 'OPERATION_ABORTED')) {
      throw new DomainError('OPERATION_ABORTED');
    }
    if (err instanceof DomainError && isErrorCode(err.code)) {
      throw new DomainError(err.code);
    }
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

  // 5. Serialization and abort race
  let onAbort: (() => void) | undefined;
  const removeAbortListener = () => {
    if (onAbort) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // Safe cleanup
      }
      onAbort = undefined;
    }
  };

  let rawBuffer: unknown;
  try {
    let abortReject: ((err: unknown) => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    // Observe abortPromise to prevent unhandled rejection on sync provider throw/rejection or late settlement
    abortPromise.catch(() => {});

    onAbort = () => {
      if (abortReject) {
        abortReject(new DomainError('OPERATION_ABORTED'));
      }
    };

    try {
      signal.addEventListener('abort', onAbort, { once: true });
    } catch {
      // Registration failure must reject static CONFIG_INVALID BEFORE invoking provider
      throw new DomainError('CONFIG_INVALID');
    }

    // IMMEDIATELY recheck signal after installing listener:
    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    const writePromise = Promise.resolve().then(() => {
      if (signal.aborted) {
        throw new DomainError('OPERATION_ABORTED');
      }
      return workbook.xlsx.writeBuffer();
    });

    rawBuffer = await Promise.race([writePromise, abortPromise]);
  } catch (err) {
    let wasAborted = false;
    try {
      wasAborted = Boolean(signal.aborted);
    } catch {
      // Ignore throwing signal.aborted
    }
    if (wasAborted || (err instanceof DomainError && err.code === 'OPERATION_ABORTED')) {
      throw new DomainError('OPERATION_ABORTED');
    }
    if (err instanceof DomainError && isErrorCode(err.code)) {
      throw new DomainError(err.code);
    }
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  } finally {
    removeAbortListener();
  }

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // 6. Inspect buffer, check limits, and copy owned Uint8Array
  let srcView: Uint8Array;
  try {
    if (rawBuffer instanceof ArrayBuffer) {
      srcView = new Uint8Array(rawBuffer);
    } else if (ArrayBuffer.isView(rawBuffer)) {
      srcView = new Uint8Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);
    } else {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
  } catch {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // Zero-length serialization buffers fail static FORMAT_SERIALIZATION_FAILED
  if (srcView.byteLength === 0) {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (srcView.byteLength > maxBytes) {
    throw new DomainError('BYTE_LIMIT_EXCEEDED');
  }

  let ownedBytes: Uint8Array;
  try {
    ownedBytes = new Uint8Array(srcView.byteLength);
    ownedBytes.set(srcView);
  } catch {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  return Object.freeze({
    bytes: ownedBytes,
    nameMappings: frozenMappings
  });
}

export async function encodeXlsx(
  prepared: readonly PreparedSheet[],
  options: EncodeXlsxOptions
): Promise<EncodeXlsxResult> {
  try {
    return await encodeXlsxInternal(prepared, options);
  } catch (err: unknown) {
    let trustedCode: ErrorCode | undefined;
    try {
      if (err instanceof DomainError) {
        const code = err.code;
        if (isErrorCode(code)) {
          trustedCode = code;
        }
      }
    } catch {
      // Mutated DomainError getter must not escape
    }
    if (trustedCode !== undefined) {
      throw new DomainError(trustedCode);
    }
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
