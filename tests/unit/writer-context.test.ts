import { describe, it, expect, vi } from 'vitest';
import type { ExportScope, SheetMeta } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import { snapshotWriterContext, PROVISIONAL_MAX_SHEETS } from '../../src/export/context.ts';

function makeValidContext(): { context: WriterContext; scope1: ExportScope; scope2: ExportScope; meta1: SheetMeta; meta2: SheetMeta } {
  const scope1: ExportScope = {
    sheetId: 10,
    rect: { sheetId: 10, r0: 2, c0: 3, r1: 15, c1: 20 }
  };
  const scope2: ExportScope = {
    sheetId: 30,
    rect: { sheetId: 30, r0: 5, c0: 10, r1: 30, c1: 50 }
  };
  const meta1: SheetMeta = {
    id: 10,
    title: 'Sheet 1 📑 Unicode',
    index: 0,
    type: 'GRID',
    hidden: false,
    rows: 50,
    columns: 25
  };
  const meta2: SheetMeta = {
    id: 30,
    title: '日本語 ワークシート 3',
    index: 3,
    type: 'GRID',
    hidden: false,
    rows: 100,
    columns: 80
  };

  const context: WriterContext = {
    sourceId: 'src-123',
    title: 'Unicode 📊 Workbook',
    locale: 'ja-JP',
    timeZone: 'Asia/Tokyo',
    scopes: [scope1, scope2],
    mode: 'raw',
    format: 'json',
    visibility: 'include_all',
    limitsVersion: '1.0',
    sheetOrder: [10, 30],
    sheets: [meta1, meta2]
  };

  return { context, scope1, scope2, meta1, meta2 };
}

