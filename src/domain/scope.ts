/**
 * T13 Immutable Scope Planning
 *
 * Resolves source, workbook metadata, account context, and scope options
 * into an immutable ExportRequest with strictly bounded rectangular scopes.
 *
 * Invariants & Semantic Decisions:
 * 1. Pure function: no side effects, no mutations, no network, no auth/permission decisions.
 * 2. Source workbook ID check binds metadata; does not prove access permission.
 * 3. Default selection includes all visible tabs (even empty tabs); hidden tabs require explicit opt-in.
 * 4. Source index ordering: Selected scopes are strictly ordered by source sheet index,
 *    not by numeric sheet ID or caller input selection order.
 * 5. REVIEWED SEMANTIC DECISION:
 *    `api_visible` excludes hidden tabs, yet explicit selection must never be silently dropped.
 *    Therefore selecting a hidden tab with `api_visible` is a validation error (SOURCE_UNSUPPORTED);
 *    caller must explicitly choose `include_all`. Default `api_visible` selects visible tabs.
 *    `include_all` preserves selected hidden tabs and all dimensions; `include_all` alone does
 *    NOT auto-select hidden tabs. No automatic mode switch.
 * 6. Non-poisoning: Unselected non-GRID or hidden sheets do not poison an otherwise valid selection;
 *    unsupported selected tabs are never skipped silently.
 * 7. Immutable output: Deeply freezes copied output; caller inputs are never mutated or frozen.
 */

import type {
  AccountContext,
  ExportFormat,
  ExportMode,
  ExportRequest,
  ExportScope,
  Rect,
  SheetMeta,
  SourceRef,
  VisibilityMode,
  WorkbookMeta
} from '../contracts/domain.ts';
import { DomainError } from '../contracts/errors.ts';
import { parseA1 } from '../source/a1.ts';

/**
 * Optional per-sheet A1 coordinate specification.
 */
export interface SheetRangeSpec {
  readonly sheetId: number;
  readonly a1: string;
}

/**
 * Scope planning options controlling tabs, coordinates, mode, format, and visibility.
 */
export interface ScopeOptions {
  readonly mode: ExportMode;
  readonly format: ExportFormat;
  readonly visibility: VisibilityMode;
  readonly limitsVersion: string;
  /** Explicit sheet IDs to export. When omitted (undefined), defaults to all visible tabs. */
  readonly selectedSheetIds?: readonly number[];
  /** Optional per-tab A1 range specifications (at most one per selected tab). */
  readonly ranges?: readonly SheetRangeSpec[];
}

const VALID_MODES = new Set<ExportMode>(['formatted', 'raw', 'formula_text']);
const VALID_FORMATS = new Set<ExportFormat>(['xlsx', 'csv', 'json']);
const VALID_VISIBILITIES = new Set<VisibilityMode>(['include_all', 'api_visible']);

/**
 * Recursively freezes an object and its nested object/array properties.
 */
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Builds an immutable, validated ExportRequest binding source and account to selected scopes.
 *
 * @param source Reference to the spreadsheet (highlightedSheetId is ignored for selection).
 * @param workbook Metadata for the spreadsheet workbook and worksheets.
 * @param account Active session account context with principalKey.
 * @param options Scope options (modes, format, visibility, selected sheet IDs, per-tab A1 ranges).
 * @returns Deeply frozen ExportRequest with scopes sorted by source sheet index.
 */
