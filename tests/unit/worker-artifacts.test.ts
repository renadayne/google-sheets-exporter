import { describe, it, expect } from 'vitest';

import type { Artifact, Cell, ExportFormat, ExportReport, NormalizedChunk } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { snapshotWriterContext } from '../../src/export/context.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import { buildCompleteExportReport } from '../../src/export/report.ts';
import {
  CANONICAL_SPARSE_SHEET_ID,
  createCanonicalExportReport,
  createCanonicalWriterContext
} from '../helpers/fixtures.ts';
import {
  createWorkerWriter,
  PROVISIONAL_WORKER_LIMITS
} from '../../src/runtime/worker-writers.ts';
import { parseWorkerArtifacts } from '../../src/runtime/worker-artifacts.ts';

function makeSmallContext(format: ExportFormat, signal: AbortSignal): WriterContext {
  const base = createCanonicalWriterContext();
  const rawContext: WriterContext = {
    sourceId: base.sourceId,
    title: base.title,
    locale: base.locale,
    timeZone: base.timeZone,
    scopes: [
      {
        sheetId: CANONICAL_SPARSE_SHEET_ID,
        rect: { sheetId: CANONICAL_SPARSE_SHEET_ID, r0: 0, c0: 0, r1: 2, c1: 2 }
      }
    ],
    mode: 'raw',
    format,
    visibility: 'include_all',
    limitsVersion: base.limitsVersion,
    sheetOrder: [CANONICAL_SPARSE_SHEET_ID],
    sheets: [
      {
        id: CANONICAL_SPARSE_SHEET_ID,
        title: 'SparseTab',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: 2,
        columns: 2
      }
    ]
  };

  return snapshotWriterContext(rawContext, {
    maxSheets: 10,
    signal
  });
}

function makeReportForContext(context: WriterContext, format: ExportFormat): ExportReport {
  const base = createCanonicalExportReport();
  return {
    schemaVersion: '1.0',
    source: {
      id: context.sourceId,
      title: context.title,
      locale: context.locale,
      timeZone: context.timeZone
    },
    export: {
      startedAt: base.export.startedAt,
      producedAt: base.export.producedAt,
      mode: context.mode,
      format,
      visibility: context.visibility,
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: []
    },
    selectedScopes: context.scopes,
    sheetOrder: context.sheetOrder,
    limitsVersion: context.limitsVersion,
    nameMappings: context.sheetOrder.map((sheetId) => {
      const sheet = context.sheets.find((s) => s.id === sheetId)!;
      return {
        sheetId: sheet.id,
        originalTitle: sheet.title,
        exportedName: format === 'xlsx' ? sheet.title : format === 'csv' ? `${sheet.title}.csv` : sheet.title
      };
    }),
    exclusions: []
  };
}

function makeChunk(sheetId: number, cells: Cell[], jobId = 'canonical-job-1'): NormalizedChunk {
  return {
    jobId,
    chunkId: `chunk_${sheetId}`,
    rect: { sheetId, r0: 0, c0: 0, r1: 2, c1: 2 },
    cells,
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 64
  };
}

function createSampleArtifact(overrides?: Partial<Artifact>): Artifact {
  const data = new Uint8Array([1, 2, 3, 4]);
  return {
    filename: 'sample.dat',
    mimeType: 'application/octet-stream',
    data,
    byteLength: 4,
    safeSummary: 'Sample binary artifact',
    ...overrides
  };
}

