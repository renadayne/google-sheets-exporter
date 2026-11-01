import { zipSync } from 'fflate';
import { DomainError, isErrorCode, type ErrorCode } from '../contracts/errors.ts';
import type { CsvSheetBytes } from './csv-sheets.ts';
import { formatWorkbookArtifactFilename } from './names.ts';

export const PROVISIONAL_MAX_CSV_ZIP_BYTES = 128 * 1024 * 1024; // 128 MiB
export const PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES = 64 * 1024 * 1024; // 64 MiB
const MIN_CSV_SHEET_RECORDS = 2;
const MAX_CSV_SHEET_RECORDS = 4096;
const FIXED_DOS_DATE = new Date(1980, 0, 1, 0, 0, 0);

export interface EncodeCsvZipOptions {
  readonly maxUncompressedBytes: number;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

interface CapturedSheet {
  readonly sheetId: number;
  readonly filename: string;
  readonly bytes: Uint8Array;
}

function isCanonicalCsvFilename(filename: string): boolean {
  if (typeof filename !== 'string' || !filename.endsWith('.csv')) {
    return false;
  }
  if (filename.length > 120 || filename.includes('/') || filename.includes('\\')) {
    return false;
  }
  const stem = filename.slice(0, -4);
  if (!stem) {
    return false;
  }
  try {
    return formatWorkbookArtifactFilename(stem, 'csv') === filename;
  } catch {
    return false;
  }
}

function captureAndValidateOptions(options: EncodeCsvZipOptions): {
  maxUncompressedBytes: number;
  maxBytes: number;
  signal: AbortSignal;
} {
  let mub: number;
  let mb: number;
  let sig: AbortSignal;
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new DomainError('CONFIG_INVALID');
    }
    mub = options.maxUncompressedBytes;
    mb = options.maxBytes;
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
      !sig ||
      typeof sig !== 'object' ||
      typeof (sig as any).aborted !== 'boolean' ||
      typeof (sig as any).addEventListener !== 'function' ||
      typeof (sig as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (sig.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }
  } catch (err: unknown) {
    if (err instanceof DomainError && err.code === 'OPERATION_ABORTED') {
      throw err;
    }
    throw new DomainError('CONFIG_INVALID');
  }

  return {
    maxUncompressedBytes: mub,
    maxBytes: mb,
    signal: sig,
  };
}

function encodeCsvZipInternal(
  sheets: readonly CsvSheetBytes[],
  manifestBytes: Uint8Array,
  options: EncodeCsvZipOptions
): Uint8Array {
  const { maxUncompressedBytes, maxBytes, signal } = captureAndValidateOptions(options);

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  if (!(manifestBytes instanceof Uint8Array) || manifestBytes.byteLength === 0) {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (!Array.isArray(sheets) || sheets.length < MIN_CSV_SHEET_RECORDS || sheets.length > MAX_CSV_SHEET_RECORDS) {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  const capturedSheets: CapturedSheet[] = [];
  const seenExactFilenames = new Set<string>();
  const seenNormalizedFilenames = new Set<string>();
  const seenSheetIds = new Set<number>();

  for (let i = 0; i < sheets.length; i++) {
    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }
    const sheet = sheets[i];
    if (!sheet || typeof sheet !== 'object') {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    let sheetId: number;
    let filename: string;
    let bytes: Uint8Array;
    try {
      sheetId = sheet.sheetId;
      filename = sheet.filename;
      bytes = sheet.bytes;
    } catch {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (
      typeof sheetId !== 'number' ||
      !Number.isSafeInteger(sheetId) ||
      sheetId < 0 ||
      Object.is(sheetId, -0) ||
      seenSheetIds.has(sheetId)
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    seenSheetIds.add(sheetId);

    if (!(bytes instanceof Uint8Array) || typeof filename !== 'string') {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (!isCanonicalCsvFilename(filename)) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    const exactKey = filename;
    const caseKey = filename.normalize('NFC').toLowerCase();
    if (caseKey === 'manifest.json' || seenExactFilenames.has(exactKey) || seenNormalizedFilenames.has(caseKey)) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    seenExactFilenames.add(exactKey);
    seenNormalizedFilenames.add(caseKey);

    capturedSheets.push({ sheetId, filename, bytes });
  }

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // Aggregate uncompressed bytes BEFORE allocating ZIP dictionary or invoking zipSync
  let totalUncompressedBytes = manifestBytes.byteLength;
  if (!Number.isSafeInteger(totalUncompressedBytes)) {
    throw new DomainError('BYTE_LIMIT_EXCEEDED');
  }
  for (let i = 0; i < capturedSheets.length; i++) {
    const sheetByteLen = capturedSheets[i].bytes.byteLength;
    if (!Number.isSafeInteger(sheetByteLen)) {
      throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }
    totalUncompressedBytes += sheetByteLen;
    if (!Number.isSafeInteger(totalUncompressedBytes)) {
      throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }
  }

  if (totalUncompressedBytes > maxUncompressedBytes) {
    throw new DomainError('BYTE_LIMIT_EXCEEDED');
  }

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  // Construct null-prototype dictionary with entries in source order plus manifest.json last
  const zippable: Record<string, Uint8Array> = Object.create(null);
  for (let i = 0; i < capturedSheets.length; i++) {
    zippable[capturedSheets[i].filename] = capturedSheets[i].bytes;
  }
  zippable['manifest.json'] = manifestBytes;

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  let rawZip: Uint8Array;
  try {
    rawZip = zipSync(zippable, {
      level: 6,
      mtime: FIXED_DOS_DATE,
    });
  } catch {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  if (!(rawZip instanceof Uint8Array) || rawZip.byteLength === 0) {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (
    rawZip.byteLength < 22 ||
    rawZip[0] !== 0x50 ||
    rawZip[1] !== 0x4b ||
    rawZip[2] !== 0x03 ||
    rawZip[3] !== 0x04
  ) {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (rawZip.byteLength > maxBytes) {
    throw new DomainError('BYTE_LIMIT_EXCEEDED');
  }

  let ownedZip: Uint8Array;
  try {
    ownedZip = new Uint8Array(rawZip.byteLength);
    ownedZip.set(rawZip);
  } catch {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  if (signal.aborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  return ownedZip;
}

/**
 * Byte transport only: sheets come from encodeCsvSheets and manifestBytes from
 * the caller's verified report encoding. Does not prove metadata, coverage or
 * permission, and synchronous compression requires worker termination to preempt.
 */
export function encodeCsvZip(
  sheets: readonly CsvSheetBytes[],
  manifestBytes: Uint8Array,
  options: EncodeCsvZipOptions
): Uint8Array {
  try {
    return encodeCsvZipInternal(sheets, manifestBytes, options);
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
