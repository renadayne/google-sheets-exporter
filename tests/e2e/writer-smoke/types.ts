/**
 * Shared types for Writer Smoke Harness (T36a and T36c3b).
 */

export interface CspViolationRecord {
  blockedURI: string;
  violatedDirective: string;
  effectiveDirective: string;
}

export interface SmokeArtifactPayload {
  filename: string;
  mimeType: string;
  byteLength: number;
  base64: string;
}

export interface SmokeBridgeCounts {
  commands: number;
  acks: number;
  progress: number;
  staged: number;
  errors: number;
  unexpected: number;
}

export interface SmokeClientCounts {
  workersCreated: number;
  workersTerminated: number;
  progressCallbacks: number;
}

export interface SmokeClientLifecycle {
  workersCreated: number;
  terminateCalls: number;
  cancelledStages: ('begin' | 'append' | 'finalize')[];
  cancelCodes: string[];
  requestTypes: string[][];
  acceptedArtifactsAfterAbort: number;
  crashCode: string | null;
  crashWorkerErrors: number;
}

export interface SmokeResult {
  done: boolean;
  error: string | null;
  cspViolations: CspViolationRecord[];
  pageErrors: string[];
  transferredBufferByteLengths?: number[] | undefined;
  jsonArtifact?: SmokeArtifactPayload | undefined;
  csvArtifacts?: SmokeArtifactPayload[] | undefined;
  xlsxArtifacts?: SmokeArtifactPayload[] | undefined;
  negativeResult?: {
    caughtErrorCode: string | null;
  } | undefined;
  bridge?: SmokeBridgeCounts | undefined;
  client?: SmokeClientCounts | undefined;
  clientLifecycle?: SmokeClientLifecycle | undefined;
}

declare global {
  interface Window {
    __cspViolations: CspViolationRecord[];
    __pageErrors: string[];
    __WRITER_SMOKE__: SmokeResult | null;
  }
}
