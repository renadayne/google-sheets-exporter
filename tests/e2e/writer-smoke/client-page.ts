/**
 * T36d2a Extension Page Script for Native Worker Writer Client Browser Smoke Harness.
 *
 * Installs CSP violation and window error observers BEFORE starting any worker.
 * For each format JSON, CSV, XLSX, creates a fresh native Worker and connects via
 * createWorkerWriterClient with strictly increasing generations 0, 1, 2.
 * Executes negative generation 3 (CSV incomplete coverage) expecting FORMAT_SERIALIZATION_FAILED.
 * Validates replies using parseWorkerReply and protocol telemetry counts:
 * 20 valid client commands, 16 ACKs, 4 PROGRESS, 3 STAGED, 1 ERROR, 0 unexpected.
 * Validates client metrics: 4 workers created, 4 workers terminated, 4 progress callbacks.
 * Exposes window.__WRITER_SMOKE__ with base64 artifacts for Node oracles.
 */

import type { Artifact, NormalizedChunk } from '../../../src/contracts/domain.ts';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../../src/contracts/errors.ts';
import type { WriterPort } from '../../../src/contracts/ports.ts';
import { createWorkerWriterClient } from '../../../src/runtime/worker-client.ts';
import { parseWorkerReply } from '../../../src/runtime/worker-reply-envelope.ts';
import {
  chunk30,
  chunk10,
  chunk20,
  createContext,
  createReport
} from './fixture.ts';
import type {
  SmokeArtifactPayload,
  SmokeBridgeCounts
} from './types.ts';

// 1. Install CSP and error observers BEFORE any Worker is instantiated
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

function formatArtifact(artifact: Artifact): SmokeArtifactPayload {
  if (!(artifact.data instanceof Uint8Array)) throw new Error('Unexpected fixture artifact binary type');
  const data = artifact.data;
  return {
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    byteLength: artifact.byteLength,
    base64: uint8ArrayToBase64(data)
  };
}

// 2. Telemetry, state tracking, and bounded whole-page deadline
const PAGE_DEADLINE_MS = 45000;
let finished = false;

const outstandingWorkers = new Set<Worker>();
const ownedClients = new Set<WriterPort>();
let workersCreated = 0;
let workersTerminated = 0;
let progressCallbacks = 0;

const bridgeCounts: SmokeBridgeCounts = {
  commands: 0,
  acks: 0,
  progress: 0,
  staged: 0,
  errors: 0,
  unexpected: 0
};

function terminateOutstanding(): void {
  const clients = [...ownedClients];
  ownedClients.clear();
  for (const client of clients) void client.abort().catch(() => {});
  for (const w of Array.from(outstandingWorkers)) {
    try {
      w.terminate();
    } catch {
      // Safe absorption
    }
  }
}

window.addEventListener('beforeunload', terminateOutstanding);
window.addEventListener('unload', terminateOutstanding);

function handleFailure(errMsg: string): void {
  if (finished) return;
  finished = true;
  clearTimeout(pageDeadlineTimer);
  terminateOutstanding();
  window.__pageErrors.push(errMsg);
  window.__WRITER_SMOKE__ = {
    done: true,
    error: errMsg,
    cspViolations: window.__cspViolations,
    pageErrors: window.__pageErrors,
    bridge: bridgeCounts,
    client: {
      workersCreated,
      workersTerminated,
      progressCallbacks
    }
  };
  const statusEl = document.getElementById('smoke-status');
  if (statusEl) statusEl.textContent = 'error';
}

const pageDeadlineTimer = setTimeout(() => {
  handleFailure('Client smoke whole-page execution timed out');
}, PAGE_DEADLINE_MS);

