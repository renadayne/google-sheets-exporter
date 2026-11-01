import { describe, it, expect } from 'vitest';
import type { NormalizedChunk, Cell, ExportMode } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import { collectWriterCells, PROVISIONAL_MAX_CELLS } from '../../src/export/cells.ts';

function makeCtx(mode: ExportMode = 'raw', sheetOrder = [0]): WriterContext {
  return {
    sourceId: 'src-1', title: 'T', locale: 'en', timeZone: 'UTC',
    scopes: sheetOrder.map(sheetId => ({ sheetId, rect: { sheetId, r0: 0, c0: 0, r1: 100000, c1: 100 } })),
    mode, format: 'json', visibility: 'include_all', limitsVersion: '1.0',
    sheetOrder, sheets: sheetOrder.map((id, index) => ({ id, title: `S${id}`, index, type: 'GRID', hidden: false }))
  } as WriterContext;
}

function makeChunk(sheetId: number, rect: [number, number, number, number], cells: Cell[], id = 'c1'): NormalizedChunk {
  return {
    jobId: 'j1', chunkId: id,
    rect: { sheetId, r0: rect[0], c0: rect[1], r1: rect[2], c1: rect[3] },
    cells, excludedIntervals: { rows: [], columns: [] }, byteCount: 64
  };
}

