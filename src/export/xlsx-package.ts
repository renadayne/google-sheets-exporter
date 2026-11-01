/**
 * T29c Bounded XLSX and Companion Metadata Packaging
 * Pure packaging function coordinating buildCompleteExportReport, encodeFrozenJson,
 * and encodeXlsx into frozen primary and companion artifacts.
 * Preconditions:
 * - context is a validated frozen snapshot (e.g. from snapshotWriterContext)
 * - prepared is the real prepareWriterData result for the SAME context
 * - context.format must be 'xlsx'
 */

import type { Artifact, ExportReport } from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, isErrorCode, type ErrorCode } from '../contracts/errors.ts';
import type { PreparedSheet } from './prepare.ts';
import {
  encodeXlsx,
  type EncodeXlsxResult,
  PROVISIONAL_MAX_XLSX_BYTES,
  PROVISIONAL_MAX_XLSX_CELLS,
  PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS
} from './xlsx.ts';
import { buildCompleteExportReport, PROVISIONAL_MAX_WARNINGS } from './report.ts';
import { encodeFrozenJson } from './json-encoding.ts';
import { formatWorkbookArtifactFilename, formatMetadataArtifactFilename } from './names.ts';

export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const JSON_MIME_TYPE = 'application/json';
export const XLSX_PRIMARY_SAFE_SUMMARY = 'XLSX export workbook';
export const XLSX_COMPANION_SAFE_SUMMARY = 'Export metadata report';

export interface PackageXlsxOptions {
  /** Sum of the two artifact byte lengths; not an inflated XML or memory bound. */
  readonly maxBytes: number;
  readonly maxCells: number;
  readonly maxInputTextUnits: number;
  readonly maxWarnings: number;
  readonly signal: AbortSignal;
}

function isSafeNonNegInt(val: unknown, max: number): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && val <= max && !Object.is(val, -0);
}

function isAbortSignal(val: unknown): val is AbortSignal {
  return (
    !!val &&
    typeof val === 'object' &&
    typeof (val as AbortSignal).aborted === 'boolean' &&
    typeof (val as any).addEventListener === 'function' &&
    typeof (val as any).removeEventListener === 'function'
  );
}

async function packageXlsxInternal(
  context: WriterContext,
  prepared: readonly PreparedSheet[],
  report: ExportReport,
  options: PackageXlsxOptions
): Promise<readonly Artifact[]> {
  let boundReport: ExportReport | null = null;
  let metadataBytes: Uint8Array | null = null;
  let xlsxResult: EncodeXlsxResult | null = null;
  let primaryArtifact: Artifact | null = null;
  let companionArtifact: Artifact | null = null;

  try {
    // 0. Options capture and single-read
    let maxBytes: number;
    let maxCells: number;
    let maxInputTextUnits: number;
    let maxWarnings: number;
    let signal: AbortSignal;

    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new DomainError('CONFIG_INVALID');
      }
      const {
        maxBytes: b,
        maxCells: c,
        maxInputTextUnits: u,
        maxWarnings: w,
        signal: s
      } = options;

      if (
        !isSafeNonNegInt(b, PROVISIONAL_MAX_XLSX_BYTES) ||
        !isSafeNonNegInt(c, PROVISIONAL_MAX_XLSX_CELLS) ||
        !isSafeNonNegInt(u, PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS) ||
        !isSafeNonNegInt(w, PROVISIONAL_MAX_WARNINGS) ||
        !isAbortSignal(s)
      ) {
        throw new DomainError('CONFIG_INVALID');
      }

      maxBytes = b;
      maxCells = c;
      maxInputTextUnits = u;
      maxWarnings = w;
      signal = s;
    } catch {
      throw new DomainError('CONFIG_INVALID');
    }

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    // Preconditions: context validated frozen snapshot and format must be 'xlsx'
    if (!context || typeof context !== 'object' || context.format !== 'xlsx') {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    // 1. Bind metadata via buildCompleteExportReport FIRST; rejects bad format/scopes/mapping/knownchange before library serialization
    boundReport = buildCompleteExportReport(context, prepared, report, {
      maxWarnings,
      signal
    });

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    // 2. Encode verified frozen metadata using encodeFrozenJson with byte budget
    metadataBytes = encodeFrozenJson(boundReport, {
      maxBytes,
      signal
    });

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    // 3. Compute remaining byte budget for XLSX
    const remainingBytes = maxBytes - metadataBytes.byteLength;
    if (remainingBytes <= 0) {
      throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }

    // 4. Encode XLSX workbook with remaining byte budget
    xlsxResult = await encodeXlsx(prepared, {
      maxBytes: remainingBytes,
      maxCells,
      maxInputTextUnits,
      signal
    });

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    // Exact aggregate byte check: sum of returned XLSX bytes + companion JSON bytes
    if (xlsxResult.bytes.byteLength + metadataBytes.byteLength > maxBytes) {
      throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }

    // 5. Compare actual XLSX result mappings field-by-field/order to bound report mappings
    if (
      !Array.isArray(xlsxResult.nameMappings) ||
      !Array.isArray(boundReport.nameMappings) ||
      xlsxResult.nameMappings.length !== boundReport.nameMappings.length
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    for (let i = 0; i < xlsxResult.nameMappings.length; i++) {
      const actual = xlsxResult.nameMappings[i];
      const expected = boundReport.nameMappings[i];
      if (
        !actual ||
        !expected ||
        actual.sheetId !== expected.sheetId ||
        actual.originalTitle !== expected.originalTitle ||
        actual.exportedName !== expected.exportedName
      ) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
    }

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    // 6. Format filenames and construct frozen artifacts with fresh owned Uint8Array buffers
    const primaryFilename = formatWorkbookArtifactFilename(context.title, 'xlsx');
    const companionFilename = formatMetadataArtifactFilename(primaryFilename);

    // Both reviewed encoders already return fresh owned buffers. Transfer their
    // ownership into these private descriptors without duplicating whole files.
    primaryArtifact = Object.freeze({
      filename: primaryFilename,
      mimeType: XLSX_MIME_TYPE,
      data: xlsxResult.bytes,
      byteLength: xlsxResult.bytes.byteLength,
      safeSummary: XLSX_PRIMARY_SAFE_SUMMARY
    });

    companionArtifact = Object.freeze({
      filename: companionFilename,
      mimeType: JSON_MIME_TYPE,
      data: metadataBytes,
      byteLength: metadataBytes.byteLength,
      safeSummary: XLSX_COMPANION_SAFE_SUMMARY
    });

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    return Object.freeze([primaryArtifact, companionArtifact]);
  } finally {
    boundReport = null;
    metadataBytes = null;
    xlsxResult = null;
    primaryArtifact = null;
    companionArtifact = null;
  }
}

export async function packageXlsx(
  context: WriterContext,
  prepared: readonly PreparedSheet[],
  report: ExportReport,
  options: PackageXlsxOptions
): Promise<readonly Artifact[]> {
  let localContext: WriterContext | null = context;
  let localPrepared: readonly PreparedSheet[] | null = prepared;
  let localReport: ExportReport | null = report;
  let localOptions: PackageXlsxOptions | null = options;

  try {
    return await packageXlsxInternal(localContext, localPrepared, localReport, localOptions);
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
  } finally {
    localContext = null;
    localPrepared = null;
    localReport = null;
    localOptions = null;
  }
}
