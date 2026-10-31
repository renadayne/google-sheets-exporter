import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import reportSchema from '../../src/contracts/report.schema.json';
import exportSchema from '../../src/contracts/export.schema.json';

import {
  CANONICAL_SPREADSHEET_ID,
  CANONICAL_PRINCIPAL_KEY,
  CANONICAL_DISPLAY_EMAIL,
  CANONICAL_EVIDENCE_REVISION,
  CANONICAL_LIMITS_VERSION,
  CANONICAL_SPARSE_SHEET_ID,
  CANONICAL_EMPTY_SHEET_ID,
  CANONICAL_HIDDEN_SHEET_ID,
  CANONICAL_SPARSE_RAW_ORACLE_CELLS,
  createCanonicalSparseRawOracleCells,
  createCanonicalWorkbookMeta,
  createCanonicalSourceRef,
  createSyntheticAccountContext,
  createSyntheticPermittedEligibility,
  createCanonicalExportRequest,
  createCanonicalWriterContext,
  createCanonicalExportReport,
  createCanonicalJsonExportDocument,
  createMultisheetGridTransportPayload,
  createUnavailableVisibilityGridTransportPayload,
  REVIEWED_FIXTURE_CATALOG
} from '../helpers/fixtures.ts';

function createValidator() {
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

  return { validateReport, validateExport };
}

