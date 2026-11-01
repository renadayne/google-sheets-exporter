import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rmdir, rm, writeFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import reportSchema from '../../src/contracts/report.schema.json';
import exportSchema from '../../src/contracts/export.schema.json';
import { isExportReport, isJsonExportDocument, isCell } from '../../src/contracts/validation.ts';
import { validateReport, validateExport, validateCell } from '../../src/contracts/generated/validators.js';
import type { Cell } from '../../src/contracts/domain.ts';
import { generateValidators } from '../../scripts/generate-validators.mjs';

import rawMultiTabFixture from '../fixtures/exports/raw-multitab.json';
import formattedStringsFixture from '../fixtures/exports/formatted-strings.json';
import formulaTextFixture from '../fixtures/exports/formula-text.json';
import metadataReportFixture from '../fixtures/exports/metadata-report-only.json';

import {
  createCanonicalExportReport,
  createCanonicalJsonExportDocument
} from '../helpers/fixtures.ts';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../..');

async function removeGeneratedTemp(tempDir: string): Promise<void> {
  for (const filename of ['validators.js', 'validators.d.ts']) {
    await rm(resolve(tempDir, filename), { force: true });
  }
  // Remove only the now-empty directory; never recursively delete an arbitrary tree.
  await rmdir(tempDir);
}

function createDevValidator() {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false
  });
  addFormats(ajv);
  ajv.addSchema(reportSchema).addSchema(exportSchema);

  const devValidateReport = ajv.getSchema('urn:google-sheets-exporter:report.schema.json')!;
  const devValidateExport = ajv.getSchema('urn:google-sheets-exporter:export.schema.json')!;

  const devValidateCell = ajv.getSchema('urn:google-sheets-exporter:export.schema.json#/$defs/cell')!;

  return { devValidateReport, devValidateExport, devValidateCell };
}

