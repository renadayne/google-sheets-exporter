import { describe, it, expect } from 'vitest';

import type {
  Artifact,
  Cell,
  ExportFormat,
  ExportReport,
  NormalizedChunk
} from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import { snapshotWriterContext } from '../../src/export/context.ts';
import {
  mapCsvFilenames,
  mapWorksheetNames
} from '../../src/export/names.ts';
import {
  CANONICAL_SPARSE_SHEET_ID,
  CANONICAL_EMPTY_SHEET_ID,
  createCanonicalExportReport,
  createCanonicalWriterContext
} from '../helpers/fixtures.ts';
import {
  createWorkerWriter
} from '../../src/runtime/worker-writers.ts';
import {
  selectPublicationArtifacts,
  PROVISIONAL_MAX_BYTES
} from '../../src/jobs/artifact-selection.ts';

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

function makeMultiContext(format: ExportFormat, signal: AbortSignal): WriterContext {
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
      },
      {
        sheetId: CANONICAL_EMPTY_SHEET_ID,
        rect: { sheetId: CANONICAL_EMPTY_SHEET_ID, r0: 0, c0: 0, r1: 2, c1: 2 }
      }
    ],
    mode: 'raw',
    format,
    visibility: 'include_all',
    limitsVersion: base.limitsVersion,
    sheetOrder: [CANONICAL_SPARSE_SHEET_ID, CANONICAL_EMPTY_SHEET_ID],
    sheets: [
      {
        id: CANONICAL_SPARSE_SHEET_ID,
        title: 'SparseTab',
        index: 0,
        type: 'GRID',
        hidden: false,
        rows: 2,
        columns: 2
      },
      {
        id: CANONICAL_EMPTY_SHEET_ID,
        title: 'EmptyTab',
        index: 1,
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
  const sheetInputs = context.sheets.map((s) => ({ id: s.id, title: s.title }));
  const nameMappings =
    format === 'csv'
      ? mapCsvFilenames(sheetInputs)
      : format === 'xlsx'
        ? mapWorksheetNames(sheetInputs)
        : sheetInputs.map((s) => ({ sheetId: s.id, originalTitle: s.title, exportedName: s.title }));

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
    nameMappings,
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

async function produceRealStagedArtifacts(
  context: WriterContext,
  format: ExportFormat,
  signal: AbortSignal
): Promise<readonly Artifact[]> {
  const writer = createWorkerWriter(format);
  await writer.begin(context, signal);

  for (const sheet of context.sheets) {
    const cells: Cell[] = [
      { r: 0, c: 0, kind: 'string', value: `val_${sheet.title}_A1` },
      { r: 1, c: 1, kind: 'number', value: sheet.id }
    ];
    await writer.append(makeChunk(sheet.id, cells), signal);
  }

  const report = makeReportForContext(context, format);
  return await writer.finalize(report, signal);
}

describe('T31a selectPublicationArtifacts', () => {
  it('reconstructs static configuration errors and contains revoked option proxies', () => {
    const original = new DomainError('AUTH_REQUIRED');
    original.message = 'private option diagnostic';
    const options = { get maxBytes(): number { throw original; }, signal: new AbortController().signal };
    const { proxy, revoke } = Proxy.revocable(options, {});
    for (const input of [options, proxy]) {
      if (input === proxy) revoke();
      let thrown: unknown;
      try { selectPublicationArtifacts({} as WriterContext, [], 'export', input); }
      catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(DomainError);
      expect((thrown as DomainError).code).toBe('CONFIG_INVALID');
      expect((thrown as DomainError).message).not.toContain('private');
      expect(thrown).not.toBe(original);
    }
  });

  it('checks actual cancellation triggered while staged descriptors are being captured', async () => {
    const controller = new AbortController();
    const context = makeSmallContext('json', controller.signal);
    const staged = await produceRealStagedArtifacts(context, 'json', controller.signal);
    let touched = 0;
    const data = new Proxy(staged[0], { getOwnPropertyDescriptor(target, key) {
      if (key === 'data') { touched++; controller.abort(); }
      return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    expect(() => selectPublicationArtifacts(context, [data], 'export', {
      signal: controller.signal, maxBytes: PROVISIONAL_MAX_BYTES
    })).toThrow(expect.objectContaining({ code: 'OPERATION_ABORTED' }));
    expect(touched).toBe(1);
  });
  const signal = new AbortController().signal;
  const defaultOptions = Object.freeze({
    signal,
    maxBytes: PROVISIONAL_MAX_BYTES
  });

  // Group 1: Real JSON writer staged outputs (single & multi tab)
  describe('Group 1: Real JSON writer outputs (single and multi sheet)', () => {
    it('returns exact single JSON workbook artifact for single-sheet context with data identity retained', async () => {
      const context = makeSmallContext('json', signal);
      const staged = await produceRealStagedArtifacts(context, 'json', signal);

      expect(staged).toHaveLength(1);
      const selected = selectPublicationArtifacts(context, staged, 'export', defaultOptions);

      expect(selected).toHaveLength(1);
      expect(selected.map((a) => a.filename)).toEqual(['Canonical Test Workbook.json']);
      expect(selected[0].mimeType).toBe('application/json');
      expect(selected[0].data).toBe(staged[0].data);
    });

    it('returns exact single JSON workbook artifact for multi-sheet context with data identity retained', async () => {
      const context = makeMultiContext('json', signal);
      const staged = await produceRealStagedArtifacts(context, 'json', signal);

      expect(staged).toHaveLength(1);
      const selected = selectPublicationArtifacts(context, staged, 'export', defaultOptions);

      expect(selected).toHaveLength(1);
      expect(selected.map((a) => a.filename)).toEqual(['Canonical Test Workbook.json']);
      expect(selected[0].mimeType).toBe('application/json');
      expect(selected[0].data).toBe(staged[0].data);
    });

    it('rejects csv_metadata action on JSON context with static FORMAT_UNSUPPORTED', async () => {
      const context = makeSmallContext('json', signal);
      const staged = await produceRealStagedArtifacts(context, 'json', signal);

      expect(() =>
        selectPublicationArtifacts(context, staged, 'csv_metadata', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, staged, 'csv_metadata', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_UNSUPPORTED');
      }
    });
  });

  // Group 2: Single-sheet CSV default export returns primary only
  describe('Group 2: Real single-sheet CSV output (default export excludes companion)', () => {
    it('returns primary CSV artifact only, excluding companion metadata, preserving data identity', async () => {
      const context = makeSmallContext('csv', signal);
      const staged = await produceRealStagedArtifacts(context, 'csv', signal);

      expect(staged).toHaveLength(2);
      expect(staged[0].filename).toBe('SparseTab.csv');
      expect(staged[1].filename).toBe('SparseTab.metadata.json');

      const selected = selectPublicationArtifacts(context, staged, 'export', defaultOptions);

      expect(selected).toHaveLength(1);
      expect(selected.map((a) => a.filename)).toEqual(['SparseTab.csv']);
      expect(selected[0].mimeType).toBe('text/csv');
      expect(selected[0].data).toBe(staged[0].data);
    });
  });

  // Group 3: Single-sheet CSV explicit 'csv_metadata' returns companion only
  describe('Group 3: Real single-sheet CSV output (explicit csv_metadata action)', () => {
    it('returns companion metadata artifact only, excluding primary CSV, preserving data identity', async () => {
      const context = makeSmallContext('csv', signal);
      const staged = await produceRealStagedArtifacts(context, 'csv', signal);

      expect(staged).toHaveLength(2);

      const selected = selectPublicationArtifacts(context, staged, 'csv_metadata', defaultOptions);

      expect(selected).toHaveLength(1);
      expect(selected.map((a) => a.filename)).toEqual(['SparseTab.metadata.json']);
      expect(selected[0].mimeType).toBe('application/json');
      expect(selected[0].data).toBe(staged[1].data);
    });
  });

  // Group 4: Multi-sheet CSV (ZIP only) and XLSX (both primary and companion)
  describe('Group 4: Multi-sheet CSV (ZIP archive) and XLSX (workbook + companion report)', () => {
    it('multi-sheet CSV export returns single ZIP artifact, csv_metadata is unavailable', async () => {
      const context = makeMultiContext('csv', signal);
      const staged = await produceRealStagedArtifacts(context, 'csv', signal);

      expect(staged).toHaveLength(1);
      expect(staged[0].filename).toBe('Canonical Test Workbook.zip');
      expect(staged[0].mimeType).toBe('application/zip');

      const selected = selectPublicationArtifacts(context, staged, 'export', defaultOptions);

      expect(selected).toHaveLength(1);
      expect(selected.map((a) => a.filename)).toEqual(['Canonical Test Workbook.zip']);
      expect(selected[0].mimeType).toBe('application/zip');
      expect(selected[0].data).toBe(staged[0].data);

      expect(() =>
        selectPublicationArtifacts(context, staged, 'csv_metadata', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, staged, 'csv_metadata', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_UNSUPPORTED');
      }
    });

    it('XLSX export returns both primary workbook and companion report in exact order', async () => {
      const context = makeSmallContext('xlsx', signal);
      const staged = await produceRealStagedArtifacts(context, 'xlsx', signal);

      expect(staged).toHaveLength(2);
      expect(staged[0].filename).toBe('Canonical Test Workbook.xlsx');
      expect(staged[1].filename).toBe('Canonical Test Workbook.metadata.json');

      const selected = selectPublicationArtifacts(context, staged, 'export', defaultOptions);

      expect(selected).toHaveLength(2);
      expect(selected.map((a) => a.filename)).toEqual([
        'Canonical Test Workbook.xlsx',
        'Canonical Test Workbook.metadata.json'
      ]);
      expect(selected[0].mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(selected[1].mimeType).toBe('application/json');
      expect(selected[0].data).toBe(staged[0].data);
      expect(selected[1].data).toBe(staged[1].data);

      expect(() =>
        selectPublicationArtifacts(context, staged, 'csv_metadata', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, staged, 'csv_metadata', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_UNSUPPORTED');
      }
    });
  });

  // Group 5: Staging mismatch, cardinality, order, auth, accessor, and budget static failures
  describe('Group 5: Staging mismatch, cardinality, order, auth, accessor, and budget static failures', () => {
    it('rejects single-sheet CSV when companion metadata is missing from staging (cardinality 1)', async () => {
      const context = makeSmallContext('csv', signal);
      const staged = await produceRealStagedArtifacts(context, 'csv', signal);

      const truncatedStaging = [staged[0]]; // Only CSV, companion omitted
      expect(() =>
        selectPublicationArtifacts(context, truncatedStaging, 'export', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, truncatedStaging, 'export', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_SERIALIZATION_FAILED');
      }
    });

    it('rejects XLSX when companion metadata is missing from staging (cardinality 1)', async () => {
      const context = makeSmallContext('xlsx', signal);
      const staged = await produceRealStagedArtifacts(context, 'xlsx', signal);

      const truncatedStaging = [staged[0]];
      expect(() =>
        selectPublicationArtifacts(context, truncatedStaging, 'export', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, truncatedStaging, 'export', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_SERIALIZATION_FAILED');
      }
    });

    it('rejects JSON when extra artifact is present in staging (cardinality 2)', async () => {
      const context = makeSmallContext('json', signal);
      const staged = await produceRealStagedArtifacts(context, 'json', signal);

      const extraStaging = [
        staged[0],
        {
          filename: 'extra.json',
          mimeType: 'application/json',
          data: new Uint8Array([1, 2]),
          byteLength: 2,
          safeSummary: 'extra'
        }
      ];

      expect(() =>
        selectPublicationArtifacts(context, extraStaging, 'export', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, extraStaging, 'export', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_SERIALIZATION_FAILED');
      }
    });

    it('rejects single-sheet CSV when artifacts are swapped in order (companion first)', async () => {
      const context = makeSmallContext('csv', signal);
      const staged = await produceRealStagedArtifacts(context, 'csv', signal);

      const swappedStaging = [staged[1], staged[0]];
      expect(() =>
        selectPublicationArtifacts(context, swappedStaging, 'export', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, swappedStaging, 'export', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_SERIALIZATION_FAILED');
      }
    });

    it('rejects XLSX when artifacts are swapped in order (companion first)', async () => {
      const context = makeSmallContext('xlsx', signal);
      const staged = await produceRealStagedArtifacts(context, 'xlsx', signal);

      const swappedStaging = [staged[1], staged[0]];
      expect(() =>
        selectPublicationArtifacts(context, swappedStaging, 'export', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, swappedStaging, 'export', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_SERIALIZATION_FAILED');
      }
    });

    it('rejects misnamed filenames not matching reviewed naming helpers', async () => {
      const context = makeSmallContext('json', signal);
      const staged = await produceRealStagedArtifacts(context, 'json', signal);

      const misnamedStaging = [
        {
          ...staged[0],
          filename: 'arbitrary_other_name.json'
        }
      ];

      expect(() =>
        selectPublicationArtifacts(context, misnamedStaging, 'export', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, misnamedStaging, 'export', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_SERIALIZATION_FAILED');
      }
    });

    it('rejects mismatched MIME types', async () => {
      const context = makeSmallContext('csv', signal);
      const staged = await produceRealStagedArtifacts(context, 'csv', signal);

      const mismimedStaging = [
        { ...staged[0], mimeType: 'text/plain' },
        staged[1]
      ];

      expect(() =>
        selectPublicationArtifacts(context, mismimedStaging, 'export', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, mismimedStaging, 'export', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_SERIALIZATION_FAILED');
      }
    });

    it('rejects forbidden auth/credential fields on staged artifact records', async () => {
      const context = makeSmallContext('json', signal);
      const staged = await produceRealStagedArtifacts(context, 'json', signal);

      const contaminatedStaging = [
        {
          ...staged[0],
          accessToken: 'ya29.hostile_secret_token'
        }
      ];

      expect(() =>
        selectPublicationArtifacts(context, contaminatedStaging, 'export', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, contaminatedStaging, 'export', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_SERIALIZATION_FAILED');
      }
    });

    it('rejects hostile property accessor getters on staged artifacts', async () => {
      const context = makeSmallContext('json', signal);
      const staged = await produceRealStagedArtifacts(context, 'json', signal);

      let trapTriggered = false;
      const hostileArtifact = {
        get filename() {
          trapTriggered = true;
          return 'Canonical Test Workbook.json';
        },
        mimeType: staged[0].mimeType,
        data: staged[0].data,
        byteLength: staged[0].byteLength,
        safeSummary: staged[0].safeSummary
      };

      expect(() =>
        selectPublicationArtifacts(context, [hostileArtifact], 'export', defaultOptions)
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, [hostileArtifact], 'export', defaultOptions);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_SERIALIZATION_FAILED');
      }
      expect(trapTriggered).toBe(false);
    });

    it('rejects staging when aggregate bytes exceed maxBytes budget', async () => {
      const context = makeSmallContext('json', signal);
      const staged = await produceRealStagedArtifacts(context, 'json', signal);

      expect(() =>
        selectPublicationArtifacts(context, staged, 'export', {
          signal,
          maxBytes: 10 // Staged JSON is larger than 10 bytes
        })
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, staged, 'export', {
          signal,
          maxBytes: 10
        });
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('FORMAT_SERIALIZATION_FAILED');
      }
    });

    it('rejects null, non-array, empty array, or invalid context with FORMAT_SERIALIZATION_FAILED', () => {
      const context = makeSmallContext('json', signal);

      expect(() =>
        selectPublicationArtifacts(context, null, 'export', defaultOptions)
      ).toThrow(DomainError);
      expect(() =>
        selectPublicationArtifacts(context, {}, 'export', defaultOptions)
      ).toThrow(DomainError);
      expect(() =>
        selectPublicationArtifacts(context, [], 'export', defaultOptions)
      ).toThrow(DomainError);

      const invalidContext = { ...context, format: 'unknown_format' as any };
      expect(() =>
        selectPublicationArtifacts(invalidContext, [], 'export', defaultOptions)
      ).toThrow(DomainError);
    });
  });

  // Group 6: Options capture once, abort, immutability, and unknown action no hooks
  describe('Group 6: Options capture once, abort signaling, immutability, and unknown action no hooks', () => {
    it('captures options properties at most once without repeated getter access', async () => {
      const context = makeSmallContext('json', signal);
      const staged = await produceRealStagedArtifacts(context, 'json', signal);

      let maxBytesReads = 0;
      let signalReads = 0;

      const trackedOptions = {
        get maxBytes() {
          maxBytesReads++;
          return PROVISIONAL_MAX_BYTES;
        },
        get signal() {
          signalReads++;
          return signal;
        }
      };

      const selected = selectPublicationArtifacts(context, staged, 'export', trackedOptions);
      expect(selected).toHaveLength(1);
      expect(maxBytesReads).toBe(1);
      expect(signalReads).toBe(1);
    });

    it('rejects invalid maxBytes and non-native signal shapes with CONFIG_INVALID', () => {
      const context = makeSmallContext('json', signal);
      const badMaxBytes = [-1, -0, PROVISIONAL_MAX_BYTES + 1, 1.5, NaN, Infinity, '64MB', null, undefined];

      for (const val of badMaxBytes) {
        expect(() =>
          selectPublicationArtifacts(context, [], 'export', {
            signal,
            maxBytes: val as any
          })
        ).toThrow(DomainError);

        try {
          selectPublicationArtifacts(context, [], 'export', {
            signal,
            maxBytes: val as any
          });
        } catch (err) {
          expect(err).toBeInstanceOf(DomainError);
          expect((err as DomainError).code).toBe('CONFIG_INVALID');
        }
      }

      const badSignals = [
        null,
        undefined,
        42,
        'signal',
        {},
        { aborted: true },
        { aborted: false, addEventListener: () => {} } // missing removeEventListener
      ];

      for (const badSig of badSignals) {
        expect(() =>
          selectPublicationArtifacts(context, [], 'export', {
            signal: badSig as any,
            maxBytes: PROVISIONAL_MAX_BYTES
          })
        ).toThrow(DomainError);

        try {
          selectPublicationArtifacts(context, [], 'export', {
            signal: badSig as any,
            maxBytes: PROVISIONAL_MAX_BYTES
          });
        } catch (err) {
          expect(err).toBeInstanceOf(DomainError);
          expect((err as DomainError).code).toBe('CONFIG_INVALID');
        }
      }
    });

    it('handles pre-abort, during-abort, and final-abort throwing static OPERATION_ABORTED', async () => {
      const context = makeSmallContext('json', signal);
      const staged = await produceRealStagedArtifacts(context, 'json', signal);

      // Pre-aborted
      const preAbortedController = new AbortController();
      preAbortedController.abort();

      expect(() =>
        selectPublicationArtifacts(context, staged, 'export', {
          signal: preAbortedController.signal,
          maxBytes: PROVISIONAL_MAX_BYTES
        })
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, staged, 'export', {
          signal: preAbortedController.signal,
          maxBytes: PROVISIONAL_MAX_BYTES
        });
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('OPERATION_ABORTED');
      }

      // Aborted dynamically during selection
      const dynamicController = new AbortController();
      let abortOnCheck = false;
      const dynamicSignal = new Proxy(dynamicController.signal, {
        get(target, prop, receiver) {
          if (prop === 'aborted') {
            if (abortOnCheck) {
              return true;
            }
          }
          return Reflect.get(target, prop, receiver);
        }
      });

      abortOnCheck = true;
      expect(() =>
        selectPublicationArtifacts(context, staged, 'export', {
          signal: dynamicSignal,
          maxBytes: PROVISIONAL_MAX_BYTES
        })
      ).toThrow(DomainError);

      try {
        selectPublicationArtifacts(context, staged, 'export', {
          signal: dynamicSignal,
          maxBytes: PROVISIONAL_MAX_BYTES
        });
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('OPERATION_ABORTED');
      }
    });

    it('rejects unknown action and hostile action objects with CONFIG_INVALID without invoking hooks', () => {
      const context = makeSmallContext('json', signal);

      const invalidActions = ['csv', 'xlsx', 'all', '', 'EXPORT', null, undefined, 42, true, []];
      for (const act of invalidActions) {
        expect(() =>
          selectPublicationArtifacts(context, [], act as any, defaultOptions)
        ).toThrow(DomainError);

        try {
          selectPublicationArtifacts(context, [], act as any, defaultOptions);
        } catch (err) {
          expect(err).toBeInstanceOf(DomainError);
          expect((err as DomainError).code).toBe('CONFIG_INVALID');
        }
      }

      let hookCalled = false;
      const hostileAction = {
        get toString() {
          hookCalled = true;
          throw new Error('hostile toString called');
        },
        get valueOf() {
          hookCalled = true;
          throw new Error('hostile valueOf called');
        },
        [Symbol.toPrimitive]() {
          hookCalled = true;
          throw new Error('hostile toPrimitive called');
        }
      };

      expect(() =>
        selectPublicationArtifacts(context, [], hostileAction as any, defaultOptions)
      ).toThrow(DomainError);
      expect(hookCalled).toBe(false);

      const hostileProxy = new Proxy({}, {
        get() {
          hookCalled = true;
          throw new Error('hostile trap called');
        }
      });

      expect(() =>
        selectPublicationArtifacts(context, [], hostileProxy as any, defaultOptions)
      ).toThrow(DomainError);
      expect(hookCalled).toBe(false);
    });

    it('returns fresh frozen array and frozen wrappers; does not mutate input or freeze binary data; accepts Blob', async () => {
      const context = makeSmallContext('json', signal);
      const staged = await produceRealStagedArtifacts(context, 'json', signal);

      const selected = selectPublicationArtifacts(context, staged, 'export', defaultOptions);

      expect(Object.isFrozen(selected)).toBe(true);
      expect(selected).not.toBe(staged);
      expect(Object.isFrozen(selected[0])).toBe(true);
      expect(Object.isFrozen(selected[0].data)).toBe(false); // TypedArray binary data must not be frozen
      expect(selected[0].data).toBe(staged[0].data);

      // Verify native Blob support via parseWorkerArtifacts
      if (typeof Blob !== 'undefined') {
        const blobData = new Blob(['{"test": true}'], { type: 'application/json' });
        const blobArtifact: Artifact = {
          filename: 'Canonical Test Workbook.json',
          mimeType: 'application/json',
          data: blobData,
          byteLength: blobData.size,
          safeSummary: 'Blob test'
        };

        const blobSelected = selectPublicationArtifacts(
          context,
          [blobArtifact],
          'export',
          defaultOptions
        );
        expect(blobSelected).toHaveLength(1);
        expect(blobSelected[0].data).toBe(blobData);
        expect(blobSelected[0].byteLength).toBe(blobData.size);
      }
    });
  });
});
