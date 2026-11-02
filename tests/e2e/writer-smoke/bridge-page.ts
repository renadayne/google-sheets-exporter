/**
 * T36c3b Extension Page Script for Native Production Worker Bridge Browser Smoke Harness.
 *
 * Installs CSP violation and window error observers BEFORE starting worker.
 * Connects to dedicated module worker (writer-worker.ts) using the native versioned protocol.
 * Executes sequential jobs for JSON, CSV, and XLSX formats with strictly increasing generations 0, 1, 2.
 * Executes negative generation 3 (CSV incomplete coverage) expecting FORMAT_SERIALIZATION_FAILED.
 * Validates responses using parseWorkerReply and parseWorkerArtifacts.
 * Tests ignored malformed and stale request envelopes without unexpected outputs.
 * Exposes window.__WRITER_SMOKE__ with base64 artifacts for Node oracles and bridge telemetry counts.
 */

import type { NormalizedChunk } from '../../../src/contracts/domain.ts';
import { parseWorkerReply, type ParsedWorkerReply } from '../../../src/runtime/worker-reply-envelope.ts';
import { parseWorkerArtifacts } from '../../../src/runtime/worker-artifacts.ts';
import {
  chunk30,
  chunk10,
  chunk20,
  createContext,
  createReport
} from './fixture.ts';
import type { SmokeArtifactPayload, SmokeBridgeCounts } from './types.ts';

// 1. Install CSP and error observers BEFORE starting worker
window.__cspViolations = [];
window.__pageErrors = [];
window.__WRITER_SMOKE__ = null;

document.addEventListener('securitypolicyviolation', (e: SecurityPolicyViolationEvent) => {
  window.__cspViolations.push({
    blockedURI: e.blockedURI,
    violatedDirective: e.violatedDirective,
    effectiveDirective: e.effectiveDirective
  });
});

window.addEventListener('error', (e: ErrorEvent) => {
  window.__pageErrors.push(e.message || String(e));
});

window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const reason = e.reason;
  window.__pageErrors.push(reason instanceof Error ? reason.message : String(reason));
});

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// 2. Instantiate dedicated ES module worker using production entry
const worker = new Worker(
  new URL('../../../src/runtime/writer-worker.ts', import.meta.url),
  { type: 'module' }
);

window.addEventListener('beforeunload', () => {
  worker.terminate();
});
window.addEventListener('unload', () => {
  worker.terminate();
});

const bridgeCounts: SmokeBridgeCounts = {
  commands: 0,
  acks: 0,
  progress: 0,
  staged: 0,
  errors: 0,
  unexpected: 0
};

const replyQueue: ParsedWorkerReply[] = [];
let finished = false;
let activeWaiter: {
  resolve: (reply: ParsedWorkerReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

function handleFailure(errMsg: string): void {
  if (finished) return;
  finished = true;
  try {
    worker.terminate();
  } catch {
    // Safe absorption
  }
  if (activeWaiter) {
    const waiter = activeWaiter;
    clearTimeout(waiter.timer);
    activeWaiter = null;
    waiter.reject(new Error(errMsg));
  }
  replyQueue.length = 0;
  window.__pageErrors.push(errMsg);
  window.__WRITER_SMOKE__ = {
    done: true,
    error: errMsg,
    cspViolations: window.__cspViolations,
    pageErrors: window.__pageErrors,
    bridge: bridgeCounts
  };
  const statusEl = document.getElementById('smoke-status');
  if (statusEl) statusEl.textContent = 'error';
}

worker.onerror = () => {
  handleFailure('Worker runtime error');
};

worker.onmessageerror = () => {
  handleFailure('Worker message deserialization failed');
};

worker.onmessage = (event: MessageEvent<unknown>) => {
  if (finished) return;
  const reply = parseWorkerReply(event.data);
  if (!reply) {
    bridgeCounts.unexpected++;
    return;
  }

  if (activeWaiter) {
    const waiter = activeWaiter;
    activeWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(reply);
  } else {
    replyQueue.push(reply);
  }
};

function waitForNextReply(timeoutMs = 10000): Promise<ParsedWorkerReply> {
  if (finished) return Promise.reject(new Error('Bridge smoke stopped'));
  if (replyQueue.length > 0) {
    return Promise.resolve(replyQueue.shift()!);
  }
  return new Promise<ParsedWorkerReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (activeWaiter?.timer === timer) {
        activeWaiter = null;
      }
      reject(new Error('Worker reply timeout'));
    }, timeoutMs);
    activeWaiter = { resolve, reject, timer };
  });
}

function postValidCommand(command: unknown): void {
  if (finished) throw new Error('Bridge smoke stopped');
  bridgeCounts.commands++;
  worker.postMessage(command);
}

function postIgnoredCommand(command: unknown): void {
  if (finished) throw new Error('Bridge smoke stopped');
  // Malicious/stale requests are separately not counted in valid commands
  worker.postMessage(command);
}

