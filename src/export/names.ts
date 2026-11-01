/**
 * T25 Deterministic Filename and Worksheet Name Mapping
 * Pure mapping functions conforming to reviewed SheetNameMapping contract.
 * Preserves source order, source titles, and emits collision-free names.
 */

import type { SheetNameMapping } from '../contracts/domain.ts';
import { DomainError } from '../contracts/errors.ts';

export type NameMapping = SheetNameMapping;

export interface SheetInput {
  readonly id: number;
  readonly title: string;
}

export type AllowedWorkbookExtension = 'json' | 'csv' | 'xlsx' | 'zip';

const UTF8_ENCODER = new TextEncoder();
const MAX_WORKSHEET_UTF16_UNITS = 31;
const MAX_CSV_FILENAME_UTF8_BYTES = 120;
const CSV_EXTENSION = '.csv';

const EXCEL_FORBIDDEN_CHARS = /[\[\]:*?/\\]|[\u0000-\u001F\u007F-\u009F\uFFFE\uFFFF]/g;
const WINDOWS_FORBIDDEN_CHARS = /[<>:"/\\|?*]|[\u0000-\u001F\u007F-\u009F]/g;
const WINDOWS_RESERVED_STEM =
  /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])($|\..*)/i;

/** Replaces unpaired/lone UTF-16 surrogates with Unicode replacement char U+FFFD. */
function replaceLoneSurrogates(s: string): string {
  const candidate = s as unknown as { toWellFormed?: () => string };
  if (typeof candidate.toWellFormed === 'function') {
    return candidate.toWellFormed();
  }
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/** Trims leading and trailing whitespace and single quote apostrophes. */
function trimApostrophesAndWhitespace(s: string): string {
  return s.replace(/^[\s']+|[\s']+$/g, '');
}

/** Canonical NFC lower-case key for collision detection. */
function normalizeKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/** Checks whether a stem or filename matches Windows reserved devices. */
function isWindowsReserved(name: string): boolean {
  return WINDOWS_RESERVED_STEM.test(name);
}

/** Truncates string to max UTF-16 units without splitting surrogate pairs and re-trims apostrophes. */
function truncateWorksheetStem(s: string, maxUnits: number): string {
  if (s.length <= maxUnits) {
    return trimApostrophesAndWhitespace(s);
  }
  let cut = maxUnits;
  const lastCode = s.charCodeAt(cut - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut -= 1;
  }
  return trimApostrophesAndWhitespace(s.slice(0, cut));
}

/** Truncates string to max UTF-8 bytes by whole Unicode code points and trims trailing dots/spaces. */
function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let out = '';
  let bytes = 0;
  for (const cp of s) {
    const cpBytes = UTF8_ENCODER.encode(cp).length;
    if (bytes + cpBytes > maxBytes) break;
    out += cp;
    bytes += cpBytes;
  }
  return out.replace(/[. ]+$/g, '');
}

/** Validates ordered sheets input array and its records. */
function validateOrderedSheets(orderedSheets: readonly SheetInput[]): void {
  if (!Array.isArray(orderedSheets) || orderedSheets.length === 0) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  const seenIds = new Set<number>();
  for (const sheet of orderedSheets) {
    if (
      !sheet ||
      typeof sheet.id !== 'number' ||
      !Number.isSafeInteger(sheet.id) ||
      sheet.id < 0 ||
      typeof sheet.title !== 'string'
    ) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    if (seenIds.has(sheet.id)) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    seenIds.add(sheet.id);
  }
}

/**
 * Pure mapping of Google Sheet titles to valid Excel worksheet names.
 * Replaces []:*?/\\, XML controls, and XML-invalid noncharacters (U+FFFE, U+FFFF) with _,
 * trims edge apostrophes/whitespace, caps at 31 UTF-16 units, avoids 'History',
 * and disambiguates collisions with ~2/~3.
 */
export function mapWorksheetNames(orderedSheets: readonly SheetInput[]): readonly SheetNameMapping[] {
  validateOrderedSheets(orderedSheets);
  const usedKeys = new Set<string>();
  const mappings: SheetNameMapping[] = [];

  for (const sheet of orderedSheets) {
    const cleanRaw = replaceLoneSurrogates(sheet.title).replace(EXCEL_FORBIDDEN_CHARS, '_');
    const sanitized = cleanRaw.replace(/_(?=[xX][0-9a-fA-F]{4}_)/g, '-');
    const initialBase = trimApostrophesAndWhitespace(sanitized) || `Sheet_${sheet.id}`;

    let exportedName = '';
    for (let step = 0; ; step++) {
      const suffix = step === 0 ? '' : `~${step + 1}`;
      const allowed = MAX_WORKSHEET_UTF16_UNITS - suffix.length;
      let base = truncateWorksheetStem(initialBase, allowed);
      if (!base) base = truncateWorksheetStem(`Sheet_${sheet.id}`, allowed) || 'Sheet';
      const candidate = `${base}${suffix}`;
      const key = normalizeKey(candidate);
      if (key !== 'history' && !usedKeys.has(key)) {
        usedKeys.add(key);
        exportedName = candidate;
        break;
      }
    }

    mappings.push({ sheetId: sheet.id, originalTitle: sheet.title, exportedName });
  }

  return Object.freeze(mappings);
}

