/**
 * T36b2 Dedicated Worker Session Dispatcher
 *
 * Implements bounded worker session dispatching, managing job identity,
 * monotonic generation watermarks, writer lifecycle, phase transitions, and error sanitization.
 *
 * Invariants & Guarantees:
 * 1. Protocol envelope parsed via parseWorkerCommand. Invalid envelopes ignored.
 * 2. Monotonic generation watermark (initially -1). BEGIN accepted only if generation strictly greater.
 * 3. Generation reserved before awaits. Identity installed immediately; superseded jobs aborted and detached.
 * 4. Fences after each external callback/trap before external writer calls.
 * 5. Current equality + not aborted checked after every await and before every emission.
 * 6. Only current job's matching APPEND/FINALIZE/CANCEL honored. Old/unknown ignored.
 * 7. Matching out-of-order APPEND/FINALIZE fails that job with static INTERNAL_ERROR then abort/discard.
 * 8. Six own enumerable DATA fields captured from APPEND chunk once without redundant re-traps. chunk.jobId === envelope.jobId enforced.
 * 9. Errors sanitized via toSafeDomainError; ERROR emitted with code ONLY without leaking message/stack/tokens.
 * 10. Close is idempotent, permanent, and observes all promises and synchronous throws.
 */

import type {
  ExportFormat,
  ExportReport,
  NormalizedChunk,
  Rect,
  Cell,
  ExcludedIntervals,
  Artifact,
} from '../contracts/domain.ts';
import type { WriterContext, WriterPort } from '../contracts/ports.ts';
import type {
  WorkerResponse,
  WorkerErrorResponse,
  WorkerAckResponse,
  WorkerProgressResponse,
  WorkerStagedArtifactsResponse,
  WorkerCancelledResponse,
} from '../contracts/messages.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { parseWorkerCommand } from './worker-envelope.ts';
import { snapshotWriterContext, PROVISIONAL_MAX_SHEETS } from '../export/context.ts';

export interface WorkerSessionDeps {
  readonly createWriter: (format: ExportFormat) => WriterPort;
  readonly emit: (response: WorkerResponse) => void;
}

export interface WorkerSession {
  readonly handle: (input: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
}

type ActiveJobPhase = 'beginning' | 'ready' | 'appending' | 'finalizing' | 'terminal';

interface ActiveJob {
  readonly jobId: string;
  readonly generation: number;
  readonly controller: AbortController;
  writer: WriterPort | null;
  phase: ActiveJobPhase;
  chunksCompleted: number;
  isTerminal: boolean;
  abortedWriter: boolean;
}

const REQUIRED_CHUNK_KEYS: readonly string[] = Object.freeze([
  'jobId',
  'chunkId',
  'rect',
  'cells',
  'excludedIntervals',
  'byteCount',
]);

function extractChunkWrapper(input: unknown): NormalizedChunk | null {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return null;
    }
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length !== 6) {
      return null;
    }
    const keySet = new Set<string | symbol>(REQUIRED_CHUNK_KEYS);
    for (let i = 0; i < ownKeys.length; i++) {
      const k = ownKeys[i]!;
      if (typeof k !== 'string' || !keySet.has(k)) {
        return null;
      }
    }
    const captured: Record<string, unknown> = Object.create(null);
    for (let i = 0; i < REQUIRED_CHUNK_KEYS.length; i++) {
      const key = REQUIRED_CHUNK_KEYS[i]!;
      const desc = Object.getOwnPropertyDescriptor(input, key);
      if (!desc || !desc.enumerable) {
        return null;
      }
      if (typeof desc.get !== 'undefined' || typeof desc.set !== 'undefined') {
        return null;
      }
      if (!('value' in desc)) {
        return null;
      }
      captured[key] = desc.value;
    }
    return Object.freeze({
      jobId: captured['jobId'] as string,
      chunkId: captured['chunkId'] as string,
      rect: captured['rect'] as Rect,
      cells: captured['cells'] as readonly Cell[],
      excludedIntervals: captured['excludedIntervals'] as ExcludedIntervals,
      byteCount: captured['byteCount'] as number,
    });
  } catch {
    return null;
  }
}

async function safelyAbortWriter(writer: WriterPort | null): Promise<void> {
  if (!writer) return;
  try {
    await writer.abort();
  } catch {
    // Synchronous throw observed and swallowed safely
  }
}