async function drainUnexpectedReplies(delayMs = 50): Promise<void> {
  await new Promise(r => setTimeout(r, delayMs));
  while (replyQueue.length > 0) {
    replyQueue.shift();
    bridgeCounts.unexpected++;
  }
}

async function expectAck(
  jobId: string,
  generation: number,
  expectedPhase: 'begin' | 'append',
  expectedChunksCompleted?: number
): Promise<void> {
  const reply = await waitForNextReply(10000);
  if (
    reply.type === 'ACK' &&
    reply.jobId === jobId &&
    reply.generation === generation &&
    reply.phase === expectedPhase &&
    (expectedChunksCompleted === undefined || reply.chunksCompleted === expectedChunksCompleted)
  ) {
    bridgeCounts.acks++;
  } else {
    bridgeCounts.unexpected++;
    throw new Error('Unexpected reply instead of expected ACK');
  }
}

async function expectProgress(
  jobId: string,
  generation: number,
  expectedPhase: 'serializing',
  expectedChunksCompleted: number
): Promise<void> {
  const reply = await waitForNextReply(10000);
  if (
    reply.type === 'PROGRESS' &&
    reply.jobId === jobId &&
    reply.generation === generation &&
    reply.phase === expectedPhase &&
    reply.chunksCompleted === expectedChunksCompleted
  ) {
    bridgeCounts.progress++;
  } else {
    bridgeCounts.unexpected++;
    throw new Error('Unexpected reply instead of expected PROGRESS');
  }
}

async function expectStagedArtifacts(
  jobId: string,
  generation: number
): Promise<readonly { filename: string; mimeType: string; byteLength: number; data: unknown }[]> {
  const reply = await waitForNextReply(10000);
  if (
    reply.type === 'STAGED_ARTIFACTS' &&
    reply.jobId === jobId &&
    reply.generation === generation
  ) {
    const parsed = parseWorkerArtifacts(reply.artifacts, {
      maxArtifacts: 2,
      maxBytes: 64 * 1024 * 1024
    });
    if (!parsed || parsed.length === 0) {
      bridgeCounts.unexpected++;
      throw new Error('Failed to parse staged artifacts');
    }
    bridgeCounts.staged++;
    return parsed;
  } else {
    bridgeCounts.unexpected++;
    throw new Error('Unexpected reply instead of expected STAGED_ARTIFACTS');
  }
}

async function expectError(
  jobId: string,
  generation: number,
  expectedCode: string
): Promise<string> {
  const reply = await waitForNextReply(10000);
  if (
    reply.type === 'ERROR' &&
    reply.jobId === jobId &&
    reply.generation === generation &&
    reply.code === expectedCode
  ) {
    bridgeCounts.errors++;
    return reply.code;
  } else {
    bridgeCounts.unexpected++;
    throw new Error('Unexpected reply instead of expected ERROR');
  }
}

