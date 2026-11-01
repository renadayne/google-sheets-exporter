import { describe, it, expect, vi } from 'vitest';
import type { NormalizedChunk } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import { snapshotWriterContext } from '../../src/export/context.ts';
import {
  snapshotWriterChunk, PROVISIONAL_MAX_CELLS, PROVISIONAL_MAX_INTERVALS, PROVISIONAL_MAX_DECODED_BYTES
} from '../../src/export/chunk-snapshot.ts';

function makeCtx(vis: 'include_all' | 'api_visible' = 'include_all', mode: 'raw' | 'formatted' = 'raw'): WriterContext {
  const c: WriterContext = {
    sourceId: 'src-1', title: 'T', locale: 'en-US', timeZone: 'UTC',
    scopes: [{ sheetId: 1, rect: { sheetId: 1, r0: 0, c0: 0, r1: 100, c1: 50 } }],
    mode, format: 'json', visibility: vis, limitsVersion: '1.0', sheetOrder: [1],
    sheets: [{ id: 1, title: 'S1', index: 0, type: 'GRID', hidden: false, rows: 100, columns: 50 }]
  };
  return snapshotWriterContext(c, { maxSheets: 10, signal: new AbortController().signal });
}

function makeChunk(overrides: Partial<NormalizedChunk> = {}): NormalizedChunk {
  return {
    jobId: 'job-1', chunkId: 'c-1', rect: { sheetId: 1, r0: 10, c0: 5, r1: 20, c1: 15 },
    cells: [
      { r: 10, c: 5, kind: 'string', value: 'txt', numberFormatType: 'TEXT' },
      { r: 11, c: 6, kind: 'number', value: 42 },
      { r: 12, c: 7, kind: 'boolean', value: false },
      { r: 13, c: 8, kind: 'error', value: { code: '#REF!', message: 'Bad ref' } }
    ],
    excludedIntervals: { rows: [], columns: [] }, byteCount: 256, ...overrides
  };
}

const opts = (sig = new AbortController().signal, extra: Record<string, unknown> = {}) => ({
  maxCells: PROVISIONAL_MAX_CELLS, maxIntervals: PROVISIONAL_MAX_INTERVALS,
  maxDecodedBytes: PROVISIONAL_MAX_DECODED_BYTES, signal: sig, ...extra
});

