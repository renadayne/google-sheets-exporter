/**
 * T24c1c JSON WriterPort Lifecycle and Private Artifact Staging
 * Writer owns private context, collected chunks, and aggregate budgets.
 * Staged artifacts remain private; publication authority rests solely with caller/controller.
 */

import type { Artifact, ExportReport, NormalizedChunk } from '../contracts/domain.ts';
import type { WriterContext, WriterPort } from '../contracts/ports.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { snapshotWriterContext } from './context.ts';
import { snapshotWriterChunk, PROVISIONAL_MAX_DECODED_BYTES } from './chunk-snapshot.ts';
import { prepareWriterData } from './prepare.ts';
import { buildJsonExportDocument, PROVISIONAL_MAX_WARNINGS } from './json-document.ts';
import { encodeFrozenJson } from './json-encoding.ts';
import { formatWorkbookArtifactFilename } from './names.ts';
import { PROVISIONAL_MAX_CHUNKS } from './coverage.ts';
import { PROVISIONAL_MAX_INTERVALS } from './exclusions.ts';
import { PROVISIONAL_MAX_CELLS } from './cells.ts';
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

function assertSignal(signal: unknown): asserts signal is AbortSignal {
  if (!signal || typeof signal !== 'object' ||
      typeof (signal as any).addEventListener !== 'function' || typeof (signal as any).removeEventListener !== 'function') {
    throw new DomainError('CONFIG_INVALID');
  }
  const aborted = (signal as AbortSignal).aborted;
  if (typeof aborted !== 'boolean') {
    throw new DomainError('CONFIG_INVALID');
  }
  if (aborted) throw new DomainError('OPERATION_ABORTED');
}

