/**
 * T24c1c / T24d1 JSON WriterPort Adapter
 * Format adapter for JSON export document serialization.
 * Delegates chunk buffering, snapshotting, and lifecycle fences to createBufferedWriter.
 */

import type { Artifact } from '../contracts/domain.ts';
import type { WriterPort } from '../contracts/ports.ts';
import { DomainError } from '../contracts/errors.ts';
import {
  createBufferedWriter,
  type BufferedWriterOptions,
  type PreparedSerializer
} from './buffered-writer.ts';
import { buildJsonExportDocument, PROVISIONAL_MAX_WARNINGS } from './json-document.ts';
import { encodeFrozenJson } from './json-encoding.ts';
import { formatWorkbookArtifactFilename } from './names.ts';
import { MAX_JSON_BYTES } from './json-string-bytes.ts';

export interface JsonWriterOptions {
  readonly maxChunks: number;
  readonly maxCells: number;
  readonly maxIntervals: number;
  readonly maxDecodedBytes: number;
  readonly maxWarnings: number;
  readonly maxBytes: number;
}

function isSafeInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max && !Object.is(v, -0);
}

export function createJsonWriter(options: JsonWriterOptions): WriterPort {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');

  let maxChunks: number;
  let maxCells: number;
  let maxIntervals: number;
  let maxDecodedBytes: number;
  let maxWarnings: number;
  let maxBytes: number;
  try {
    maxChunks = options.maxChunks;
    maxCells = options.maxCells;
    maxIntervals = options.maxIntervals;
    maxDecodedBytes = options.maxDecodedBytes;
    maxWarnings = options.maxWarnings;
    maxBytes = options.maxBytes;
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }

  if (!isSafeInt(maxWarnings, 0, PROVISIONAL_MAX_WARNINGS) || !isSafeInt(maxBytes, 0, MAX_JSON_BYTES)) {
    throw new DomainError('CONFIG_INVALID');
  }

  const bufferedOptions: BufferedWriterOptions = Object.freeze({
    maxChunks,
    maxCells,
    maxIntervals,
    maxDecodedBytes
  });

  const serialize: PreparedSerializer = (context, prepared, report, signal) => {
    const doc = buildJsonExportDocument(context, prepared, report, { maxWarnings, signal });
    const encodedBytes = encodeFrozenJson(doc, { maxBytes, signal });

    const artifact: Artifact = Object.freeze({
      filename: formatWorkbookArtifactFilename(context.title, 'json'),
      mimeType: 'application/json',
      data: encodedBytes,
      byteLength: encodedBytes.byteLength,
      safeSummary: 'JSON export document'
    });
    return Object.freeze([artifact]);
  };

  return createBufferedWriter('json', bufferedOptions, serialize);
}