describe('T24b1c collectWriterCells', () => {
  const signal = new AbortController().signal;
  const opts = { maxCells: PROVISIONAL_MAX_CELLS, signal };

  it('handles shuffled A1/D50/Z90000, 4 kinds error copy, blank tab, and input/output isolation', () => {
    const a1: Cell = { r: 0, c: 0, kind: 'string', value: '00123' };
    const d50: Cell = { r: 49, c: 3, kind: 'number', value: 123.45 };
    const err: Cell = { r: 50, c: 4, kind: 'error', value: { code: '#DIV/0!', message: 'Divide by zero' } };
    const z90k: Cell = { r: 89999, c: 25, kind: 'boolean', value: true };
    const rawCells = [z90k, a1, err, d50];
    const ch = makeChunk(0, [0, 0, 90000, 30], rawCells);
    const ctx = makeCtx('raw', [0, 1]);

    const res = collectWriterCells(ctx, [ch], opts);
    expect(res).toHaveLength(2);
    expect(res[0].sheetId).toBe(0);
    expect(res[1].sheetId).toBe(1);
    expect(res[1].cells).toEqual([]);
    expect(res[0].cells.map(c => `${c.r},${c.c}`)).toEqual(['0,0', '49,3', '50,4', '89999,25']);
    expect(res[0].cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: '00123' },
      { r: 49, c: 3, kind: 'number', value: 123.45 },
      { r: 50, c: 4, kind: 'error', value: { code: '#DIV/0!', message: 'Divide by zero' } },
      { r: 89999, c: 25, kind: 'boolean', value: true }
    ]);

    const outErr = res[0].cells[2];
    expect(outErr.value).toEqual({ code: '#DIV/0!', message: 'Divide by zero' });
    expect(outErr.value).not.toBe(err.value);
    expect(Object.isFrozen(res)).toBe(true);
    expect(Object.isFrozen(res[0])).toBe(true);
    expect(Object.isFrozen(res[0].cells)).toBe(true);
    expect(Object.isFrozen(res[0].cells[0])).toBe(true);
    expect(Object.isFrozen(outErr.value)).toBe(true);
    expect(Object.isFrozen(ch.cells)).toBe(false);
    expect(ch.cells[0]).toBe(z90k);
    (err.value as { message: string }).message = 'changed source';
    expect(outErr.value).toEqual({ code: '#DIV/0!', message: 'Divide by zero' });
  });

  it('keeps nonzero-origin positions and number-format metadata without shifting or converting', () => {
    const cells: Cell[] = [
      { r: 5, c: 3, kind: 'number', value: 45678.5, numberFormatType: 'DATE_TIME' },
      { r: 4, c: 2, kind: 'string', value: '  café 🌟\r\n' }
    ];
    expect(collectWriterCells(makeCtx(), [makeChunk(0, [4, 2, 6, 4], cells)], opts)[0].cells).toEqual([
      { r: 4, c: 2, kind: 'string', value: '  café 🌟\r\n' },
      { r: 5, c: 3, kind: 'number', value: 45678.5, numberFormatType: 'DATE_TIME' }
    ]);
  });

  it('enforces formatted, raw, and formula_text modes and permits literal =... text', () => {
    const lit = (r: number): Cell => ({ r, c: 0, kind: 'string', value: '=SUM(A1:B2)' });
    const ft = (r: number, val: string, formula: string): Cell =>
      ({ r, c: 0, kind: 'string', value: val, formulaText: formula });
    const num: Cell = { r: 1, c: 0, kind: 'number', value: 42 };

    const chLit = makeChunk(0, [0, 0, 10, 10], [lit(0)]);
    expect(collectWriterCells(makeCtx('formatted'), [chLit], opts)[0].cells).toHaveLength(1);
    expect(collectWriterCells(makeCtx('raw'), [chLit], opts)[0].cells).toHaveLength(1);
    expect(collectWriterCells(makeCtx('formula_text'), [chLit], opts)[0].cells).toHaveLength(1);

    expect(() => collectWriterCells(makeCtx('formatted'), [makeChunk(0, [0, 0, 10, 10], [num])], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(() => collectWriterCells(makeCtx('formatted'), [makeChunk(0, [0, 0, 10, 10], [ft(0, '=A', '=A')])], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(() => collectWriterCells(makeCtx('raw'), [makeChunk(0, [0, 0, 10, 10], [ft(0, '=A', '=A')])], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);

    const validFt = makeChunk(0, [0, 0, 10, 10], [ft(0, '=SUM(A1)', '=SUM(A1)'), num]);
    expect(collectWriterCells(makeCtx('formula_text'), [validFt], opts)[0].cells).toHaveLength(2);
    expect(collectWriterCells(makeCtx('formula_text'), [validFt], opts)[0].cells).toEqual([
      { r: 0, c: 0, kind: 'string', value: '=SUM(A1)', formulaText: '=SUM(A1)' },
      { r: 1, c: 0, kind: 'number', value: 42 }
    ]);

    const mismatchFt = makeChunk(0, [0, 0, 10, 10], [ft(0, '=A1', '=B1')]);
    expect(() => collectWriterCells(makeCtx('formula_text'), [mismatchFt], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
  });

  it('rejects duplicates within same chunk and across chunks for same sheet', () => {
    const c1: Cell = { r: 2, c: 2, kind: 'number', value: 1 };
    const c2: Cell = { r: 2, c: 2, kind: 'number', value: 2 };
    const dupChunk = makeChunk(0, [0, 0, 10, 10], [c1, c2]);
    expect(() => collectWriterCells(makeCtx('raw'), [dupChunk], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);

    const chA = makeChunk(0, [0, 0, 5, 5], [c1], 'cA');
    const chB = makeChunk(0, [0, 0, 5, 5], [c2], 'cB');
    expect(() => collectWriterCells(makeCtx('raw'), [chA, chB], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);

    const diffSheetB = makeChunk(1, [0, 0, 5, 5], [c2], 'cB');
    expect(collectWriterCells(makeCtx('raw', [0, 1]), [chA, diffSheetB], opts)).toHaveLength(2);
  });

  it('rejects cells outside owning chunk, foreign chunk sheetId, and malformed cell arrays', () => {
    const outCell: Cell = { r: 6, c: 2, kind: 'number', value: 1 };
    const ch = makeChunk(0, [0, 0, 5, 5], [outCell]);
    expect(() => collectWriterCells(makeCtx('raw'), [ch], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);

    const foreign = makeChunk(999, [0, 0, 5, 5], [{ r: 0, c: 0, kind: 'number', value: 1 }]);
    expect(() => collectWriterCells(makeCtx('raw', [0]), [foreign], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);

    const badArrayChunk = { ...ch, cells: null as any };
    expect(() => collectWriterCells(makeCtx('raw'), [badArrayChunk], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
  });

  it('rejects unsafe coordinates -0, MAX_SAFE_INTEGER+1, and bad rects', () => {
    const negZeroR: any = { r: -0, c: 0, kind: 'number', value: 1 };
    const negZeroC: any = { r: 0, c: -0, kind: 'number', value: 1 };
    const maxSafePlus1: any = { r: Number.MAX_SAFE_INTEGER + 1, c: 0, kind: 'number', value: 1 };
    expect(() => collectWriterCells(makeCtx('raw'), [makeChunk(0, [0, 0, 10, 10], [negZeroR])], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(() => collectWriterCells(makeCtx('raw'), [makeChunk(0, [0, 0, 10, 10], [negZeroC])], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(() => collectWriterCells(makeCtx('raw'), [makeChunk(0, [0, 0, 10, 10], [maxSafePlus1])], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);

    const badRect = makeChunk(0, [-0 as any, 0, 10, 10], [{ r: 0, c: 0, kind: 'number', value: 1 }]);
    expect(() => collectWriterCells(makeCtx('raw'), [badRect], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
  });

  it('rejects NaN, Date, unknown fields, and credentials like accessToken', () => {
    const nanCell: any = { r: 0, c: 0, kind: 'number', value: NaN };
    const dateCell: any = { r: 0, c: 0, kind: 'number', value: new Date() };
    const tokenCell: any = { r: 0, c: 0, kind: 'string', value: 'secret', accessToken: 'ya29.xyz' };
    const tokenErr: any = { r: 0, c: 0, kind: 'error', value: { code: 'E', message: 'M', accessToken: 'leak' } };

    expect(() => collectWriterCells(makeCtx('raw'), [makeChunk(0, [0, 0, 10, 10], [nanCell])], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(() => collectWriterCells(makeCtx('raw'), [makeChunk(0, [0, 0, 10, 10], [dateCell])], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(() => collectWriterCells(makeCtx('raw'), [makeChunk(0, [0, 0, 10, 10], [tokenCell])], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
    expect(() => collectWriterCells(makeCtx('raw'), [makeChunk(0, [0, 0, 10, 10], [tokenErr])], opts))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
  });

  it('enforces options validation, preabort, hostile getters, and cap-before-cell-getter', () => {
    expect(() => collectWriterCells(makeCtx('raw'), [], { maxCells: -1, signal } as any))
      .toThrowError(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
    expect(() => collectWriterCells(makeCtx('raw'), [], { maxCells: PROVISIONAL_MAX_CELLS + 1, signal }))
      .toThrowError(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
    expect(() => collectWriterCells(makeCtx('raw'), [], { maxCells: 10, signal: {} as any }))
      .toThrowError(SAFE_ERROR_MESSAGES.CONFIG_INVALID);

    const abortedSig = new AbortController();
    abortedSig.abort();
    expect(() => collectWriterCells(makeCtx('raw'), [], { maxCells: 10, signal: abortedSig.signal }))
      .toThrowError(SAFE_ERROR_MESSAGES.OPERATION_ABORTED);

    const hostileOpt = {
      get maxCells(): number { throw new Error('hostile-opt'); },
      signal
    };
    expect(() => collectWriterCells(makeCtx('raw'), [], hostileOpt as any))
      .toThrowError(SAFE_ERROR_MESSAGES.CONFIG_INVALID);

    const hostileCell = {
      get r(): number { throw new Error('hostile-cell'); }
    };
    const hostileChunk = makeChunk(0, [0, 0, 10, 10], [hostileCell as any, hostileCell as any]);
    expect(() => collectWriterCells(makeCtx('raw'), [hostileChunk], { maxCells: 1, signal }))
      .toThrowError(SAFE_ERROR_MESSAGES.CELL_LIMIT_EXCEEDED);

    expect(() => collectWriterCells(makeCtx('raw'), [hostileChunk], { maxCells: 10, signal }))
      .toThrowError(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);

    const hostileDomainErr = new DomainError('FORMAT_SERIALIZATION_FAILED');
    (hostileDomainErr as any).safeMessage = 'mutated';
    (hostileDomainErr as any).secretToken = 'leak';
    const hostileCtx = {
      ...makeCtx('raw'),
      get mode(): any { throw hostileDomainErr; }
    };
    try {
      collectWriterCells(hostileCtx, [makeChunk(0, [0, 0, 10, 10], [])], opts);
      expect.fail('should throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('FORMAT_SERIALIZATION_FAILED');
      expect(err.safeMessage).toBe(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
      expect(err.secretToken).toBeUndefined();
    }
  });
});
