import { describe, it, expect } from 'vitest';
import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import {
  mapWorksheetNames,
  mapCsvFilenames,
  formatWorkbookArtifactFilename,
  type SheetInput
} from '../../src/export/names.ts';
import { DomainError } from '../../src/contracts/errors.ts';

describe('T25 Pure Worksheet & Filename Mapping', () => {
  it('advances past multiple naturally suffixed filename collisions and keeps Unicode byte caps', () => {
    expect(mapCsvFilenames([
      { id: 1, title: 'Dup' }, { id: 2, title: 'Dup_4' },
      { id: 3, title: 'Dup_4_2' }, { id: 4, title: 'Dup' }
    ]).map(item => item.exportedName)).toEqual(['Dup.csv', 'Dup_4.csv', 'Dup_4_2.csv', 'Dup_4_3.csv']);
    expect(mapCsvFilenames([{ id: 1, title: '🌟'.repeat(40) }, { id: 2, title: '🌟'.repeat(40) }]).map(item => item.exportedName)).toEqual(['🌟'.repeat(29) + '.csv', '🌟'.repeat(28) + '_2.csv']);
  });

  it('detects NFC-equivalent CSV filenames without rewriting original titles', () => {
    const title = 'cafe\u0301';
    expect(mapCsvFilenames([{ id: 7, title: 'café' }, { id: 8, title }])).toEqual([
      { sheetId: 7, originalTitle: 'café', exportedName: 'café.csv' },
      { sheetId: 8, originalTitle: title, exportedName: title + '_8.csv' }
    ]);
  });
  it('maps worksheet invalid chars, controls, edge apostrophes and nonempty fallback', () => {
    const input: readonly SheetInput[] = [
      { id: 10, title: '[Sales:2026*Q1?A/B\\C]' },
      { id: 20, title: "  'P&L Summary'  " },
      { id: 30, title: "'''" },
      { id: 40, title: 'Control\u0000\u001f\u007fTab' },
      { id: 50, title: 'XML\uFFFEInvalid\uFFFFSheet' }
    ];
    const res = mapWorksheetNames(input);
    expect(res).toEqual([
      { sheetId: 10, originalTitle: '[Sales:2026*Q1?A/B\\C]', exportedName: '_Sales_2026_Q1_A_B_C_' },
      { sheetId: 20, originalTitle: "  'P&L Summary'  ", exportedName: 'P&L Summary' },
      { sheetId: 30, originalTitle: "'''", exportedName: 'Sheet_30' },
      { sheetId: 40, originalTitle: 'Control\u0000\u001f\u007fTab', exportedName: 'Control___Tab' },
      { sheetId: 50, originalTitle: 'XML\uFFFEInvalid\uFFFFSheet', exportedName: 'XML_Invalid_Sheet' }
    ]);
  });

  it('handles worksheet 31 UTF-16 cap, emoji boundaries, and apostrophe exposed by truncation', () => {
    const longAscii = 'A'.repeat(40);
    const boundaryEmoji = 'A'.repeat(30) + '😀'; // 30 + 2 units -> 30 units (no split surrogate)
    const exposedApostrophe = 'B'.repeat(30) + "'Extra"; // 30 chars + ' at cut -> edge ' trimmed
    const res = mapWorksheetNames([
      { id: 1, title: longAscii },
      { id: 2, title: boundaryEmoji },
      { id: 3, title: exposedApostrophe }
    ]);
    expect(res[0].exportedName).toBe('A'.repeat(31));
    expect(res[1].exportedName).toBe('A'.repeat(30));
    expect(res[2].exportedName).toBe('B'.repeat(30));
  });

  it('avoids worksheet reserved History, resolves NFC/case and naturally suffixed collisions', () => {
    const input: readonly SheetInput[] = [
      { id: 1, title: 'History' },
      { id: 2, title: 'history' },
      { id: 3, title: 'Report~2' },
      { id: 4, title: 'Report' },
      { id: 5, title: 'REPORT' },
      { id: 6, title: 'café' },
      { id: 7, title: 'cafe\u0301' } // decomposed café
    ];
    const res = mapWorksheetNames(input);
    expect(res.map((r) => r.exportedName)).toEqual([
      'History~2',
      'history~3',
      'Report~2',
      'Report',
      'REPORT~3', // ~2 was naturally taken by Sheet 3
      'café',
      'cafe\u0301~2'
    ]);
  });

  it('safely replaces lone surrogates without failing or emitting broken surrogates', () => {
    const resSheet = mapWorksheetNames([{ id: 7, title: 'Bad\uD800Surrogate\uDFFF' }]);
    expect(resSheet[0].exportedName).toBe('Bad\uFFFDSurrogate\uFFFD');
    const resCsv = mapCsvFilenames([{ id: 7, title: 'Bad\uD800Surrogate\uDFFF' }]);
    expect(resCsv[0].exportedName).toBe('Bad\uFFFDSurrogate\uFFFD.csv');
  });

  it('sanitizes OOXML-escaped patterns in worksheet names, handles collisions, 31-unit cap, and SheetJS roundtrip', async () => {
    const input: readonly SheetInput[] = [
      { id: 1, title: '_x0041_' },
      { id: 2, title: '-x0041_' },
      { id: 3, title: '_x0041_' },
      { id: 4, title: 'A'.repeat(24) + '_x0041_' },
      { id: 5, title: 'B'.repeat(25) + '_x0041_' }
    ];
    const res = mapWorksheetNames(input);
    expect(res).toEqual([
      { sheetId: 1, originalTitle: '_x0041_', exportedName: '-x0041_' },
      { sheetId: 2, originalTitle: '-x0041_', exportedName: '-x0041_~2' },
      { sheetId: 3, originalTitle: '_x0041_', exportedName: '-x0041_~3' },
      { sheetId: 4, originalTitle: 'A'.repeat(24) + '_x0041_', exportedName: 'A'.repeat(24) + '-x0041_' },
      { sheetId: 5, originalTitle: 'B'.repeat(25) + '_x0041_', exportedName: 'B'.repeat(25) + '-x0041' }
    ]);
    expect(res[3].exportedName.length).toBe(31);
    expect(res[4].exportedName.length).toBe(31);

    // Verify source metadata is never renamed
    expect(input[0].title).toBe('_x0041_');
    expect(input[1].title).toBe('-x0041_');
    expect(input[2].title).toBe('_x0041_');

    // Real SheetJS roundtrip verification
    const wb = new ExcelJS.Workbook();
    for (const m of res) {
      wb.addWorksheet(m.exportedName);
    }
    const buf = await wb.xlsx.writeBuffer();
    const readWb = XLSX.read(buf, { type: 'buffer' });
    expect(readWb.SheetNames).toEqual([
      '-x0041_',
      '-x0041_~2',
      '-x0041_~3',
      'A'.repeat(24) + '-x0041_',
      'B'.repeat(25) + '-x0041'
    ]);
  });

  it('maps CSV filenames: invalid Windows chars, trailing dots/spaces, traversal, and controlled .csv', () => {
    const input: readonly SheetInput[] = [
      { id: 101, title: 'Data<2026>:"Q1"|*?' },
      { id: 102, title: 'TrailingDots...   ' },
      { id: 103, title: '../../etc/passwd' },
      { id: 104, title: 'Monthly.csv' },
      { id: 105, title: '...' }
    ];
    const res = mapCsvFilenames(input);
    expect(res).toEqual([
      { sheetId: 101, originalTitle: 'Data<2026>:"Q1"|*?', exportedName: 'Data_2026___Q1____.csv' },
      { sheetId: 102, originalTitle: 'TrailingDots...   ', exportedName: 'TrailingDots.csv' },
      { sheetId: 103, originalTitle: '../../etc/passwd', exportedName: '.._.._etc_passwd.csv' },
      { sheetId: 104, originalTitle: 'Monthly.csv', exportedName: 'Monthly.csv.csv' },
      { sheetId: 105, originalTitle: '...', exportedName: 'Sheet_105.csv' }
    ]);
  });

  it('handles CSV Windows reserved devices, extensions, superscripts and collision suffixes', () => {
    const input: readonly SheetInput[] = [
      { id: 1, title: 'CON' },
      { id: 2, title: 'con.txt' },
      { id: 3, title: 'COM1' },
      { id: 4, title: 'COM¹' },
      { id: 5, title: 'LPT³' },
      { id: 6, title: 'AUX' },
      { id: 7, title: 'aux.log' }
    ];
    const res = mapCsvFilenames(input);
    expect(res.map((r) => r.exportedName)).toEqual([
      '_CON.csv',
      '_con.txt.csv',
      '_COM1.csv',
      '_COM¹.csv',
      '_LPT³.csv',
      '_AUX.csv',
      '_aux.log.csv'
    ]);
  });

  it('handles CSV collisions with prefixed reserved names and naturally-suffixed collisions', () => {
    const input: readonly SheetInput[] = [
      { id: 1, title: '_CON' },
      { id: 2, title: 'CON' },
      { id: 3, title: '_CON_2' },
      { id: 4, title: 'con' }
    ];
    const res = mapCsvFilenames(input);
    expect(res.map((r) => r.exportedName)).toEqual([
      '_CON.csv',
      '_CON_2.csv',
      '_CON_2_3.csv',
      '_con_4.csv'
    ]);
  });

  it('handles CSV case/NFC collisions and multiple collisions with numeric counter', () => {
    const input: readonly SheetInput[] = [
      { id: 10, title: 'Metric' },
      { id: 20, title: 'METRIC' },
      { id: 30, title: 'Metric_30' },
      { id: 31, title: 'Metric' } // collides with Metric, Metric_31 available
    ];
    const res = mapCsvFilenames(input);
    expect(res.map((r) => r.exportedName)).toEqual([
      'Metric.csv',
      'METRIC_20.csv',
      'Metric_30.csv',
      'Metric_31.csv'
    ]);

    // Many duplicate collisions on same sheet title
    const duplicates = [1, 2, 3, 4].map((id) => ({ id, title: 'Dup' }));
    const dupRes = mapCsvFilenames(duplicates);
    expect(dupRes.map((r) => r.exportedName)).toEqual([
      'Dup.csv',
      'Dup_2.csv',
      'Dup_3.csv',
      'Dup_4.csv'
    ]);
  });

  it('enforces CSV max 120 UTF-8 bytes cap and truncates by whole Unicode code points', () => {
    const encoder = new TextEncoder();
    const longEmoji = '🌟'.repeat(40); // 40 * 4 = 160 bytes
    const longCJK = '數據'.repeat(30); // 60 * 3 = 180 bytes
    const longReserved = 'CON.' + 'A'.repeat(120);
    const res = mapCsvFilenames([
      { id: 5, title: longEmoji },
      { id: 6, title: longCJK },
      { id: 7, title: longReserved }
    ]);
    for (const item of res) {
      const bytes = encoder.encode(item.exportedName).length;
      expect(bytes).toBeLessThanOrEqual(120);
      expect(item.exportedName.endsWith('.csv')).toBe(true);
    }
    expect(res[2].exportedName.startsWith('_CON.')).toBe(true);
  });

  it('validates input strictly, preserves source order, never mutates source, and is deterministic', () => {
    // Zero sheets
    expect(() => mapWorksheetNames([])).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    expect(() => mapCsvFilenames([])).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // Duplicate IDs
    expect(() =>
      mapWorksheetNames([
        { id: 1, title: 'A' },
        { id: 1, title: 'B' }
      ])
    ).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

    // Invalid ID / type
    for (const bad of [
      [{ id: -1, title: 'A' }],
      [{ id: 1.5, title: 'A' }],
      [{ id: '1' as unknown as number, title: 'A' }],
      [{ id: 1, title: null as unknown as string }]
    ]) {
      expect(() => mapWorksheetNames(bad as SheetInput[])).toThrowError(
        expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' })
      );
    }

    // Preserves source, immutability, non-consecutive IDs, stability
    const rawInput = Object.freeze([
      Object.freeze({ id: 9999, title: 'SparseTab' }),
      Object.freeze({ id: 42, title: 'EmptyTab' })
    ]);
    const r1 = mapWorksheetNames(rawInput);
    const r2 = mapWorksheetNames(rawInput);
    expect(r1).toEqual(r2);
    expect(r1[0].sheetId).toBe(9999);
    expect(r1[0].originalTitle).toBe('SparseTab');
    expect(r1[1].sheetId).toBe(42);
    expect(r1[1].originalTitle).toBe('EmptyTab');
  });

  it('formats safe workbook artifact filenames with allowed enum and Windows rules', () => {
    expect(formatWorkbookArtifactFilename('Financial 2026', 'xlsx')).toBe('Financial 2026.xlsx');
    expect(formatWorkbookArtifactFilename('Audit/Logs', 'json')).toBe('Audit_Logs.json');
    expect(formatWorkbookArtifactFilename('CON', 'zip')).toBe('_CON.zip');
    expect(formatWorkbookArtifactFilename('CON.txt', 'zip')).toBe('_CON.txt.zip');
    expect(formatWorkbookArtifactFilename('aux.data', 'xlsx')).toBe('_aux.data.xlsx');
    expect(formatWorkbookArtifactFilename('nul.tar', 'csv')).toBe('_nul.tar.csv');
    expect(formatWorkbookArtifactFilename('..', 'csv')).toBe('Workbook.csv');
    expect(formatWorkbookArtifactFilename('A'.repeat(150), 'xlsx').length).toBeLessThanOrEqual(120);
    expect(
      new TextEncoder().encode(
        formatWorkbookArtifactFilename('CON.' + 'A'.repeat(150), 'zip')
      ).length
    ).toBeLessThanOrEqual(120);

    // Rejects disallowed extensions
    expect(() =>
      formatWorkbookArtifactFilename('Book', 'exe' as unknown as 'xlsx')
    ).toThrowError(DomainError);
  });
});
