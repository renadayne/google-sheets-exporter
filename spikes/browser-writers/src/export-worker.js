import { createSyntheticWorkbookFixture, NAME_EDGE_CASES } from './fixtures.js';
import {
  writeXlsxArtifact,
  writeCsvZipArtifact,
  buildNameMappings,
  validateXlsxRepresentability
} from './writer-core.js';

function getWorkerMemorySnapshot() {
  if (typeof performance !== 'undefined' && performance.memory) {
    return {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
    };
  }
  return null;
}

function runGuardChecks() {
  const dummySheet = { id: 999, title: 'GuardSheet' };
  const checks = [];

  const cases = [
    {
      name: 'over_max_string_32768',
      cell: { r: 0, c: 0, kind: 'string', value: 'A'.repeat(32768) },
      expectedCode: 'XLSX_LIMIT_STRING_LENGTH'
    },
    {
      name: 'xml_invalid_null_char',
      cell: { r: 0, c: 0, kind: 'string', value: 'bad\u0000char' },
      expectedCode: 'XLSX_INVALID_XML_CHAR'
    },
    {
      name: 'over_max_row_1048576',
      cell: { r: 1048576, c: 0, kind: 'number', value: 1 },
      expectedCode: 'XLSX_LIMIT_DIMENSIONS'
    },
    {
      name: 'over_max_col_16384',
      cell: { r: 0, c: 16384, kind: 'number', value: 1 },
      expectedCode: 'XLSX_LIMIT_DIMENSIONS'
    },
    {
      name: 'non_finite_number',
      cell: { r: 0, c: 0, kind: 'number', value: Number.NaN },
      expectedCode: 'XLSX_INVALID_NUMBER'
    }
  ];

  for (const tc of cases) {
    let rejected = false;
    let message = '';
    try {
      validateXlsxRepresentability(dummySheet, tc.cell);
    } catch (err) {
      rejected = true;
      message = err instanceof Error ? err.message : String(err);
    }
    checks.push({
      name: tc.name,
      rejected,
      matchedExpectedCode: message.includes(tc.expectedCode),
      message
    });
  }

  return checks;
}

self.addEventListener('message', async event => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'RUN_SYNTHETIC_SPIKE') {
    try {
      const memBefore = getWorkerMemorySnapshot();
      const fixture = createSyntheticWorkbookFixture();

      const xlsxResult = await writeXlsxArtifact(fixture);
      const memAfterXlsx = getWorkerMemorySnapshot();

      const csvZipResult = writeCsvZipArtifact(fixture);
      const memAfterZip = getWorkerMemorySnapshot();

      const nameEdgeMappings = buildNameMappings(
        NAME_EDGE_CASES.map((s, idx) => ({ ...s, index: idx }))
      );
      const guardChecks = runGuardChecks();

      const xlsxBuffer = xlsxResult.xlsxBytes.buffer.slice(
        xlsxResult.xlsxBytes.byteOffset,
        xlsxResult.xlsxBytes.byteOffset + xlsxResult.xlsxBytes.byteLength
      );
      const zipBuffer = csvZipResult.zipBytes.buffer.slice(
        csvZipResult.zipBytes.byteOffset,
        csvZipResult.zipBytes.byteOffset + csvZipResult.zipBytes.byteLength
      );

      self.postMessage(
        {
          type: 'SPIKE_COMPLETE',
          jobId: msg.jobId,
          xlsxBuffer,
          zipBuffer,
          metrics: {
            xlsxElapsedMs: Number(xlsxResult.xlsxElapsedMs ?? xlsxResult.elapsedMs).toFixed(2),
            xlsxByteLength: xlsxBuffer.byteLength,
            csvZipElapsedMs: Number(csvZipResult.elapsedMs).toFixed(2),
            csvZipByteLength: zipBuffer.byteLength,
            csvUncompressedByteLength: csvZipResult.totalUncompressedBytes,
            memBefore,
            memAfterXlsx,
            memAfterZip
          },
          nameMappings: xlsxResult.nameMappings,
          nameEdgeMappings,
          manifest: csvZipResult.manifest,
          guardChecks
        },
        [xlsxBuffer, zipBuffer]
      );
    } catch (err) {
      self.postMessage({
        type: 'SPIKE_ERROR',
        jobId: msg.jobId,
        error: err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err)
      });
    }
  } else if (msg.type === 'RUN_HEAVY_FOR_CANCEL') {
    self.postMessage({ type: 'HEAVY_STARTED', jobId: msg.jobId });
    const cells = [];
    for (let r = 0; r < 50000; r++) {
      for (let c = 0; c < 5; c++) {
        cells.push({ r, c, kind: 'string', value: `Cell_${r}_${c}_${'payload'.repeat(5)}` });
      }
    }
    const heavyFixture = {
      source: { id: 'heavy', title: 'Heavy', locale: 'en_US', timeZone: 'UTC' },
      startedAt: '2026-10-30T17:00:00.000Z',
      producedAt: '2026-10-30T17:00:05.000Z',
      mode: 'raw',
      visibility: 'include_all',
      limitsVersion: 'v1-spike',
      sheets: [
        {
          id: 1,
          title: 'HeavySheet',
          index: 0,
          scope: { r0: 0, c0: 0, r1: 50000, c1: 5 },
          exclusions: { excludedRows: [], excludedColumns: [] },
          cells
        }
      ]
    };
    const res = await writeXlsxArtifact(heavyFixture);
    self.postMessage({
      type: 'HEAVY_COMPLETE',
      jobId: msg.jobId,
      byteLength: res.xlsxBytes.byteLength
    });
  }
});
