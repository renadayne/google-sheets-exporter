import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_POSITIONS,
  createChunkId,
  planChunks,
  splitChunk
} from '../../src/domain/chunks.ts';
import { createDeterministicRandom } from '../helpers/deterministic.ts';

describe('T14a Deterministic 2D Tiling and Splitting', () => {
  it('retains exact safe endpoints near MAX_SAFE_INTEGER with an oversized budget', () => {
    const rect = { sheetId: 7, r0: 9007199254740989, c0: 4, r1: 9007199254740991, c1: 6 };
    expect(planChunks(rect, Number.MAX_SAFE_INTEGER)).toEqual([{ id: 'chunk_7_9007199254740989_4_9007199254740991_6', rect }]);
    expect(() => splitChunk({ id: 'unrelated-id', rect })).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
  });
  it('tiles small rectangle with nonzero origin into literal expected chunks', () => {
    const rect = { sheetId: 1, r0: 10, c0: 20, r1: 13, c1: 22 };
    const chunks = planChunks(rect, 4);

    expect(chunks).toEqual([
      {
        id: 'chunk_1_10_20_12_22',
        rect: { sheetId: 1, r0: 10, c0: 20, r1: 12, c1: 22 }
      },
      {
        id: 'chunk_1_12_20_13_22',
        rect: { sheetId: 1, r0: 12, c0: 20, r1: 13, c1: 22 }
      }
    ]);
  });

  it('performs column tiling when wide rectangle exceeds budget', () => {
    const rect = { sheetId: 0, r0: 2, c0: 5, r1: 4, c1: 11 };
    const chunks = planChunks(rect, 3);

    expect(chunks).toEqual([
      { id: 'chunk_0_2_5_3_8', rect: { sheetId: 0, r0: 2, c0: 5, r1: 3, c1: 8 } },
      { id: 'chunk_0_2_8_3_11', rect: { sheetId: 0, r0: 2, c0: 8, r1: 3, c1: 11 } },
      { id: 'chunk_0_3_5_4_8', rect: { sheetId: 0, r0: 3, c0: 5, r1: 4, c1: 8 } },
      { id: 'chunk_0_3_8_4_11', rect: { sheetId: 0, r0: 3, c0: 8, r1: 4, c1: 11 } }
    ]);
  });

  it('handles exact budget and budget=1 boundary cases', () => {
    const exact = planChunks({ sheetId: 0, r0: 0, c0: 0, r1: 4, c1: 5 }, 20);
    expect(exact).toHaveLength(1);
    expect(exact[0]!.rect).toEqual({ sheetId: 0, r0: 0, c0: 0, r1: 4, c1: 5 });

    const budget1 = planChunks({ sheetId: 2, r0: 1, c0: 1, r1: 3, c1: 3 }, 1);
    expect(budget1).toHaveLength(4);
    expect(budget1.map(c => [c.rect.r0, c.rect.c0, c.rect.r1, c.rect.c1])).toEqual([
      [1, 1, 2, 2],
      [1, 2, 2, 3],
      [2, 1, 3, 2],
      [2, 2, 3, 3]
    ]);
  });

  it('plans A1 and verifies Z90000 bounds/membership arithmetically without dense allocation', () => {
    const a1Chunks = planChunks({ sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 1 });
    expect(a1Chunks).toHaveLength(1);
    expect(a1Chunks[0]!.id).toBe('chunk_0_0_0_1_1');

    const z90000Rect = { sheetId: 0, r0: 0, c0: 0, r1: 90000, c1: 26 };
    const chunks = planChunks(z90000Rect, DEFAULT_MAX_POSITIONS);

    expect(chunks.length).toBe(Math.ceil(90000 / Math.floor(DEFAULT_MAX_POSITIONS / 26)));
    expect(chunks[0]!.rect.r0).toBe(0);
    expect(chunks[0]!.rect.c0).toBe(0);
    expect(chunks[chunks.length - 1]!.rect.r1).toBe(90000);
    expect(chunks[chunks.length - 1]!.rect.c1).toBe(26);

    let totalArea = 0;
    for (let i = 0; i < chunks.length; i++) {
      const { r0, c0, r1, c1 } = chunks[i]!.rect;
      const area = (r1 - r0) * (c1 - c0);
      expect(area).toBeGreaterThan(0);
      expect(area).toBeLessThanOrEqual(DEFAULT_MAX_POSITIONS);
      expect(c0).toBe(0);
      expect(c1).toBe(26);
      if (i > 0) expect(chunks[i]!.rect.r0).toBe(chunks[i - 1]!.rect.r1);
      totalArea += area;
    }
    expect(totalArea).toBe(90000 * 26);
  });

  it('rejects empty, reversed, fractional, negative, nonfinite, and unsafe coordinates', () => {
    expect(() => planChunks({ sheetId: 0, r0: 5, c0: 2, r1: 5, c1: 10 })).toThrowError(
      expect.objectContaining({ code: 'RANGE_EMPTY' })
    );
    expect(() => planChunks({ sheetId: 0, r0: 2, c0: 5, r1: 10, c1: 5 })).toThrowError(
      expect.objectContaining({ code: 'RANGE_EMPTY' })
    );
    expect(() => planChunks({ sheetId: 0, r0: 10, c0: 2, r1: 5, c1: 10 })).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    expect(() => planChunks({ sheetId: -1, r0: 0, c0: 0, r1: 1, c1: 1 })).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    expect(() => planChunks({ sheetId: 0, r0: 0.5, c0: 0, r1: 2, c1: 2 })).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    expect(() => planChunks({ sheetId: 0, r0: 0, c0: -1, r1: 2, c1: 2 })).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    expect(() => planChunks({ sheetId: 0, r0: 0, c0: 0, r1: Infinity, c1: 2 })).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    expect(() => planChunks({ sheetId: 0, r0: 0, c0: 0, r1: 2, c1: 2 }, 0)).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    expect(() => planChunks({ sheetId: 0, r0: 0, c0: 0, r1: 2, c1: 2 }, 1.5)).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    expect(() =>
      planChunks({ sheetId: 0, r0: 0, c0: 0, r1: Number.MAX_SAFE_INTEGER, c1: 2 })
    ).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
  });

  describe('splitChunk', () => {
    it('splits 1xN across columns and Nx1 across rows', () => {
      const [left, right] = splitChunk({
        id: 'chunk_0_0_0_1_4',
        rect: { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 4 }
      });
      expect(left.rect).toEqual({ sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 2 });
      expect(right.rect).toEqual({ sheetId: 0, r0: 0, c0: 2, r1: 1, c1: 4 });

      const [top, bottom] = splitChunk({
        id: 'chunk_0_0_0_4_1',
        rect: { sheetId: 0, r0: 0, c0: 0, r1: 4, c1: 1 }
      });
      expect(top.rect).toEqual({ sheetId: 0, r0: 0, c0: 0, r1: 2, c1: 1 });
      expect(bottom.rect).toEqual({ sheetId: 0, r0: 2, c0: 0, r1: 4, c1: 1 });
    });

    it('breaks tie towards rows and handles odd dimensions and nonzero origin', () => {
      const [top, bottom] = splitChunk({
        id: 'chunk_3_10_20_13_23',
        rect: { sheetId: 3, r0: 10, c0: 20, r1: 13, c1: 23 }
      });
      expect(top.rect).toEqual({ sheetId: 3, r0: 10, c0: 20, r1: 11, c1: 23 });
      expect(bottom.rect).toEqual({ sheetId: 3, r0: 11, c0: 20, r1: 13, c1: 23 });
    });

    it('rejects splitting 1x1 chunk with RANGE_INVALID', () => {
      expect(() =>
        splitChunk({ id: 'chunk_0_4_7_5_8', rect: { sheetId: 0, r0: 4, c0: 7, r1: 5, c1: 8 } })
      ).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    });
  });

  it('guarantees immutability, frozen outputs, and deterministic IDs', () => {
    const inputRect = { sheetId: 0, r0: 2, c0: 3, r1: 6, c1: 7 };
    const rectCopy = { ...inputRect };
    const chunks = planChunks(inputRect, 5);

    expect(inputRect).toEqual(rectCopy);
    expect(Object.isFrozen(chunks)).toBe(true);
    expect(Object.isFrozen(chunks[0])).toBe(true);
    expect(Object.isFrozen(chunks[0]!.rect)).toBe(true);

    const [c1, c2] = splitChunk(chunks[0]!);
    expect(c1.id).toBe(createChunkId(c1.rect));
    expect(c2.id).toBe(createChunkId(c2.rect));
    expect(c1.id).not.toBe(chunks[0]!.id);
    expect(c2.id).not.toBe(chunks[0]!.id);
    expect(c1.id).not.toBe(c2.id);
  });

  it('verifies independent seeded cases cover all cells exactly once with no outside coords', () => {
    const seeds = [
      0.12, 0.45, 0.78, 0.23, 0.89, 0.34, 0.67, 0.01, 0.55, 0.92,
      0.15, 0.73, 0.38, 0.62, 0.81, 0.29, 0.44, 0.95, 0.08, 0.51
    ];
    const rng = createDeterministicRandom(seeds);

    for (let test = 0; test < 4; test++) {
      const r0 = Math.floor(rng.next() * 10);
      const c0 = Math.floor(rng.next() * 10);
      const height = 1 + Math.floor(rng.next() * 15);
      const width = 1 + Math.floor(rng.next() * 15);
      const budget = 1 + Math.floor(rng.next() * 20);

      const rect = { sheetId: test, r0, c0, r1: r0 + height, c1: c0 + width };
      const expected = new Set<string>();
      for (let r = rect.r0; r < rect.r1; r++) {
        for (let c = rect.c0; c < rect.c1; c++) {
          expected.add(`${r},${c}`);
        }
      }

      const chunks = planChunks(rect, budget);
      const seen = new Set<string>();

      for (const chunk of chunks) {
        const area = (chunk.rect.r1 - chunk.rect.r0) * (chunk.rect.c1 - chunk.rect.c0);
        expect(area).toBeGreaterThan(0);
        expect(area).toBeLessThanOrEqual(budget);

        for (let r = chunk.rect.r0; r < chunk.rect.r1; r++) {
          for (let c = chunk.rect.c0; c < chunk.rect.c1; c++) {
            const key = `${r},${c}`;
            expect(expected.has(key)).toBe(true);
            expect(seen.has(key)).toBe(false);
            seen.add(key);
          }
        }
      }

      expect(seen.size).toBe(expected.size);
    }
  });
});