// 3. Worker factory with terminate wrapper and independent onmessage wire telemetry
function createSmokeWorker(expectedJobId: string, expectedGeneration: number): Worker {
  const worker = new Worker(
    new URL('../../../src/runtime/writer-worker.ts', import.meta.url),
    { type: 'module' }
  );
  workersCreated++;
  outstandingWorkers.add(worker);

  const origTerminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    workersTerminated++;
    origTerminate();
    outstandingWorkers.delete(worker);
  };

  worker.onerror = () => {
    handleFailure('Unexpected native worker error event');
  };

  worker.onmessageerror = () => {
    handleFailure('Unexpected native worker messageerror event');
  };

  // Attach native worker.onmessage observer BEFORE client construction
  worker.onmessage = (event: MessageEvent<unknown>) => {
    if (finished) return;
    const reply = parseWorkerReply(event.data);
    if (!reply) {
      bridgeCounts.unexpected++;
      return;
    }

    if (reply.jobId !== expectedJobId || reply.generation !== expectedGeneration) {
      bridgeCounts.unexpected++;
      return;
    }

    if (reply.type === 'ACK') {
      bridgeCounts.acks++;
    } else if (reply.type === 'PROGRESS') {
      if (
        reply.phase === 'serializing' &&
        reply.chunksCompleted === 3 &&
        !('percent' in reply) &&
        !('percentage' in reply)
      ) {
        bridgeCounts.progress++;
      } else {
        bridgeCounts.unexpected++;
      }
    } else if (reply.type === 'STAGED_ARTIFACTS') {
      bridgeCounts.staged++;
    } else if (reply.type === 'ERROR') {
      if (reply.code === 'FORMAT_SERIALIZATION_FAILED') {
        bridgeCounts.errors++;
      } else {
        bridgeCounts.unexpected++;
      }
    } else {
      bridgeCounts.unexpected++;
    }
  };

  return worker;
}

function createClientForSmoke(worker: Worker, generation: number): WriterPort {
  const client = createWorkerWriterClient({
    worker,
    jobId: 'smoke_job_1',
    generation,
    timeoutMs: 10000,
    maxBytes: 64 * 1024 * 1024,
    onProgress: (progress) => {
      if (
        progress &&
        typeof progress === 'object' &&
        progress.phase === 'serializing' &&
        progress.chunksCompleted === 3 &&
        !('percent' in progress) &&
        !('percentage' in progress)
      ) {
        progressCallbacks++;
      } else {
        handleFailure('Unexpected onProgress payload schema');
      }
    }
  });
  ownedClients.add(client);
  return client;
}

