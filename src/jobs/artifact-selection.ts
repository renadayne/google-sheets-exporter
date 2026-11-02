/**
 * T31a Bounded Private Artifact Action Selection
 *
 * Pure publication artifact selector bridging staged worker artifacts to controller download actions.
 * Validates whole staged artifacts array against sanitized WriterContext and expected writer naming rules,
 * then returns a fresh frozen array of frozen artifact wrappers for the requested publication action.
 *
 * CRITICAL ARCHITECTURAL INVARIANTS:
 * 1. PURE SELECTION ONLY:
 *    - Carries NO authorization authority, provenance, current job/generation proof,
 *      completeness claim, or consistency proof.
 *    - Even companion metadata action requires a NEW controller same-principal / final
 *      permission gate before publication.
 *    - NO browser downloads API, DownloadPort call, Blob URL creation, Chrome APIs, timers,
 *      storage, or network communication.
 * 2. BOUNDED WORKER TRANSPORT PROFILE:
 *    - Provisional max transport budget 64 MiB (0..67,108,864 safe non-negative integer, no -0).
 *    - Max staged artifacts cardinality is 2 (provisional worker profile, not new domain limit).
 * 3. OPTIONS CAPTURE ONCE:
 *    - options.maxBytes and options.signal captured and validated exactly once.
 *    - Native-shaped AbortSignal verified (aborted boolean, addEventListener/removeEventListener functions).
 *    - Pre-abort, intermediate, and final abort checks throw static DomainError('OPERATION_ABORTED').
 *    - Invalid options or throwing accessors throw static DomainError('CONFIG_INVALID').
 * 4. STRICT ACTION VALIDATION WITHOUT COERCION:
 *    - Only 'export' and 'csv_metadata' actions are supported.
 *    - Unknown or hostile action values throw static DomainError('CONFIG_INVALID') without coercion
 *      or invoking prototype/toString/valueOf hooks.
 * 5. WHOLE STAGING VALIDATION:
 *    - Context is reconstructed and deep-frozen via snapshotWriterContext(maxSheets: PROVISIONAL_MAX_SHEETS).
 *    - Staging parsed via parseWorkerArtifacts(maxArtifacts: 2, maxBytes).
 *    - Entire staging is validated against expected writer format/cardinality/filename/MIME even if only
 *      one artifact is selected for the requested action.
 *    - Bad staging, cardinality mismatches, misnamed files, mismimed types, or swapped orders throw
 *      static DomainError('FORMAT_SERIALIZATION_FAILED').
 *    - Never infer format by arbitrary filename or MIME: compare context format/sheet count to expected
 *      reviewed writer helpers (formatWorkbookArtifactFilename, mapCsvFilenames, formatMetadataArtifactFilename).
 *    - Does NOT decode or compare file contents.
 * 6. FORMAT ACTION COMPATIBILITY:
 *    - 'csv_metadata' is valid ONLY for single-sheet CSV exports.
 *    - 'csv_metadata' on JSON, XLSX, or multi-sheet CSV throws static DomainError('FORMAT_UNSUPPORTED').
 * 7. IMMUTABILITY AND ZERO-COPY:
 *    - Returns fresh Object.freeze array of captured frozen Artifact wrappers.
 *    - Retains binary identity (Uint8Array or Blob); no payload copying, mutation, or binary freezing.
 */

import type { Artifact } from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { snapshotWriterContext, PROVISIONAL_MAX_SHEETS } from '../export/context.ts';
import {
  formatWorkbookArtifactFilename,
  mapCsvFilenames,
  formatMetadataArtifactFilename
} from '../export/names.ts';
import { parseWorkerArtifacts } from '../runtime/worker-artifacts.ts';

/** Provisional worker output transport limit (64 MiB = 67,108,864 bytes). */
export const PROVISIONAL_MAX_BYTES = 64 * 1024 * 1024;

const JSON_MIME = 'application/json';
const CSV_MIME = 'text/csv';
const ZIP_MIME = 'application/zip';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type PublicationAction = 'export' | 'csv_metadata';

export interface SelectPublicationArtifactsOptions {
  readonly signal: AbortSignal;
  readonly maxBytes: number;
}

/**
 * Selects and validates staged publication artifacts for an export or metadata download action.
 *
 * @param context Sanitized WriterContext (rebuilt via snapshotWriterContext).
 * @param artifacts Untrusted staged artifacts payload across worker boundary.
 * @param action Publication action ('export' or 'csv_metadata').
 * @param options Options capturing signal and transport maxBytes.
 * @returns Fresh frozen array of frozen Artifact wrappers.
 */
export function selectPublicationArtifacts(
  context: WriterContext,
  artifacts: unknown,
  action: PublicationAction,
  options: SelectPublicationArtifactsOptions
): readonly Artifact[] {
  try {
    return selectArtifacts(context, artifacts, action, options);
  } catch (error) {
    throw toSafeDomainError(error);
  }
}

