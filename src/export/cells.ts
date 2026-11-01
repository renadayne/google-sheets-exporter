/**
 * T24b1c Pure Shared Cell Collection — Bounded prerequisite of T24 JSON Writer.
 */
import type { Cell, NormalizedChunk, StringCell, NumberCell, BooleanCell, ErrorCell } from '../contracts/domain.ts';
import type { WriterContext } from '../contracts/ports.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { isCell } from '../contracts/validation.ts';

export interface CollectedSheetCells {
  readonly sheetId: number;
  readonly cells: readonly Cell[];
}

export const PROVISIONAL_MAX_CELLS = 250000;

function isNonNegativeSafeInt(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && !Object.is(val, -0);
}

/** Requires prior assertWriterCoverage; exclusion coherence and report checks are separate. */
export function collectWriterCells(
  context: WriterContext,
  chunks: readonly NormalizedChunk[],
  options: { readonly maxCells: number; readonly signal: AbortSignal }
): readonly CollectedSheetCells[] {
  let maxCells: number;
  let signal: AbortSignal;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DomainError('CONFIG_INVALID');
    const { maxCells: rawMax, signal: rawSig } = options;
    if (
      !isNonNegativeSafeInt(rawMax) || rawMax > PROVISIONAL_MAX_CELLS || !rawSig || typeof rawSig !== 'object' ||
      typeof rawSig.aborted !== 'boolean' || typeof (rawSig as any).addEventListener !== 'function' ||
      typeof (rawSig as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (rawSig.aborted) throw new DomainError('OPERATION_ABORTED');
    maxCells = rawMax;
    signal = rawSig;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('CONFIG_INVALID');
  }

  try {
    if (
      !context || typeof context !== 'object' || !Array.isArray(context.sheetOrder) || !Array.isArray(chunks) ||
      (context.mode !== 'formatted' && context.mode !== 'raw' && context.mode !== 'formula_text')
    ) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    const validSheets = new Set<number>();
    const cellsBySheet = new Map<number, Cell[]>();
    const seenCoords = new Map<number, Set<string>>();

    for (const id of context.sheetOrder) {
      if (!isNonNegativeSafeInt(id) || validSheets.has(id)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      validSheets.add(id);
      cellsBySheet.set(id, []);
      seenCoords.set(id, new Set<string>());
    }

    let totalIncoming = 0;
    for (const chunk of chunks) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      if (!chunk || typeof chunk !== 'object' || !Array.isArray(chunk.cells)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      const len = chunk.cells.length;
      if (typeof len !== 'number' || !Number.isSafeInteger(len) || len < 0) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      totalIncoming += len;
      if (!Number.isSafeInteger(totalIncoming) || totalIncoming > maxCells) {
        throw new DomainError('CELL_LIMIT_EXCEEDED');
      }
    }

    for (const chunk of chunks) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const rect = chunk.rect;
      if (
        !rect || typeof rect !== 'object' || Object.getOwnPropertySymbols(rect).length > 0 ||
        !validSheets.has(rect.sheetId) || !isNonNegativeSafeInt(rect.r0) || !isNonNegativeSafeInt(rect.c0) ||
        !isNonNegativeSafeInt(rect.r1) || !isNonNegativeSafeInt(rect.c1) || rect.r0 > rect.r1 || rect.c0 > rect.c1
      ) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      const sheetCells = cellsBySheet.get(rect.sheetId)!;
      const sheetSeen = seenCoords.get(rect.sheetId)!;

      for (const cell of chunk.cells) {
        if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
        if (!isCell(cell) || Object.getOwnPropertySymbols(cell).length > 0) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        const { r, c, kind, value } = cell;
        if (!isNonNegativeSafeInt(r) || !isNonNegativeSafeInt(c)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        if (r < rect.r0 || r >= rect.r1 || c < rect.c0 || c >= rect.c1) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

        const coordKey = `${r},${c}`;
        if (sheetSeen.has(coordKey)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        sheetSeen.add(coordKey);

        const keys = Object.keys(cell);
        const hasNft = 'numberFormatType' in cell && cell.numberFormatType !== undefined;
        if (hasNft && typeof cell.numberFormatType !== 'string') throw new DomainError('FORMAT_SERIALIZATION_FAILED');

        const allowed = kind === 'string'
          ? ['r', 'c', 'kind', 'value', 'formulaText', 'numberFormatType']
          : ['r', 'c', 'kind', 'value', 'numberFormatType'];
        if (keys.some(k => !allowed.includes(k))) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

        const copy: Record<string, unknown> = { r, c, kind, value };
        if (hasNft) copy.numberFormatType = cell.numberFormatType;

        if (kind === 'string') {
          if (typeof value !== 'string') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          const hasFt = 'formulaText' in cell && cell.formulaText !== undefined;
          if (hasFt && typeof cell.formulaText !== 'string') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          if (context.mode === 'formatted' && hasFt) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          if (context.mode === 'raw' && hasFt) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          if (context.mode === 'formula_text' && hasFt && cell.formulaText !== value) {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
          if (hasFt) copy.formulaText = cell.formulaText;
          sheetCells.push(Object.freeze(copy as unknown as StringCell));
        } else {
          if ('formulaText' in cell && cell.formulaText !== undefined) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          if (context.mode === 'formatted') throw new DomainError('FORMAT_SERIALIZATION_FAILED');

          if (kind === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
            sheetCells.push(Object.freeze(copy as unknown as NumberCell));
          } else if (kind === 'boolean') {
            if (typeof value !== 'boolean') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
            sheetCells.push(Object.freeze(copy as unknown as BooleanCell));
          } else if (kind === 'error') {
            if (!value || typeof value !== 'object' || Object.getOwnPropertySymbols(value).length > 0) {
              throw new DomainError('FORMAT_SERIALIZATION_FAILED');
            }
            const { code, message } = value as unknown as Record<string, unknown>;
            if (Object.keys(value).length !== 2 || typeof code !== 'string' || typeof message !== 'string') {
              throw new DomainError('FORMAT_SERIALIZATION_FAILED');
            }
            copy.value = Object.freeze({ code, message });
            sheetCells.push(Object.freeze(copy as unknown as ErrorCell));
          } else {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
        }
      }
    }

    const result: CollectedSheetCells[] = [];
    for (const sheetId of context.sheetOrder) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      const sheetCells = cellsBySheet.get(sheetId)!;
      sheetCells.sort((a, b) => (a.r !== b.r ? a.r - b.r : a.c - b.c));
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      result.push(Object.freeze({ sheetId, cells: Object.freeze(sheetCells) }));
    }

    return Object.freeze(result);
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
