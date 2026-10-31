import type {
  NormalizedChunk,
  ExportReport,
  Artifact,
  StringCell,
  Rect,
  ExportRequest,
  AccountContext
} from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerBeginRequest,
  WorkerAppendRequest,
  WorkerFinalizeRequest,
  WorkerCancelRequest,
  WorkerAckResponse,
  WorkerProgressResponse,
  WorkerStagedArtifactsResponse,
  WorkerErrorResponse,
  WorkerCancelledResponse
} from '../../src/contracts/messages.ts';

/**
 * Compile-only test fixtures for worker-message protocol adherence.
 * Deliberately not runtime unit tests.
 */
function validMessageFixtures(): void {
  const rect: Rect = { sheetId: 0, r0: 0, c0: 0, r1: 10, c1: 5 };

  const sanitizedContext: WriterContext = {
    sourceId: 'spreadsheet-1',
    title: 'Financials',
    locale: 'en_US',
    timeZone: 'America/New_York',
    scopes: [{ sheetId: 0, rect }],
    mode: 'raw',
    format: 'xlsx',
    visibility: 'include_all',
    limitsVersion: '1.0',
    sheetOrder: [0],
    sheets: [{ id: 0, title: 'Q1', index: 0, type: 'GRID', hidden: false, rows: 10, columns: 5 }]
  };

  // Legitimate selected workbook cell string containing synthetic token-like text.
  // The protocol does not ban or redact cell values.
  const tokenLikeCell: StringCell = {
    r: 1,
    c: 1,
    kind: 'string',
    value: 'ya29.a0AfH6SM-synthetic-token-like-cell-text'
  };

  const chunk: NormalizedChunk = {
    jobId: 'job-101',
    chunkId: 'chunk-001',
    rect,
    cells: [tokenLikeCell],
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 256
  };

  const report: ExportReport = {
    schemaVersion: '1.0',
    source: { id: 'spreadsheet-1', title: 'Financials', locale: 'en_US', timeZone: 'America/New_York' },
    export: {
      startedAt: '2026-10-31T00:00:00.000Z',
      producedAt: '2026-10-31T00:00:05.000Z',
      mode: 'raw',
      format: 'xlsx',
      visibility: 'include_all',
      complete: true,
      consistency: 'not_atomic_no_change_detected',
      warnings: []
    },
    selectedScopes: [{ sheetId: 0, rect }],
    sheetOrder: [0],
    limitsVersion: '1.0',
    nameMappings: [{ sheetId: 0, originalTitle: 'Q1', exportedName: 'Q1' }],
    exclusions: []
  };

  const stagedArtifact: Artifact = {
    filename: 'Financials.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    data: new Uint8Array([0x50, 0x4b]),
    byteLength: 2,
    safeSummary: '1 sheet exported'
  };

  // Valid requests
  const beginReq: WorkerBeginRequest = {
    protocolVersion: 1,
    jobId: 'job-101',
    generation: 1,
    type: 'BEGIN',
    context: sanitizedContext
  };

  const appendReq: WorkerAppendRequest = {
    protocolVersion: 1,
    jobId: 'job-101',
    generation: 1,
    type: 'APPEND',
    chunk
  };

  const finalizeReq: WorkerFinalizeRequest = {
    protocolVersion: 1,
    jobId: 'job-101',
    generation: 1,
    type: 'FINALIZE',
    report
  };

  const cancelReq: WorkerCancelRequest = {
    protocolVersion: 1,
    jobId: 'job-101',
    generation: 1,
    type: 'CANCEL'
  };

  // Discriminated union assignment
  const requests: readonly WorkerRequest[] = [beginReq, appendReq, finalizeReq, cancelReq];

  // Valid responses
  const ackRes: WorkerAckResponse = {
    protocolVersion: 1,
    jobId: 'job-101',
    generation: 1,
    type: 'ACK',
    phase: 'begin'
  };

  const progressRes: WorkerProgressResponse = {
    protocolVersion: 1,
    jobId: 'job-101',
    generation: 1,
    type: 'PROGRESS',
    phase: 'append',
    chunksCompleted: 1,
    totalChunks: 5
  };

  const stagedRes: WorkerStagedArtifactsResponse = {
    protocolVersion: 1,
    jobId: 'job-101',
    generation: 1,
    type: 'STAGED_ARTIFACTS',
    artifacts: [stagedArtifact]
  };

  const errorRes: WorkerErrorResponse = {
    protocolVersion: 1,
    jobId: 'job-101',
    generation: 1,
    type: 'ERROR',
    code: 'FORMAT_SERIALIZATION_FAILED',
    sheetId: 0,
    r: 1,
    c: 1
  };

  const cancelledRes: WorkerCancelledResponse = {
    protocolVersion: 1,
    jobId: 'job-101',
    generation: 1,
    type: 'CANCELLED'
  };

  const responses: readonly WorkerResponse[] = [
    ackRes,
    progressRes,
    stagedRes,
    errorRes,
    cancelledRes
  ];

  void [requests, responses];
}

/**
 * Compile-only negative fixtures verifying message rejection.
 * Consumes all tested values so unused-local checks cannot mask type failures.
 */
