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
import { parseWorkerCommand } from '../../../src/runtime/worker-envelope.ts';
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

let lifecycleWorkersCreated = 0;
let lifecycleTerminateCalls = 0;
const cancelledStages: ('begin' | 'append' | 'finalize')[] = [];
const cancelCodes: string[] = [];
const cancelRequestTypes: string[][] = [];
let acceptedArtifactsAfterAbort = 0;
let crashCode: string | null = null;
let crashWorkerErrors = 0;

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
    },
    clientLifecycle: {
      workersCreated: lifecycleWorkersCreated,
      terminateCalls: lifecycleTerminateCalls,
      cancelledStages,
      cancelCodes,
      requestTypes: cancelRequestTypes,
      acceptedArtifactsAfterAbort,
      crashCode,
      crashWorkerErrors
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

function createLifecycleCancelWorker(label: string): {
  worker: Worker;
  requestTypes: string[];
} {
  const worker = new Worker(
    new URL('../../../src/runtime/writer-worker.ts', import.meta.url),
    { type: 'module' }
  );
  lifecycleWorkersCreated++;
  outstandingWorkers.add(worker);

  const origTerminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    lifecycleTerminateCalls++;
    origTerminate();
    outstandingWorkers.delete(worker);
  };

  worker.onerror = () => {
    handleFailure(`Unexpected native worker error event in ${label}`);
  };

  worker.onmessageerror = () => {
    handleFailure(`Unexpected native worker messageerror event in ${label}`);
  };

  const requestTypes: string[] = [];
  const origPostMessage = worker.postMessage.bind(worker);
  worker.postMessage = ((message: unknown, transferOrOptions?: unknown) => {
    const parsed = parseWorkerCommand(message);
    if (parsed) {
      requestTypes.push(parsed.type);
    }
    if (transferOrOptions !== undefined) {
      return (origPostMessage as any)(message, transferOrOptions);
    }
    return (origPostMessage as any)(message);
  }) as typeof worker.postMessage;

  return { worker, requestTypes };
}

