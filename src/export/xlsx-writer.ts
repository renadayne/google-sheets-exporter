/**
 * T24d2 XLSX WriterPort Adapter
 * Format adapter for XLSX export serialization (primary XLSX workbook + companion report JSON).
 * Delegates chunk buffering, snapshotting, and lifecycle fences to createBufferedWriter.
 */

import type { WriterPort } from '../contracts/ports.ts';
import { DomainError } from '../contracts/errors.ts';
import {
  createBufferedWriter,
  type BufferedWriterOptions,
  type PreparedSerializer
} from './buffered-writer.ts';
import { packageXlsx } from './xlsx-package.ts';
import {
  PROVISIONAL_MAX_XLSX_BYTES,
  PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS
} from './xlsx.ts';
import { PROVISIONAL_MAX_WARNINGS } from './report.ts';

export interface XlsxWriterOptions extends BufferedWriterOptions {
  readonly maxInputTextUnits: number;
  readonly maxBytes: number;
  readonly maxWarnings: number;
}

function isSafeInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max && !Object.is(v, -0);
}

export function createXlsxWriter(options: XlsxWriterOptions): WriterPort {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');

  let maxChunks: number;
  let maxCells: number;
  let maxIntervals: number;
  let maxDecodedBytes: number;
  let maxInputTextUnits: number;
  let maxBytes: number;
  let maxWarnings: number;
  try {
    maxChunks = options.maxChunks;
    maxCells = options.maxCells;
    maxIntervals = options.maxIntervals;
    maxDecodedBytes = options.maxDecodedBytes;
    maxInputTextUnits = options.maxInputTextUnits;
    maxBytes = options.maxBytes;
    maxWarnings = options.maxWarnings;
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }

  if (
    !isSafeInt(maxInputTextUnits, 0, PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS) ||
    !isSafeInt(maxBytes, 0, PROVISIONAL_MAX_XLSX_BYTES) ||
    !isSafeInt(maxWarnings, 0, PROVISIONAL_MAX_WARNINGS)
  ) {
    throw new DomainError('CONFIG_INVALID');
  }

  const bufferedOptions: BufferedWriterOptions = Object.freeze({
    maxChunks,
    maxCells,
    maxIntervals,
    maxDecodedBytes
  });

  const serialize: PreparedSerializer = (context, prepared, report, signal) => {
    return packageXlsx(context, prepared, report, {
      maxBytes,
      maxCells,
      maxInputTextUnits,
      maxWarnings,
      signal
    });
  };

  return createBufferedWriter('xlsx', bufferedOptions, serialize);
}