export function createWorkerSession(deps: WorkerSessionDeps): WorkerSession {
  let isClosed = false;
  let closePromise: Promise<void> | null = null;
  let highestAcceptedGeneration = -1;
  let activeJob: ActiveJob | null = null;

  function isCurrent(job: ActiveJob): boolean {
    return (
      !isClosed &&
      activeJob === job &&
      !job.isTerminal &&
      !job.controller.signal.aborted
    );
  }

  function abortAndDetach(job: ActiveJob): void {
    if (activeJob === job) {
      activeJob = null;
    }
    job.isTerminal = true;
    job.phase = 'terminal';
    if (!job.controller.signal.aborted) {
      try {
        job.controller.abort();
      } catch {
        // Observe sync throw
      }
    }
    if (!job.abortedWriter && job.writer) {
      job.abortedWriter = true;
      void safelyAbortWriter(job.writer);
    }
  }

  function safeEmit(job: ActiveJob | null, response: WorkerResponse): void {
    if (isClosed) return;
    if (job && (!isCurrent(job) || job.generation < highestAcceptedGeneration)) {
      return;
    }
    try {
      deps.emit(response);
    } catch {
      if (job) {
        abortAndDetach(job);
      }
    }
  }

  function safeEmitTerminal(job: ActiveJob, response: WorkerResponse): void {
    if (isClosed || job.generation !== highestAcceptedGeneration) {
      return;
    }
    try {
      deps.emit(response);
    } catch {
      abortAndDetach(job);
    }
  }

  function failJob(job: ActiveJob, rawError: unknown): void {
    if (job.isTerminal) {
      return;
    }
    abortAndDetach(job);

    if (isClosed || job.generation < highestAcceptedGeneration) {
      return;
    }

    const domainError = toSafeDomainError(rawError);
    const errorResponse: WorkerErrorResponse = Object.freeze({
      protocolVersion: 1,
      jobId: job.jobId,
      generation: job.generation,
      type: 'ERROR',
      code: domainError.code,
    });

    safeEmitTerminal(job, errorResponse);
  }

  async function handle(input: unknown): Promise<void> {
    try {
      if (isClosed) return;

      const command = parseWorkerCommand(input);
      if (!command || isClosed) return;

      switch (command.type) {
        case 'BEGIN': {
          if (command.generation <= highestAcceptedGeneration) {
            return;
          }
          highestAcceptedGeneration = command.generation;

          const previous = activeJob;
          const controller = new AbortController();
          const job: ActiveJob = {
            jobId: command.jobId,
            generation: command.generation,
            controller,
            writer: null,
            phase: 'beginning',
            chunksCompleted: 0,
            isTerminal: false,
            abortedWriter: false,
          };
          activeJob = job;
          if (previous) abortAndDetach(previous);
          if (!isCurrent(job)) return;

          let snapshot: WriterContext;
          try {
            snapshot = snapshotWriterContext(command.context as WriterContext, {
              maxSheets: PROVISIONAL_MAX_SHEETS,
              signal: controller.signal,
            });
          } catch (err) {
            if (isCurrent(job)) {
              failJob(job, err);
            }
            return;
          }

          if (!isCurrent(job)) {
            return;
          }

          let writer: WriterPort;
          try {
            writer = deps.createWriter(snapshot.format);
          } catch (err) {
            if (isCurrent(job)) {
              failJob(job, err);
            }
            return;
          }

          if (!isCurrent(job)) {
            void safelyAbortWriter(writer);
            return;
          }

          job.writer = writer;

          try {
            await writer.begin(snapshot, controller.signal);
          } catch (err) {
            if (isCurrent(job)) {
              failJob(job, err);
            }
            return;
          }

          if (!isCurrent(job)) {
            return;
          }

          job.phase = 'ready';
          const ackResponse: WorkerAckResponse = Object.freeze({
            protocolVersion: 1,
            jobId: job.jobId,
            generation: job.generation,
            type: 'ACK',
            phase: 'begin',
          });
          safeEmit(job, ackResponse);
          return;
        }

        case 'APPEND': {
          if (
            !activeJob ||
            activeJob.jobId !== command.jobId ||
            activeJob.generation !== command.generation
          ) {
            return;
          }
          const job = activeJob;

          if (job.phase !== 'ready') {
            failJob(job, new DomainError('INTERNAL_ERROR'));
            return;
          }

          job.phase = 'appending';
          const chunkWrapper = extractChunkWrapper(command.chunk);

          // Fence after descriptor capture: Proxy traps may have cancelled, closed, or started new BEGIN
          if (!isCurrent(job)) {
            return;
          }

          if (!chunkWrapper || chunkWrapper.jobId !== command.jobId) {
            failJob(job, new DomainError('FORMAT_SERIALIZATION_FAILED'));
            return;
          }

          if (!isCurrent(job)) {
            return;
          }

          if (!job.writer) {
            return;
          }

          try {
            await job.writer.append(chunkWrapper, job.controller.signal);
          } catch (err) {
            if (isCurrent(job)) {
              failJob(job, err);
            }
            return;
          }

          if (!isCurrent(job)) {
            return;
          }

          job.chunksCompleted++;
          job.phase = 'ready';

          const ackResponse: WorkerAckResponse = Object.freeze({
            protocolVersion: 1,
            jobId: job.jobId,
            generation: job.generation,
            type: 'ACK',
            phase: 'append',
            chunksCompleted: job.chunksCompleted,
          });
          safeEmit(job, ackResponse);
          return;
        }

        case 'FINALIZE': {
          if (
            !activeJob ||
            activeJob.jobId !== command.jobId ||
            activeJob.generation !== command.generation
          ) {
            return;
          }
          const job = activeJob;

          if (job.phase !== 'ready') {
            failJob(job, new DomainError('INTERNAL_ERROR'));
            return;
          }

          job.phase = 'finalizing';

          const progressResponse: WorkerProgressResponse = Object.freeze({
            protocolVersion: 1,
            jobId: job.jobId,
            generation: job.generation,
            type: 'PROGRESS',
            phase: 'serializing',
            chunksCompleted: job.chunksCompleted,
          });
          safeEmit(job, progressResponse);

          // Ownership fence after PROGRESS emit callback before invoking external writer
          if (!isCurrent(job)) {
            return;
          }

          if (!job.writer) {
            return;
          }

          let artifacts: readonly Artifact[];
          try {
            artifacts = await job.writer.finalize(
              command.report as ExportReport,
              job.controller.signal
            );
          } catch (err) {
            if (isCurrent(job)) {
              failJob(job, err);
            }
            return;
          }

          if (!isCurrent(job)) {
            return;
          }

          job.isTerminal = true;
          job.phase = 'terminal';
          if (activeJob === job) {
            activeJob = null;
          }

          const stagedResponse: WorkerStagedArtifactsResponse = Object.freeze({
            protocolVersion: 1,
            jobId: job.jobId,
            generation: job.generation,
            type: 'STAGED_ARTIFACTS',
            artifacts,
          });
          safeEmitTerminal(job, stagedResponse);
          return;
        }

        case 'CANCEL': {
          if (
            !activeJob ||
            activeJob.jobId !== command.jobId ||
            activeJob.generation !== command.generation
          ) {
            return;
          }
          const job = activeJob;

          abortAndDetach(job);

          const cancelResponse: WorkerCancelledResponse = Object.freeze({
            protocolVersion: 1,
            jobId: job.jobId,
            generation: job.generation,
            type: 'CANCELLED',
          });
          safeEmitTerminal(job, cancelResponse);
          return;
        }
      }
    } catch {
      // Unhandled error in session dispatcher must never leak or unhandled reject
    }
  }

  async function close(): Promise<void> {
    if (isClosed) {
      return closePromise ?? Promise.resolve();
    }
    isClosed = true;
    const current = activeJob;
    activeJob = null;
    if (current) {
      current.isTerminal = true;
      current.phase = 'terminal';
      if (!current.controller.signal.aborted) {
        try {
          current.controller.abort();
        } catch {
          // Observe sync throw
        }
      }
      closePromise = (async () => {
        if (current.writer && !current.abortedWriter) {
          current.abortedWriter = true;
          try {
            await current.writer.abort();
          } catch {
            // Observe all sync throws and rejected promises
          }
        }
      })();
      return closePromise;
    }
    return Promise.resolve();
  }

  return Object.freeze({
    handle,
    close,
  });
}