async function runBridgeSmoke(): Promise<void> {
  const jobId = 'smoke_job_1';
  const signal = new AbortController().signal;

  // Send malformed request examples before starting jobs
  postIgnoredCommand({ protocolVersion: 999, jobId, generation: 0, type: 'BEGIN' });
  postIgnoredCommand({ notAnEnvelope: true });
  postIgnoredCommand(null);
  await drainUnexpectedReplies(50);

  // Generation 0: JSON Export
  const ctxJson = createContext('json', signal);
  const reportJson = createReport(ctxJson, 'json');

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 0,
    type: 'BEGIN',
    context: ctxJson
  });
  await expectAck(jobId, 0, 'begin');

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 0,
    type: 'APPEND',
    chunk: chunk30
  });
  await expectAck(jobId, 0, 'append', 1);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 0,
    type: 'APPEND',
    chunk: chunk10
  });
  await expectAck(jobId, 0, 'append', 2);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 0,
    type: 'APPEND',
    chunk: chunk20
  });
  await expectAck(jobId, 0, 'append', 3);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 0,
    type: 'FINALIZE',
    report: reportJson
  });
  await expectProgress(jobId, 0, 'serializing', 3);
  const jsonArtifacts = await expectStagedArtifacts(jobId, 0);

  // Send stale / mismatched request examples between jobs
  postIgnoredCommand({
    protocolVersion: 1,
    jobId,
    generation: 0,
    type: 'CANCEL'
  });
  postIgnoredCommand({
    protocolVersion: 1,
    jobId: 'unknown_job',
    generation: 99,
    type: 'CANCEL'
  });
  await drainUnexpectedReplies(50);

  // Generation 1: CSV Export (Multi-tab ZIP)
  const ctxCsv = createContext('csv', signal);
  const reportCsv = createReport(ctxCsv, 'csv');

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 1,
    type: 'BEGIN',
    context: ctxCsv
  });
  await expectAck(jobId, 1, 'begin');

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 1,
    type: 'APPEND',
    chunk: chunk30
  });
  await expectAck(jobId, 1, 'append', 1);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 1,
    type: 'APPEND',
    chunk: chunk10
  });
  await expectAck(jobId, 1, 'append', 2);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 1,
    type: 'APPEND',
    chunk: chunk20
  });
  await expectAck(jobId, 1, 'append', 3);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 1,
    type: 'FINALIZE',
    report: reportCsv
  });
  await expectProgress(jobId, 1, 'serializing', 3);
  const csvArtifacts = await expectStagedArtifacts(jobId, 1);

  // Send malformed request example with forbidden field between jobs
  postIgnoredCommand({
    protocolVersion: 1,
    jobId,
    generation: 2,
    type: 'BEGIN',
    context: ctxJson,
    token: 'forbidden_token'
  });
  await drainUnexpectedReplies(50);

  // Generation 2: XLSX Export (Workbook + Companion Report)
  const ctxXlsx = createContext('xlsx', signal);
  const reportXlsx = createReport(ctxXlsx, 'xlsx');

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 2,
    type: 'BEGIN',
    context: ctxXlsx
  });
  await expectAck(jobId, 2, 'begin');

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 2,
    type: 'APPEND',
    chunk: chunk30
  });
  await expectAck(jobId, 2, 'append', 1);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 2,
    type: 'APPEND',
    chunk: chunk10
  });
  await expectAck(jobId, 2, 'append', 2);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 2,
    type: 'APPEND',
    chunk: chunk20
  });
  await expectAck(jobId, 2, 'append', 3);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 2,
    type: 'FINALIZE',
    report: reportXlsx
  });
  await expectProgress(jobId, 2, 'serializing', 3);
  const xlsxArtifacts = await expectStagedArtifacts(jobId, 2);

  // Send stale request example between jobs
  postIgnoredCommand({
    protocolVersion: 1,
    jobId,
    generation: 1,
    type: 'APPEND',
    chunk: chunk10
  });
  await drainUnexpectedReplies(50);

  // Generation 3: Negative Test (incomplete coverage on sheet 30)
  const ctxNegative = createContext('csv', signal);
  const reportNegative = createReport(ctxNegative, 'csv');

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 3,
    type: 'BEGIN',
    context: ctxNegative
  });
  await expectAck(jobId, 3, 'begin');

  const incompleteChunk: NormalizedChunk = {
    jobId,
    chunkId: 'chunk_incomplete_coverage',
    rect: { sheetId: 30, r0: 2, c0: 1, r1: 3, c1: 4 }, // only 1 row covered out of 3 required in scope
    cells: [],
    excludedIntervals: { rows: [], columns: [] },
    byteCount: 0
  };

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 3,
    type: 'APPEND',
    chunk: incompleteChunk
  });
  await expectAck(jobId, 3, 'append', 1);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 3,
    type: 'APPEND',
    chunk: chunk10
  });
  await expectAck(jobId, 3, 'append', 2);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 3,
    type: 'APPEND',
    chunk: chunk20
  });
  await expectAck(jobId, 3, 'append', 3);

  postValidCommand({
    protocolVersion: 1,
    jobId,
    generation: 3,
    type: 'FINALIZE',
    report: reportNegative
  });
  await expectProgress(jobId, 3, 'serializing', 3);
  const caughtErrorCode = await expectError(jobId, 3, 'FORMAT_SERIALIZATION_FAILED');

  // Verify no unexpected late outputs arrived
  await drainUnexpectedReplies(50);

  // Terminate worker upon successful completion
  try {
    worker.terminate();
  } catch {
    // Safe absorption
  }

  const jsonArt = jsonArtifacts[0]!;
  const jsonPayload: SmokeArtifactPayload = {
    filename: jsonArt.filename,
    mimeType: jsonArt.mimeType,
    byteLength: jsonArt.byteLength,
    base64: uint8ArrayToBase64(jsonArt.data as Uint8Array)
  };

  const csvPayloads: SmokeArtifactPayload[] = csvArtifacts.map(a => ({
    filename: a.filename,
    mimeType: a.mimeType,
    byteLength: a.byteLength,
    base64: uint8ArrayToBase64(a.data as Uint8Array)
  }));

  const xlsxPayloads: SmokeArtifactPayload[] = xlsxArtifacts.map(a => ({
    filename: a.filename,
    mimeType: a.mimeType,
    byteLength: a.byteLength,
    base64: uint8ArrayToBase64(a.data as Uint8Array)
  }));

  window.__WRITER_SMOKE__ = {
    done: true,
    error: null,
    cspViolations: window.__cspViolations,
    pageErrors: window.__pageErrors,
    // Production protocol doesn't emit detachment telemetry; transferredBufferByteLengths omitted
    jsonArtifact: jsonPayload,
    csvArtifacts: csvPayloads,
    xlsxArtifacts: xlsxPayloads,
    negativeResult: {
      caughtErrorCode
    },
    bridge: bridgeCounts
  };

  const statusEl = document.getElementById('smoke-status');
  if (statusEl) statusEl.textContent = 'complete';
}

runBridgeSmoke().catch(err => {
  handleFailure(err instanceof Error ? err.message : 'Bridge smoke failed');
});