function negativeMessageFixtures(
  context: WriterContext,
  fullRequest: ExportRequest,
  account: AccountContext
): void {
  // 1. Missing required envelope fields
  // @ts-expect-error Missing protocolVersion
  const _missingVersion: WorkerCancelRequest = {
    jobId: 'job-1',
    generation: 1,
    type: 'CANCEL'
  };

  // @ts-expect-error Missing jobId
  const _missingJobId: WorkerCancelRequest = {
    protocolVersion: 1,
    generation: 1,
    type: 'CANCEL'
  };

  // @ts-expect-error Missing generation
  const _missingGeneration: WorkerCancelRequest = {
    protocolVersion: 1,
    jobId: 'job-1',
    type: 'CANCEL'
  };

  // 2. Unsupported protocol version (protocolVersion must be literal 1)
  // @ts-expect-error protocolVersion must be literal 1, not 2
  const _version2: WorkerCancelRequest = { protocolVersion: 2, jobId: 'job-1', generation: 1, type: 'CANCEL' };

  // 3. Wrong payloads
  // @ts-expect-error BEGIN requires WriterContext, string payload rejected
  const _wrongBeginPayload: WorkerBeginRequest = { protocolVersion: 1, jobId: 'job-1', generation: 1, type: 'BEGIN', context: 'not-a-context' };

  // @ts-expect-error APPEND requires NormalizedChunk, empty object rejected
  const _wrongAppendPayload: WorkerAppendRequest = { protocolVersion: 1, jobId: 'job-1', generation: 1, type: 'APPEND', chunk: {} };

  // @ts-expect-error FINALIZE requires ExportReport, empty object rejected
  const _wrongFinalizePayload: WorkerFinalizeRequest = { protocolVersion: 1, jobId: 'job-1', generation: 1, type: 'FINALIZE', report: {} };

  // 4. Auth-contaminated otherwise-valid context or full ExportRequest variable
  // @ts-expect-error Spreading ExportRequest variable brings principalKey, which is rejected by optional never
  const _authContaminatedContext: WriterContext = {
    ...context,
    ...fullRequest
  };

  // @ts-expect-error Spreading AccountContext brings principalKey and displayEmail, rejected by optional never
  const _accountContaminatedContext: WriterContext = {
    ...context,
    ...account
  };

  // @ts-expect-error Spreading full ExportRequest onto BEGIN request brings principalKey, rejected on envelope
  const _authContaminatedBegin: WorkerBeginRequest = {
    protocolVersion: 1,
    jobId: 'job-1',
    generation: 1,
    type: 'BEGIN',
    context,
    ...fullRequest
  };

  // 5. Token-bearing envelope
  const _tokenEnvelope: WorkerCancelRequest = {
    protocolVersion: 1,
    jobId: 'job-1',
    generation: 1,
    type: 'CANCEL',
    // @ts-expect-error Envelope explicitly forbids accessToken via optional never
    accessToken: 'synthetic-token'
  };

  const _tokenEnvelope2: WorkerCancelRequest = {
    protocolVersion: 1,
    jobId: 'job-1',
    generation: 1,
    type: 'CANCEL',
    // @ts-expect-error Envelope explicitly forbids token via optional never
    token: 'synthetic-token'
  };

  const _headersEnvelope: WorkerCancelRequest = {
    protocolVersion: 1,
    jobId: 'job-1',
    generation: 1,
    type: 'CANCEL',
    // @ts-expect-error Envelope explicitly forbids headers via optional never
    headers: { Authorization: 'Bearer synthetic' }
  };

  // 6. Raw Error body / stack / message leakage
  // @ts-expect-error Error response forbids raw error message
  const _errorMessageBody: WorkerErrorResponse = { protocolVersion: 1, jobId: 'job-1', generation: 1, type: 'ERROR', code: 'INTERNAL_ERROR', message: 'untrusted error message' };

  // @ts-expect-error Error response forbids stack trace
  const _errorStackBody: WorkerErrorResponse = { protocolVersion: 1, jobId: 'job-1', generation: 1, type: 'ERROR', code: 'INTERNAL_ERROR', stack: 'Error: untrusted\n  at stack.ts:1:1' };

  // @ts-expect-error Error response forbids arbitrary body property
  const _errorBodyProp: WorkerErrorResponse = { protocolVersion: 1, jobId: 'job-1', generation: 1, type: 'ERROR', code: 'INTERNAL_ERROR', body: '<html>500 Internal Server Error</html>' };

  // @ts-expect-error Error response forbids cause object
  const _errorCauseProp: WorkerErrorResponse = { protocolVersion: 1, jobId: 'job-1', generation: 1, type: 'ERROR', code: 'INTERNAL_ERROR', cause: new Error('nested cause') };

  // 7. Synthetic/fake progress percent rejected
  // @ts-expect-error PROGRESS response forbids percent
  const _fakePercentProgress: WorkerProgressResponse = { protocolVersion: 1, jobId: 'job-1', generation: 1, type: 'PROGRESS', phase: 'append', chunksCompleted: 1, percent: 50 };

  void [
    _missingVersion,
    _missingJobId,
    _missingGeneration,
    _version2,
    _wrongBeginPayload,
    _wrongAppendPayload,
    _wrongFinalizePayload,
    _authContaminatedContext,
    _accountContaminatedContext,
    _authContaminatedBegin,
    _tokenEnvelope,
    _tokenEnvelope2,
    _headersEnvelope,
    _errorMessageBody,
    _errorStackBody,
    _errorBodyProp,
    _errorCauseProp,
    _fakePercentProgress
  ];
}

void [validMessageFixtures, negativeMessageFixtures];
