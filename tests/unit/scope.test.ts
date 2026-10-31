/**
 * T13 Scope Planning Unit Tests
 *
 * Validates immutable scope planning with reviewed parsers and contracts.
 * Tests exact plans from synthetic fixtures with small independent expected literals.
 */

import { describe, expect, it } from 'vitest';
import type { SheetMeta, WorkbookMeta } from '../../src/contracts/domain.ts';
import { buildScopePlan, type ScopeOptions } from '../../src/domain/scope.ts';
import {
  CANONICAL_EMPTY_SHEET_ID,
  CANONICAL_HIDDEN_SHEET_ID,
  CANONICAL_LIMITS_VERSION,
  CANONICAL_PRINCIPAL_KEY,
  CANONICAL_SPARSE_SHEET_ID,
  CANONICAL_SPREADSHEET_ID,
  createCanonicalSourceRef,
  createCanonicalWorkbookMeta,
  createSyntheticAccountContext
} from '../helpers/fixtures.ts';

describe('T13 buildScopePlan', () => {
  it('requires one explicit range-entry shape instead of silently accepting malformed alternatives', () => {
    for (const ranges of [new Map([[101, 'A1']]), { '0x65': 'A1' }, [{ sheetId: 101, range: 'A1' }]]) {
      expect(() => buildScopePlan(createCanonicalSourceRef(), createCanonicalWorkbookMeta(), createSyntheticAccountContext(), {
        mode: 'raw', format: 'json', visibility: 'include_all', limitsVersion: '1.0',
        ranges: ranges as unknown as NonNullable<ScopeOptions['ranges']>
      })).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    }
  });

  it('keeps default API-visible scope in source order even when metadata array is shuffled', () => {
    const workbook = createCanonicalWorkbookMeta();
    const plan = buildScopePlan(createCanonicalSourceRef(), { ...workbook, sheets: [...workbook.sheets].reverse() }, createSyntheticAccountContext(), {
      mode: 'raw', format: 'json', visibility: 'api_visible', limitsVersion: '1.0'
    });
    expect(plan.scopes).toEqual([
      { sheetId: 101, rect: { sheetId: 101, r0: 0, c0: 0, r1: 90000, c1: 26 } },
      { sheetId: 205, rect: { sheetId: 205, r0: 0, c0: 0, r1: 1000, c1: 26 } }
    ]);
  });
  const baseOptions: ScopeOptions = Object.freeze({
    mode: 'raw',
    format: 'json',
    visibility: 'include_all',
    limitsVersion: CANONICAL_LIMITS_VERSION
  });

  it('builds exact plan from canonical three-tab fixture with default visible tabs', () => {
    const source = createCanonicalSourceRef();
    const wb = createCanonicalWorkbookMeta();
    const account = createSyntheticAccountContext();

    const plan = buildScopePlan(source, wb, account, baseOptions);

    // Literal expectation: exactly two visible tabs in source index order
    expect(plan).toEqual({
      sourceId: CANONICAL_SPREADSHEET_ID,
      principalKey: CANONICAL_PRINCIPAL_KEY,
      mode: 'raw',
      format: 'json',
      visibility: 'include_all',
      limitsVersion: CANONICAL_LIMITS_VERSION,
      scopes: [
        {
          sheetId: CANONICAL_SPARSE_SHEET_ID,
          rect: {
            sheetId: CANONICAL_SPARSE_SHEET_ID,
            r0: 0,
            c0: 0,
            r1: 90000,
            c1: 26
          }
        },
        {
          sheetId: CANONICAL_EMPTY_SHEET_ID,
          rect: {
            sheetId: CANONICAL_EMPTY_SHEET_ID,
            r0: 0,
            c0: 0,
            r1: 1000,
            c1: 26
          }
        }
      ]
    });
  });

  it('includes visible empty tabs by default and excludes hidden tabs', () => {
    const source = createCanonicalSourceRef();
    const wb = createCanonicalWorkbookMeta();
    const account = createSyntheticAccountContext();

    const plan = buildScopePlan(source, wb, account, baseOptions);

    const sheetIds = plan.scopes.map(s => s.sheetId);
    expect(sheetIds).toContain(CANONICAL_EMPTY_SHEET_ID);
    expect(sheetIds).not.toContain(CANONICAL_HIDDEN_SHEET_ID);
    expect(plan.scopes).toHaveLength(2);
  });

  it('ignores highlightedSheetId in source: pointing to hidden or unknown sheet does not narrow selection', () => {
    const wb = createCanonicalWorkbookMeta();
    const account = createSyntheticAccountContext();

    // highlightedSheetId pointing to hidden tab
    const sourcePointingHidden = {
      spreadsheetId: CANONICAL_SPREADSHEET_ID,
      highlightedSheetId: CANONICAL_HIDDEN_SHEET_ID
    };
    const plan1 = buildScopePlan(sourcePointingHidden, wb, account, baseOptions);
    expect(plan1.scopes.map(s => s.sheetId)).toEqual([
      CANONICAL_SPARSE_SHEET_ID,
      CANONICAL_EMPTY_SHEET_ID
    ]);

    // highlightedSheetId pointing to non-existent tab
    const sourcePointingUnknown = {
      spreadsheetId: CANONICAL_SPREADSHEET_ID,
      highlightedSheetId: 99999
    };
    const plan2 = buildScopePlan(sourcePointingUnknown, wb, account, baseOptions);
    expect(plan2.scopes.map(s => s.sheetId)).toEqual([
      CANONICAL_SPARSE_SHEET_ID,
      CANONICAL_EMPTY_SHEET_ID
    ]);
  });

  it('supports explicit hidden tab opt-in when visibility is include_all', () => {
    const source = createCanonicalSourceRef();
    const wb = createCanonicalWorkbookMeta();
    const account = createSyntheticAccountContext();

    const options: ScopeOptions = {
      ...baseOptions,
      visibility: 'include_all',
      selectedSheetIds: [CANONICAL_HIDDEN_SHEET_ID]
    };

    const plan = buildScopePlan(source, wb, account, options);

    expect(plan.scopes).toEqual([
      {
        sheetId: CANONICAL_HIDDEN_SHEET_ID,
        rect: {
          sheetId: CANONICAL_HIDDEN_SHEET_ID,
          r0: 0,
          c0: 0,
          r1: 100,
          c1: 10
        }
      }
    ]);
  });

  it('rejects selecting hidden tab when visibility is api_visible (SOURCE_UNSUPPORTED)', () => {
    const source = createCanonicalSourceRef();
    const wb = createCanonicalWorkbookMeta();
    const account = createSyntheticAccountContext();

    const options: ScopeOptions = {
      ...baseOptions,
      visibility: 'api_visible',
      selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID, CANONICAL_HIDDEN_SHEET_ID]
    };

    expect(() => buildScopePlan(source, wb, account, options)).toThrowError(
      expect.objectContaining({
        name: 'DomainError',
        code: 'SOURCE_UNSUPPORTED'
      })
    );
  });

  it('reorders selected sheet IDs to source index order regardless of input selection order', () => {
    const source = createCanonicalSourceRef();
    const wb = createCanonicalWorkbookMeta();
    const account = createSyntheticAccountContext();

    // Input order is reversed: EmptyTab (index 1) then SparseTab (index 0)
    const options: ScopeOptions = {
      ...baseOptions,
      selectedSheetIds: [CANONICAL_EMPTY_SHEET_ID, CANONICAL_SPARSE_SHEET_ID]
    };

    const plan = buildScopePlan(source, wb, account, options);

    expect(plan.scopes.map(s => s.sheetId)).toEqual([
      CANONICAL_SPARSE_SHEET_ID,
      CANONICAL_EMPTY_SHEET_ID
    ]);
  });

  it('handles non-consecutive sheet IDs without index-id conflation', () => {
    const source = createCanonicalSourceRef();
    const wb = createCanonicalWorkbookMeta();
    const account = createSyntheticAccountContext();

    // IDs are 101, 205, 309, none equal to index 0, 1, 2
    const options: ScopeOptions = {
      ...baseOptions,
      selectedSheetIds: [CANONICAL_EMPTY_SHEET_ID]
    };

    const plan = buildScopePlan(source, wb, account, options);

    expect(plan.scopes).toHaveLength(1);
    expect(plan.scopes[0].sheetId).toBe(205);
    expect(plan.scopes[0].rect.sheetId).toBe(205);
  });

  it('resolves exact C5:D6, single cell, and whole-row rectangles via reviewed A1 parser', () => {
    const source = createCanonicalSourceRef();
    const wb = createCanonicalWorkbookMeta();
    const account = createSyntheticAccountContext();

    // 1. C5:D6 on SparseTab
    const planC5D6 = buildScopePlan(source, wb, account, {
      ...baseOptions,
      selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID],
      ranges: [{ sheetId: CANONICAL_SPARSE_SHEET_ID, a1: 'C5:D6' }]
    });
    expect(planC5D6.scopes[0].rect).toEqual({
      sheetId: CANONICAL_SPARSE_SHEET_ID,
      r0: 4,
      c0: 2,
      r1: 6,
      c1: 4
    });

    // 2. Single cell A1 on SparseTab
    const planA1 = buildScopePlan(source, wb, account, {
      ...baseOptions,
      selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID],
      ranges: [{ sheetId: CANONICAL_SPARSE_SHEET_ID, a1: 'A1' }]
    });
    expect(planA1.scopes[0].rect).toEqual({
      sheetId: CANONICAL_SPARSE_SHEET_ID,
      r0: 0,
      c0: 0,
      r1: 1,
      c1: 1
    });

    // 3. Whole-row 5:6 on SparseTab (resolved against columns=26)
    const planRow = buildScopePlan(source, wb, account, {
      ...baseOptions,
      selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID],
      ranges: [{ sheetId: CANONICAL_SPARSE_SHEET_ID, a1: '5:6' }]
    });
    expect(planRow.scopes[0].rect).toEqual({
      sheetId: CANONICAL_SPARSE_SHEET_ID,
      r0: 4,
      c0: 0,
      r1: 6,
      c1: 26
    });

    // 4. Record mapping format and sheet prefix
    const planRecord = buildScopePlan(source, wb, account, {
      ...baseOptions,
      selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID],
      ranges: [{ sheetId: CANONICAL_SPARSE_SHEET_ID, a1: "'SparseTab'!C5:D6" }]
    });
    expect(planRecord.scopes[0].rect).toEqual({
      sheetId: CANONICAL_SPARSE_SHEET_ID,
      r0: 4,
      c0: 2,
      r1: 6,
      c1: 4
    });
  });

  describe('Validation: empty, unknown, and duplicate inputs', () => {
    const source = createCanonicalSourceRef();
    const wb = createCanonicalWorkbookMeta();
    const account = createSyntheticAccountContext();

    it('rejects explicit empty sheet selection with RANGE_EMPTY', () => {
      expect(() =>
        buildScopePlan(source, wb, account, {
          ...baseOptions,
          selectedSheetIds: []
        })
      ).toThrowError(expect.objectContaining({ code: 'RANGE_EMPTY' }));
    });

    it('rejects default selection when workbook has 0 visible tabs with RANGE_EMPTY', () => {
      const allHiddenWb: WorkbookMeta = {
        ...wb,
        sheets: wb.sheets.map(s => ({ ...s, hidden: true }))
      };
      expect(() =>
        buildScopePlan(source, allHiddenWb, account, baseOptions)
      ).toThrowError(expect.objectContaining({ code: 'RANGE_EMPTY' }));
    });

    it('rejects unknown sheet IDs with RANGE_INVALID', () => {
      expect(() =>
        buildScopePlan(source, wb, account, {
          ...baseOptions,
          selectedSheetIds: [99999]
        })
      ).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    });

    it('rejects duplicate sheet IDs in selection with RANGE_INVALID', () => {
      expect(() =>
        buildScopePlan(source, wb, account, {
          ...baseOptions,
          selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID, CANONICAL_SPARSE_SHEET_ID]
        })
      ).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    });

    it('rejects duplicate range entries for the same sheet with RANGE_INVALID', () => {
      expect(() =>
        buildScopePlan(source, wb, account, {
          ...baseOptions,
          selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID],
          ranges: [
            { sheetId: CANONICAL_SPARSE_SHEET_ID, a1: 'A1:B2' },
            { sheetId: CANONICAL_SPARSE_SHEET_ID, a1: 'C3:D4' }
          ]
        })
      ).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    });

    it('rejects range entry for unselected sheet with RANGE_INVALID', () => {
      expect(() =>
        buildScopePlan(source, wb, account, {
          ...baseOptions,
          selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID],
          ranges: [{ sheetId: CANONICAL_EMPTY_SHEET_ID, a1: 'A1:B2' }]
        })
      ).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    });

    it('propagates RANGE_OUT_OF_BOUNDS from A1 parser when range exceeds sheet dimensions', () => {
      expect(() =>
        buildScopePlan(source, wb, account, {
          ...baseOptions,
          selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID],
          ranges: [{ sheetId: CANONICAL_SPARSE_SHEET_ID, a1: 'AA1' }] // SparseTab only has 26 columns (A-Z)
        })
      ).toThrowError(expect.objectContaining({ code: 'RANGE_OUT_OF_BOUNDS' }));
    });

    it('propagates RANGE_INVALID from A1 parser on malformed A1 syntax', () => {
      expect(() =>
        buildScopePlan(source, wb, account, {
          ...baseOptions,
          selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID],
          ranges: [{ sheetId: CANONICAL_SPARSE_SHEET_ID, a1: 'invalid-syntax' }]
        })
      ).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    });
  });

  describe('Validation: source matching, unsupported sheets, and invalid metadata', () => {
    const wb = createCanonicalWorkbookMeta();
    const account = createSyntheticAccountContext();

    it('rejects mismatched source spreadsheet ID with SOURCE_UNSUPPORTED', () => {
      const mismatchedSource = {
        spreadsheetId: 'different-spreadsheet-id-456'
      };
      expect(() =>
        buildScopePlan(mismatchedSource, wb, account, baseOptions)
      ).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    });

    it('allows unselected unsupported sheet type (e.g. OBJECT) but rejects when selected', () => {
      const source = createCanonicalSourceRef();
      const objectSheet: SheetMeta = {
        id: 404,
        title: 'ChartSheet',
        index: 3,
        type: 'OBJECT',
        hidden: false
      };
      const wbWithObject: WorkbookMeta = {
        ...wb,
        sheets: [...wb.sheets, objectSheet]
      };

      // 1. Explicit selection of GRID tabs only: unselected OBJECT tab does NOT poison
      const plan = buildScopePlan(source, wbWithObject, account, {
        ...baseOptions,
        selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID, CANONICAL_EMPTY_SHEET_ID]
      });
      expect(plan.scopes).toHaveLength(2);

      // 2. Explicit selection of the OBJECT tab: rejected with SOURCE_UNSUPPORTED
      expect(() =>
        buildScopePlan(source, wbWithObject, account, {
          ...baseOptions,
          selectedSheetIds: [404]
        })
      ).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

      // 3. Default visible selection when OBJECT tab is visible: never silently skips selected tab
      expect(() =>
        buildScopePlan(source, wbWithObject, account, baseOptions)
      ).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    });

    it('rejects selected sheet with invalid or non-positive grid bounds', () => {
      const source = createCanonicalSourceRef();
      const zeroRowSheet: SheetMeta = {
        id: 501,
        title: 'ZeroRowTab',
        index: 3,
        type: 'GRID',
        hidden: false,
        rows: 0,
        columns: 10
      };
      const wbWithZeroRow: WorkbookMeta = {
        ...wb,
        sheets: [...wb.sheets, zeroRowSheet]
      };

      expect(() =>
        buildScopePlan(source, wbWithZeroRow, account, {
          ...baseOptions,
          selectedSheetIds: [501]
        })
      ).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    });

    it('rejects ambiguous duplicate sheet IDs or source indexes in workbook metadata', () => {
      const source = createCanonicalSourceRef();

      // Duplicate sheet ID
      const dupIdWb: WorkbookMeta = {
        ...wb,
        sheets: [
          wb.sheets[0],
          { ...wb.sheets[1], id: wb.sheets[0].id }
        ]
      };
      expect(() =>
        buildScopePlan(source, dupIdWb, account, baseOptions)
      ).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));

      // Duplicate sheet index
      const dupIndexWb: WorkbookMeta = {
        ...wb,
        sheets: [
          wb.sheets[0],
          { ...wb.sheets[1], index: wb.sheets[0].index }
        ]
      };
      expect(() =>
        buildScopePlan(source, dupIndexWb, account, baseOptions)
      ).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    });

    it('rejects invalid enum options', () => {
      const source = createCanonicalSourceRef();

      // Invalid format
      expect(() =>
        buildScopePlan(source, wb, account, {
          ...baseOptions,
          format: 'pdf' as ScopeOptions['format']
        })
      ).toThrowError(expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' }));

      // Invalid mode
      expect(() =>
        buildScopePlan(source, wb, account, {
          ...baseOptions,
          mode: 'unsupported_mode' as ScopeOptions['mode']
        })
      ).toThrowError(expect.objectContaining({ code: 'FORMAT_UNSUPPORTED' }));

      // Invalid visibility
      expect(() =>
        buildScopePlan(source, wb, account, {
          ...baseOptions,
          visibility: 'unknown_visibility' as ScopeOptions['visibility']
        })
      ).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));

      // Missing limitsVersion
      expect(() =>
        buildScopePlan(source, wb, account, {
          ...baseOptions,
          limitsVersion: ''
        })
      ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    });

    it('rejects missing or empty account principalKey with AUTH_REQUIRED', () => {
      const source = createCanonicalSourceRef();
      const emptyAccount = { principalKey: '  ', displayEmail: 'user@example.com' };
      expect(() =>
        buildScopePlan(source, wb, emptyAccount, baseOptions)
      ).toThrowError(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    });
  });

  describe('Immutability and Isolation', () => {
    it('returns a deeply frozen copy without freezing or mutating caller inputs', () => {
      const source = createCanonicalSourceRef();
      const wb = createCanonicalWorkbookMeta();
      const account = createSyntheticAccountContext();
      const selectedIds = [CANONICAL_EMPTY_SHEET_ID, CANONICAL_SPARSE_SHEET_ID];
      const ranges = [{ sheetId: CANONICAL_SPARSE_SHEET_ID, a1: 'C5:D6' }];
      const options: ScopeOptions = {
        mode: 'raw',
        format: 'json',
        visibility: 'include_all',
        limitsVersion: CANONICAL_LIMITS_VERSION,
        selectedSheetIds: selectedIds,
        ranges
      };

      const plan = buildScopePlan(source, wb, account, options);

      // Returned plan and nested structures are frozen
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.scopes)).toBe(true);
      expect(Object.isFrozen(plan.scopes[0])).toBe(true);
      expect(Object.isFrozen(plan.scopes[0].rect)).toBe(true);
      expect(Object.isFrozen(plan.scopes[1])).toBe(true);
      expect(Object.isFrozen(plan.scopes[1].rect)).toBe(true);

      // Caller inputs remain unfrozen and mutable
      expect(Object.isFrozen(source)).toBe(false);
      expect(Object.isFrozen(wb)).toBe(false);
      expect(Object.isFrozen(account)).toBe(false);
      expect(Object.isFrozen(options)).toBe(false);
      expect(Object.isFrozen(selectedIds)).toBe(false);
      expect(Object.isFrozen(ranges)).toBe(false);

      // Mutating caller inputs after buildScopePlan does not alter the returned plan
      selectedIds.push(CANONICAL_HIDDEN_SHEET_ID);
      ranges.push({ sheetId: CANONICAL_EMPTY_SHEET_ID, a1: 'A1:B2' });

      expect(plan.scopes).toHaveLength(2);
      expect(plan.scopes[0].sheetId).toBe(CANONICAL_SPARSE_SHEET_ID);
      expect(plan.scopes[1].sheetId).toBe(CANONICAL_EMPTY_SHEET_ID);
    });
  });
});
