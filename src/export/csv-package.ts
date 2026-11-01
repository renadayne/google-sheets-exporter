/**
 * T27c2 Bounded CSV Artifact Assembly
 *
 * Packages prepared CSV sheets and validated report metadata into staged Artifact descriptors:
 * - Single-sheet: returns [primary CSV artifact, optional companion metadata artifact].
 *   IMPORTANT: The second artifact (companion metadata JSON) MUST be exposed to the user
 *   ONLY by an explicit metadata action; the default user export is exactly one .csv file,
 *   never automatically two downloads. This packaging helper stages private artifacts and
 *   never publishes; the readonly Artifact[] contract is preserved, allowing the future
 *   controller to select the published subset based on user request options.
 *   The primary CSV artifact filename is derived from the actual sheet title (e.g. 'Sheet1.csv')
 *   matching report exportedName, NOT the workbook title.
 * - Multi-sheet (2+): returns a single [ZIP artifact] containing one CSV per sheet in source
 *   order plus 'manifest.json' as the final entry. The ZIP filename is derived from the
 *   workbook title (e.g. 'Workbook.zip').
 *
 * Preconditions:
 * - `context` must be a validated frozen snapshot (e.g. from `snapshotWriterContext`) with `format: 'csv'`.
 * - `prepared` must be real `prepareWriterData` result for the SAME context.
 * - Does NOT verify an acquisition ledger or authorize publication/download.
 */

import type { Artifact, ExportReport } from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, isErrorCode, type ErrorCode } from '../contracts/errors.ts';
import { encodeCsvSheets } from './csv-sheets.ts';
import {
  encodeCsvZip,
  PROVISIONAL_MAX_CSV_ZIP_BYTES,
  PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
} from './csv-zip.ts';
import { buildCompleteExportReport, PROVISIONAL_MAX_WARNINGS } from './report.ts';
import { encodeFrozenJson } from './json-encoding.ts';
import { formatWorkbookArtifactFilename, formatMetadataArtifactFilename } from './names.ts';
import type { PreparedSheet } from './prepare.ts';

const FORBIDDEN_CONTEXT_KEYS = [
  'principalKey',
  'displayEmail',
  'accessToken',
  'refreshToken',
  'token',
  'account',
  'authorization',
  'headers',
] as const;

export interface PackageCsvOptions {
  readonly maxUncompressedBytes: number;
  readonly maxBytes: number;
  readonly maxWarnings: number;
  readonly signal: AbortSignal;
}

function captureAndValidateOptions(options: PackageCsvOptions): {
  maxUncompressedBytes: number;
  maxBytes: number;
  maxWarnings: number;
  signal: AbortSignal;
} {
  let mub: number;
  let mb: number;
  let mw: number;
  let sig: AbortSignal;
  let initiallyAborted = false;
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new DomainError('CONFIG_INVALID');
    }
    mub = options.maxUncompressedBytes;
    mb = options.maxBytes;
    mw = options.maxWarnings;
    sig = options.signal;
    if (
      typeof mub !== 'number' ||
      !Number.isSafeInteger(mub) ||
      mub < 0 ||
      Object.is(mub, -0) ||
      mub > PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES ||
      typeof mb !== 'number' ||
      !Number.isSafeInteger(mb) ||
      mb < 0 ||
      Object.is(mb, -0) ||
      mb > PROVISIONAL_MAX_CSV_ZIP_BYTES ||
      typeof mw !== 'number' ||
      !Number.isSafeInteger(mw) ||
      mw < 0 ||
      Object.is(mw, -0) ||
      mw > PROVISIONAL_MAX_WARNINGS ||
      !sig ||
      typeof sig !== 'object' ||
      typeof (sig as any).addEventListener !== 'function' ||
      typeof (sig as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    const aborted = sig.aborted;
    if (typeof aborted !== 'boolean') throw new DomainError('CONFIG_INVALID');
    initiallyAborted = aborted;
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }
  if (initiallyAborted) throw new DomainError('OPERATION_ABORTED');

  return {
    maxUncompressedBytes: mub,
    maxBytes: mb,
    maxWarnings: mw,
    signal: sig,
  };
}

