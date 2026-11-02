/**
 * T36c2 Dedicated Production Writer Worker Entry
 *
 * Dedicated Worker entry point for off-thread document serialization.
 * Connects trusted native worker messaging to createWorkerHost.
 *
 * Invariants & Guarantees:
 * 1. No auth, network, download or storage operations in this entry.
 * 2. Trusted native scope: Adapts Worker postMessage/addEventListener directly without arbitrary dependencies.
 * 3. Exact listener: Listens for 'message' events and routes event.data to host.handle.
 * 4. Closed fence: Idempotent close removes the listener, closes host, and suppresses any late outputs.
 * 5. Clean environment: Auto-installs only in dedicated worker environments; no Node/window side effects.
 * 6. No leaks: No errors or source text logged; no public global job state.
 */

import type { WorkerResponse } from '../contracts/messages.ts';
import { createWorkerHost } from './worker-host.ts';

export interface WriterWorkerScope {
  readonly postMessage: (message: WorkerResponse, transfer: Transferable[]) => void;
  readonly addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void
  ) => void;
  readonly removeEventListener: (
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void
  ) => void;
}

export function installWriterWorker(
  scope: WriterWorkerScope
): Readonly<{ close: () => Promise<void> }> {
  let isClosed = false;
  let closePromise: Promise<void> | null = null;

  const host = createWorkerHost((response: WorkerResponse, transfer: Transferable[]): void => {
    if (isClosed) {
      return;
    }
    scope.postMessage(response, transfer);
  });

  const listener = (event: MessageEvent<unknown>): void => {
    if (isClosed) {
      return;
    }
    void host.handle(event.data);
  };

  scope.addEventListener('message', listener);

  function close(): Promise<void> {
    if (isClosed) {
      return closePromise ?? Promise.resolve();
    }
    isClosed = true;
    try {
      scope.removeEventListener('message', listener);
    } catch {
      // Safe absorption: never log errors or source text
    }
    closePromise = host.close();
    return closePromise;
  }

  return Object.freeze({
    close,
  });
}

// Auto-install ONLY when running in a dedicated worker-like global environment.
// Never run in Node or browser window environments (no side effects).
if (
  typeof document === 'undefined' &&
  typeof (globalThis as { postMessage?: unknown }).postMessage === 'function' &&
  typeof (globalThis as { addEventListener?: unknown }).addEventListener === 'function' &&
  typeof (globalThis as { removeEventListener?: unknown }).removeEventListener === 'function'
) {
  // Type assertion ONLY on the trusted global native worker adapter, not untrusted data.
  installWriterWorker(globalThis as unknown as WriterWorkerScope);
}
