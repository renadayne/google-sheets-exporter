/**
 * T08b Port Contracts
 * Readonly interfaces defining trust boundaries between domain, auth, Sheets API, serializers, and download.
 * Declared contracts: readonly structures, explicit AbortSignal cancellation, no any or open index signatures.
 * Adapters must implement these interfaces; ports do not perform runtime work.
 */

import type {
  SourceRef,
  AccountContext,
  Eligibility,
  PermittedEligibility,
  WorkbookMeta,
  Rect,
  ExportScope,
  ExportMode,
  ExportFormat,
  VisibilityMode,
  NormalizedChunk,
  Artifact,
  SheetMeta,
  ExportReport,
  SourceObservation
} from './domain.ts';
import type { ErrorCode } from './errors.ts';

// --- Auth Port ---

export interface AuthPort {
  /**
   * Initiate user authentication.
   * Tokens stay exclusively in auth/network memory and are never returned or persisted in domain objects.
   */
  readonly signIn: (signal: AbortSignal) => Promise<AccountContext>;

  /**
   * Retrieve active authenticated account context, or null if unauthenticated.
   */
  readonly getContext: (signal: AbortSignal) => Promise<AccountContext | null>;

  /**
   * Acquire a fresh bearer token bound to the expected authenticated principal.
   * Implementation must verify active account matches expectedPrincipalKey before returning token.
   * Tokens stay exclusively in auth/network memory.
   */
  readonly getToken: (expectedPrincipalKey: string, signal: AbortSignal) => Promise<string>;

  /**
   * Clear application authentication state and discard Chrome's cached token.
   * Cache removal does not by itself revoke the token at Google.
   */
  readonly signOut: (signal: AbortSignal) => Promise<void>;
}

// --- Permission Port ---

export interface PermissionPort {
  /**
   * Query documented permission metadata; never read cells to establish eligibility.
   * Prior positive cache alone does NOT grant future publication; controller final gate is mandatory.
   */
  readonly check: (
    source: SourceRef,
    account: AccountContext,
    signal: AbortSignal
  ) => Promise<Eligibility>;
}

// --- Sheets Port ---

export interface GridTransportPayload {
  /** Parsed JSON, still unvalidated; remains unknown until the domain parser checks it. */
  readonly payload: unknown;
  /** Decoded response-body bytes, not compressed Content-Length or a heap-memory estimate. */
  readonly byteCount: number;
}

export interface SheetsPort {
  /**
   * Retrieve workbook metadata. Requires explicit source reference and active PermittedEligibility.
   */
  readonly getMetadata: (
    source: SourceRef,
    permitted: PermittedEligibility,
    signal: AbortSignal
  ) => Promise<WorkbookMeta>;

  /**
   * Read raw grid chunk. Requires explicit source, active PermittedEligibility, target Rect, and signal.
   * Returns transport payload typed as unknown (never any) with byte count.
   */
  readonly readGrid: (
    source: SourceRef,
    permitted: PermittedEligibility,
    rect: Rect,
    signal: AbortSignal
  ) => Promise<GridTransportPayload>;
}

/** Observe version/modifiedTime without promising an atomic Sheets snapshot. */
export interface SourceObservationPort {
  readonly observe: (
    source: SourceRef,
    permitted: PermittedEligibility,
    signal: AbortSignal
  ) => Promise<SourceObservation>;
}

// --- Writer Port and Sanitized Context ---

/**
 * Sanitized context for export serialization.
 * Projected from source metadata and export request parameters.
 * Explicitly forbids principal and auth/token fields via optional never so full ExportRequest
 * or AccountContext variables fail compile-time assignment.
 */
export interface WriterContext {
  readonly sourceId: string;
  readonly title: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly scopes: readonly ExportScope[];
  readonly mode: ExportMode;
  readonly format: ExportFormat;
  readonly visibility: VisibilityMode;
  readonly limitsVersion: string;
  readonly sheetOrder: readonly number[];
  /** Selected sheet names/indices, in the same source order as scopes. */
  readonly sheets: readonly SheetMeta[];

  // Explicitly forbidden auth / credential fields.
  // Optional never ensures structural typing rejects bound requests or accounts.
  readonly principalKey?: never;
  readonly displayEmail?: never;
  readonly accessToken?: never;
  readonly refreshToken?: never;
  readonly token?: never;
  readonly account?: never;
  readonly authorization?: never;
  readonly headers?: never;
}

export interface WriterPort {
  /** Initialize writer with sanitized context. */
  readonly begin: (context: WriterContext, signal: AbortSignal) => Promise<void>;

  /** Append normalized grid chunk to serializer. */
  readonly append: (chunk: NormalizedChunk, signal: AbortSignal) => Promise<void>;

  /** Finalize with the caller's scope/consistency report; reject incomplete/mismatched reports.
   * Returned artifacts remain private and never imply permission to publish. */
  readonly finalize: (report: ExportReport, signal: AbortSignal) => Promise<readonly Artifact[]>;

  /** Abort serialization and discard intermediate state. */
  readonly abort: () => Promise<void>;
}

// --- Download Port ---

export type DownloadOutcome = 'completed' | 'interrupted';

export interface DownloadResult {
  readonly filename: string;
  readonly outcome: DownloadOutcome;
  readonly downloadId?: number;
  readonly error?: ErrorCode;
}

export interface DownloadPort {
  /**
   * Publish staged private artifacts to browser download manager.
   * Controller final gate is the sole authority to invoke publication, not worker success.
   */
  readonly publish: (
    artifacts: readonly Artifact[],
    signal: AbortSignal
  ) => Promise<readonly DownloadResult[]>;
}

// --- Deterministic Testing Utilities ---

export interface Clock {
  readonly now: () => number;
}

export interface Random {
  readonly next: () => number;
}

export interface Fetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}
