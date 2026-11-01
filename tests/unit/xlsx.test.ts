import { describe, it, expect, vi, afterEach } from 'vitest';
import XLSX from 'xlsx';
import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import ExcelJS from 'exceljs';
import type { Cell, Rect, SheetMeta } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import {
  encodeXlsx,
  PROVISIONAL_MAX_XLSX_BYTES,
  PROVISIONAL_MAX_XLSX_CELLS,
  PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS
} from '../../src/export/xlsx.ts';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';

function createTrackingSignal(realSignal: AbortSignal = new AbortController().signal) {
  let registeredCount = 0;
  let removedCount = 0;
  const proxySignal = new Proxy(realSignal, {
    get(target, prop) {
      if (prop === 'addEventListener') {
        return function(type: string, listener: any, opts: any) {
          if (type === 'abort') registeredCount++;
          return (target as any).addEventListener(type, listener, opts);
        };
      }
      if (prop === 'removeEventListener') {
        return function(type: string, listener: any, opts: any) {
          if (type === 'abort') removedCount++;
          return (target as any).removeEventListener(type, listener, opts);
        };
      }
      return Reflect.get(target, prop, target);
    }
  });
  return {
    signal: proxySignal,
    get registeredCount() { return registeredCount; },
    get removedCount() { return removedCount; }
  };
}

function makeSheetFixture(
  id: number,
  title: string,
  index: number,
  rect: Rect,
  cells: Cell[]
) {
  const meta: SheetMeta = {
    id,
    title,
    index,
    type: 'GRID',
    hidden: false,
    rows: rect.r1,
    columns: rect.c1
  };
  const scope = { sheetId: id, rect };
  const chunk = {
    jobId: 'j1',
    chunkId: `c_${id}`,
    rect,
    cells,
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 64
  };
  return { meta, scope, chunk };
}

function prepareSheetsViaWriter(
  fixtures: ReturnType<typeof makeSheetFixture>[],
  sheetOrder: number[],
  signal: AbortSignal = new AbortController().signal,
  mode: WriterContext['mode'] = 'raw'
) {
  const ctx: WriterContext = {
    sourceId: 'src1',
    title: 'Doc',
    locale: 'en',
    timeZone: 'UTC',
    format: 'xlsx',
    mode,
    visibility: 'include_all',
    limitsVersion: '1.0',
    sheetOrder,
    sheets: fixtures.map(f => f.meta),
    scopes: fixtures.map(f => f.scope)
  };
  const prepOpts = {
    maxChunks: 100,
    maxIntervals: 100,
    maxCells: 100000,
    signal
  };
  return prepareWriterData(ctx, fixtures.map(f => f.chunk), prepOpts);
}

function hasForbiddenXmlNodes(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    return obj.some(hasForbiddenXmlNodes);
  }
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === 'f' ||
      lowerKey.endsWith(':f') ||
      lowerKey === 'hyperlink' ||
      lowerKey === 'hyperlinks' ||
      lowerKey === 'externalreference' ||
      lowerKey === 'externalreferences'
    ) {
      return true;
    }
    if (hasForbiddenXmlNodes(value)) return true;
  }
  return false;
}

function hasExternalRelationships(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    return obj.some(hasExternalRelationships);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === '@_TargetMode' && value === 'External') {
      return true;
    }
    if (hasExternalRelationships(value)) return true;
  }
  return false;
}