describe('T10a Shared Synthetic Fixtures and Oracle Catalog', () => {
  const { validateReport, validateExport } = createValidator();

  describe('1. Canonical 3-tab WorkbookMeta', () => {
    it('provides exactly 3 sheets in strict source index order', () => {
      const wb = createCanonicalWorkbookMeta();
      expect(wb.sheets).toHaveLength(3);

      expect(wb.sheets[0].index).toBe(0);
      expect(wb.sheets[1].index).toBe(1);
      expect(wb.sheets[2].index).toBe(2);
    });

    it('has stable NON-consecutive IDs ensuring id is distinct from index', () => {
      const wb = createCanonicalWorkbookMeta();

      expect(wb.sheets[0].id).toBe(CANONICAL_SPARSE_SHEET_ID); // 101
      expect(wb.sheets[1].id).toBe(CANONICAL_EMPTY_SHEET_ID);  // 205
      expect(wb.sheets[2].id).toBe(CANONICAL_HIDDEN_SHEET_ID); // 309

      // Ensure IDs are strictly non-consecutive
      expect(wb.sheets[1].id - wb.sheets[0].id).toBeGreaterThan(1);
      expect(wb.sheets[2].id - wb.sheets[1].id).toBeGreaterThan(1);

      // Ensure id != index for all sheets
      for (const sheet of wb.sheets) {
        expect(sheet.id).not.toBe(sheet.index);
      }
    });

    it('configures visibility and sheet types accurately', () => {
      const wb = createCanonicalWorkbookMeta();

      // Tab 0: visible populated sparse tab
      expect(wb.sheets[0].title).toBe('SparseTab');
      expect(wb.sheets[0].type).toBe('GRID');
      expect(wb.sheets[0].hidden).toBe(false);

      // Tab 1: visible empty tab
      expect(wb.sheets[1].title).toBe('EmptyTab');
      expect(wb.sheets[1].type).toBe('GRID');
      expect(wb.sheets[1].hidden).toBe(false);

      // Tab 2: hidden tab
      expect(wb.sheets[2].title).toBe('HiddenTab');
      expect(wb.sheets[2].type).toBe('GRID');
      expect(wb.sheets[2].hidden).toBe(true);
    });

    it('allocates full dimensions containing Z90000 on sparse tab', () => {
      const wb = createCanonicalWorkbookMeta();
      const sparseSheet = wb.sheets[0];

      expect(sparseSheet.rows).toBe(90000);
      expect(sparseSheet.columns).toBe(26);

      // Z is column index 25 (< 26), row 90000 is index 89999 (< 90000)
      const zColIndex = 25;
      const row90000Index = 89999;
      expect(row90000Index).toBeLessThan(sparseSheet.rows!);
      expect(zColIndex).toBeLessThan(sparseSheet.columns!);
    });

    it('includes positive dimensions for all grid sheets', () => {
      const wb = createCanonicalWorkbookMeta();
      for (const sheet of wb.sheets) {
        expect(sheet.rows).toBeGreaterThan(0);
        expect(sheet.columns).toBeGreaterThan(0);
      }
    });
  });

  describe('2. Empty selected tab retention', () => {
    it('retains empty visible tab in ExportRequest scopes in source order', () => {
      const request = createCanonicalExportRequest();
      expect(request.scopes).toHaveLength(2);

      // Two visible tabs in source order
      expect(request.scopes[0].sheetId).toBe(CANONICAL_SPARSE_SHEET_ID);
      expect(request.scopes[1].sheetId).toBe(CANONICAL_EMPTY_SHEET_ID);

      // Empty tab scope covers its allocated dimensions
      expect(request.scopes[1].rect).toEqual({
        sheetId: CANONICAL_EMPTY_SHEET_ID,
        r0: 0,
        c0: 0,
        r1: 1000,
        c1: 26
      });
    });

    it('retains empty visible tab in WriterContext sheets and sheetOrder', () => {
      const ctx = createCanonicalWriterContext();
      expect(ctx.sheetOrder).toEqual([CANONICAL_SPARSE_SHEET_ID, CANONICAL_EMPTY_SHEET_ID]);
      expect(ctx.sheets).toHaveLength(2);
      expect(ctx.sheets[1].id).toBe(CANONICAL_EMPTY_SHEET_ID);
      expect(ctx.sheets[1].title).toBe('EmptyTab');
    });

    it('retains empty visible tab in ExportReport scopes, order, and nameMappings', () => {
      const report = createCanonicalExportReport();
      expect(report.sheetOrder).toEqual([CANONICAL_SPARSE_SHEET_ID, CANONICAL_EMPTY_SHEET_ID]);
      expect(report.selectedScopes).toHaveLength(2);
      expect(report.selectedScopes[1].sheetId).toBe(CANONICAL_EMPTY_SHEET_ID);

      const emptyMapping = report.nameMappings.find((m) => m.sheetId === CANONICAL_EMPTY_SHEET_ID);
      expect(emptyMapping).toBeDefined();
      expect(emptyMapping?.originalTitle).toBe('EmptyTab');
      expect(emptyMapping?.exportedName).toBe('EmptyTab');
    });

    it('retains empty visible tab in JsonExportDocument with empty cells array', () => {
      const doc = createCanonicalJsonExportDocument();
      expect(doc.sheets).toHaveLength(2);

      const emptySheet = doc.sheets[1];
      expect(emptySheet.id).toBe(CANONICAL_EMPTY_SHEET_ID);
      expect(emptySheet.title).toBe('EmptyTab');
      expect(emptySheet.cells).toEqual([]);
    });
  });

  describe('3. Source, Principal, and Scope Alignment', () => {
    it('binds consistent sourceId across all canonical fixtures', () => {
      const wb = createCanonicalWorkbookMeta();
      const sourceRef = createCanonicalSourceRef();
      const eligibility = createSyntheticPermittedEligibility();
      const request = createCanonicalExportRequest();
      const writerCtx = createCanonicalWriterContext();
      const report = createCanonicalExportReport();
      const jsonDoc = createCanonicalJsonExportDocument();

      expect(wb.id).toBe(CANONICAL_SPREADSHEET_ID);
      expect(sourceRef.spreadsheetId).toBe(CANONICAL_SPREADSHEET_ID);
      expect(eligibility.sourceId).toBe(CANONICAL_SPREADSHEET_ID);
      expect(request.sourceId).toBe(CANONICAL_SPREADSHEET_ID);
      expect(writerCtx.sourceId).toBe(CANONICAL_SPREADSHEET_ID);
      expect(report.source.id).toBe(CANONICAL_SPREADSHEET_ID);
      expect(jsonDoc.source.id).toBe(CANONICAL_SPREADSHEET_ID);

      expect(request.limitsVersion).toBe(CANONICAL_LIMITS_VERSION);
      expect(writerCtx.limitsVersion).toBe(CANONICAL_LIMITS_VERSION);
      expect(report.limitsVersion).toBe(CANONICAL_LIMITS_VERSION);
    });

    it('binds consistent principalKey across AccountContext, Eligibility, and Request', () => {
      const account = createSyntheticAccountContext();
      const eligibility = createSyntheticPermittedEligibility();
      const request = createCanonicalExportRequest();

      expect(account.principalKey).toBe(CANONICAL_PRINCIPAL_KEY);
      expect(eligibility.principalKey).toBe(CANONICAL_PRINCIPAL_KEY);
      expect(request.principalKey).toBe(CANONICAL_PRINCIPAL_KEY);
      expect(account.displayEmail).toBe(CANONICAL_DISPLAY_EMAIL);
    });

    it('aligns scopes across Request, WriterContext, Report, and JsonExportDocument', () => {
      const request = createCanonicalExportRequest();
      const writerCtx = createCanonicalWriterContext();
      const report = createCanonicalExportReport();
      const jsonDoc = createCanonicalJsonExportDocument();

      expect(writerCtx.scopes).toEqual(request.scopes);
      expect(report.selectedScopes).toEqual(request.scopes);
      expect(jsonDoc.selectedScopes).toEqual(request.scopes);
    });

    it('aligns sheetOrder with source order of visible sheets', () => {
      const writerCtx = createCanonicalWriterContext();
      const report = createCanonicalExportReport();
      const jsonDoc = createCanonicalJsonExportDocument();

      const expectedOrder = [CANONICAL_SPARSE_SHEET_ID, CANONICAL_EMPTY_SHEET_ID];
      expect(writerCtx.sheetOrder).toEqual(expectedOrder);
      expect(report.sheetOrder).toEqual(expectedOrder);
      expect(jsonDoc.sheetOrder).toEqual(expectedOrder);
    });

    it('uses synthetic local evidence revision without live permission claims', () => {
      const eligibility = createSyntheticPermittedEligibility();
      expect(eligibility.status).toBe('permitted');
      expect(eligibility.evidenceRevision).toBe(CANONICAL_EVIDENCE_REVISION);
      expect(eligibility.reasonCode).toBe('SYNTHETIC_TEST_PERMITTED');
    });
  });

  describe('4. Manual Sparse Raw-Mode Oracle Cells', () => {
    it('contains exactly THREE manually authored sparse cells', () => {
      expect(CANONICAL_SPARSE_RAW_ORACLE_CELLS).toHaveLength(3);
      const freshCells = createCanonicalSparseRawOracleCells();
      expect(freshCells).toHaveLength(3);
    });

    it('asserts exact absolute coordinates, kinds, and values for all three cells', () => {
      const cells = createCanonicalSparseRawOracleCells();

      // Cell 0: A1
      expect(cells[0]).toEqual({
        r: 0,
        c: 0,
        kind: 'string',
        value: '00123'
      });

      // Cell 1: D50 (column D = index 3, row 50 = index 49)
      expect(cells[1]).toEqual({
        r: 49,
        c: 3,
        kind: 'string',
        value: 'middle'
      });

      // Cell 2: Z90000 (column Z = index 25, row 90000 = index 89999)
      expect(cells[2]).toEqual({
        r: 89999,
        c: 25,
        kind: 'number',
        value: 42
      });
    });

    it('preserves leading zeros on raw string cell A1 without numeric coercion', () => {
      const a1Cell = CANONICAL_SPARSE_RAW_ORACLE_CELLS[0];
      expect(a1Cell.kind).toBe('string');
      expect(a1Cell.value).toBe('00123');
      expect(typeof a1Cell.value).toBe('string');
      expect(a1Cell.value).not.toBe(123);
    });

    it('does not represent sparse data as a dense 90,000-row array', () => {
      expect(Array.isArray(CANONICAL_SPARSE_RAW_ORACLE_CELLS)).toBe(true);
      expect(CANONICAL_SPARSE_RAW_ORACLE_CELLS.length).toBe(3);
      expect(CANONICAL_SPARSE_RAW_ORACLE_CELLS.length).toBeLessThan(10);
    });
  });

  describe('5. Sanitization and Absence of Auth Fields', () => {
    it('contains no auth or credential fields in WriterContext', () => {
      const writerCtx = createCanonicalWriterContext();
      const forbiddenAuthKeys = [
        'principalKey',
        'displayEmail',
        'accessToken',
        'refreshToken',
        'token',
        'account',
        'authorization',
        'headers'
      ];

      for (const key of forbiddenAuthKeys) {
        expect(key in writerCtx, `WriterContext must not contain ${key}`).toBe(false);
      }
    });

    it('contains no auth fields in ExportReport or its sub-objects', () => {
      const report = createCanonicalExportReport();
      const forbiddenAuthKeys = [
        'principalKey',
        'displayEmail',
        'accessToken',
        'refreshToken',
        'token',
        'account',
        'authorization',
        'headers'
      ];

      for (const key of forbiddenAuthKeys) {
        expect(key in report, `ExportReport must not contain ${key}`).toBe(false);
        expect(key in report.source, `report.source must not contain ${key}`).toBe(false);
        expect(key in report.export, `report.export must not contain ${key}`).toBe(false);
      }
    });

    it('contains no auth fields in JsonExportDocument', () => {
      const doc = createCanonicalJsonExportDocument();
      const forbiddenAuthKeys = [
        'principalKey',
        'displayEmail',
        'accessToken',
        'refreshToken',
        'token',
        'account',
        'authorization'
      ];

      for (const key of forbiddenAuthKeys) {
        expect(key in doc, `JsonExportDocument must not contain ${key}`).toBe(false);
      }
    });
  });

  describe('6. Deep Isolation of Factory Invocations', () => {
    it('returns fresh distinct instances for createCanonicalWorkbookMeta', () => {
      const wb1 = createCanonicalWorkbookMeta();
      const wb2 = createCanonicalWorkbookMeta();

      expect(wb1).not.toBe(wb2);
      expect(wb1.sheets).not.toBe(wb2.sheets);
      expect(wb1.sheets[0]).not.toBe(wb2.sheets[0]);

      // Mutating wb1 must not affect wb2 or future invocations
      (wb1.sheets[0] as unknown as { title: string }).title = 'MUTATED';
      expect(wb2.sheets[0].title).toBe('SparseTab');
      expect(createCanonicalWorkbookMeta().sheets[0].title).toBe('SparseTab');
    });

    it('returns fresh distinct instances for createCanonicalSourceRef', () => {
      const s1 = createCanonicalSourceRef();
      const s2 = createCanonicalSourceRef();
      expect(s1).not.toBe(s2);
    });

    it('returns fresh distinct instances for createSyntheticAccountContext', () => {
      const a1 = createSyntheticAccountContext();
      const a2 = createSyntheticAccountContext();
      expect(a1).not.toBe(a2);
    });

    it('returns fresh distinct instances for createSyntheticPermittedEligibility', () => {
      const e1 = createSyntheticPermittedEligibility();
      const e2 = createSyntheticPermittedEligibility();
      expect(e1).not.toBe(e2);
    });

    it('returns fresh distinct instances for createCanonicalExportRequest', () => {
      const r1 = createCanonicalExportRequest();
      const r2 = createCanonicalExportRequest();

      expect(r1).not.toBe(r2);
      expect(r1.scopes).not.toBe(r2.scopes);
      expect(r1.scopes[0]).not.toBe(r2.scopes[0]);
      expect(r1.scopes[0].rect).not.toBe(r2.scopes[0].rect);

      // Mutating r1 does not contaminate r2
      (r1.scopes[0] as unknown as { sheetId: number }).sheetId = 999;
      expect(r2.scopes[0].sheetId).toBe(CANONICAL_SPARSE_SHEET_ID);
      expect(createCanonicalExportRequest().scopes[0].sheetId).toBe(CANONICAL_SPARSE_SHEET_ID);
    });

    it('returns fresh distinct instances for createCanonicalWriterContext', () => {
      const w1 = createCanonicalWriterContext();
      const w2 = createCanonicalWriterContext();

      expect(w1).not.toBe(w2);
      expect(w1.scopes).not.toBe(w2.scopes);
      expect(w1.sheets).not.toBe(w2.sheets);
      expect(w1.sheets[0]).not.toBe(w2.sheets[0]);

      // Mutating w1 does not contaminate w2
      (w1.sheets[0] as unknown as { title: string }).title = 'MUTATED';
      expect(w2.sheets[0].title).toBe('SparseTab');
      expect(createCanonicalWriterContext().sheets[0].title).toBe('SparseTab');
    });

    it('returns fresh distinct instances for createCanonicalExportReport', () => {
      const rep1 = createCanonicalExportReport();
      const rep2 = createCanonicalExportReport();

      expect(rep1).not.toBe(rep2);
      expect(rep1.selectedScopes).not.toBe(rep2.selectedScopes);
      expect(rep1.nameMappings).not.toBe(rep2.nameMappings);
      expect(rep1.exclusions).not.toBe(rep2.exclusions);

      // Mutating rep1 does not contaminate rep2
      (rep1.nameMappings[0] as unknown as { exportedName: string }).exportedName = 'MUTATED';
      expect(rep2.nameMappings[0].exportedName).toBe('SparseTab');
      expect(createCanonicalExportReport().nameMappings[0].exportedName).toBe('SparseTab');
    });

    it('returns fresh distinct instances for createCanonicalSparseRawOracleCells', () => {
      const c1 = createCanonicalSparseRawOracleCells();
      const c2 = createCanonicalSparseRawOracleCells();

      expect(c1).not.toBe(c2);
      expect(c1[0]).not.toBe(c2[0]);

      (c1[0] as unknown as { value: string }).value = 'MUTATED';
      expect(c2[0].value).toBe('00123');
      expect(createCanonicalSparseRawOracleCells()[0].value).toBe('00123');
    });

    it('returns fresh distinct instances for createCanonicalJsonExportDocument', () => {
      const d1 = createCanonicalJsonExportDocument();
      const d2 = createCanonicalJsonExportDocument();

      expect(d1).not.toBe(d2);
      expect(d1.sheets).not.toBe(d2.sheets);
      expect(d1.sheets[0].cells).not.toBe(d2.sheets[0].cells);

      (d1.sheets[0].cells[0] as unknown as { value: string }).value = 'MUTATED';
      expect(d2.sheets[0].cells[0].value).toBe('00123');
      expect(createCanonicalJsonExportDocument().sheets[0].cells[0].value).toBe('00123');
    });

    it('returns fresh distinct payloads for transport factories', () => {
      const p1 = createMultisheetGridTransportPayload();
      const p2 = createMultisheetGridTransportPayload();

      expect(p1).not.toBe(p2);
      expect(p1.payload).not.toBe(p2.payload);

      const u1 = createUnavailableVisibilityGridTransportPayload();
      const u2 = createUnavailableVisibilityGridTransportPayload();

      expect(u1).not.toBe(u2);
      expect(u1.payload).not.toBe(u2.payload);
    });
  });

  describe('7. Schema Validation with Ajv (Draft 2020-12)', () => {
    it('validates canonical ExportReport against report.schema.json', () => {
      const report = createCanonicalExportReport();
      const isValid = validateReport(report);

      expect(validateReport.errors).toBeNull();
      expect(isValid).toBe(true);
    });

    it('validates canonical JsonExportDocument against export.schema.json', () => {
      const doc = createCanonicalJsonExportDocument();
      const isValid = validateExport(doc);

      expect(validateExport.errors).toBeNull();
      expect(isValid).toBe(true);
    });
  });

  describe('8. Reviewed Fixture Catalog References', () => {
    it('isolates catalog payloads, oracles and exports from consumer mutation', () => {
      const grid = REVIEWED_FIXTURE_CATALOG.t03GridData.multisheetFidelity;
      expect(grid.transport).not.toBe(grid.transport);
      expect(grid.oracle).not.toBe(grid.oracle);
      const catalog = REVIEWED_FIXTURE_CATALOG.t09JsonExports;
      const document = catalog.rawMultiTab;
      const originalTitle = document.source.title;
      document.source.title = 'MUTATED';
      expect(catalog.rawMultiTab.source.title).toBe(originalTitle);
      expect(catalog.formattedStrings).not.toBe(catalog.formattedStrings);
      expect(catalog.formulaText).not.toBe(catalog.formulaText);
      expect(catalog.metadataReportOnly).not.toBe(catalog.metadataReportOnly);
      expect(createMultisheetGridTransportPayload().payload).toEqual(grid.transport);
    });
    it('exposes reviewed T03 grid fixtures with unvalidated transport payloads', () => {
      const { t03GridData } = REVIEWED_FIXTURE_CATALOG;

      expect(t03GridData.multisheetFidelity.transport).toBeDefined();
      expect(t03GridData.multisheetFidelity.oracle).toBeDefined();
      expect(t03GridData.multisheetFidelity.oracle.expectedSheetsCount).toBe(3);

      expect(t03GridData.unavailableVisibility.transport).toBeDefined();
      expect(t03GridData.unavailableVisibility.oracle).toBeDefined();
      expect(t03GridData.unavailableVisibility.oracle.visibilityAssessment.visibilityEvidenceAvailable).toBe(false);

      const multiPayload = createMultisheetGridTransportPayload();
      expect(multiPayload.byteCount).toBe(Buffer.byteLength(JSON.stringify(multiPayload.payload), 'utf8'));
      expect(typeof multiPayload.payload).toBe('object');

      const unavailPayload = createUnavailableVisibilityGridTransportPayload();
      expect(unavailPayload.byteCount).toBe(Buffer.byteLength(JSON.stringify(unavailPayload.payload), 'utf8'));
      expect(typeof unavailPayload.payload).toBe('object');
    });

    it('exposes reviewed T09 JSON export fixture documents', () => {
      const { t09JsonExports } = REVIEWED_FIXTURE_CATALOG;

      expect(t09JsonExports.rawMultiTab.schemaVersion).toBe('1.0');
      expect(t09JsonExports.rawMultiTab.export.mode).toBe('raw');

      expect(t09JsonExports.formattedStrings.schemaVersion).toBe('1.0');
      expect(t09JsonExports.formattedStrings.export.mode).toBe('formatted');

      expect(t09JsonExports.formulaText.schemaVersion).toBe('1.0');
      expect(t09JsonExports.formulaText.export.mode).toBe('formula_text');

      expect(t09JsonExports.metadataReportOnly.schemaVersion).toBe('1.0');
      expect(t09JsonExports.metadataReportOnly.export.format).toBe('csv');
    });
  });
});
