/**
 * T24d2 CSV WriterPort Adapter
 * Format adapter for CSV export serialization (single CSV + companion JSON or multi-tab ZIP).
 * Delegates chunk buffering, snapshotting, and lifecycle fences to createBufferedWriter.
 * Single-sheet companion metadata stays private for an explicit metadata action;
 * default publication must select only the primary CSV.
 */

import type { WriterPort } from '../contracts/ports.ts';
import { DomainError } from '../contracts/errors.ts';
import {
  createBufferedWriter,
  type BufferedWriterOptions,
  type PreparedSerializer
} from './buffered-writer.ts';
import { packageCsv } from './csv-package.ts';
import {
  PROVISIONAL_MAX_CSV_ZIP_BYTES,
  PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES
} from './csv-zip.ts';
import { PROVISIONAL_MAX_WARNINGS } from './report.ts';

export interface CsvWriterOptions extends BufferedWriterOptions {
  readonly maxUncompressedBytes: number;
  readonly maxBytes: number;
  readonly maxWarnings: number;
}

function isSafeInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max && !Object.is(v, -0);
}

export function createCsvWriter(options: CsvWriterOptions): WriterPort {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');

  let maxChunks: number;
  let maxCells: number;
  let maxIntervals: number;
  let maxDecodedBytes: number;
  let maxUncompressedBytes: number;
  let maxBytes: number;
  let maxWarnings: number;
  try {
    maxChunks = options.maxChunks;
    maxCells = options.maxCells;
    maxIntervals = options.maxIntervals;
    maxDecodedBytes = options.maxDecodedBytes;
    maxUncompressedBytes = options.maxUncompressedBytes;
    maxBytes = options.maxBytes;
    maxWarnings = options.maxWarnings;
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }

  if (
    !isSafeInt(maxUncompressedBytes, 0, PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES) ||
    !isSafeInt(maxBytes, 0, PROVISIONAL_MAX_CSV_ZIP_BYTES) ||
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
    return packageCsv(context, prepared, report, {
      maxUncompressedBytes,
      maxBytes,
      maxWarnings,
      signal
    });
  };

  return createBufferedWriter('csv', bufferedOptions, serialize);
}
