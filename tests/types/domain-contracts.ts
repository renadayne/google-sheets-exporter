import type {
  Cell,
  StringCell,
  NumberCell,
  BooleanCell,
  ErrorCell,
  PermittedEligibility,
  ExportReport,
  Artifact,
  Rect,
  NormalizedChunk,
  CoverageSnapshot
} from '../../src/contracts/domain.ts';

/** Compile-only fixtures included by tsconfig; deliberately not runtime unit tests. */
function validDomainFixture(): void {
    const rect: Rect = {
      sheetId: 0,
      r0: 0,
      c0: 0,
      r1: 100,
      c1: 26
    };

    const permitted: PermittedEligibility = {
      status: 'permitted',
      sourceId: 'doc-123',
      principalKey: 'user-001',
      checkedAt: '2026-10-31T00:00:00.000Z',
      evidenceRevision: 'rev-xyz',
      reasonCode: 'DRIVE_PERMITTED'
    };

    const stringCell: StringCell = {
      r: 0,
      c: 0,
      kind: 'string',
      value: 'Header'
    };

    const dateSerialCell: NumberCell = {
      r: 1,
      c: 0,
      kind: 'number',
      value: 45678.5,
      numberFormatType: 'DATE_TIME'
    };

    const errorCell: ErrorCell = {
      r: 2,
      c: 0,
      kind: 'error',
      value: { code: '#DIV/0!', message: 'Evaluation error' }
    };

    const chunk: NormalizedChunk = {
      jobId: 'job-1',
      chunkId: 'chunk-1',
      rect,
      cells: [stringCell, dateSerialCell, errorCell],
      excludedIntervals: { rows: [], columns: [] },
      byteCount: 1024
    };

    const coverage: CoverageSnapshot = {
      plannedLeafCount: 1,
      completedChunkIds: ['chunk-1'],
      failedChunkIds: [],
      splitChunkIds: [],
      isScopeComplete: true
    };

    const report: ExportReport = {
      schemaVersion: '1.0',
      source: {
        id: 'doc-123',
        title: 'Sales Q3',
        locale: 'en_US',
        timeZone: 'UTC'
      },
      export: {
        startedAt: '2026-10-31T00:00:00.000Z',
        producedAt: '2026-10-31T00:00:02.000Z',
        mode: 'raw',
        format: 'csv',
        visibility: 'include_all',
        complete: true,
        consistency: 'not_atomic_no_change_detected',
        warnings: []
      },
      selectedScopes: [{ sheetId: 0, rect }],
      sheetOrder: [0],
      limitsVersion: '1.0',
      nameMappings: [{ sheetId: 0, originalTitle: 'Sheet1', exportedName: 'Sheet1.csv' }],
      exclusions: []
    };

    void [permitted, chunk, coverage, report];
}

function negativeDomainFixture(validReport: ExportReport): void {
    // 1. Wrong scalar / error types
    // @ts-expect-error StringCell value must be string, not number
    const _wrongScalarString: StringCell = { r: 0, c: 0, kind: 'string', value: 12345 };

    // @ts-expect-error NumberCell value must be number, not string
    const _wrongScalarNumber: NumberCell = { r: 0, c: 0, kind: 'number', value: '42' };

    // @ts-expect-error BooleanCell value must be boolean, not string
    const _wrongScalarBool: BooleanCell = { r: 0, c: 0, kind: 'boolean', value: 'true' };

    // @ts-expect-error ErrorCell value must be { code, message }, not string
    const _wrongErrorShape: ErrorCell = { r: 0, c: 0, kind: 'error', value: '#REF!' };

    // @ts-expect-error ErrorCell value must have message
    const _missingErrorMessage: ErrorCell = { r: 0, c: 0, kind: 'error', value: { code: '#N/A' } };

    // 2. Date cell values (dates stay numeric serial, never Date)
    // @ts-expect-error Cell value must never be Date object
    const _dateAsNumberValue: NumberCell = { r: 0, c: 0, kind: 'number', value: new Date() };

    // @ts-expect-error Cell discriminated union rejects Date value
    const _dateInCellUnion: Cell = { r: 0, c: 0, kind: 'string', value: new Date() };

    // 3. Missing permitted binding
    // @ts-expect-error PermittedEligibility MUST have sourceId
    const _missingSourceId: PermittedEligibility = {
      status: 'permitted',
      principalKey: 'u1',
      checkedAt: '2026-10-31T00:00:00Z',
      evidenceRevision: 'rev1',
      reasonCode: 'OK'
    };

    // @ts-expect-error PermittedEligibility MUST have principalKey
    const _missingPrincipalKey: PermittedEligibility = {
      status: 'permitted',
      sourceId: 's1',
      checkedAt: '2026-10-31T00:00:00Z',
      evidenceRevision: 'rev1',
      reasonCode: 'OK'
    };

    // @ts-expect-error PermittedEligibility MUST have checkedAt
    const _missingCheckedAt: PermittedEligibility = {
      status: 'permitted',
      sourceId: 's1',
      principalKey: 'u1',
      evidenceRevision: 'rev1',
      reasonCode: 'OK'
    };

    // @ts-expect-error PermittedEligibility MUST have evidenceRevision
    const _missingRevision: PermittedEligibility = {
      status: 'permitted',
      sourceId: 's1',
      principalKey: 'u1',
      checkedAt: '2026-10-31T00:00:00Z',
      reasonCode: 'OK'
    };

    // 4. Credential-bearing report and artifact literals rejected
    // @ts-expect-error ExportReport must not contain credential/token properties
    const _credentialReport: ExportReport = { ...validReport, accessToken: 'synthetic-test-only' };

    // @ts-expect-error Artifact must not contain token properties
    const _credentialArtifact: Artifact = { filename: 'export.csv', mimeType: 'text/csv', data: new Uint8Array(), byteLength: 0, safeSummary: '1 tab exported', bearerToken: 'synthetic-test-only' };

    void [_wrongScalarString, _wrongScalarNumber, _wrongScalarBool, _wrongErrorShape,
      _missingErrorMessage, _dateAsNumberValue, _dateInCellUnion, _missingSourceId,
      _missingPrincipalKey, _missingCheckedAt, _missingRevision, _credentialReport, _credentialArtifact];
}

void [validDomainFixture, negativeDomainFixture];