export function createJsonWriter(options: JsonWriterOptions): WriterPort {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');

  let maxChunks: number, maxCells: number, maxIntervals: number, maxDecodedBytes: number, maxWarnings: number, maxBytes: number;
  try {
    maxChunks = options.maxChunks; maxCells = options.maxCells; maxIntervals = options.maxIntervals;
    maxDecodedBytes = options.maxDecodedBytes; maxWarnings = options.maxWarnings; maxBytes = options.maxBytes;
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }

  if (!isSafeInt(maxChunks, 1, PROVISIONAL_MAX_CHUNKS) || !isSafeInt(maxCells, 0, PROVISIONAL_MAX_CELLS) ||
      !isSafeInt(maxIntervals, 0, PROVISIONAL_MAX_INTERVALS) || !isSafeInt(maxDecodedBytes, 0, PROVISIONAL_MAX_DECODED_BYTES) ||
      !isSafeInt(maxWarnings, 0, PROVISIONAL_MAX_WARNINGS) || !isSafeInt(maxBytes, 0, MAX_JSON_BYTES)) {
    throw new DomainError('CONFIG_INVALID');
  }

  let currentGeneration = 0;
  let phase: 'idle' | 'open' | 'finalizing' = 'idle';
  let context: WriterContext | null = null;
  let chunks: NormalizedChunk[] = [];
  let chunkIds = new Set<string>();
  let boundJobId: string | null = null;
  let aggregateCells = 0, aggregateIntervals = 0, aggregateDecodedBytes = 0;

  function resetSession(): void {
    currentGeneration++; phase = 'idle'; context = null; chunks = []; chunkIds = new Set();
    boundJobId = null; aggregateCells = 0; aggregateIntervals = 0; aggregateDecodedBytes = 0;
  }

  async function begin(rawContext: WriterContext, signal: AbortSignal): Promise<void> {
    if (phase !== 'idle') { resetSession(); throw new DomainError('FORMAT_SERIALIZATION_FAILED'); }
    const sessionGen = ++currentGeneration;
    try {
      assertSignal(signal);
      if (sessionGen !== currentGeneration || phase !== 'idle') {
        throw new DomainError('OPERATION_ABORTED');
      }
      const snap = snapshotWriterContext(rawContext, { maxSheets: maxChunks, signal });
      if (snap.format !== 'json') {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (sessionGen !== currentGeneration || phase !== 'idle') {
        throw new DomainError('OPERATION_ABORTED');
      }
      phase = 'open'; context = snap; chunks = []; chunkIds = new Set();
      boundJobId = null; aggregateCells = 0; aggregateIntervals = 0; aggregateDecodedBytes = 0;
    } catch (err) {
      if (sessionGen === currentGeneration) resetSession();
      throw toSafeDomainError(err);
    }
  }

  async function append(chunk: NormalizedChunk, signal: AbortSignal): Promise<void> {
    const sessionGen = currentGeneration;
    try {
      if (phase !== 'open' || !context) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      const activeContext = context;
      assertSignal(signal);
      if (sessionGen !== currentGeneration || phase !== 'open') {
        throw new DomainError('OPERATION_ABORTED');
      }
      if (chunks.length >= maxChunks) throw new DomainError('SIZE_LIMIT_EXCEEDED');

      const remainingCells = Math.max(0, maxCells - aggregateCells);
      const remainingIntervals = Math.max(0, maxIntervals - aggregateIntervals);
      const remainingDecodedBytes = Math.max(0, maxDecodedBytes - aggregateDecodedBytes);

      const snap = snapshotWriterChunk(activeContext, chunk, {
        maxCells: remainingCells, maxIntervals: remainingIntervals,
        maxDecodedBytes: remainingDecodedBytes, signal
      });

      if (sessionGen !== currentGeneration || phase !== 'open') {
        throw new DomainError('OPERATION_ABORTED');
      }

      if (boundJobId === null) boundJobId = snap.jobId;
      else if (snap.jobId !== boundJobId) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

      if (chunkIds.has(snap.chunkId)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

      chunkIds.add(snap.chunkId);
      chunks.push(snap);
      aggregateCells += snap.cells.length;
      aggregateIntervals += snap.excludedIntervals.rows.length + snap.excludedIntervals.columns.length;
      aggregateDecodedBytes += snap.byteCount;
    } catch (err) {
      if (sessionGen === currentGeneration) resetSession();
      throw toSafeDomainError(err);
    }
  }

  async function finalize(report: ExportReport, signal: AbortSignal): Promise<readonly Artifact[]> {
    const sessionGen = currentGeneration;
    try {
      if (phase !== 'open' || !context) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      assertSignal(signal);
      if (sessionGen !== currentGeneration || phase !== 'open') {
        throw new DomainError('OPERATION_ABORTED');
      }
      phase = 'finalizing';
      const activeContext = context, activeChunks = chunks;

      const prepared = prepareWriterData(activeContext, activeChunks, { maxChunks, maxIntervals, maxCells, signal });
      const doc = buildJsonExportDocument(activeContext, prepared, report, { maxWarnings, signal });
      const encodedBytes = encodeFrozenJson(doc, { maxBytes, signal });

      const artifact: Artifact = Object.freeze({
        filename: formatWorkbookArtifactFilename(activeContext.title, 'json'),
        mimeType: 'application/json',
        data: encodedBytes,
        byteLength: encodedBytes.byteLength,
        safeSummary: 'JSON export document'
      });
      const artifacts = Object.freeze([artifact]);

      // Generation-fence asynchronous continuations: yield to microtask queue
      await Promise.resolve();

      assertSignal(signal);
      if (sessionGen !== currentGeneration || phase !== 'finalizing') {
        throw new DomainError('OPERATION_ABORTED');
      }

      phase = 'idle'; context = null; chunks = []; chunkIds = new Set();
      boundJobId = null; aggregateCells = 0; aggregateIntervals = 0; aggregateDecodedBytes = 0;
      return artifacts;
    } catch (err) {
      if (sessionGen === currentGeneration) resetSession();
      throw toSafeDomainError(err);
    }
  }

  async function abort(): Promise<void> {
    resetSession();
  }

  return Object.freeze({ begin, append, finalize, abort });
}