describe('T24c1a snapshotWriterContext', () => {
  const signal = new AbortController().signal;
  const validOpts = { maxSheets: PROVISIONAL_MAX_SHEETS, signal };

  it('snapshots independent valid two selected sheets with indices 0,3, nonzero scopes, and Unicode titles', () => {
    const { context } = makeValidContext();
    const snapshot = snapshotWriterContext(context, validOpts);

    expect(snapshot.sourceId).toBe('src-123');
    expect(snapshot.title).toBe('Unicode 📊 Workbook');
    expect(snapshot.locale).toBe('ja-JP');
    expect(snapshot.timeZone).toBe('Asia/Tokyo');
    expect(snapshot.mode).toBe('raw');
    expect(snapshot.format).toBe('json');
    expect(snapshot.visibility).toBe('include_all');
    expect(snapshot.limitsVersion).toBe('1.0');
    expect(snapshot.sheetOrder).toEqual([10, 30]);

    expect(snapshot.scopes).toHaveLength(2);
    expect(snapshot.scopes[0]).toEqual({
      sheetId: 10,
      rect: { sheetId: 10, r0: 2, c0: 3, r1: 15, c1: 20 }
    });
    expect(snapshot.scopes[1]).toEqual({
      sheetId: 30,
      rect: { sheetId: 30, r0: 5, c0: 10, r1: 30, c1: 50 }
    });

    expect(snapshot.sheets).toHaveLength(2);
    expect(snapshot.sheets[0]).toEqual({
      id: 10,
      title: 'Sheet 1 📑 Unicode',
      index: 0,
      type: 'GRID',
      hidden: false,
      rows: 50,
      columns: 25
    });
    expect(snapshot.sheets[1]).toEqual({
      id: 30,
      title: '日本語 ワークシート 3',
      index: 3,
      type: 'GRID',
      hidden: false,
      rows: 100,
      columns: 80
    });
  });

  it('guarantees deep frozen clone isolation after caller input mutation', () => {
    const { context } = makeValidContext();
    const snapshot = snapshotWriterContext(context, validOpts);

    // Snapshot tree must be deeply frozen
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.scopes)).toBe(true);
    expect(Object.isFrozen(snapshot.scopes[0])).toBe(true);
    expect(Object.isFrozen(snapshot.scopes[0].rect)).toBe(true);
    expect(Object.isFrozen(snapshot.scopes[1])).toBe(true);
    expect(Object.isFrozen(snapshot.scopes[1].rect)).toBe(true);
    expect(Object.isFrozen(snapshot.sheetOrder)).toBe(true);
    expect(Object.isFrozen(snapshot.sheets)).toBe(true);
    expect(Object.isFrozen(snapshot.sheets[0])).toBe(true);
    expect(Object.isFrozen(snapshot.sheets[1])).toBe(true);

    // Input objects must remain unfrozen
    expect(Object.isFrozen(context)).toBe(false);
    expect(Object.isFrozen(context.scopes)).toBe(false);
    expect(Object.isFrozen(context.scopes[0])).toBe(false);
    expect(Object.isFrozen(context.scopes[0].rect)).toBe(false);
    expect(Object.isFrozen(context.sheets[0])).toBe(false);

    // Deep clones are not identical references
    expect(snapshot.scopes).not.toBe(context.scopes);
    expect(snapshot.scopes[0]).not.toBe(context.scopes[0]);
    expect(snapshot.scopes[0].rect).not.toBe(context.scopes[0].rect);
    expect(snapshot.sheetOrder).not.toBe(context.sheetOrder);
    expect(snapshot.sheets).not.toBe(context.sheets);
    expect(snapshot.sheets[0]).not.toBe(context.sheets[0]);

    // Mutating input must not mutate snapshot
    (context as any).title = 'MUTATED TITLE';
    (context.scopes[0].rect as any).r0 = 999;
    (context.sheets[0] as any).title = 'MUTATED SHEET';
    (context.sheetOrder as any)[0] = 999;

    expect(snapshot.title).toBe('Unicode 📊 Workbook');
    expect(snapshot.scopes[0].rect.r0).toBe(2);
    expect(snapshot.sheets[0].title).toBe('Sheet 1 📑 Unicode');
    expect(snapshot.sheetOrder[0]).toBe(10);
  });

  it('rejects order alignment violations and non-ascending sheet indices', () => {
    const { context } = makeValidContext();

    // Mismatched sheetOrder vs scopes
    const swappedOrder = { ...context, sheetOrder: [30, 10] };
    expect(() => snapshotWriterContext(swappedOrder, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Mismatched array lengths
    const unevenScopes = { ...context, scopes: [context.scopes[0]] };
    expect(() => snapshotWriterContext(unevenScopes, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Non-ascending indices (index 3 then index 0)
    const descendingIndices = {
      ...context,
      sheets: [
        { ...context.sheets[0], index: 5 },
        { ...context.sheets[1], index: 2 }
      ]
    };
    expect(() => snapshotWriterContext(descendingIndices, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Equal indices
    const equalIndices = {
      ...context,
      sheets: [
        { ...context.sheets[0], index: 1 },
        { ...context.sheets[1], index: 1 }
      ]
    };
    expect(() => snapshotWriterContext(equalIndices, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('rejects duplicate or invalid sheet IDs and non-GRID sheet types', () => {
    const { context } = makeValidContext();

    // Duplicate sheet ID in sheetOrder
    const dupSheetId = {
      ...context,
      sheetOrder: [10, 10],
      scopes: [context.scopes[0], { ...context.scopes[1], sheetId: 10, rect: { ...context.scopes[1].rect, sheetId: 10 } }],
      sheets: [context.sheets[0], { ...context.sheets[1], id: 10 }]
    };
    expect(() => snapshotWriterContext(dupSheetId, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Negative sheet ID
    const negSheetId = {
      ...context,
      sheetOrder: [-1, 30],
      scopes: [{ ...context.scopes[0], sheetId: -1, rect: { ...context.scopes[0].rect, sheetId: -1 } }, context.scopes[1]],
      sheets: [{ ...context.sheets[0], id: -1 }, context.sheets[1]]
    };
    expect(() => snapshotWriterContext(negSheetId, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Non-GRID type
    const nonGridSheet = {
      ...context,
      sheets: [{ ...context.sheets[0], type: 'OBJECT' as any }, context.sheets[1]]
    };
    expect(() => snapshotWriterContext(nonGridSheet, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('rejects invalid enums and hidden sheet conflict with api_visible', () => {
    const { context } = makeValidContext();

    // Invalid mode
    expect(() => snapshotWriterContext({ ...context, mode: 'formula' as any }, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Invalid format
    expect(() => snapshotWriterContext({ ...context, format: 'tsv' as any }, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Invalid visibility
    expect(() => snapshotWriterContext({ ...context, visibility: 'all' as any }, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // hidden: true with api_visible
    const hiddenWithApiVisible = {
      ...context,
      visibility: 'api_visible' as const,
      sheets: [{ ...context.sheets[0], hidden: true }, context.sheets[1]]
    };
    expect(() => snapshotWriterContext(hiddenWithApiVisible, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // hidden: true with include_all is valid
    const hiddenWithIncludeAll = {
      ...context,
      visibility: 'include_all' as const,
      sheets: [{ ...context.sheets[0], hidden: true }, context.sheets[1]]
    };
    expect(() => snapshotWriterContext(hiddenWithIncludeAll, validOpts)).not.toThrow();
  });

  it('rejects coordinate bounds violations, negative-zero, and non-integer coords', () => {
    const { context } = makeValidContext();

    // r0 >= r1
    const invertedRows = {
      ...context,
      scopes: [{ ...context.scopes[0], rect: { ...context.scopes[0].rect, r0: 15, r1: 15 } }, context.scopes[1]]
    };
    expect(() => snapshotWriterContext(invertedRows, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // c0 >= c1
    const invertedCols = {
      ...context,
      scopes: [{ ...context.scopes[0], rect: { ...context.scopes[0].rect, c0: 20, c1: 10 } }, context.scopes[1]]
    };
    expect(() => snapshotWriterContext(invertedCols, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // r1 > meta.rows
    const rowOOB = {
      ...context,
      scopes: [{ ...context.scopes[0], rect: { ...context.scopes[0].rect, r1: 51 } }, context.scopes[1]]
    };
    expect(() => snapshotWriterContext(rowOOB, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // c1 > meta.columns
    const colOOB = {
      ...context,
      scopes: [{ ...context.scopes[0], rect: { ...context.scopes[0].rect, c1: 26 } }, context.scopes[1]]
    };
    expect(() => snapshotWriterContext(colOOB, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Negative-zero coordinate
    const negZero = {
      ...context,
      scopes: [{ ...context.scopes[0], rect: { ...context.scopes[0].rect, r0: -0 } }, context.scopes[1]]
    };
    expect(() => snapshotWriterContext(negZero, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Non-integer float coordinate
    const floatCoord = {
      ...context,
      scopes: [{ ...context.scopes[0], rect: { ...context.scopes[0].rect, r0: 2.5 } }, context.scopes[1]]
    };
    expect(() => snapshotWriterContext(floatCoord, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('rejects extra auth fields, unknown properties, and missing required fields', () => {
    const { context } = makeValidContext();

    // Extra forbidden auth properties on root context
    expect(() => snapshotWriterContext({ ...context, principalKey: 'user-1' } as any, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
    expect(() => snapshotWriterContext({ ...context, accessToken: 'token-xyz' } as any, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
    expect(() => snapshotWriterContext({ ...context, extraProp: 'unknown' } as any, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Extra property on SheetMeta
    const extraSheetProp = {
      ...context,
      sheets: [{ ...context.sheets[0], extra: true } as any, context.sheets[1]]
    };
    expect(() => snapshotWriterContext(extraSheetProp, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Extra property on Scope
    const extraScopeProp = {
      ...context,
      scopes: [{ ...context.scopes[0], extra: true } as any, context.scopes[1]]
    };
    expect(() => snapshotWriterContext(extraScopeProp, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Missing required field: empty string sourceId
    expect(() => snapshotWriterContext({ ...context, sourceId: '' }, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Empty scopes array
    expect(() => snapshotWriterContext({ ...context, scopes: [], sheetOrder: [], sheets: [] }, validOpts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('handles accessor failures statically without leaking custom error details or invoking toJSON', () => {
    const { context } = makeValidContext();

    // Throwing accessor on context yields static FORMAT_SERIALIZATION_FAILED
    const throwingContext = {
      ...context,
      get title(): string {
        throw new Error('Hostile title getter exception');
      }
    };
    expect(() => snapshotWriterContext(throwingContext, validOpts)).toThrowError(
      expect.objectContaining({
        name: 'DomainError',
        code: 'FORMAT_SERIALIZATION_FAILED'
      })
    );

    // Throwing accessor on options yields static CONFIG_INVALID
    const throwingOpts = {
      get maxSheets(): number {
        throw new Error('Hostile maxSheets getter exception');
      },
      signal
    };
    expect(() => snapshotWriterContext(context, throwingOpts)).toThrowError(
      expect.objectContaining({
        name: 'DomainError',
        code: 'CONFIG_INVALID'
      })
    );

    // Hostile DomainError from options getter is sanitized to CONFIG_INVALID
    const hostileDomainErrorOpts = {
      get maxSheets(): number {
        throw new DomainError('OPERATION_ABORTED');
      },
      signal
    };
    expect(() => snapshotWriterContext(context, hostileDomainErrorOpts)).toThrowError(
      expect.objectContaining({
        name: 'DomainError',
        code: 'CONFIG_INVALID'
      })
    );

    // toJSON must NOT be invoked on context or its child objects
    const toJSONSpy = vi.fn(() => {
      throw new Error('toJSON must never be called');
    });
    const protoWithToJSON = { toJSON: toJSONSpy };
    const contextWithToJSON = Object.create(protoWithToJSON, Object.getOwnPropertyDescriptors(context));
    Object.setPrototypeOf(contextWithToJSON.sheets[0], protoWithToJSON);
    expect(() => snapshotWriterContext(contextWithToJSON, validOpts)).not.toThrow();
    expect(toJSONSpy).not.toHaveBeenCalled();
  });

  it('captures options getters exactly once', () => {
    const { context } = makeValidContext();
    let maxSheetsReadCount = 0;
    let signalReadCount = 0;

    const singleAccessOpts = {
      get maxSheets(): number {
        maxSheetsReadCount++;
        return 10;
      },
      get signal(): AbortSignal {
        signalReadCount++;
        return signal;
      }
    };

    snapshotWriterContext(context, singleAccessOpts);
    expect(maxSheetsReadCount).toBe(1);
    expect(signalReadCount).toBe(1);
  });

  it('captures metadata values once so a changing getter cannot introduce an object into the snapshot', () => {
    const { context } = makeValidContext();
    let reads = 0;
    Object.defineProperty(context.sheets[0], 'title', {
      enumerable: true,
      get() { return ++reads === 1 ? 'Captured title' : { accessToken: 'synthetic-secret' }; }
    });
    const snapshot = snapshotWriterContext(context, validOpts);
    expect(reads).toBe(1);
    expect(snapshot.sheets[0].title).toBe('Captured title');
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-secret');
  });

  it('enforces maxSheets cap before evaluating metadata getter, and halts on pre-abort before reading context', () => {
    const { context } = makeValidContext();

    // Context with 2 scopes, but maxSheets cap set to 1.
    // sheets getter must NOT be called because selected scope count > maxSheets triggers SIZE_LIMIT_EXCEEDED first.
    let sheetsGetterCalled = false;
    const cappedContext = {
      ...context,
      get sheets(): readonly SheetMeta[] {
        sheetsGetterCalled = true;
        throw new Error('sheets getter must not be reached when scopes exceed maxSheets');
      }
    };

    expect(() => snapshotWriterContext(cappedContext, { maxSheets: 1, signal })).toThrowError(
      expect.objectContaining({
        name: 'DomainError',
        code: 'SIZE_LIMIT_EXCEEDED'
      })
    );
    expect(sheetsGetterCalled).toBe(false);

    // Pre-abort halts immediately before accessing context properties
    let sourceIdAccessed = false;
    const preabortedContext = {
      ...context,
      get sourceId(): string {
        sourceIdAccessed = true;
        throw new Error('context should not be read when pre-aborted');
      }
    };

    const preabortedSignal = AbortSignal.abort();
    expect(() => snapshotWriterContext(preabortedContext, { maxSheets: 10, signal: preabortedSignal })).toThrowError(
      expect.objectContaining({
        name: 'DomainError',
        code: 'OPERATION_ABORTED'
      })
    );
    expect(sourceIdAccessed).toBe(false);
  });
});
