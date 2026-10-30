import ExcelJS from 'exceljs';
import { zipSync, strToU8 } from 'fflate';

const XLSX_MAX_ROWS = 1048576;
const XLSX_MAX_COLS = 16384;
const XLSX_MAX_CELL_CHARS = 32767;
const XML_INVALID_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
const CSV_DANGEROUS_PREFIX_RE = /^[\s\u0000-\u001F]*[=+\-@]|^[\t\r\n]/;
const WINDOWS_RESERVED_BASENAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

export function colIndexToLetter(c0) {
  let n = c0 + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function coordToA1(r0, c0) {
  return `${colIndexToLetter(c0)}${r0 + 1}`;
}

function truncateUtf16Safe(str, maxUnits) {
  if (str.length <= maxUnits) return str;
  let sliced = str.slice(0, maxUnits);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    sliced = sliced.slice(0, -1);
  }
  return sliced;
}

export function buildNameMappings(sheets) {
  const usedWorksheetLower = new Set();
  const usedFileLower = new Set();
  const mappings = [];

  for (const sheet of sheets) {
    // 1. Worksheet name rules (A§H): replace []:*?/\, trim edge apostrophes, reserve History, max 31 UTF-16 units
    let wsBase = String(sheet.title ?? '')
      .replace(/[\[\]:*?/\\]/g, '_')
      .replace(/[\u0000-\u001F]/g, ' ')
      .replace(/^'+|'+$/g, '')
      .trim();

    if (!wsBase || wsBase.toLowerCase() === 'history') {
      wsBase = wsBase ? `Sheet_${wsBase}` : `Sheet_${sheet.id}`;
    }
    wsBase = truncateUtf16Safe(wsBase, 31).replace(/'+$/g, '');
    if (!wsBase) wsBase = `Sheet_${sheet.id}`;

    let wsCandidate = wsBase;
    let suffixNum = 2;
    while (usedWorksheetLower.has(wsCandidate.toLowerCase())) {
      const suffix = `~${suffixNum}`;
      const prefix = truncateUtf16Safe(wsBase, 31 - suffix.length).replace(/'+$/g, '');
      wsCandidate = `${prefix || 'Sheet'}${suffix}`;
      suffixNum++;
    }
    usedWorksheetLower.add(wsCandidate.toLowerCase());

    // 2. CSV file basename rules (A§H)
    let fileBase = String(sheet.title ?? '')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim();
    if (!fileBase || WINDOWS_RESERVED_BASENAMES.has(fileBase.toUpperCase())) {
      fileBase = `Sheet_${sheet.id}${fileBase ? '_' + fileBase : ''}`;
    }
    fileBase = truncateUtf16Safe(fileBase, 80);
    let fileCandidate = `${fileBase}.csv`;
    if (usedFileLower.has(fileCandidate.toLowerCase())) {
      fileCandidate = `${truncateUtf16Safe(fileBase, 68)}_${sheet.id}.csv`;
    }
    let fileAttempt = 2;
    while (usedFileLower.has(fileCandidate.toLowerCase())) {
      fileCandidate = `${truncateUtf16Safe(fileBase, 64)}_${sheet.id}_${fileAttempt}.csv`;
      fileAttempt++;
    }
    usedFileLower.add(fileCandidate.toLowerCase());

    mappings.push({
      sheetId: sheet.id,
      index: sheet.index,
      originalTitle: sheet.title,
      worksheetName: wsCandidate,
      csvFileName: fileCandidate
    });
  }

  return mappings;
}

export function validateXlsxRepresentability(sheet, cell) {
  if (cell.r < 0 || cell.r >= XLSX_MAX_ROWS || cell.c < 0 || cell.c >= XLSX_MAX_COLS) {
    throw new Error(
      `XLSX_LIMIT_DIMENSIONS: Cell (${cell.r}, ${cell.c}) in sheet "${sheet.title}" exceeds XLSX bounds (${XLSX_MAX_ROWS}x${XLSX_MAX_COLS}). Use JSON export.`
    );
  }
  if (cell.kind === 'string') {
    const str = String(cell.value);
    if (str.length > XLSX_MAX_CELL_CHARS) {
      throw new Error(
        `XLSX_LIMIT_STRING_LENGTH: Cell (${cell.r}, ${cell.c}) has length ${str.length} > ${XLSX_MAX_CELL_CHARS}. Use JSON export.`
      );
    }
    if (XML_INVALID_CONTROL_RE.test(str)) {
      throw new Error(
        `XLSX_INVALID_XML_CHAR: Cell (${cell.r}, ${cell.c}) contains XML-invalid control characters. Use JSON export.`
      );
    }
  } else if (cell.kind === 'number') {
    if (typeof cell.value !== 'number' || !Number.isFinite(cell.value)) {
      throw new Error(`XLSX_INVALID_NUMBER: Cell (${cell.r}, ${cell.c}) has non-finite number.`);
    }
  }
}

export async function writeXlsxArtifact(fixture) {
  const t0 = performance.now();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Google Sheets Exporter';
  workbook.created = new Date(fixture.producedAt);
  workbook.modified = new Date(fixture.producedAt);

  const mappings = buildNameMappings(fixture.sheets);
  const mapById = new Map(mappings.map(m => [m.sheetId, m]));

  for (const sheet of fixture.sheets) {
    const mapping = mapById.get(sheet.id);
    const ws = workbook.addWorksheet(mapping.worksheetName);

    for (const cell of sheet.cells) {
      validateXlsxRepresentability(sheet, cell);
      // 1-based absolute coordinates in ExcelJS
      const excelCell = ws.getRow(cell.r + 1).getCell(cell.c + 1);
      if (cell.kind === 'string') {
        // Always assign raw JS string; never formula or hyperlink object
        excelCell.value = String(cell.value);
      } else if (cell.kind === 'number') {
        excelCell.value = cell.value;
      } else if (cell.kind === 'boolean') {
        excelCell.value = Boolean(cell.value);
      } else if (cell.kind === 'error') {
        // A§F: CSV/XLSX inert error text
        excelCell.value = String(cell.value.code);
      } else {
        throw new Error(`Unsupported cell kind: ${cell.kind}`);
      }
    }
  }

  const rawBuffer = await workbook.xlsx.writeBuffer();
  const uint8 = rawBuffer instanceof Uint8Array ? rawBuffer : new Uint8Array(rawBuffer);
  const elapsedMs = performance.now() - t0;

  return {
    xlsxBytes: uint8,
    nameMappings: mappings,
    elapsedMs
  };
}

export function sanitizeCsvTextValue(rawText) {
  if (CSV_DANGEROUS_PREFIX_RE.test(rawText)) {
    return { text: `'${rawText}`, transformed: true };
  }
  return { text: rawText, transformed: false };
}

function quoteCsvField(text) {
  return `"${String(text).replace(/"/g, '""')}"`;
}

export function encodeSheetCsv(sheet) {
  const { r0, c0, r1, c1 } = sheet.scope;
  const rowCount = r1 - r0;
  const colCount = c1 - c0;

  const byRow = new Map();
  for (const cell of sheet.cells) {
    if (cell.r < r0 || cell.r >= r1 || cell.c < c0 || cell.c >= c1) {
      throw new Error(`Cell (${cell.r}, ${cell.c}) outside scope [${r0},${c0})..[${r1},${c1})`);
    }
    let rowMap = byRow.get(cell.r);
    if (!rowMap) {
      rowMap = new Map();
      byRow.set(cell.r, rowMap);
    }
    rowMap.set(cell.c, cell);
  }

  const emptyField = '""';
  const blankRowLine = Array.from({ length: colCount }, () => emptyField).join(',');
  const lines = new Array(rowCount);
  let transformedCells = 0;

  for (let r = r0; r < r1; r++) {
    const rowMap = byRow.get(r);
    if (!rowMap) {
      lines[r - r0] = blankRowLine;
      continue;
    }
    const fields = new Array(colCount);
    for (let c = c0; c < c1; c++) {
      const cell = rowMap.get(c);
      if (!cell) {
        fields[c - c0] = emptyField;
        continue;
      }
      if (cell.kind === 'number') {
        // Numeric negatives stay unmodified
        fields[c - c0] = quoteCsvField(String(cell.value));
      } else if (cell.kind === 'boolean') {
        fields[c - c0] = quoteCsvField(cell.value ? 'TRUE' : 'FALSE');
      } else if (cell.kind === 'error') {
        const res = sanitizeCsvTextValue(String(cell.value.code));
        if (res.transformed) transformedCells++;
        fields[c - c0] = quoteCsvField(res.text);
      } else if (cell.kind === 'string') {
        const res = sanitizeCsvTextValue(String(cell.value));
        if (res.transformed) transformedCells++;
        fields[c - c0] = quoteCsvField(res.text);
      }
    }
    lines[r - r0] = fields.join(',');
  }

  // UTF-8 BOM + CRLF record endings
  const csvContent = '\uFEFF' + lines.join('\r\n') + '\r\n';
  return {
    csvContent,
    csvBytes: strToU8(csvContent),
    transformedCells,
    rowCount,
    colCount
  };
}

export function writeCsvZipArtifact(fixture) {
  const t0 = performance.now();
  const mappings = buildNameMappings(fixture.sheets);
  const mapById = new Map(mappings.map(m => [m.sheetId, m]));
  const zipEntries = {};
  const transformCountsBySheet = [];
  let totalTransformed = 0;
  let totalUncompressedBytes = 0;

  for (const sheet of fixture.sheets) {
    const mapping = mapById.get(sheet.id);
    const encoded = encodeSheetCsv(sheet);
    zipEntries[mapping.csvFileName] = encoded.csvBytes;
    totalUncompressedBytes += encoded.csvBytes.byteLength;
    totalTransformed += encoded.transformedCells;
    transformCountsBySheet.push({
      sheetId: sheet.id,
      csvFileName: mapping.csvFileName,
      transformedCells: encoded.transformedCells
    });
  }

  const manifest = {
    schemaVersion: '1.0',
    source: fixture.source,
    export: {
      startedAt: fixture.startedAt,
      producedAt: fixture.producedAt,
      mode: fixture.mode,
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: totalTransformed > 0
        ? [{
            code: 'CSV_FORMULA_PREFIXED',
            message: `${totalTransformed} string cell(s) starting with formula-trigger characters were prefixed with an apostrophe.`
          }]
        : []
    },
    limitsVersion: fixture.limitsVersion,
    nameMappings: mappings,
    exportedScopes: fixture.sheets.map(s => ({
      sheetId: s.id,
      originalTitle: s.title,
      origin: coordToA1(s.scope.r0, s.scope.c0),
      scope: s.scope,
      exclusions: s.exclusions
    })),
    csvTransformCounts: {
      totalTransformedCells: totalTransformed,
      bySheet: transformCountsBySheet
    }
  };

  const manifestBytes = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  zipEntries['manifest.json'] = manifestBytes;
  totalUncompressedBytes += manifestBytes.byteLength;

  const zipBytes = zipSync(zipEntries, { level: 6 });
  const elapsedMs = performance.now() - t0;

  return {
    zipBytes,
    manifest,
    totalUncompressedBytes,
    elapsedMs
  };
}
