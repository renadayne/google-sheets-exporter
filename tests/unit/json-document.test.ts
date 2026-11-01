import { describe, it, expect } from 'vitest';
import type {
  Cell, ExportReport, ExportMode, VisibilityMode, NormalizedChunk, ExcludedIntervals
} from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { isJsonExportDocument } from '../../src/contracts/validation.ts';
import { buildJsonExportDocument, PROVISIONAL_MAX_WARNINGS } from '../../src/export/json-document.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import { encodeFrozenJson } from '../../src/export/json-encoding.ts';
import { MAX_JSON_BYTES } from '../../src/export/json-string-bytes.ts';
import { PROVISIONAL_MAX_CHUNKS } from '../../src/export/coverage.ts';
import { PROVISIONAL_MAX_INTERVALS } from '../../src/export/exclusions.ts';
import { PROVISIONAL_MAX_CELLS } from '../../src/export/cells.ts';

function makeChunk(
  sheetId: number,
  rect: [number, number, number, number],
  cells: Cell[],
  excl: ExcludedIntervals = { rows: [], columns: [] },
  id = 'c1'
): NormalizedChunk {
  return {
    jobId: 'j1',
    chunkId: `${id}_${sheetId}`,
    rect: { sheetId, r0: rect[0], c0: rect[1], r1: rect[2], c1: rect[3] },
    cells,
    excludedIntervals: excl,
    byteCount: 64
  };
}

function makeFixture(
  mode: ExportMode = 'raw',
  visibility: VisibilityMode = 'include_all',
  customCells?: Cell[],
  customExclusions?: ExcludedIntervals
) {
  const meta1 = { id: 10, title: 'Data', index: 0, type: 'GRID', hidden: false, rows: 20, columns: 10 };
  const meta2 = { id: 20, title: 'Empty', index: 1, type: 'GRID', hidden: false, rows: 20, columns: 10 };
  const scope1 = { sheetId: 10, rect: { sheetId: 10, r0: 2, c0: 1, r1: 10, c1: 5 } };
  const scope2 = { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 5, c1: 5 } };
  const ctx: WriterContext = {
    sourceId: 'src_1',
    title: 'Workbook',
    locale: 'en_US',
    timeZone: 'UTC',
    scopes: [scope1, scope2],
    mode,
    format: 'json',
    visibility,
    limitsVersion: '1.0',
    sheetOrder: [10, 20],
    sheets: [meta1, meta2]
  };

  const repExclusions = customExclusions && (customExclusions.rows.length > 0 || customExclusions.columns.length > 0)
    ? [{ sheetId: 10, excludedRows: customExclusions.rows, excludedColumns: customExclusions.columns }]
    : [];

  const rep: ExportReport = {
    schemaVersion: '1.0',
    source: { id: 'src_1', title: 'Workbook', locale: 'en_US', timeZone: 'UTC' },
    export: {
      startedAt: '2026-10-30T00:00:00.000Z',
      producedAt: '2026-10-30T00:00:02.000Z',
      mode,
      format: 'json',
      visibility,
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: []
    },
    selectedScopes: [scope1, scope2],
    sheetOrder: [10, 20],
    limitsVersion: '1.0',
    nameMappings: [
      { sheetId: 10, originalTitle: 'Data', exportedName: 'Data' },
      { sheetId: 20, originalTitle: 'Empty', exportedName: 'Empty' }
    ],
    exclusions: repExclusions
  };

  const defaultCells: Cell[] = mode === 'formatted'
    ? [
        { r: 2, c: 1, kind: 'string', value: '00123' },
        { r: 3, c: 2, kind: 'string', value: '$100.00' }
      ]
    : mode === 'formula_text'
    ? [
        { r: 2, c: 1, kind: 'string', value: '=SUM(A1:A5)', formulaText: '=SUM(A1:A5)' },
        { r: 3, c: 2, kind: 'string', value: '00123' }
      ]
    : [
        { r: 2, c: 1, kind: 'string', value: '00123' },
        { r: 3, c: 2, kind: 'number', value: 42 },
        { r: 4, c: 3, kind: 'boolean', value: true },
        { r: 5, c: 4, kind: 'error', value: { code: '#N/A', message: 'Not available' } }
      ];

  const cells = customCells ?? defaultCells;
  const excl = customExclusions ?? { rows: [], columns: [] };

  const chunk1 = makeChunk(10, [2, 1, 10, 5], cells, excl, 'ch1');
  const chunk2 = makeChunk(20, [0, 0, 5, 5], [], { rows: [], columns: [] }, 'ch2');

  const prepOpts = {
    maxChunks: PROVISIONAL_MAX_CHUNKS,
    maxIntervals: PROVISIONAL_MAX_INTERVALS,
    maxCells: PROVISIONAL_MAX_CELLS,
    signal: new AbortController().signal
  };

  const prep = prepareWriterData(ctx, [chunk1, chunk2], prepOpts);
  return { ctx, rep, prep };
}