function packageCsvInternal(
  context: WriterContext,
  prepared: readonly PreparedSheet[],
  report: ExportReport,
  options: PackageCsvOptions
): readonly Artifact[] {
  const { maxUncompressedBytes, maxBytes, maxWarnings, signal } = captureAndValidateOptions(options);

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // Defensive precondition validations
  if (!context || typeof context !== 'object' || !Object.isFrozen(context)) {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  for (const k of FORBIDDEN_CONTEXT_KEYS) {
    if (k in context && (context as any)[k] !== undefined) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
  }

  if (context.format !== 'csv') {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (!Array.isArray(prepared) || prepared.length === 0 || !Object.isFrozen(prepared)) {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (!report || typeof report !== 'object') {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // 1. Encode CSV sheets first using maxUncompressedBytes to determine actual counts
  const csvResult = encodeCsvSheets(prepared, { maxBytes: maxUncompressedBytes, signal });

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // 2. Validate and build complete report with ACTUAL transform counts
  // Bad report or concurrent modifications reject BEFORE any ZIP encoding
  const verifiedReport = buildCompleteExportReport(context, prepared, report, {
    maxWarnings,
    signal,
    csvTransformCounts: csvResult.csvTransformCounts,
  });

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // 3. Compare actual encoder name mappings to verified report mappings exact fields and order
  if (csvResult.nameMappings.length !== verifiedReport.nameMappings.length) {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
  for (let i = 0; i < csvResult.nameMappings.length; i++) {
    const enc = csvResult.nameMappings[i];
    const rep = verifiedReport.nameMappings[i];
    if (
      !enc ||
      !rep ||
      enc.sheetId !== rep.sheetId ||
      enc.originalTitle !== rep.originalTitle ||
      enc.exportedName !== rep.exportedName
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
  }

  // Defensive alignment check between csvResult.sheets and csvResult.nameMappings
  if (csvResult.sheets.length !== csvResult.nameMappings.length) {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
  for (let i = 0; i < csvResult.sheets.length; i++) {
    const s = csvResult.sheets[i];
    const m = csvResult.nameMappings[i];
    if (!s || s.sheetId !== m.sheetId || s.filename !== m.exportedName) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
  }

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // 4. Encode verified frozen metadata via encodeFrozenJson using remaining uncompressed budget
  const remainingUncompressedBytes = maxUncompressedBytes - csvResult.totalByteLength;
  if (!Number.isSafeInteger(remainingUncompressedBytes) || remainingUncompressedBytes < 0) {
    throw new DomainError('BYTE_LIMIT_EXCEEDED');
  }

  const metadataBytes = encodeFrozenJson(verifiedReport, {
    maxBytes: remainingUncompressedBytes,
    signal,
  });

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // Aggregate uncompressed bytecounts exact
  const totalUncompressedBytes = csvResult.totalByteLength + metadataBytes.byteLength;
  if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > maxUncompressedBytes) {
    throw new DomainError('BYTE_LIMIT_EXCEEDED');
  }

  // 5. Branch based on sheet count
  if (csvResult.sheets.length === 1) {
    const csvSheet = csvResult.sheets[0];
    const primaryFilename = csvSheet.filename;
    const companionFilename = formatMetadataArtifactFilename(primaryFilename);

    // Single branch must check maxBytes against SUM of CSV + optional metadata staged bytes
    const totalStagedBytes = csvSheet.bytes.byteLength + metadataBytes.byteLength;
    if (
      !Number.isSafeInteger(totalStagedBytes) ||
      totalStagedBytes > maxBytes ||
      totalStagedBytes > maxUncompressedBytes
    ) {
      throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }

    // Both reviewed encoders already own their output buffers. Stage those
    // buffers directly without duplicating the entire files.

    const csvArtifact: Artifact = Object.freeze({
      filename: primaryFilename,
      mimeType: 'text/csv',
      data: csvSheet.bytes,
      byteLength: csvSheet.bytes.byteLength,
      safeSummary: 'CSV sheet export',
    });

    const metadataArtifact: Artifact = Object.freeze({
      filename: companionFilename,
      mimeType: 'application/json',
      data: metadataBytes,
      byteLength: metadataBytes.byteLength,
      safeSummary: 'CSV export companion metadata',
    });

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    return Object.freeze([csvArtifact, metadataArtifact]);
  } else {
    // Multi-tab branch: 2+ sheets -> ZIP artifact
    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    const zipBytes = encodeCsvZip(csvResult.sheets, metadataBytes, {
      maxUncompressedBytes,
      maxBytes,
      signal,
    });

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    const zipFilename = formatWorkbookArtifactFilename(context.title, 'zip');

    const zipArtifact: Artifact = Object.freeze({
      filename: zipFilename,
      mimeType: 'application/zip',
      data: zipBytes,
      byteLength: zipBytes.byteLength,
      safeSummary: 'CSV ZIP export archive',
    });

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    return Object.freeze([zipArtifact]);
  }
}

export function packageCsv(
  context: WriterContext,
  prepared: readonly PreparedSheet[],
  report: ExportReport,
  options: PackageCsvOptions
): readonly Artifact[] {
  try {
    return packageCsvInternal(context, prepared, report, options);
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
      // Hostile err getters must not escape
    }
    if (trustedCode !== undefined) {
      throw new DomainError(trustedCode);
    }
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
