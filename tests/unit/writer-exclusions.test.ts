import { describe, it, expect } from 'vitest';
import type { DimensionInterval, NormalizedChunk, Rect } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import { collectWriterExclusions, PROVISIONAL_MAX_INTERVALS } from '../../src/export/exclusions.ts';

function makeContext(overrides?: Partial<WriterContext>): WriterContext {
  return {
    sourceId: 'src-test',
    title: 'Test Spreadsheet',
    locale: 'en',
    timeZone: 'UTC',
    scopes: [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 } }],
    mode: 'raw',
    format: 'json',
    visibility: 'api_visible',
    limitsVersion: '1.0',
    sheetOrder: [0],
    sheets: [{ id: 0, title: 'Sheet1', index: 0, type: 'GRID', hidden: false, rows: 100, columns: 100 }],
    ...overrides
  } as WriterContext;
}

function makeChunk(
  rect: Rect,
  excludedIntervals: { rows?: DimensionInterval[]; columns?: DimensionInterval[] } = {},
  id = 'c1',
  jobId = 'job-1'
): NormalizedChunk {
  return {
    jobId,
    chunkId: id,
    rect,
    cells: [],
    excludedIntervals: {
      rows: excludedIntervals.rows ?? [],
      columns: excludedIntervals.columns ?? []
    },
    byteCount: 64
  };
}

