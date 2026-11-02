/**
 * T30d Bounded Sanitized Writer Context Projection for controller wiring.
 *
 * API: projectWriterContext(request: unknown, workbook: unknown): WriterContext | null
 * Pure bounded synchronous DTO projection; no auth/network/job state/browser/worker/data reads or permission decisions.
 * Invalid shape/value/binding/traps => null safely.
 *
 * Internally uses snapshotWriterContext with a fresh non-aborted native AbortController.signal solely for validation.
 * Drops principalKey, tokens, and sourceVersionObservation. Projects only the 11 fields of WriterContext.
 */

import type { SheetMeta, SheetType } from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { parseExportRequest, PROVISIONAL_MAX_SHEETS } from './request-snapshot.ts';
import { snapshotWriterContext } from '../export/context.ts';

export { PROVISIONAL_MAX_SHEETS };

const REQUIRED_WORKBOOK_KEYS = [
  'id',
  'title',
  'locale',
  'timeZone',
  'sheets',
] as const;

const SELECTED_SHEET_KEYS = [
  'id',
  'title',
  'index',
  'type',
  'hidden',
  'rows',
  'columns',
] as const;

function isNonNegativeSafeInt(val: unknown): val is number {
  return (
    typeof val === 'number' &&
    Number.isSafeInteger(val) &&
    val >= 0 &&
    !Object.is(val, -0)
  );
}

function isPositiveSafeInt(val: unknown): val is number {
  return (
    typeof val === 'number' &&
    Number.isSafeInteger(val) &&
    val > 0 &&
    !Object.is(val, -0)
  );
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.length > 0;
}

/**
 * Synchronous, bounded projection of an untrusted export request and workbook metadata into a
 * sanitized, immutable WriterContext.
 *
 * Enforces:
 * - Request validation via parseExportRequest (dropping principalKey)
 * - Plain object / null-prototype workbook record with required own enumerable data keys
 * - Optional primitive string sourceVersionObservation (validated but dropped)
 * - Exact sourceId match between request and workbook
 * - Dense native Array sheets bounded by PROVISIONAL_MAX_SHEETS (4096)
 * - Identity-only inspection of unselected sheets (never reading titles/types/rows/columns)
 * - Seven own data keys on selected sheets without re-reading id
 * - Request scope ordering preservation
 * - Validation and deep freezing via snapshotWriterContext with an internal AbortController
 */
