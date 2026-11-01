import { describe, it, expect } from 'vitest';
import type { Cell, ExportMode, ExcludedIntervals, NormalizedChunk, VisibilityMode } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import { PROVISIONAL_MAX_CHUNKS } from '../../src/export/coverage.ts';
import { PROVISIONAL_MAX_INTERVALS } from '../../src/export/exclusions.ts';
import { PROVISIONAL_MAX_CELLS } from '../../src/export/cells.ts';

function makeCtx(mode: ExportMode = 'raw', sheetOrder = [0], visibility: VisibilityMode = 'include_all', scopes?: any[]): WriterContext {
  return {
    sourceId: 'src1', title: 'T', locale: 'en', timeZone: 'UTC',
    scopes: scopes ?? sheetOrder.map(sheetId => ({ sheetId, rect: { sheetId, r0: 0, c0: 0, r1: 100, c1: 50 } })),
    mode, format: 'json', visibility, limitsVersion: '1.0', sheetOrder,
    sheets: sheetOrder.map((id, index) => ({ id, title: `S${id}`, index, type: 'GRID', hidden: false, rows: 100, columns: 50 }))
  } as WriterContext;
}

function makeChunk(sheetId: number, rect: [number, number, number, number], cells: Cell[], excl: ExcludedIntervals = { rows: [], columns: [] }, id = 'c1'): NormalizedChunk {
  return {
    jobId: 'j1', chunkId: `${id}_${sheetId}`,
    rect: { sheetId, r0: rect[0], c0: rect[1], r1: rect[2], c1: rect[3] },
    cells, excludedIntervals: excl, byteCount: 64
  };
}

