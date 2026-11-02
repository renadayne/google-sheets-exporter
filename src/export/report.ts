/**
 * T27b Common Complete Metadata Report Validation and Copy
 * Precondition: `context` must be a validated frozen snapshot (e.g. from `snapshotWriterContext`)
 * and `prepared` must be real `prepareWriterData` result for the SAME `context`.
 * Still enforces defensive validation and semantic relations across context, prepared sheets,
 * and report metadata.
 * Note: This helper alone cannot verify an acquisition ledger or publication authority.
 */

import type {
  ExportReport, DimensionInterval, SheetExclusions, ReportWarning,
  ReportSourceObservations, SourceObservation, ConsistencyStatus,
  ReportCsvTransforms, SheetNameMapping
} from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { isExportReport } from '../contracts/validation.ts';
import type { PreparedSheet } from './prepare.ts';
import { mapCsvFilenames, mapWorksheetNames, type SheetInput } from './names.ts';
import { snapshotExportReport } from './report-snapshot.ts';
import { MAX_JSON_NODES } from './json-encoding.ts';

export const PROVISIONAL_MAX_WARNINGS = 4096;

const FORBIDDEN_CONTEXT_KEYS = [
  'principalKey', 'displayEmail', 'accessToken', 'refreshToken',
  'token', 'account', 'authorization', 'headers'
] as const;

export interface BuildCompleteExportReportOptions {
  readonly maxWarnings: number;
  readonly signal: AbortSignal;
  /** Actual encodeCsvSheets result for these prepared sheets; never caller-estimated counts. */
  readonly csvTransformCounts?: ReportCsvTransforms;
}

function isSafeNonNegInt(val: unknown, max: number): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && val <= max && !Object.is(val, -0);
}