function decodeOoxmlString(s: string): string {
  return s.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

describe('T28a encodeXlsx', () => {
  const sampleWb = new ExcelJS.Workbook();
  const XLSXProto = Object.getPrototypeOf(sampleWb.xlsx);
  delete (ExcelJS.Workbook.prototype as any)._xlsx;

  const baseSignal = new AbortController().signal;
  const stdOpts = {
    maxBytes: PROVISIONAL_MAX_XLSX_BYTES,
    maxCells: PROVISIONAL_MAX_XLSX_CELLS,
    maxInputTextUnits: PROVISIONAL_MAX_XLSX_INPUT_TEXT_UNITS,
    signal: baseSignal
  };

  afterEach(() => {
    delete (ExcelJS.Workbook.prototype as any)._xlsx;
  });

  it('encodes tabs with unsorted IDs, typed scalars, literal OOXML escapes, exact CRLF semantic oracle, and inert formulas', async () => {
    // Deliberately unsorted source IDs (42, 7, 99) with assigned indices (0, 1, 2)
    const s1Cells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: '00123' },
      { r: 49, c: 3, kind: 'string', value: 'middle' },
      { r: 89999, c: 25, kind: 'number', value: 42 },
      { r: 1, c: 0, kind: 'boolean', value: true },
      { r: 2, c: 0, kind: 'number', value: 45678.5, numberFormatType: 'DATE_TIME' },
      { r: 3, c: 0, kind: 'string', value: '=SUM(1,2)' },
      { r: 4, c: 0, kind: 'string', value: '=HYPERLINK("https://evil.com","click")' },
      { r: 5, c: 0, kind: 'string', value: '  Unicode: 🚀 "quotes" \r\n end  ' },
      { r: 6, c: 0, kind: 'string', value: '_x000D_' },
      { r: 7, c: 0, kind: 'string', value: '_x005F_' },
      { r: 8, c: 0, kind: 'string', value: '_x000D_x000A_' },
      { r: 9, c: 0, kind: 'string', value: 'CR_only:\r_line' },
      { r: 10, c: 0, kind: 'error', value: { code: '#DIV/0!', message: 'Divide by zero' } },
      { r: 11, c: 0, kind: 'error', value: { code: '#VALUE!', message: 'Bad\r\nvalue with _x000D_' } }
    ];
    const s1CellsSnapshot = JSON.stringify(s1Cells);

    const s3Cells: Cell[] = [
      { r: 4, c: 2, kind: 'string', value: 'C5_val' },
      { r: 5, c: 3, kind: 'number', value: 99 }
    ];

    const d1 = makeSheetFixture(42, 'Data/Raw', 0, { sheetId: 42, r0: 0, c0: 0, r1: 100000, c1: 30 }, s1Cells);
    const d2 = makeSheetFixture(7, 'BlankSheet', 1, { sheetId: 7, r0: 0, c0: 0, r1: 10, c1: 10 }, []);
    const d3 = makeSheetFixture(99, 'Data:Raw', 2, { sheetId: 99, r0: 4, c0: 2, r1: 6, c1: 4 }, s3Cells);

    // Source order deliberately [42, 7, 99]
    const sheetOrder = [42, 7, 99];
    const prepared = prepareSheetsViaWriter([d1, d2, d3], sheetOrder, baseSignal);

    const tracker = createTrackingSignal(baseSignal);
    const result = await encodeXlsx(prepared, { ...stdOpts, signal: tracker.signal });
    expect(tracker.registeredCount).toBe(1);
    expect(tracker.removedCount).toBe(1);

    // Preserves exact source order and maps names deterministically
    expect(result.nameMappings).toEqual([
      { sheetId: 42, originalTitle: 'Data/Raw', exportedName: 'Data_Raw' },
      { sheetId: 7, originalTitle: 'BlankSheet', exportedName: 'BlankSheet' },
      { sheetId: 99, originalTitle: 'Data:Raw', exportedName: 'Data_Raw~2' }
    ]);
    expect(Object.isFrozen(result) && Object.isFrozen(result.nameMappings)).toBe(true);
    expect(Object.isFrozen(result.bytes)).toBe(false);

    // Assert source cell input was not mutated
    expect(JSON.stringify(s1Cells)).toBe(s1CellsSnapshot);

    // Real SheetJS verification (with explicit CRLF normalization boundary documented)
    const wb = XLSX.read(result.bytes, { type: 'array', cellFormula: true, cellDates: false });
    expect(wb.SheetNames).toEqual(['Data_Raw', 'BlankSheet', 'Data_Raw~2']);

    const ws1 = wb.Sheets['Data_Raw'];
    expect(ws1['A1']).toMatchObject({ t: 's', v: '00123' });
    expect(ws1['D50']).toMatchObject({ t: 's', v: 'middle' });
    expect(ws1['Z90000']).toMatchObject({ t: 'n', v: 42 });
    expect(ws1['A2']).toMatchObject({ t: 'b', v: true });

    // Date serial stays number with DATE_TIME metadata
    expect(ws1['A3']).toMatchObject({ t: 'n', v: 45678.5 });

    // Formula text fixtures stay inert strings without formula or hyperlink evaluation
    expect(ws1['A4']).toMatchObject({ t: 's', v: '=SUM(1,2)' });
    expect(ws1['A4'].f).toBeUndefined();
    expect(ws1['A5']).toMatchObject({ t: 's', v: '=HYPERLINK("https://evil.com","click")' });
    expect(ws1['A5'].f).toBeUndefined();
    expect((ws1['A5'] as any).l).toBeUndefined();

    // SheetJS normalizes CRLF to LF even when OOXML _x000D_ wire escaping is present (lead probe boundary)
    expect(ws1['A6']).toMatchObject({ t: 's', v: '  Unicode: 🚀 "quotes" \n end  ' });

    // Literal escape roundtrips through SheetJS
    expect(ws1['A7']).toMatchObject({ t: 's', v: '_x000D_' });
    expect(ws1['A8']).toMatchObject({ t: 's', v: '_x005F_' });
    expect(ws1['A9']).toMatchObject({ t: 's', v: '_x000D_x000A_' });
    expect(ws1['A10']).toMatchObject({ t: 's', v: 'CR_only:\r_line' });

    // Error rendering
    expect(ws1['A11']).toMatchObject({ t: 's', v: '#ERROR[#DIV/0!]: Divide by zero' });
    expect(ws1['A12']).toMatchObject({ t: 's', v: '#ERROR[#VALUE!]: Bad\nvalue with _x000D_' });

    // Blank tab preserves empty state
    expect(wb.Sheets['BlankSheet']['A1']).toBeUndefined();

    // Tab 3 with nonzero origin C5:D6
    const ws3 = wb.Sheets['Data_Raw~2'];
    expect(ws3['C5']).toMatchObject({ t: 's', v: 'C5_val' });
    expect(ws3['D6']).toMatchObject({ t: 'n', v: 99 });

    // Independent fflate + fast-xml-parser verification
    const unzipped = unzipSync(result.bytes);
    const xmlParserStrict = new XMLParser({
      ignoreAttributes: false,
      trimValues: false,
      parseTagValue: false
    });

    // 1. Workbook XML tab ordering
    const wbXml = xmlParserStrict.parse(new TextDecoder().decode(unzipped['xl/workbook.xml']));
    const sheets = Array.isArray(wbXml.workbook.sheets.sheet)
      ? wbXml.workbook.sheets.sheet
      : [wbXml.workbook.sheets.sheet];
    expect(sheets.map((s: any) => s['@_name'])).toEqual(['Data_Raw', 'BlankSheet', 'Data_Raw~2']);

    // 2. Semantic node inspection across ALL worksheet/workbook XMLs and relationship files
    const allFilenames = Object.keys(unzipped);
    for (const filename of allFilenames) {
      if (filename.startsWith('xl/worksheets/sheet') && filename.endsWith('.xml')) {
        const sheetXmlText = new TextDecoder().decode(unzipped[filename]);
        expect(/<f[\s/>]/i.test(sheetXmlText)).toBe(false);
        expect(/<hyperlink[\s/>]/i.test(sheetXmlText)).toBe(false);
        expect(/<externalReference[\s/>]/i.test(sheetXmlText)).toBe(false);

        const parsedSheet = xmlParserStrict.parse(sheetXmlText);
        expect(hasForbiddenXmlNodes(parsedSheet)).toBe(false);
      }
      if (filename.endsWith('.rels')) {
        const relsXml = xmlParserStrict.parse(new TextDecoder().decode(unzipped[filename]));
        expect(hasExternalRelationships(relsXml)).toBe(false);
      }
    }
    expect(hasForbiddenXmlNodes(wbXml)).toBe(false);

    // 3. Independent XML + ST_Xstring one-pass semantic oracle for exact ORIGINAL CRLF
    const sharedStringsText = new TextDecoder().decode(unzipped['xl/sharedStrings.xml']);
    const sstXml = xmlParserStrict.parse(sharedStringsText);
    const siEntries = Array.isArray(sstXml.sst.si) ? sstXml.sst.si : [sstXml.sst.si];
    const decodedSstStrings = siEntries.map((si: any) => {
      const t = si.t;
      const rawText = typeof t === 'string' ? t : (t?.['#text'] ?? '');
      return decodeOoxmlString(rawText);
    });

    // Semantic oracle asserts EXACT ORIGINAL CRLF and preserved whitespace
    expect(decodedSstStrings).toContain('  Unicode: 🚀 "quotes" \r\n end  ');
    expect(decodedSstStrings).toContain('_x000D_');
    expect(decodedSstStrings).toContain('_x005F_');
    expect(decodedSstStrings).toContain('_x000D_x000A_');
    expect(decodedSstStrings).toContain('CR_only:\r_line');
    expect(decodedSstStrings).toContain('#ERROR[#DIV/0!]: Divide by zero');
    expect(decodedSstStrings).toContain('#ERROR[#VALUE!]: Bad\r\nvalue with _x000D_');
  });

  it('encodes sheets prepared through prepareWriterData with context.mode="formula_text", verifying formula text strings and absent f/hyperlink XML', async () => {
    const sCells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: '=SUM(1,2)', formulaText: '=SUM(1,2)' },
      { r: 1, c: 0, kind: 'string', value: '=HYPERLINK("https://evil.com","click")', formulaText: '=HYPERLINK("https://evil.com","click")' },
      { r: 2, c: 0, kind: 'string', value: 'plain text cell' },
      { r: 3, c: 0, kind: 'number', value: 42 },
      { r: 4, c: 0, kind: 'boolean', value: false }
    ];
    const sCellsSnapshot = JSON.stringify(sCells);

    const f1 = makeSheetFixture(1, 'Formulas', 0, { sheetId: 1, r0: 0, c0: 0, r1: 10, c1: 5 }, sCells);
    const prepared = prepareSheetsViaWriter([f1], [1], baseSignal, 'formula_text');

    const result = await encodeXlsx(prepared, stdOpts);

    expect(JSON.stringify(sCells)).toBe(sCellsSnapshot);
    expect(result.nameMappings).toEqual([
      { sheetId: 1, originalTitle: 'Formulas', exportedName: 'Formulas' }
    ]);

    // SheetJS inspects parsed string and asserts no formula / hyperlink evaluation
    const wb = XLSX.read(result.bytes, { type: 'array', cellFormula: true, cellDates: false });
    const ws = wb.Sheets['Formulas'];
    expect(ws['A1']).toMatchObject({ t: 's', v: '=SUM(1,2)' });
    expect(ws['A1'].f).toBeUndefined();
    expect(ws['A2']).toMatchObject({ t: 's', v: '=HYPERLINK("https://evil.com","click")' });
    expect(ws['A2'].f).toBeUndefined();
    expect((ws['A2'] as any).l).toBeUndefined();
    expect(ws['A3']).toMatchObject({ t: 's', v: 'plain text cell' });
    expect(ws['A4']).toMatchObject({ t: 'n', v: 42 });
    expect(ws['A5']).toMatchObject({ t: 'b', v: false });

    // XML parser asserts no <f> or <hyperlink> nodes anywhere
    const unzipped = unzipSync(result.bytes);
    const xmlParserStrict = new XMLParser({
      ignoreAttributes: false,
      trimValues: false,
      parseTagValue: false
    });

    for (const filename of Object.keys(unzipped)) {
      if (filename.startsWith('xl/worksheets/sheet') && filename.endsWith('.xml')) {
        const sheetXmlText = new TextDecoder().decode(unzipped[filename]);
        expect(/<f[\s/>]/i.test(sheetXmlText)).toBe(false);
        expect(/<hyperlink[\s/>]/i.test(sheetXmlText)).toBe(false);
        expect(/<externalReference[\s/>]/i.test(sheetXmlText)).toBe(false);

        const parsedSheet = xmlParserStrict.parse(sheetXmlText);
        expect(hasForbiddenXmlNodes(parsedSheet)).toBe(false);
      }
      if (filename.endsWith('.rels')) {
        const relsXml = xmlParserStrict.parse(new TextDecoder().decode(unzipped[filename]));
        expect(hasExternalRelationships(relsXml)).toBe(false);
      }
    }
  });

  it('genuinely spies and checks representability caps before Workbook.addWorksheet or writeBuffer', async () => {
    const addWorksheetSpy = vi.spyOn(ExcelJS.Workbook.prototype, 'addWorksheet');
    const writeBufferSpy = vi.spyOn(XLSXProto, 'writeBuffer');

    try {
      const mkRaw = (cells: Cell[], rect: Rect = { sheetId: 1, r0: 0, c0: 0, r1: 10, c1: 10 }) => [
        {
          metadata: { id: 1, title: 'S', index: 0, type: 'GRID', hidden: false },
          scope: rect,
          cells,
          excludedIntervals: { rows: [], columns: [] }
        }
      ];

      // Scope cap errors
      await expect(encodeXlsx(mkRaw([], { sheetId: 1, r0: 0, c0: 0, r1: 1048577, c1: 10 }), stdOpts))
        .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
      await expect(encodeXlsx(mkRaw([], { sheetId: 1, r0: 5, c0: 0, r1: 5, c1: 10 }), stdOpts))
        .rejects.toMatchObject({ code: 'RANGE_EMPTY' });
      await expect(encodeXlsx(mkRaw([], { sheetId: 1, r0: 5, c0: 0, r1: 4, c1: 10 }), stdOpts))
        .rejects.toMatchObject({ code: 'RANGE_INVALID' });
      await expect(encodeXlsx(mkRaw([{ r: 15, c: 0, kind: 'string', value: 'out' }]), stdOpts))
        .rejects.toMatchObject({ code: 'RANGE_OUT_OF_BOUNDS' });
      await expect(encodeXlsx(mkRaw([{ r: -1, c: 0, kind: 'string', value: 'bad' }]), stdOpts))
        .rejects.toMatchObject({ code: 'RANGE_INVALID' });

      // Text representability cap errors
      await expect(encodeXlsx(mkRaw([{ r: 0, c: 0, kind: 'string', value: 'a'.repeat(32768) }]), stdOpts))
        .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
      await expect(encodeXlsx(mkRaw([{ r: 0, c: 0, kind: 'string', value: 'bad\u0000char' }]), stdOpts))
        .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
      await expect(encodeXlsx(mkRaw([{ r: 0, c: 0, kind: 'string', value: '\n'.repeat(254) }]), stdOpts))
        .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
      await expect(encodeXlsx(mkRaw([{ r: 0, c: 0, kind: 'error', value: { code: 'A'.repeat(32760), message: 'B' } }]), stdOpts))
        .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });

      // Numeric representability cap errors
      await expect(encodeXlsx(mkRaw([{ r: 0, c: 0, kind: 'number', value: NaN }]), stdOpts))
        .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
      await expect(encodeXlsx(mkRaw([{ r: 0, c: 0, kind: 'number', value: Infinity }]), stdOpts))
        .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
      await expect(encodeXlsx(mkRaw([{ r: 0, c: 0, kind: 'number', value: 1e308 }]), stdOpts))
        .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
      await expect(encodeXlsx(mkRaw([{ r: 0, c: 0, kind: 'number', value: 1.234567890123456 }]), stdOpts))
        .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });

      // Cell limit cap error
      await expect(encodeXlsx(mkRaw([{ r: 0, c: 0, kind: 'string', value: '1' }, { r: 0, c: 1, kind: 'string', value: '2' }]), { ...stdOpts, maxCells: 1 }))
        .rejects.toMatchObject({ code: 'CELL_LIMIT_EXCEEDED' });

      // Text unit limit cap error
      await expect(encodeXlsx(mkRaw([{ r: 0, c: 0, kind: 'string', value: 'hello world' }]), { ...stdOpts, maxInputTextUnits: 5 }))
        .rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' });

      // Options validation and pre-abort
      await expect(encodeXlsx(mkRaw([]), null as any)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      await expect(encodeXlsx([], stdOpts)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      await expect(encodeXlsx(mkRaw([]), { ...stdOpts, maxBytes: -1 })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      await expect(encodeXlsx(mkRaw([]), { ...stdOpts, signal: {} as any })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

      const preAborted = new AbortController();
      preAborted.abort();
      await expect(encodeXlsx(mkRaw([]), { ...stdOpts, signal: preAborted.signal }))
        .rejects.toMatchObject({ code: 'OPERATION_ABORTED' });

      // Genuinely assert neither addWorksheet nor writeBuffer was EVER invoked during preflight cap rejections
      expect(addWorksheetSpy).not.toHaveBeenCalled();
      expect(writeBufferSpy).not.toHaveBeenCalled();
    } finally {
      addWorksheetSpy.mockRestore();
      writeBufferSpy.mockRestore();
    }
  });

  it('redacts constructor and population failures to static FORMAT_SERIALIZATION_FAILED without token leak', async () => {
    const f1 = makeSheetFixture(1, 'S', 0, { sheetId: 1, r0: 0, c0: 0, r1: 5, c1: 5 }, [{ r: 0, c: 0, kind: 'string', value: 'v' }]);
    const prep = prepareSheetsViaWriter([f1], [1], baseSignal);

    // 1. Real Workbook constructor failure mock
    const origWorkbook = ExcelJS.Workbook;
    try {
      (ExcelJS as any).Workbook = function() {
        throw new Error('LEAK_SECRET_CONSTRUCTOR_TOKEN');
      };
      await expect(encodeXlsx(prep, stdOpts)).rejects.toMatchObject({
        code: 'FORMAT_SERIALIZATION_FAILED',
        message: SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED
      });
    } finally {
      (ExcelJS as any).Workbook = origWorkbook;
    }

    // 2. addWorksheet population failure
    const origAdd = ExcelJS.Workbook.prototype.addWorksheet;
    try {
      ExcelJS.Workbook.prototype.addWorksheet = function() {
        throw new Error('LEAK_SECRET_ADD_WORKSHEET_TOKEN');
      };
      await expect(encodeXlsx(prep, stdOpts)).rejects.toMatchObject({
        code: 'FORMAT_SERIALIZATION_FAILED',
        message: SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED
      });
    } finally {
      ExcelJS.Workbook.prototype.addWorksheet = origAdd;
    }

    // 3. getCell setter/getter population failure
    const origAddWorksheet = ExcelJS.Workbook.prototype.addWorksheet;
    try {
      ExcelJS.Workbook.prototype.addWorksheet = function(name?: string, options?: any) {
        const ws = origAddWorksheet.call(this, name, options);
        ws.getCell = function() {
          throw new Error('LEAK_SECRET_GET_CELL_TOKEN');
        };
        return ws;
      };
      await expect(encodeXlsx(prep, stdOpts)).rejects.toMatchObject({
        code: 'FORMAT_SERIALIZATION_FAILED',
        message: SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED
      });
    } finally {
      ExcelJS.Workbook.prototype.addWorksheet = origAddWorksheet;
    }

    // 4. Raw provider error with arbitrary .code property is not trusted
    try {
      ExcelJS.Workbook.prototype.addWorksheet = function() {
        const rawErr = new Error('LEAK_SECRET_RAW_PROVIDER');
        (rawErr as any).code = 'OPERATION_ABORTED';
        throw rawErr;
      };
      const res = await encodeXlsx(prep, stdOpts).catch(e => e);
      expect(res).toBeInstanceOf(DomainError);
      expect(res.code).toBe('FORMAT_SERIALIZATION_FAILED');
      expect(res.message).toBe(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
      expect(String(res)).not.toContain('LEAK_SECRET_RAW_PROVIDER');
    } finally {
      ExcelJS.Workbook.prototype.addWorksheet = origAdd;
    }

    // 5. Mutated DomainError code getter does not escape
    try {
      ExcelJS.Workbook.prototype.addWorksheet = function() {
        const mutatedErr = new DomainError('OPERATION_ABORTED');
        Object.defineProperty(mutatedErr, 'code', {
          get() {
            throw new Error('LEAK_SECRET_MUTATED_CODE_GETTER');
          }
        });
        throw mutatedErr;
      };
      const res = await encodeXlsx(prep, stdOpts).catch(e => e);
      expect(res).toBeInstanceOf(DomainError);
      expect(res.code).toBe('FORMAT_SERIALIZATION_FAILED');
      expect(res.message).toBe(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
      expect(String(res)).not.toContain('LEAK_SECRET_MUTATED_CODE_GETTER');
    } finally {
      ExcelJS.Workbook.prototype.addWorksheet = origAdd;
    }
  });

  it('handles synchronous aborting+throwing provider without unhandled rejection or secret leak', async () => {
    const f1 = makeSheetFixture(1, 'S', 0, { sheetId: 1, r0: 0, c0: 0, r1: 5, c1: 5 }, []);
    const prep = prepareSheetsViaWriter([f1], [1], baseSignal);

    const ac = new AbortController();
    const origWrite = XLSXProto.writeBuffer;

    const unhandledList: any[] = [];
    const unhandledHandler = (reason: any) => { unhandledList.push(reason); };
    process.on('unhandledRejection', unhandledHandler);

    try {
      XLSXProto.writeBuffer = function() {
        ac.abort();
        throw new Error('LEAK_SECRET_SYNC_THROW_TOKEN');
      };

      await expect(encodeXlsx(prep, { ...stdOpts, signal: ac.signal }))
        .rejects.toMatchObject({
          code: 'OPERATION_ABORTED',
          message: SAFE_ERROR_MESSAGES.OPERATION_ABORTED
        });

      // Allow any microtasks to settle
      await new Promise(r => setTimeout(r, 20));
      expect(unhandledList).toHaveLength(0);
    } finally {
      XLSXProto.writeBuffer = origWrite;
      process.removeListener('unhandledRejection', unhandledHandler);
    }
  });

  it('handles in-flight abort, late rejection, listener cleanup, and signal proxy registration failure', async () => {
    const f1 = makeSheetFixture(1, 'S', 0, { sheetId: 1, r0: 0, c0: 0, r1: 5, c1: 5 }, []);
    const prep = prepareSheetsViaWriter([f1], [1], baseSignal);

    const origWrite = XLSXProto.writeBuffer;
    const unhandledList: any[] = [];
    const unhandledHandler = (reason: any) => { unhandledList.push(reason); };
    process.on('unhandledRejection', unhandledHandler);

    try {
      // In-flight abort race: explicitly assert listener registered and removed count
      const ac = new AbortController();
      const tracker = createTrackingSignal(ac.signal);
      XLSXProto.writeBuffer = async function() {
        ac.abort();
        await new Promise(r => setTimeout(r, 10));
        return origWrite.apply(this);
      };
      await expect(encodeXlsx(prep, { ...stdOpts, signal: tracker.signal }))
        .rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
      expect(tracker.registeredCount).toBe(1);
      expect(tracker.removedCount).toBe(1);

      // Late rejection from writeBuffer after abort
      const acLate = new AbortController();
      XLSXProto.writeBuffer = async function() {
        await new Promise(r => setTimeout(r, 30));
        throw new Error('LATE_REJECTION_SECRET_TOKEN');
      };
      const latePromise = encodeXlsx(prep, { ...stdOpts, signal: acLate.signal });
      setTimeout(() => acLate.abort(), 10);
      await expect(latePromise).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });

      // Wait for late rejection to fire in background and verify no unhandled rejection occurs
      await new Promise(r => setTimeout(r, 50));
      expect(unhandledList).toHaveLength(0);

      // Signal cancellation at registration boundary
      const boundaryAc = new AbortController();
      let listenerRegistered = false;
      const proxySignal = new Proxy(boundaryAc.signal, {
        get(target, prop) {
          if (prop === 'addEventListener') {
            return function(...args: any[]) {
              boundaryAc.abort(); // abort during listener registration
              listenerRegistered = true;
              return (target as any).addEventListener.apply(target, args);
            };
          }
          return Reflect.get(target, prop, target);
        }
      });
      await expect(encodeXlsx(prep, { ...stdOpts, signal: proxySignal }))
        .rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
      expect(listenerRegistered).toBe(true);

      // Regression: signal proxy where real aborted getter bound works, addEventListener throws with secret
      // Asserts: static CONFIG_INVALID BEFORE invoking provider, writeBuffer NOT called, cleanup attempted
      const writeBufferSpy = vi.spyOn(XLSXProto, 'writeBuffer');
      const acFail = new AbortController();
      let regCount = 0;
      let remCount = 0;
      const regFailSignal = new Proxy(acFail.signal, {
        get(target, prop) {
          if (prop === 'addEventListener') {
            return function() {
              regCount++;
              throw new Error('SECRET_ADD_EVENT_LISTENER_LEAK');
            };
          }
          if (prop === 'removeEventListener') {
            return function(type: string, listener: any, opts: any) {
              remCount++;
              return (target as any).removeEventListener(type, listener, opts);
            };
          }
          return Reflect.get(target, prop, target);
        }
      });

      const errReg = await encodeXlsx(prep, { ...stdOpts, signal: regFailSignal }).catch(e => e);
      expect(errReg).toBeInstanceOf(DomainError);
      expect(errReg.code).toBe('CONFIG_INVALID');
      expect(errReg.message).toBe(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
      expect(String(errReg)).not.toContain('SECRET_ADD_EVENT_LISTENER_LEAK');
      expect(writeBufferSpy).not.toHaveBeenCalled();
      expect(regCount).toBe(1);
      expect(remCount).toBe(1); // Cleanup attempted
      writeBufferSpy.mockRestore();

      // A transient failure at the immediate post-registration check must fail
      // before writeBuffer, even if subsequent aborted reads return false again.
      const transientAc = new AbortController();
      let throwOnce = false;
      const transientSignal = new Proxy(transientAc.signal, {
        get(target, prop) {
          if (prop === 'addEventListener') return function(...args: Parameters<AbortSignal['addEventListener']>) {
            target.addEventListener(...args);
            throwOnce = true;
          };
          if (prop === 'aborted' && throwOnce) {
            throwOnce = false;
            throw new Error('SECRET_POST_REGISTRATION_GETTER');
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      const transientWriteSpy = vi.spyOn(XLSXProto, 'writeBuffer');
      try {
        await expect(encodeXlsx(prep, { ...stdOpts, signal: transientSignal })).rejects.toMatchObject({
          code: 'FORMAT_SERIALIZATION_FAILED', message: SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED
        });
        expect(transientWriteSpy).not.toHaveBeenCalled();
      } finally {
        transientWriteSpy.mockRestore();
      }
    } finally {
      XLSXProto.writeBuffer = origWrite;
      process.removeListener('unhandledRejection', unhandledHandler);
    }
  });

  it('safely catches preflight throwing getters and throwing signal during operation without raw leak', async () => {
    const f1 = makeSheetFixture(1, 'S', 0, { sheetId: 1, r0: 0, c0: 0, r1: 5, c1: 5 }, [{ r: 0, c: 0, kind: 'string', value: 'v' }]);
    const prep = prepareSheetsViaWriter([f1], [1], baseSignal);

    // 1. Throwing prepared[i].cells getter
    const sheetWithThrowingCells = {
      metadata: { id: 1, title: 'S', index: 0, type: 'GRID', hidden: false },
      scope: { sheetId: 1, r0: 0, c0: 0, r1: 5, c1: 5 },
      get cells(): Cell[] {
        throw new Error('SECRET_THROWING_CELLS_GETTER');
      },
      excludedIntervals: { rows: [], columns: [] }
    };
    const errCells = await encodeXlsx([sheetWithThrowingCells as any], stdOpts).catch(e => e);
    expect(errCells).toBeInstanceOf(DomainError);
    expect(errCells.code).toBe('FORMAT_SERIALIZATION_FAILED');
    expect(errCells.message).toBe(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(String(errCells)).not.toContain('SECRET_THROWING_CELLS_GETTER');

    // 2. Throwing sheet.scope getter
    const sheetWithThrowingScope = {
      metadata: { id: 1, title: 'S', index: 0, type: 'GRID', hidden: false },
      get scope(): Rect {
        throw new Error('SECRET_THROWING_SCOPE_GETTER');
      },
      cells: [{ r: 0, c: 0, kind: 'string' as const, value: 'v' }],
      excludedIntervals: { rows: [], columns: [] }
    };
    const errScope = await encodeXlsx([sheetWithThrowingScope as any], stdOpts).catch(e => e);
    expect(errScope).toBeInstanceOf(DomainError);
    expect(errScope.code).toBe('FORMAT_SERIALIZATION_FAILED');
    expect(errScope.message).toBe(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(String(errScope)).not.toContain('SECRET_THROWING_SCOPE_GETTER');

    // 3. Throwing cell.value getter
    const cellWithThrowingValue = {
      r: 0,
      c: 0,
      kind: 'string' as const,
      get value(): string {
        throw new Error('SECRET_THROWING_VALUE_GETTER');
      }
    };
    const sheetWithThrowingValue = {
      metadata: { id: 1, title: 'S', index: 0, type: 'GRID', hidden: false },
      scope: { sheetId: 1, r0: 0, c0: 0, r1: 5, c1: 5 },
      cells: [cellWithThrowingValue],
      excludedIntervals: { rows: [], columns: [] }
    };
    const errVal = await encodeXlsx([sheetWithThrowingValue as any], stdOpts).catch(e => e);
    expect(errVal).toBeInstanceOf(DomainError);
    expect(errVal.code).toBe('FORMAT_SERIALIZATION_FAILED');
    expect(errVal.message).toBe(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(String(errVal)).not.toContain('SECRET_THROWING_VALUE_GETTER');

    // 4. Throwing signal during operation
    const unhandledList: any[] = [];
    const unhandledHandler = (reason: any) => { unhandledList.push(reason); };
    process.on('unhandledRejection', unhandledHandler);

    try {
      let abortedReadCount = 0;
      const ac = new AbortController();
      const throwingSignal = new Proxy(ac.signal, {
        get(target, prop) {
          if (prop === 'aborted') {
            abortedReadCount++;
            // Pass options validation (2 reads), then throw during operation
            if (abortedReadCount > 2) {
              throw new Error('SECRET_SIGNAL_ABORTED_DURING_OP');
            }
            return false;
          }
          return Reflect.get(target, prop, target);
        }
      });

      const errSig = await encodeXlsx(prep, { ...stdOpts, signal: throwingSignal }).catch(e => e);
      expect(errSig).toBeInstanceOf(DomainError);
      expect(errSig.code).toBe('FORMAT_SERIALIZATION_FAILED');
      expect(errSig.message).toBe(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
      expect(String(errSig)).not.toContain('SECRET_SIGNAL_ABORTED_DURING_OP');

      await new Promise(r => setTimeout(r, 20));
      expect(unhandledList).toHaveLength(0);
    } finally {
      process.removeListener('unhandledRejection', unhandledHandler);
    }
  });

  it('enforces byte cap and rejects zero-length or malformed serialization buffers', async () => {
    const f1 = makeSheetFixture(1, 'S', 0, { sheetId: 1, r0: 0, c0: 0, r1: 5, c1: 5 }, [{ r: 0, c: 0, kind: 'string', value: 'val' }]);
    const prep = prepareSheetsViaWriter([f1], [1], baseSignal);

    // Byte limit exceeded
    await expect(encodeXlsx(prep, { ...stdOpts, maxBytes: 10 }))
      .rejects.toMatchObject({ code: 'BYTE_LIMIT_EXCEEDED' });

    // Zero-length serialization buffer
    const origWrite = XLSXProto.writeBuffer;
    try {
      XLSXProto.writeBuffer = async function() {
        return new Uint8Array(0);
      };
      await expect(encodeXlsx(prep, stdOpts)).rejects.toMatchObject({
        code: 'FORMAT_SERIALIZATION_FAILED'
      });

      // Malformed buffer (neither ArrayBuffer nor View)
      XLSXProto.writeBuffer = async function() {
        return { bad: 'object' };
      };
      await expect(encodeXlsx(prep, stdOpts)).rejects.toMatchObject({
        code: 'FORMAT_SERIALIZATION_FAILED'
      });
    } finally {
      XLSXProto.writeBuffer = origWrite;
    }
  });
});