describe('T24a Precompiled Static Schema Validation Infrastructure', () => {
  const { devValidateReport, devValidateExport, devValidateCell } = createDevValidator();

  describe('Guard acceptance on valid fixtures', () => {
    it('accepts metadata-only report with isExportReport, rejects with isJsonExportDocument', () => {
      expect(isExportReport(metadataReportFixture)).toBe(true);
      expect(isJsonExportDocument(metadataReportFixture)).toBe(false);
    });

    it('accepts raw multi-tab fixture with isJsonExportDocument, rejects with isExportReport', () => {
      expect(isJsonExportDocument(rawMultiTabFixture)).toBe(true);
      expect(isExportReport(rawMultiTabFixture)).toBe(false);
    });

    it('accepts formatted-strings fixture with isJsonExportDocument, rejects with isExportReport', () => {
      expect(isJsonExportDocument(formattedStringsFixture)).toBe(true);
      expect(isExportReport(formattedStringsFixture)).toBe(false);
    });

    it('accepts formula-text fixture with isJsonExportDocument, rejects with isExportReport', () => {
      expect(isJsonExportDocument(formulaTextFixture)).toBe(true);
      expect(isExportReport(formulaTextFixture)).toBe(false);
    });

    it('accepts canonical T10a ExportReport with isExportReport, rejects with isJsonExportDocument', () => {
      const canonicalReport = createCanonicalExportReport();
      expect(isExportReport(canonicalReport)).toBe(true);
      expect(isJsonExportDocument(canonicalReport)).toBe(false);
    });

    it('accepts canonical T10a JsonExportDocument with isJsonExportDocument, rejects with isExportReport', () => {
      const canonicalExport = createCanonicalJsonExportDocument();
      expect(isJsonExportDocument(canonicalExport)).toBe(true);
      expect(isExportReport(canonicalExport)).toBe(false);
    });

    it('accepts representative valid cells across all 4 Cell kinds with isCell', () => {
      const stringCell: Cell = { r: 0, c: 0, kind: 'string', value: 'hello' };
      const stringCellWithFormula: Cell = {
        r: 0,
        c: 1,
        kind: 'string',
        value: '=SUM(A1:A10)',
        formulaText: '=SUM(A1:A10)',
        numberFormatType: 'TEXT'
      };
      const numberCell: Cell = { r: 1, c: 0, kind: 'number', value: 42, numberFormatType: 'CURRENCY' };
      const booleanCellTrue: Cell = { r: 2, c: 0, kind: 'boolean', value: true };
      const booleanCellFalse: Cell = { r: 2, c: 1, kind: 'boolean', value: false };
      const errorCell: Cell = {
        r: 3,
        c: 0,
        kind: 'error',
        value: { code: '#DIV/0!', message: 'Division by zero' }
      };

      for (const cell of [stringCell, stringCellWithFormula, numberCell, booleanCellTrue, booleanCellFalse, errorCell]) {
        expect(isCell(cell)).toBe(true);
        expect(Boolean(devValidateCell(cell))).toBe(true);
      }
    });
  });

  describe('Representative mutations with dev-only Ajv parity', () => {
    function assertExportParity(candidate: unknown) {
      const expected = Boolean(devValidateExport(candidate));
      const actual = isJsonExportDocument(candidate);
      expect(actual).toBe(expected);
      return actual;
    }

    function assertReportParity(candidate: unknown) {
      const expected = Boolean(devValidateReport(candidate));
      const actual = isExportReport(candidate);
      expect(actual).toBe(expected);
      return actual;
    }

    function assertCellParity(candidate: unknown) {
      const expected = Boolean(devValidateCell(candidate));
      const actual = isCell(candidate);
      expect(actual).toBe(expected);
      return actual;
    }

    it('rejects authentication / credentials and unexpected extra root fields', () => {
      const base = createCanonicalJsonExportDocument();
      const withAuth = { ...base, credentials: { token: 'secret' } };
      const withSourceToken = {
        ...base,
        source: { ...base.source, token: 'leak' }
      };
      const withExtra = { ...base, unexpectedField: true };

      expect(assertExportParity(withAuth)).toBe(false);
      expect(assertExportParity(withSourceToken)).toBe(false);
      expect(assertExportParity(withExtra)).toBe(false);

      const reportBase = createCanonicalExportReport();
      const reportWithAuth = { ...reportBase, auth: 'bearer xyz' };
      expect(assertReportParity(reportWithAuth)).toBe(false);
    });

    it('rejects unsupported schema versions', () => {
      const base = createCanonicalJsonExportDocument();
      const v2 = { ...base, schemaVersion: '2.0' };
      const v09 = { ...base, schemaVersion: '0.9' };
      const numeric = { ...base, schemaVersion: 1 };

      expect(assertExportParity(v2)).toBe(false);
      expect(assertExportParity(v09)).toBe(false);
      expect(assertExportParity(numeric)).toBe(false);
    });

    it('rejects missing or empty scopes and sheets', () => {
      const base = createCanonicalJsonExportDocument();
      const emptyScopes = { ...base, selectedScopes: [] };
      const emptySheets = { ...base, sheets: [] };
      const noSheets = { ...base } as Record<string, unknown>;
      delete noSheets.sheets;

      expect(assertExportParity(emptyScopes)).toBe(false);
      expect(assertExportParity(emptySheets)).toBe(false);
      expect(assertExportParity(noSheets)).toBe(false);
    });

    it('rejects incomplete export or unpermitted change detection', () => {
      const base = createCanonicalJsonExportDocument();
      const incomplete = {
        ...base,
        export: { ...base.export, complete: false }
      };
      const changesDetected = {
        ...base,
        export: { ...base.export, consistency: 'not_atomic_changes_detected' }
      };

      expect(assertExportParity(incomplete)).toBe(false);
      expect(assertExportParity(changesDetected)).toBe(false);
    });

    it('rejects wrong scalar types (no type coercion)', () => {
      const base = createCanonicalJsonExportDocument();
      const stringSheetId = {
        ...base,
        sheetOrder: ['0']
      };
      const numberLimitsVersion = {
        ...base,
        limitsVersion: 100
      };

      expect(assertExportParity(stringSheetId)).toBe(false);
      expect(assertExportParity(numberLimitsVersion)).toBe(false);

      // Wrong type in cell: string value on number cell
      const badCell = {
        ...base,
        sheets: [
          {
            ...base.sheets[0],
            cells: [{ r: 0, c: 0, kind: 'number', value: '42' }]
          }
        ]
      };
      expect(assertExportParity(badCell)).toBe(false);
    });

    it('rejects non-serializable / non-JSON values (NaN, Date objects)', () => {
      const base = createCanonicalJsonExportDocument();
      const nanCell = {
        ...base,
        sheets: [
          {
            ...base.sheets[0],
            cells: [{ r: 0, c: 0, kind: 'number', value: NaN }]
          }
        ]
      };
      const dateCell = {
        ...base,
        sheets: [
          {
            ...base.sheets[0],
            cells: [{ r: 0, c: 0, kind: 'number', value: new Date() }]
          }
        ]
      };

      expect(assertExportParity(nanCell)).toBe(false);
      expect(assertExportParity(dateCell)).toBe(false);
    });

    it('rejects forbidden formulaText in raw / formatted modes and non-string cells', () => {
      // In raw mode, formulaText is forbidden by conditional schema
      const rawWithFormula = {
        ...rawMultiTabFixture,
        sheets: [
          {
            ...rawMultiTabFixture.sheets[0],
            cells: [
              ...rawMultiTabFixture.sheets[0].cells,
              { r: 0, c: 1, kind: 'string', value: '=A1', formulaText: '=A1' }
            ]
          },
          ...rawMultiTabFixture.sheets.slice(1)
        ]
      };
      expect(assertExportParity(rawWithFormula)).toBe(false);

      // In formatted mode, all cells must be kind: string and formulaText is forbidden
      const formattedWithFormula = {
        ...formattedStringsFixture,
        sheets: [
          {
            ...formattedStringsFixture.sheets[0],
            cells: [
              { r: 0, c: 0, kind: 'string', value: 'Hello', formulaText: '=A1' }
            ]
          }
        ]
      };
      expect(assertExportParity(formattedWithFormula)).toBe(false);

      // In formula_text mode, formulaText on a number cell is forbidden
      const formulaTextOnNumber = {
        ...formulaTextFixture,
        sheets: [
          {
            ...formulaTextFixture.sheets[0],
            cells: [
              { r: 0, c: 0, kind: 'number', value: 42, formulaText: '=40+2' }
            ]
          }
        ]
      };
      expect(assertExportParity(formulaTextOnNumber)).toBe(false);
    });

    it('rejects invalid timestamps and calendar values', () => {
      const base = createCanonicalJsonExportDocument();
      const noZ = {
        ...base,
        export: { ...base.export, startedAt: '2026-10-31T00:00:00.000' }
      };
      const tzOffset = {
        ...base,
        export: { ...base.export, startedAt: '2026-10-31T00:00:00.000+05:00' }
      };
      const invalidCal = {
        ...base,
        export: { ...base.export, startedAt: '2026-02-31T00:00:00.000Z' }
      };
      const gibberish = {
        ...base,
        export: { ...base.export, startedAt: 'invalid-date' }
      };

      expect(assertExportParity(noZ)).toBe(false);
      expect(assertExportParity(tzOffset)).toBe(false);
      expect(assertExportParity(invalidCal)).toBe(false);
      expect(assertExportParity(gibberish)).toBe(false);
    });

    it('rejects invalid cells: missing fields, wrong types, NaN, Date, numeric formulaText, extra accessToken', () => {
      // Missing required properties
      expect(assertCellParity({ c: 0, kind: 'string', value: 'no r' })).toBe(false);
      expect(assertCellParity({ r: 0, kind: 'string', value: 'no c' })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, value: 'no kind' })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, kind: 'string' })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, kind: 'error', value: { code: '#REF!' } })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, kind: 'error', value: { message: 'err' } })).toBe(false);

      // Wrong type / out of bounds
      expect(assertCellParity({ r: -1, c: 0, kind: 'string', value: 'neg r' })).toBe(false);
      expect(assertCellParity({ r: 0, c: -1, kind: 'string', value: 'neg c' })).toBe(false);
      expect(assertCellParity({ r: 1.5, c: 0, kind: 'string', value: 'float r' })).toBe(false);
      expect(assertCellParity({ r: '0', c: 0, kind: 'string', value: 'string r' })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, kind: 'unknown', value: 'bad kind' })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, kind: 'string', value: 123 })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, kind: 'number', value: '123' })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, kind: 'boolean', value: 'true' })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, kind: 'error', value: '#VALUE!' })).toBe(false);

      // Non-serializable / non-JSON values (NaN, Date objects)
      expect(assertCellParity({ r: 0, c: 0, kind: 'number', value: NaN })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, kind: 'number', value: new Date() })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, kind: 'string', value: new Date() })).toBe(false);

      // Numeric formulaText: formulaText is forbidden on number cells
      expect(assertCellParity({ r: 0, c: 0, kind: 'number', value: 42, formulaText: '=40+2' })).toBe(false);

      // Extra unpermitted fields / credentials
      expect(assertCellParity({ r: 0, c: 0, kind: 'string', value: 'secret', accessToken: 'ya29.xyz' })).toBe(false);
      expect(assertCellParity({ r: 0, c: 0, kind: 'number', value: 1, extraField: true })).toBe(false);
    });
  });

  describe('Non-mutation and safe error containment', () => {
    it('does not mutate input documents during validation', () => {
      const original = createCanonicalJsonExportDocument();
      const snapshot = JSON.parse(JSON.stringify(original));

      expect(isJsonExportDocument(original)).toBe(true);
      expect(original).toEqual(snapshot);

      const invalidCandidate = {
        ...original,
        extraProperty: 'should-not-be-deleted'
      };
      const invalidSnapshot = JSON.parse(JSON.stringify(invalidCandidate));

      expect(isJsonExportDocument(invalidCandidate)).toBe(false);
      expect(invalidCandidate).toEqual(invalidSnapshot);
    });

    it('resets generated validator .errors after checking', () => {
      const invalidCandidate = { schemaVersion: 'bogus' };

      expect(isExportReport(invalidCandidate)).toBe(false);
      expect(validateReport.errors).toBeNull();

      expect(isJsonExportDocument(invalidCandidate)).toBe(false);
      expect(validateExport.errors).toBeNull();
    });

    it('safely catches hostile property getter detonations without throwing', () => {
      const hostileReport = {
        get schemaVersion() {
          throw new Error('Hostile getter detonation in schemaVersion');
        }
      };

      expect(() => isExportReport(hostileReport)).not.toThrow();
      expect(isExportReport(hostileReport)).toBe(false);
      expect(validateReport.errors).toBeNull();

      const hostileDoc = {
        get export() {
          throw new Error('Hostile getter detonation in export');
        }
      };

      expect(() => isJsonExportDocument(hostileDoc)).not.toThrow();
      expect(isJsonExportDocument(hostileDoc)).toBe(false);
      expect(validateExport.errors).toBeNull();
    });

    it('does not mutate input cell or coerce types during validation', () => {
      const validCell = { r: 0, c: 0, kind: 'string', value: 'keep-original' };
      const validSnapshot = JSON.parse(JSON.stringify(validCell));
      expect(isCell(validCell)).toBe(true);
      expect(validCell).toEqual(validSnapshot);

      const invalidCell = { r: 0, c: 0, kind: 'number', value: '42' };
      const invalidSnapshot = JSON.parse(JSON.stringify(invalidCell));
      expect(isCell(invalidCell)).toBe(false);
      expect(invalidCell).toEqual(invalidSnapshot);
      // Source strings unchanged: no string-to-number coercion occurred
      expect(typeof invalidCell.value).toBe('string');
    });

    it('resets generated validator .errors after checking cells', () => {
      const invalidCell = { r: 'invalid', c: 0 };
      expect(isCell(invalidCell)).toBe(false);
      expect(validateCell.errors).toBeNull();
    });

    it('safely catches hostile property getter detonations on cell without throwing', () => {
      let reads = 0;
      const hostileCell = {
        r: 0,
        c: 0,
        kind: 'string',
        get value() {
          reads++;
          throw new Error('Hostile getter detonation in cell value');
        }
      };

      expect(() => isCell(hostileCell)).not.toThrow();
      expect(isCell(hostileCell)).toBe(false);
      expect(reads).toBeGreaterThan(0);
      expect(validateCell.errors).toBeNull();
    });
  });

  describe('Deterministic generation and --check stale detection', () => {
    it('generates byte-for-byte identical output across separate runs', async () => {
      await mkdir(resolve(PROJECT_ROOT, '.local'), { recursive: true });
      const tempDir1 = await mkdtemp(resolve(PROJECT_ROOT, '.local', 'schema-test-gen1-'));
      const tempDir2 = await mkdtemp(resolve(PROJECT_ROOT, '.local', 'schema-test-gen2-'));

      try {
        const res1 = await generateValidators({ outDir: tempDir1 });
        const res2 = await generateValidators({ outDir: tempDir2 });

        expect(res1.hash).toBe(res2.hash);

        const check1 = await generateValidators({ check: true, outDir: tempDir1 });
        expect(check1.upToDate).toBe(true);

        const check2 = await generateValidators({ check: true, outDir: tempDir2 });
        expect(check2.upToDate).toBe(true);
      } finally {
        await removeGeneratedTemp(tempDir1);
        await removeGeneratedTemp(tempDir2);
      }
    });

    it('fails check mode when generated validator files are missing or modified', async () => {
      await mkdir(resolve(PROJECT_ROOT, '.local'), { recursive: true });
      const tempDir = await mkdtemp(resolve(PROJECT_ROOT, '.local', 'schema-test-stale-'));

      try {
        await generateValidators({ outDir: tempDir });

        // Modify generated file to simulate stale drift
        const jsFile = resolve(tempDir, 'validators.js');
        await writeFile(jsFile, '// Stale modified content\n', 'utf8');

        await expect(
          generateValidators({ check: true, outDir: tempDir })
        ).rejects.toThrow(/stale/i);

        // Delete file to simulate missing artifact
        await rm(jsFile, { force: true });
        await expect(
          generateValidators({ check: true, outDir: tempDir })
        ).rejects.toThrow(/missing/i);
      } finally {
        await removeGeneratedTemp(tempDir);
      }
    });
  });

  describe('Node child VM execution test (--experimental-vm-modules)', () => {
    it('executes generated validators in a VM with code generation and imports disabled', async () => {
      const helperScript = resolve(PROJECT_ROOT, 'tests/helpers/run-vm-validator.mjs');
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--experimental-vm-modules', helperScript],
        { cwd: PROJECT_ROOT, timeout: 15000 }
      );

      // Parse JSON output from helper
      const jsonLine = stdout
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('{') && l.endsWith('}'))
        .pop();

      expect(jsonLine).toBeDefined();
      const result = JSON.parse(jsonLine!);
      expect(result.ok).toBe(true);
      expect(result.verifiedChecks).toBe(8);
    });
  });
});