describe('T24c1b snapshotWriterChunk', () => {
  it('accepts partial chunk with 4 scalar kinds, metadata, coords, frozen isolation, and no toJSON', () => {
    const ctx = makeCtx();
    const toJSONHook = vi.fn();
    const proto = { toJSON: toJSONHook };
    const raw = Object.assign(Object.create(proto), makeChunk());
    const snap = snapshotWriterChunk(ctx, raw, opts());

    expect(snap.jobId).toBe('job-1');
    expect(snap.chunkId).toBe('c-1');
    expect(snap.rect).toEqual({ sheetId: 1, r0: 10, c0: 5, r1: 20, c1: 15 });
    expect(snap.cells).toHaveLength(4);
    expect(snap.cells[0]).toEqual({ r: 10, c: 5, kind: 'string', value: 'txt', numberFormatType: 'TEXT' });
    expect(snap.cells[1]).toEqual({ r: 11, c: 6, kind: 'number', value: 42 });
    expect(snap.cells[2]).toEqual({ r: 12, c: 7, kind: 'boolean', value: false });
    expect(snap.cells[3]).toEqual({ r: 13, c: 8, kind: 'error', value: { code: '#REF!', message: 'Bad ref' } });
    expect(Object.isFrozen(snap) && Object.isFrozen(snap.rect) && Object.isFrozen(snap.cells)).toBe(true);
    expect(toJSONHook).not.toHaveBeenCalled();

    // Input mutation isolation
    (raw as unknown as Record<string, unknown>).jobId = 'mutated';
    (raw.cells as unknown as Record<string, unknown>[])[0].value = 'mutated';
    expect(snap.jobId).toBe('job-1');
    expect(snap.cells[0].value).toBe('txt');
  });

  it('rejects foreign, outside, zero area, unsafe coords, extra auth, invalid shape, ID, or byteCount', () => {
    const ctx = makeCtx();
    const bad = (chunk: unknown, code = 'FORMAT_SERIALIZATION_FAILED') => {
      expect(() => snapshotWriterChunk(ctx, chunk as NormalizedChunk, opts()))
        .toThrow(expect.objectContaining({ code } as DomainError));
    };

    bad(makeChunk({ rect: { sheetId: 999, r0: 10, c0: 5, r1: 20, c1: 15 } })); // foreign
    bad(makeChunk({ rect: { sheetId: 1, r0: 10, c0: 5, r1: 105, c1: 15 } })); // outside scope
    bad(makeChunk({ rect: { sheetId: 1, r0: 10, c0: 5, r1: 10, c1: 15 } })); // zero area
    bad(makeChunk({ rect: { sheetId: 1, r0: -0, c0: 5, r1: 20, c1: 15 } })); // -0 coord
    bad(makeChunk({ rect: { sheetId: 1, r0: -1, c0: 5, r1: 20, c1: 15 } })); // negative
    bad({ ...makeChunk(), auth: 'secret-token' }); // extra auth property
    const masked = { ...makeChunk(), accessToken: 'synthetic-secret' };
    Object.defineProperty(masked, 'byteCount', { enumerable: false });
    bad(masked); // Equal key count must not hide an unknown enumerable key.
    bad({ ...makeChunk(), [Symbol('extra')]: 1 }); // symbol property
    bad(makeChunk({ jobId: '' })); // empty job ID
    bad(makeChunk({ chunkId: '' })); // empty chunk ID
    bad(makeChunk({ byteCount: -1 })); // negative byteCount
    bad(makeChunk({ byteCount: -0 })); // -0 byteCount
    bad(makeChunk({ cells: 'not-array' as unknown as [] })); // malformed shape
    expect(() => snapshotWriterChunk(ctx, makeChunk(), null as unknown as ReturnType<typeof opts>))
      .toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('rejects cells inside hidden rows or columns under api_visible', () => {
    const ctx = makeCtx('api_visible');
    const badRow = makeChunk({
      rect: { sheetId: 1, r0: 10, c0: 5, r1: 20, c1: 15 },
      cells: [{ r: 12, c: 7, kind: 'number', value: 1 }],
      excludedIntervals: { rows: [{ start: 12, end: 14 }], columns: [] }
    });
    expect(() => snapshotWriterChunk(ctx, badRow, opts())).toThrow(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    const badCol = makeChunk({
      rect: { sheetId: 1, r0: 10, c0: 5, r1: 20, c1: 15 },
      cells: [{ r: 10, c: 7, kind: 'number', value: 1 }],
      excludedIntervals: { rows: [], columns: [{ start: 6, end: 8 }] }
    });
    expect(() => snapshotWriterChunk(ctx, badCol, opts())).toThrow(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
  });

  it('rejects wrong mode, duplicate coords, or malformed cell', () => {
    const ctxFormatted = makeCtx('include_all', 'formatted');
    const ftChunk = makeChunk({
      cells: [{ r: 10, c: 5, kind: 'string', value: '=A1', formulaText: '=A1' }]
    });
    expect(() => snapshotWriterChunk(ctxFormatted, ftChunk, opts()))
      .toThrow(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    const ctxRaw = makeCtx('include_all', 'raw');
    const dupChunk = makeChunk({
      cells: [
        { r: 10, c: 5, kind: 'number', value: 1 },
        { r: 10, c: 5, kind: 'number', value: 2 }
      ]
    });
    expect(() => snapshotWriterChunk(ctxRaw, dupChunk, opts()))
      .toThrow(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    const malformed = makeChunk({
      cells: [{ r: 10, c: 5, kind: 'unknown', value: 1 }] as unknown as NormalizedChunk['cells']
    });
    expect(() => snapshotWriterChunk(ctxRaw, malformed, opts()))
      .toThrow(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
  });

  it('enforces cap-before-cell/interval getters, preabort, and byte budget', () => {
    const ctx = makeCtx();
    const ac = new AbortController();
    ac.abort();
    expect(() => snapshotWriterChunk(ctx, makeChunk(), opts(ac.signal)))
      .toThrow(expect.objectContaining({ code: 'OPERATION_ABORTED' }));

    expect(() => snapshotWriterChunk(ctx, makeChunk({ byteCount: 500 }), opts(undefined, { maxDecodedBytes: 400 })))
      .toThrow(expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' }));

    // Over-cells limit before cell getters
    let cellGetterCalled = false;
    const poisonCell = {
      get r() { cellGetterCalled = true; throw new Error('getter should not run'); },
      c: 5, kind: 'number' as const, value: 1
    };
    const overCellsChunk = makeChunk({ cells: [poisonCell, poisonCell] as unknown as [] });
    expect(() => snapshotWriterChunk(ctx, overCellsChunk, opts(undefined, { maxCells: 1 })))
      .toThrow(expect.objectContaining({ code: 'CELL_LIMIT_EXCEEDED' }));
    expect(cellGetterCalled).toBe(false);

    // Over-intervals limit before interval getters
    let ivGetterCalled = false;
    const poisonIv = {
      get start() { ivGetterCalled = true; throw new Error('getter should not run'); },
      end: 15
    };
    const overIvChunk = makeChunk({
      excludedIntervals: { rows: [poisonIv, poisonIv] as unknown as [], columns: [] }
    });
    expect(() => snapshotWriterChunk(ctx, overIvChunk, opts(undefined, { maxIntervals: 1 })))
      .toThrow(expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' }));
    expect(ivGetterCalled).toBe(false);
  });

  it('safely handles hostile changing optional Cell metadata', () => {
    const ctx = makeCtx();
    let calls = 0;
    const hostileCell = {
      r: 10, c: 5, kind: 'string' as const, value: 'txt',
      get numberFormatType() {
        calls++;
        return (calls === 1 ? 'TEXT' : { malicious: 'object' }) as unknown as string;
      }
    };
    const hostileChunk = makeChunk({ cells: [hostileCell] });
    expect(() => snapshotWriterChunk(ctx, hostileChunk, opts()))
      .toThrow(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Valid stable getter copied safely
    const stableCell = {
      r: 10, c: 5, kind: 'string' as const, value: 'txt',
      get numberFormatType() { return 'TEXT'; }
    };
    const snap = snapshotWriterChunk(ctx, makeChunk({ cells: [stableCell] }), opts());
    expect(snap.cells[0].numberFormatType).toBe('TEXT');
  });
});
