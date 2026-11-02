/**
 * T36b4 Local Worker Writer Factory
 * Bounded factory creating fresh, independent WriterPort adapters for dedicated worker execution.
 * Configures provisional worker limits for json, csv, and xlsx formats.
 * Invariant: Never handles auth tokens, network, browser globals, or persistent caches.
 */

import type { ExportFormat } from '../contracts/domain.ts';
import type { WriterPort } from '../contracts/ports.ts';
import { DomainError } from '../contracts/errors.ts';
import { PROVISIONAL_MAX_CHUNKS } from '../export/coverage.ts';
import { PROVISIONAL_MAX_CELLS } from '../export/cells.ts';
import { PROVISIONAL_MAX_INTERVALS } from '../export/exclusions.ts';
import { PROVISIONAL_MAX_DECODED_BYTES } from '../export/chunk-snapshot.ts';
import { PROVISIONAL_MAX_WARNINGS } from '../export/report.ts';
import { PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES } from '../export/csv-zip.ts';
import { PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS } from '../export/xlsx.ts';
import { createJsonWriter } from '../export/json.ts';
import { createCsvWriter } from '../export/csv-writer.ts';
import { createXlsxWriter } from '../export/xlsx-writer.ts';

export interface WorkerLimits {
  readonly maxChunks: number;
  readonly maxCells: number;
  readonly maxIntervals: number;
  readonly maxDecodedBytes: number;
  readonly maxWarnings: number;
  readonly maxOutputBytes: number;
  readonly maxUncompressedBytes: number;
  readonly maxInputTextUnits: number;
}

export const PROVISIONAL_WORKER_LIMITS: WorkerLimits = Object.freeze({
  maxChunks: PROVISIONAL_MAX_CHUNKS,
  maxCells: PROVISIONAL_MAX_CELLS,
  maxIntervals: PROVISIONAL_MAX_INTERVALS,
  maxDecodedBytes: PROVISIONAL_MAX_DECODED_BYTES,
  maxWarnings: PROVISIONAL_MAX_WARNINGS,
  maxOutputBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
  maxInputTextUnits: PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS
});

export function createWorkerWriter(format: ExportFormat): WriterPort {
  if (format === 'json') {
    return createJsonWriter({
      maxChunks: PROVISIONAL_WORKER_LIMITS.maxChunks,
      maxCells: PROVISIONAL_WORKER_LIMITS.maxCells,
      maxIntervals: PROVISIONAL_WORKER_LIMITS.maxIntervals,
      maxDecodedBytes: PROVISIONAL_WORKER_LIMITS.maxDecodedBytes,
      maxWarnings: PROVISIONAL_WORKER_LIMITS.maxWarnings,
      maxBytes: PROVISIONAL_WORKER_LIMITS.maxOutputBytes
    });
  }

  if (format === 'csv') {
    return createCsvWriter({
      maxChunks: PROVISIONAL_WORKER_LIMITS.maxChunks,
      maxCells: PROVISIONAL_WORKER_LIMITS.maxCells,
      maxIntervals: PROVISIONAL_WORKER_LIMITS.maxIntervals,
      maxDecodedBytes: PROVISIONAL_WORKER_LIMITS.maxDecodedBytes,
      maxUncompressedBytes: PROVISIONAL_WORKER_LIMITS.maxUncompressedBytes,
      maxBytes: PROVISIONAL_WORKER_LIMITS.maxOutputBytes,
      maxWarnings: PROVISIONAL_WORKER_LIMITS.maxWarnings
    });
  }

  if (format === 'xlsx') {
    return createXlsxWriter({
      maxChunks: PROVISIONAL_WORKER_LIMITS.maxChunks,
      maxCells: PROVISIONAL_WORKER_LIMITS.maxCells,
      maxIntervals: PROVISIONAL_WORKER_LIMITS.maxIntervals,
      maxDecodedBytes: PROVISIONAL_WORKER_LIMITS.maxDecodedBytes,
      maxInputTextUnits: PROVISIONAL_WORKER_LIMITS.maxInputTextUnits,
      maxBytes: PROVISIONAL_WORKER_LIMITS.maxOutputBytes,
      maxWarnings: PROVISIONAL_WORKER_LIMITS.maxWarnings
    });
  }

  throw new DomainError('FORMAT_UNSUPPORTED');
}
