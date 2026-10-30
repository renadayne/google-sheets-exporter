import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSyntheticWorkbookFixture, NAME_EDGE_CASES } from '../src/fixtures.js';
import {
  writeXlsxArtifact,
  writeCsvZipArtifact,
  buildNameMappings
} from '../src/writer-core.js';
import { verifyArtifacts } from './verify-artifacts.mjs';

const artifactsDir = resolve(import.meta.dirname, '../artifacts');
mkdirSync(artifactsDir, { recursive: true });

const fixture = createSyntheticWorkbookFixture();
const xlsxRes = await writeXlsxArtifact(fixture);
const zipRes = writeCsvZipArtifact(fixture);

const xlsxPath = resolve(artifactsDir, 'node-synthetic-3tab.xlsx');
const zipPath = resolve(artifactsDir, 'node-synthetic-3tab-csv.zip');
writeFileSync(xlsxPath, xlsxRes.xlsxBytes);
writeFileSync(zipPath, zipRes.zipBytes);

const verification = verifyArtifacts({
  xlsxBytes: xlsxRes.xlsxBytes,
  zipBytes: zipRes.zipBytes,
  label: 'node-spike'
});

const nameEdgeMappings = buildNameMappings(
  NAME_EDGE_CASES.map((s, idx) => ({ ...s, index: idx }))
);

console.log(
  JSON.stringify(
    {
      status: 'PASS',
      mode: 'node',
      xlsxByteLength: xlsxRes.xlsxBytes.byteLength,
      xlsxElapsedMs: Number(xlsxRes.elapsedMs.toFixed(2)),
      zipByteLength: zipRes.zipBytes.byteLength,
      csvUncompressedByteLength: zipRes.totalUncompressedBytes,
      zipElapsedMs: Number(zipRes.elapsedMs.toFixed(2)),
      verification,
      nameEdgeMappings
    },
    null,
    2
  )
);