// Date.parse discards sub-millisecond digits. Compare whole seconds and the exact
// fractional suffix separately so equivalent spellings match without hiding changes.
function compareTimestamps(a: string, b: string): number {
  const key = (value: string) => {
    const match = /^(.*:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
    if (!match) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    const milliseconds = Date.parse(match[1] + match[3]);
    if (!Number.isFinite(milliseconds)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    return { milliseconds, fraction: (match[2] ?? '').replace(/0+$/, '') };
  };
  const left = key(a), right = key(b);
  if (left.milliseconds !== right.milliseconds) return left.milliseconds < right.milliseconds ? -1 : 1;
  return left.fraction === right.fraction ? 0 : left.fraction < right.fraction ? -1 : 1;
}

export function buildCompleteExportReport(
  context: WriterContext,
  prepared: readonly PreparedSheet[],
  report: ExportReport,
  options: BuildCompleteExportReportOptions
): ExportReport {
  let maxWarnings: number, signal: AbortSignal, rawCsvTransformCounts: ReportCsvTransforms | undefined;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');
    const { maxWarnings: rawMax, signal: rawSig, csvTransformCounts: rawTransforms } = options;
    if (
      !isSafeNonNegInt(rawMax, PROVISIONAL_MAX_WARNINGS) || !rawSig || typeof rawSig !== 'object' ||
      typeof rawSig.aborted !== 'boolean' || typeof (rawSig as any).addEventListener !== 'function' ||
      typeof (rawSig as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (rawSig.aborted) throw new DomainError('OPERATION_ABORTED');
    maxWarnings = rawMax;
    signal = rawSig;
    rawCsvTransformCounts = rawTransforms;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('CONFIG_INVALID');
  }

  try {
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    if (!context || typeof context !== 'object') {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    const targetFormat = context.format;
    if (targetFormat !== 'json' && targetFormat !== 'csv' && targetFormat !== 'xlsx') {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    for (const k of FORBIDDEN_CONTEXT_KEYS) {
      if (k in context && (context as any)[k] !== undefined) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    report = snapshotExportReport(report, { signal, maxNodes: MAX_JSON_NODES });

    // Check warnings count early against captured report
    if (report.export.warnings.length > maxWarnings) {
      throw new DomainError('SIZE_LIMIT_EXCEEDED');
    }

    if (report.export.complete !== true || report.export.format !== targetFormat) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    if (report.export.consistency === 'not_atomic_changes_detected') throw new DomainError('SOURCE_CHANGED_CONCURRENTLY');

    if (targetFormat !== 'csv') {
      if (rawCsvTransformCounts !== undefined) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      if ('csvTransformCounts' in report && (report as any).csvTransformCounts !== undefined) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
    }

    if (compareTimestamps(report.export.producedAt, report.export.startedAt) < 0) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (report.sourceObservations !== undefined) {
      const { before, after } = report.sourceObservations;
      if (before !== undefined) {
        const bTime = Date.parse(before.observedAt);
        if (!Number.isFinite(bTime)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        if (before.modifiedTime !== undefined) {
          if (typeof before.modifiedTime !== 'string') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          const bMod = Date.parse(before.modifiedTime);
          if (!Number.isFinite(bMod)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
      }
      if (after !== undefined) {
        const aTime = Date.parse(after.observedAt);
        if (!Number.isFinite(aTime)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        if (after.modifiedTime !== undefined) {
          if (typeof after.modifiedTime !== 'string') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          const aMod = Date.parse(after.modifiedTime);
          if (!Number.isFinite(aMod)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
      }
      if (before !== undefined && after !== undefined) {
        if (compareTimestamps(after.observedAt, before.observedAt) < 0) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        if (
          typeof before.version === 'string' && typeof after.version === 'string' &&
          before.version !== after.version
        ) {
          throw new DomainError('SOURCE_CHANGED_CONCURRENTLY');
        }
        if (
          typeof before.modifiedTime === 'string' && typeof after.modifiedTime === 'string'
        ) {
          if (compareTimestamps(before.modifiedTime, after.modifiedTime) !== 0) {
            throw new DomainError('SOURCE_CHANGED_CONCURRENTLY');
          }
        }
      }
    }

    if (
      report.source.id !== context.sourceId ||
      report.source.title !== context.title ||
      report.source.locale !== context.locale ||
      report.source.timeZone !== context.timeZone ||
      report.export.mode !== context.mode ||
      report.export.visibility !== context.visibility ||
      report.limitsVersion !== context.limitsVersion
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (
      !Array.isArray(context.sheets) ||
      !Array.isArray(context.scopes) ||
      !Array.isArray(context.sheetOrder) ||
      !Array.isArray(prepared) ||
      !Array.isArray(report.sheetOrder) ||
      !Array.isArray(report.selectedScopes) ||
      !Array.isArray(report.nameMappings)
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    const sheetCount = context.sheets.length;
    if (
      sheetCount === 0 ||
      context.scopes.length !== sheetCount ||
      context.sheetOrder.length !== sheetCount ||
      prepared.length !== sheetCount ||
      report.sheetOrder.length !== sheetCount ||
      report.selectedScopes.length !== sheetCount ||
      report.nameMappings.length !== sheetCount
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    const sheetInputs: SheetInput[] = [];
    for (let i = 0; i < sheetCount; i++) {
      const s = context.sheets[i];
      if (!s || typeof s.id !== 'number' || typeof s.title !== 'string') {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      sheetInputs.push({ id: s.id, title: s.title });
    }

    let derivedMappings: readonly SheetNameMapping[];
    if (targetFormat === 'json') {
      derivedMappings = sheetInputs.map(s => Object.freeze({
        sheetId: s.id,
        originalTitle: s.title,
        exportedName: s.title
      }));
    } else if (targetFormat === 'csv') {
      derivedMappings = mapCsvFilenames(sheetInputs);
    } else {
      derivedMappings = mapWorksheetNames(sheetInputs);
    }

    if (!Array.isArray(derivedMappings) || derivedMappings.length !== sheetCount) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    const seenSheetIds = new Set<number>();
    for (let i = 0; i < sheetCount; i++) {
      const meta = context.sheets[i];
      const ctxOrderId = context.sheetOrder[i];
      const repOrderId = report.sheetOrder[i];
      const cs = context.scopes[i];
      const rs = report.selectedScopes[i];
      const m = report.nameMappings[i];
      const d = derivedMappings[i];
      const p = prepared[i];

      if (
        !meta || typeof meta.id !== 'number' ||
        seenSheetIds.has(meta.id) ||
        ctxOrderId !== meta.id ||
        repOrderId !== meta.id ||
        cs.sheetId !== meta.id ||
        cs.rect.sheetId !== meta.id ||
        rs.sheetId !== meta.id ||
        rs.rect.sheetId !== meta.id ||
        rs.rect.r0 !== cs.rect.r0 ||
        rs.rect.c0 !== cs.rect.c0 ||
        rs.rect.r1 !== cs.rect.r1 ||
        rs.rect.c1 !== cs.rect.c1 ||
        m.sheetId !== meta.id ||
        m.originalTitle !== meta.title ||
        m.sheetId !== d.sheetId ||
        m.originalTitle !== d.originalTitle ||
        m.exportedName !== d.exportedName ||
        p.metadata.id !== meta.id ||
        p.metadata.title !== meta.title ||
        p.metadata.index !== meta.index ||
        p.scope.sheetId !== cs.rect.sheetId ||
        p.scope.r0 !== cs.rect.r0 ||
        p.scope.c0 !== cs.rect.c0 ||
        p.scope.r1 !== cs.rect.r1 ||
        p.scope.c1 !== cs.rect.c1
      ) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      seenSheetIds.add(meta.id);
    }

    let frozenCsvTransformCounts: ReportCsvTransforms | undefined;
    if (targetFormat === 'csv') {
      if (!rawCsvTransformCounts || typeof rawCsvTransformCounts !== 'object' || Array.isArray(rawCsvTransformCounts)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      const allowedKeys = new Set(['policy', 'totalTransformedCells', 'bySheet']);
      const rawKeys = Object.keys(rawCsvTransformCounts);
      if (
        rawKeys.length !== 3 ||
        !('policy' in rawCsvTransformCounts) ||
        !('totalTransformedCells' in rawCsvTransformCounts) ||
        !('bySheet' in rawCsvTransformCounts)
      ) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      for (const k of rawKeys) {
        if (!allowedKeys.has(k)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      const capturedPolicy = rawCsvTransformCounts.policy;
      const capturedTotal = rawCsvTransformCounts.totalTransformedCells;
      const capturedBySheet = rawCsvTransformCounts.bySheet;

      if (capturedPolicy !== 'apostrophe_prefix_v1') {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (
        typeof capturedTotal !== 'number' ||
        !Number.isSafeInteger(capturedTotal) ||
        capturedTotal < 0 ||
        Object.is(capturedTotal, -0)
      ) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (!Array.isArray(capturedBySheet) || capturedBySheet.length !== sheetCount) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      let runningTotal = 0;
      const clonedBySheet: { readonly sheetId: number; readonly transformedCells: number }[] = [];
      for (let i = 0; i < sheetCount; i++) {
        if ((i & 63) === 0 && signal.aborted) throw new DomainError('OPERATION_ABORTED');
        const item = capturedBySheet[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        const itemKeys = Object.keys(item);
        if (itemKeys.length !== 2 || !('sheetId' in item) || !('transformedCells' in item)) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        for (const k of itemKeys) {
          if (k !== 'sheetId' && k !== 'transformedCells') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }

        const itemSheetId = item.sheetId;
        const itemTransformedCells = item.transformedCells;

        if (itemSheetId !== context.sheets[i].id) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        if (
          typeof itemTransformedCells !== 'number' ||
          !Number.isSafeInteger(itemTransformedCells) ||
          itemTransformedCells < 0 ||
          Object.is(itemTransformedCells, -0)
        ) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }

        let stringCellCount = 0;
        const sheetCells = prepared[i].cells;
        for (let c = 0; c < sheetCells.length; c++) {
          if ((c & 127) === 0 && signal.aborted) throw new DomainError('OPERATION_ABORTED');
          if (sheetCells[c].kind === 'string') {
            stringCellCount++;
          }
        }
        if (itemTransformedCells > stringCellCount) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }

        runningTotal += itemTransformedCells;
        if (!Number.isSafeInteger(runningTotal)) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }

        clonedBySheet.push(Object.freeze({
          sheetId: itemSheetId,
          transformedCells: itemTransformedCells
        }));
      }

      if (runningTotal !== capturedTotal) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      frozenCsvTransformCounts = Object.freeze({
        policy: 'apostrophe_prefix_v1',
        totalTransformedCells: capturedTotal,
        bySheet: Object.freeze(clonedBySheet)
      });

      if ('csvTransformCounts' in report && (report as any).csvTransformCounts !== undefined) {
        const repTransforms = (report as any).csvTransformCounts;
        if (!repTransforms || typeof repTransforms !== 'object' || Array.isArray(repTransforms)) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        const repKeys = Object.keys(repTransforms);
        if (
          repKeys.length !== 3 ||
          !('policy' in repTransforms) ||
          !('totalTransformedCells' in repTransforms) ||
          !('bySheet' in repTransforms)
        ) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        for (const k of repKeys) {
          if (!allowedKeys.has(k)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }

        const repPolicy = repTransforms.policy;
        const repTotal = repTransforms.totalTransformedCells;
        const repBySheet = repTransforms.bySheet;

        if (repPolicy !== frozenCsvTransformCounts.policy || repTotal !== frozenCsvTransformCounts.totalTransformedCells) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        if (!Array.isArray(repBySheet) || repBySheet.length !== sheetCount) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        for (let i = 0; i < sheetCount; i++) {
          const repItem = repBySheet[i];
          if (!repItem || typeof repItem !== 'object' || Array.isArray(repItem)) {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
          const rItemKeys = Object.keys(repItem);
          if (rItemKeys.length !== 2 || !('sheetId' in repItem) || !('transformedCells' in repItem)) {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
          for (const k of rItemKeys) {
            if (k !== 'sheetId' && k !== 'transformedCells') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
          if (
            repItem.sheetId !== frozenCsvTransformCounts.bySheet[i].sheetId ||
            repItem.transformedCells !== frozenCsvTransformCounts.bySheet[i].transformedCells
          ) {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
        }
      }
    }

    for (const w of report.export.warnings) {
      if (w.code === 'CSV_TEXT_ESCAPED') {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      if (typeof w.sheetId === 'number' && !seenSheetIds.has(w.sheetId)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
    }

    const willAddCsvWarning =
      targetFormat === 'csv' &&
      frozenCsvTransformCounts !== undefined &&
      frozenCsvTransformCounts.totalTransformedCells > 0;

    const finalWarningsCount = report.export.warnings.length + (willAddCsvWarning ? 1 : 0);
    if (finalWarningsCount > maxWarnings) {
      throw new DomainError('SIZE_LIMIT_EXCEEDED');
    }

    if (!Array.isArray(report.exclusions)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    const seenExcls = new Set<number>(), exclMap = new Map<number, SheetExclusions>();
    for (const e of report.exclusions) {
      if (!seenSheetIds.has(e.sheetId) || seenExcls.has(e.sheetId)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      seenExcls.add(e.sheetId);
      exclMap.set(e.sheetId, e);
    }

    for (let i = 0; i < sheetCount; i++) {
      const id = context.sheets[i].id, { rows: dr, columns: dc } = prepared[i].excludedIntervals, e = exclMap.get(id);
      if (!e) {
        if (dr.length !== 0 || dc.length !== 0) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        continue;
      }
      if (e.excludedRows.length !== dr.length || e.excludedColumns.length !== dc.length) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      for (let r = 0; r < dr.length; r++) {
        if (e.excludedRows[r].start !== dr[r].start || e.excludedRows[r].end !== dr[r].end) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      for (let c = 0; c < dc.length; c++) {
        if (e.excludedColumns[c].start !== dc[c].start || e.excludedColumns[c].end !== dc[c].end) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
    }

    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

    const warnings: ReportWarning[] = report.export.warnings.map(w =>
      Object.freeze(typeof w.sheetId === 'number' ? { code: w.code, message: w.message, sheetId: w.sheetId } : { code: w.code, message: w.message })
    );

    if (willAddCsvWarning) {
      warnings.push(Object.freeze({
        code: 'CSV_TEXT_ESCAPED',
        message: 'Some source strings were prefixed for CSV safety. JSON preserves original values.'
      }));
    }

    const exportMeta = Object.freeze({
      startedAt: report.export.startedAt,
      producedAt: report.export.producedAt,
      mode: report.export.mode,
      format: targetFormat,
      visibility: report.export.visibility,
      complete: true as const,
      consistency: report.export.consistency as Exclude<ConsistencyStatus, 'not_atomic_changes_detected'>,
      warnings: Object.freeze(warnings)
    });

    let sourceObservations: ReportSourceObservations | undefined;
    if (report.sourceObservations !== undefined) {
      const obs: { before?: SourceObservation; after?: SourceObservation } = {};
      if (report.sourceObservations.before !== undefined) {
        const b = report.sourceObservations.before;
        const bObj: { observedAt: string; version?: string; modifiedTime?: string } = { observedAt: b.observedAt };
        if (typeof b.version === 'string') bObj.version = b.version;
        if (typeof b.modifiedTime === 'string') bObj.modifiedTime = b.modifiedTime;
        obs.before = Object.freeze(bObj);
      }
      if (report.sourceObservations.after !== undefined) {
        const a = report.sourceObservations.after;
        const aObj: { observedAt: string; version?: string; modifiedTime?: string } = { observedAt: a.observedAt };
        if (typeof a.version === 'string') aObj.version = a.version;
        if (typeof a.modifiedTime === 'string') aObj.modifiedTime = a.modifiedTime;
        obs.after = Object.freeze(aObj);
      }
      sourceObservations = Object.freeze(obs);
    }

    const copiedReport: ExportReport = Object.freeze({
      schemaVersion: '1.0' as const,
      source: Object.freeze({
        id: report.source.id,
        title: report.source.title,
        locale: report.source.locale,
        timeZone: report.source.timeZone
      }),
      export: exportMeta,
      selectedScopes: Object.freeze(report.selectedScopes.map(s => Object.freeze({
        sheetId: s.sheetId,
        rect: Object.freeze({
          sheetId: s.rect.sheetId,
          r0: s.rect.r0,
          c0: s.rect.c0,
          r1: s.rect.r1,
          c1: s.rect.c1
        })
      }))),
      sheetOrder: Object.freeze([...report.sheetOrder]),
      limitsVersion: report.limitsVersion,
      nameMappings: Object.freeze(derivedMappings.map(m => Object.freeze({
        sheetId: m.sheetId,
        originalTitle: m.originalTitle,
        exportedName: m.exportedName
      }))),
      exclusions: Object.freeze(report.exclusions.map(e => Object.freeze({
        sheetId: e.sheetId,
        excludedRows: Object.freeze(e.excludedRows.map((iv: DimensionInterval) => Object.freeze({ start: iv.start, end: iv.end }))),
        excludedColumns: Object.freeze(e.excludedColumns.map((iv: DimensionInterval) => Object.freeze({ start: iv.start, end: iv.end })))
      }))),
      ...(sourceObservations !== undefined ? { sourceObservations } : {}),
      ...(targetFormat === 'csv' && frozenCsvTransformCounts !== undefined ? { csvTransformCounts: frozenCsvTransformCounts } : {})
    });

    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    if (!isExportReport(copiedReport)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    return copiedReport;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
