import { describe, it, expect } from 'vitest';
import type { ExportScope, Rect } from '../../src/contracts/domain.ts';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import { planChunks } from '../../src/domain/chunks.ts';
import {
  PROVISIONAL_MAX_SELECTED_POSITIONS,
  PROVISIONAL_WARN_POSITIONS,
  estimateScopes,
  type EstimateScopeOptions
} from '../../src/jobs/scope-estimate.ts';
import { buildScopePlan } from '../../src/domain/scope.ts';
import { createCanonicalSourceRef, createCanonicalWorkbookMeta, createSyntheticAccountContext } from '../helpers/fixtures.ts';

function createValidOptions(overrides: Partial<EstimateScopeOptions> = {}): EstimateScopeOptions {
  return {
    maxPositions: PROVISIONAL_MAX_SELECTED_POSITIONS,
    maxChunks: 4096,
    chunkPositions: 20_000,
    signal: new AbortController().signal,
    ...overrides
  };
}

function makeScope(sheetId: number, r0: number, c0: number, r1: number, c1: number): ExportScope {
  return {
    sheetId,
    rect: { sheetId, r0, c0, r1, c1 }
  };
}

describe('T23a Bounded Offline Scope Estimator', () => {
  it('captures the bounded array length once and contains throwing element access', () => {
    const scope = makeScope(1, 0, 0, 10, 10);
    let lengthReads = 0;
    const changing = new Proxy([scope], {
      get(target, key, receiver) {
        if (key === 'length') return ++lengthReads === 1 ? 1 : 0;
        return Reflect.get(target, key, receiver);
      }
    });
    expect(estimateScopes(changing, createValidOptions())).toEqual({
      selectedPositions: 100n, initialChunks: 1n, exceedsPositionLimit: false,
      exceedsChunkLimit: false, largeScopeWarning: false, decodedBytes: null, outputBytes: null
    });
    expect(lengthReads).toBe(1);
    let elementReads = 0;
    const hostile = new Proxy([scope], {
      get(target, key, receiver) {
        if (key === '0') { elementReads++; throw new Error('private-array-diagnostic'); }
        return Reflect.get(target, key, receiver);
      }
    });
    expect(() => estimateScopes(hostile, createValidOptions())).toThrowError(expect.objectContaining({
      code: 'RANGE_INVALID', message: SAFE_ERROR_MESSAGES.RANGE_INVALID
    }));
    expect(elementReads).toBe(1);
  });
  // Group 1: Multi-tab aggregation, source ordering, non-zero origin, cell-blind geometry
  it('1. aggregates multiple tabs in source order, handles non-zero origin, and operates purely on geometry', () => {
    const canonicalReq = buildScopePlan(createCanonicalSourceRef(), createCanonicalWorkbookMeta(), createSyntheticAccountContext(), {
      mode: 'raw', format: 'json', visibility: 'include_all', limitsVersion: '1.0'
    });
    const opts = createValidOptions({ maxPositions: 10_000_000, chunkPositions: 20_000 });

    const estimate = estimateScopes(canonicalReq.scopes, opts);

    // Canonical scopes:
    // Tab 101: [0, 0, 90000, 26) = 2,340,000 positions, 118 chunks (colsStep=26, rowsStep=769 => ceil(90000/769)=118)
    // Tab 205: [0, 0, 1000, 26) = 26,000 positions, 2 chunks (colsStep=26, rowsStep=769 => ceil(1000/769)=2)
    // Total = 2,366,000 positions, 120 chunks
    expect(estimate.selectedPositions).toBe(2_366_000n);
    expect(estimate.initialChunks).toBe(120n);
    expect(estimate.exceedsPositionLimit).toBe(false);
    expect(estimate.exceedsChunkLimit).toBe(false);
    expect(estimate.largeScopeWarning).toBe(true); // >= 1_000_000
    expect(estimate.decodedBytes).toBeNull();
    expect(estimate.outputBytes).toBeNull();

    // Non-zero coordinate offsets: offset does not alter position count or tiling
    const offsetScope = makeScope(1, 100, 200, 300, 400); // 200x200 = 40,000 positions
    const offsetEstimate = estimateScopes([offsetScope], opts);
    expect(offsetEstimate.selectedPositions).toBe(40_000n);
    // budget=20000, width=200, colsStep=min(200, 20000)=200, rowsStep=floor(20000/200)=100.
    // colChunks=1, rowChunks=ceil(200/100)=2 => 2 chunks
    expect(offsetEstimate.initialChunks).toBe(2n);
  });

  // Group 2: Exact cap, cap+1, and large-scope warning threshold
  it('2. evaluates exact limit boundaries (> cap only) and warning threshold (>= 1M)', () => {
    const scope100 = makeScope(1, 0, 0, 10, 10); // 100 positions, budget 10 => 10 chunks

    // Position limit exact cap vs cap+1
    const exactPosOpts = createValidOptions({ maxPositions: 100, chunkPositions: 10 });
    const estExactPos = estimateScopes([scope100], exactPosOpts);
    expect(estExactPos.selectedPositions).toBe(100n);
    expect(estExactPos.exceedsPositionLimit).toBe(false);

    const overPosOpts = createValidOptions({ maxPositions: 99, chunkPositions: 10 });
    const estOverPos = estimateScopes([scope100], overPosOpts);
    expect(estOverPos.exceedsPositionLimit).toBe(true);

    // Chunk limit exact cap vs cap+1
    const exactChunkOpts = createValidOptions({ maxChunks: 10, chunkPositions: 10 });
    const estExactChunks = estimateScopes([scope100], exactChunkOpts);
    expect(estExactChunks.initialChunks).toBe(10n);
    expect(estExactChunks.exceedsChunkLimit).toBe(false);

    const overChunkOpts = createValidOptions({ maxChunks: 9, chunkPositions: 10 });
    const estOverChunks = estimateScopes([scope100], overChunkOpts);
    expect(estOverChunks.exceedsChunkLimit).toBe(true);

    // Warning threshold exact boundary (PROVISIONAL_WARN_POSITIONS = 1_000_000)
    // 999,999 positions (1 x 999,999) -> false
    const scopeUnderWarn = makeScope(1, 0, 0, 1, PROVISIONAL_WARN_POSITIONS - 1);
    expect(estimateScopes([scopeUnderWarn], createValidOptions()).largeScopeWarning).toBe(false);

    // 1,000,000 positions (1 x 1,000,000) -> true
    const scopeExactWarn = makeScope(1, 0, 0, 1, PROVISIONAL_WARN_POSITIONS);
    expect(estimateScopes([scopeExactWarn], createValidOptions()).largeScopeWarning).toBe(true);

    // 1,000,001 positions (1 x 1,000,001) -> true
    const scopeOverWarn = makeScope(1, 0, 0, 1, PROVISIONAL_WARN_POSITIONS + 1);
    expect(estimateScopes([scopeOverWarn], createValidOptions()).largeScopeWarning).toBe(true);
  });

  // Group 3: Giant safe endpoints producing area > Number.MAX_SAFE_INTEGER without plan materialization
  it('3. calculates exact BigInt metrics for safe endpoints exceeding Number.MAX_SAFE_INTEGER without plan materialization', () => {
    // Each coordinate is a safe integer (1,000,000,000 < Number.MAX_SAFE_INTEGER)
    // But product width * height = 10^18 > Number.MAX_SAFE_INTEGER (9 * 10^15)
    const giantScope = makeScope(1, 0, 0, 1_000_000_000, 1_000_000_000);
    const opts = createValidOptions({ maxPositions: 10_000_000, maxChunks: 4096, chunkPositions: 20_000 });

    const estimate = estimateScopes([giantScope], opts);

    expect(estimate.selectedPositions).toBe(1_000_000_000_000_000_000n);
    // budget=20000, width=10^9 => colsStep=20000, rowsStep=1.
    // colChunks = 10^9 / 20000 = 50,000.
    // rowChunks = 10^9 / 1 = 1,000,000,000.
    // initialChunks = 50,000 * 10^9 = 50,000,000,000,000 chunks
    expect(estimate.initialChunks).toBe(50_000_000_000_000n);
    expect(estimate.exceedsPositionLimit).toBe(true);
    expect(estimate.exceedsChunkLimit).toBe(true);
    expect(estimate.largeScopeWarning).toBe(true);
  });

  // Group 4: Manual tiling verification including width > budget and regression against planChunks
  it('4. matches reviewed 2D tiling examples and regressions against actual planChunks', () => {
    // Example 1 from specification: 5x5 with budget 4 => 10 chunks (colsStep=4, rowsStep=1, 2*5=10)
    const scope5x5 = makeScope(0, 0, 0, 5, 5);
    const est5x5 = estimateScopes([scope5x5], createValidOptions({ chunkPositions: 4 }));
    expect(est5x5.selectedPositions).toBe(25n);
    expect(est5x5.initialChunks).toBe(10n);
    // Extra regression against real planChunks
    expect(est5x5.initialChunks).toBe(BigInt(planChunks(scope5x5.rect, 4).length));

    // Example 2 from specification: 2x25000 with budget 20000 => 4 chunks (width > budget, colsStep=20000, rowsStep=1, 2*2=4)
    const scopeWide = makeScope(0, 0, 0, 2, 25_000);
    const estWide = estimateScopes([scopeWide], createValidOptions({ chunkPositions: 20_000 }));
    expect(estWide.selectedPositions).toBe(50_000n);
    expect(estWide.initialChunks).toBe(4n);
    expect(estWide.initialChunks).toBe(BigInt(planChunks(scopeWide.rect, 20_000).length));

    // Tall rectangle: 25000x2 with budget 20000 => 3 chunks (colsStep=2, rowsStep=10000, 1*3=3)
    const scopeTall = makeScope(0, 0, 0, 25_000, 2);
    const estTall = estimateScopes([scopeTall], createValidOptions({ chunkPositions: 20_000 }));
    expect(estTall.selectedPositions).toBe(50_000n);
    expect(estTall.initialChunks).toBe(3n);
    expect(estTall.initialChunks).toBe(BigInt(planChunks(scopeTall.rect, 20_000).length));

    // Small rectangle fitting in single chunk
    const scopeSmall = makeScope(0, 0, 0, 10, 10);
    const estSmall = estimateScopes([scopeSmall], createValidOptions({ chunkPositions: 20_000 }));
    expect(estSmall.selectedPositions).toBe(100n);
    expect(estSmall.initialChunks).toBe(1n);
    expect(estSmall.initialChunks).toBe(BigInt(planChunks(scopeSmall.rect, 20_000).length));
  });

  // Group 5: Coordinate validation, closed keys, symbols, -0, non-finite, and empty scopes
  it('5. enforces closed key guards, bounds validation, duplicate rejection, and empty/invalid coordinates', () => {
    const validOpts = createValidOptions();

    // Empty scopes array -> RANGE_EMPTY
    expect(() => estimateScopes([], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_EMPTY' }));

    // Non-array scopes -> RANGE_INVALID
    expect(() => estimateScopes(null as any, validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => estimateScopes({} as any, validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));

    // Scopes count > 4096 -> RANGE_INVALID
    const tooManyScopes = Array.from({ length: 4097 }, (_, i) => makeScope(i, 0, 0, 1, 1));
    expect(() => estimateScopes(tooManyScopes, validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));

    // Duplicate sheet ID -> RANGE_INVALID
    const dupScopes = [makeScope(1, 0, 0, 2, 2), makeScope(1, 0, 0, 3, 3)];
    expect(() => estimateScopes(dupScopes, validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));

    // Mismatched scope.sheetId and rect.sheetId -> RANGE_INVALID
    const mismatchedScope = { sheetId: 1, rect: { sheetId: 2, r0: 0, c0: 0, r1: 5, c1: 5 } };
    expect(() => estimateScopes([mismatchedScope as any], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));

    // Equal endpoints -> RANGE_EMPTY
    expect(() => estimateScopes([makeScope(1, 5, 0, 5, 10)], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_EMPTY' }));
    expect(() => estimateScopes([makeScope(1, 0, 5, 10, 5)], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_EMPTY' }));

    // Reversed bounds -> RANGE_INVALID
    expect(() => estimateScopes([makeScope(1, 10, 0, 5, 10)], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => estimateScopes([makeScope(1, 0, 10, 10, 5)], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));

    // Negative / -0 / non-finite coordinates -> RANGE_INVALID
    expect(() => estimateScopes([makeScope(1, -1, 0, 5, 5)], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => estimateScopes([makeScope(1, -0, 0, 5, 5)], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => estimateScopes([makeScope(1, 0, 0, 5, -0)], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => estimateScopes([makeScope(1, 0, 0, Infinity, 5)], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => estimateScopes([makeScope(1, 0, 0, NaN, 5)], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => estimateScopes([makeScope(1, 0, 0, 5.5, 5)], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));

    // Extra own properties, Symbol keys, or inherited properties on scope -> RANGE_INVALID
    expect(() => estimateScopes([{ ...makeScope(1, 0, 0, 5, 5), extra: 'bad' } as any], validOpts)).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    expect(() => estimateScopes([{ ...makeScope(1, 0, 0, 5, 5), [Symbol('extra')]: 'bad' } as any], validOpts)).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    const inheritedScope = Object.create({ inheritedProp: 123 });
    Object.assign(inheritedScope, makeScope(1, 0, 0, 5, 5));
    expect(() => estimateScopes([inheritedScope], validOpts)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));

    // Extra own properties, Symbol keys, or inherited properties on rect -> RANGE_INVALID
    const rectWithExtra = { sheetId: 1, r0: 0, c0: 0, r1: 5, c1: 5, extra: 99 };
    expect(() => estimateScopes([{ sheetId: 1, rect: rectWithExtra as any }], validOpts)).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    const rectWithSymbol = { sheetId: 1, r0: 0, c0: 0, r1: 5, c1: 5, [Symbol('sym')]: 1 };
    expect(() => estimateScopes([{ sheetId: 1, rect: rectWithSymbol as any }], validOpts)).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    const inheritedRect = Object.create({ protoProp: 1 });
    Object.assign(inheritedRect, { sheetId: 1, r0: 0, c0: 0, r1: 5, c1: 5 });
    expect(() => estimateScopes([{ sheetId: 1, rect: inheritedRect }], validOpts)).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
  });

  // Group 6: Single capture of changing getters and hostile throwing getters
  it('6. captures primitives once and safely sanitizes hostile throwing getters into static catalog errors', () => {
    // Changing getter on options captured once
    let optCallCount = 0;
    const dynamicOpts = {
      get maxPositions(): number {
        return ++optCallCount === 1 ? 100 : 9_999_999;
      },
      maxChunks: 4096,
      chunkPositions: 20_000,
      signal: new AbortController().signal
    };
    const scope100 = makeScope(1, 0, 0, 10, 10); // 100 positions
    const estDyn = estimateScopes([scope100], dynamicOpts);
    expect(estDyn.selectedPositions).toBe(100n);
    expect(estDyn.exceedsPositionLimit).toBe(false); // Validated against captured 100, not subsequent 9,999,999
    expect(optCallCount).toBe(1);

    // Changing getter on rect captured once
    let rectCallCount = 0;
    const dynamicRect: Rect = {
      sheetId: 1,
      r0: 0,
      c0: 0,
      get r1(): number {
        return ++rectCallCount === 1 ? 10 : 999_999;
      },
      c1: 10
    };
    const estRect = estimateScopes([{ sheetId: 1, rect: dynamicRect }], createValidOptions());
    expect(estRect.selectedPositions).toBe(100n);
    expect(rectCallCount).toBe(1);

    // Hostile throwing getter on options -> static CONFIG_INVALID (no raw secret leak)
    const hostileOpt = {
      get maxPositions(): number {
        throw new Error('SENSITIVE_OPTION_EXCEPTION');
      },
      maxChunks: 4096,
      chunkPositions: 20_000,
      signal: new AbortController().signal
    };
    try {
      estimateScopes([scope100], hostileOpt as any);
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('CONFIG_INVALID');
      expect(err.message).toBe(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
      expect(String(err)).not.toContain('SENSITIVE_OPTION_EXCEPTION');
    }

    // Hostile mutated DomainError from options getter -> clean DomainError
    const hostileMutatedConfig = new DomainError('CONFIG_INVALID');
    (hostileMutatedConfig as any).secretToken = 'token_abc123';
    (hostileMutatedConfig as any).cause = new Error('inner leak');
    const hostileMutatedOpts = {
      get maxChunks(): number {
        throw hostileMutatedConfig;
      },
      maxPositions: 10_000_000,
      chunkPositions: 20_000,
      signal: new AbortController().signal
    };
    try {
      estimateScopes([scope100], hostileMutatedOpts as any);
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('CONFIG_INVALID');
      expect((err as any).secretToken).toBeUndefined();
      expect((err as any).cause).toBeUndefined();
    }

    // Hostile throwing getter on rect -> static RANGE_INVALID
    const hostileRect: Rect = {
      sheetId: 1,
      r0: 0,
      c0: 0,
      get r1(): number {
        throw new Error('SENSITIVE_RECT_EXCEPTION');
      },
      c1: 10
    };
    try {
      estimateScopes([{ sheetId: 1, rect: hostileRect }], createValidOptions());
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('RANGE_INVALID');
      expect(err.message).toBe(SAFE_ERROR_MESSAGES.RANGE_INVALID);
      expect(String(err)).not.toContain('SENSITIVE_RECT_EXCEPTION');
    }
  });

  // Group 7: AbortSignal handling, caller input immutability, and unknown byte fields
  it('7. checks pre-abort and per-scope cancellation, preserves caller inputs, and leaves byte fields null', () => {
    const scope1 = makeScope(1, 0, 0, 10, 10);
    const scope2 = makeScope(2, 0, 0, 10, 10);

    // Pre-aborted signal -> OPERATION_ABORTED
    const preAbortedCtrl = new AbortController();
    preAbortedCtrl.abort();
    expect(() => estimateScopes([scope1], createValidOptions({ signal: preAbortedCtrl.signal }))).toThrowError(
      expect.objectContaining({ code: 'OPERATION_ABORTED' })
    );

    // Signal aborted during per-scope polling
    const pollingCtrl = new AbortController();
    const pollingScope: ExportScope = {
      get sheetId(): number {
        pollingCtrl.abort();
        return 3;
      },
      rect: { sheetId: 3, r0: 0, c0: 0, r1: 10, c1: 10 }
    };
    expect(() =>
      estimateScopes([scope1, pollingScope, scope2], createValidOptions({ signal: pollingCtrl.signal }))
    ).toThrowError(expect.objectContaining({ code: 'OPERATION_ABORTED' }));

    // Input scopes and rects are NOT mutated or frozen
    const mutableScope = makeScope(1, 0, 0, 10, 10);
    expect(Object.isFrozen(mutableScope)).toBe(false);
    expect(Object.isFrozen(mutableScope.rect)).toBe(false);

    const result = estimateScopes([mutableScope], createValidOptions());

    expect(Object.isFrozen(mutableScope)).toBe(false);
    expect(Object.isFrozen(mutableScope.rect)).toBe(false);
    expect(mutableScope.sheetId).toBe(1);
    expect(mutableScope.rect.r1).toBe(10);

    // Returned estimate is frozen and contains null byte fields
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.decodedBytes).toBeNull();
    expect(result.outputBytes).toBeNull();
  });

  // Group 8: Options contract and limits validation
  it('8. validates options contract: rejects invalid budgets, out-of-range caps, -0, and non-conforming signals with static CONFIG_INVALID', () => {
    const scope = makeScope(1, 0, 0, 10, 10);
    const validSig = new AbortController().signal;

    // options not object / null / array
    expect(() => estimateScopes([scope], null as any)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => estimateScopes([scope], [] as any)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => estimateScopes([scope], 'bad' as any)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));

    // maxPositions out of bounds (1..10M), -0, non-safe
    expect(() => estimateScopes([scope], { maxPositions: 0, maxChunks: 4096, chunkPositions: 20_000, signal: validSig })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() => estimateScopes([scope], { maxPositions: -1, maxChunks: 4096, chunkPositions: 20_000, signal: validSig })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() => estimateScopes([scope], { maxPositions: -0, maxChunks: 4096, chunkPositions: 20_000, signal: validSig })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() =>
      estimateScopes([scope], { maxPositions: PROVISIONAL_MAX_SELECTED_POSITIONS + 1, maxChunks: 4096, chunkPositions: 20_000, signal: validSig })
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => estimateScopes([scope], { maxPositions: 1.5, maxChunks: 4096, chunkPositions: 20_000, signal: validSig })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );

    // maxChunks out of bounds (1..4096), -0, non-safe
    expect(() => estimateScopes([scope], { maxPositions: 10_000_000, maxChunks: 0, chunkPositions: 20_000, signal: validSig })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() => estimateScopes([scope], { maxPositions: 10_000_000, maxChunks: 4097, chunkPositions: 20_000, signal: validSig })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() => estimateScopes([scope], { maxPositions: 10_000_000, maxChunks: -0, chunkPositions: 20_000, signal: validSig })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );

    // chunkPositions out of bounds (< 1), -0, non-safe
    expect(() => estimateScopes([scope], { maxPositions: 10_000_000, maxChunks: 4096, chunkPositions: 0, signal: validSig })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() => estimateScopes([scope], { maxPositions: 10_000_000, maxChunks: 4096, chunkPositions: -5, signal: validSig })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() => estimateScopes([scope], { maxPositions: 10_000_000, maxChunks: 4096, chunkPositions: -0, signal: validSig })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );

    // signal missing or invalid shape
    expect(() =>
      estimateScopes([scope], { maxPositions: 10_000_000, maxChunks: 4096, chunkPositions: 20_000, signal: null as any })
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() =>
      estimateScopes([scope], { maxPositions: 10_000_000, maxChunks: 4096, chunkPositions: 20_000, signal: {} as any })
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() =>
      estimateScopes([scope], {
        maxPositions: 10_000_000,
        maxChunks: 4096,
        chunkPositions: 20_000,
        signal: { aborted: 'not-bool', addEventListener: () => {}, removeEventListener: () => {} } as any
      })
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });
});
