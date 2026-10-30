import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import * as XLSX from 'xlsx';
import { parse as parseCsvSync } from 'csv-parse/sync';

export function verifyArtifacts({ xlsxBytes, zipBytes, label }) {
  // 1. Inspect XLSX ZIP entries & raw XML
  const xlsxEntries = unzipSync(xlsxBytes);
  const entryNames = Object.keys(xlsxEntries).sort();

  const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_'
  });

  const workbookXml = strFromU8(xlsxEntries['xl/workbook.xml']);
  const workbookDoc = xmlParser.parse(workbookXml);
  const rawSheets = workbookDoc?.workbook?.sheets?.sheet;
  const sheetNodes = Array.isArray(rawSheets) ? rawSheets : [rawSheets];
  assert.equal(sheetNodes.length, 3, `[${label}] Expected exactly 3 sheets in xl/workbook.xml`);
  assert.deepEqual(
    sheetNodes.map(s => s['@_name']),
    [
      "Sales '26 — Đông Á",
      'Empty_Sheet',
      "Cafe's _2026_____LongTitle_Exce"
    ],
    `[${label}] Worksheet names and order in xl/workbook.xml must match expected sanitized names`
  );

  const worksheetFiles = entryNames.filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  assert.equal(worksheetFiles.length, 3, `[${label}] Expected 3 worksheet XML files`);

  const xmlSummary = {};
  for (const wsFile of worksheetFiles) {
    const xmlText = strFromU8(xlsxEntries[wsFile]);
    // Assert zero <f> formula nodes and zero <hyperlinks> / externalLink nodes
    assert.equal(
      /<f[\s>]/i.test(xmlText),
      false,
      `[${label}] ${wsFile} must not contain any <f> formula XML elements`
    );
    assert.equal(
      /<hyperlinks[\s>]|<hyperlink[\s>]/i.test(xmlText),
      false,
      `[${label}] ${wsFile} must not contain any <hyperlink> XML elements`
    );
    assert.equal(
      /externalLink/i.test(xmlText),
      false,
      `[${label}] ${wsFile} must not reference externalLink`
    );

    const parsedWs = xmlParser.parse(xmlText);
    const rawRows = parsedWs?.worksheet?.sheetData?.row;
    const rows = !rawRows ? [] : Array.isArray(rawRows) ? rawRows : [rawRows];
    xmlSummary[wsFile] = {
      xmlByteLength: xlsxEntries[wsFile].byteLength,
      rowNodeCount: rows.length,
      rowNumbers: rows.map(r => Number(r['@_r']))
    };
  }

  // Verify sparse Sheet 1 only emitted 4 <row> elements (1, 2, 50, 90000), not 90,000!
  assert.deepEqual(
    xmlSummary['xl/worksheets/sheet1.xml'].rowNumbers,
    [1, 2, 50, 90000],
    `[${label}] sheet1.xml must contain only sparse row nodes [1, 2, 50, 90000]`
  );
  assert.deepEqual(
    xmlSummary['xl/worksheets/sheet2.xml'].rowNumbers,
    [],
    `[${label}] sheet2.xml (Empty_Sheet) must contain 0 row nodes`
  );
  assert.deepEqual(
    xmlSummary['xl/worksheets/sheet3.xml'].rowNumbers,
    [5, 6, 7, 8],
    `[${label}] sheet3.xml must preserve nonzero-origin row numbers [5, 6, 7, 8]`
  );

  // 2. Parse XLSX with independent reader (SheetJS / xlsx)
  const wb = XLSX.read(xlsxBytes, {
    type: 'buffer',
    cellFormula: true,
    cellNF: true,
    cellText: false
  });
  assert.deepEqual(wb.SheetNames, [
    "Sales '26 — Đông Á",
    'Empty_Sheet',
    "Cafe's _2026_____LongTitle_Exce"
  ]);

  const ws1 = wb.Sheets[wb.SheetNames[0]];
  const expectedSheet1Cells = [
    ['A1', 's', '00123'],
    ['B1', 'n', -42.5],
    ['C1', 'b', true],
    ['D1', 's', '#DIV/0!'],
    ['A2', 's', '=SUM(1,1)'],
    ['B2', 's', "+cmd|' /C calc'!A0"],
    ['C2', 's', '-2+3'],
    ['D2', 's', '@SUM(A1:A2)'],
    ['E2', 's', ' \t=HYPERLINK("https://evil.example","click")'],
    ['F2', 's', 'https://docs.google.com/spreadsheets/d/123'],
    ['G2', 's', 'Line 1\r\n"Quoted, text"\nLine 3 emoji 🧪'],
    ['H2', 's', ''],
    ['D50', 's', 'middle'],
    ['Z90000', 'n', 42]
  ];

  for (const [addr, expectedType, expectedVal] of expectedSheet1Cells) {
    const cell = ws1[addr];
    assert.ok(cell, `[${label}] Missing cell ${addr} in Sheet 1`);
    assert.equal(cell.t, expectedType, `[${label}] Cell ${addr} type mismatch`);
    assert.equal(cell.v, expectedVal, `[${label}] Cell ${addr} value mismatch`);
    assert.equal(cell.f, undefined, `[${label}] Cell ${addr} must not have a formula`);
    assert.equal(cell.l, undefined, `[${label}] Cell ${addr} must not have a hyperlink`);
  }

  const ws2 = wb.Sheets[wb.SheetNames[1]];
  const ws2Keys = Object.keys(ws2).filter(k => !k.startsWith('!'));
  assert.equal(ws2Keys.length, 0, `[${label}] Empty_Sheet must have 0 cells`);

  const ws3 = wb.Sheets[wb.SheetNames[2]];
  assert.equal(ws3['A1'], undefined, `[${label}] Sheet 3 A1 must be empty (nonzero origin C5)`);
  assert.equal(ws3['C5']?.t, 's');
  assert.equal(ws3['C5']?.v, 'Origin C5');
  assert.equal(ws3['D6']?.t, 's');
  assert.equal(ws3['D6']?.v?.length, 32767);
  assert.equal(ws3['E7']?.t, 'b');
  assert.equal(ws3['E7']?.v, false);
  assert.equal(ws3['F8']?.t, 'n');
  assert.equal(ws3['F8']?.v, 99.95);

  // 3. Inspect multi-tab CSV ZIP with fflate + independent csv-parse
  const zipEntries = unzipSync(zipBytes);
  const zipEntryNames = Object.keys(zipEntries).sort();
  assert.equal(zipEntryNames.length, 4, `[${label}] Expected 3 CSV files + manifest.json in ZIP`);
  assert.ok(zipEntries['manifest.json'], `[${label}] manifest.json missing from ZIP`);

  const manifest = JSON.parse(strFromU8(zipEntries['manifest.json']));
  assert.equal(manifest.schemaVersion, '1.0');
  assert.equal(manifest.csvTransformCounts.totalTransformedCells, 5);
  assert.equal(manifest.exportedScopes[2].origin, 'C5');

  const csvSummary = {};
  for (const mapping of manifest.nameMappings) {
    const rawBytes = zipEntries[mapping.csvFileName];
    assert.ok(rawBytes, `[${label}] Missing ${mapping.csvFileName} in ZIP`);
    // Verify UTF-8 BOM (EF BB BF)
    assert.equal(rawBytes[0], 0xef);
    assert.equal(rawBytes[1], 0xbb);
    assert.equal(rawBytes[2], 0xbf);

    const text = strFromU8(rawBytes);
    assert.ok(text.endsWith('\r\n'), `[${label}] ${mapping.csvFileName} must use CRLF endings`);

    const records = parseCsvSync(rawBytes, {
      bom: true,
      relax_column_count: false
    });
    csvSummary[mapping.csvFileName] = {
      byteLength: rawBytes.byteLength,
      rows: records.length,
      cols: records[0]?.length ?? 0
    };

    if (mapping.sheetId === 101) {
      assert.equal(records.length, 90000);
      assert.equal(records[0].length, 26);
      assert.equal(records[0][0], '00123');
      assert.equal(records[0][1], '-42.5'); // numeric negative unmodified
      assert.equal(records[0][2], 'TRUE');
      assert.equal(records[0][3], '#DIV/0!');
      assert.equal(records[1][0], "'=SUM(1,1)");
      assert.equal(records[1][1], "'+cmd|' /C calc'!A0");
      assert.equal(records[1][2], "'-2+3");
      assert.equal(records[1][3], "'@SUM(A1:A2)");
      assert.equal(records[1][4], "' \t=HYPERLINK(\"https://evil.example\",\"click\")");
      assert.equal(records[1][5], 'https://docs.google.com/spreadsheets/d/123');
      assert.equal(records[1][6], 'Line 1\r\n"Quoted, text"\nLine 3 emoji 🧪');
      assert.equal(records[1][7], '');
      assert.equal(records[49][3], 'middle');
      assert.equal(records[89999][25], '42');
    } else if (mapping.sheetId === 202) {
      assert.equal(records.length, 5);
      assert.equal(records[0].length, 4);
      assert.ok(records.every(row => row.every(cell => cell === '')));
    } else if (mapping.sheetId === 303) {
      assert.equal(records.length, 4);
      assert.equal(records[0].length, 4);
      assert.equal(records[0][0], 'Origin C5');
      assert.equal(records[1][1].length, 32767);
      assert.equal(records[2][2], 'FALSE');
      assert.equal(records[3][3], '99.95');
    }
  }

  return {
    xlsxEntryNames: entryNames,
    xmlSummary,
    csvSummary,
    totalTransformedCells: manifest.csvTransformCounts.totalTransformedCells
  };
}