function createCrashWorker(): Worker {
  const worker = new Worker(
    new URL('./client-crash-worker.ts', import.meta.url),
    { type: 'module' }
  );
  lifecycleWorkersCreated++;
  outstandingWorkers.add(worker);

  const origTerminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    lifecycleTerminateCalls++;
    origTerminate();
    outstandingWorkers.delete(worker);
  };

  worker.onerror = () => {
    crashWorkerErrors++;
  };

  worker.onmessageerror = () => {
    handleFailure('Unexpected native worker messageerror event in crash worker');
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

    // 5. Lifecycle Scenarios (T36d2b)
    // 1 begin pending: start actual client.begin, attach outcome handlers, immediately client.abort synchronously before yielding to messages.
    const cancel1 = createLifecycleCancelWorker('cancel stage begin');
    const clientLifecycle1 = createWorkerWriterClient({
      worker: cancel1.worker,
      jobId: 'smoke_job_1',
      generation: 4,
      timeoutMs: 10000,
      maxBytes: 64 * 1024 * 1024
    });
    ownedClients.add(clientLifecycle1);

    const ac1 = new AbortController();
    const ctx1 = createContext('json', ac1.signal);
    let p1Resolved = false;
    let p1Rejection: unknown = null;
    const p1 = clientLifecycle1.begin(ctx1, ac1.signal);
    p1.then(
      () => {
        p1Resolved = true;
      },
      (err) => {
        p1Rejection = err;
      }
    );
    void clientLifecycle1.abort();

    try {
      await p1;
    } catch {
      // Expected rejection
    }

    if (p1Resolved) {
      throw new Error('Cancel stage begin: client.begin unexpectedly resolved after abort');
    }
    if (!(p1Rejection instanceof DomainError)) {
      throw new Error('Cancel stage begin: expected static DomainError rejection');
    }
    cancelledStages.push('begin');
    cancelCodes.push(p1Rejection.code);
    cancelRequestTypes.push(cancel1.requestTypes);
    ownedClients.delete(clientLifecycle1);

    // 2 append pending: await actual BEGIN ACK, start APPEND(chunk30), attach outcome handlers, immediately abort.
    const cancel2 = createLifecycleCancelWorker('cancel stage append');
    const clientLifecycle2 = createWorkerWriterClient({
      worker: cancel2.worker,
      jobId: 'smoke_job_1',
      generation: 5,
      timeoutMs: 10000,
      maxBytes: 64 * 1024 * 1024
    });
    ownedClients.add(clientLifecycle2);

    const ac2 = new AbortController();
    const ctx2 = createContext('json', ac2.signal);
    await clientLifecycle2.begin(ctx2, ac2.signal);

    let p2Resolved = false;
    let p2Rejection: unknown = null;
    const p2 = clientLifecycle2.append(chunk30, ac2.signal);
    p2.then(
      () => {
        p2Resolved = true;
      },
      (err) => {
        p2Rejection = err;
      }
    );
    void clientLifecycle2.abort();

    try {
      await p2;
    } catch {
      // Expected rejection
    }

    if (p2Resolved) {
      throw new Error('Cancel stage append: client.append unexpectedly resolved after abort');
    }
    if (!(p2Rejection instanceof DomainError)) {
      throw new Error('Cancel stage append: expected static DomainError rejection');
    }
    cancelledStages.push('append');
    cancelCodes.push(p2Rejection.code);
    cancelRequestTypes.push(cancel2.requestTypes);
    ownedClients.delete(clientLifecycle2);

    // 3 finalize pending: actual XLSX begin and all 3 append ACKs, start finalize matching report, attach handlers, immediately abort.
    const cancel3 = createLifecycleCancelWorker('cancel stage finalize');
    const clientLifecycle3 = createWorkerWriterClient({
      worker: cancel3.worker,
      jobId: 'smoke_job_1',
      generation: 6,
      timeoutMs: 10000,
      maxBytes: 64 * 1024 * 1024
    });
    ownedClients.add(clientLifecycle3);

    const ac3 = new AbortController();
    const ctx3 = createContext('xlsx', ac3.signal);
    const report3 = createReport(ctx3, 'xlsx');

    await clientLifecycle3.begin(ctx3, ac3.signal);
    await clientLifecycle3.append(chunk30, ac3.signal);
    await clientLifecycle3.append(chunk10, ac3.signal);
    await clientLifecycle3.append(chunk20, ac3.signal);

    let p3Resolved = false;
    let p3Rejection: unknown = null;
    const p3 = clientLifecycle3.finalize(report3, ac3.signal);
    p3.then(
      (artifacts) => {
        p3Resolved = true;
        if (Array.isArray(artifacts)) {
          acceptedArtifactsAfterAbort += artifacts.length;
        }
      },
      (err) => {
        p3Rejection = err;
      }
    );
    void clientLifecycle3.abort();

    try {
      await p3;
    } catch {
      // Expected rejection
    }

    if (p3Resolved) {
      throw new Error('Cancel stage finalize: client.finalize unexpectedly resolved after abort');
    }
    if (!(p3Rejection instanceof DomainError)) {
      throw new Error('Cancel stage finalize: expected static DomainError rejection');
    }
    cancelledStages.push('finalize');
    cancelCodes.push(p3Rejection.code);
    cancelRequestTypes.push(cancel3.requestTypes);
    ownedClients.delete(clientLifecycle3);

    // 4 native crash: module Worker from client-crash-worker.ts which throws synthetic Error upon received message.
    // Actual client.begin must reject static FORMAT_SERIALIZATION_FAILED; native worker error event observed exactly once.
    const crashWorker = createCrashWorker();
    const crashClient = createWorkerWriterClient({
      worker: crashWorker,
      jobId: 'smoke_job_1',
      generation: 7,
      timeoutMs: 10000,
      maxBytes: 64 * 1024 * 1024
    });
    ownedClients.add(crashClient);

    const acCrash = new AbortController();
    const ctxCrash = createContext('json', acCrash.signal);
    let crashResolved = false;
    let crashRejection: unknown = null;
    try {
      await crashClient.begin(ctxCrash, acCrash.signal);
      crashResolved = true;
    } catch (err: unknown) {
      crashRejection = err;
    }

    if (crashResolved) {
      throw new Error('Crash scenario: client.begin unexpectedly resolved on worker crash');
    }
    if (!(crashRejection instanceof DomainError)) {
      throw new Error('Crash scenario: expected static DomainError rejection');
    }
    crashCode = crashRejection.code;
    ownedClients.delete(crashClient);

    // Settled clients must already have terminated their owned workers.
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
    if (lifecycleWorkersCreated !== 4 || lifecycleTerminateCalls !== 4) {
      throw new Error(`Lifecycle worker count mismatch: created ${lifecycleWorkersCreated}, terminated ${lifecycleTerminateCalls}`);
    }
    if (crashWorkerErrors !== 1) {
      throw new Error(`Crash worker errors mismatch: expected 1, got ${crashWorkerErrors}`);
    }
    if (acceptedArtifactsAfterAbort !== 0) {
      throw new Error(`Accepted artifacts after abort mismatch: expected 0, got ${acceptedArtifactsAfterAbort}`);
    }
    if (crashCode !== 'FORMAT_SERIALIZATION_FAILED') {
      throw new Error(`Crash code mismatch: expected FORMAT_SERIALIZATION_FAILED, got ${crashCode}`);
    }
    if (cancelCodes.length !== 3 || cancelCodes.some((c) => c !== 'OPERATION_ABORTED')) {
      throw new Error(`Cancel codes mismatch: expected three OPERATION_ABORTED, got ${JSON.stringify(cancelCodes)}`);
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
      },
      clientLifecycle: {
        workersCreated: lifecycleWorkersCreated,
        terminateCalls: lifecycleTerminateCalls,
        cancelledStages,
        cancelCodes,
        requestTypes: cancelRequestTypes,
        acceptedArtifactsAfterAbort,
        crashCode,
        crashWorkerErrors
      }
    };

    if (statusEl) statusEl.textContent = 'done';
  } catch (err: unknown) {
    handleFailure(err instanceof Error ? err.message : String(err));
  }
}

runClientSmoke();