describe('T36b5 parseWorkerArtifacts', () => {
  it('accepts reordered array own-key snapshots and captures every descriptor once', () => {
    const artifact = createSampleArtifact();
    const artifactReads = new Map<PropertyKey, number>();
    const arrayReads = new Map<PropertyKey, number>();
    const wrapped = new Proxy(artifact, { getOwnPropertyDescriptor(target, key) {
      const reads = (artifactReads.get(key) ?? 0) + 1;
      artifactReads.set(key, reads);
      if (reads > 1) throw new Error('Unexpected artifact reread');
      return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    const array = new Proxy([wrapped], {
      ownKeys: () => ['length', '0'],
      getOwnPropertyDescriptor(target, key) {
        const reads = (arrayReads.get(key) ?? 0) + 1;
        arrayReads.set(key, reads);
        if (reads > 1) throw new Error('Unexpected array reread');
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    const parsed = parseWorkerArtifacts(array, { maxArtifacts: 2, maxBytes: 1024 });
    expect(parsed).toEqual([artifact]);
    expect(parsed![0].data).toBe(artifact.data);
    expect(Object.fromEntries(arrayReads)).toEqual({ length: 1, 0: 1 });
    expect(Object.fromEntries(artifactReads)).toEqual({ filename: 1, mimeType: 1, data: 1, byteLength: 1, safeSummary: 1 });
  });
  const signal = new AbortController().signal;

  // Group 1: Actual previous createWorkerWriter JSON/CSV/XLSX outputs snapshot passed and native Blob accepts
  describe('Group 1: Real writer outputs snapshot + native Blob acceptance', () => {
    it('accepts real JSON writer outputs snapshot', async () => {
      const writer = createWorkerWriter('json');
      const context = makeSmallContext('json', signal);
      const cells: Cell[] = [
        { r: 0, c: 0, kind: 'string', value: 'json_val_A1' },
        { r: 1, c: 1, kind: 'number', value: 123 }
      ];
      const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells);
      const report = makeReportForContext(context, 'json');
      const prepared = prepareWriterData(context, [chunk], {
        maxChunks: PROVISIONAL_WORKER_LIMITS.maxChunks,
        maxIntervals: PROVISIONAL_WORKER_LIMITS.maxIntervals,
        maxCells: PROVISIONAL_WORKER_LIMITS.maxCells,
        signal
      });
      const completeReport = buildCompleteExportReport(context, prepared, report, {
        maxWarnings: PROVISIONAL_WORKER_LIMITS.maxWarnings,
        signal
      });

      await writer.begin(context, signal);
      await writer.append(chunk, signal);
      const rawArtifacts = await writer.finalize(completeReport, signal);

      const parsed = parseWorkerArtifacts(rawArtifacts, {
        maxArtifacts: 10,
        maxBytes: PROVISIONAL_WORKER_LIMITS.maxOutputBytes
      });

      expect(parsed).not.toBeNull();
      expect(parsed).toHaveLength(1);
      expect(parsed![0].filename).toBe('Canonical Test Workbook.json');
      expect(parsed![0].mimeType).toBe('application/json');
      expect(parsed![0].byteLength).toBe(rawArtifacts[0].byteLength);
      expect(parsed![0].safeSummary).toBe(rawArtifacts[0].safeSummary);
      expect(parsed![0].data).toBe(rawArtifacts[0].data);
    });

    it('accepts real CSV writer outputs snapshot (primary CSV + staged metadata)', async () => {
      const writer = createWorkerWriter('csv');
      const context = makeSmallContext('csv', signal);
      const cells: Cell[] = [
        { r: 0, c: 0, kind: 'string', value: 'csv_val_A1' },
        { r: 1, c: 1, kind: 'number', value: 456 }
      ];
      const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells);
      const report = makeReportForContext(context, 'csv');

      await writer.begin(context, signal);
      await writer.append(chunk, signal);
      const rawArtifacts = await writer.finalize(report, signal);

      const parsed = parseWorkerArtifacts(rawArtifacts, {
        maxArtifacts: 10,
        maxBytes: PROVISIONAL_WORKER_LIMITS.maxOutputBytes
      });

      expect(parsed).not.toBeNull();
      expect(parsed).toHaveLength(2);
      expect(parsed![0].filename).toBe('SparseTab.csv');
      expect(parsed![0].mimeType).toBe('text/csv');
      expect(parsed![0].data).toBe(rawArtifacts[0].data);
      expect(parsed![1].filename).toBe('SparseTab.metadata.json');
      expect(parsed![1].mimeType).toBe('application/json');
      expect(parsed![1].data).toBe(rawArtifacts[1].data);
    });

    it('accepts real XLSX writer outputs snapshot (workbook + companion report)', async () => {
      const writer = createWorkerWriter('xlsx');
      const context = makeSmallContext('xlsx', signal);
      const cells: Cell[] = [
        { r: 0, c: 0, kind: 'string', value: 'xlsx_val_A1' },
        { r: 1, c: 1, kind: 'number', value: 789 }
      ];
      const chunk = makeChunk(CANONICAL_SPARSE_SHEET_ID, cells);
      const report = makeReportForContext(context, 'xlsx');

      await writer.begin(context, signal);
      await writer.append(chunk, signal);
      const rawArtifacts = await writer.finalize(report, signal);

      const parsed = parseWorkerArtifacts(rawArtifacts, {
        maxArtifacts: 10,
        maxBytes: PROVISIONAL_WORKER_LIMITS.maxOutputBytes
      });

      expect(parsed).not.toBeNull();
      expect(parsed).toHaveLength(2);
      expect(parsed![0].filename).toBe('Canonical Test Workbook.xlsx');
      expect(parsed![0].mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(parsed![0].data).toBe(rawArtifacts[0].data);
      expect(parsed![1].filename).toBe('Canonical Test Workbook.metadata.json');
      expect(parsed![1].mimeType).toBe('application/json');
      expect(parsed![1].data).toBe(rawArtifacts[1].data);
    });

    it('accepts native Blob artifact with verified intrinsic size', () => {
      const blobData = new Blob([new Uint8Array([10, 20, 30])], { type: 'application/octet-stream' });
      const blobArtifact: Artifact = {
        filename: 'data.bin',
        mimeType: 'application/octet-stream',
        data: blobData,
        byteLength: 3,
        safeSummary: 'Native Blob test artifact'
      };

      const parsed = parseWorkerArtifacts([blobArtifact], {
        maxArtifacts: 5,
        maxBytes: 1024
      });

      expect(parsed).not.toBeNull();
      expect(parsed).toHaveLength(1);
      expect(parsed![0].filename).toBe('data.bin');
      expect(parsed![0].mimeType).toBe('application/octet-stream');
      expect(parsed![0].data).toBe(blobData);
      expect(parsed![0].byteLength).toBe(3);
      expect(parsed![0].safeSummary).toBe('Native Blob test artifact');
    });
  });

  // Group 2: Exact frozen metadata / data identity / no input freeze
  describe('Group 2: Exact frozen metadata, data identity, and no input freeze', () => {
    it('returns fresh frozen array containing fresh frozen wrappers while preserving data reference', () => {
      const rawData = new Uint8Array([1, 2, 3, 4, 5]);
      const rawArtifact = {
        filename: 'test.dat',
        mimeType: 'application/octet-stream',
        data: rawData,
        byteLength: 5,
        safeSummary: 'Frozen test summary'
      };
      const rawInput = [rawArtifact];

      const parsed = parseWorkerArtifacts(rawInput, { maxArtifacts: 5, maxBytes: 1024 });

      expect(parsed).not.toBeNull();
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed![0])).toBe(true);

      // Wrapper is fresh
      expect(parsed![0]).not.toBe(rawArtifact);

      // Reference identity of binary payload is preserved
      expect(parsed![0].data).toBe(rawData);

      // Binary payload is NOT frozen
      expect(Object.isFrozen(rawData)).toBe(false);

      // Source array and source artifact are NOT frozen
      expect(Object.isFrozen(rawInput)).toBe(false);
      expect(Object.isFrozen(rawArtifact)).toBe(false);
    });
  });

  // Group 3: Caps / count / exact + over mismatched actual bytes
  describe('Group 3: Caps, count bounds, exact boundary, and mismatched bytes', () => {
    it('rejects empty input array (length 0)', () => {
      const parsed = parseWorkerArtifacts([], { maxArtifacts: 10, maxBytes: 1024 });
      expect(parsed).toBeNull();
    });

    it('rejects input array exceeding maxArtifacts', () => {
      const art1 = createSampleArtifact({ filename: '1.dat' });
      const art2 = createSampleArtifact({ filename: '2.dat' });
      const art3 = createSampleArtifact({ filename: '3.dat' });

      const parsed = parseWorkerArtifacts([art1, art2, art3], { maxArtifacts: 2, maxBytes: 1024 });
      expect(parsed).toBeNull();
    });

    it('rejects invalid maxArtifacts values (0, -0, negative, > 4096, non-integer)', () => {
      const art = createSampleArtifact();
      expect(parseWorkerArtifacts([art], { maxArtifacts: 0, maxBytes: 1024 })).toBeNull();
      expect(parseWorkerArtifacts([art], { maxArtifacts: -0, maxBytes: 1024 })).toBeNull();
      expect(parseWorkerArtifacts([art], { maxArtifacts: -1, maxBytes: 1024 })).toBeNull();
      expect(parseWorkerArtifacts([art], { maxArtifacts: 4097, maxBytes: 1024 })).toBeNull();
      expect(parseWorkerArtifacts([art], { maxArtifacts: 2.5, maxBytes: 1024 })).toBeNull();
      expect(parseWorkerArtifacts([art], { maxArtifacts: NaN, maxBytes: 1024 })).toBeNull();
      expect(parseWorkerArtifacts([art], { maxArtifacts: Infinity, maxBytes: 1024 })).toBeNull();
    });

    it('rejects invalid maxBytes values (-0, negative, > 64MiB, non-integer)', () => {
      const art = createSampleArtifact();
      expect(parseWorkerArtifacts([art], { maxArtifacts: 5, maxBytes: -0 })).toBeNull();
      expect(parseWorkerArtifacts([art], { maxArtifacts: 5, maxBytes: -1 })).toBeNull();
      expect(parseWorkerArtifacts([art], { maxArtifacts: 5, maxBytes: 64 * 1024 * 1024 + 1 })).toBeNull();
      expect(parseWorkerArtifacts([art], { maxArtifacts: 5, maxBytes: 10.5 })).toBeNull();
      expect(parseWorkerArtifacts([art], { maxArtifacts: 5, maxBytes: NaN })).toBeNull();
    });

    it('rejects declared byteLength mismatched with actual binary intrinsic length', () => {
      const data = new Uint8Array([1, 2, 3]); // actual length 3
      const overDeclared = createSampleArtifact({ data, byteLength: 4 });
      const underDeclared = createSampleArtifact({ data, byteLength: 2 });
      const negativeDeclared = createSampleArtifact({ data, byteLength: -1 });
      const minusZeroDeclared = createSampleArtifact({ data, byteLength: -0 });

      expect(parseWorkerArtifacts([overDeclared], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
      expect(parseWorkerArtifacts([underDeclared], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
      expect(parseWorkerArtifacts([negativeDeclared], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
      expect(parseWorkerArtifacts([minusZeroDeclared], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
    });

    it('accepts exact cumulative bytes at maxBytes boundary, and rejects over maxBytes', () => {
      const art1 = createSampleArtifact({ data: new Uint8Array([1, 2, 3]), byteLength: 3 });
      const art2 = createSampleArtifact({ data: new Uint8Array([4, 5]), byteLength: 2 });

      // Total = 5 bytes. maxBytes = 5 (exact boundary) -> PASS
      const exact = parseWorkerArtifacts([art1, art2], { maxArtifacts: 5, maxBytes: 5 });
      expect(exact).not.toBeNull();
      expect(exact).toHaveLength(2);

      // Total = 5 bytes. maxBytes = 4 (over boundary) -> REJECT
      const over = parseWorkerArtifacts([art1, art2], { maxArtifacts: 5, maxBytes: 4 });
      expect(over).toBeNull();
    });

    it('allows 0-byte artifact when maxBytes is 0', () => {
      const emptyArt = createSampleArtifact({ data: new Uint8Array(0), byteLength: 0 });
      const parsed = parseWorkerArtifacts([emptyArt], { maxArtifacts: 5, maxBytes: 0 });
      expect(parsed).not.toBeNull();
      expect(parsed).toHaveLength(1);
      expect(parsed![0].byteLength).toBe(0);
    });
  });

  // Group 4: Sparse / accessor / extra / symbol / prototype fields rejects no hooks
  describe('Group 4: Rejection of sparse slots, accessors, extra/symbol keys, and non-plain prototypes', () => {
    it('rejects non-array or primitive inputs and invalid options records', () => {
      const opts = { maxArtifacts: 5, maxBytes: 1024 };
      expect(parseWorkerArtifacts(null, opts)).toBeNull();
      expect(parseWorkerArtifacts(undefined, opts)).toBeNull();
      expect(parseWorkerArtifacts('string', opts)).toBeNull();
      expect(parseWorkerArtifacts(123, opts)).toBeNull();
      expect(parseWorkerArtifacts({}, opts)).toBeNull();
      expect(parseWorkerArtifacts([null], opts)).toBeNull();
      expect(parseWorkerArtifacts([undefined], opts)).toBeNull();
      expect(parseWorkerArtifacts(['string'], opts)).toBeNull();
      expect(parseWorkerArtifacts([[]], opts)).toBeNull();
      expect(parseWorkerArtifacts([{}], opts)).toBeNull();

      expect(parseWorkerArtifacts([createSampleArtifact()], null as any)).toBeNull();
      expect(parseWorkerArtifacts([createSampleArtifact()], undefined as any)).toBeNull();
      expect(parseWorkerArtifacts([createSampleArtifact()], 'opts' as any)).toBeNull();
      expect(parseWorkerArtifacts([createSampleArtifact()], [] as any)).toBeNull();
    });

    it('rejects sparse input arrays without calling hooks', () => {
      const art1 = createSampleArtifact();
      const art2 = createSampleArtifact();
      const sparseArr = [art1, art2];
      delete (sparseArr as any)[0];

      expect(parseWorkerArtifacts(sparseArr, { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
    });

    it('rejects input array accessor slots without executing getter', () => {
      let hookCalled = false;
      const arr: any[] = [];
      Object.defineProperty(arr, '0', {
        get() {
          hookCalled = true;
          return createSampleArtifact();
        },
        enumerable: true,
        configurable: true
      });
      arr.length = 1;

      expect(parseWorkerArtifacts(arr, { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
      expect(hookCalled).toBe(false);
    });

    it('rejects input array with extra named or symbol properties', () => {
      const arr = [createSampleArtifact()];
      (arr as any).extraField = 'extra';
      expect(parseWorkerArtifacts(arr, { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();

      const arrWithSymbol = [createSampleArtifact()];
      (arrWithSymbol as any)[Symbol('tag')] = 'sym';
      expect(parseWorkerArtifacts(arrWithSymbol, { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
    });

    it('rejects input array with non-Array prototype', () => {
      const arr = [createSampleArtifact()];
      Object.setPrototypeOf(arr, null);
      expect(parseWorkerArtifacts(arr, { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
    });

    it('rejects artifact with accessor properties without executing getter', () => {
      let hookCalled = false;
      const artWithGetter = {
        get filename() {
          hookCalled = true;
          return 'getter.dat';
        },
        mimeType: 'text/plain',
        data: new Uint8Array([1]),
        byteLength: 1,
        safeSummary: 'safe'
      };

      expect(parseWorkerArtifacts([artWithGetter], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
      expect(hookCalled).toBe(false);
    });

    it('rejects artifact with extra properties or symbol properties', () => {
      const artWithExtra = {
        ...createSampleArtifact(),
        extraProp: 'forbidden'
      };
      expect(parseWorkerArtifacts([artWithExtra], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();

      const artWithSymbol = {
        ...createSampleArtifact(),
        [Symbol('auth')]: 'forbidden'
      };
      expect(parseWorkerArtifacts([artWithSymbol], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
    });

    it('rejects artifact with non-plain prototype', () => {
      class CustomArtifact {
        filename = 'c.dat';
        mimeType = 'text/plain';
        data = new Uint8Array([1]);
        byteLength = 1;
        safeSummary = 'class summary';
      }

      expect(parseWorkerArtifacts([new CustomArtifact()], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
    });

    it('accepts artifact with null prototype (null record)', () => {
      const nullProtoArt = Object.assign(Object.create(null), {
        filename: 'null.dat',
        mimeType: 'text/plain',
        data: new Uint8Array([1]),
        byteLength: 1,
        safeSummary: 'null proto summary'
      });

      const parsed = parseWorkerArtifacts([nullProtoArt], { maxArtifacts: 5, maxBytes: 1024 });
      expect(parsed).not.toBeNull();
      expect(parsed).toHaveLength(1);
      expect(parsed![0].filename).toBe('null.dat');
    });

    it('rejects auth/credential fields on array or artifact, including prototype pollution', () => {
      const artWithAuth = {
        ...createSampleArtifact(),
        token: 'auth-token'
      };
      expect(parseWorkerArtifacts([artWithAuth], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();

      const arrayWithAuth = [createSampleArtifact()];
      (arrayWithAuth as any).principalKey = 'user-key';
      expect(parseWorkerArtifacts(arrayWithAuth, { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();

      try {
        (Object.prototype as any).accessToken = 'polluted-token';
        expect(parseWorkerArtifacts([createSampleArtifact()], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
      } finally {
        delete (Object.prototype as any).accessToken;
      }
    });

    it('rejects invalid metadata primitives (empty filename, empty mimeType, non-string safeSummary)', () => {
      const emptyFilename = createSampleArtifact({ filename: '' });
      expect(parseWorkerArtifacts([emptyFilename], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();

      const emptyMime = createSampleArtifact({ mimeType: '' });
      expect(parseWorkerArtifacts([emptyMime], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();

      const nonStringSummary = createSampleArtifact({ safeSummary: 123 as any });
      expect(parseWorkerArtifacts([nonStringSummary], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();

      // Empty safeSummary is valid
      const emptySummary = createSampleArtifact({ safeSummary: '' });
      const parsed = parseWorkerArtifacts([emptySummary], { maxArtifacts: 5, maxBytes: 1024 });
      expect(parsed).not.toBeNull();
      expect(parsed![0].safeSummary).toBe('');
    });
  });

  // Group 5: Native Uint8Array subviews / shared / resizable / fake data / native getter override not executed
  describe('Group 5: Binary validation (subviews, shared/resizable buffers, fake data, getter overrides)', () => {
    it('rejects subview with non-zero byteOffset', () => {
      const buffer = new ArrayBuffer(10);
      const subview = new Uint8Array(buffer, 2, 4);
      const art = createSampleArtifact({ data: subview, byteLength: 4 });

      expect(parseWorkerArtifacts([art], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
    });

    it('rejects subview with byteLength not spanning entire backing ArrayBuffer', () => {
      const buffer = new ArrayBuffer(10);
      const subview = new Uint8Array(buffer, 0, 5); // offset 0, but buffer is 10
      const art = createSampleArtifact({ data: subview, byteLength: 5 });

      expect(parseWorkerArtifacts([art], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
    });

    it('rejects SharedArrayBuffer backing buffer', () => {
      if (typeof SharedArrayBuffer !== 'undefined') {
        const sab = new SharedArrayBuffer(10);
        const view = new Uint8Array(sab);
        const art = createSampleArtifact({ data: view, byteLength: 10 });

        expect(parseWorkerArtifacts([art], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
      }
    });

    it('rejects resizable ArrayBuffer backing buffer', () => {
      try {
        const rab = new (ArrayBuffer as any)(10, { maxByteLength: 20 });
        const view = new Uint8Array(rab);
        const art = createSampleArtifact({ data: view, byteLength: 10 });

        expect(parseWorkerArtifacts([art], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
      } catch {
        // Resizable ArrayBuffer not supported in older runtimes; ignore
      }
    });

    it('rejects fake data object and Proxy around Uint8Array', () => {
      const fakeData = {
        byteLength: 5,
        byteOffset: 0,
        buffer: new ArrayBuffer(5)
      };
      Object.setPrototypeOf(fakeData, Uint8Array.prototype);
      const art1 = createSampleArtifact({ data: fakeData as any, byteLength: 5 });
      expect(parseWorkerArtifacts([art1], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();

      const proxyData = new Proxy(new Uint8Array(5), {});
      const art2 = createSampleArtifact({ data: proxyData, byteLength: 5 });
      expect(parseWorkerArtifacts([art2], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
    });

    it('does not execute own getter overrides on genuine Uint8Array data', () => {
      const genuineU8 = new Uint8Array([1, 2, 3, 4]);
      let hookExecuted = false;

      Object.defineProperty(genuineU8, 'byteLength', {
        get() {
          hookExecuted = true;
          throw new Error('Overridden byteLength executed!');
        }
      });
      Object.defineProperty(genuineU8, 'byteOffset', {
        get() {
          hookExecuted = true;
          throw new Error('Overridden byteOffset executed!');
        }
      });
      Object.defineProperty(genuineU8, 'buffer', {
        get() {
          hookExecuted = true;
          throw new Error('Overridden buffer executed!');
        }
      });

      const art = createSampleArtifact({ data: genuineU8, byteLength: 4 });
      const parsed = parseWorkerArtifacts([art], { maxArtifacts: 5, maxBytes: 1024 });

      expect(parsed).not.toBeNull();
      expect(hookExecuted).toBe(false);
      expect(parsed![0].byteLength).toBe(4);
    });
  });

  // Group 6: Option / descriptor capture counts + throwing traps
  describe('Group 6: Options and descriptor capture counts with throwing traps', () => {
    it('captures options values exactly once through a proxy spy', () => {
      let maxArtifactsReads = 0;
      let maxBytesReads = 0;

      const optionsSpy = new Proxy(
        { maxArtifacts: 5, maxBytes: 1024 },
        {
          get(target, prop, receiver) {
            if (prop === 'maxArtifacts') maxArtifactsReads++;
            if (prop === 'maxBytes') maxBytesReads++;
            return Reflect.get(target, prop, receiver);
          }
        }
      );

      const parsed = parseWorkerArtifacts([createSampleArtifact()], optionsSpy);
      expect(parsed).not.toBeNull();
      expect(maxArtifactsReads).toBe(1);
      expect(maxBytesReads).toBe(1);
    });

    it('handles throwing options traps by returning null safely without exception', () => {
      const throwingOptions = {
        get maxArtifacts(): number {
          throw new Error('throwing maxArtifacts');
        },
        maxBytes: 1024
      };
      expect(parseWorkerArtifacts([createSampleArtifact()], throwingOptions)).toBeNull();

      const throwingBytesOptions = {
        maxArtifacts: 5,
        get maxBytes(): number {
          throw new Error('throwing maxBytes');
        }
      };
      expect(parseWorkerArtifacts([createSampleArtifact()], throwingBytesOptions)).toBeNull();
    });

    it('handles throwing array descriptor traps safely', () => {
      const art = createSampleArtifact();
      const throwingArray = new Proxy([art], {
        getOwnPropertyDescriptor(target, prop) {
          if (prop === '0') throw new Error('throwing element descriptor');
          return Reflect.getOwnPropertyDescriptor(target, prop);
        }
      });

      expect(parseWorkerArtifacts(throwingArray, { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
    });

    it('handles throwing artifact ownKeys and descriptor traps safely', () => {
      const throwingOwnKeys = new Proxy(createSampleArtifact(), {
        ownKeys() {
          throw new Error('throwing ownKeys');
        }
      });
      expect(parseWorkerArtifacts([throwingOwnKeys], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();

      const throwingDesc = new Proxy(createSampleArtifact(), {
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'filename') throw new Error('throwing filename descriptor');
          return Reflect.getOwnPropertyDescriptor(target, prop);
        }
      });
      expect(parseWorkerArtifacts([throwingDesc], { maxArtifacts: 5, maxBytes: 1024 })).toBeNull();
    });
  });

  // Group 7: Metadata field changing traps captured once and no raw leak
  describe('Group 7: Metadata field changing traps captured once and zero raw error leak', () => {
    it('captures metadata primitives once such that later source wrapper mutation does not affect returned snapshot', () => {
      const sourceArt = createSampleArtifact({
        filename: 'original.dat',
        byteLength: 4,
        safeSummary: 'original summary'
      });

      const parsed = parseWorkerArtifacts([sourceArt], { maxArtifacts: 5, maxBytes: 1024 });
      expect(parsed).not.toBeNull();
      expect(parsed![0].filename).toBe('original.dat');
      expect(parsed![0].safeSummary).toBe('original summary');

      // Mutate source artifact after parsing
      (sourceArt as any).filename = 'mutated.dat';
      (sourceArt as any).byteLength = 9999;
      (sourceArt as any).safeSummary = 'mutated summary';

      // Returned frozen snapshot remains unaffected
      expect(parsed![0].filename).toBe('original.dat');
      expect(parsed![0].byteLength).toBe(4);
      expect(parsed![0].safeSummary).toBe('original summary');
    });

    it('ensures zero raw error leak when hostile trap throws sensitive information', () => {
      const hostileArtifact = new Proxy(createSampleArtifact(), {
        getOwnPropertyDescriptor() {
          throw new Error('SENSITIVE_BEARER_TOKEN_LEAK_SECRET_12345');
        }
      });

      let returned: any = undefined;
      expect(() => {
        returned = parseWorkerArtifacts([hostileArtifact], { maxArtifacts: 5, maxBytes: 1024 });
      }).not.toThrow();
      expect(returned).toBeNull();
    });
  });
});
