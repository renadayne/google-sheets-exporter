/**
 * T24b2 JSON Document Assembly and Report Binding
 * Precondition: `prepared` must be the output of reviewed `prepareWriterData`
 * (geometry, cell coordinates, and exclusion coherence already proven).
 * Note: This helper alone cannot verify an acquisition ledger or authority.
 */

import type {
  ExportReport, JsonExportDocument, JsonExportSheet, DimensionInterval,
  SheetExclusions, ReportWarning, ReportSourceObservations, SourceObservation, ConsistencyStatus
} from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { isExportReport, isJsonExportDocument } from '../contracts/validation.ts';
import type { PreparedSheet } from './prepare.ts';

export const PROVISIONAL_MAX_WARNINGS = 4096;

const FORBIDDEN_CONTEXT_KEYS = ['principalKey', 'displayEmail', 'accessToken', 'refreshToken', 'token', 'account', 'authorization', 'headers'] as const;

export interface BuildJsonExportDocumentOptions {
  readonly maxWarnings: number;
  readonly signal: AbortSignal;
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

export function buildJsonExportDocument(
  context: WriterContext,
  prepared: readonly PreparedSheet[],
  report: ExportReport,
  options: BuildJsonExportDocumentOptions
): JsonExportDocument {
  let maxWarnings: number, signal: AbortSignal;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');
    const { maxWarnings: rawMax, signal: rawSig } = options;
    if (
      !isSafeNonNegInt(rawMax, PROVISIONAL_MAX_WARNINGS) || !rawSig || typeof rawSig !== 'object' ||
      typeof rawSig.aborted !== 'boolean' || typeof (rawSig as any).addEventListener !== 'function' ||
      typeof (rawSig as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (rawSig.aborted) throw new DomainError('OPERATION_ABORTED');
    maxWarnings = rawMax; signal = rawSig;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('CONFIG_INVALID');
  }

  try {
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    if (!context || typeof context !== 'object' || context.format !== 'json') {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    for (const k of FORBIDDEN_CONTEXT_KEYS) {
      if (k in context && (context as any)[k] !== undefined) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (!report || typeof report !== 'object') {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    // Check warnings count early before schema walks huge warnings list or copying
    const rawExport = (report as any).export;
    if (rawExport && typeof rawExport === 'object' && Array.isArray(rawExport.warnings)) {
      if (rawExport.warnings.length > maxWarnings) {
        throw new DomainError('SIZE_LIMIT_EXCEEDED');
      }
    }

    if (!isExportReport(report)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

    if (report.export.complete !== true || report.export.format !== 'json') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    if (report.export.consistency === 'not_atomic_changes_detected') throw new DomainError('SOURCE_CHANGED_CONCURRENTLY');
    if ('csvTransformCounts' in report && (report as any).csvTransformCounts !== undefined) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

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

    const seenSheetIds = new Set<number>();
    for (let i = 0; i < sheetCount; i++) {
      const meta = context.sheets[i];
      const ctxOrderId = context.sheetOrder[i];
      const repOrderId = report.sheetOrder[i];
      const cs = context.scopes[i];
      const rs = report.selectedScopes[i];
      const m = report.nameMappings[i];
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
        m.exportedName !== meta.title ||
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

    for (const w of report.export.warnings) {
      if (typeof w.sheetId === 'number' && !seenSheetIds.has(w.sheetId)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
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

    const exportMeta = Object.freeze({
      startedAt: report.export.startedAt, producedAt: report.export.producedAt, mode: report.export.mode,
      format: 'json' as const, visibility: report.export.visibility, complete: true as const,
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

    const sheets: JsonExportSheet[] = [];
    for (let i = 0; i < sheetCount; i++) {
      if ((i & 63) === 0 && signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const p = prepared[i];
      sheets.push(Object.freeze({
        id: p.metadata.id, title: p.metadata.title, index: p.metadata.index,
        scope: Object.freeze({ sheetId: p.scope.sheetId, r0: p.scope.r0, c0: p.scope.c0, r1: p.scope.r1, c1: p.scope.c1 }),
        visibility: Object.freeze({
          mode: context.visibility,
          excludedRows: Object.freeze(p.excludedIntervals.rows.map((iv: DimensionInterval) => Object.freeze({ start: iv.start, end: iv.end }))),
          excludedColumns: Object.freeze(p.excludedIntervals.columns.map((iv: DimensionInterval) => Object.freeze({ start: iv.start, end: iv.end })))
        }),
        cells: p.cells
      }));
    }

    const doc: JsonExportDocument = Object.freeze({
      schemaVersion: '1.0' as const,
      source: Object.freeze({ id: report.source.id, title: report.source.title, locale: report.source.locale, timeZone: report.source.timeZone }),
      export: exportMeta,
      selectedScopes: Object.freeze(report.selectedScopes.map(s => Object.freeze({
        sheetId: s.sheetId, rect: Object.freeze({ sheetId: s.rect.sheetId, r0: s.rect.r0, c0: s.rect.c0, r1: s.rect.r1, c1: s.rect.c1 })
      }))),
      sheetOrder: Object.freeze([...report.sheetOrder]),
      limitsVersion: report.limitsVersion,
      nameMappings: Object.freeze(report.nameMappings.map(m => Object.freeze({ sheetId: m.sheetId, originalTitle: m.originalTitle, exportedName: m.exportedName }))),
      exclusions: Object.freeze(report.exclusions.map(e => Object.freeze({
        sheetId: e.sheetId,
        excludedRows: Object.freeze(e.excludedRows.map((iv: DimensionInterval) => Object.freeze({ start: iv.start, end: iv.end }))),
        excludedColumns: Object.freeze(e.excludedColumns.map((iv: DimensionInterval) => Object.freeze({ start: iv.start, end: iv.end })))
      }))),
      ...(sourceObservations !== undefined ? { sourceObservations } : {}),
      sheets: Object.freeze(sheets)
    });

    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    if (!isJsonExportDocument(doc)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    return doc;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