// 4. Main test execution across positive formats (JSON, CSV, XLSX) + negative CSV
async function runClientSmoke(): Promise<void> {
  const statusEl = document.getElementById('smoke-status');
  if (statusEl) statusEl.textContent = 'running';

  const ac = new AbortController();
  const signal = ac.signal;

  try {
    // 1. JSON Export (Generation 0)
    const ctxJson = createContext('json', signal);
    const reportJson = createReport(ctxJson, 'json');
    const worker0 = createSmokeWorker('smoke_job_1', 0);
    const client0 = createClientForSmoke(worker0, 0);

    bridgeCounts.commands++;
    await client0.begin(ctxJson, signal);
    bridgeCounts.commands++;
    await client0.append(chunk30, signal);
    bridgeCounts.commands++;
    await client0.append(chunk10, signal);
    bridgeCounts.commands++;
    await client0.append(chunk20, signal);
    bridgeCounts.commands++;
    const jsonArtifacts = await client0.finalize(reportJson, signal);
    if (!jsonArtifacts || jsonArtifacts.length !== 1) {
      throw new Error('Expected exactly 1 JSON artifact');
    }

    // 2. CSV Export (Generation 1, Multi-tab ZIP)
    const ctxCsv = createContext('csv', signal);
    const reportCsv = createReport(ctxCsv, 'csv');
    const worker1 = createSmokeWorker('smoke_job_1', 1);
    const client1 = createClientForSmoke(worker1, 1);

    bridgeCounts.commands++;
    await client1.begin(ctxCsv, signal);
    bridgeCounts.commands++;
    await client1.append(chunk30, signal);
    bridgeCounts.commands++;
    await client1.append(chunk10, signal);
    bridgeCounts.commands++;
    await client1.append(chunk20, signal);
    bridgeCounts.commands++;
    const csvArtifacts = await client1.finalize(reportCsv, signal);
    if (!csvArtifacts || csvArtifacts.length !== 1) {
      throw new Error('Expected exactly 1 CSV artifact');
    }

    // 3. XLSX Export (Generation 2, Workbook + Companion Report)
    const ctxXlsx = createContext('xlsx', signal);
    const reportXlsx = createReport(ctxXlsx, 'xlsx');
    const worker2 = createSmokeWorker('smoke_job_1', 2);
    const client2 = createClientForSmoke(worker2, 2);

    bridgeCounts.commands++;
    await client2.begin(ctxXlsx, signal);
    bridgeCounts.commands++;
    await client2.append(chunk30, signal);
    bridgeCounts.commands++;
    await client2.append(chunk10, signal);
    bridgeCounts.commands++;
    await client2.append(chunk20, signal);
    bridgeCounts.commands++;
    const xlsxArtifacts = await client2.finalize(reportXlsx, signal);
    if (!xlsxArtifacts || xlsxArtifacts.length !== 2) {
      throw new Error('Expected exactly 2 XLSX artifacts');
    }

    // 4. Negative CSV Export (Generation 3: incomplete coverage on sheet 30)
    const ctxNeg = createContext('csv', signal);
    const reportNeg = createReport(ctxNeg, 'csv');
    const worker3 = createSmokeWorker('smoke_job_1', 3);
    const client3 = createClientForSmoke(worker3, 3);

    const incompleteChunk: NormalizedChunk = {
      jobId: 'smoke_job_1',
      chunkId: 'chunk_incomplete_coverage',
      rect: { sheetId: 30, r0: 2, c0: 1, r1: 3, c1: 4 }, // incomplete: only r2..3 covered out of r2..5
      cells: [],
      excludedIntervals: { rows: [], columns: [] },
      byteCount: 0
    };

    bridgeCounts.commands++;
    await client3.begin(ctxNeg, signal);
    bridgeCounts.commands++;
    await client3.append(incompleteChunk, signal);
    bridgeCounts.commands++;
    await client3.append(chunk10, signal);
    bridgeCounts.commands++;
    await client3.append(chunk20, signal);
    bridgeCounts.commands++;
    let caughtErrorCode: string | null = null;
    try {
      await client3.finalize(reportNeg, signal);
    } catch (err: unknown) {
      if (!(err instanceof DomainError) || err.message !== SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED) {
        throw new Error('Expected a static DomainError from the client');
      }
      caughtErrorCode = err.code;
    }
    if (caughtErrorCode !== 'FORMAT_SERIALIZATION_FAILED') {
      throw new Error(`Expected FORMAT_SERIALIZATION_FAILED, got ${caughtErrorCode}`);
    }

    // Settled clients must already have terminated their owned workers.
    // Native cancellation/crash/late-message behavior is tested separately.
    if (finished) throw new Error('Client smoke stopped');

    if (bridgeCounts.unexpected > 0) {
      throw new Error('Unexpected protocol messages observed');
    }
    if (outstandingWorkers.size > 0) {
      throw new Error('Workers still outstanding after client execution');
    }
    if (workersCreated !== 4 || workersTerminated !== 4) {
      throw new Error(`Worker count mismatch: created ${workersCreated}, terminated ${workersTerminated}`);
    }
    if (progressCallbacks !== 4) {
      throw new Error(`Progress callback count mismatch: expected 4, got ${progressCallbacks}`);
    }

    const jsonArt = jsonArtifacts[0]!;
    const jsonPayload = formatArtifact(jsonArt);
    const csvPayloads = csvArtifacts.map(formatArtifact);
    const xlsxPayloads = xlsxArtifacts.map(formatArtifact);
    ownedClients.clear();
    clearTimeout(pageDeadlineTimer);
    finished = true;

    window.__WRITER_SMOKE__ = {
      done: true,
      error: null,
      cspViolations: window.__cspViolations,
      pageErrors: window.__pageErrors,
      jsonArtifact: jsonPayload,
      csvArtifacts: csvPayloads,
      xlsxArtifacts: xlsxPayloads,
      negativeResult: {
        caughtErrorCode
      },
      bridge: bridgeCounts,
      client: {
        workersCreated,
        workersTerminated,
        progressCallbacks
      }
    };

    if (statusEl) statusEl.textContent = 'done';
  } catch (err: unknown) {
    handleFailure(err instanceof Error ? err.message : String(err));
  }
}

runClientSmoke();