describe('T24b1d prepareWriterData', () => {
  const signal = new AbortController().signal;
  const opts = { maxChunks: PROVISIONAL_MAX_CHUNKS, maxIntervals: PROVISIONAL_MAX_INTERVALS, maxCells: PROVISIONAL_MAX_CELLS, signal };

  it('2-tab fixture: shuffled split chunks, nonzero-origin scope, typed cells, blank tab, source order, freeze & isolation', () => {
    const s10Scope = { sheetId: 10, rect: { sheetId: 10, r0: 5, c0: 2, r1: 9, c1: 6 } };
    const s20Scope = { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 10, c1: 10 } };
    const ctx = makeCtx('raw', [10, 20], 'include_all', [s10Scope, s20Scope]);

    const strCell: Cell = { r: 5, c: 2, kind: 'string', value: 'hello' };
    const numCell: Cell = { r: 6, c: 3, kind: 'number', value: 42 };
    const boolCell: Cell = { r: 7, c: 4, kind: 'boolean', value: false };
    const errCell: Cell = { r: 8, c: 5, kind: 'error', value: { code: '#REF!', message: 'Invalid ref' } };

    const ch10a = makeChunk(10, [5, 2, 7, 6], [strCell, numCell], { rows: [], columns: [] }, 'ch10a');
    const ch10b = makeChunk(10, [7, 2, 9, 6], [boolCell, errCell], { rows: [], columns: [] }, 'ch10b');
    const ch20 = makeChunk(20, [0, 0, 10, 10], [], { rows: [], columns: [] }, 'ch20');

    const prep = prepareWriterData(ctx, [ch10b, ch20, ch10a], opts);
    expect(prep).toHaveLength(2);
    expect(prep[0].metadata).toEqual({ id: 10, title: 'S10', index: 0, type: 'GRID', hidden: false, rows: 100, columns: 50 });
    expect(prep[0].scope).toEqual({ sheetId: 10, r0: 5, c0: 2, r1: 9, c1: 6 });
    expect(prep[0].cells).toEqual([strCell, numCell, boolCell, errCell]);
    expect(prep[1].metadata).toEqual({ id: 20, title: 'S20', index: 1, type: 'GRID', hidden: false, rows: 100, columns: 50 });
    expect(prep[1].scope).toEqual({ sheetId: 20, r0: 0, c0: 0, r1: 10, c1: 10 });
    expect(prep[1].cells).toEqual([]);

    expect(Object.isFrozen(prep) && Object.isFrozen(prep[0]) && Object.isFrozen(prep[0].metadata)).toBe(true);
    expect(Object.isFrozen(prep[0].scope) && Object.isFrozen(prep[0].excludedIntervals)).toBe(true);
    expect(Object.isFrozen(ctx)).toBe(false);
    expect(prep[0].scope).not.toBe(ctx.scopes[0].rect);
    expect(prep[0].metadata).not.toBe(ctx.sheets[0]);
    (ctx.sheets[0] as { title: string }).title = 'changed source title';
    (ctx.scopes[0].rect as { r0: number }).r0 = 0;
    expect(prep[0].metadata.title).toBe('S10');
    expect(prep[0].scope.r0).toBe(5);
  });

  it('api_visible with >1 exclusion interval proves binary lookup edges and retains surviving coords', () => {
    const scope = { sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 20, c1: 10 } };
    const ctx = makeCtx('raw', [0], 'api_visible', [scope]);
    const excl = { rows: [{ start: 2, end: 4 }, { start: 6, end: 8 }], columns: [{ start: 3, end: 5 }] };

    const surviving: Cell[] = [
      { r: 1, c: 1, kind: 'string', value: 'before-iv1' },
      { r: 4, c: 1, kind: 'string', value: 'end-edge-iv1' },
      { r: 5, c: 1, kind: 'string', value: 'between-ivs' },
      { r: 8, c: 1, kind: 'string', value: 'end-edge-iv2' },
      { r: 9, c: 2, kind: 'string', value: 'before-col' },
      { r: 9, c: 5, kind: 'string', value: 'end-edge-col' }
    ];
    const ch = makeChunk(0, [0, 0, 20, 10], surviving, excl);
    const prep = prepareWriterData(ctx, [ch], opts);

    expect(prep[0].excludedIntervals).toEqual(excl);
    expect(prep[0].cells.map(c => `${c.r},${c.c}`)).toEqual(['1,1', '4,1', '5,1', '8,1', '9,2', '9,5']);
  });

  it('rejects a supplied cell inside excluded row or column interval', () => {
    const scope = { sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 20, c1: 10 } };
    const ctx = makeCtx('raw', [0], 'api_visible', [scope]);
    const excl = { rows: [{ start: 2, end: 4 }, { start: 6, end: 8 }], columns: [{ start: 3, end: 5 }] };

    for (const [r, c] of [[2, 1], [3, 1], [6, 1], [7, 1], [1, 3], [1, 4]]) {
      const badCell: Cell = { r, c, kind: 'string', value: 'bad' };
      const ch = makeChunk(0, [0, 0, 20, 10], [badCell], excl);
      expect(() => prepareWriterData(ctx, [ch], opts)).toThrowError(
        expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' })
      );
    }
  });

  it('propagates invalid coverage, mode, and conflicting exclusions before output', () => {
    const ctx = makeCtx('raw', [0]);
    const halfChunk = makeChunk(0, [0, 0, 50, 50], []);
    expect(() => prepareWriterData(ctx, [halfChunk], opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    const badModeCtx = { ...ctx, mode: 'invalid' as any };
    const fullChunk = makeChunk(0, [0, 0, 100, 50], []);
    expect(() => prepareWriterData(badModeCtx, [fullChunk], opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    const visCtx = makeCtx('raw', [0], 'api_visible');
    const chA = makeChunk(0, [0, 0, 100, 25], [], { rows: [{ start: 2, end: 4 }], columns: [] }, 'cA');
    const chB = makeChunk(0, [0, 25, 100, 50], [], { rows: [], columns: [] }, 'cB');
    expect(() => prepareWriterData(visCtx, [chA, chB], opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('respects explicit caps and pre-aborted signal', () => {
    const ctx = makeCtx('raw', [0]);
    const chA = makeChunk(0, [0, 0, 50, 50], [{ r: 0, c: 0, kind: 'number', value: 1 }], { rows: [], columns: [] }, 'a');
    const chB = makeChunk(0, [50, 0, 100, 50], [{ r: 50, c: 0, kind: 'number', value: 2 }], { rows: [], columns: [] }, 'b');

    const abortedSig = AbortSignal.abort();
    expect(() => prepareWriterData(ctx, [chA, chB], { ...opts, signal: abortedSig })).toThrowError(
      expect.objectContaining({ code: 'OPERATION_ABORTED' })
    );

    expect(() => prepareWriterData(ctx, [chA, chB], { ...opts, maxChunks: 1 })).toThrowError(
      expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' })
    );

    expect(() => prepareWriterData(ctx, [chA, chB], { ...opts, maxCells: 1 })).toThrowError(
      expect.objectContaining({ code: 'CELL_LIMIT_EXCEEDED' })
    );

    expect(() => prepareWriterData(ctx, [chA, chB], null as any)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
  });
});
