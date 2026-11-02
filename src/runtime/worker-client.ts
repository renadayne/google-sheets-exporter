/**
 * T36d1 Bounded Single-Job Worker Writer Client
 *
 * Implements WriterPort backed by a dedicated Web Worker running worker-host / worker-session.
 *
 * CRITICAL INVARIANTS:
 * 1. Single-job ownership: One pre-created worker owned by one client/job, no resetting/reuse.
 * 2. Pure client: NEVER imports worker-writers, worker-host, or ExcelJS in production.
 * 3. Constructor options captured once; invalid configuration throws static CONFIG_INVALID before adopting worker.
 * 4. Strict lifecycle: fresh -> beginning -> ready -> appending -> ready -> finalizing -> terminal.
 * 5. Exactly one pending operation; concurrent or out-of-order calls fail closed with INTERNAL_ERROR,
 *    terminating worker and rejecting both existing pending and new call.
 * 6. Permanent terminal latching: First failure or closure permanently latches safe ErrorCode; later port methods
 *    reject with a new DomainError(latchedErrorCode) with no raw message/stack.
 *    Late ERROR/crash/CANCELLED messages cannot overwrite latched outcome.
 * 7. Snapshot fencing: Snapshots (context, chunk, report) taken before post; getters/traps that abort or call client
 *    are fenced before postMessage.
 * 8. Timer & cancellation: Per-operation timeout timer (FORMAT_SERIALIZATION_FAILED) is owned by PendingOp,
 *    starts BEFORE postMessage, and is never reset by PROGRESS.
 *    Abort (signal or client.abort) terminates worker immediately without waiting for CANCELLED or CPU cooperation.
 * 9. Protocol sanitization: Replies parsed via parseWorkerReply; artifacts via parseWorkerArtifacts.
 *    Cleanup detaches state before external callbacks; each listener removal independently caught.
 */

import type { NormalizedChunk, ExportReport, Artifact } from '../contracts/domain.ts';
import { DomainError, toSafeDomainError, isErrorCode, type ErrorCode } from '../contracts/errors.ts';
import type {
  WorkerPhase,
  WorkerBeginRequest,
  WorkerAppendRequest,
  WorkerFinalizeRequest,
} from '../contracts/messages.ts';
import type { WriterPort, WriterContext } from '../contracts/ports.ts';
import { snapshotWriterContext, PROVISIONAL_MAX_SHEETS } from '../export/context.ts';
import {
  snapshotWriterChunk,
  PROVISIONAL_MAX_CELLS,
  PROVISIONAL_MAX_INTERVALS,
  PROVISIONAL_MAX_DECODED_BYTES,
} from '../export/chunk-snapshot.ts';
import { MAX_JSON_NODES } from '../export/json-encoding.ts';
import { snapshotExportReport } from '../export/report-snapshot.ts';
import { parseWorkerArtifacts } from './worker-artifacts.ts';
import { parseWorkerReply } from './worker-reply-envelope.ts';

export type WorkerEndpoint = Pick<
  Worker,
  'postMessage' | 'addEventListener' | 'removeEventListener' | 'terminate'
>;

export interface WorkerClientOptions {
  readonly worker: WorkerEndpoint;
  readonly jobId: string;
  readonly generation: number;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly onProgress?: (
    progress: Readonly<{
      phase: WorkerPhase;
      chunksCompleted: number;
      totalChunks?: number;
    }>
  ) => void;
}

type ClientState = 'fresh' | 'beginning' | 'ready' | 'appending' | 'finalizing' | 'terminal';

interface PendingOp<T = any> {
  readonly id: symbol;
  readonly type: 'begin' | 'append' | 'finalize';
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  timerId: ReturnType<typeof setTimeout> | null;
  readonly resolve: (val: T) => void;
  readonly reject: (err: any) => void;
}