/**
 * Pure mapping of Google Sheet titles to portable single-component CSV filenames.
 * Appends .csv once, sanitizes invalid Windows/path/control chars, prefixes reserved stems
 * with '_' before truncation/suffix generation to prevent reserved devices (e.g. _CON.csv,
 * _con.txt.csv), enforces max 120 UTF-8 bytes, and disambiguates collisions via stable
 * sheetId suffix.
 */
export function mapCsvFilenames(orderedSheets: readonly SheetInput[]): readonly SheetNameMapping[] {
  validateOrderedSheets(orderedSheets);
  const usedKeys = new Set<string>();
  const mappings: SheetNameMapping[] = [];
  const extBytes = UTF8_ENCODER.encode(CSV_EXTENSION).length;

  for (const sheet of orderedSheets) {
    const cleanRaw = replaceLoneSurrogates(sheet.title)
      .replace(WINDOWS_FORBIDDEN_CHARS, '_')
      .replace(/[. ]+$/g, '');
    let initialBase = (!cleanRaw || cleanRaw === '.' || cleanRaw === '..') ? `Sheet_${sheet.id}` : cleanRaw;
    if (isWindowsReserved(initialBase)) {
      initialBase = `_${initialBase}`;
    }

    let exportedName = '';
    for (let step = 0; ; step++) {
      const suffix = step === 0 ? '' : step === 1 ? `_${sheet.id}` : `_${sheet.id}_${step}`;
      const allowed = MAX_CSV_FILENAME_UTF8_BYTES - extBytes - UTF8_ENCODER.encode(suffix).length;
      let base = truncateUtf8(initialBase, allowed);
      if (!base) base = step === 0 ? `Sheet_${sheet.id}` : 'Sheet';
      if (isWindowsReserved(base)) {
        base = `_${truncateUtf8(base, Math.max(0, allowed - 1))}`;
        if (!base || base === '_') base = step === 0 ? `Sheet_${sheet.id}` : 'Sheet';
      }
      let stem = `${base}${suffix}`;
      if (isWindowsReserved(stem)) {
        stem = `_${stem}`;
      }
      const candidate = `${stem}${CSV_EXTENSION}`;
      const key = normalizeKey(candidate);
      if (!usedKeys.has(key)) {
        usedKeys.add(key);
        exportedName = candidate;
        break;
      }
    }

    mappings.push({ sheetId: sheet.id, originalTitle: sheet.title, exportedName });
  }

  return Object.freeze(mappings);
}

/**
 * Formats a safe workbook artifact filename for json, csv, xlsx, or zip.
 * Enforces runtime enum check, portable filename rules, prefixes reserved stems
 * with '_' before truncation (e.g. _CON.zip, _CON.txt.zip), and caps at 120 UTF-8 bytes.
 */
export function formatWorkbookArtifactFilename(
  workbookTitle: string,
  extension: AllowedWorkbookExtension
): string {
  const ALLOWED: ReadonlySet<string> = new Set(['json', 'csv', 'xlsx', 'zip']);
  if (!ALLOWED.has(extension)) {
    throw new DomainError('FORMAT_UNSUPPORTED');
  }
  if (typeof workbookTitle !== 'string') {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  let clean = replaceLoneSurrogates(workbookTitle)
    .replace(WINDOWS_FORBIDDEN_CHARS, '_')
    .replace(/[. ]+$/g, '');
  if (!clean || clean === '.' || clean === '..') {
    clean = 'Workbook';
  }

  if (isWindowsReserved(clean)) {
    clean = `_${clean}`;
  }

  const ext = `.${extension}`;
  const maxStemBytes = MAX_CSV_FILENAME_UTF8_BYTES - UTF8_ENCODER.encode(ext).length;
  let stem = truncateUtf8(clean, maxStemBytes);
  if (!stem) stem = 'Workbook';

  if (isWindowsReserved(stem)) {
    stem = `_${truncateUtf8(stem, Math.max(0, maxStemBytes - 1))}`;
    if (!stem || stem === '_') stem = 'Workbook';
  }

  return `${stem}${ext}`;
}

/**
 * Formats companion metadata artifact filename (<stem>.metadata.json) for a safe primary (.xlsx/.csv).
 * Preserves complete 14-byte '.metadata.json' suffix under the 120-byte portable cap.
 * Long companion stems may shorten at Unicode boundaries to fit; source mappings remain unaffected.
 */
export function formatMetadataArtifactFilename(primaryFilename: string): string {
  if (typeof primaryFilename !== 'string' || primaryFilename.length > MAX_CSV_FILENAME_UTF8_BYTES) {
    throw new DomainError('FORMAT_UNSUPPORTED');
  }
  let ext: AllowedWorkbookExtension;
  let stem: string;
  if (primaryFilename.endsWith('.xlsx')) {
    ext = 'xlsx';
    stem = primaryFilename.slice(0, -5);
  } else if (primaryFilename.endsWith('.csv')) {
    ext = 'csv';
    stem = primaryFilename.slice(0, -4);
  } else {
    throw new DomainError('FORMAT_UNSUPPORTED');
  }
  if (!stem || formatWorkbookArtifactFilename(stem, ext) !== primaryFilename) {
    throw new DomainError('FORMAT_UNSUPPORTED');
  }
  const companionStem = truncateUtf8(stem, MAX_CSV_FILENAME_UTF8_BYTES - 14);
  return formatWorkbookArtifactFilename(`${companionStem}.metadata`, 'json');
}
