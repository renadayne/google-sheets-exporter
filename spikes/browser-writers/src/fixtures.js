export function createSyntheticWorkbookFixture() {
  const maxExcelCellText = 'MaxLen32767:' + 'X'.repeat(32767 - 12);
  return {
    source: {
      id: 'synthetic-spike-t04',
      title: 'T04 Synthetic Workbook',
      locale: 'en_US',
      timeZone: 'Asia/Ho_Chi_Minh'
    },
    startedAt: '2026-10-30T17:00:00.000Z',
    producedAt: '2026-10-30T17:00:02.000Z',
    mode: 'raw',
    visibility: 'include_all',
    limitsVersion: 'v1-spike',
    sheets: [
      {
        id: 101,
        title: "Sales '26 — Đông Á",
        index: 0,
        scope: { r0: 0, c0: 0, r1: 90000, c1: 26 },
        exclusions: { excludedRows: [], excludedColumns: [] },
        cells: [
          { r: 0, c: 0, kind: 'string', value: '00123' },
          { r: 0, c: 1, kind: 'number', value: -42.5 },
          { r: 0, c: 2, kind: 'boolean', value: true },
          {
            r: 0,
            c: 3,
            kind: 'error',
            value: { code: '#DIV/0!', message: 'Function DIVIDE parameter 2 cannot be zero.' }
          },
          { r: 1, c: 0, kind: 'string', value: '=SUM(1,1)' },
          { r: 1, c: 1, kind: 'string', value: "+cmd|' /C calc'!A0" },
          { r: 1, c: 2, kind: 'string', value: '-2+3' },
          { r: 1, c: 3, kind: 'string', value: '@SUM(A1:A2)' },
          { r: 1, c: 4, kind: 'string', value: ' \t=HYPERLINK("https://evil.example","click")' },
          { r: 1, c: 5, kind: 'string', value: 'https://docs.google.com/spreadsheets/d/123' },
          { r: 1, c: 6, kind: 'string', value: 'Line 1\r\n"Quoted, text"\nLine 3 emoji 🧪' },
          { r: 1, c: 7, kind: 'string', value: '' },
          { r: 49, c: 3, kind: 'string', value: 'middle' },
          { r: 89999, c: 25, kind: 'number', value: 42 }
        ]
      },
      {
        id: 202,
        title: 'Empty_Sheet',
        index: 1,
        scope: { r0: 0, c0: 0, r1: 5, c1: 4 },
        exclusions: { excludedRows: [], excludedColumns: [] },
        cells: []
      },
      {
        id: 303,
        title: "'Cafe's [2026]*?/\\LongTitle_Exceeding_ThirtyOne_Chars'",
        index: 2,
        scope: { r0: 4, c0: 2, r1: 8, c1: 6 },
        exclusions: { excludedRows: [], excludedColumns: [] },
        cells: [
          { r: 4, c: 2, kind: 'string', value: 'Origin C5' },
          { r: 5, c: 3, kind: 'string', value: maxExcelCellText },
          { r: 6, c: 4, kind: 'boolean', value: false },
          { r: 7, c: 5, kind: 'number', value: 99.95 }
        ]
      }
    ]
  };
}

export const NAME_EDGE_CASES = [
  { id: 1, title: "Sales '26 — Đông Á" },
  { id: 2, title: 'Empty_Sheet' },
  { id: 3, title: "'Cafe's [2026]*?/\\LongTitle_Exceeding_ThirtyOne_Chars'" },
  { id: 4, title: 'sales \'26 — đông á' },
  { id: 5, title: 'History' },
  { id: 6, title: 'history' },
  { id: 7, title: '[*?:/\\]' },
  { id: 8, title: 'CON' }
];