export function createWorkerWriterClient(options: WorkerClientOptions): WriterPort {
  let rawWorker: WorkerEndpoint;
  let rawJobId: string;
  let rawGeneration: number;
  let rawTimeoutMs: number;
  let rawMaxBytes: number;
  let rawOnProgress:
    | ((progress: Readonly<{ phase: WorkerPhase; chunksCompleted: number; totalChunks?: number }>) => void)
    | undefined;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new DomainError('CONFIG_INVALID');
    }

    rawWorker = options.worker;
    rawJobId = options.jobId;
    rawGeneration = options.generation;
    rawTimeoutMs = options.timeoutMs;
    rawMaxBytes = options.maxBytes;
    rawOnProgress = options.onProgress;

    if (
      typeof rawJobId !== 'string' ||
      rawJobId.length === 0 ||
      typeof rawGeneration !== 'number' ||
      !Number.isSafeInteger(rawGeneration) ||
      rawGeneration < 0 ||
      Object.is(rawGeneration, -0) ||
      typeof rawTimeoutMs !== 'number' ||
      !Number.isSafeInteger(rawTimeoutMs) ||
      rawTimeoutMs < 1 ||
      rawTimeoutMs > 600000 ||
      Object.is(rawTimeoutMs, -0) ||
      typeof rawMaxBytes !== 'number' ||
      !Number.isSafeInteger(rawMaxBytes) ||
      rawMaxBytes < 0 ||
      rawMaxBytes > 64 * 1024 * 1024 ||
      Object.is(rawMaxBytes, -0) ||
      (rawOnProgress !== undefined && typeof rawOnProgress !== 'function') ||
      !rawWorker ||
      typeof rawWorker !== 'object' ||
      typeof rawWorker.postMessage !== 'function' ||
      typeof rawWorker.addEventListener !== 'function' ||
      typeof rawWorker.removeEventListener !== 'function' ||
      typeof rawWorker.terminate !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }

  let state: ClientState = 'fresh';
  let latchedErrorCode: ErrorCode | null = null;
  let ackedChunksCount = 0;
  let capturedContext: WriterContext | null = null;
  let terminated = false;
  let pendingOp: PendingOp | null = null;

  function terminateOnce(): void {
    if (terminated) return;
    terminated = true;
    try {
      rawWorker.removeEventListener('message', onMessage as EventListener);
    } catch {
      // ignore
    }
    try {
      rawWorker.removeEventListener('error', onError as EventListener);
    } catch {
      // ignore
    }
    try {
      rawWorker.removeEventListener('messageerror', onMessageError as EventListener);
    } catch {
      // ignore
    }
    try {
      rawWorker.terminate();
    } catch {
      // ignore
    }
  }

  function failTerminal(code: ErrorCode): void {
    // Permanent terminal latching: guard against overwriting first terminal outcome
    if (state === 'terminal') return;

    // Commit state and detach pending operation FIRST
    const oldOp = pendingOp;
    pendingOp = null;
    state = 'terminal';
    latchedErrorCode = isErrorCode(code) ? code : 'INTERNAL_ERROR';
    capturedContext = null;

    // Clean up timer and abort listener using captured oldOp
    if (oldOp) {
      if (oldOp.timerId !== null) {
        clearTimeout(oldOp.timerId);
        oldOp.timerId = null;
      }
      try {
        oldOp.signal.removeEventListener('abort', oldOp.onAbort);
      } catch {
        // ignore
      }
    }

    terminateOnce();

    if (oldOp) {
      oldOp.reject(new DomainError(latchedErrorCode));
    }
  }

  function failConcurrentOrOutOfOrder(): Promise<never> {
    failTerminal('INTERNAL_ERROR');
    return Promise.reject(new DomainError('INTERNAL_ERROR'));
  }

  function onError(event: Event): void {
    if (state === 'terminal') return;
    try {
      if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
    } catch {
      // ignore
    }
    failTerminal('FORMAT_SERIALIZATION_FAILED');
  }

  function onMessageError(event: Event): void {
    if (state === 'terminal') return;
    try {
      if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
    } catch {
      // ignore
    }
    failTerminal('FORMAT_SERIALIZATION_FAILED');
  }

  function onMessage(event: MessageEvent): void {
    if (state === 'terminal') return;
    const data: unknown = event ? (event as any).data : undefined;
    const parsed = parseWorkerReply(data);

    // Fence after parseWorkerReply before taking any action
    if ((state as ClientState) === 'terminal' || !parsed || parsed.jobId !== rawJobId || parsed.generation !== rawGeneration) {
      return;
    }

    if (parsed.type === 'ACK') {
      if (state === 'beginning' && pendingOp?.type === 'begin') {
        if (parsed.phase === 'begin') {
          const oldOp = pendingOp;
          pendingOp = null;
          state = 'ready';

          if (oldOp) {
            if (oldOp.timerId !== null) {
              clearTimeout(oldOp.timerId);
              oldOp.timerId = null;
            }
            try {
              oldOp.signal.removeEventListener('abort', oldOp.onAbort);
            } catch {
              // ignore
            }
            oldOp.resolve(undefined);
          }
        }
      } else if (state === 'appending' && pendingOp?.type === 'append') {
        if (parsed.phase === 'append') {
          if (parsed.chunksCompleted !== ackedChunksCount + 1) {
            failTerminal('INTERNAL_ERROR');
          } else {
            ackedChunksCount += 1;
            const oldOp = pendingOp;
            pendingOp = null;
            state = 'ready';

            if (oldOp) {
              if (oldOp.timerId !== null) {
                clearTimeout(oldOp.timerId);
                oldOp.timerId = null;
              }
              try {
                oldOp.signal.removeEventListener('abort', oldOp.onAbort);
              } catch {
                // ignore
              }
              oldOp.resolve(undefined);
            }
          }
        }
      }
    } else if (parsed.type === 'PROGRESS') {
      if (state === 'finalizing' && pendingOp?.type === 'finalize') {
        if (parsed.chunksCompleted === ackedChunksCount && (parsed.phase === 'serializing' || parsed.phase === 'finalizing')) {
          if (typeof rawOnProgress === 'function') {
            const progressObj: Readonly<{
              phase: WorkerPhase;
              chunksCompleted: number;
              totalChunks?: number;
            }> = Object.freeze({
              phase: parsed.phase,
              chunksCompleted: parsed.chunksCompleted,
              ...(parsed.totalChunks !== undefined ? { totalChunks: parsed.totalChunks } : {}),
            });
            try {
              rawOnProgress(progressObj);
            } catch {
              failTerminal('INTERNAL_ERROR');
            }
          }
        }
      }
    } else if (parsed.type === 'STAGED_ARTIFACTS') {
      const currentOp = pendingOp;
      if (state !== 'finalizing' || !currentOp || currentOp.type !== 'finalize') {
        return;
      }

      const artifacts = parseWorkerArtifacts(parsed.artifacts, {
        maxArtifacts: 2,
        maxBytes: rawMaxBytes,
      });

      // Fence AFTER parser before any cleanup or resolution:
      // hostile traps during parseWorkerArtifacts may have called client.abort()
      if (state !== 'finalizing' || pendingOp !== currentOp) {
        return;
      }

      if (!artifacts) {
        failTerminal('FORMAT_SERIALIZATION_FAILED');
      } else {
        const oldOp = pendingOp;
        pendingOp = null;
        state = 'terminal';
        latchedErrorCode = 'INTERNAL_ERROR';
        capturedContext = null;

        if (oldOp) {
          if (oldOp.timerId !== null) {
            clearTimeout(oldOp.timerId);
            oldOp.timerId = null;
          }
          try {
            oldOp.signal.removeEventListener('abort', oldOp.onAbort);
          } catch {
            // ignore
          }
        }

        terminateOnce();

        if (oldOp) {
          oldOp.resolve(artifacts);
        }
      }
    } else if (parsed.type === 'ERROR') {
      failTerminal(parsed.code);
    } else if (parsed.type === 'CANCELLED') {
      failTerminal('OPERATION_ABORTED');
    }
  }

  // Install 3 event listeners once on trusted worker endpoint
  rawWorker.addEventListener('message', onMessage as EventListener);
  rawWorker.addEventListener('error', onError as EventListener);
  rawWorker.addEventListener('messageerror', onMessageError as EventListener);

  function startOperation<T>(
    opType: 'begin' | 'append' | 'finalize',
    expectedState: ClientState,
    activePhase: ClientState,
    signal: AbortSignal,
    performSnapshot: (s: AbortSignal) => unknown,
    createRequest: (snapshot: any) => WorkerBeginRequest | WorkerAppendRequest | WorkerFinalizeRequest
  ): Promise<T> {
    if (state === 'terminal') {
      return Promise.reject(new DomainError(latchedErrorCode!));
    }
    if (state !== expectedState || pendingOp !== null || (opType === 'append' && !capturedContext)) {
      return failConcurrentOrOutOfOrder();
    }

    state = activePhase;
    const opId = Symbol();
    let resolvePending!: (value: T | PromiseLike<T>) => void;
    let rejectPending!: (reason?: any) => void;
    const pendingPromise = new Promise<T>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });

    const onAbort = () => {
      if (pendingOp?.id === opId) {
        failTerminal('OPERATION_ABORTED');
      }
    };

    const currentOp: PendingOp<T> = {
      id: opId,
      type: opType,
      signal,
      onAbort,
      timerId: null,
      resolve: resolvePending,
      reject: rejectPending,
    };
    pendingOp = currentOp;

    try {
      if (
        !signal ||
        typeof signal !== 'object' ||
        typeof (signal as any).addEventListener !== 'function' ||
        typeof (signal as any).removeEventListener !== 'function'
      ) {
        throw new DomainError('CONFIG_INVALID');
      }

      const initialAborted = signal.aborted;
      if (typeof initialAborted !== 'boolean') {
        throw new DomainError('CONFIG_INVALID');
      }

      if (initialAborted) {
        failTerminal('OPERATION_ABORTED');
        return pendingPromise;
      }

      signal.addEventListener('abort', onAbort, { once: true });
    } catch {
      if (pendingOp?.id === opId) {
        failTerminal('CONFIG_INVALID');
      }
      return pendingPromise;
    }

    // Fence after signal registration
    if (pendingOp?.id !== opId || state !== activePhase) {
      return pendingPromise;
    }

    let captured: unknown;
    try {
      captured = performSnapshot(signal);
    } catch (err) {
      if (pendingOp?.id === opId) {
        const code = toSafeDomainError(err).code;
        failTerminal(code);
      }
      return pendingPromise;
    }

    // Fence after snapshot helper and before post
    if (pendingOp?.id !== opId || state !== activePhase) {
      return pendingPromise;
    }

    // Lead correction: worker response deadline uses FORMAT_SERIALIZATION_FAILED, not NETWORK_TIMEOUT
    currentOp.timerId = setTimeout(() => {
      if (pendingOp?.id === opId) {
        currentOp.timerId = null;
        failTerminal('FORMAT_SERIALIZATION_FAILED');
      }
    }, rawTimeoutMs);

    const request = Object.freeze(createRequest(captured));

    try {
      rawWorker.postMessage(request);
    } catch {
      if (pendingOp?.id === opId) {
        failTerminal('FORMAT_SERIALIZATION_FAILED');
      }
    }

    return pendingPromise;
  }

  function begin(context: WriterContext, signal: AbortSignal): Promise<void> {
    return startOperation<void>(
      'begin',
      'fresh',
      'beginning',
      signal,
      (s) => {
        const captured = snapshotWriterContext(context, {
          maxSheets: PROVISIONAL_MAX_SHEETS,
          signal: s,
        });
        return captured;
      },
      (captured) => {
        // Commit only after startOperation's ownership fence. A context getter
        // may abort the client while snapshotWriterContext is running.
        capturedContext = captured;
        return {
          protocolVersion: 1,
          jobId: rawJobId,
          generation: rawGeneration,
          type: 'BEGIN',
          context: captured,
        };
      }
    );
  }

  function append(chunk: NormalizedChunk, signal: AbortSignal): Promise<void> {
    return startOperation<void>(
      'append',
      'ready',
      'appending',
      signal,
      (s) => {
        const captured = snapshotWriterChunk(capturedContext!, chunk, {
          maxCells: PROVISIONAL_MAX_CELLS,
          maxIntervals: PROVISIONAL_MAX_INTERVALS,
          maxDecodedBytes: PROVISIONAL_MAX_DECODED_BYTES,
          signal: s,
        });
        if (captured.jobId !== rawJobId) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        return captured;
      },
      (captured) => ({
        protocolVersion: 1,
        jobId: rawJobId,
        generation: rawGeneration,
        type: 'APPEND',
        chunk: captured,
      })
    );
  }

  function finalize(report: ExportReport, signal: AbortSignal): Promise<readonly Artifact[]> {
    return startOperation<readonly Artifact[]>(
      'finalize',
      'ready',
      'finalizing',
      signal,
      (s) =>
        snapshotExportReport(report, {
          maxNodes: MAX_JSON_NODES,
          signal: s,
        }),
      (captured) => ({
        protocolVersion: 1,
        jobId: rawJobId,
        generation: rawGeneration,
        type: 'FINALIZE',
        report: captured,
      })
    );
  }

  async function abort(): Promise<void> {
    if (state === 'terminal') {
      return;
    }
    failTerminal('OPERATION_ABORTED');
  }

  const port: WriterPort = {
    begin,
    append,
    finalize,
    abort,
  };

  return Object.freeze(port);
}