describe('T24b2 buildJsonExportDocument', () => {
  const signal = new AbortController().signal;
  const opts = { maxWarnings: PROVISIONAL_MAX_WARNINGS, signal };

  it('successful raw roundtrip: JSON stringify/parse independent assertions, types, leading-zero string00123, source metadata/timezone, scope/order/emptytab', () => {
    const { ctx, rep, prep } = makeFixture('raw');
    const doc = buildJsonExportDocument(ctx, prep, rep, opts);

    expect(isJsonExportDocument(doc)).toBe(true);
    const jsonStr = JSON.stringify(doc);
    const bytes = encodeFrozenJson(doc, { maxBytes: MAX_JSON_BYTES, signal });
    expect(new TextDecoder().decode(bytes)).toBe(jsonStr);
    const parsed = JSON.parse(jsonStr);

    const expectedIndependent = {
      schemaVersion: '1.0',
      source: {
        id: 'src_1',
        title: 'Workbook',
        locale: 'en_US',
        timeZone: 'UTC'
      },
      export: {
        startedAt: '2026-10-30T00:00:00.000Z',
        producedAt: '2026-10-30T00:00:02.000Z',
        mode: 'raw',
        format: 'json',
        visibility: 'include_all',
        complete: true,
        consistency: 'not_atomic_no_change_detected',
        warnings: []
      },
      selectedScopes: [
        { sheetId: 10, rect: { sheetId: 10, r0: 2, c0: 1, r1: 10, c1: 5 } },
        { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 5, c1: 5 } }
      ],
      sheetOrder: [10, 20],
      limitsVersion: '1.0',
      nameMappings: [
        { sheetId: 10, originalTitle: 'Data', exportedName: 'Data' },
        { sheetId: 20, originalTitle: 'Empty', exportedName: 'Empty' }
      ],
      exclusions: [],
      sheets: [
        {
          id: 10,
          title: 'Data',
          index: 0,
          scope: { sheetId: 10, r0: 2, c0: 1, r1: 10, c1: 5 },
          visibility: { mode: 'include_all', excludedRows: [], excludedColumns: [] },
          cells: [
            { r: 2, c: 1, kind: 'string', value: '00123' },
            { r: 3, c: 2, kind: 'number', value: 42 },
            { r: 4, c: 3, kind: 'boolean', value: true },
            { r: 5, c: 4, kind: 'error', value: { code: '#N/A', message: 'Not available' } }
          ]
        },
        {
          id: 20,
          title: 'Empty',
          index: 1,
          scope: { sheetId: 20, r0: 0, c0: 0, r1: 5, c1: 5 },
          visibility: { mode: 'include_all', excludedRows: [], excludedColumns: [] },
          cells: []
        }
      ]
    };

    expect(parsed).toEqual(expectedIndependent);
    // Explicit independent type and value verifications
    expect(typeof parsed.sheets[0].cells[0].value).toBe('string');
    expect(parsed.sheets[0].cells[0].value).toBe('00123');
    expect(typeof parsed.sheets[0].cells[1].value).toBe('number');
    expect(parsed.sheets[0].cells[1].value).toBe(42);
    expect(typeof parsed.sheets[0].cells[2].value).toBe('boolean');
    expect(parsed.sheets[0].cells[2].value).toBe(true);
    expect(parsed.sheets[0].cells[3].kind).toBe('error');
    expect(parsed.sheets[0].cells[3].value).toEqual({ code: '#N/A', message: 'Not available' });
    expect(parsed.sheets[1].cells).toEqual([]);
    expect(parsed.source.timeZone).toBe('UTC');
    expect(parsed.source.locale).toBe('en_US');
    expect(parsed.sheetOrder).toEqual([10, 20]);
  });

  it('successful formatted roundtrip: JSON stringify/parse independent assertions and leading-zero string00123', () => {
    const { ctx, rep, prep } = makeFixture('formatted');
    const doc = buildJsonExportDocument(ctx, prep, rep, opts);

    expect(isJsonExportDocument(doc)).toBe(true);
    const parsed = JSON.parse(JSON.stringify(doc));
    expect(parsed.export.mode).toBe('formatted');
    expect(parsed.sheets[0].cells).toEqual([
      { r: 2, c: 1, kind: 'string', value: '00123' },
      { r: 3, c: 2, kind: 'string', value: '$100.00' }
    ]);
    expect(parsed.sheets[0].cells[0].value).toBe('00123');
    expect(parsed.sheets[1].cells).toEqual([]);
  });

  it('successful formula_text roundtrip: JSON stringify/parse independent assertions and formulaText', () => {
    const { ctx, rep, prep } = makeFixture('formula_text');
    const doc = buildJsonExportDocument(ctx, prep, rep, opts);

    expect(isJsonExportDocument(doc)).toBe(true);
    const parsed = JSON.parse(JSON.stringify(doc));
    expect(parsed.export.mode).toBe('formula_text');
    expect(parsed.sheets[0].cells).toEqual([
      { r: 2, c: 1, kind: 'string', value: '=SUM(A1:A5)', formulaText: '=SUM(A1:A5)' },
      { r: 3, c: 2, kind: 'string', value: '00123' }
    ]);
    expect(parsed.sheets[0].cells[1].value).toBe('00123');
    expect(parsed.sheets[1].cells).toEqual([]);
  });

  it('accepts property-reordered equivalent rect', () => {
    const { ctx, rep, prep } = makeFixture();
    const reordered = { r0: 2, c0: 1, sheetId: 10, r1: 10, c1: 5 } as any;
    const repReordered = { ...rep, selectedScopes: [{ sheetId: 10, rect: reordered }, rep.selectedScopes[1]] };
    const doc = buildJsonExportDocument(ctx, prep, repReordered, opts);
    expect(doc.selectedScopes[0].rect).toEqual({ sheetId: 10, r0: 2, c0: 1, r1: 10, c1: 5 });
  });

  it('deeply freezes output cells and nested error data, and input post-call changes do not mutate output', () => {
    const { ctx, rep, prep } = makeFixture('raw');
    const doc = buildJsonExportDocument(ctx, prep, rep, opts);

    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.sheets)).toBe(true);
    expect(Object.isFrozen(doc.sheets[0])).toBe(true);
    expect(Object.isFrozen(doc.sheets[0].cells)).toBe(true);
    expect(Object.isFrozen(doc.sheets[0].visibility)).toBe(true);
    expect(Object.isFrozen(doc.sheets[0].visibility.excludedRows)).toBe(true);
    expect(Object.isFrozen(doc.sheets[0].visibility.excludedColumns)).toBe(true);

    for (const cell of doc.sheets[0].cells) {
      expect(Object.isFrozen(cell)).toBe(true);
      if (cell.kind === 'error') {
        expect(Object.isFrozen(cell.value)).toBe(true);
      }
    }

    // Mutate inputs after call
    (ctx as any).title = 'MutatedTitle';
    (ctx.sheetOrder as any)[0] = 999;
    (rep.source as any).title = 'MutatedReportTitle';
    (rep.sheetOrder as any)[0] = 999;
    (rep.export.warnings as any).push({ code: 'W99', message: 'late warning' });

    expect(doc.source.title).toBe('Workbook');
    expect(doc.sheetOrder).toEqual([10, 20]);
    expect(doc.export.warnings).toHaveLength(0);
  });

  it('simultaneous-order-mutation regression: rejects when context.sheetOrder and report.sheetOrder are reversed but sheets remain unchanged', () => {
    const { ctx, rep, prep } = makeFixture();
    const badCtx = { ...ctx, sheetOrder: [20, 10] };
    const badRep = { ...rep, sheetOrder: [20, 10] };
    expect(() => buildJsonExportDocument(badCtx, prep, badRep, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('extra-context-scope regression: rejects when context.scopes has extra scope not matching sheets length', () => {
    const { ctx, rep, prep } = makeFixture();
    const extraScope = { sheetId: 30, rect: { sheetId: 30, r0: 0, c0: 0, r1: 5, c1: 5 } };
    const badCtx = { ...ctx, scopes: [...ctx.scopes, extraScope] };
    expect(() => buildJsonExportDocument(badCtx, prep, rep, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('rejects empty context sheets / scopes / sheetOrder / prepared', () => {
    const { ctx, rep } = makeFixture();
    const emptyCtx = { ...ctx, sheets: [], scopes: [], sheetOrder: [] };
    const emptyRep = { ...rep, selectedScopes: [], sheetOrder: [], nameMappings: [] };
    expect(() => buildJsonExportDocument(emptyCtx, [], emptyRep, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('rejects selected-scope mismatch, duplicate mapping, and source ID/locale/limits mismatches', () => {
    const { ctx, rep, prep } = makeFixture();

    // Selected-scope mismatch
    const badScopeRect = {
      ...rep,
      selectedScopes: [
        { sheetId: 10, rect: { sheetId: 10, r0: 99, c0: 1, r1: 10, c1: 5 } },
        rep.selectedScopes[1]
      ]
    };
    expect(() => buildJsonExportDocument(ctx, prep, badScopeRect, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Duplicate mapping
    const dupMapping = {
      ...rep,
      nameMappings: [
        { sheetId: 10, originalTitle: 'Data', exportedName: 'Data' },
        { sheetId: 10, originalTitle: 'Data', exportedName: 'Data' }
      ]
    };
    expect(() => buildJsonExportDocument(ctx, prep, dupMapping, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Source ID mismatch
    const badSourceId = { ...rep, source: { ...rep.source, id: 'wrong_id' } };
    expect(() => buildJsonExportDocument(ctx, prep, badSourceId, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Locale mismatch
    const badLocale = { ...rep, source: { ...rep.source, locale: 'fr_FR' } };
    expect(() => buildJsonExportDocument(ctx, prep, badLocale, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // LimitsVersion mismatch
    const badLimits = { ...rep, limitsVersion: '2.0' };
    expect(() => buildJsonExportDocument(ctx, prep, badLimits, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Negative forged-prepared metadata test (invalid boundary case)
    const badPrep = [{ ...prep[0], metadata: { ...prep[0].metadata, id: 99 } }, prep[1]];
    expect(() => buildJsonExportDocument(ctx, badPrep, rep, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('exclusions: omitted empty accepted, omitted nonempty rejected, success via real prepareWriterData, duplicate/foreign/interval mismatch rejected', () => {
    // Exclusion success case: cell at r=2 is outside excluded rows [3, 5)
    // prepareWriterData is invoked with input cells omitting excluded row/col cells
    const successCells: Cell[] = [{ r: 2, c: 1, kind: 'string', value: '00123' }];
    const successExcl: ExcludedIntervals = { rows: [{ start: 3, end: 5 }], columns: [] };
    const { ctx: exclCtx, rep: exclRep, prep: exclPrep } = makeFixture('raw', 'api_visible', successCells, successExcl);

    const doc = buildJsonExportDocument(exclCtx, exclPrep, exclRep, opts);
    expect(doc.exclusions).toHaveLength(1);
    expect(doc.exclusions[0]).toEqual({ sheetId: 10, excludedRows: [{ start: 3, end: 5 }], excludedColumns: [] });
    expect(doc.sheets[0].visibility.excludedRows).toEqual([{ start: 3, end: 5 }]);

    // Omitted nonempty exclusion in report -> FORMAT_SERIALIZATION_FAILED
    const omittedRep: ExportReport = { ...exclRep, exclusions: [] };
    expect(() => buildJsonExportDocument(exclCtx, exclPrep, omittedRep, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Duplicate sheet in exclusions -> reject
    const dupExcl: ExportReport = { ...exclRep, exclusions: [...exclRep.exclusions, exclRep.exclusions[0]] };
    expect(() => buildJsonExportDocument(exclCtx, exclPrep, dupExcl, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Foreign sheet in exclusions -> reject
    const foreignExcl: ExportReport = { ...exclRep, exclusions: [{ sheetId: 999, excludedRows: [], excludedColumns: [] }] };
    expect(() => buildJsonExportDocument(exclCtx, exclPrep, foreignExcl, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Interval bounds mismatch -> reject
    const mismatchExcl: ExportReport = {
      ...exclRep,
      exclusions: [{ sheetId: 10, excludedRows: [{ start: 3, end: 6 }], excludedColumns: [] }]
    };
    expect(() => buildJsonExportDocument(exclCtx, exclPrep, mismatchExcl, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('modifiedTime: semantic comparison of equivalent timestamps (Z vs .000Z), genuinely different rejected, malformed rejected', () => {
    const { ctx, rep, prep } = makeFixture();

    // Equivalent timestamp accepted (same instant formatted differently)
    const equivalentRep: ExportReport = {
      ...rep,
      sourceObservations: {
        before: { observedAt: '2026-10-30T00:00:00Z', modifiedTime: '2026-10-30T00:00:00Z' },
        after: { observedAt: '2026-10-30T00:00:01.000Z', modifiedTime: '2026-10-30T00:00:00.000Z' }
      }
    };
    const doc = buildJsonExportDocument(ctx, prep, equivalentRep, opts);
    expect(doc.sourceObservations?.before?.modifiedTime).toBe('2026-10-30T00:00:00Z');
    expect(doc.sourceObservations?.after?.modifiedTime).toBe('2026-10-30T00:00:00.000Z');

    // Genuinely different modifiedTime rejected
    const differentRep: ExportReport = {
      ...rep,
      sourceObservations: {
        before: { observedAt: '2026-10-30T00:00:00Z', modifiedTime: '2026-10-30T00:00:00.000Z' },
        after: { observedAt: '2026-10-30T00:00:01Z', modifiedTime: '2026-10-30T00:00:01.000Z' }
      }
    };
    expect(() => buildJsonExportDocument(ctx, prep, differentRep, opts)).toThrowError(
      expect.objectContaining({ code: 'SOURCE_CHANGED_CONCURRENTLY' })
    );

    // Malformed unsupported timestamp rejected
    const malformedRep: ExportReport = {
      ...rep,
      sourceObservations: {
        before: { observedAt: '2026-10-30T00:00:00Z', modifiedTime: 'malformed-timestamp' },
        after: { observedAt: '2026-10-30T00:00:01Z', modifiedTime: '2026-10-30T00:00:00Z' }
      }
    };
    expect(() => buildJsonExportDocument(ctx, prep, malformedRep, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Versions remain exact opaque string comparisons
    const versionMismatchRep: ExportReport = {
      ...rep,
      sourceObservations: {
        before: { observedAt: '2026-10-30T00:00:00.000Z', version: 'v1' },
        after: { observedAt: '2026-10-30T00:00:01.000Z', version: 'v2' }
      }
    };
    expect(() => buildJsonExportDocument(ctx, prep, versionMismatchRep, opts)).toThrowError(
      expect.objectContaining({ code: 'SOURCE_CHANGED_CONCURRENTLY' })
    );
  });

  it('rejects complete=false, known changes, csvTransformCounts, and inverted timestamps', () => {
    const { ctx, rep, prep } = makeFixture();
    expect(() => buildJsonExportDocument(ctx, prep, { ...rep, export: { ...rep.export, complete: false } }, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    expect(() => buildJsonExportDocument(ctx, prep, { ...rep, export: { ...rep.export, consistency: 'not_atomic_changes_detected' } }, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_CHANGED_CONCURRENTLY' }));

    // Inverted timestamps
    expect(() => buildJsonExportDocument(ctx, prep, { ...rep, export: { ...rep.export, startedAt: '2026-10-30T00:00:05.000Z', producedAt: '2026-10-30T00:00:01.000Z' } }, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));

    // CSV transform counts forbidden in JSON report
    const withCsvCounts = { ...rep, csvTransformCounts: { policy: 'apostrophe_prefix_v1' as const, totalTransformedCells: 0, bySheet: [] } };
    expect(() => buildJsonExportDocument(ctx, prep, withCsvCounts as any, opts)).toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
  });

  it('checks warnings count early before schema walk, static SIZE_LIMIT_EXCEEDED when appropriate, and malformed structures fail FORMAT_SERIALIZATION_FAILED', () => {
    const { ctx, rep, prep } = makeFixture();
    const repWarn = {
      ...rep,
      export: {
        ...rep.export,
        warnings: [{ code: 'W1', message: 'warn' }, { code: 'W2', message: 'warn2' }]
      }
    };
    expect(() => buildJsonExportDocument(ctx, prep, repWarn, { maxWarnings: 1, signal })).toThrowError(
      expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' })
    );

    // Unknown malformed structures fail FORMAT_SERIALIZATION_FAILED
    expect(() => buildJsonExportDocument(ctx, prep, {} as any, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
    expect(() => buildJsonExportDocument(ctx, prep, null as any, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
    expect(() => buildJsonExportDocument(ctx, prep, { export: { warnings: 'not-an-array' } } as any, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    const foreignWarn = { ...rep, export: { ...rep.export, warnings: [{ code: 'W1', message: 'warn', sheetId: 999 }] } };
    expect(() => buildJsonExportDocument(ctx, prep, foreignWarn, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('handles options validation, preabort, forbidden context tokens, and hostile getters', () => {
    const { ctx, rep, prep } = makeFixture();

    const aborted = AbortSignal.abort();
    expect(() => buildJsonExportDocument(ctx, prep, rep, { maxWarnings: 10, signal: aborted })).toThrowError(
      expect.objectContaining({ code: 'OPERATION_ABORTED' })
    );

    expect(() => buildJsonExportDocument(ctx, prep, rep, { maxWarnings: -1, signal } as any)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    expect(() => buildJsonExportDocument(ctx, prep, rep, { maxWarnings: 4097, signal } as any)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );

    // Extra forbidden token properties on context
    const tokenCtx = { ...ctx, accessToken: 'secret_token' };
    expect(() => buildJsonExportDocument(tokenCtx as any, prep, rep, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );

    // Hostile getter error safely caught
    const hostileRep = { ...rep, get limitsVersion(): string { throw new Error('hostile explosion'); } };
    expect(() => buildJsonExportDocument(ctx, prep, hostileRep as any, opts)).toThrowError(
      expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
    );
  });

  it('non-enumerable toJSON hook is never invoked', () => {
    const { ctx, rep, prep } = makeFixture();
    let toJSONCalled = false;
    Object.defineProperty(rep, 'toJSON', {
      enumerable: false,
      configurable: true,
      value: () => { toJSONCalled = true; throw new Error('toJSON called!'); }
    });
    Object.defineProperty(rep.source, 'toJSON', {
      enumerable: false,
      configurable: true,
      value: () => { toJSONCalled = true; throw new Error('toJSON called!'); }
    });

    const doc = buildJsonExportDocument(ctx, prep, rep, opts);
    expect(toJSONCalled).toBe(false);
    expect(doc.source.title).toBe('Workbook');
  });

  it('preserves fractional timestamp precision while comparing equivalent offsets and trailing zeros', () => {
    const { ctx, rep, prep } = makeFixture();
    const observations = {
      before: { observedAt: '2026-10-30T00:00:00Z', modifiedTime: '2026-10-30T07:00:00.123456789+07:00' },
      after: { observedAt: '2026-10-30T00:00:01Z', modifiedTime: '2026-10-30T00:00:00.1234567890Z' }
    };
    expect(buildJsonExportDocument(ctx, prep, { ...rep, sourceObservations: observations }, opts).export.complete).toBe(true);
    const changed = { ...observations, after: { ...observations.after, modifiedTime: '2026-10-30T00:00:00.123456788Z' } };
    expect(() => buildJsonExportDocument(ctx, prep, { ...rep, sourceObservations: changed }, opts))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_CHANGED_CONCURRENTLY' }));
    const inverted = { ...rep, export: { ...rep.export,
      startedAt: '2026-10-30T00:00:00.123456789Z', producedAt: '2026-10-30T00:00:00.123456788Z' } };
    expect(() => buildJsonExportDocument(ctx, prep, inverted, opts))
      .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
  });
});
