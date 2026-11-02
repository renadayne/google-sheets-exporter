import { describe, it, expect } from 'vitest';
import type {
  ExportRequest,
  SheetMeta,
  WorkbookMeta,
} from '../../src/contracts/domain.ts';
import { buildScopePlan } from '../../src/domain/scope.ts';
import {
  projectWriterContext,
  PROVISIONAL_MAX_SHEETS,
} from '../../src/jobs/writer-context.ts';
import {
  createCanonicalSourceRef,
  createCanonicalWorkbookMeta,
  createSyntheticAccountContext,
  CANONICAL_SPREADSHEET_ID,
  CANONICAL_PRINCIPAL_KEY,
  CANONICAL_LIMITS_VERSION,
  CANONICAL_SPARSE_SHEET_ID,
  CANONICAL_EMPTY_SHEET_ID,
  CANONICAL_HIDDEN_SHEET_ID,
} from '../helpers/fixtures.ts';

function buildCanonicalTestRequest(options?: {
  readonly mode?: 'formatted' | 'raw' | 'formula_text';
  readonly format?: 'xlsx' | 'csv' | 'json';
  readonly visibility?: 'include_all' | 'api_visible';
  readonly selectedSheetIds?: readonly number[];
}): ExportRequest {
  const scopeOptions: {
    mode: 'formatted' | 'raw' | 'formula_text';
    format: 'xlsx' | 'csv' | 'json';
    visibility: 'include_all' | 'api_visible';
    limitsVersion: string;
    selectedSheetIds?: readonly number[];
  } = {
    mode: options?.mode ?? 'raw',
    format: options?.format ?? 'json',
    visibility: options?.visibility ?? 'include_all',
    limitsVersion: CANONICAL_LIMITS_VERSION,
  };
  if (options?.selectedSheetIds !== undefined) {
    scopeOptions.selectedSheetIds = options.selectedSheetIds;
  }
  return buildScopePlan(
    createCanonicalSourceRef(),
    createCanonicalWorkbookMeta(),
    createSyntheticAccountContext(),
    scopeOptions
  );
}