function selectArtifacts(
  context: WriterContext,
  artifacts: unknown,
  action: PublicationAction,
  options: SelectPublicationArtifactsOptions
): readonly Artifact[] {
  // 1. Strict action validation without coercion
  if (action !== 'export' && action !== 'csv_metadata') {
    throw new DomainError('CONFIG_INVALID');
  }

  // 2. Validate options container
  // Capture options properties exactly once
  let maxBytes: number;
  let signal: AbortSignal;
  let aborted = false;

  try {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new DomainError('CONFIG_INVALID');
    }
    const rawMaxBytes = options.maxBytes;
    const rawSignal = options.signal;
    const rawAborted = rawSignal?.aborted;

    if (
      typeof rawMaxBytes !== 'number' ||
      !Number.isSafeInteger(rawMaxBytes) ||
      rawMaxBytes < 0 ||
      rawMaxBytes > PROVISIONAL_MAX_BYTES ||
      Object.is(rawMaxBytes, -0) ||
      typeof rawSignal !== 'object' ||
      rawSignal === null ||
      Array.isArray(rawSignal) ||
      typeof rawAborted !== 'boolean' ||
      typeof (rawSignal as any).addEventListener !== 'function' ||
      typeof (rawSignal as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }

    aborted = rawAborted;
    maxBytes = rawMaxBytes;
    signal = rawSignal;
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }

  // Pre-abort check
  if (aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // 3. Rebuild context snapshot via snapshotWriterContext
  let validatedContext: WriterContext;
  try {
    validatedContext = snapshotWriterContext(context, {
      maxSheets: PROVISIONAL_MAX_SHEETS,
      signal
    });
  } catch (err) {
    if (signal.aborted || (err instanceof DomainError && err.code === 'OPERATION_ABORTED')) {
      throw new DomainError('OPERATION_ABORTED');
    }
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  // Check abort after context snapshot
  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // 4. Parse worker staging across the boundary (provisional maxArtifacts: 2, maxBytes)
  const parsed = parseWorkerArtifacts(artifacts, {
    maxArtifacts: 2,
    maxBytes
  });

  if (parsed === null) {
    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  // Check abort after parsing staging
  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // 5. Validate entire staging against expected real writer output and select artifacts
  const format = validatedContext.format;
  const sheetCount = validatedContext.sheets.length;

  if (format === 'json') {
    // Exactly 1 JSON document
    if (parsed.length !== 1) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    const expectedFilename = formatWorkbookArtifactFilename(validatedContext.title, 'json');
    if (parsed[0].filename !== expectedFilename || parsed[0].mimeType !== JSON_MIME) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (action === 'export') {
      if (signal.aborted) {
        throw new DomainError('OPERATION_ABORTED');
      }
      return Object.freeze([parsed[0]]);
    }

    // csv_metadata is not supported for JSON format
    throw new DomainError('FORMAT_UNSUPPORTED');
  }

  if (format === 'csv') {
    if (sheetCount === 1) {
      // Exactly 2 artifacts: primary CSV + companion metadata JSON in that order
      if (parsed.length !== 2) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      const mappings = mapCsvFilenames(validatedContext.sheets);
      const primaryFilename = mappings[0].exportedName;
      const companionFilename = formatMetadataArtifactFilename(primaryFilename);

      if (
        parsed[0].filename !== primaryFilename ||
        parsed[0].mimeType !== CSV_MIME ||
        parsed[1].filename !== companionFilename ||
        parsed[1].mimeType !== JSON_MIME
      ) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      if (signal.aborted) {
        throw new DomainError('OPERATION_ABORTED');
      }

      if (action === 'export') {
        // Single-sheet CSV export returns primary CSV only (excludes companion metadata)
        return Object.freeze([parsed[0]]);
      }

      // Explicit csv_metadata returns companion metadata only (never downloads CSV again)
      return Object.freeze([parsed[1]]);
    } else {
      // Multi-sheet CSV: exactly 1 ZIP archive
      if (parsed.length !== 1) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      const zipFilename = formatWorkbookArtifactFilename(validatedContext.title, 'zip');
      if (parsed[0].filename !== zipFilename || parsed[0].mimeType !== ZIP_MIME) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      if (action === 'export') {
        if (signal.aborted) {
          throw new DomainError('OPERATION_ABORTED');
        }
        return Object.freeze([parsed[0]]);
      }

      // csv_metadata is unavailable for multi-sheet CSV
      throw new DomainError('FORMAT_UNSUPPORTED');
    }
  }

  if (format === 'xlsx') {
    // Exactly 2 artifacts: primary XLSX workbook + companion metadata JSON in that order
    if (parsed.length !== 2) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    const xlsxFilename = formatWorkbookArtifactFilename(validatedContext.title, 'xlsx');
    const companionFilename = formatMetadataArtifactFilename(xlsxFilename);

    if (
      parsed[0].filename !== xlsxFilename ||
      parsed[0].mimeType !== XLSX_MIME ||
      parsed[1].filename !== companionFilename ||
      parsed[1].mimeType !== JSON_MIME
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (action === 'export') {
      if (signal.aborted) {
        throw new DomainError('OPERATION_ABORTED');
      }
      // XLSX export returns BOTH primary workbook and companion metadata
      return Object.freeze([parsed[0], parsed[1]]);
    }

    // csv_metadata is not supported for XLSX format
    throw new DomainError('FORMAT_UNSUPPORTED');
  }

  throw new DomainError('FORMAT_UNSUPPORTED');
}
