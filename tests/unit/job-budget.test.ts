import { describe, it, expect } from 'vitest';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import {
  createJobBudget,
  PROVISIONAL_MAX_CHUNKS,
  PROVISIONAL_MAX_CELLS,
  PROVISIONAL_MAX_DECODED_BYTES,
  PROVISIONAL_MAX_OUTPUT_BYTES,
  type JobBudgetOptions
} from '../../src/jobs/budget.ts';

function createStandardBudgetOptions(overrides: Partial<JobBudgetOptions> = {}): JobBudgetOptions {
  return {
    maxChunks: PROVISIONAL_MAX_CHUNKS,
    maxCells: PROVISIONAL_MAX_CELLS,
    maxDecodedBytes: PROVISIONAL_MAX_DECODED_BYTES,
    maxOutputBytes: PROVISIONAL_MAX_OUTPUT_BYTES,
    ...overrides
  };
}

describe('T23b Bounded Pure Offline Job Budget Counter', () => {
  it('contains revoked option proxies inside the static configuration boundary', () => {
    const { proxy, revoke } = Proxy.revocable(createStandardBudgetOptions(), {});
    revoke();
    expect(() => createJobBudget(proxy)).toThrowError(expect.objectContaining({
      code: 'CONFIG_INVALID', message: SAFE_ERROR_MESSAGES.CONFIG_INVALID
    }));
  });
  // Group 1: Multi-chunk + output true accumulation
  describe('Group 1: Multi-chunk + output true accumulation', () => {
    it('accumulates multiple chunks (including empty chunks) and output bundle sums into explicit snapshot metrics', () => {
      const budget = createJobBudget(createStandardBudgetOptions({
        maxChunks: 10,
        maxCells: 1000,
        maxDecodedBytes: 50_000,
        maxOutputBytes: 100_000
      }));

      // Initial state is all zeros
      expect(budget.snapshot()).toEqual({
        chunks: 0,
        cells: 0,
        decodedBytes: 0,
        outputBytes: 0
      });

      // Chunk 1: 500 decoded bytes, 15 emitted cells
      budget.recordChunk(500, 15);
      expect(budget.snapshot()).toEqual({
        chunks: 1,
        cells: 15,
        decodedBytes: 500,
        outputBytes: 0
      });

      // Chunk 2: 1250 decoded bytes, 35 emitted cells
      budget.recordChunk(1250, 35);
      expect(budget.snapshot()).toEqual({
        chunks: 2,
        cells: 50,
        decodedBytes: 1750,
        outputBytes: 0
      });

      // Chunk 3: Empty chunk (e.g. 20,000 planned scope positions with 0 cells and 0 decoded bytes)
      // Cells vs positions: positions in scope geometry are not counted; only actual emitted cells and +1 chunk
      budget.recordChunk(0, 0);
      expect(budget.snapshot()).toEqual({
        chunks: 3,
        cells: 50,
        decodedBytes: 1750,
        outputBytes: 0
      });

      // Output bundle sum: primary CSV artifact (15,000 bytes) + companion report JSON (2,400 bytes)
      budget.recordOutput(15_000);
      expect(budget.snapshot()).toEqual({
        chunks: 3,
        cells: 50,
        decodedBytes: 1750,
        outputBytes: 15_000
      });

      budget.recordOutput(2_400);
      expect(budget.snapshot()).toEqual({
        chunks: 3,
        cells: 50,
        decodedBytes: 1750,
        outputBytes: 17_400
      });
    });
  });

  // Group 2: Exact caps, +1, and zero
  describe('Group 2: Exact caps, +1, and zero', () => {
    it('evaluates exact cap boundaries, cap+1 rejections, and zero deltas for all dimensions', () => {
      // 1. Max chunks: exactly reaches cap (2 chunks), 3rd chunk fails with SIZE_LIMIT_EXCEEDED
      const chunkBudget = createJobBudget(createStandardBudgetOptions({ maxChunks: 2 }));
      chunkBudget.recordChunk(100, 1);
      chunkBudget.recordChunk(200, 2);
      expect(chunkBudget.snapshot().chunks).toBe(2);
      expect(() => chunkBudget.recordChunk(0, 0)).toThrowError(
        expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED', message: SAFE_ERROR_MESSAGES.SIZE_LIMIT_EXCEEDED })
      );

      // Fresh budget: cap+1 in single chunk (e.g. budget allows 1 chunk, 2nd rejected)
      const singleChunkBudget = createJobBudget(createStandardBudgetOptions({ maxChunks: 1 }));
      singleChunkBudget.recordChunk(10, 1);
      expect(() => singleChunkBudget.recordChunk(10, 1)).toThrowError(
        expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' })
      );

      // 2. Max cells: exactly reaches cap (50 cells), +1 cell fails with CELL_LIMIT_EXCEEDED
      const cellBudget = createJobBudget(createStandardBudgetOptions({ maxCells: 50 }));
      cellBudget.recordChunk(100, 50);
      expect(cellBudget.snapshot().cells).toBe(50);
      expect(() => cellBudget.recordChunk(10, 1)).toThrowError(
        expect.objectContaining({ code: 'CELL_LIMIT_EXCEEDED', message: SAFE_ERROR_MESSAGES.CELL_LIMIT_EXCEEDED })
      );

      // Fresh budget: cap+1 on first chunk (51 cells > 50 max) fails immediately
      const overCellBudget = createJobBudget(createStandardBudgetOptions({ maxCells: 50 }));
      expect(() => overCellBudget.recordChunk(10, 51)).toThrowError(
        expect.objectContaining({ code: 'CELL_LIMIT_EXCEEDED' })
      );

      // 3. Max decoded bytes: exactly reaches cap (1000 bytes), +1 byte fails with BYTE_LIMIT_EXCEEDED
      const decodedBudget = createJobBudget(createStandardBudgetOptions({ maxDecodedBytes: 1000 }));
      decodedBudget.recordChunk(1000, 5);
      expect(decodedBudget.snapshot().decodedBytes).toBe(1000);
      expect(() => decodedBudget.recordChunk(1, 0)).toThrowError(
        expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED', message: SAFE_ERROR_MESSAGES.BYTE_LIMIT_EXCEEDED })
      );

      // Fresh budget: cap+1 on first chunk (1001 bytes > 1000 max) fails immediately
      const overDecodedBudget = createJobBudget(createStandardBudgetOptions({ maxDecodedBytes: 1000 }));
      expect(() => overDecodedBudget.recordChunk(1001, 1)).toThrowError(
        expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' })
      );

      // 4. Max output bytes: exactly reaches cap (2000 bytes), +1 byte fails with BYTE_LIMIT_EXCEEDED
      const outputBudget = createJobBudget(createStandardBudgetOptions({ maxOutputBytes: 2000 }));
      outputBudget.recordOutput(2000);
      expect(outputBudget.snapshot().outputBytes).toBe(2000);
      expect(() => outputBudget.recordOutput(1)).toThrowError(
        expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED', message: SAFE_ERROR_MESSAGES.BYTE_LIMIT_EXCEEDED })
      );

      // Fresh budget: cap+1 on first output (2001 bytes > 2000 max) fails immediately
      const overOutputBudget = createJobBudget(createStandardBudgetOptions({ maxOutputBytes: 2000 }));
      expect(() => overOutputBudget.recordOutput(2001)).toThrowError(
        expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' })
      );

      // 5. Zero caps: maxCells=0, maxDecodedBytes=0, maxOutputBytes=0
      const zeroBudget = createJobBudget({
        maxChunks: 5,
        maxCells: 0,
        maxDecodedBytes: 0,
        maxOutputBytes: 0
      });
      // Zero increments succeed on zero caps
      zeroBudget.recordChunk(0, 0);
      zeroBudget.recordOutput(0);
      expect(zeroBudget.snapshot()).toEqual({ chunks: 1, cells: 0, decodedBytes: 0, outputBytes: 0 });
      // Non-zero increment immediately fails
      expect(() => zeroBudget.recordChunk(0, 1)).toThrowError(
        expect.objectContaining({ code: 'CELL_LIMIT_EXCEEDED' })
      );

      // 6. Zero delta at output cap: delta=0 is accepted when already at output cap
      const fullOutputBudget = createJobBudget(createStandardBudgetOptions({ maxOutputBytes: 100 }));
      fullOutputBudget.recordOutput(100);
      expect(fullOutputBudget.snapshot().outputBytes).toBe(100);
      fullOutputBudget.recordOutput(0); // 0 > 100 - 100 is false, passes
      expect(fullOutputBudget.snapshot().outputBytes).toBe(100);
      expect(() => fullOutputBudget.recordOutput(1)).toThrowError(
        expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' })
      );
    });
  });

  // Group 3: Failed increment atomic, no further record after latched failure, new errors, snapshot immutability
  describe('Group 3: Failed increment atomic, latched failure, and snapshot immutability', () => {
    it('preserves atomic state on rejection, latches failure permanently, throws fresh errors, and preserves snapshot immutability', () => {
      const budget = createJobBudget(createStandardBudgetOptions({
        maxChunks: 10,
        maxCells: 100,
        maxDecodedBytes: 1000,
        maxOutputBytes: 1000
      }));

      // Commit valid first chunk
      budget.recordChunk(200, 20);
      expect(budget.snapshot()).toEqual({
        chunks: 1,
        cells: 20,
        decodedBytes: 200,
        outputBytes: 0
      });

      // Attempt second chunk that exceeds cell cap (20 + 85 = 105 > 100)
      let firstError: unknown;
      try {
        budget.recordChunk(100, 85);
        expect.unreachable('Should have thrown');
      } catch (err) {
        firstError = err;
      }
      expect(firstError).toBeInstanceOf(DomainError);
      expect((firstError as DomainError).code).toBe('CELL_LIMIT_EXCEEDED');

      // Atomic verification: chunks did not advance from 1 to 2, decodedBytes did not advance from 200 to 300
      const snapAfterFailure = budget.snapshot();
      expect(snapAfterFailure).toEqual({
        chunks: 1,
        cells: 20,
        decodedBytes: 200,
        outputBytes: 0
      });

      // Verification of atomic check on decoded bytes cap failure
      const budgetBytes = createJobBudget(createStandardBudgetOptions({
        maxChunks: 10,
        maxCells: 100,
        maxDecodedBytes: 500,
        maxOutputBytes: 1000
      }));
      budgetBytes.recordChunk(200, 10);
      expect(() => budgetBytes.recordChunk(400, 10)).toThrowError(
        expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' })
      );
      // Chunks and cells did not increment
      expect(budgetBytes.snapshot()).toEqual({
        chunks: 1,
        cells: 10,
        decodedBytes: 200,
        outputBytes: 0
      });

      // Permanent latching: no further recordChunk or recordOutput may advance
      let secondError: unknown;
      try {
        budget.recordChunk(0, 0);
        expect.unreachable('Should have thrown on latched failure');
      } catch (err) {
        secondError = err;
      }
      expect(secondError).toBeInstanceOf(DomainError);
      expect((secondError as DomainError).code).toBe('CELL_LIMIT_EXCEEDED');

      // Every subsequent throw is a NEW static DomainError instance (err1 !== err2)
      expect(secondError).not.toBe(firstError);
      expect((secondError as DomainError).code).toBe((firstError as DomainError).code);
      expect((secondError as DomainError).message).toBe(SAFE_ERROR_MESSAGES.CELL_LIMIT_EXCEEDED);

      // recordOutput also throws the latched code
      let thirdError: unknown;
      try {
        budget.recordOutput(10);
        expect.unreachable('Should have thrown on latched failure');
      } catch (err) {
        thirdError = err;
      }
      expect((thirdError as DomainError).code).toBe('CELL_LIMIT_EXCEEDED');
      expect(thirdError).not.toBe(firstError);
      expect(thirdError).not.toBe(secondError);

      // Even malformed inputs on latched budget throw the permanently latched code
      expect(() => budget.recordChunk(-1, 0)).toThrowError(
        expect.objectContaining({ code: 'CELL_LIMIT_EXCEEDED' })
      );

      // Snapshot immutability:
      const snap1 = budget.snapshot();
      const snap2 = budget.snapshot();
      expect(snap1).toEqual({ chunks: 1, cells: 20, decodedBytes: 200, outputBytes: 0 });
      expect(snap1).not.toBe(snap2); // Fresh instance
      expect(Object.isFrozen(snap1)).toBe(true);
      expect(Object.isFrozen(snap2)).toBe(true);

      // In strict mode, modifying frozen snapshot properties throws TypeError
      expect(() => {
        (snap1 as any).chunks = 999;
      }).toThrow(TypeError);
    });
  });

  // Group 4: Invalid options, capture once, and throwing getter static
  describe('Group 4: Invalid options, capture once, and throwing getter static', () => {
    it('validates options contract, captures options once, and safely sanitizes hostile throwing getters into CONFIG_INVALID', () => {
      // 1. Non-object options reject with static CONFIG_INVALID
      expect(() => createJobBudget(null as any)).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID', message: SAFE_ERROR_MESSAGES.CONFIG_INVALID })
      );
      expect(() => createJobBudget(undefined as any)).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget([] as any)).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget('string' as any)).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(42 as any)).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );

      // 2. maxChunks validation: 1..4096, safe integers, no -0
      expect(() => createJobBudget(createStandardBudgetOptions({ maxChunks: 0 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxChunks: -1 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxChunks: -0 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxChunks: PROVISIONAL_MAX_CHUNKS + 1 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxChunks: 1.5 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxChunks: NaN }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxChunks: Infinity }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );

      // 3. maxCells validation: 0..250000, safe integers, no -0
      expect(() => createJobBudget(createStandardBudgetOptions({ maxCells: -1 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxCells: -0 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxCells: PROVISIONAL_MAX_CELLS + 1 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxCells: 10.5 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxCells: NaN }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );

      // 4. maxDecodedBytes validation: 0..64MiB, safe integers, no -0
      expect(() => createJobBudget(createStandardBudgetOptions({ maxDecodedBytes: -1 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxDecodedBytes: -0 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxDecodedBytes: PROVISIONAL_MAX_DECODED_BYTES + 1 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxDecodedBytes: NaN }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );

      // 5. maxOutputBytes validation: 0..128MiB, safe integers, no -0
      expect(() => createJobBudget(createStandardBudgetOptions({ maxOutputBytes: -1 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxOutputBytes: -0 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxOutputBytes: PROVISIONAL_MAX_OUTPUT_BYTES + 1 }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => createJobBudget(createStandardBudgetOptions({ maxOutputBytes: NaN }))).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );

      // 6. Hostile throwing getter on options -> static CONFIG_INVALID without leaking diagnostic string
      const hostileOptions = {
        get maxChunks(): number {
          throw new Error('HOSTILE_RAW_AUTH_SECRET_DIAGNOSTIC');
        },
        maxCells: 100,
        maxDecodedBytes: 1000,
        maxOutputBytes: 1000
      };
      try {
        createJobBudget(hostileOptions as any);
        expect.unreachable('Should have thrown on hostile getter');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('CONFIG_INVALID');
        expect((err as DomainError).message).toBe(SAFE_ERROR_MESSAGES.CONFIG_INVALID);
        expect(String(err)).not.toContain('HOSTILE_RAW_AUTH_SECRET_DIAGNOSTIC');
      }

      // Hostile mutated DomainError from getter -> clean DomainError without extra properties
      const mutatedErr = new DomainError('CONFIG_INVALID');
      (mutatedErr as any).secretPayload = 'leaked-token-xyz';
      const hostileMutatedOptions = {
        get maxCells(): number {
          throw mutatedErr;
        },
        maxChunks: 10,
        maxDecodedBytes: 1000,
        maxOutputBytes: 1000
      };
      try {
        createJobBudget(hostileMutatedOptions as any);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('CONFIG_INVALID');
        expect((err as any).secretPayload).toBeUndefined();
      }

      // 7. Options captured once: changing getter returns valid on 1st read, invalid on 2nd read
      let chunkGetterReads = 0;
      const dynamicOptions = {
        get maxChunks(): number {
          return ++chunkGetterReads === 1 ? 5 : 0;
        },
        maxCells: 100,
        maxDecodedBytes: 1000,
        maxOutputBytes: 1000
      };
      const dynBudget = createJobBudget(dynamicOptions);
      expect(chunkGetterReads).toBe(1);
      // Validated against captured 5
      dynBudget.recordChunk(10, 1);
      expect(dynBudget.snapshot().chunks).toBe(1);

      // Mutating options object post-creation has no effect
      const mutableOptions = {
        maxChunks: 10,
        maxCells: 100,
        maxDecodedBytes: 1000,
        maxOutputBytes: 1000
      };
      const safeBudget = createJobBudget(mutableOptions);
      mutableOptions.maxChunks = 1;
      // Budget still permits >1 chunk because options was captured once
      safeBudget.recordChunk(10, 1);
      safeBudget.recordChunk(10, 1);
      expect(safeBudget.snapshot().chunks).toBe(2);
    });
  });

  // Group 5: Invalid deltas, no hooks/coercion, safe max integer overflow
  describe('Group 5: Invalid deltas, no hooks/coercion, safe max integer overflow', () => {
    it('rejects malformed deltas with INTERNAL_ERROR, avoids property coercion on non-numbers, and handles safe max integer overflows', () => {
      // 1. Invalid deltas on recordChunk: negative, -0, float, NaN, Infinity, non-number
      const testInvalidChunkDelta = (decodedBytes: any, cells: any) => {
        const b = createJobBudget(createStandardBudgetOptions());
        expect(() => b.recordChunk(decodedBytes, cells)).toThrowError(
          expect.objectContaining({ code: 'INTERNAL_ERROR', message: SAFE_ERROR_MESSAGES.INTERNAL_ERROR })
        );
        // Permanently latches INTERNAL_ERROR
        expect(() => b.recordChunk(0, 0)).toThrowError(
          expect.objectContaining({ code: 'INTERNAL_ERROR' })
        );
      };

      testInvalidChunkDelta(-1, 0);
      testInvalidChunkDelta(0, -1);
      testInvalidChunkDelta(-0, 0);
      testInvalidChunkDelta(0, -0);
      testInvalidChunkDelta(1.5, 0);
      testInvalidChunkDelta(0, 2.5);
      testInvalidChunkDelta(NaN, 0);
      testInvalidChunkDelta(0, NaN);
      testInvalidChunkDelta(Infinity, 0);
      testInvalidChunkDelta(0, Infinity);
      testInvalidChunkDelta('100', 0);
      testInvalidChunkDelta(0, '100');
      testInvalidChunkDelta(null, 0);
      testInvalidChunkDelta(0, null);
      testInvalidChunkDelta(undefined, 0);
      testInvalidChunkDelta(0, undefined);
      testInvalidChunkDelta(Symbol('delta'), 0);

      // 2. Invalid deltas on recordOutput: negative, -0, float, NaN, Infinity, non-number
      const testInvalidOutputDelta = (bytes: any) => {
        const b = createJobBudget(createStandardBudgetOptions());
        expect(() => b.recordOutput(bytes)).toThrowError(
          expect.objectContaining({ code: 'INTERNAL_ERROR', message: SAFE_ERROR_MESSAGES.INTERNAL_ERROR })
        );
        // Permanently latches INTERNAL_ERROR
        expect(() => b.recordOutput(0)).toThrowError(
          expect.objectContaining({ code: 'INTERNAL_ERROR' })
        );
      };

      testInvalidOutputDelta(-1);
      testInvalidOutputDelta(-0);
      testInvalidOutputDelta(1.5);
      testInvalidOutputDelta(NaN);
      testInvalidOutputDelta(Infinity);
      testInvalidOutputDelta('500');
      testInvalidOutputDelta(null);
      testInvalidOutputDelta(undefined);
      testInvalidOutputDelta({});

      // 3. No property access or coercion: objects with valueOf, toString, Symbol.toPrimitive
      let valueOfCalled = false;
      const hostileCoercible = {
        valueOf() {
          valueOfCalled = true;
          return 50;
        },
        toString() {
          valueOfCalled = true;
          return '50';
        },
        [Symbol.toPrimitive]() {
          valueOfCalled = true;
          return 50;
        }
      };

      const noCoercionBudget = createJobBudget(createStandardBudgetOptions());
      expect(() => noCoercionBudget.recordChunk(hostileCoercible as any, 10)).toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
      expect(valueOfCalled).toBe(false);

      let outputValueOfCalled = false;
      const hostileOutputCoercible = {
        valueOf() {
          outputValueOfCalled = true;
          return 50;
        }
      };
      const noCoercionBudgetOutput = createJobBudget(createStandardBudgetOptions());
      expect(() => noCoercionBudgetOutput.recordOutput(hostileOutputCoercible as any)).toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
      expect(outputValueOfCalled).toBe(false);

      // Hostile Proxy: trap is never triggered
      let proxyGetTrapped = false;
      const hostileProxy = new Proxy({}, {
        get() {
          proxyGetTrapped = true;
          return 100;
        }
      });
      const proxyBudget = createJobBudget(createStandardBudgetOptions());
      expect(() => proxyBudget.recordChunk(hostileProxy as any, 0)).toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
      expect(proxyGetTrapped).toBe(false);

      // 4. Safe max integer overflow:
      // Number.MAX_SAFE_INTEGER is a valid safe integer, but exceeds provisional caps
      // Delta > cap - current detects overflow without wrapping or non-safe integer math
      const overflowBudget = createJobBudget(createStandardBudgetOptions());
      expect(() => overflowBudget.recordChunk(0, Number.MAX_SAFE_INTEGER)).toThrowError(
        expect.objectContaining({ code: 'CELL_LIMIT_EXCEEDED' })
      );

      const overflowBudgetDecoded = createJobBudget(createStandardBudgetOptions());
      expect(() => overflowBudgetDecoded.recordChunk(Number.MAX_SAFE_INTEGER, 0)).toThrowError(
        expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' })
      );

      const overflowBudgetOutput = createJobBudget(createStandardBudgetOptions());
      expect(() => overflowBudgetOutput.recordOutput(Number.MAX_SAFE_INTEGER)).toThrowError(
        expect.objectContaining({ code: 'BYTE_LIMIT_EXCEEDED' })
      );

      // Number.MAX_SAFE_INTEGER + 1 is not a safe integer -> INTERNAL_ERROR
      const unsafeBudget = createJobBudget(createStandardBudgetOptions());
      expect(() => unsafeBudget.recordChunk(Number.MAX_SAFE_INTEGER + 1, 0)).toThrowError(
        expect.objectContaining({ code: 'INTERNAL_ERROR' })
      );
    });
  });

  // Group 6: Independent fresh jobs, no reset/reuse
  describe('Group 6: Independent fresh jobs, no reset/reuse', () => {
    it('operates jobs completely independently, disallows reset/reuse, and freezes budget interface', () => {
      const budgetA = createJobBudget(createStandardBudgetOptions({ maxChunks: 5, maxCells: 100 }));
      const budgetB = createJobBudget(createStandardBudgetOptions({ maxChunks: 5, maxCells: 100 }));

      // Advance job A
      budgetA.recordChunk(100, 10);
      budgetA.recordOutput(500);

      // Job B remains pristine at all zeros
      expect(budgetA.snapshot()).toEqual({ chunks: 1, cells: 10, decodedBytes: 100, outputBytes: 500 });
      expect(budgetB.snapshot()).toEqual({ chunks: 0, cells: 0, decodedBytes: 0, outputBytes: 0 });

      // Latch failure on job A
      expect(() => budgetA.recordChunk(100, 95)).toThrowError(
        expect.objectContaining({ code: 'CELL_LIMIT_EXCEEDED' })
      );
      expect(() => budgetA.recordChunk(0, 0)).toThrowError(
        expect.objectContaining({ code: 'CELL_LIMIT_EXCEEDED' })
      );

      // Job B is unaffected and can record successfully
      budgetB.recordChunk(50, 5);
      budgetB.recordOutput(250);
      expect(budgetB.snapshot()).toEqual({ chunks: 1, cells: 5, decodedBytes: 50, outputBytes: 250 });

      // No reset method exists on JobBudget
      expect('reset' in budgetA).toBe(false);
      expect((budgetA as any).reset).toBeUndefined();
      expect('reset' in budgetB).toBe(false);
      expect((budgetB as any).reset).toBeUndefined();

      // JobBudget object itself is frozen
      expect(Object.isFrozen(budgetA)).toBe(true);
      expect(Object.isFrozen(budgetB)).toBe(true);

      // In strict mode, attempting to mutate methods throws TypeError
      expect(() => {
        (budgetA as any).recordChunk = () => {};
      }).toThrow(TypeError);
    });
  });
});