describe('T30d Bounded Sanitized Writer Context Projection', () => {
  // Group 1: Exact whole expected Context and all nested types
  describe('Group 1: Exact whole expected Context and all nested types', () => {
    it('projects valid request and workbook into exact eleven-field WriterContext with all nested types', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const canonicalWb = createCanonicalWorkbookMeta();

      const context = projectWriterContext(canonicalReq, canonicalWb);
      expect(context).not.toBeNull();
      if (!context) return;

      // Exact 11 root fields
      expect(context.sourceId).toBe(CANONICAL_SPREADSHEET_ID);
      expect(context.title).toBe('Canonical Test Workbook');
      expect(context.locale).toBe('en_US');
      expect(context.timeZone).toBe('UTC');
      expect(context.mode).toBe('raw');
      expect(context.format).toBe('json');
      expect(context.visibility).toBe('include_all');
      expect(context.limitsVersion).toBe(CANONICAL_LIMITS_VERSION);

      // sheetOrder matches scopes sheetId order
      expect(context.sheetOrder).toEqual([
        CANONICAL_SPARSE_SHEET_ID,
        CANONICAL_EMPTY_SHEET_ID,
      ]);

      // Scopes array & nested rects
      expect(context.scopes).toHaveLength(2);
      expect(context.scopes[0]).toEqual({
        sheetId: CANONICAL_SPARSE_SHEET_ID,
        rect: {
          sheetId: CANONICAL_SPARSE_SHEET_ID,
          r0: 0,
          c0: 0,
          r1: 90000,
          c1: 26,
        },
      });
      expect(context.scopes[1]).toEqual({
        sheetId: CANONICAL_EMPTY_SHEET_ID,
        rect: {
          sheetId: CANONICAL_EMPTY_SHEET_ID,
          r0: 0,
          c0: 0,
          r1: 1000,
          c1: 26,
        },
      });

      // Sheets array & nested SheetMeta
      expect(context.sheets).toHaveLength(2);
      expect(context.sheets[0]).toEqual({
        id: CANONICAL_SPARSE_SHEET_ID,
        title: 'SparseTab',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: 90000,
        columns: 26,
      });
      expect(context.sheets[1]).toEqual({
        id: CANONICAL_EMPTY_SHEET_ID,
        title: 'EmptyTab',
        index: 1,
        type: 'GRID',
        hidden: false,
        rows: 1000,
        columns: 26,
      });
    });

    it('accepts workbook with empty string title', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const wb = { ...createCanonicalWorkbookMeta(), title: '' };

      const context = projectWriterContext(canonicalReq, wb);
      expect(context).not.toBeNull();
      expect(context?.title).toBe('');
    });

    it('accepts workbook without optional sourceVersionObservation', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const wb: any = createCanonicalWorkbookMeta();
      delete wb.sourceVersionObservation;

      const context = projectWriterContext(canonicalReq, wb);
      expect(context).not.toBeNull();
      expect(context?.sourceId).toBe(CANONICAL_SPREADSHEET_ID);
    });

    it('accepts workbook and sheet records with null prototype', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const canonicalWb = createCanonicalWorkbookMeta();

      const nullProtoWb = Object.create(null);
      nullProtoWb.id = canonicalWb.id;
      nullProtoWb.title = canonicalWb.title;
      nullProtoWb.locale = canonicalWb.locale;
      nullProtoWb.timeZone = canonicalWb.timeZone;
      nullProtoWb.sheets = canonicalWb.sheets.map((s) => {
        const nullProtoSheet = Object.create(null);
        Object.assign(nullProtoSheet, s);
        return nullProtoSheet;
      });

      const context = projectWriterContext(canonicalReq, nullProtoWb);
      expect(context).not.toBeNull();
      expect(context?.sourceId).toBe(CANONICAL_SPREADSHEET_ID);
      expect(context?.sheets).toHaveLength(2);
    });
  });

  // Group 2: Principal, request-only, observation, and unselected fields absent
  describe('Group 2: Principal, request-only, observation, and unselected fields absent', () => {
    it('completely excludes principalKey and credential fields from projected context', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const canonicalWb = createCanonicalWorkbookMeta();

      const context: any = projectWriterContext(canonicalReq, canonicalWb);
      expect(context).not.toBeNull();

      expect(context.principalKey).toBeUndefined();
      expect('principalKey' in context).toBe(false);
      expect('displayEmail' in context).toBe(false);
      expect('accessToken' in context).toBe(false);
      expect('refreshToken' in context).toBe(false);
      expect('token' in context).toBe(false);
      expect('account' in context).toBe(false);
      expect('authorization' in context).toBe(false);
      expect('headers' in context).toBe(false);
    });

    it('excludes sourceVersionObservation from projected context', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const canonicalWb = createCanonicalWorkbookMeta();
      expect(canonicalWb.sourceVersionObservation).toBe('synthetic-v1');

      const context: any = projectWriterContext(canonicalReq, canonicalWb);
      expect(context).not.toBeNull();
      expect(context.sourceVersionObservation).toBeUndefined();
      expect('sourceVersionObservation' in context).toBe(false);
    });

    it('excludes unselected sheet metadata from projected context', () => {
      // Select only the first tab (CANONICAL_SPARSE_SHEET_ID)
      const singleTabReq = buildCanonicalTestRequest({
        selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID],
      });
      const canonicalWb = createCanonicalWorkbookMeta();

      const context = projectWriterContext(singleTabReq, canonicalWb);
      expect(context).not.toBeNull();
      expect(context?.sheetOrder).toEqual([CANONICAL_SPARSE_SHEET_ID]);
      expect(context?.sheets).toHaveLength(1);
      expect(context?.sheets[0].id).toBe(CANONICAL_SPARSE_SHEET_ID);

      // Verify unselected sheets (205, 309) are not present
      const sheetIds = context?.sheets.map((s) => s.id);
      expect(sheetIds).not.toContain(CANONICAL_EMPTY_SHEET_ID);
      expect(sheetIds).not.toContain(CANONICAL_HIDDEN_SHEET_ID);
    });

    it('contains exactly the eleven allowed root keys without extras', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const canonicalWb = createCanonicalWorkbookMeta();

      const context = projectWriterContext(canonicalReq, canonicalWb);
      expect(context).not.toBeNull();
      if (!context) return;

      const expectedKeys = [
        'format',
        'limitsVersion',
        'locale',
        'mode',
        'scopes',
        'sheetOrder',
        'sheets',
        'sourceId',
        'timeZone',
        'title',
        'visibility',
      ].sort();

      const actualKeys = Object.keys(context).sort();
      expect(actualKeys).toEqual(expectedKeys);
    });
  });

  // Group 3: All formats, modes, and visibilities projected
  describe('Group 3: All formats, modes, and visibilities projected', () => {
    it.each([
      { format: 'xlsx' as const },
      { format: 'csv' as const },
      { format: 'json' as const },
    ])('projects format "$format" faithfully', ({ format }) => {
      const req = buildCanonicalTestRequest({ format });
      const context = projectWriterContext(req, createCanonicalWorkbookMeta());
      expect(context?.format).toBe(format);
    });

    it.each([
      { mode: 'formatted' as const },
      { mode: 'raw' as const },
      { mode: 'formula_text' as const },
    ])('projects mode "$mode" faithfully', ({ mode }) => {
      const req = buildCanonicalTestRequest({ mode });
      const context = projectWriterContext(req, createCanonicalWorkbookMeta());
      expect(context?.mode).toBe(mode);
    });

    it.each([
      { visibility: 'include_all' as const },
      { visibility: 'api_visible' as const },
    ])('projects visibility "$visibility" faithfully for visible tabs', ({ visibility }) => {
      const req = buildCanonicalTestRequest({
        visibility,
        selectedSheetIds: [CANONICAL_SPARSE_SHEET_ID],
      });
      const context = projectWriterContext(req, createCanonicalWorkbookMeta());
      expect(context?.visibility).toBe(visibility);
    });
  });

  // Group 4: Non-numeric source order preserved
  describe('Group 4: Non-numeric source order preserved', () => {
    it('preserves tab index order when sheet IDs are non-numerically ordered', () => {
      // In this workbook, tab 0 has id 888 and tab 1 has id 111 (888 > 111)
      const customWb: WorkbookMeta = {
        id: CANONICAL_SPREADSHEET_ID,
        title: 'Nonnumeric Order Test',
        locale: 'en_US',
        timeZone: 'UTC',
        sheets: [
          {
            id: 888,
            title: 'FirstTabHighId',
            index: 0,
            type: 'GRID',
            hidden: false,
            rows: 50,
            columns: 10,
          },
          {
            id: 111,
            title: 'SecondTabLowId',
            index: 1,
            type: 'GRID',
            hidden: false,
            rows: 60,
            columns: 12,
          },
        ],
      };

      const req = buildScopePlan(
        createCanonicalSourceRef(),
        customWb,
        createSyntheticAccountContext(),
        {
          mode: 'raw',
          format: 'json',
          visibility: 'include_all',
          limitsVersion: CANONICAL_LIMITS_VERSION,
        }
      );

      const context = projectWriterContext(req, customWb);
      expect(context).not.toBeNull();
      // Must preserve source tab index order [888, 111], NOT numerical order [111, 888]
      expect(context?.sheetOrder).toEqual([888, 111]);
      expect(context?.sheets[0].id).toBe(888);
      expect(context?.sheets[0].title).toBe('FirstTabHighId');
      expect(context?.sheets[1].id).toBe(111);
      expect(context?.sheets[1].title).toBe('SecondTabLowId');
    });
  });

  // Group 5: Hidden opt-in honored, unselected unsupported sheet with missing bounds and hostile unused getters not touched
  describe('Group 5: Hidden opt-in and unselected sheet isolation', () => {
    it('honors hidden opt-in with include_all and rejects hidden tab under api_visible', () => {
      const canonicalWb = createCanonicalWorkbookMeta();
      // Select hidden tab (CANONICAL_HIDDEN_SHEET_ID: 309) with include_all
      const includeAllReq = buildScopePlan(
        createCanonicalSourceRef(),
        canonicalWb,
        createSyntheticAccountContext(),
        {
          mode: 'raw',
          format: 'json',
          visibility: 'include_all',
          limitsVersion: CANONICAL_LIMITS_VERSION,
          selectedSheetIds: [CANONICAL_HIDDEN_SHEET_ID],
        }
      );

      const includeAllContext = projectWriterContext(includeAllReq, canonicalWb);
      expect(includeAllContext).not.toBeNull();
      expect(includeAllContext?.sheets[0].id).toBe(CANONICAL_HIDDEN_SHEET_ID);
      expect(includeAllContext?.sheets[0].hidden).toBe(true);

      // Attempting to project a hidden tab under api_visible must safely return null
      const invalidApiVisibleReq: any = {
        ...includeAllReq,
        visibility: 'api_visible',
      };
      const apiVisibleContext = projectWriterContext(invalidApiVisibleReq, canonicalWb);
      expect(apiVisibleContext).toBeNull();
    });

    it('does not allow unselected unsupported sheet with missing bounds to poison valid selection', () => {
      // Workbook with a valid selected sheet and unselected unsupported sheets
      const mixedWb: WorkbookMeta = {
        id: CANONICAL_SPREADSHEET_ID,
        title: 'Mixed Sheets Test',
        locale: 'en_US',
        timeZone: 'UTC',
        sheets: [
          {
            id: 101,
            title: 'ValidGrid',
            index: 0,
            type: 'GRID',
            hidden: false,
            rows: 100,
            columns: 20,
          },
          {
            id: 401,
            title: 'DataSourceSheet',
            index: 1,
            type: 'DATA_SOURCE',
            hidden: false,
            // rows & columns missing for non-grid source
          },
          {
            id: 402,
            title: 'ObjectSheet',
            index: 2,
            type: 'OBJECT',
            hidden: false,
            // bounds missing
          },
        ],
      };

      const req = buildScopePlan(
        createCanonicalSourceRef(),
        mixedWb,
        createSyntheticAccountContext(),
        {
          mode: 'raw',
          format: 'json',
          visibility: 'include_all',
          limitsVersion: CANONICAL_LIMITS_VERSION,
          selectedSheetIds: [101],
        }
      );

      const context = projectWriterContext(req, mixedWb);
      expect(context).not.toBeNull();
      expect(context?.sheets).toHaveLength(1);
      expect(context?.sheets[0].id).toBe(101);
      expect(context?.sheets[0].type).toBe('GRID');
    });

    it('never accesses hostile unused getters on unselected sheets', () => {
      let hostileGetterCalled = false;
      const hostileUnselectedSheet: SheetMeta = {
        id: 999,
        get title(): string {
          hostileGetterCalled = true;
          throw new Error('Hostile getter title accessed!');
        },
        index: 1,
        get type(): any {
          hostileGetterCalled = true;
          throw new Error('Hostile getter type accessed!');
        },
        hidden: false,
        get rows(): any {
          hostileGetterCalled = true;
          throw new Error('Hostile getter rows accessed!');
        },
        get columns(): any {
          hostileGetterCalled = true;
          throw new Error('Hostile getter columns accessed!');
        },
      };

      const selectedGridSheet: SheetMeta = {
        id: 101,
        title: 'SelectedGrid',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: 100,
        columns: 10,
      };

      // Clean predecessor helper workbook to build valid ExportRequest selecting only sheet 101
      const cleanWb: WorkbookMeta = {
        id: CANONICAL_SPREADSHEET_ID,
        title: 'Clean Predecessor Test',
        locale: 'en_US',
        timeZone: 'UTC',
        sheets: [
          selectedGridSheet,
          {
            id: 999,
            title: 'CleanUnselected',
            index: 1,
            type: 'GRID',
            hidden: false,
            rows: 50,
            columns: 5,
          },
        ],
      };

      const req = buildScopePlan(
        createCanonicalSourceRef(),
        cleanWb,
        createSyntheticAccountContext(),
        {
          mode: 'raw',
          format: 'json',
          visibility: 'include_all',
          limitsVersion: CANONICAL_LIMITS_VERSION,
          selectedSheetIds: [101],
        }
      );

      // Now pass the workbook containing hostile unselected getters to projectWriterContext
      const wbWithHostile: WorkbookMeta = {
        id: CANONICAL_SPREADSHEET_ID,
        title: 'Hostile Unselected Test',
        locale: 'en_US',
        timeZone: 'UTC',
        sheets: [selectedGridSheet, hostileUnselectedSheet],
      };

      const context = projectWriterContext(req, wbWithHostile);
      expect(context).not.toBeNull();
      expect(context?.sheets).toHaveLength(1);
      expect(context?.sheets[0].id).toBe(101);
      expect(hostileGetterCalled).toBe(false);
    });
  });

  // Group 6: Rejection of source mismatch, missing, duplicate, selected unsupported, bounds, and order without narrowing
  describe('Group 6: Rejection of source mismatch, missing, duplicate, selected unsupported, bounds, and order', () => {
    it('rejects sourceId mismatch between request and workbook', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const mismatchedWb = {
        ...createCanonicalWorkbookMeta(),
        id: 'different-source-id-1234567890',
      };

      expect(projectWriterContext(canonicalReq, mismatchedWb)).toBeNull();
    });

    it('rejects when requested sheetId is missing from workbook without narrowing', () => {
      const canonicalReq = buildCanonicalTestRequest();
      // Workbook only contains sheet 101, but request expects 101 and 205
      const missingTabWb = {
        ...createCanonicalWorkbookMeta(),
        sheets: [createCanonicalWorkbookMeta().sheets[0]],
      };

      expect(projectWriterContext(canonicalReq, missingTabWb)).toBeNull();
    });

    it('rejects duplicate sheet IDs in workbook globally', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const dupWb = createCanonicalWorkbookMeta();
      (dupWb.sheets as any) = [
        dupWb.sheets[0],
        { ...dupWb.sheets[1], id: dupWb.sheets[0].id }, // duplicate ID 101
      ];

      expect(projectWriterContext(canonicalReq, dupWb)).toBeNull();
    });

    it('rejects when selected sheet has unsupported non-grid type', () => {
      const canonicalReq = buildCanonicalTestRequest({ selectedSheetIds: [101] });
      const nonGridWb = createCanonicalWorkbookMeta();
      (nonGridWb.sheets as any)[0] = {
        ...nonGridWb.sheets[0],
        type: 'OBJECT',
      };

      expect(projectWriterContext(canonicalReq, nonGridWb)).toBeNull();
    });

    it('rejects when selected sheet bounds are exceeded by scope rectangle', () => {
      const canonicalReq = buildCanonicalTestRequest({ selectedSheetIds: [101] });
      const smallBoundsWb = createCanonicalWorkbookMeta();
      // Sheet 101 has scope r1: 90000, c1: 26. Make workbook have rows: 50.
      (smallBoundsWb.sheets as any)[0] = {
        ...smallBoundsWb.sheets[0],
        rows: 50,
      };

      expect(projectWriterContext(canonicalReq, smallBoundsWb)).toBeNull();
    });

    it('rejects when scopes in request have descending or out-of-order sheet indices', () => {
      const canonicalReq = buildCanonicalTestRequest();
      // Reverse scopes order (sheet 205 index 1 before sheet 101 index 0)
      const reversedScopesReq: any = {
        ...canonicalReq,
        scopes: [canonicalReq.scopes[1], canonicalReq.scopes[0]],
      };

      expect(projectWriterContext(reversedScopesReq, createCanonicalWorkbookMeta())).toBeNull();
    });

    it('rejects negative, -0, and floating point sheetId in workbook', () => {
      const canonicalReq = buildCanonicalTestRequest({ selectedSheetIds: [101] });
      const baseWb = createCanonicalWorkbookMeta();

      const negWb = {
        ...baseWb,
        sheets: [{ ...baseWb.sheets[0], id: -1 }],
      };
      expect(projectWriterContext(canonicalReq, negWb)).toBeNull();

      const negZeroWb = {
        ...baseWb,
        sheets: [{ ...baseWb.sheets[0], id: -0 }],
      };
      expect(projectWriterContext(canonicalReq, negZeroWb)).toBeNull();

      const floatWb = {
        ...baseWb,
        sheets: [{ ...baseWb.sheets[0], id: 101.5 }],
      };
      expect(projectWriterContext(canonicalReq, floatWb)).toBeNull();
    });

    it('rejects non-positive, -0, or non-integer bounds on selected sheet', () => {
      const canonicalReq = buildCanonicalTestRequest({ selectedSheetIds: [101] });
      const baseWb = createCanonicalWorkbookMeta();

      const zeroRowsWb = {
        ...baseWb,
        sheets: [{ ...baseWb.sheets[0], rows: 0 }],
      };
      expect(projectWriterContext(canonicalReq, zeroRowsWb)).toBeNull();

      const negColsWb = {
        ...baseWb,
        sheets: [{ ...baseWb.sheets[0], columns: -5 }],
      };
      expect(projectWriterContext(canonicalReq, negColsWb)).toBeNull();
    });

    it('rejects non-string sourceVersionObservation on workbook', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const objObsWb = {
        ...createCanonicalWorkbookMeta(),
        sourceVersionObservation: { version: 'synthetic-v1' } as any,
      };
      expect(projectWriterContext(canonicalReq, objObsWb)).toBeNull();

      const numObsWb = {
        ...createCanonicalWorkbookMeta(),
        sourceVersionObservation: 12345 as any,
      };
      expect(projectWriterContext(canonicalReq, numObsWb)).toBeNull();
    });
  });

  // Group 7: Descriptor proxies, accessors, masks, symbol, traps, array cap, input immutability, and deep freeze
  describe('Group 7: Descriptor proxies, accessors, masks, traps, array caps, and deep freeze', () => {
    it('captures descriptors on workbook and selected sheets exactly once with full values', () => {
      const canonicalReq = buildCanonicalTestRequest({ selectedSheetIds: [101] });
      const canonicalWb = createCanonicalWorkbookMeta();

      const wbDescCalls: string[] = [];
      const sheetDescCalls: string[] = [];

      const trackedSheet = new Proxy(canonicalWb.sheets[0], {
        getOwnPropertyDescriptor(target, prop) {
          if (typeof prop === 'string') {
            sheetDescCalls.push(prop);
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      });

      const trackedSheets = new Proxy([trackedSheet], {
        getOwnPropertyDescriptor(target, prop) {
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      });

      const trackedWb = new Proxy(
        {
          ...canonicalWb,
          sheets: trackedSheets,
        },
        {
          getOwnPropertyDescriptor(target, prop) {
            if (typeof prop === 'string') {
              wbDescCalls.push(prop);
            }
            return Reflect.getOwnPropertyDescriptor(target, prop);
          },
        }
      );

      const context = projectWriterContext(canonicalReq, trackedWb);
      expect(context).not.toBeNull();
      expect(context).toEqual({
        sourceId: CANONICAL_SPREADSHEET_ID,
        title: 'Canonical Test Workbook',
        locale: 'en_US',
        timeZone: 'UTC',
        scopes: canonicalReq.scopes,
        mode: 'raw',
        format: 'json',
        visibility: 'include_all',
        limitsVersion: CANONICAL_LIMITS_VERSION,
        sheetOrder: [CANONICAL_SPARSE_SHEET_ID],
        sheets: [{
          id: CANONICAL_SPARSE_SHEET_ID, title: 'SparseTab', index: 0,
          type: 'GRID', hidden: false, rows: 90000, columns: 26,
        }],
      });

      // Workbook own keys descriptors read exactly once
      expect(wbDescCalls.filter((k) => k === 'id')).toHaveLength(1);
      expect(wbDescCalls.filter((k) => k === 'title')).toHaveLength(1);
      expect(wbDescCalls.filter((k) => k === 'locale')).toHaveLength(1);
      expect(wbDescCalls.filter((k) => k === 'timeZone')).toHaveLength(1);
      expect(wbDescCalls.filter((k) => k === 'sheets')).toHaveLength(1);

      // Selected sheet: id descriptor read exactly once (reused without re-reading)
      expect(sheetDescCalls.filter((k) => k === 'id')).toHaveLength(1);
      expect(sheetDescCalls.filter((k) => k === 'title')).toHaveLength(1);
      expect(sheetDescCalls.filter((k) => k === 'index')).toHaveLength(1);
      expect(sheetDescCalls.filter((k) => k === 'type')).toHaveLength(1);
      expect(sheetDescCalls.filter((k) => k === 'hidden')).toHaveLength(1);
      expect(sheetDescCalls.filter((k) => k === 'rows')).toHaveLength(1);
      expect(sheetDescCalls.filter((k) => k === 'columns')).toHaveLength(1);
    });

    it('rejects accessors/getters on workbook and sheet properties', () => {
      const canonicalReq = buildCanonicalTestRequest({ selectedSheetIds: [101] });
      const baseWb = createCanonicalWorkbookMeta();

      // Getter on workbook.id
      const wbWithIdGetter = Object.defineProperty({ ...baseWb }, 'id', {
        get() {
          return CANONICAL_SPREADSHEET_ID;
        },
        enumerable: true,
        configurable: true,
      });
      expect(projectWriterContext(canonicalReq, wbWithIdGetter)).toBeNull();

      // Getter on selected sheet.rows
      const sheetWithRowsGetter = Object.defineProperty(
        { ...baseWb.sheets[0] },
        'rows',
        {
          get() {
            return 90000;
          },
          enumerable: true,
          configurable: true,
        }
      );
      const wbWithSheetGetter = {
        ...baseWb,
        sheets: [sheetWithRowsGetter],
      };
      expect(projectWriterContext(canonicalReq, wbWithSheetGetter)).toBeNull();
    });

    it('rejects extra properties and symbol keys on workbook and selected sheet', () => {
      const canonicalReq = buildCanonicalTestRequest({ selectedSheetIds: [101] });
      const baseWb = createCanonicalWorkbookMeta();

      // Extra property on workbook
      const wbWithExtra = {
        ...baseWb,
        extraProperty: 'forbidden',
      };
      expect(projectWriterContext(canonicalReq, wbWithExtra)).toBeNull();

      // Symbol property on workbook
      const symWb = {
        ...baseWb,
        [Symbol('test')]: 'val',
      };
      expect(projectWriterContext(canonicalReq, symWb)).toBeNull();

      // Extra property on selected sheet
      const wbWithExtraSheetProp = {
        ...baseWb,
        sheets: [{ ...baseWb.sheets[0], extraSheetKey: 123 }],
      };
      expect(projectWriterContext(canonicalReq, wbWithExtraSheetProp)).toBeNull();
    });

    it('rejects non-plain prototypes on workbook and selected sheet', () => {
      const canonicalReq = buildCanonicalTestRequest({ selectedSheetIds: [101] });
      const baseWb = createCanonicalWorkbookMeta();

      class CustomWorkbook {
        id = baseWb.id;
        title = baseWb.title;
        locale = baseWb.locale;
        timeZone = baseWb.timeZone;
        sheets = baseWb.sheets;
      }
      expect(projectWriterContext(canonicalReq, new CustomWorkbook())).toBeNull();

      class CustomSheet {
        id = baseWb.sheets[0].id;
        title = baseWb.sheets[0].title;
        index = baseWb.sheets[0].index;
        type = baseWb.sheets[0].type;
        hidden = baseWb.sheets[0].hidden;
        rows = baseWb.sheets[0].rows;
        columns = baseWb.sheets[0].columns;
      }
      const wbWithCustomSheet = {
        ...baseWb,
        sheets: [new CustomSheet() as any],
      };
      expect(projectWriterContext(canonicalReq, wbWithCustomSheet)).toBeNull();
    });

    it('rejects array masks, sparse arrays, empty arrays, and oversized arrays', () => {
      const canonicalReq = buildCanonicalTestRequest({ selectedSheetIds: [101] });
      const baseWb = createCanonicalWorkbookMeta();

      // Array with extra property
      const arrWithExtra: any = [...baseWb.sheets];
      arrWithExtra.maskProp = 'sneaky';
      expect(
        projectWriterContext(canonicalReq, { ...baseWb, sheets: arrWithExtra })
      ).toBeNull();

      // Sparse array
      const sparseArr: any = [baseWb.sheets[0], undefined];
      delete sparseArr[1];
      sparseArr.length = 2;
      expect(
        projectWriterContext(canonicalReq, { ...baseWb, sheets: sparseArr })
      ).toBeNull();

      // Empty sheets array
      expect(
        projectWriterContext(canonicalReq, { ...baseWb, sheets: [] })
      ).toBeNull();

      // Sheets array exceeding PROVISIONAL_MAX_SHEETS
      let hugeLengthReads = 0;
      let hugeKeysReads = 0;
      const hugeArrProxy = new Proxy(new Array(PROVISIONAL_MAX_SHEETS + 1), {
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'length') hugeLengthReads++;
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        ownKeys(target) {
          hugeKeysReads++;
          return Reflect.ownKeys(target);
        },
      });
      expect(
        projectWriterContext(canonicalReq, { ...baseWb, sheets: hugeArrProxy })
      ).toBeNull();
      expect(hugeLengthReads).toBe(1);
      expect(hugeKeysReads).toBe(0);
    });

    it('leaves inputs unfrozen and unmutated, and returns deeply frozen output', () => {
      const mutableReq = {
        sourceId: CANONICAL_SPREADSHEET_ID,
        principalKey: CANONICAL_PRINCIPAL_KEY,
        scopes: [
          {
            sheetId: CANONICAL_SPARSE_SHEET_ID,
            rect: {
              sheetId: CANONICAL_SPARSE_SHEET_ID,
              r0: 0,
              c0: 0,
              r1: 90000,
              c1: 26,
            },
          },
          {
            sheetId: CANONICAL_EMPTY_SHEET_ID,
            rect: {
              sheetId: CANONICAL_EMPTY_SHEET_ID,
              r0: 0,
              c0: 0,
              r1: 1000,
              c1: 26,
            },
          },
        ],
        mode: 'raw' as const,
        format: 'json' as const,
        visibility: 'include_all' as const,
        limitsVersion: CANONICAL_LIMITS_VERSION,
      };

      const mutableWb = createCanonicalWorkbookMeta();

      // Inputs initially not frozen
      expect(Object.isFrozen(mutableReq)).toBe(false);
      expect(Object.isFrozen(mutableReq.scopes)).toBe(false);
      expect(Object.isFrozen(mutableReq.scopes[0])).toBe(false);
      expect(Object.isFrozen(mutableReq.scopes[0].rect)).toBe(false);
      expect(Object.isFrozen(mutableWb)).toBe(false);
      expect(Object.isFrozen(mutableWb.sheets)).toBe(false);
      expect(Object.isFrozen(mutableWb.sheets[0])).toBe(false);

      const context = projectWriterContext(mutableReq, mutableWb);
      expect(context).not.toBeNull();
      if (!context) return;

      // Inputs remain unfrozen
      expect(Object.isFrozen(mutableReq)).toBe(false);
      expect(Object.isFrozen(mutableReq.scopes)).toBe(false);
      expect(Object.isFrozen(mutableReq.scopes[0])).toBe(false);
      expect(Object.isFrozen(mutableReq.scopes[0].rect)).toBe(false);
      expect(Object.isFrozen(mutableWb)).toBe(false);
      expect(Object.isFrozen(mutableWb.sheets)).toBe(false);
      expect(Object.isFrozen(mutableWb.sheets[0])).toBe(false);

      // Mutating inputs after projection does not mutate projected context
      mutableReq.sourceId = 'mutated-source';
      (mutableWb as { title: string }).title = 'Mutated Workbook Title';
      expect(context.sourceId).toBe(CANONICAL_SPREADSHEET_ID);
      expect(context.title).toBe('Canonical Test Workbook');

      // Output context and all nested structures are deeply frozen
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.scopes)).toBe(true);
      expect(Object.isFrozen(context.scopes[0])).toBe(true);
      expect(Object.isFrozen(context.scopes[0].rect)).toBe(true);
      expect(Object.isFrozen(context.scopes[1])).toBe(true);
      expect(Object.isFrozen(context.scopes[1].rect)).toBe(true);
      expect(Object.isFrozen(context.sheetOrder)).toBe(true);
      expect(Object.isFrozen(context.sheets)).toBe(true);
      expect(Object.isFrozen(context.sheets[0])).toBe(true);
      expect(Object.isFrozen(context.sheets[1])).toBe(true);
    });
  });
});
