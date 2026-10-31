/**
 * T08c Typed Worker-Message Protocol Contracts
 * Discriminated unions for communication between extension controller and dedicated export worker.
 * All messages require protocolVersion: 1, jobId: string, generation: number.
 * No worker command/response authorizes publication; final controller gate alone calls DownloadPort.
 *
 * Runtime obligations for T36:
 * 1. Validate message version (protocolVersion === 1) and discriminated type at runtime.
 * 2. Validate identifiers: non-empty jobId string and safe non-negative finite integer generation.
 * 3. Enforce chunk.jobId === envelope.jobId in APPEND messages.
 * 4. Verify message matches expected active jobId and current generation; discard stale messages.
 * 5. Whitelist context fields and verify bounds; reject auth properties at runtime.
 * NOTE: TypeScript compile-time checks are erased at runtime; TS alone is NOT runtime or privacy validation.
 */

import type { NormalizedChunk, ExportReport, Artifact } from './domain.ts';
import type { WriterContext } from './ports.ts';
import type { ErrorCode } from './errors.ts';

/** Base envelope required on every job message across the worker boundary. */
export interface WorkerJobEnvelope {
  readonly protocolVersion: 1;
  readonly jobId: string;
  readonly generation: number;

  // Forbidden auth, credential, and principal fields.
  // Optional never ensures structural typing rejects contaminated variables and requests.
  readonly principalKey?: never;
  readonly displayEmail?: never;
  readonly email?: never;
  readonly principal?: never;
  readonly token?: never;
  readonly accessToken?: never;
  readonly refreshToken?: never;
  readonly authorization?: never;
  readonly headers?: never;
  readonly account?: never;
  readonly auth?: never;
  readonly exportRequest?: never;
}

// --- Worker Requests (Controller -> Worker) ---

export interface WorkerBeginRequest extends WorkerJobEnvelope {
  readonly type: 'BEGIN';
  readonly context: WriterContext;
}

export interface WorkerAppendRequest extends WorkerJobEnvelope {
  readonly type: 'APPEND';
  readonly chunk: NormalizedChunk;
}

export interface WorkerFinalizeRequest extends WorkerJobEnvelope {
  readonly type: 'FINALIZE';
  readonly report: ExportReport;
}

export interface WorkerCancelRequest extends WorkerJobEnvelope {
  readonly type: 'CANCEL';
}

export type WorkerRequest =
  | WorkerBeginRequest
  | WorkerAppendRequest
  | WorkerFinalizeRequest
  | WorkerCancelRequest;

// --- Worker Responses (Worker -> Controller) ---

export type WorkerPhase = 'begin' | 'append' | 'serializing' | 'finalizing';

export interface WorkerAckResponse extends WorkerJobEnvelope {
  readonly type: 'ACK';
  readonly phase?: WorkerPhase;
  readonly chunksCompleted?: number;
  readonly totalChunks?: number;
  readonly percent?: never;
  readonly percentage?: never;
}

export interface WorkerProgressResponse extends WorkerJobEnvelope {
  readonly type: 'PROGRESS';
  readonly phase: WorkerPhase;
  readonly chunksCompleted: number;
  readonly totalChunks?: number;
  // Disallow synthetic/fake percentages when total is unknown or approximate
  readonly percent?: never;
  readonly percentage?: never;
}

/** Staged artifacts held private in controller memory; does not authorize publication. */
export interface WorkerStagedArtifactsResponse extends WorkerJobEnvelope {
  readonly type: 'STAGED_ARTIFACTS';
  readonly artifacts: readonly Artifact[];
}

export interface WorkerErrorResponse extends WorkerJobEnvelope {
  readonly type: 'ERROR';
  readonly code: ErrorCode;
  readonly sheetId?: number;
  readonly r?: number;
  readonly c?: number;

  // Forbid raw/arbitrary error details to prevent token, message, or stack leakage
  readonly message?: never;
  readonly stack?: never;
  readonly body?: never;
  readonly cause?: never;
  readonly error?: never;
}

export interface WorkerCancelledResponse extends WorkerJobEnvelope {
  readonly type: 'CANCELLED';
}

export type WorkerResponse =
  | WorkerAckResponse
  | WorkerProgressResponse
  | WorkerStagedArtifactsResponse
  | WorkerErrorResponse
  | WorkerCancelledResponse;

export type WorkerMessage = WorkerRequest | WorkerResponse;
