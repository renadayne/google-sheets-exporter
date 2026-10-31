import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import reportSchema from '../../src/contracts/report.schema.json';
import exportSchema from '../../src/contracts/export.schema.json';

import rawMultiTabFixture from '../fixtures/exports/raw-multitab.json';
import formattedStringsFixture from '../fixtures/exports/formatted-strings.json';
import formulaTextFixture from '../fixtures/exports/formula-text.json';
import metadataReportFixture from '../fixtures/exports/metadata-report-only.json';

function createValidator() {
  // Explicitly disable coercion, defaults, and removal of additional properties.
  // Validation must never mutate input objects.
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false
  });
  addFormats(ajv);
  ajv.addSchema(reportSchema);
  ajv.addSchema(exportSchema);

  const validateReport = ajv.getSchema('urn:google-sheets-exporter:report.schema.json')!;
  const validateExport = ajv.getSchema('urn:google-sheets-exporter:export.schema.json')!;

  return { ajv, validateReport, validateExport };
}

describe('T09 Export & Report JSON Schemas (Draft 2020-12)', () => {
  const { validateReport, validateExport } = createValidator();

  describe('Valid synthetic fixtures', () => {
    it('validates raw multi-tab fixture including empty sheet and extreme coordinates', () => {
      const isValid = validateExport(rawMultiTabFixture);
      expect(validateExport.errors).toBeNull();
      expect(isValid).toBe(true);
    });

    it('validates formatted strings fixture where all cells are string projections', () => {
      const isValid = validateExport(formattedStringsFixture);
      expect(validateExport.errors).toBeNull();
      expect(isValid).toBe(true);
    });

    it('validates formula_text fixture with inert expressions and typed nonformula cells', () => {
      const isValid = validateExport(formulaTextFixture);
      expect(validateExport.errors).toBeNull();
      expect(isValid).toBe(true);
    });

    it('validates metadata-only report against report.schema.json', () => {
      const isValid = validateReport(metadataReportFixture);
      expect(validateReport.errors).toBeNull();
      expect(isValid).toBe(true);
    });

    it('enforces composition boundary: report schema rejects document with sheets', () => {
      // report.schema.json is metadata-only; unevaluatedProperties: false rejects sheets
      const isValid = validateReport(rawMultiTabFixture);
      expect(isValid).toBe(false);
      expect(validateReport.errors?.some(e => e.keyword === 'unevaluatedProperties')).toBe(true);
    });

    it('enforces composition boundary: export document requires sheets', () => {
      // export.schema.json requires sheets
      const isValid = validateExport(metadataReportFixture);
      expect(isValid).toBe(false);
      expect(validateExport.errors?.some(e => e.keyword === 'required' && e.params?.missingProperty === 'sheets')).toBe(true);
    });
  });

  describe('Strict immutability (no coercion, defaults, or field removal)', () => {
    it('does not mutate or coerce input objects during validation', () => {
      const clone = JSON.parse(JSON.stringify(rawMultiTabFixture));
      const before = JSON.stringify(clone);
      validateExport(clone);
      const after = JSON.stringify(clone);
      expect(after).toBe(before);
    });

    it('rejects numeric strings when number is expected (no coercion)', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[8].value = '42.5'; // index 8 is D50 number cell
      const isValid = validateExport(doc);
      expect(isValid).toBe(false);
      expect(doc.sheets[0].cells[8].value).toBe('42.5');
    });

    it('rejects boolean strings when boolean is expected (no coercion)', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[9].value = 'true'; // index 9 is Z90000 boolean cell
      const isValid = validateExport(doc);
      expect(isValid).toBe(false);
    });
  });

  describe('Missing completeness and required metadata mutations', () => {
    it('rejects document missing schemaVersion', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      delete doc.schemaVersion;
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects document with unsupported schemaVersion', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.schemaVersion = '2.0';
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects document missing source metadata', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      delete doc.source;
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects document missing selectedScopes', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      delete doc.selectedScopes;
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects document missing sheetOrder', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      delete doc.sheetOrder;
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects document missing limitsVersion', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      delete doc.limitsVersion;
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects document missing nameMappings', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      delete doc.nameMappings;
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects document missing exclusions', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      delete doc.exclusions;
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects document missing sheets array', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      delete doc.sheets;
      expect(validateExport(doc)).toBe(false);
    });
  });

  describe('Auth and credential containment (boundary isolation)', () => {
    it('rejects extra auth fields at top level of export document', () => {
      const doc = {
        ...JSON.parse(JSON.stringify(rawMultiTabFixture)),
        accessToken: 'ya29.sample-secret'
      };
      expect(validateExport(doc)).toBe(false);
      expect(validateExport.errors?.some(e => e.keyword === 'unevaluatedProperties')).toBe(true);
    });

    it('rejects extra auth fields at top level of report metadata', () => {
      const report = {
        ...JSON.parse(JSON.stringify(metadataReportFixture)),
        bearerToken: 'secret'
      };
      expect(validateReport(report)).toBe(false);
      expect(validateReport.errors?.some(e => e.keyword === 'unevaluatedProperties')).toBe(true);
    });

    it('rejects principal or credential fields inside nested source metadata', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.source.principalKey = 'user@example.com';
      expect(validateExport(doc)).toBe(false);
      expect(validateExport.errors?.some(e => e.keyword === 'additionalProperties')).toBe(true);
    });

    it('rejects auth fields inside nested export metadata', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.export.clientSecret = 'super-secret';
      expect(validateExport(doc)).toBe(false);
      expect(validateExport.errors?.some(e => e.keyword === 'additionalProperties')).toBe(true);
    });

    it('rejects extra fields inside sheet metadata', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].userEmail = 'user@example.com';
      expect(validateExport(doc)).toBe(false);
      expect(validateExport.errors?.some(e => e.keyword === 'additionalProperties')).toBe(true);
    });

    it('rejects extra fields inside cell objects', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[0].token = 'leak';
      expect(validateExport(doc)).toBe(false);
      expect(validateExport.errors?.some(e => e.keyword === 'additionalProperties')).toBe(true);
    });

    it('allows legitimate cell string values that resemble tokens or formulas', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      // String value contains token-like text and formula-like text; perfectly valid as cell data
      doc.sheets[0].cells.push({
        r: 6,
        c: 0,
        kind: 'string',
        value: 'ya29.a0AfH6SMB-real-looking-string-data'
      });
      doc.sheets[0].cells.push({
        r: 7,
        c: 0,
        kind: 'string',
        value: '=SUM(A1:B10)'
      });
      expect(validateExport(doc)).toBe(true);
    });
  });

  describe('Scalar and error cell discriminators', () => {
    it('rejects string cell with number value', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[0] = { r: 0, c: 0, kind: 'string', value: 999 };
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects number cell with string value', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[8] = { r: 49, c: 3, kind: 'number', value: '42.5' };
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects boolean cell with non-boolean value', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[9] = { r: 89999, c: 25, kind: 'boolean', value: 1 };
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects error cell where value is string instead of tagged object', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[2] = { r: 2, c: 0, kind: 'error', value: '#DIV/0!' };
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects error cell missing message property', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[2] = { r: 2, c: 0, kind: 'error', value: { code: '#DIV/0!' } };
      expect(validateExport(doc)).toBe(false);
    });

    it('accepts valid tagged error cell with code and message', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[2] = {
        r: 2,
        c: 0,
        kind: 'error',
        value: { code: '#REF!', message: 'Reference does not exist' }
      };
      expect(validateExport(doc)).toBe(true);
    });

    it('preserves numeric serial dates and rejects Date objects or date strings as raw value', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      // index 1 is date serial cell: value is number 45678.5
      expect(doc.sheets[0].cells[1].kind).toBe('number');
      expect(typeof doc.sheets[0].cells[1].value).toBe('number');
      expect(doc.sheets[0].cells[1].numberFormatType).toBe('DATE_TIME');

      doc.sheets[0].cells[1].value = '2026-10-31';
      expect(validateExport(doc)).toBe(false);
      doc.sheets[0].cells[1].value = new Date('2026-10-31T00:00:00Z');
      expect(validateExport(doc)).toBe(false);
    });
  });

  describe('Timestamps and nonfinite numbers', () => {
    it('accepts UTC Z timestamps for client-produced fields', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.export.startedAt = '2026-10-31T12:30:00Z';
      doc.export.producedAt = '2026-10-31T12:30:05.123Z';
      expect(validateExport(doc)).toBe(true);
    });

    it('rejects non-UTC timestamps (with timezone offset) in client-produced fields', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.export.startedAt = '2026-10-31T12:30:00+07:00';
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects malformed date-time strings in timestamps', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.export.startedAt = 'not-a-timestamp';
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects NaN and Infinity in numeric cells', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[8].value = NaN;
      expect(validateExport(doc)).toBe(false);

      doc.sheets[0].cells[8].value = Infinity;
      expect(validateExport(doc)).toBe(false);

      doc.sheets[0].cells[8].value = -Infinity;
      expect(validateExport(doc)).toBe(false);
    });
  });

  describe('Negative and non-integer coordinates', () => {
    it('rejects negative row coordinate', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[0].r = -1;
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects negative col coordinate', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[0].c = -1;
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects float coordinate in cell position', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[0].r = 1.5;
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects negative coordinates in rect scope', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].scope.r0 = -1;
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects negative interval in exclusions', () => {
      const doc = JSON.parse(JSON.stringify(formattedStringsFixture));
      doc.exclusions[0].excludedRows[0].start = -1;
      expect(validateExport(doc)).toBe(false);
    });
  });

  describe('Export completeness and consistency guarantees', () => {
    for (const field of ['sheets', 'selectedScopes', 'sheetOrder', 'nameMappings']) {
      it(`rejects successful output with empty ${field}`, () => {
        const doc = { ...structuredClone(rawMultiTabFixture), [field]: [] };
        expect(validateExport(doc)).toBe(false);
      });
    }

    it('rejects duplicate entries in sheetOrder', () => {
      const doc = { ...structuredClone(rawMultiTabFixture), sheetOrder: [0, 0] };
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects zero exclusive scope endpoints', () => {
      const doc = structuredClone(rawMultiTabFixture);
      doc.sheets[0]!.scope.r1 = 0;
      expect(validateExport(doc)).toBe(false);
    });
    it('rejects export document where complete is false', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.export.complete = false;
      expect(validateExport(doc)).toBe(false);
    });

    it('allows report metadata where complete is false (e.g. incomplete staged job)', () => {
      const report = JSON.parse(JSON.stringify(metadataReportFixture));
      report.export.complete = false;
      expect(validateReport(report)).toBe(true);
    });

    it('rejects export document where consistency is not_atomic_changes_detected', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.export.consistency = 'not_atomic_changes_detected';
      expect(validateExport(doc)).toBe(false);
    });

    it('allows report metadata where consistency is not_atomic_changes_detected', () => {
      const report = JSON.parse(JSON.stringify(metadataReportFixture));
      report.export.consistency = 'not_atomic_changes_detected';
      expect(validateReport(report)).toBe(true);
    });

    it('rejects non-json format in export document', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.export.format = 'csv';
      expect(validateExport(doc)).toBe(false);
    });

    it('allows non-json format in report metadata', () => {
      const report = JSON.parse(JSON.stringify(metadataReportFixture));
      report.export.format = 'xlsx';
      expect(validateReport(report)).toBe(true);
    });
  });

  describe('Mode projection rules and formulaText leak prevention', () => {
    it('rejects computed number cells carrying formulaText in formula_text output', () => {
      const doc = JSON.parse(JSON.stringify(formulaTextFixture));
      doc.sheets[0].cells[0] = { r: 0, c: 0, kind: 'number', value: 55, formulaText: '=SUM(B1:B10)' };
      expect(validateExport(doc)).toBe(false);
    });
    it('rejects formulaText property on cells in raw mode', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      doc.sheets[0].cells[0].formulaText = '=SUM(A1:B10)';
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects formulaText property on cells in formatted mode', () => {
      const doc = JSON.parse(JSON.stringify(formattedStringsFixture));
      doc.sheets[0].cells[0].formulaText = '=SUM(A1:B10)';
      expect(validateExport(doc)).toBe(false);
    });

    it('rejects non-string cells in formatted mode (formatted cells are strings)', () => {
      const doc = JSON.parse(JSON.stringify(formattedStringsFixture));
      doc.sheets[0].cells.push({
        r: 10,
        c: 0,
        kind: 'number',
        value: 123
      });
      expect(validateExport(doc)).toBe(false);
    });

    it('allows formulaText on formula cells in formula_text mode', () => {
      const doc = JSON.parse(JSON.stringify(formulaTextFixture));
      expect(doc.sheets[0].cells[0].formulaText).toBe('=SUM(B1:B10)');
      expect(validateExport(doc)).toBe(true);
    });

    it('allows nonformula typed cells without formulaText in formula_text mode', () => {
      const doc = JSON.parse(JSON.stringify(formulaTextFixture));
      // index 2 is number, index 3 is boolean, index 4 is string, index 5 is error
      expect(doc.sheets[0].cells[2].kind).toBe('number');
      expect(doc.sheets[0].cells[2].formulaText).toBeUndefined();
      expect(validateExport(doc)).toBe(true);
    });

    it('does not reject ordinary formula-like source strings in raw mode', () => {
      const doc = JSON.parse(JSON.stringify(rawMultiTabFixture));
      // index 4 has value "=SUM(A1:B10)" with kind "string" and no formulaText
      expect(doc.sheets[0].cells[4].value).toBe('=SUM(A1:B10)');
      expect(doc.sheets[0].cells[4].formulaText).toBeUndefined();
      expect(validateExport(doc)).toBe(true);
    });
  });
});
