import type {
  SourceRef,
  AccountContext,
  Eligibility,
  PermittedEligibility,
  RestrictedEligibility,
  WorkbookMeta,
  Rect,
  ExportRequest,
  NormalizedChunk,
  Artifact,
  ExportReport
} from '../../src/contracts/domain.ts';

import type {
  AuthPort,
  PermissionPort,
  SheetsPort,
  WriterPort,
  WriterContext,
  DownloadPort,
  DownloadResult,
  GridTransportPayload,
  Clock,
  Random,
  Fetch
} from '../../src/contracts/ports.ts';
import { DomainError } from '../../src/contracts/errors.ts';

/**
 * Compile-only test fixtures verifying port type adherence.
 * Deliberately not runtime unit tests.
 */
function validPortFixtures(): void {
  const dummyAuth: AuthPort = {
    signIn: async () => ({ principalKey: 'p1', displayEmail: 'p1@example.com' }),
    getContext: async () => ({ principalKey: 'p1', displayEmail: 'p1@example.com' }),
    getToken: async (_expectedPrincipalKey: string) => 'token-in-auth-memory-only',
    signOut: async () => {}
  };

  const dummyPermission: PermissionPort = {
    check: async (
      _source: SourceRef,
      _account: AccountContext,
      _signal: AbortSignal
    ): Promise<Eligibility> => ({
      status: 'permitted',
      sourceId: 's1',
      principalKey: 'p1',
      checkedAt: '2026-10-31T00:00:00Z',
      evidenceRevision: 'rev1',
      reasonCode: 'OK'
    })
  };

  const dummySheets: SheetsPort = {
    getMetadata: async (
      _source: SourceRef,
      _permitted: PermittedEligibility,
      _signal: AbortSignal
    ): Promise<WorkbookMeta> => ({
      id: 's1',
      title: 'Workbook 1',
      locale: 'en',
      timeZone: 'UTC',
      sheets: []
    }),
    readGrid: async (
      _source: SourceRef,
      _permitted: PermittedEligibility,
      _rect: Rect,
      _signal: AbortSignal
    ): Promise<GridTransportPayload> => ({
      payload: { rawData: [] },
      byteCount: 128
    })
  };

  const dummyWriter: WriterPort = {
    begin: async (_context: WriterContext) => {},
    append: async (_chunk: NormalizedChunk) => {},
    finalize: async (_report: ExportReport, _signal: AbortSignal): Promise<readonly Artifact[]> => [],
    abort: async () => {}
  };

  const dummyDownload: DownloadPort = {
    publish: async (
      _artifacts: readonly Artifact[],
      _signal: AbortSignal
    ): Promise<readonly DownloadResult[]> => []
  };

  const dummyClock: Clock = {
    now: () => 1700000000000
  };

  const dummyRandom: Random = {
    next: () => 0.5
  };

  const dummyFetch: Fetch = async (_input: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify({ ok: true }));
  };

  // Valid projection from ExportRequest to sanitized WriterContext
  const validRequest: ExportRequest = {
    sourceId: 's1',
    principalKey: 'p1',
    scopes: [{ sheetId: 0, rect: { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 5 } }],
    mode: 'raw',
    format: 'csv',
    visibility: 'include_all',
    limitsVersion: '1.0'
  };

  const sanitizedWriterContext: WriterContext = {
    sourceId: validRequest.sourceId,
    title: 'Sheet Title',
    locale: 'en_US',
    timeZone: 'UTC',
    scopes: validRequest.scopes,
    mode: validRequest.mode,
    format: validRequest.format,
    visibility: validRequest.visibility,
    limitsVersion: validRequest.limitsVersion,
    sheetOrder: [0],
    sheets: [{ id: 0, title: 'Sheet1', index: 0, type: 'GRID', hidden: false, rows: 10, columns: 5 }]
  };

  void [
    dummyAuth,
    dummyPermission,
    dummySheets,
    dummyWriter,
    dummyDownload,
    dummyClock,
    dummyRandom,
    dummyFetch,
    dummyWriter.begin(sanitizedWriterContext, new AbortController().signal)
  ];
}