describe('T24b1b collectWriterExclusions', () => {
  const signal = new AbortController().signal;
  const defaultOpts = { maxIntervals: PROVISIONAL_MAX_INTERVALS, signal };

  it('merges shuffled, overlapping, and adjacent intervals with nonzero origin', () => {
    const ctx = makeContext({
      scopes: [{ sheetId: 0, rect: { sheetId: 0, r0: 100, c0: 200, r1: 200, c1: 300 } }]
    });

    const shuffledRows: DimensionInterval[] = [
      { start: 125, end: 130 }, // adjacent to 115..125
      { start: 110, end: 120 }, // overlapping 115..125
      { start: 115, end: 125 },
      { start: 130, end: 140 }, // adjacent to 125..130
      { start: 165, end: 175 }, // overlapping 160..170
      { start: 160, end: 170 }
    ];

    const shuffledCols: DimensionInterval[] = [
      { start: 250, end: 260 },
      { start: 220, end: 230 }, // adjacent to 210..220
      { start: 210, end: 220 }
    ];

    const chunk = makeChunk(
      { sheetId: 0, r0: 100, c0: 200, r1: 200, c1: 300 },
      { rows: shuffledRows, columns: shuffledCols }
    );

    const res = collectWriterExclusions(ctx, [chunk], defaultOpts);
    expect(res).toHaveLength(1);
    expect(res[0].sheetId).toBe(0);

    // Independent expected compact intervals
    expect(res[0].excludedRows).toEqual([
      { start: 110, end: 140 },
      { start: 160, end: 175 }
    ]);
    expect(res[0].excludedColumns).toEqual([
      { start: 210, end: 230 },
      { start: 250, end: 260 }
    ]);
  });

  it('validates agreeing horizontal row flags and vertical column flags across multiple chunks and sheets', () => {
    const ctx = makeContext({
      sheetOrder: [0, 1],
      scopes: [
        { sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 100, c1: 100 } },
        { sheetId: 1, rect: { sheetId: 1, r0: 0, c0: 0, r1: 50, c1: 50 } }
      ]
    });

    // 2x2 partition on sheet 0 agreeing on row and col flags
    const c0TopLeft = makeChunk(
      { sheetId: 0, r0: 0, c0: 0, r1: 50, c1: 50 },
      { rows: [{ start: 10, end: 20 }], columns: [{ start: 5, end: 15 }] },
      'c0-tl'
    );
    const c0TopRight = makeChunk(
      { sheetId: 0, r0: 0, c0: 50, r1: 50, c1: 100 },
      { rows: [{ start: 10, end: 20 }], columns: [{ start: 70, end: 80 }] },
      'c0-tr'
    );
    const c0BotLeft = makeChunk(
      { sheetId: 0, r0: 50, c0: 0, r1: 100, c1: 50 },
      { rows: [{ start: 60, end: 70 }], columns: [{ start: 5, end: 15 }] },
      'c0-bl'
    );
    const c0BotRight = makeChunk(
      { sheetId: 0, r0: 50, c0: 50, r1: 100, c1: 100 },
      { rows: [{ start: 60, end: 70 }], columns: [{ start: 70, end: 80 }] },
      'c0-br'
    );

    // Single chunk on sheet 1
    const c1Single = makeChunk(
      { sheetId: 1, r0: 0, c0: 0, r1: 50, c1: 50 },
      { rows: [{ start: 5, end: 10 }], columns: [{ start: 20, end: 25 }] },
      'c1-s'
    );

    const res = collectWriterExclusions(ctx, [c0BotRight, c0TopLeft, c1Single, c0BotLeft, c0TopRight], defaultOpts);
    expect(res).toHaveLength(2);
    expect(res[0].sheetId).toBe(0);
    expect(res[0].excludedRows).toEqual([
      { start: 10, end: 20 },
      { start: 60, end: 70 }
    ]);
    expect(res[0].excludedColumns).toEqual([
      { start: 5, end: 15 },
      { start: 70, end: 80 }
    ]);

    expect(res[1].sheetId).toBe(1);
    expect(res[1].excludedRows).toEqual([{ start: 5, end: 10 }]);
    expect(res[1].excludedColumns).toEqual([{ start: 20, end: 25 }]);
  });

  it('rejects conflicting hidden vs visible spans across disjoint cell rectangles and partial dimension overlap', () => {
    const ctx = makeContext();

    // Grouped table cases of visibility conflicts
    const conflictCases = [
      {
        name: 'row hidden in left chunk but visible in right chunk (disjoint cell rects)',
        chunks: [
          makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 5 }, { rows: [{ start: 2, end: 6 }] }, 'ca1'),
          makeChunk({ sheetId: 0, r0: 0, c0: 5, r1: 10, c1: 10 }, { rows: [] }, 'ca2')
        ]
      },
      {
        name: 'column hidden in top chunk but visible in bottom chunk (disjoint cell rects)',
        chunks: [
          makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 5, c1: 10 }, { columns: [{ start: 3, end: 7 }] }, 'cb1'),
          makeChunk({ sheetId: 0, r0: 5, c0: 0, r1: 10, c1: 10 }, { columns: [] }, 'cb2')
        ]
      },
      {
        name: 'partial row overlap: left chunk [2, 6) hidden vs right chunk [4, 8) hidden',
        chunks: [
          makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 5 }, { rows: [{ start: 2, end: 6 }] }, 'cc1'),
          makeChunk({ sheetId: 0, r0: 0, c0: 5, r1: 10, c1: 10 }, { rows: [{ start: 4, end: 8 }] }, 'cc2')
        ]
      },
      {
        name: 'partial column overlap: top chunk [1, 5) hidden vs bottom chunk [3, 8) hidden',
        chunks: [
          makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 5, c1: 10 }, { columns: [{ start: 1, end: 5 }] }, 'cd1'),
          makeChunk({ sheetId: 0, r0: 5, c0: 0, r1: 10, c1: 10 }, { columns: [{ start: 3, end: 8 }] }, 'cd2')
        ]
      }
    ];

    for (const { chunks } of conflictCases) {
      expect(() => collectWriterExclusions(ctx, chunks, defaultOpts)).toThrowError(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
    }
  });

  it('rejects exclusions and foreign empty chunks in include_all mode', () => {
    const ctxAll = makeContext({ visibility: 'include_all', sheetOrder: [0] });

    // Exclusions present in include_all mode must be rejected
    const rowExclusionChunk = makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [{ start: 0, end: 1 }] });
    expect(() => collectWriterExclusions(ctxAll, [rowExclusionChunk], defaultOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    const colExclusionChunk = makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { columns: [{ start: 0, end: 1 }] });
    expect(() => collectWriterExclusions(ctxAll, [colExclusionChunk], defaultOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Foreign empty chunk (sheetId 999 not in sheetOrder) must be rejected even with zero exclusions
    const foreignEmptyChunk = makeChunk({ sheetId: 999, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [], columns: [] });
    expect(() => collectWriterExclusions(ctxAll, [foreignEmptyChunk], defaultOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Valid empty exclusions in include_all succeed
    const validChunk = makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [], columns: [] });
    const res = collectWriterExclusions(ctxAll, [validChunk], defaultOpts);
    expect(res).toEqual([
      { sheetId: 0, excludedRows: [], excludedColumns: [] }
    ]);
  });

  it('handles hidden-all with huge endpoint compactly without dense memory allocation', () => {
    const hugeRows = 10_000_000;
    const hugeCols = 18_278;
    const ctx = makeContext();
    const chunk = makeChunk(
      { sheetId: 0, r0: 0, c0: 0, r1: hugeRows, c1: hugeCols },
      {
        rows: [{ start: 0, end: hugeRows }],
        columns: [{ start: 0, end: hugeCols }]
      }
    );

    const res = collectWriterExclusions(ctx, [chunk], defaultOpts);
    expect(res).toHaveLength(1);
    expect(res[0].excludedRows).toEqual([{ start: 0, end: hugeRows }]);
    expect(res[0].excludedColumns).toEqual([{ start: 0, end: hugeCols }]);
  });

  it('executes regression with >=140000 disjoint intervals on one large span without call stack explosion', () => {
    const count = 140000;
    const spanEnd = count * 2;
    const ctx = makeContext();

    const disjointRows: DimensionInterval[] = new Array(count);
    for (let i = 0; i < count; i++) {
      disjointRows[i] = { start: i * 2, end: i * 2 + 1 };
    }

    const chunk = makeChunk(
      { sheetId: 0, r0: 0, c0: 0, r1: spanEnd, c1: 1 },
      { rows: disjointRows, columns: [] }
    );

    const res = collectWriterExclusions(ctx, [chunk], defaultOpts);
    expect(res).toHaveLength(1);
    expect(res[0].excludedRows).toHaveLength(count);
    expect(res[0].excludedRows[0]).toEqual({ start: 0, end: 1 });
    expect(res[0].excludedRows[count - 1]).toEqual({ start: (count - 1) * 2, end: (count - 1) * 2 + 1 });
    expect(res[0].excludedColumns).toHaveLength(0);
  });

  it('rejects invalid bounds, wrong keys, and negative zero (-0)', () => {
    const ctx = makeContext();

    const invalidCases: Array<{ name: string; chunk: any; ctx?: WriterContext }> = [
      // Rect geometry violations
      { name: 'rect r0 >= r1', chunk: makeChunk({ sheetId: 0, r0: 5, c0: 0, r1: 5, c1: 10 }) },
      { name: 'rect r0 > r1', chunk: makeChunk({ sheetId: 0, r0: 8, c0: 0, r1: 5, c1: 10 }) },
      { name: 'rect c0 >= c1', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 5, r1: 10, c1: 5 }) },
      { name: 'rect c0 > c1', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 8, r1: 10, c1: 5 }) },
      { name: 'rect negative r0', chunk: makeChunk({ sheetId: 0, r0: -1, c0: 0, r1: 10, c1: 10 }) },
      { name: 'rect non-integer r0', chunk: makeChunk({ sheetId: 0, r0: 1.5, c0: 0, r1: 10, c1: 10 }) },
      { name: 'rect r0 is -0', chunk: makeChunk({ sheetId: 0, r0: -0, c0: 0, r1: 10, c1: 10 }) },
      { name: 'rect r1 is -0', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: -0, c1: 10 }) },
      { name: 'rect c0 is -0', chunk: makeChunk({ sheetId: 0, r0: 0, c0: -0, r1: 10, c1: 10 }) },
      { name: 'rect c1 is -0', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: -0 }) },
      { name: 'rect sheetId is -0', chunk: makeChunk({ sheetId: -0 as any, r0: 0, c0: 0, r1: 10, c1: 10 }) },
      { name: 'rect extra property', chunk: { ...makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }), rect: { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10, extra: true } } },
      { name: 'rect missing property', chunk: { ...makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }), rect: { sheetId: 0, r0: 0, c0: 0, r1: 10 } } },

      // Interval violations
      { name: 'interval start >= end', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [{ start: 5, end: 5 }] }) },
      { name: 'interval start > end', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [{ start: 6, end: 4 }] }) },
      { name: 'interval start < r0', chunk: makeChunk({ sheetId: 0, r0: 5, c0: 0, r1: 10, c1: 10 }, { rows: [{ start: 4, end: 7 }] }) },
      { name: 'interval end > r1', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [{ start: 5, end: 11 }] }) },
      { name: 'interval start is -0', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [{ start: -0, end: 5 }] }) },
      { name: 'interval end is -0', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [{ start: 0, end: -0 }] }) },
      { name: 'interval non-integer', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [{ start: 0.5, end: 5 }] }) },
      { name: 'interval extra property', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [{ start: 0, end: 5, extra: 'bad' } as any] }) },
      { name: 'interval missing property', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [{ start: 0 } as any] }) },

      // ExcludedIntervals violations
      { name: 'excludedIntervals extra key', chunk: { ...makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }), excludedIntervals: { rows: [], columns: [], extra: [] } } },
      { name: 'excludedIntervals missing key', chunk: { ...makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }), excludedIntervals: { rows: [] } } },
      { name: 'excludedIntervals rows not array', chunk: { ...makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }), excludedIntervals: { rows: null, columns: [] } } },

      // Context sheetOrder violations
      { name: 'duplicate sheetId in sheetOrder', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }), ctx: makeContext({ sheetOrder: [0, 0] }) },
      { name: 'sheetId -0 in sheetOrder', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }), ctx: makeContext({ sheetOrder: [-0 as any] }) },
      { name: 'invalid visibility mode', chunk: makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }), ctx: makeContext({ visibility: 'unknown' as any }) }
    ];

    for (const { name, chunk, ctx: testCtx } of invalidCases) {
      try {
        collectWriterExclusions(testCtx ?? ctx, [chunk], defaultOpts);
        expect.unreachable(`Expected failure for case: ${name}`);
      } catch (err: any) {
        expect(err.code, `Failed case: ${name}`).toBe('FORMAT_SERIALIZATION_FAILED');
      }
    }
  });

  it('enforces cap-before-interval-getter without invoking interval property getters', () => {
    let getterInvoked = false;
    const hostileInterval = {
      get start(): number {
        getterInvoked = true;
        throw new Error('HOSTILE_INTERVAL_GETTER_DETONATION');
      },
      get end(): number {
        getterInvoked = true;
        throw new Error('HOSTILE_INTERVAL_GETTER_DETONATION');
      }
    };

    const chunk = makeChunk(
      { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 },
      { rows: [{ start: 0, end: 1 }, { start: 1, end: 2 }, hostileInterval as any] }
    );

    // Limit is 2 intervals, but chunk has 3 intervals
    expect(() =>
      collectWriterExclusions(makeContext(), [chunk], { maxIntervals: 2, signal })
    ).toThrowError(expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' }));

    expect(getterInvoked).toBe(false);
  });

  it('rejects pre-aborted signal with OPERATION_ABORTED', () => {
    const ac = new AbortController();
    ac.abort();

    const chunk = makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 });
    expect(() =>
      collectWriterExclusions(makeContext(), [chunk], { maxIntervals: PROVISIONAL_MAX_INTERVALS, signal: ac.signal })
    ).toThrowError(expect.objectContaining({ code: 'OPERATION_ABORTED' }));
  });

  it('safely handles hostile getters without leaking diagnostic text', () => {
    const chunk = makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [{ start: 1, end: 2 }] });

    // Hostile options getter throwing standard Error
    const hostileOpts = {
      signal,
      get maxIntervals(): number {
        throw new Error('HOSTILE_OPTIONS_TOKEN_LEAK');
      }
    };
    try {
      collectWriterExclusions(makeContext(), [chunk], hostileOpts as any);
      expect.fail('Expected exception');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('CONFIG_INVALID');
      expect(err.message).toBe(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
      expect(err.message).not.toContain('HOSTILE_OPTIONS_TOKEN_LEAK');
    }

    // Hostile options getter throwing mutated DomainError with cause and sensitive token
    const hostileDomainErr = new DomainError('CONFIG_INVALID');
    (hostileDomainErr as any).message = 'MUTATED_SECRET_MESSAGE_LEAK';
    (hostileDomainErr as any).secretToken = 'super-secret-token';
    (hostileDomainErr as any).cause = new Error('nested sensitive cause');

    const hostileDomainOpts = {
      signal,
      get maxIntervals(): number {
        throw hostileDomainErr;
      }
    };
    try {
      collectWriterExclusions(makeContext(), [chunk], hostileDomainOpts as any);
      expect.fail('Expected exception');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('CONFIG_INVALID');
      expect(err.message).toBe(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
      expect(err.message).not.toContain('MUTATED_SECRET_MESSAGE_LEAK');
      expect((err as any).secretToken).toBeUndefined();
      expect((err as any).cause).toBeUndefined();
    }

    // Hostile chunk rect getter
    const hostileRectChunk = {
      ...chunk,
      get rect(): Rect {
        throw new Error('HOSTILE_RECT_LEAK');
      }
    };
    try {
      collectWriterExclusions(makeContext(), [hostileRectChunk as any], defaultOpts);
      expect.fail('Expected exception');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('FORMAT_SERIALIZATION_FAILED');
      expect(err.message).toBe(SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED);
      expect(err.message).not.toContain('HOSTILE_RECT_LEAK');
    }
  });

  it('guarantees deep result freezing and input isolation', () => {
    const rawInterval = { start: 2, end: 5 };
    const chunk = makeChunk(
      { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 },
      { rows: [rawInterval], columns: [{ start: 1, end: 4 }] }
    );

    const res = collectWriterExclusions(makeContext(), [chunk], defaultOpts);

    // Deep freezing
    expect(Object.isFrozen(res)).toBe(true);
    expect(Object.isFrozen(res[0])).toBe(true);
    expect(Object.isFrozen(res[0].excludedRows)).toBe(true);
    expect(Object.isFrozen(res[0].excludedColumns)).toBe(true);
    expect(Object.isFrozen(res[0].excludedRows[0])).toBe(true);
    expect(Object.isFrozen(res[0].excludedColumns[0])).toBe(true);

    // Strict mode mutations must throw
    expect(() => {
      (res[0].excludedRows as any).push({ start: 6, end: 7 });
    }).toThrow(TypeError);
    expect(() => {
      (res[0].excludedRows[0] as any).start = 99;
    }).toThrow(TypeError);

    // Input isolation: modifying raw interval after call does not alter frozen result
    (rawInterval as any).start = 8;
    expect(res[0].excludedRows[0].start).toBe(2);
  });

  it('allows blank data when maxIntervals is 0 and rejects non-blank exclusions', () => {
    const blankChunk = makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, { rows: [], columns: [] });
    const res = collectWriterExclusions(makeContext(), [blankChunk], { maxIntervals: 0, signal });
    expect(res).toEqual([
      { sheetId: 0, excludedRows: [], excludedColumns: [] }
    ]);

    const nonBlankChunk = makeChunk(
      { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 },
      { rows: [{ start: 0, end: 1 }], columns: [] }
    );
    expect(() =>
      collectWriterExclusions(makeContext(), [nonBlankChunk], { maxIntervals: 0, signal })
    ).toThrowError(expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' }));
  });
});
