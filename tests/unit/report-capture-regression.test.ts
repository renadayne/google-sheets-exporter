import { describe, it, expect } from 'vitest';
import { DomainError } from '../../src/contracts/errors.ts';
import { snapshotWriterContext } from '../../src/export/context.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import { buildCompleteExportReport } from '../../src/export/report.ts';
import { createCanonicalExportReport, createCanonicalWriterContext } from '../helpers/fixtures.ts';

describe('report input capture', () => {
  it('cannot copy a different source id after validating the original source', () => {
    const signal = new AbortController().signal;
    const context = snapshotWriterContext(createCanonicalWriterContext(), { maxSheets: 10, signal });
    const prepared = prepareWriterData(context, context.scopes.map((scope, i) => ({
      jobId: 'capture-test', chunkId: `chunk-${i}`, rect: scope.rect, cells: [],
      excludedIntervals: { rows: [], columns: [] }, byteCount: 0
    })), { maxChunks: 10, maxCells: 10, maxIntervals: 10, signal });
    const options = { maxWarnings: 10, signal };
    const baseline = buildCompleteExportReport(context, prepared, createCanonicalExportReport(), options);
    for (let cutoff = 1; cutoff <= 16; cutoff++) {
      const input = structuredClone(baseline);
      let reads = 0;
      Object.defineProperty(input.source, 'id', { enumerable: true, get() {
        return ++reads <= cutoff ? context.sourceId : 'different-source-after-validation';
      } });
      let output;
      try {
        output = buildCompleteExportReport(context, prepared, input, options);
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe('FORMAT_SERIALIZATION_FAILED');
      }
      expect(reads).toBe(0);
      if (output) expect(output.source.id).toBe(context.sourceId);
    }
  });
});
