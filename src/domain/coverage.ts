/**
 * T14b Exact 2D Partition Coverage Ledger
 *
 * Tracks exact 2D partition coverage over requested ExportScopes without
 * relying on loose area sums or arbitrary caller tilings.
 *
 * Invariants & Guarantees:
 * 1. Exact partition by construction: initial leaf chunks produced by reviewed planChunks;
 *    splits performed by reviewed deterministic splitChunk.
 * 2. Active leaves and split ancestry are stored strictly separately.
 * 3. Complete duplicates on a valid completed leaf are idempotent with no double counting.
 * 4. Unknown IDs and stale split parents reject statically with DomainError('RANGE_INVALID') (no raw IDs in error).
 * 5. A failed active leaf can complete after retry, clearing its failed status.
 * 6. Cannot split or fail an already completed leaf.
 * 7. Splitting a pending or failed leaf replaces the parent with returned children in-place,
 *    clears any active failure, records split parent, and never counts parent as completed.
 *    Splitting 1x1 throws RANGE_INVALID without corrupting ledger state.
 * 8. Deterministic leaf ordering: children replace parent in order. No arbitrary child injection.
 * 9. Blank chunks complete identically to nonempty chunks; ledger tracks coordinates/IDs only.
 * 10. Immutability: leaves and snapshot return safe, frozen copies; caller mutations cannot alter internal state.
 */

import type { CoverageSnapshot, ExportScope } from '../contracts/domain.ts';
import { DomainError } from '../contracts/errors.ts';
import { planChunks, splitChunk, type PlannedChunk } from './chunks.ts';

export class CoverageLedger {
  private readonly _leaves: PlannedChunk[];
  private readonly _leafMap: Map<string, PlannedChunk>;
  private readonly _completedChunkIds: Set<string>;
  private readonly _failedChunkIds: Set<string>;
  private readonly _splitChunkIds: Set<string>;

  constructor(scopes: readonly ExportScope[], maxPositions?: number) {
    if (!Array.isArray(scopes)) {
      throw new DomainError('RANGE_INVALID');
    }
    if (scopes.length === 0) {
      throw new DomainError('RANGE_EMPTY');
    }

    const seenSheetIds = new Set<number>();
    const initialLeaves: PlannedChunk[] = [];
    const leafMap = new Map<string, PlannedChunk>();

    for (const scope of scopes) {
      if (!scope || typeof scope !== 'object') {
        throw new DomainError('RANGE_INVALID');
      }
      const { sheetId, rect } = scope;
      if (typeof sheetId !== 'number' || !Number.isSafeInteger(sheetId) || sheetId < 0) {
        throw new DomainError('RANGE_INVALID');
      }
      if (seenSheetIds.has(sheetId)) {
        throw new DomainError('RANGE_INVALID');
      }
      seenSheetIds.add(sheetId);

      if (!rect || typeof rect !== 'object' || rect.sheetId !== sheetId) {
        throw new DomainError('RANGE_INVALID');
      }

      // planChunks validates rect and maxPositions, throwing RANGE_INVALID or RANGE_EMPTY
      const chunks = planChunks(rect, maxPositions);
      for (const chunk of chunks) {
        initialLeaves.push(chunk);
        leafMap.set(chunk.id, chunk);
      }
    }

    this._leaves = initialLeaves;
    this._leafMap = leafMap;
    this._completedChunkIds = new Set<string>();
    this._failedChunkIds = new Set<string>();
    this._splitChunkIds = new Set<string>();
  }

  get leaves(): readonly PlannedChunk[] {
    return Object.freeze([...this._leaves]);
  }

  getLeaves(): readonly PlannedChunk[] {
    return this.leaves;
  }

  complete(chunkId: string): void {
    if (typeof chunkId !== 'string') {
      throw new DomainError('RANGE_INVALID');
    }
    if (this._splitChunkIds.has(chunkId)) {
      throw new DomainError('RANGE_INVALID');
    }
    if (!this._leafMap.has(chunkId)) {
      throw new DomainError('RANGE_INVALID');
    }
    if (this._completedChunkIds.has(chunkId)) {
      return;
    }
    this._failedChunkIds.delete(chunkId);
    this._completedChunkIds.add(chunkId);
  }

  fail(chunkId: string): void {
    if (typeof chunkId !== 'string') {
      throw new DomainError('RANGE_INVALID');
    }
    if (this._splitChunkIds.has(chunkId)) {
      throw new DomainError('RANGE_INVALID');
    }
    if (!this._leafMap.has(chunkId)) {
      throw new DomainError('RANGE_INVALID');
    }
    if (this._completedChunkIds.has(chunkId)) {
      throw new DomainError('RANGE_INVALID');
    }
    this._failedChunkIds.add(chunkId);
  }

  split(chunkId: string): readonly [PlannedChunk, PlannedChunk] {
    if (typeof chunkId !== 'string') {
      throw new DomainError('RANGE_INVALID');
    }
    if (this._splitChunkIds.has(chunkId)) {
      throw new DomainError('RANGE_INVALID');
    }
    const parent = this._leafMap.get(chunkId);
    if (!parent) {
      throw new DomainError('RANGE_INVALID');
    }
    if (this._completedChunkIds.has(chunkId)) {
      throw new DomainError('RANGE_INVALID');
    }

    // Call splitChunk before mutating state; 1x1 throws RANGE_INVALID without corrupting ledger
    const children = splitChunk(parent);

    const index = this._leaves.findIndex((c) => c.id === chunkId);
    if (index === -1) {
      throw new DomainError('RANGE_INVALID');
    }

    this._leaves.splice(index, 1, children[0], children[1]);
    this._leafMap.delete(chunkId);
    this._leafMap.set(children[0].id, children[0]);
    this._leafMap.set(children[1].id, children[1]);

    this._failedChunkIds.delete(chunkId);
    this._splitChunkIds.add(chunkId);

    return children;
  }

  snapshot(): CoverageSnapshot {
    const isScopeComplete =
      this._leaves.length > 0 &&
      this._completedChunkIds.size === this._leaves.length &&
      this._failedChunkIds.size === 0;

    return Object.freeze({
      plannedLeafCount: this._leaves.length,
      completedChunkIds: Object.freeze(Array.from(this._completedChunkIds)),
      failedChunkIds: Object.freeze(Array.from(this._failedChunkIds)),
      splitChunkIds: Object.freeze(Array.from(this._splitChunkIds)),
      isScopeComplete
    });
  }
}

export function createCoverageLedger(
  scopes: readonly ExportScope[],
  maxPositions?: number
): CoverageLedger {
  return new CoverageLedger(scopes, maxPositions);
}
