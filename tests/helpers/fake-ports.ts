/**
 * T10c Scripted Domain Fake Ports
 *
 * Implements deterministic in-memory fake adapters for the domain port contracts:
 * AuthPort, PermissionPort, SheetsPort, SourceObservationPort, WriterPort, DownloadPort.
 *
 * Rules:
 * - Assignable to exact port contracts under strict TypeScript.
 * - Explicit per-method finite queues via AsyncResultQueue; no implicit permitted decisions,
 *   auto-metadata, or auto-completed downloads.
 * - Unconfigured or exhausted queues fail clearly with descriptive errors.
 * - In-flight and pre-aborted cancellation honored via AsyncResultQueue.
 * - In-memory private call logs capture exact argument order; no raw secrets logged or emitted.
 * - Cross-method event log supported for sequence/lifecycle verification across ports.
 * - Independent instances have completely isolated queues and logs.
 */

import type {
  SourceRef,
  AccountContext,
  Eligibility,
  PermittedEligibility,
  WorkbookMeta,
  Rect,
  NormalizedChunk,
  Artifact,
  ExportReport,
  SourceObservation
} from '../../src/contracts/domain.ts';

import type {
  AuthPort,
  PermissionPort,
  SheetsPort,
  SourceObservationPort,
  WriterPort,
  WriterContext,
  DownloadPort,
  DownloadResult,
  GridTransportPayload
} from '../../src/contracts/ports.ts';

import { AsyncResultQueue } from './deterministic.ts';

// --- Shared Event Log Types ---

export interface PortEvent<TCall = unknown> {
  readonly port: string;
  readonly method: string;
  readonly call: TCall;
}

export type EventLog = PortEvent[];

export interface FakePortOptions {
  readonly eventLog?: EventLog | undefined;
}

// --- Generic Internal Method Runner ---

interface MethodRunner<TResult, TCall> {
  readonly queue: AsyncResultQueue<TResult>;
  readonly invoke: (call: TCall, signal?: AbortSignal | undefined) => Promise<TResult>;
}

function createMethodRunner<TResult, TCall>(
  port: string,
  method: string,
  localCalls: TCall[],
  eventLog?: EventLog | undefined
): MethodRunner<TResult, TCall> {
  const queue = new AsyncResultQueue<TResult>();
  return {
    queue,
    invoke: async (call: TCall, signal?: AbortSignal | undefined): Promise<TResult> => {
      Object.freeze(call);
      localCalls.push(call);
      if (eventLog) {
        eventLog.push(Object.freeze({ port, method, call }));
      }
      return queue.next(signal);
    }
  };
}

// --- Fake Auth Port ---

export type FakeAuthCall =
  | { readonly method: 'signIn'; readonly signal: AbortSignal }
  | { readonly method: 'getContext'; readonly signal: AbortSignal }
  | { readonly method: 'getToken'; readonly expectedPrincipalKey: string; readonly signal: AbortSignal }
  | { readonly method: 'signOut'; readonly signal: AbortSignal };

export interface FakeAuthPort extends AuthPort {
  readonly calls: readonly FakeAuthCall[];
  readonly signInQueue: AsyncResultQueue<AccountContext>;
  readonly getContextQueue: AsyncResultQueue<AccountContext | null>;
  readonly getTokenQueue: AsyncResultQueue<string>;
  readonly signOutQueue: AsyncResultQueue<void>;
}

export function createFakeAuthPort(options?: FakePortOptions | undefined): FakeAuthPort {
  const calls: FakeAuthCall[] = [];
  const signInRunner = createMethodRunner<AccountContext, FakeAuthCall>('auth', 'signIn', calls, options?.eventLog);
  const getContextRunner = createMethodRunner<AccountContext | null, FakeAuthCall>('auth', 'getContext', calls, options?.eventLog);
  const getTokenRunner = createMethodRunner<string, FakeAuthCall>('auth', 'getToken', calls, options?.eventLog);
  const signOutRunner = createMethodRunner<void, FakeAuthCall>('auth', 'signOut', calls, options?.eventLog);

  return {
    calls,
    signInQueue: signInRunner.queue,
    getContextQueue: getContextRunner.queue,
    getTokenQueue: getTokenRunner.queue,
    signOutQueue: signOutRunner.queue,
    signIn: (signal: AbortSignal) => signInRunner.invoke({ method: 'signIn', signal }, signal),
    getContext: (signal: AbortSignal) => getContextRunner.invoke({ method: 'getContext', signal }, signal),
    getToken: (expectedPrincipalKey: string, signal: AbortSignal) =>
      getTokenRunner.invoke({ method: 'getToken', expectedPrincipalKey, signal }, signal),
    signOut: (signal: AbortSignal) => signOutRunner.invoke({ method: 'signOut', signal }, signal)
  };
}

// --- Fake Permission Port ---

export type FakePermissionCall = {
  readonly method: 'check';
  readonly source: SourceRef;
  readonly account: AccountContext;
  readonly signal: AbortSignal;
};

export interface FakePermissionPort extends PermissionPort {
  readonly calls: readonly FakePermissionCall[];
  readonly checkQueue: AsyncResultQueue<Eligibility>;
}

export function createFakePermissionPort(options?: FakePortOptions | undefined): FakePermissionPort {
  const calls: FakePermissionCall[] = [];
  const checkRunner = createMethodRunner<Eligibility, FakePermissionCall>('permission', 'check', calls, options?.eventLog);

  return {
    calls,
    checkQueue: checkRunner.queue,
    check: (source: SourceRef, account: AccountContext, signal: AbortSignal) =>
      checkRunner.invoke({ method: 'check', source, account, signal }, signal)
  };
}

// --- Fake Sheets Port ---

