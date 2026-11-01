import type { ReportCsvTransforms, SheetNameMapping } from '../contracts/domain.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { encodeCsv, PROVISIONAL_MAX_CSV_BYTES } from './csv.ts';
import { mapCsvFilenames } from './names.ts';
import type { PreparedSheet } from './prepare.ts';

export interface CsvSheetBytes {
  readonly sheetId: number;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly transformedCells: number;
}

export interface EncodeCsvSheetsOptions {
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

export interface EncodeCsvSheetsResult {
  readonly sheets: readonly CsvSheetBytes[];
  readonly nameMappings: readonly SheetNameMapping[];
  readonly totalByteLength: number;
  readonly csvTransformCounts: ReportCsvTransforms;
}

/** Requires verified prepareWriterData output; does not prove coverage or authorize publication. */
export function encodeCsvSheets(
  prepared: readonly PreparedSheet[],
  options: { readonly maxBytes: number; readonly signal: AbortSignal }
): EncodeCsvSheetsResult {
  let maxBytes: number, signal: AbortSignal;
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');
    const { maxBytes: mb, signal: sig } = options;
    if (
      typeof mb !== 'number' || !Number.isSafeInteger(mb) || mb < 0 || Object.is(mb, -0) || mb > PROVISIONAL_MAX_CSV_BYTES ||
      !sig || typeof sig !== 'object' || typeof sig.aborted !== 'boolean' ||
      typeof (sig as any).addEventListener !== 'function' || typeof (sig as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (sig.aborted) throw new DomainError('OPERATION_ABORTED');
    maxBytes = mb;
    signal = sig;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('CONFIG_INVALID');
  }

  if (!Array.isArray(prepared) || prepared.length === 0) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

  const sheets: CsvSheetBytes[] = [];
  try {
    const rawMappings = mapCsvFilenames(prepared.map(p => ({ id: p.metadata.id, title: p.metadata.title })));
    const nameMappings: readonly SheetNameMapping[] = Object.freeze(
      rawMappings.map(m => Object.freeze({ sheetId: m.sheetId, originalTitle: m.originalTitle, exportedName: m.exportedName }))
    );

    let remaining = maxBytes;
    let totalByteLength = 0;
    let totalTransformedCells = 0;
    const bySheet: { readonly sheetId: number; readonly transformedCells: number }[] = [];

    for (let i = 0; i < prepared.length; i++) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const sheet = prepared[i];
      const res = encodeCsv(sheet.scope, sheet.cells, { maxBytes: remaining, signal });
      remaining -= res.bytes.byteLength;
      totalByteLength += res.bytes.byteLength;
      totalTransformedCells += res.transformedCells;
      if (!Number.isSafeInteger(totalTransformedCells)) throw new DomainError('CELL_LIMIT_EXCEEDED');

      sheets.push(Object.freeze({
        sheetId: sheet.metadata.id,
        filename: nameMappings[i].exportedName,
        bytes: res.bytes,
        transformedCells: res.transformedCells,
      }));
      bySheet.push(Object.freeze({ sheetId: sheet.metadata.id, transformedCells: res.transformedCells }));
    }

    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

    return Object.freeze({
      sheets: Object.freeze(sheets),
      nameMappings,
      totalByteLength,
      csvTransformCounts: Object.freeze({
        policy: 'apostrophe_prefix_v1',
        totalTransformedCells,
        bySheet: Object.freeze(bySheet),
      }),
    });
  } catch (err) {
    sheets.length = 0;
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