export function buildScopePlan(
  source: SourceRef,
  workbook: WorkbookMeta,
  account: AccountContext,
  options: ScopeOptions
): ExportRequest {
  // 1. Account validation
  if (
    !account ||
    typeof account !== 'object' ||
    typeof account.principalKey !== 'string' ||
    account.principalKey.trim().length === 0
  ) {
    throw new DomainError('AUTH_REQUIRED');
  }

  // 2. Source and workbook references
  if (
    !source ||
    typeof source !== 'object' ||
    typeof source.spreadsheetId !== 'string' ||
    source.spreadsheetId.trim().length === 0
  ) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (
    !workbook ||
    typeof workbook !== 'object' ||
    typeof workbook.id !== 'string' ||
    workbook.id.trim().length === 0 ||
    !Array.isArray(workbook.sheets)
  ) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // Source workbook ID must match (binds metadata, does not prove permission)
  if (source.spreadsheetId !== workbook.id) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // 3. Validate options fields and enums
  if (!options || typeof options !== 'object') {
    throw new DomainError('CONFIG_INVALID');
  }
  if (typeof options.limitsVersion !== 'string' || options.limitsVersion.trim().length === 0) {
    throw new DomainError('CONFIG_INVALID');
  }
  if (!VALID_FORMATS.has(options.format)) {
    throw new DomainError('FORMAT_UNSUPPORTED');
  }
  if (!VALID_MODES.has(options.mode)) {
    throw new DomainError('FORMAT_UNSUPPORTED');
  }
  if (!VALID_VISIBILITIES.has(options.visibility)) {
    throw new DomainError('RANGE_INVALID');
  }

  // 4. Validate workbook sheets structure and uniqueness of IDs & source indexes
  if (workbook.sheets.length === 0) {
    throw new DomainError('RANGE_EMPTY');
  }

  const sheetsById = new Map<number, SheetMeta>();
  const seenIndices = new Set<number>();

  for (const sheet of workbook.sheets) {
    if (
      !sheet ||
      typeof sheet !== 'object' ||
      typeof sheet.id !== 'number' ||
      !Number.isSafeInteger(sheet.id) ||
      sheet.id < 0 ||
      typeof sheet.index !== 'number' ||
      !Number.isSafeInteger(sheet.index) ||
      sheet.index < 0 ||
      typeof sheet.title !== 'string' ||
      typeof sheet.hidden !== 'boolean'
    ) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }

    if (sheetsById.has(sheet.id) || seenIndices.has(sheet.index)) {
      // Reject ambiguous duplicate metadata IDs or source indexes
      throw new DomainError('SOURCE_UNSUPPORTED');
    }

    sheetsById.set(sheet.id, sheet);
    seenIndices.add(sheet.index);
  }

  // 5. Determine selected sheets (default vs explicit)
  let selectedSheets: SheetMeta[];

  if (options.selectedSheetIds === undefined) {
    // Default includes all visible tabs even empty; hidden tabs require explicit opt-in
    selectedSheets = workbook.sheets.filter(s => !s.hidden);
    if (selectedSheets.length === 0) {
      throw new DomainError('RANGE_EMPTY');
    }
  } else {
    if (!Array.isArray(options.selectedSheetIds)) {
      throw new DomainError('RANGE_INVALID');
    }
    if (options.selectedSheetIds.length === 0) {
      // Explicit empty selection error
      throw new DomainError('RANGE_EMPTY');
    }

    const seenSelectedIds = new Set<number>();
    selectedSheets = [];

    for (const id of options.selectedSheetIds) {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
        throw new DomainError('RANGE_INVALID');
      }
      if (seenSelectedIds.has(id)) {
        // Duplicate selection IDs
        throw new DomainError('RANGE_INVALID');
      }
      seenSelectedIds.add(id);

      const sheet = sheetsById.get(id);
      if (!sheet) {
        // Unknown sheet ID
        throw new DomainError('RANGE_INVALID');
      }
      selectedSheets.push(sheet);
    }
  }

  // 6. Sort selected sheets by unique source index (not numeric IDs or input order)
  selectedSheets.sort((a, b) => a.index - b.index);

  // 7. Parse and validate per-tab ranges
  const rangeMap = new Map<number, string>();

  if (options.ranges !== undefined) {
    if (!Array.isArray(options.ranges)) throw new DomainError('RANGE_INVALID');
    for (const item of options.ranges) {
      if (!item || typeof item !== 'object') {
        throw new DomainError('RANGE_INVALID');
      }
      const sheetId = (item as { sheetId?: unknown }).sheetId;
      const a1 = (item as { a1?: unknown }).a1;
      if (typeof sheetId !== 'number' || !Number.isSafeInteger(sheetId) || sheetId < 0) {
        throw new DomainError('RANGE_INVALID');
      }
      if (typeof a1 !== 'string' || a1.trim().length === 0) {
        throw new DomainError('RANGE_INVALID');
      }
      if (rangeMap.has(sheetId)) {
        throw new DomainError('RANGE_INVALID');
      }
      rangeMap.set(sheetId, a1);
    }

    // Validate ranges for unselected sheets are rejected
    const selectedSheetIdSet = new Set(selectedSheets.map(s => s.id));
    for (const sheetId of rangeMap.keys()) {
      if (!selectedSheetIdSet.has(sheetId)) {
        throw new DomainError('RANGE_INVALID');
      }
    }
  }

  // 8. Build scopes and validate selected sheets
  const scopes: ExportScope[] = [];

  for (const sheet of selectedSheets) {
    // REVIEWED SEMANTIC DECISION: api_visible excludes hidden tabs; selecting hidden tab
    // with api_visible is a validation error (SOURCE_UNSUPPORTED). Caller must choose include_all.
    if (sheet.hidden && options.visibility === 'api_visible') {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }

    // Selected tab must be GRID and have valid allocated dimensions
    if (
      sheet.type !== 'GRID' ||
      typeof sheet.rows !== 'number' ||
      !Number.isSafeInteger(sheet.rows) ||
      sheet.rows <= 0 ||
      typeof sheet.columns !== 'number' ||
      !Number.isSafeInteger(sheet.columns) ||
      sheet.columns <= 0
    ) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }

    let rect: Rect;
    const a1Spec = rangeMap.get(sheet.id);

    if (a1Spec !== undefined) {
      // Per-tab A1 using reviewed parser (exactly one Rect per tab)
      rect = parseA1(a1Spec, sheet);
    } else {
      // Default rectangle: FULL allocated grid
      rect = {
        sheetId: sheet.id,
        r0: 0,
        c0: 0,
        r1: sheet.rows,
        c1: sheet.columns
      };
    }

    scopes.push({
      sheetId: sheet.id,
      rect
    });
  }

  // 9. Construct output ExportRequest and deeply freeze it
  const plan: ExportRequest = {
    sourceId: workbook.id,
    principalKey: account.principalKey,
    scopes: scopes.map(s => ({
      sheetId: s.sheetId,
      rect: {
        sheetId: s.rect.sheetId,
        r0: s.rect.r0,
        c0: s.rect.c0,
        r1: s.rect.r1,
        c1: s.rect.c1
      }
    })),
    mode: options.mode,
    format: options.format,
    visibility: options.visibility,
    limitsVersion: options.limitsVersion
  };

  return deepFreeze(plan);
}
