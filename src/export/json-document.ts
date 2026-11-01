/**
 * T24b2 JSON Document Assembly and Report Binding
 * Precondition: `prepared` must be the output of reviewed `prepareWriterData`
 * (geometry, cell coordinates, and exclusion coherence already proven).
 * Note: This helper alone cannot verify an acquisition ledger or authority.
 */

import type {
  ExportReport, JsonExportDocument, JsonExportSheet, DimensionInterval
} from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { isJsonExportDocument } from '../contracts/validation.ts';
import type { PreparedSheet } from './prepare.ts';
import {
  PROVISIONAL_MAX_WARNINGS,
  type BuildCompleteExportReportOptions,
  buildCompleteExportReport
} from './report.ts';

export { PROVISIONAL_MAX_WARNINGS };
export type { BuildCompleteExportReportOptions as BuildJsonExportDocumentOptions };

export function buildJsonExportDocument(
  context: WriterContext,
  prepared: readonly PreparedSheet[],
  report: ExportReport,
  options: BuildCompleteExportReportOptions
): JsonExportDocument {
  let capturedOptions: BuildCompleteExportReportOptions;
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');
    const { maxWarnings, signal, csvTransformCounts } = options;
    capturedOptions = {
      maxWarnings,
      signal,
      ...(csvTransformCounts !== undefined ? { csvTransformCounts } : {})
    };
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }
  const { signal } = capturedOptions;
  try {
    const verifiedReport = buildCompleteExportReport(context, prepared, report, capturedOptions);

    if (verifiedReport.export.format !== 'json' || verifiedReport.export.complete !== true) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    const consistency = verifiedReport.export.consistency;
    if (consistency === 'not_atomic_changes_detected') {
      throw new DomainError('SOURCE_CHANGED_CONCURRENTLY');
    }

    const exportMeta: JsonExportDocument['export'] = Object.freeze({
      startedAt: verifiedReport.export.startedAt,
      producedAt: verifiedReport.export.producedAt,
      mode: verifiedReport.export.mode,
      format: 'json',
      visibility: verifiedReport.export.visibility,
      complete: true,
      consistency,
      warnings: verifiedReport.export.warnings
    });

    const sheetCount = prepared.length;
    const sheets: JsonExportSheet[] = [];
    for (let i = 0; i < sheetCount; i++) {
      if ((i & 63) === 0 && signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const p = prepared[i];
      sheets.push(Object.freeze({
        id: p.metadata.id,
        title: p.metadata.title,
        index: p.metadata.index,
        scope: Object.freeze({
          sheetId: p.scope.sheetId,
          r0: p.scope.r0,
          c0: p.scope.c0,
          r1: p.scope.r1,
          c1: p.scope.c1
        }),
        visibility: Object.freeze({
          mode: context.visibility,
          excludedRows: Object.freeze(p.excludedIntervals.rows.map((iv: DimensionInterval) => Object.freeze({ start: iv.start, end: iv.end }))),
          excludedColumns: Object.freeze(p.excludedIntervals.columns.map((iv: DimensionInterval) => Object.freeze({ start: iv.start, end: iv.end })))
        }),
        cells: p.cells
      }));
    }

    const doc: JsonExportDocument = Object.freeze({
      schemaVersion: verifiedReport.schemaVersion,
      source: verifiedReport.source,
      export: exportMeta,
      selectedScopes: verifiedReport.selectedScopes,
      sheetOrder: verifiedReport.sheetOrder,
      limitsVersion: verifiedReport.limitsVersion,
      nameMappings: verifiedReport.nameMappings,
      exclusions: verifiedReport.exclusions,
      ...(verifiedReport.sourceObservations !== undefined ? { sourceObservations: verifiedReport.sourceObservations } : {}),
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
