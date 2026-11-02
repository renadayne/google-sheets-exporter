/**
 * T31b1 Bounded Download Completion Observer
 *
 * Observes completion of a Chrome download using chrome.downloads.search
 * and chrome.downloads.onChanged events.
 *
 * Primary documentation:
 * https://developer.chrome.com/docs/extensions/reference/api/downloads
 */

import { DomainError } from '../contracts/errors.ts';

export type DownloadCompletion = 'completed' | 'interrupted' | 'unverified';

export interface DownloadsObservationApi {
  search: (query: { id: number }) => Promise<unknown>;
  onChanged: {
    addListener: (listener: (delta: unknown) => void) => void;
    removeListener: (listener: (delta: unknown) => void) => void;
  };
}

export interface DownloadObserverOptions {
  signal: AbortSignal;
  timeoutMs: number;
}

export function observeDownloadCompletion(
  api: DownloadsObservationApi,
  downloadId: number,
  options: { signal: AbortSignal; timeoutMs: number }
): Promise<DownloadCompletion> {
  let capturedId: number;
  let capturedTimeoutMs: number;
  let capturedSignal: AbortSignal;
  let capturedAddListener: (type: 'abort', listener: () => void) => void;
  let capturedRemoveListener: (type: 'abort', listener: () => void) => void;

  try {
    if (!api || typeof api !== 'object') {
      return Promise.reject(new DomainError('CONFIG_INVALID'));
    }
    if (typeof api.search !== 'function') {
      return Promise.reject(new DomainError('CONFIG_INVALID'));
    }
    if (!api.onChanged || typeof api.onChanged !== 'object') {
      return Promise.reject(new DomainError('CONFIG_INVALID'));
    }
    if (
      typeof api.onChanged.addListener !== 'function' ||
      typeof api.onChanged.removeListener !== 'function'
    ) {
      return Promise.reject(new DomainError('CONFIG_INVALID'));
    }

    if (
      typeof downloadId !== 'number' ||
      !Number.isSafeInteger(downloadId) ||
      downloadId < 0 || Object.is(downloadId, -0)
    ) {
      return Promise.reject(new DomainError('CONFIG_INVALID'));
    }
    capturedId = downloadId;

    if (!options || typeof options !== 'object') {
      return Promise.reject(new DomainError('CONFIG_INVALID'));
    }

    const rawTimeout = options.timeoutMs;
    if (
      typeof rawTimeout !== 'number' ||
      !Number.isSafeInteger(rawTimeout) ||
      rawTimeout < 1 ||
      rawTimeout > 600000
    ) {
      return Promise.reject(new DomainError('CONFIG_INVALID'));
    }
    capturedTimeoutMs = rawTimeout;

    const rawSignal = options.signal;
    if (!rawSignal || typeof rawSignal !== 'object') {
      return Promise.reject(new DomainError('CONFIG_INVALID'));
    }

    const isAborted = rawSignal.aborted;
    if (typeof isAborted !== 'boolean') {
      return Promise.reject(new DomainError('CONFIG_INVALID'));
    }
    const addListenerFn = rawSignal.addEventListener;
    const removeListenerFn = rawSignal.removeEventListener;
    if (
      typeof addListenerFn !== 'function' ||
      typeof removeListenerFn !== 'function'
    ) {
      return Promise.reject(new DomainError('CONFIG_INVALID'));
    }

    if (isAborted) {
      return Promise.reject(new DomainError('OPERATION_ABORTED'));
    }

    capturedSignal = rawSignal;
    capturedAddListener = (type, listener) => addListenerFn.call(rawSignal, type, listener);
    capturedRemoveListener = (type, listener) => removeListenerFn.call(rawSignal, type, listener);
  } catch {
    return Promise.reject(new DomainError('CONFIG_INVALID'));
  }

  return new Promise<DownloadCompletion>((resolve, reject) => {
    let settled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let changedListener: ((delta: unknown) => void) | null = null;
    let abortListener: (() => void) | null = null;

    function cleanup(): void {
      if (timerId !== null) {
        try {
          clearTimeout(timerId);
        } catch {
          // ignore
        }
        timerId = null;
      }
      if (abortListener !== null) {
        try {
          capturedRemoveListener('abort', abortListener);
        } catch {
          // ignore
        }
        abortListener = null;
      }
      if (changedListener !== null) {
        try {
          api.onChanged.removeListener(changedListener);
        } catch {
          // ignore
        }
        changedListener = null;
      }
    }

    function settleResolve(outcome: DownloadCompletion): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    }

    function settleReject(err: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function handleSearchResult(rawResult: unknown): void {
      if (settled) return;

      let item: unknown;
      try {
        if (!Array.isArray(rawResult)) {
          settleResolve('unverified');
          return;
        }
        const length = Object.getOwnPropertyDescriptor(rawResult, 'length');
        if (!length || !('value' in length) || length.value !== 1) {
          settleResolve('unverified');
          return;
        }
        if (settled) return;
        const element = Object.getOwnPropertyDescriptor(rawResult, '0');
        if (!element || 'get' in element || 'set' in element || !('value' in element)) {
          settleResolve('unverified');
          return;
        }
        item = element.value;
      } catch {
        settleResolve('unverified');
        return;
      }

      if (settled) return;
      if (typeof item !== 'object' || item === null) {
        settleResolve('unverified');
        return;
      }

      let idDesc: PropertyDescriptor | undefined;
      let stateDesc: PropertyDescriptor | undefined;
      try {
        idDesc = Object.getOwnPropertyDescriptor(item, 'id');
      } catch {
        settleResolve('unverified');
        return;
      }

      // Must be own DATA descriptor for id
      if (!idDesc || idDesc.get !== undefined || idDesc.set !== undefined || !('value' in idDesc)) {
        settleResolve('unverified');
        return;
      }
      if (settled) return;
      if (idDesc.value !== capturedId || Object.is(idDesc.value, -0)) {
        settleResolve('unverified');
        return;
      }

      // Must be own DATA descriptor for state
      try { stateDesc = Object.getOwnPropertyDescriptor(item, 'state'); }
      catch { settleResolve('unverified'); return; }
      if (settled) return;
      if (!stateDesc || stateDesc.get !== undefined || stateDesc.set !== undefined || !('value' in stateDesc)) {
        settleResolve('unverified');
        return;
      }

      const stateVal = stateDesc.value;
      if (stateVal === 'complete') {
        settleResolve('completed');
        return;
      }
      if (stateVal === 'interrupted') {
        settleResolve('interrupted');
        return;
      }
      if (stateVal === 'in_progress') {
        // Still in progress: wait for onChanged or timeout/abort
        return;
      }
      // Unknown state (including 'completed' or invalid types)
      settleResolve('unverified');
    }

    function handleChangedDelta(delta: unknown): void {
      if (settled) return;

      if (typeof delta !== 'object' || delta === null) {
        return;
      }

      let idDesc: PropertyDescriptor | undefined;
      try {
        idDesc = Object.getOwnPropertyDescriptor(delta, 'id');
      } catch {
        settleResolve('unverified');
        return;
      }

      // Unowned id ignored without reading state
      if (!idDesc) {
        return;
      }

      // Malformed id descriptor: ignored without reading state
      if (idDesc.get !== undefined || idDesc.set !== undefined || !('value' in idDesc)) {
        return;
      }

      const deltaId = idDesc.value;
      if (settled) return;
      if (typeof deltaId !== 'number' || !Number.isSafeInteger(deltaId) || Object.is(deltaId, -0) || deltaId !== capturedId) {
        // Unrelated or malformed ID: ignored without reading state
        return;
      }

      // Owned matching ID: now capture state
      let stateDesc: PropertyDescriptor | undefined;
      try {
        stateDesc = Object.getOwnPropertyDescriptor(delta, 'state');
      } catch {
        settleResolve('unverified');
        return;
      }

      // Absent state is unrelated change and ignored
      if (settled) return;
      if (!stateDesc) {
        return;
      }

      // Present state must be own DATA descriptor
      if (stateDesc.get !== undefined || stateDesc.set !== undefined || !('value' in stateDesc)) {
        settleResolve('unverified');
        return;
      }

      const stateObj = stateDesc.value;
      if (typeof stateObj !== 'object' || stateObj === null) {
        settleResolve('unverified');
        return;
      }

      let currentDesc: PropertyDescriptor | undefined;
      try {
        currentDesc = Object.getOwnPropertyDescriptor(stateObj, 'current');
      } catch {
        settleResolve('unverified');
        return;
      }

      // Absent current is unrelated change and ignored
      if (settled) return;
      if (!currentDesc) {
        return;
      }

      // Present current must be own DATA descriptor
      if (currentDesc.get !== undefined || currentDesc.set !== undefined || !('value' in currentDesc)) {
        settleResolve('unverified');
        return;
      }

      const currentVal = currentDesc.value;
      if (typeof currentVal !== 'string') {
        settleResolve('unverified');
        return;
      }

      if (currentVal === 'complete') {
        settleResolve('completed');
        return;
      }
      if (currentVal === 'interrupted') {
        settleResolve('interrupted');
        return;
      }
      if (currentVal === 'in_progress') {
        return;
      }
      // Unknown state string (including 'completed')
      settleResolve('unverified');
    }

    // Step 1: Install timer
    timerId = setTimeout(() => {
      if (!settled) {
        settleResolve('unverified');
      }
    }, capturedTimeoutMs);

    // Step 2: Install abort listener
    abortListener = () => {
      if (!settled) {
        settleReject(new DomainError('OPERATION_ABORTED'));
      }
    };

    try {
      capturedAddListener('abort', abortListener);
    } catch {
      settleResolve('unverified');
      return;
    }
    if (settled) return;

    let isNowAborted = false;
    try {
      const rawAborted = capturedSignal.aborted;
      if (typeof rawAborted !== 'boolean') { settleResolve('unverified'); return; }
      isNowAborted = rawAborted;
    } catch {
      settleResolve('unverified');
      return;
    }

    if (isNowAborted) {
      settleReject(new DomainError('OPERATION_ABORTED'));
      return;
    }

    if (settled) {
      return;
    }

    // Step 3: Install changed listener BEFORE querying search
    changedListener = (delta: unknown) => {
      if (settled) return;
      handleChangedDelta(delta);
    };

    try {
      api.onChanged.addListener(changedListener);
    } catch {
      settleResolve('unverified');
      return;
    }

    // Check if synchronous callback on addListener settled observation
    if (settled) {
      return;
    }

    // Step 4: Query search({ id: capturedId })
    let searchPromise: Promise<unknown>;
    try {
      searchPromise = api.search({ id: capturedId });
    } catch {
      settleResolve('unverified');
      return;
    }

    let then: unknown;
    try { then = searchPromise?.then; }
    catch { settleResolve('unverified'); return; }
    if (typeof then !== 'function') {
      settleResolve('unverified');
      return;
    }

    const adopted = new Promise<unknown>((resolveQuery, rejectQuery) => {
      Reflect.apply(then, searchPromise, [resolveQuery, rejectQuery]);
    });
    void adopted.then(
      (searchResult) => {
        if (settled) return;
        try { handleSearchResult(searchResult); }
        catch { settleResolve('unverified'); }
      },
      () => {
        if (settled) return;
        settleResolve('unverified');
      }
    );
  });
}
