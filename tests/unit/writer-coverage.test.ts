import { describe, it, expect } from 'vitest';
import type { NormalizedChunk, Rect } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import { assertWriterCoverage, PROVISIONAL_MAX_CHUNKS } from '../../src/export/coverage.ts';

function makeContext(overrides?: Partial<WriterContext>): WriterContext {
  return {
    sourceId: 'src-test',
    title: 'Test Spreadsheet',
    locale: 'en',
    timeZone: 'UTC',
    scopes: [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 } }],
    mode: 'raw',
    format: 'json',
    visibility: 'include_all',
    limitsVersion: '1.0',
    sheetOrder: [0],
    sheets: [{ id: 0, title: 'Sheet1', index: 0, type: 'GRID', hidden: false, rows: 100, columns: 100 }],
    ...overrides
  } as WriterContext;
}

function makeChunk(rect: Rect, id = 'c1', jobId = 'job-1', cells: any[] = []): NormalizedChunk {
  return {
    jobId,
    chunkId: id,
    rect,
    cells,
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 128
  };
}

describe('T24b1a assertWriterCoverage', () => {
  const signal = new AbortController().signal;
  const opts = { maxChunks: PROVISIONAL_MAX_CHUNKS, signal };

  it('validates single chunk, shuffled split partitions, nonzero origins, and blank tabs', () => {
    const ctx = makeContext();
    const single = [makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 })];
    expect(() => assertWriterCoverage(ctx, single, opts)).not.toThrow();

    // 2x2 split shuffled
    const c1 = makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 5, c1: 5 }, 'c1');
    const c2 = makeChunk({ sheetId: 0, r0: 0, c0: 5, r1: 5, c1: 10 }, 'c2');
    const c3 = makeChunk({ sheetId: 0, r0: 5, c0: 0, r1: 10, c1: 5 }, 'c3');
    const c4 = makeChunk({ sheetId: 0, r0: 5, c0: 5, r1: 10, c1: 10 }, 'c4');
    expect(() => assertWriterCoverage(ctx, [c4, c1, c3, c2], opts)).not.toThrow();

    // Nonzero origin range [5, 10) x [5, 10) with empty cells on blank tab
    const ctxNonzero = makeContext({
      scopes: [{ sheetId: 0, rect: { sheetId: 0, r0: 5, c0: 5, r1: 15, c1: 15 } }]
    });
    const nz1 = makeChunk({ sheetId: 0, r0: 5, c0: 5, r1: 10, c1: 15 }, 'nz1', 'job-1', []);
    const nz2 = makeChunk({ sheetId: 0, r0: 10, c0: 5, r1: 15, c1: 15 }, 'nz2', 'job-1', []);
    expect(() => assertWriterCoverage(ctxNonzero, [nz1, nz2], opts)).not.toThrow();
  });

  it('rejects geometry violations: holes, overlaps, and equal-area overlap+gap trap', () => {
    const ctx = makeContext();
    // Hole: only covers [0, 5) x [0, 10), area 50/100
    const hole = [makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 5, c1: 10 }, 'c1')];
    expect(() => assertWriterCoverage(ctx, hole, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Direct overlap: total area 120/100
    const over1 = makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 6, c1: 10 }, 'c1');
    const over2 = makeChunk({ sheetId: 0, r0: 4, c0: 0, r1: 10, c1: 10 }, 'c2');
    expect(() => assertWriterCoverage(ctx, [over1, over2], opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Equal-area overlap+gap trap: chunk1 area 60 [0,6)x[0,10), chunk2 area 40 [4,8)x[0,10).
    // Sum = 100 == scopeArea, but overlap on [4,6)x[0,10) and gap on [8,10)x[0,10)
    const trap1 = makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 6, c1: 10 }, 'c1');
    const trap2 = makeChunk({ sheetId: 0, r0: 4, c0: 0, r1: 8, c1: 10 }, 'c2');
    expect(() => assertWriterCoverage(ctx, [trap1, trap2], opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('rejects foreign sheet, duplicate chunk IDs, and zero/out-of-bounds extents', () => {
    const ctx = makeContext();
    const foreign = [makeChunk({ sheetId: 99, r0: 0, c0: 0, r1: 10, c1: 10 }, 'c1')];
    expect(() => assertWriterCoverage(ctx, foreign, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    const dup1 = makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 5, c1: 10 }, 'same-id');
    const dup2 = makeChunk({ sheetId: 0, r0: 5, c0: 0, r1: 10, c1: 10 }, 'same-id');
    expect(() => assertWriterCoverage(ctx, [dup1, dup2], opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    const zeroExtent = [makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 0, c1: 10 }, 'c1')];
    expect(() => assertWriterCoverage(ctx, zeroExtent, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('rejects context structural violations, hidden conflicts, and duplicate/unordered IDs', () => {
    const validChunk = [makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 })];

    // Extra forbidden keys (e.g. principalKey)
    const extraKeyCtx = { ...makeContext(), principalKey: 'user-secret' } as any;
    expect(() => assertWriterCoverage(extraKeyCtx, validChunk, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Hidden conflict with api_visible
    const hiddenCtx = makeContext({
      visibility: 'api_visible',
      sheets: [{ id: 0, title: 'Sheet1', index: 0, type: 'GRID', hidden: true, rows: 100, columns: 100 }]
    });
    expect(() => assertWriterCoverage(hiddenCtx, validChunk, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Unequal array lengths
    const unequalCtx = makeContext({ sheetOrder: [0, 1] });
    expect(() => assertWriterCoverage(unequalCtx, validChunk, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Unordered sheet indices
    const unorderedCtx = makeContext({
      sheetOrder: [0, 1],
      scopes: [
        { sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 } },
        { sheetId: 1, rect: { sheetId: 1, r0: 0, c0: 0, r1: 10, c1: 10 } }
      ],
      sheets: [
        { id: 0, title: 'S1', index: 5, type: 'GRID', hidden: false, rows: 100, columns: 100 },
        { id: 1, title: 'S2', index: 2, type: 'GRID', hidden: false, rows: 100, columns: 100 }
      ]
    });
    const twoChunks = [
      makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }, 'c0'),
      makeChunk({ sheetId: 1, r0: 0, c0: 0, r1: 10, c1: 10 }, 'c1')
    ];
    expect(() => assertWriterCoverage(unorderedCtx, twoChunks, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // -0 coordinate rejection
    const negZeroChunk = [makeChunk({ sheetId: 0, r0: -0, c0: 0, r1: 10, c1: 10 })];
    expect(() => assertWriterCoverage(makeContext(), negZeroChunk, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Non-enumerable expected context key plus enumerable accessToken regression
    const badCtx = makeContext();
    Object.defineProperty(badCtx, 'title', {
      value: 'Test Spreadsheet',
      enumerable: false,
      configurable: true,
      writable: true
    });
    (badCtx as any).accessToken = 'secret-token-123';
    expect(() => assertWriterCoverage(badCtx, validChunk, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Non-enumerable expected metadata key plus enumerable accessToken regression
    const badMeta = { ...makeContext().sheets[0] };
    Object.defineProperty(badMeta, 'title', {
      value: 'Sheet1',
      enumerable: false,
      configurable: true,
      writable: true
    });
    (badMeta as any).accessToken = 'secret-token-456';
    const badSheetCtx = makeContext({
      sheets: [badMeta as any]
    });
    expect(() => assertWriterCoverage(badSheetCtx, validChunk, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('validates huge endpoint area with BigInt arithmetic without dense allocation', () => {
    const hugeRows = 2_000_000;
    const hugeCols = 2_000_000;
    const hugeCtx = makeContext({
      scopes: [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 1_000_000, c1: 1_000_000 } }],
      sheets: [{ id: 0, title: 'Huge', index: 0, type: 'GRID', hidden: false, rows: hugeRows, columns: hugeCols }]
    });
    const c1 = makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 500_000, c1: 1_000_000 }, 'h1');
    const c2 = makeChunk({ sheetId: 0, r0: 500_000, c0: 0, r1: 1_000_000, c1: 1_000_000 }, 'h2');
    expect(() => assertWriterCoverage(hugeCtx, [c1, c2], opts)).not.toThrow();
  });

  it('preserves input immutability without mutation', () => {
    const ctx = Object.freeze({
      sourceId: 'src-1',
      title: 'T',
      locale: 'en',
      timeZone: 'UTC',
      scopes: Object.freeze([{ sheetId: 0, rect: Object.freeze({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }) }]),
      mode: 'raw' as const,
      format: 'json' as const,
      visibility: 'include_all' as const,
      limitsVersion: '1.0',
      sheetOrder: Object.freeze([0]),
      sheets: Object.freeze([{ id: 0, title: 'S', index: 0, type: 'GRID' as const, hidden: false, rows: 50, columns: 50 }])
    });
    const chunk = Object.freeze({
      jobId: 'j1',
      chunkId: 'c1',
      rect: Object.freeze({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 }),
      cells: Object.freeze([]),
      excludedIntervals: Object.freeze({ rows: Object.freeze([]), columns: Object.freeze([]) }),
      byteCount: 0
    });
    const frozenChunks = Object.freeze([chunk]);
    const frozenOpts = Object.freeze({ maxChunks: 10, signal });
    expect(() => assertWriterCoverage(ctx as any, frozenChunks as any, frozenOpts)).not.toThrow();
  });

  it('enforces cap-before-work, pre-abort, and rejects invalid options with CONFIG_INVALID', () => {
    // Bad options
    expect(() => assertWriterCoverage(makeContext(), [], null as any)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() => assertWriterCoverage(makeContext(), [], { maxChunks: -1, signal } as any)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() => assertWriterCoverage(makeContext(), [], { maxChunks: 5000, signal })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );

    // Bad signal shapes (missing addEventListener / removeEventListener)
    expect(() => assertWriterCoverage(makeContext(), [], { maxChunks: 10, signal: { aborted: false } as any })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() =>
      assertWriterCoverage(makeContext(), [], {
        maxChunks: 10,
        signal: { aborted: false, addEventListener: () => {} } as any
      })
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));

    // Pre-abort
    const ac = new AbortController();
    ac.abort();
    expect(() => assertWriterCoverage(makeContext(), [], { maxChunks: 10, signal: ac.signal })).toThrowError(
      expect.objectContaining({ code: 'OPERATION_ABORTED' })
    );

    // Options maxChunks and signal captured ONCE inside config try without second destructuring
    let maxChunksAccessCount = 0;
    let signalAccessCount = 0;
    const onceOpts = {
      get maxChunks() {
        maxChunksAccessCount++;
        if (maxChunksAccessCount > 1) throw new Error('RAW_MAXCHUNKS_LEAK');
        return PROVISIONAL_MAX_CHUNKS;
      },
      get signal() {
        signalAccessCount++;
        if (signalAccessCount > 1) throw new Error('RAW_SIGNAL_LEAK');
        return signal;
      }
    };
    const validChunk = [makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 })];
    expect(() => assertWriterCoverage(makeContext(), validChunk, onceOpts as any)).not.toThrow();
    expect(maxChunksAccessCount).toBe(1);
    expect(signalAccessCount).toBe(1);

    // Cap-before-work: chunks.length > maxChunks fails with SIZE_LIMIT_EXCEEDED before detailed checks
    const badChunk = { invalid: true } as any;
    expect(() =>
      assertWriterCoverage(makeContext(), [badChunk, badChunk, badChunk], { maxChunks: 2, signal })
    ).toThrowError(expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' }));
  });

  it('safely handles hostile getters without leaking raw text', () => {
    const hostileContext = {
      ...makeContext(),
      get title(): string {
        throw new Error('SENSITIVE_OAUTH_TOKEN_LEAK');
      }
    };
    const chunk = [makeChunk({ sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 })];
    try {
      assertWriterCoverage(hostileContext as any, chunk, opts);
      expect.fail('Expected exception');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('FORMAT_SERIALIZATION_FAILED');
      expect(err.message).not.toContain('SENSITIVE_OAUTH_TOKEN_LEAK');
    }

    const hostileOpts = {
      signal,
      get maxChunks(): number {
        throw new Error('HOSTILE_CONFIG_GETTER');
      }
    };
    try {
      assertWriterCoverage(makeContext(), chunk, hostileOpts as any);
      expect.fail('Expected exception');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('CONFIG_INVALID');
      expect(err.message).not.toContain('HOSTILE_CONFIG_GETTER');
    }

    // Regression: hostile getter throws DomainError with mutated secret message, cause, and extra properties
    const hostileDomainErr = new DomainError('FORMAT_SERIALIZATION_FAILED');
    (hostileDomainErr as any).message = 'MUTATED_SECRET_MESSAGE_LEAK';
    (hostileDomainErr as any).secretToken = 'super-secret-token';
    (hostileDomainErr as any).cause = new Error('nested sensitive cause');

    const hostileDomainCtx = {
      ...makeContext(),
      get title(): string {
        throw hostileDomainErr;
      }
    };
    try {
      assertWriterCoverage(hostileDomainCtx as any, chunk, opts);
      expect.fail('Expected exception');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('FORMAT_SERIALIZATION_FAILED');
      expect(err.message).not.toContain('MUTATED_SECRET_MESSAGE_LEAK');
      expect(err.message).toBe(SAFE_ERROR_MESSAGES['FORMAT_SERIALIZATION_FAILED']);
      expect((err as any).secretToken).toBeUndefined();
      expect((err as any).cause).toBeUndefined();
      expect(Object.keys(err)).not.toContain('secretToken');
    }

    // Hostile config getter throws DomainError with mutated secret message and extra properties
    const hostileConfigErr = new DomainError('CONFIG_INVALID');
    (hostileConfigErr as any).message = 'MUTATED_SECRET_CONFIG_LEAK';
    (hostileConfigErr as any).extraSecret = 'sensitive-cfg';

    const hostileConfigDomainOpts = {
      signal,
      get maxChunks(): number {
        throw hostileConfigErr;
      }
    };
    try {
      assertWriterCoverage(makeContext(), chunk, hostileConfigDomainOpts as any);
      expect.fail('Expected exception');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('CONFIG_INVALID');
      expect(err.message).not.toContain('MUTATED_SECRET_CONFIG_LEAK');
      expect(err.message).toBe(SAFE_ERROR_MESSAGES['CONFIG_INVALID']);
      expect((err as any).extraSecret).toBeUndefined();
      expect(Object.keys(err)).not.toContain('extraSecret');
    }
  });

  it('polls signal within pairwise comparison inner loop on 128 boundary without claiming preemptive cancellation', () => {
    // 150 chunks along 1 column => 150 * 149 / 2 = 11,175 pairwise comparisons
    const rows = 150;
    const ctx = makeContext({
      scopes: [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: rows, c1: 1 } }],
      sheets: [{ id: 0, title: 'Sheet1', index: 0, type: 'GRID', hidden: false, rows, columns: 1 }]
    });

    const ac = new AbortController();
    const chunks: NormalizedChunk[] = [];
    for (let i = 0; i < rows; i++) {
      const chunk = makeChunk({ sheetId: 0, r0: i, c0: 0, r1: i + 1, c1: 1 }, `c${i}`);
      // On chunk 20, abort signal on its second rect access (which occurs during pairwise comparisons with i=0)
      if (i === 20) {
        let accessCount = 0;
        const origRect = chunk.rect;
        Object.defineProperty(chunk, 'rect', {
          get() {
            accessCount++;
            if (accessCount === 2) {
              ac.abort();
            }
            return origRect;
          }
        });
      }
      chunks.push(chunk);
    }

    // Must be aborted on the 128-comparison boundary inside the inner loop
    expect(() =>
      assertWriterCoverage(ctx, chunks, { maxChunks: PROVISIONAL_MAX_CHUNKS, signal: ac.signal })
    ).toThrowError(expect.objectContaining({ code: 'OPERATION_ABORTED' }));
  });

  it('explicitly proves geometry coverage helper alone does not validate cells or exclusions', () => {
    const ctx = makeContext();
    // Non-cell objects in cells array and arbitrary object in excludedIntervals
    const arbitraryChunk: NormalizedChunk = {
      jobId: 'job-1',
      chunkId: 'c1',
      rect: { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 },
      cells: [{ notAValidCell: true, kind: 'unknown' }] as any,
      excludedIntervals: { customProperty: 123 } as any,
      byteCount: 50
    };
    // Must pass geometry coverage check because deep cell/exclusion checks are deferred
    expect(() => assertWriterCoverage(ctx, [arbitraryChunk], opts)).not.toThrow();
  });
});
