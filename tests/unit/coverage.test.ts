import { describe, it, expect } from 'vitest';
import { CoverageLedger, createCoverageLedger } from '../../src/domain/coverage.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import type { ExportScope } from '../../src/contracts/domain.ts';

describe('T14b Exact Coverage Ledger', () => {
  it('initializes incomplete and tracks planned leaves', () => {
    const scopes: ExportScope[] = [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 10 } }];
    const ledger = createCoverageLedger(scopes, 50);

    const snap = ledger.snapshot();
    expect(snap.isScopeComplete).toBe(false);
    expect(snap.plannedLeafCount).toBe(2);
    expect(snap.completedChunkIds).toEqual([]);
    expect(snap.failedChunkIds).toEqual([]);
    expect(snap.splitChunkIds).toEqual([]);
    expect(ledger.leaves).toHaveLength(2);
  });

  it('completes fully across all leaves including blank regions', () => {
    const scopes: ExportScope[] = [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 4, c1: 4 } }];
    const ledger = new CoverageLedger(scopes, 8); // 2 chunks: [0..2, 0..4) and [2..4, 0..4)
    const leaves = ledger.leaves;

    ledger.complete(leaves[0]!.id);
    expect(ledger.snapshot().isScopeComplete).toBe(false);

    // Completes second chunk (representing blank sheet cells without cell payload)
    ledger.complete(leaves[1]!.id);
    const snap = ledger.snapshot();
    expect(snap.isScopeComplete).toBe(true);
    expect(snap.completedChunkIds).toEqual([leaves[0]!.id, leaves[1]!.id]);
  });

  it('handles duplicate completion idempotently without double counting', () => {
    const scopes: ExportScope[] = [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 2, c1: 2 } }];
    const ledger = new CoverageLedger(scopes, 10);
    const id = ledger.leaves[0]!.id;

    ledger.complete(id);
    const count1 = ledger.snapshot().completedChunkIds.length;
    ledger.complete(id);
    const snap = ledger.snapshot();
    expect(snap.completedChunkIds.length).toBe(count1);
    expect(snap.completedChunkIds).toEqual([id]);
  });

  it('rejects unknown IDs and stale split parents statically without leaking raw IDs', () => {
    const scopes: ExportScope[] = [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 4, c1: 4 } }];
    const ledger = new CoverageLedger(scopes, 100);
    const parentId = ledger.leaves[0]!.id;

    // Unknown ID
    expect(() => ledger.complete('secret_unknown_id_12345')).toThrowError(
      expect.objectContaining({ code: 'RANGE_INVALID' })
    );
    try {
      ledger.fail('raw_private_chunk_xyz');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as Error).message).not.toContain('raw_private_chunk_xyz');
    }

    // Split parent and verify stale parent rejection
    ledger.split(parentId);
    expect(() => ledger.complete(parentId)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => ledger.fail(parentId)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => ledger.split(parentId)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
  });

  it('clears failed status on successful retry complete', () => {
    const scopes: ExportScope[] = [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 2, c1: 2 } }];
    const ledger = new CoverageLedger(scopes, 10);
    const id = ledger.leaves[0]!.id;

    ledger.fail(id);
    let snap = ledger.snapshot();
    expect(snap.failedChunkIds).toEqual([id]);
    expect(snap.isScopeComplete).toBe(false);

    ledger.complete(id);
    snap = ledger.snapshot();
    expect(snap.failedChunkIds).toEqual([]);
    expect(snap.completedChunkIds).toEqual([id]);
    expect(snap.isScopeComplete).toBe(true);
  });

  it('tracks nested splits, partial progress, and all-children completion', () => {
    const scopes: ExportScope[] = [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 4, c1: 4 } }];
    const ledger = new CoverageLedger(scopes, 100);
    const rootId = ledger.leaves[0]!.id;

    const [child1, child2] = ledger.split(rootId);
    expect(ledger.snapshot().plannedLeafCount).toBe(2);
    expect(ledger.snapshot().isScopeComplete).toBe(false);

    const [grandchild1, grandchild2] = ledger.split(child1.id);
    expect(ledger.snapshot().plannedLeafCount).toBe(3);
    expect(ledger.snapshot().splitChunkIds).toEqual([rootId, child1.id]);

    ledger.complete(grandchild1.id);
    expect(ledger.snapshot().isScopeComplete).toBe(false);

    ledger.complete(grandchild2.id);
    expect(ledger.snapshot().isScopeComplete).toBe(false);

    ledger.complete(child2.id);
    const snap = ledger.snapshot();
    expect(snap.isScopeComplete).toBe(true);
    expect(snap.completedChunkIds).toEqual([grandchild1.id, grandchild2.id, child2.id]);
  });

  it('removes obsolete failure when failed leaf is split', () => {
    const scopes: ExportScope[] = [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 4, c1: 4 } }];
    const ledger = new CoverageLedger(scopes, 100);
    const id = ledger.leaves[0]!.id;

    ledger.fail(id);
    expect(ledger.snapshot().failedChunkIds).toEqual([id]);

    const [c1, c2] = ledger.split(id);
    const snap = ledger.snapshot();
    expect(snap.failedChunkIds).toEqual([]);
    expect(snap.splitChunkIds).toEqual([id]);
    expect(ledger.leaves.map((l) => l.id)).toEqual([c1.id, c2.id]);
  });

  it('rejects splitting or failing an already completed leaf', () => {
    const scopes: ExportScope[] = [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 2, c1: 2 } }];
    const ledger = new CoverageLedger(scopes, 10);
    const id = ledger.leaves[0]!.id;

    ledger.complete(id);
    expect(() => ledger.split(id)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => ledger.fail(id)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(ledger.snapshot().completedChunkIds).toEqual([id]);
  });

  it('leaves state unchanged when attempting to split a 1x1 singleton leaf', () => {
    const scopes: ExportScope[] = [{ sheetId: 0, rect: { sheetId: 0, r0: 5, c0: 5, r1: 6, c1: 6 } }];
    const ledger = new CoverageLedger(scopes, 10);
    const id = ledger.leaves[0]!.id;

    expect(() => ledger.split(id)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));
    const snap = ledger.snapshot();
    expect(snap.plannedLeafCount).toBe(1);
    expect(snap.splitChunkIds).toEqual([]);
    expect(ledger.leaves[0]!.id).toBe(id);
  });

  it('handles multiple tabs, nonzero scopes, A1, Z90000, and rejects duplicate tabs / zero scopes', () => {
    expect(() => new CoverageLedger([])).toThrowError(expect.objectContaining({ code: 'RANGE_EMPTY' }));

    const dupScopes: ExportScope[] = [
      { sheetId: 1, rect: { sheetId: 1, r0: 0, c0: 0, r1: 2, c1: 2 } },
      { sheetId: 1, rect: { sheetId: 1, r0: 2, c0: 2, r1: 4, c1: 4 } }
    ];
    expect(() => new CoverageLedger(dupScopes)).toThrowError(expect.objectContaining({ code: 'RANGE_INVALID' }));

    const validScopes: ExportScope[] = [
      { sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 1, c1: 1 } }, // A1
      { sheetId: 1, rect: { sheetId: 1, r0: 10, c0: 20, r1: 15, c1: 25 } },
      { sheetId: 2, rect: { sheetId: 2, r0: 89999, c0: 25, r1: 90000, c1: 26 } } // Z90000
    ];
    const ledger = new CoverageLedger(validScopes, 100);
    expect(ledger.leaves).toHaveLength(3);
    expect(ledger.snapshot().plannedLeafCount).toBe(3);
  });

  it('isolates caller input and returned snapshot from mutations', () => {
    const scopes: ExportScope[] = [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 2, c1: 2 } }];
    const ledger = new CoverageLedger(scopes, 10);

    // Caller mutates array
    scopes.push({ sheetId: 1, rect: { sheetId: 1, r0: 0, c0: 0, r1: 1, c1: 1 } });
    expect(ledger.leaves).toHaveLength(1);

    // Leaves and snapshot immutability
    expect(() => (ledger.leaves as unknown as unknown[]).push(null)).toThrow();
    const snap = ledger.snapshot();
    expect(() => (snap.completedChunkIds as unknown as unknown[]).push('tamper')).toThrow();

    // Independent instances
    const ledger2 = new CoverageLedger([{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 2, c1: 2 } }], 10);
    ledger.complete(ledger.leaves[0]!.id);
    expect(ledger.snapshot().isScopeComplete).toBe(true);
    expect(ledger2.snapshot().isScopeComplete).toBe(false);
  });

  it('confirms exact coordinate partition via independent cell enumeration after nested splits', () => {
    const rect = { sheetId: 5, r0: 2, c0: 3, r1: 6, c1: 8 }; // height 4, width 5 -> 20 cells
    const ledger = new CoverageLedger([{ sheetId: 5, rect }], 100);

    // Perform nested splits
    const [c1, c2] = ledger.split(ledger.leaves[0]!.id);
    const [gc1, gc2] = ledger.split(c1.id);
    ledger.split(c2.id);
    ledger.split(gc1.id);
    ledger.split(gc2.id);

    // Independent oracle: collect every cell (r, c) from all active leaves
    const visited = new Set<string>();
    let totalCells = 0;

    for (const leaf of ledger.leaves) {
      expect(leaf.rect.sheetId).toBe(5);
      expect(leaf.rect.r0).toBeGreaterThanOrEqual(rect.r0);
      expect(leaf.rect.r1).toBeLessThanOrEqual(rect.r1);
      expect(leaf.rect.c0).toBeGreaterThanOrEqual(rect.c0);
      expect(leaf.rect.c1).toBeLessThanOrEqual(rect.c1);

      for (let r = leaf.rect.r0; r < leaf.rect.r1; r++) {
        for (let c = leaf.rect.c0; c < leaf.rect.c1; c++) {
          const key = `${r}:${c}`;
          expect(visited.has(key)).toBe(false); // No overlap
          visited.add(key);
          totalCells++;
        }
      }
    }

    // Must match requested rectangle exactly
    const expectedCount = (rect.r1 - rect.r0) * (rect.c1 - rect.c0);
    expect(totalCells).toBe(expectedCount);
    expect(visited.size).toBe(expectedCount);

    for (let r = rect.r0; r < rect.r1; r++) {
      for (let c = rect.c0; c < rect.c1; c++) {
        expect(visited.has(`${r}:${c}`)).toBe(true);
      }
    }
  });
});