export function projectWriterContext(
  request: unknown,
  workbook: unknown
): WriterContext | null {
  try {
    // 1. Obtain reviewed frozen seven-field request via parseExportRequest
    const parsedRequest = parseExportRequest(request);
    if (!parsedRequest) {
      return null;
    }

    // 2. Validate workbook record: plain Object.prototype or null record
    if (!workbook || typeof workbook !== 'object' || Array.isArray(workbook)) {
      return null;
    }
    const wbProto = Object.getPrototypeOf(workbook);
    if (wbProto !== Object.prototype && wbProto !== null) {
      return null;
    }

    // Reject symbols on workbook
    if (Object.getOwnPropertySymbols(workbook).length > 0) {
      return null;
    }

    // Own enumerable DATA required: id, title, locale, timeZone, sheets
    // and optional: sourceVersionObservation
    const wbKeys = Reflect.ownKeys(workbook);
    if (wbKeys.length < 5 || wbKeys.length > 6) {
      return null;
    }

    for (let i = 0; i < REQUIRED_WORKBOOK_KEYS.length; i++) {
      if (!wbKeys.includes(REQUIRED_WORKBOOK_KEYS[i])) {
        return null;
      }
    }

    let capturedWbId: unknown;
    let capturedWbTitle: unknown;
    let capturedWbLocale: unknown;
    let capturedWbTimeZone: unknown;
    let capturedWbSheets: unknown;
    let capturedSourceVersionObservation: unknown;
    let hasSourceVersionObservation = false;

    // Capture each workbook descriptor once, rejecting accessors and non-enumerable properties
    for (let i = 0; i < wbKeys.length; i++) {
      const k = wbKeys[i];
      if (typeof k !== 'string') {
        return null;
      }
      const desc = Object.getOwnPropertyDescriptor(workbook, k);
      if (
        !desc ||
        !desc.enumerable ||
        'get' in desc ||
        'set' in desc ||
        !('value' in desc)
      ) {
        return null;
      }
      switch (k) {
        case 'id':
          capturedWbId = desc.value;
          break;
        case 'title':
          capturedWbTitle = desc.value;
          break;
        case 'locale':
          capturedWbLocale = desc.value;
          break;
        case 'timeZone':
          capturedWbTimeZone = desc.value;
          break;
        case 'sheets':
          capturedWbSheets = desc.value;
          break;
        case 'sourceVersionObservation':
          capturedSourceVersionObservation = desc.value;
          hasSourceVersionObservation = true;
          break;
        default:
          return null; // Extra property rejected
      }
    }

    // Validate captured workbook primitive fields
    if (
      !isNonEmptyString(capturedWbId) ||
      typeof capturedWbTitle !== 'string' ||
      !isNonEmptyString(capturedWbLocale) ||
      !isNonEmptyString(capturedWbTimeZone)
    ) {
      return null;
    }

    // Optional sourceVersionObservation: if present validate primitive string, do not forward it
    if (
      hasSourceVersionObservation &&
      typeof capturedSourceVersionObservation !== 'string'
    ) {
      return null;
    }

    // request.sourceId must exactly equal captured workbook.id
    if (capturedWbId !== parsedRequest.sourceId) {
      return null;
    }

    // 3. Metadata array standard dense native Array, own length captured once,
    // local provisional scan bound 1..PROVISIONAL_MAX_SHEETS (4096) before elements/allocation.
    if (!Array.isArray(capturedWbSheets)) {
      return null;
    }
    if (Object.getPrototypeOf(capturedWbSheets) !== Array.prototype) {
      return null;
    }

    const lenDesc = Object.getOwnPropertyDescriptor(capturedWbSheets, 'length');
    if (
      !lenDesc ||
      lenDesc.enumerable ||
      'get' in lenDesc ||
      'set' in lenDesc ||
      !('value' in lenDesc)
    ) {
      return null;
    }

    const sheetsLen = lenDesc.value;
    if (
      typeof sheetsLen !== 'number' ||
      !Number.isSafeInteger(sheetsLen) ||
      sheetsLen < 1 ||
      sheetsLen > PROVISIONAL_MAX_SHEETS ||
      Object.is(sheetsLen, -0)
    ) {
      return null;
    }

    // Exact actual index whitelist plus length, no masks/symbol/extras/sparse/accessors
    const sheetsKeys = Reflect.ownKeys(capturedWbSheets);
    if (sheetsKeys.length !== sheetsLen + 1) {
      return null;
    }

    for (let i = 0; i < sheetsKeys.length; i++) {
      const k = sheetsKeys[i];
      if (k === 'length') continue;
      if (typeof k !== 'string') return null;
      const idx = Number(k);
      if (
        !Number.isSafeInteger(idx) ||
        idx < 0 ||
        idx >= sheetsLen ||
        String(idx) !== k ||
        Object.is(idx, -0)
      ) {
        return null;
      }
    }

    // 4. Inspect sheets:
    const selectedSheetIdSet = new Set<number>();
    for (let i = 0; i < parsedRequest.scopes.length; i++) {
      selectedSheetIdSet.add(parsedRequest.scopes[i].sheetId);
    }

    const globalSeenSheetIds = new Set<number>();
    const capturedSelectedSheetsMap = new Map<number, SheetMeta>();

    for (let i = 0; i < sheetsLen; i++) {
      const elemDesc = Object.getOwnPropertyDescriptor(
        capturedWbSheets,
        String(i)
      );
      if (
        !elemDesc ||
        !elemDesc.enumerable ||
        'get' in elemDesc ||
        'set' in elemDesc ||
        !('value' in elemDesc)
      ) {
        return null;
      }

      const rawSheet = elemDesc.value;
      if (!rawSheet || typeof rawSheet !== 'object' || Array.isArray(rawSheet)) {
        return null;
      }

      // For each sheet capture own DATA id ONCE; safe nonnegative integer no -0;
      // reject duplicate IDs globally.
      const idDesc = Object.getOwnPropertyDescriptor(rawSheet, 'id');
      if (
        !idDesc ||
        !idDesc.enumerable ||
        'get' in idDesc ||
        'set' in idDesc ||
        !('value' in idDesc)
      ) {
        return null;
      }

      const sheetId = idDesc.value;
      if (!isNonNegativeSafeInt(sheetId)) {
        return null;
      }

      if (globalSeenSheetIds.has(sheetId)) {
        return null;
      }
      globalSeenSheetIds.add(sheetId);

      // For unselected sheets inspect ONLY identity, never read their titles/types/rows/columns or forward them;
      // unselected unsupported/non-grid/missing bounds must not poison valid selection.
      if (!selectedSheetIdSet.has(sheetId)) {
        continue;
      }

      // Selected sheet records must have exactly seven own enumerable DATA keys:
      // id, title, index, type, hidden, rows, columns.
      const sheetProto = Object.getPrototypeOf(rawSheet);
      if (sheetProto !== Object.prototype && sheetProto !== null) {
        return null;
      }
      if (Object.getOwnPropertySymbols(rawSheet).length > 0) {
        return null;
      }

      const rawSheetKeys = Reflect.ownKeys(rawSheet);
      if (rawSheetKeys.length !== SELECTED_SHEET_KEYS.length) {
        return null;
      }
      for (let k = 0; k < rawSheetKeys.length; k++) {
        const key = rawSheetKeys[k];
        if (
          typeof key !== 'string' ||
          !SELECTED_SHEET_KEYS.includes(key as any)
        ) {
          return null;
        }
      }

      // Reuse previously captured id WITHOUT re-reading descriptor.
      // Capture each other known field once into new known wrapper.
      let capturedTitle: unknown;
      let capturedIndex: unknown;
      let capturedType: unknown;
      let capturedHidden: unknown;
      let capturedRows: unknown;
      let capturedColumns: unknown;

      for (const k of ['title', 'index', 'type', 'hidden', 'rows', 'columns'] as const) {
        const desc = Object.getOwnPropertyDescriptor(rawSheet, k);
        if (
          !desc ||
          !desc.enumerable ||
          'get' in desc ||
          'set' in desc ||
          !('value' in desc)
        ) {
          return null;
        }
        const val = desc.value;
        switch (k) {
          case 'title':
            capturedTitle = val;
            break;
          case 'index':
            capturedIndex = val;
            break;
          case 'type':
            capturedType = val;
            break;
          case 'hidden':
            capturedHidden = val;
            break;
          case 'rows':
            capturedRows = val;
            break;
          case 'columns':
            capturedColumns = val;
            break;
        }
      }

      // Validate captured fields for selected sheet.
      // Do not fabricate grid bounds or infer hidden/type defaults.
      if (
        typeof capturedTitle !== 'string' ||
        !isNonNegativeSafeInt(capturedIndex) ||
        typeof capturedType !== 'string' ||
        typeof capturedHidden !== 'boolean' ||
        !isPositiveSafeInt(capturedRows) ||
        !isPositiveSafeInt(capturedColumns)
      ) {
        return null;
      }

      capturedSelectedSheetsMap.set(sheetId, {
        id: sheetId,
        title: capturedTitle,
        index: capturedIndex,
        type: capturedType as SheetType,
        hidden: capturedHidden,
        rows: capturedRows,
        columns: capturedColumns,
      });
    }

    // 5. Construct selected sheet array IN REQUEST SCOPE ORDER by matching ids; missing selected id => null.
    // sheetOrder = request.scopes.map(sheetId), no sorting, compaction, tab skipping or format/visibility switching.
    const orderedSheets: SheetMeta[] = [];
    const sheetOrder: number[] = [];

    for (let i = 0; i < parsedRequest.scopes.length; i++) {
      const scopeSheetId = parsedRequest.scopes[i].sheetId;
      const matchingSheet = capturedSelectedSheetsMap.get(scopeSheetId);
      if (!matchingSheet) {
        return null; // Missing selected id => null
      }
      sheetOrder.push(scopeSheetId);
      orderedSheets.push(matchingSheet);
    }

    // 6. Build explicit WriterContext fields:
    // sourceId, title, locale, timeZone, scopes, mode, format, visibility, limitsVersion, sheetOrder, sheets
    const candidateContext: WriterContext = {
      sourceId: parsedRequest.sourceId,
      title: capturedWbTitle as string,
      locale: capturedWbLocale as string,
      timeZone: capturedWbTimeZone as string,
      scopes: parsedRequest.scopes,
      mode: parsedRequest.mode,
      format: parsedRequest.format,
      visibility: parsedRequest.visibility,
      limitsVersion: parsedRequest.limitsVersion,
      sheetOrder,
      sheets: orderedSheets,
    };

    // 7. Internally use snapshotWriterContext with a fresh non-aborted native AbortController.signal
    // solely for validation (never expose controller or retain input).
    const controller = new AbortController();
    const validatedContext = snapshotWriterContext(candidateContext, {
      maxSheets: PROVISIONAL_MAX_SHEETS,
      signal: controller.signal,
    });

    return validatedContext;
  } catch {
    return null;
  }
}