/**
 * Compile-only negative tests verifying trust boundaries and type rejections.
 * Consumes all tested values to ensure noUnusedLocals does not mask typecheck failures.
 */
function negativePortFixtures(
  writer: WriterPort,
  sheets: SheetsPort,
  permission: PermissionPort,
  request: ExportRequest,
  account: AccountContext,
  source: SourceRef,
  rect: Rect,
  restricted: RestrictedEligibility,
  context: WriterContext,
  signal: AbortSignal
): void {
  // 1. Proving full auth-bound ExportRequest variable cannot be passed to writer.begin()
  // @ts-expect-error ExportRequest contains principalKey; WriterContext forbids principalKey via optional never
  const _rejectedBoundRequest = writer.begin({ ...context, ...request }, signal);

  // 2. Proving AccountContext variable cannot be passed to writer.begin()
  // @ts-expect-error AccountContext contains principalKey and displayEmail; WriterContext forbids auth fields
  const _rejectedAccountContext = writer.begin({ ...context, ...account }, signal);

  // 3. Proving object literal with auth/token fields is rejected by WriterContext
  const _rejectedTokenLiteral = writer.begin({
    sourceId: 's1',
    title: 'Title',
    locale: 'en',
    timeZone: 'UTC',
    scopes: [],
    mode: 'raw',
    format: 'csv',
    visibility: 'include_all',
    limitsVersion: '1.0',
    sheetOrder: [],
    sheets: [],
    // @ts-expect-error WriterContext explicitly forbids accessToken
    accessToken: 'synthetic-token'
  }, signal);

  const _rejectedTokenLiteral2 = writer.begin({
    sourceId: 's1',
    title: 'Title',
    locale: 'en',
    timeZone: 'UTC',
    scopes: [],
    mode: 'raw',
    format: 'csv',
    visibility: 'include_all',
    limitsVersion: '1.0',
    sheetOrder: [],
    sheets: [],
    // @ts-expect-error WriterContext explicitly forbids token
    token: 'synthetic-token'
  }, signal);

  // 4. SheetsPort requires explicit PermittedEligibility; rejected on RestrictedEligibility
  // @ts-expect-error SheetsPort.getMetadata requires PermittedEligibility, rejects RestrictedEligibility
  const _rejectedUnpermittedMeta = sheets.getMetadata(source, restricted, signal);

  // @ts-expect-error SheetsPort.readGrid requires PermittedEligibility, rejects RestrictedEligibility
  const _rejectedUnpermittedGrid = sheets.readGrid(source, restricted, rect, signal);

  // 5. PermissionPort and DownloadPort require explicit AbortSignal
  // @ts-expect-error PermissionPort.check requires signal argument
  const _rejectedPermissionNoSignal = permission.check(source, account);

  // @ts-expect-error A denied error cannot opt itself into a retry category
  const _rejectedRetryOverride = new DomainError('RESTRICTED_EXPORT_DENIED', { retryClassification: 'network' });

  // @ts-expect-error Writer operations require explicit cancellation signals
  const _rejectedWriterNoSignal = writer.begin(context);

  // @ts-expect-error Download failures expose safe codes, not raw browser/error messages
  const _rejectedRawDownloadError: DownloadResult = { filename: 'fixture.csv', outcome: 'interrupted', error: 'untrusted raw error' };

  // Consume all variables so unused-local checks cannot masquerade as type rejection
  void [
    _rejectedBoundRequest,
    _rejectedAccountContext,
    _rejectedTokenLiteral,
    _rejectedTokenLiteral2,
    _rejectedUnpermittedMeta,
    _rejectedUnpermittedGrid,
    _rejectedPermissionNoSignal,
    _rejectedRetryOverride,
    _rejectedWriterNoSignal,
    _rejectedRawDownloadError
  ];
}

void [validPortFixtures, negativePortFixtures];