export type FakeSheetsCall =
  | {
      readonly method: 'getMetadata';
      readonly source: SourceRef;
      readonly permitted: PermittedEligibility;
      readonly signal: AbortSignal;
    }
  | {
      readonly method: 'readGrid';
      readonly source: SourceRef;
      readonly permitted: PermittedEligibility;
      readonly rect: Rect;
      readonly signal: AbortSignal;
    };

export interface FakeSheetsPort extends SheetsPort {
  readonly calls: readonly FakeSheetsCall[];
  readonly getMetadataQueue: AsyncResultQueue<WorkbookMeta>;
  readonly readGridQueue: AsyncResultQueue<GridTransportPayload>;
}

export function createFakeSheetsPort(options?: FakePortOptions | undefined): FakeSheetsPort {
  const calls: FakeSheetsCall[] = [];
  const metaRunner = createMethodRunner<WorkbookMeta, FakeSheetsCall>('sheets', 'getMetadata', calls, options?.eventLog);
  const gridRunner = createMethodRunner<GridTransportPayload, FakeSheetsCall>('sheets', 'readGrid', calls, options?.eventLog);

  return {
    calls,
    getMetadataQueue: metaRunner.queue,
    readGridQueue: gridRunner.queue,
    getMetadata: (source: SourceRef, permitted: PermittedEligibility, signal: AbortSignal) =>
      metaRunner.invoke({ method: 'getMetadata', source, permitted, signal }, signal),
    readGrid: (source: SourceRef, permitted: PermittedEligibility, rect: Rect, signal: AbortSignal) =>
      gridRunner.invoke({ method: 'readGrid', source, permitted, rect, signal }, signal)
  };
}

// --- Fake Source Observation Port ---

export type FakeSourceObservationCall = {
  readonly method: 'observe';
  readonly source: SourceRef;
  readonly permitted: PermittedEligibility;
  readonly signal: AbortSignal;
};

export interface FakeSourceObservationPort extends SourceObservationPort {
  readonly calls: readonly FakeSourceObservationCall[];
  readonly observeQueue: AsyncResultQueue<SourceObservation>;
}

export function createFakeSourceObservationPort(
  options?: FakePortOptions | undefined
): FakeSourceObservationPort {
  const calls: FakeSourceObservationCall[] = [];
  const observeRunner = createMethodRunner<SourceObservation, FakeSourceObservationCall>(
    'observation',
    'observe',
    calls,
    options?.eventLog
  );

  return {
    calls,
    observeQueue: observeRunner.queue,
    observe: (source: SourceRef, permitted: PermittedEligibility, signal: AbortSignal) =>
      observeRunner.invoke({ method: 'observe', source, permitted, signal }, signal)
  };
}

// --- Fake Writer Port ---

export type FakeWriterCall =
  | { readonly method: 'begin'; readonly context: WriterContext; readonly signal: AbortSignal }
  | { readonly method: 'append'; readonly chunk: NormalizedChunk; readonly signal: AbortSignal }
  | { readonly method: 'finalize'; readonly report: ExportReport; readonly signal: AbortSignal }
  | { readonly method: 'abort' };

export interface FakeWriterPort extends WriterPort {
  readonly calls: readonly FakeWriterCall[];
  readonly beginQueue: AsyncResultQueue<void>;
  readonly appendQueue: AsyncResultQueue<void>;
  readonly finalizeQueue: AsyncResultQueue<readonly Artifact[]>;
  readonly abortQueue: AsyncResultQueue<void>;
}

export function createFakeWriterPort(options?: FakePortOptions | undefined): FakeWriterPort {
  const calls: FakeWriterCall[] = [];
  const beginRunner = createMethodRunner<void, FakeWriterCall>('writer', 'begin', calls, options?.eventLog);
  const appendRunner = createMethodRunner<void, FakeWriterCall>('writer', 'append', calls, options?.eventLog);
  const finalizeRunner = createMethodRunner<readonly Artifact[], FakeWriterCall>('writer', 'finalize', calls, options?.eventLog);
  const abortRunner = createMethodRunner<void, FakeWriterCall>('writer', 'abort', calls, options?.eventLog);

  return {
    calls,
    beginQueue: beginRunner.queue,
    appendQueue: appendRunner.queue,
    finalizeQueue: finalizeRunner.queue,
    abortQueue: abortRunner.queue,
    begin: (context: WriterContext, signal: AbortSignal) =>
      beginRunner.invoke({ method: 'begin', context, signal }, signal),
    append: (chunk: NormalizedChunk, signal: AbortSignal) =>
      appendRunner.invoke({ method: 'append', chunk, signal }, signal),
    finalize: (report: ExportReport, signal: AbortSignal) =>
      finalizeRunner.invoke({ method: 'finalize', report, signal }, signal),
    abort: () => abortRunner.invoke({ method: 'abort' }, undefined)
  };
}

// --- Fake Download Port ---

export type FakeDownloadCall = {
  readonly method: 'publish';
  readonly artifacts: readonly Artifact[];
  readonly signal: AbortSignal;
};

export interface FakeDownloadPort extends DownloadPort {
  readonly calls: readonly FakeDownloadCall[];
  readonly publishQueue: AsyncResultQueue<readonly DownloadResult[]>;
}

export function createFakeDownloadPort(options?: FakePortOptions | undefined): FakeDownloadPort {
  const calls: FakeDownloadCall[] = [];
  const publishRunner = createMethodRunner<readonly DownloadResult[], FakeDownloadCall>(
    'download',
    'publish',
    calls,
    options?.eventLog
  );

  return {
    calls,
    publishQueue: publishRunner.queue,
    publish: (artifacts: readonly Artifact[], signal: AbortSignal) =>
      publishRunner.invoke({ method: 'publish', artifacts, signal }, signal)
  };
}
