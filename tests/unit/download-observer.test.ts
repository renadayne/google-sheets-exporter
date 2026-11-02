import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DomainError } from '../../src/contracts/errors.ts';
import {
  observeDownloadCompletion,
  type DownloadsObservationApi,
  type DownloadObserverOptions
} from '../../src/runtime/download-observer.ts';

interface MockApiOptions {
  searchResult?: unknown;
  searchRejectError?: unknown;
  searchDelayMs?: number;
  syncDeltaOnAdd?: unknown;
  onRemoveListener?: () => void;
}

function createMockApi(options: MockApiOptions = {}) {
  const listeners: ((delta: unknown) => void)[] = [];
  const searchCalls: { id: number }[] = [];
  let removeListenerCalls = 0;

  let resolveSearchPromise: ((value: unknown) => void) | null = null;
  let rejectSearchPromise: ((reason: unknown) => void) | null = null;

  const searchFn = vi.fn((query: { id: number }): Promise<unknown> => {
    searchCalls.push(query);
    if (options.searchRejectError !== undefined) {
      return Promise.reject(options.searchRejectError);
    }
    if (options.searchResult !== undefined) {
      return Promise.resolve(options.searchResult);
    }
    return new Promise((resolve, reject) => {
      resolveSearchPromise = resolve;
      rejectSearchPromise = reject;
    });
  });

  const addListenerFn = vi.fn((listener: (delta: unknown) => void) => {
    listeners.push(listener);
    if (options.syncDeltaOnAdd !== undefined) {
      listener(options.syncDeltaOnAdd);
    }
  });

  const removeListenerFn = vi.fn((listener: (delta: unknown) => void) => {
    removeListenerCalls++;
    const idx = listeners.indexOf(listener);
    if (idx !== -1) {
      listeners.splice(idx, 1);
    }
    if (options.onRemoveListener) {
      options.onRemoveListener();
    }
  });

  const api: DownloadsObservationApi = {
    search: searchFn,
    onChanged: {
      addListener: addListenerFn,
      removeListener: removeListenerFn
    }
  };

  return {
    api,
    listeners,
    searchCalls,
    get removeListenerCalls() {
      return removeListenerCalls;
    },
    emitChanged(delta: unknown) {
      // Copy listeners slice to allow mutations during dispatch
      for (const listener of [...listeners]) {
        listener(delta);
      }
    },
    resolveSearch(val: unknown) {
      if (resolveSearchPromise) resolveSearchPromise(val);
    },
    rejectSearch(err: unknown) {
      if (rejectSearchPromise) rejectSearchPromise(err);
    }
  };
}

describe('T31b1 Download Completion Observer', () => {
  it('accepts safe zero download IDs without accepting negative zero', async () => {
    const mock = createMockApi({ searchResult: [{ id: 0, state: 'complete' }] });
    await expect(observeDownloadCompletion(mock.api, 0, { signal: new AbortController().signal, timeoutMs: 1000 }))
      .resolves.toBe('completed');
    expect(mock.searchCalls).toEqual([{ id: 0 }]);
    expect(mock.listeners).toHaveLength(0);
  });

  it('rejects array slot accessors without invocation and contains a revoked result proxy', async () => {
    let getterReads = 0;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { get() { getterReads++; return { id: 42, state: 'complete' }; } });
    const mock = createMockApi({ searchResult: accessor });
    await expect(observeDownloadCompletion(mock.api, 42, { signal: new AbortController().signal, timeoutMs: 1000 }))
      .resolves.toBe('unverified');
    expect(getterReads).toBe(0);
    const { proxy, revoke } = Proxy.revocable([{ id: 42, state: 'complete' }], {});
    const revokedMock = createMockApi({ searchResult: proxy });
    const pending = observeDownloadCompletion(revokedMock.api, 42, { signal: new AbortController().signal, timeoutMs: 1000 });
    revoke();
    await expect(pending).resolves.toBe('unverified');
    expect(revokedMock.listeners).toHaveLength(0);
  });

  it('captures a throwing search then getter once and releases listeners without raw rejection', async () => {
    const mock = createMockApi();
    let reads = 0;
    mock.api.search = () => ({ get then() { reads++; throw new Error('private query diagnostic'); } } as unknown as Promise<unknown>);
    await expect(observeDownloadCompletion(mock.api, 42, { signal: new AbortController().signal, timeoutMs: 1000 }))
      .resolves.toBe('unverified');
    expect(reads).toBe(1);
    expect(mock.listeners).toHaveLength(0);
  });

  it('does not read state after an ID trap aborts observation or reveals an unowned ID', async () => {
    for (const shouldAbort of [true, false]) {
      const controller = new AbortController();
      let stateReads = 0;
      const item = new Proxy({ id: shouldAbort ? 42 : 99, state: 'complete' }, {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'id' && shouldAbort) controller.abort();
          if (key === 'state') stateReads++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        }
      });
      const mock = createMockApi({ searchResult: [item] });
      const pending = observeDownloadCompletion(mock.api, 42, { signal: controller.signal, timeoutMs: 1000 });
      if (shouldAbort) await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'OPERATION_ABORTED' }));
      else await expect(pending).resolves.toBe('unverified');
      expect(stateReads).toBe(0);
      expect(mock.listeners).toHaveLength(0);
    }
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('Group 1: already-complete search', () => {
    it('resolves completed when search returns matching complete item', async () => {
      const mock = createMockApi({
        searchResult: [{ id: 42, state: 'complete' }]
      });
      const controller = new AbortController();

      const result = await observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      expect(result).toBe('completed');
      expect(mock.searchCalls).toEqual([{ id: 42 }]);
      expect(mock.removeListenerCalls).toBe(1);
      expect(mock.listeners.length).toBe(0);
    });

    it('resolves interrupted when search returns matching interrupted item', async () => {
      const mock = createMockApi({
        searchResult: [{ id: 101, state: 'interrupted' }]
      });
      const controller = new AbortController();

      const result = await observeDownloadCompletion(mock.api, 101, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      expect(result).toBe('interrupted');
      expect(mock.searchCalls).toEqual([{ id: 101 }]);
      expect(mock.removeListenerCalls).toBe(1);
    });

    it('waits when search returns matching in_progress item', async () => {
      const mock = createMockApi({
        searchResult: [{ id: 42, state: 'in_progress' }]
      });
      const controller = new AbortController();

      let settled = false;
      const promise = observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      }).then((r) => {
        settled = true;
        return r;
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      expect(mock.listeners.length).toBe(1);

      // Now emit complete event
      mock.emitChanged({ id: 42, state: { current: 'complete' } });
      const result = await promise;
      expect(result).toBe('completed');
      expect(mock.removeListenerCalls).toBe(1);
    });
  });

  describe('Group 2: in-progress then actual complete/interrupted event', () => {
    it('resolves completed when in_progress search is followed by complete onChanged delta', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise = observeDownloadCompletion(mock.api, 7, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      mock.resolveSearch([{ id: 7, state: 'in_progress' }]);
      await vi.advanceTimersByTimeAsync(10);

      mock.emitChanged({ id: 7, state: { current: 'complete' } });
      const result = await promise;
      expect(result).toBe('completed');
      expect(mock.removeListenerCalls).toBe(1);
    });

    it('resolves interrupted when in_progress search is followed by interrupted onChanged delta', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise = observeDownloadCompletion(mock.api, 7, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      mock.resolveSearch([{ id: 7, state: 'in_progress' }]);
      await vi.advanceTimersByTimeAsync(10);

      mock.emitChanged({ id: 7, state: { current: 'interrupted' } });
      const result = await promise;
      expect(result).toBe('interrupted');
      expect(mock.removeListenerCalls).toBe(1);
    });

    it('ignores unrelated progress delta without state, and resolves when terminal complete arrives', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise = observeDownloadCompletion(mock.api, 7, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      mock.resolveSearch([{ id: 7, state: 'in_progress' }]);
      await vi.advanceTimersByTimeAsync(10);

      // Progress event with bytesReceived but no state
      mock.emitChanged({ id: 7, bytesReceived: { current: 1024 } });
      // Event with absent current
      mock.emitChanged({ id: 7, state: { previous: 'in_progress' } });
      // Event with in_progress state
      mock.emitChanged({ id: 7, state: { current: 'in_progress' } });

      await vi.advanceTimersByTimeAsync(10);
      expect(mock.listeners.length).toBe(1);

      // Finally complete
      mock.emitChanged({ id: 7, state: { current: 'complete' } });
      const result = await promise;
      expect(result).toBe('completed');
    });
  });

  describe('Group 3: unrelated ID fields never touched', () => {
    it('ignores delta for unrelated ID and NEVER accesses adversarial getters on state', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise = observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      mock.resolveSearch([{ id: 42, state: 'in_progress' }]);
      await vi.advanceTimersByTimeAsync(10);

      let trapTriggered = false;
      const unrelatedDelta = { id: 999 };
      Object.defineProperty(unrelatedDelta, 'state', {
        get() {
          trapTriggered = true;
          throw new Error('evil getter on unrelated delta.state');
        },
        enumerable: true,
        configurable: true
      });

      mock.emitChanged(unrelatedDelta);
      expect(trapTriggered).toBe(false);

      // Delta without ID
      const noIdDelta = {};
      Object.defineProperty(noIdDelta, 'state', {
        get() {
          trapTriggered = true;
          throw new Error('evil getter on unowned delta.state');
        },
        enumerable: true,
        configurable: true
      });
      mock.emitChanged(noIdDelta);
      expect(trapTriggered).toBe(false);

      // Delta with malformed non-number ID
      const malformedIdDelta = { id: '42' };
      Object.defineProperty(malformedIdDelta, 'state', {
        get() {
          trapTriggered = true;
          throw new Error('evil getter on malformed ID delta.state');
        },
        enumerable: true,
        configurable: true
      });
      mock.emitChanged(malformedIdDelta);
      expect(trapTriggered).toBe(false);

      // Delta with getter on ID
      const getterIdDelta = {};
      Object.defineProperty(getterIdDelta, 'id', {
        get() {
          trapTriggered = true;
          throw new Error('evil getter on delta.id');
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(getterIdDelta, 'state', {
        get() {
          trapTriggered = true;
          throw new Error('evil getter on state');
        },
        enumerable: true,
        configurable: true
      });
      mock.emitChanged(getterIdDelta);
      expect(trapTriggered).toBe(false);

      // Now emit valid completion for 42
      mock.emitChanged({ id: 42, state: { current: 'complete' } });
      const result = await promise;
      expect(result).toBe('completed');
      expect(trapTriggered).toBe(false);
    });
  });

  describe('Group 4: event terminal before deferred search resolution cannot downgrade/upgrade', () => {
    it('completed event wins before search resolves; later search resolution cannot change outcome or touch fields', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise = observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      // onChanged fires complete BEFORE search resolves
      mock.emitChanged({ id: 42, state: { current: 'complete' } });
      const result = await promise;
      expect(result).toBe('completed');
      expect(mock.removeListenerCalls).toBe(1);

      // Late search resolution with interrupted state and adversarial getters
      let searchStateRead = false;
      const lateItem = { id: 42 };
      Object.defineProperty(lateItem, 'state', {
        get() {
          searchStateRead = true;
          return 'interrupted';
        },
        enumerable: true,
        configurable: true
      });

      mock.resolveSearch([lateItem]);
      await vi.advanceTimersByTimeAsync(10);

      expect(searchStateRead).toBe(false);
      expect(result).toBe('completed');
    });

    it('interrupted event wins before search resolves; later search cannot upgrade to completed', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise = observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      mock.emitChanged({ id: 42, state: { current: 'interrupted' } });
      const result = await promise;
      expect(result).toBe('interrupted');

      // Late search resolves with complete
      mock.resolveSearch([{ id: 42, state: 'complete' }]);
      await vi.advanceTimersByTimeAsync(10);

      expect(result).toBe('interrupted');
    });
  });

  describe('Group 5: missing/invalid/search failure unverified (including wrong "completed" state)', () => {
    it('resolves unverified on empty search array', async () => {
      const mock = createMockApi({ searchResult: [] });
      const controller = new AbortController();

      const result = await observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });
      expect(result).toBe('unverified');
      expect(mock.removeListenerCalls).toBe(1);
    });

    it('resolves unverified on ambiguous multiple search items', async () => {
      const mock = createMockApi({
        searchResult: [
          { id: 42, state: 'complete' },
          { id: 42, state: 'complete' }
        ]
      });
      const controller = new AbortController();

      const result = await observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });
      expect(result).toBe('unverified');
    });

    it('resolves unverified on sparse array', async () => {
      const sparse = new Array(1);
      const mock = createMockApi({ searchResult: sparse });
      const controller = new AbortController();

      const result = await observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });
      expect(result).toBe('unverified');
    });

    it('resolves unverified on search result item with mismatched id', async () => {
      const mock = createMockApi({
        searchResult: [{ id: 99, state: 'complete' }]
      });
      const controller = new AbortController();

      const result = await observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });
      expect(result).toBe('unverified');
    });

    it('resolves unverified when browser state is incorrectly "completed" instead of "complete"', async () => {
      const mock = createMockApi({
        searchResult: [{ id: 42, state: 'completed' }]
      });
      const controller = new AbortController();

      const result = await observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });
      expect(result).toBe('unverified');
    });

    it('resolves unverified on search item with unknown state', async () => {
      const mock = createMockApi({
        searchResult: [{ id: 42, state: 'paused' }]
      });
      const controller = new AbortController();

      const result = await observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });
      expect(result).toBe('unverified');
    });

    it('resolves unverified on search promise rejection', async () => {
      const mock = createMockApi({
        searchRejectError: new Error('Chrome extension context invalidated')
      });
      const controller = new AbortController();

      const result = await observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });
      expect(result).toBe('unverified');
      expect(mock.removeListenerCalls).toBe(1);
    });

    it('resolves unverified when search throws synchronously', async () => {
      const api: DownloadsObservationApi = {
        search: () => {
          throw new Error('sync search throw');
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn()
        }
      };
      const controller = new AbortController();

      const result = await observeDownloadCompletion(api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });
      expect(result).toBe('unverified');
    });

    it('resolves unverified when search returns non-thenable', async () => {
      const api: DownloadsObservationApi = {
        search: () => null as any,
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn()
        }
      };
      const controller = new AbortController();

      const result = await observeDownloadCompletion(api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });
      expect(result).toBe('unverified');
    });

    it('resolves unverified when onChanged delta has incorrect state "completed"', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise = observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      mock.emitChanged({ id: 42, state: { current: 'completed' } });
      const result = await promise;
      expect(result).toBe('unverified');
    });

    it('resolves unverified when onChanged delta has unknown state "paused"', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise = observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      mock.emitChanged({ id: 42, state: { current: 'paused' } });
      const result = await promise;
      expect(result).toBe('unverified');
    });

    it('resolves unverified when onChanged delta has non-string current', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise = observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      mock.emitChanged({ id: 42, state: { current: 123 } });
      const result = await promise;
      expect(result).toBe('unverified');
    });

    it('resolves unverified when onChanged addListener throws synchronously', async () => {
      const api: DownloadsObservationApi = {
        search: vi.fn(),
        onChanged: {
          addListener: () => {
            throw new Error('addListener failed');
          },
          removeListener: vi.fn()
        }
      };
      const controller = new AbortController();

      const result = await observeDownloadCompletion(api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });
      expect(result).toBe('unverified');
    });
  });

  describe('Group 6: timeout fake timers + pre/during abort cleanup', () => {
    it('resolves unverified on timeout expiry (not inferred failure or NETWORK_TIMEOUT)', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise = observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 3000
      });

      mock.resolveSearch([{ id: 42, state: 'in_progress' }]);
      await vi.advanceTimersByTimeAsync(2999);
      expect(mock.listeners.length).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;
      expect(result).toBe('unverified');
      expect(mock.removeListenerCalls).toBe(1);
      expect(mock.listeners.length).toBe(0);
    });

    it('pre-aborted signal rejects with static DomainError OPERATION_ABORTED and zero subscription/search', async () => {
      const mock = createMockApi();
      const controller = new AbortController();
      controller.abort();

      await expect(
        observeDownloadCompletion(mock.api, 42, {
          signal: controller.signal,
          timeoutMs: 5000
        })
      ).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('OPERATION_ABORTED');
        return true;
      });

      expect(mock.searchCalls.length).toBe(0);
      expect(mock.listeners.length).toBe(0);
      expect(mock.removeListenerCalls).toBe(0);
    });

    it('signal abort during observation rejects with DomainError OPERATION_ABORTED and cleans up completely', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise = observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      mock.resolveSearch([{ id: 42, state: 'in_progress' }]);
      await vi.advanceTimersByTimeAsync(100);
      expect(mock.listeners.length).toBe(1);

      controller.abort();

      await expect(promise).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('OPERATION_ABORTED');
        return true;
      });

      expect(mock.removeListenerCalls).toBe(1);
      expect(mock.listeners.length).toBe(0);
    });
  });

  describe('Group 7: descriptor/getter/option capture, static errors, synchronous subscription callback & cleanup reentry', () => {
    it('captures options properties exactly once', async () => {
      const mock = createMockApi({
        searchResult: [{ id: 42, state: 'complete' }]
      });
      const controller = new AbortController();

      let timeoutReads = 0;
      let signalReads = 0;
      const options: DownloadObserverOptions = {
        get timeoutMs() {
          timeoutReads++;
          return 5000;
        },
        get signal() {
          signalReads++;
          return controller.signal;
        }
      };

      const result = await observeDownloadCompletion(mock.api, 42, options);
      expect(result).toBe('completed');
      expect(timeoutReads).toBe(1);
      expect(signalReads).toBe(1);
    });

    it('throwing getter on options rejects with static DomainError CONFIG_INVALID without synchronous leak', async () => {
      const mock = createMockApi();
      const options = {
        get timeoutMs(): number {
          throw new Error('evil options getter');
        },
        signal: new AbortController().signal
      };

      let threwSync = false;
      let caughtPromiseErr: unknown = null;
      try {
        const p = observeDownloadCompletion(mock.api, 42, options as any);
        await p.catch((e) => {
          caughtPromiseErr = e;
        });
      } catch {
        threwSync = true;
      }

      expect(threwSync).toBe(false);
      expect(caughtPromiseErr).toBeInstanceOf(DomainError);
      expect((caughtPromiseErr as DomainError).code).toBe('CONFIG_INVALID');
    });

    it('rejects invalid downloadId values with CONFIG_INVALID', async () => {
      const mock = createMockApi();
      const signal = new AbortController().signal;

      const invalidIds = [-0, -1, -42, 1.5, NaN, Infinity, -Infinity, '42', null, undefined];
      for (const id of invalidIds) {
        await expect(
          observeDownloadCompletion(mock.api, id as any, { signal, timeoutMs: 5000 })
        ).rejects.toSatisfy((err) => {
          expect(err).toBeInstanceOf(DomainError);
          expect((err as DomainError).code).toBe('CONFIG_INVALID');
          return true;
        });
      }
    });

    it('rejects invalid timeoutMs values with CONFIG_INVALID, and accepts exact boundaries 1 and 600000', async () => {
      const mock = createMockApi({
        searchResult: [{ id: 42, state: 'complete' }]
      });
      const signal = new AbortController().signal;

      const invalidTimeouts = [0, -1, 600001, 1.5, NaN, Infinity, '5000', null, undefined];
      for (const timeoutMs of invalidTimeouts) {
        await expect(
          observeDownloadCompletion(mock.api, 42, { signal, timeoutMs: timeoutMs as any })
        ).rejects.toSatisfy((err) => {
          expect(err).toBeInstanceOf(DomainError);
          expect((err as DomainError).code).toBe('CONFIG_INVALID');
          return true;
        });
      }

      // Valid boundary: 1
      const res1 = await observeDownloadCompletion(mock.api, 42, { signal, timeoutMs: 1 });
      expect(res1).toBe('completed');

      // Valid boundary: 600000
      const res600k = await observeDownloadCompletion(mock.api, 42, { signal, timeoutMs: 600000 });
      expect(res600k).toBe('completed');
    });

    it('rejects invalid signal with CONFIG_INVALID', async () => {
      const mock = createMockApi();

      const invalidSignals = [
        null,
        undefined,
        {},
        { aborted: 'not-bool' },
        { aborted: false, addEventListener: 'not-fn' },
        { aborted: false, addEventListener: () => {}, removeEventListener: null }
      ];

      for (const sig of invalidSignals) {
        await expect(
          observeDownloadCompletion(mock.api, 42, { signal: sig as any, timeoutMs: 5000 })
        ).rejects.toSatisfy((err) => {
          expect(err).toBeInstanceOf(DomainError);
          expect((err as DomainError).code).toBe('CONFIG_INVALID');
          return true;
        });
      }
    });

    it('rejects invalid api with CONFIG_INVALID', async () => {
      const signal = new AbortController().signal;

      const invalidApis = [
        null,
        undefined,
        {},
        { search: 'not-fn' },
        { search: () => {}, onChanged: null },
        { search: () => {}, onChanged: { addListener: () => {} } } // missing removeListener
      ];

      for (const api of invalidApis) {
        await expect(
          observeDownloadCompletion(api as any, 42, { signal, timeoutMs: 5000 })
        ).rejects.toSatisfy((err) => {
          expect(err).toBeInstanceOf(DomainError);
          expect((err as DomainError).code).toBe('CONFIG_INVALID');
          return true;
        });
      }
    });

    it('search item with accessor descriptor for id or state resolves unverified and never invokes getters', async () => {
      let idGetterCalled = false;
      const itemWithIdGetter = { state: 'complete' };
      Object.defineProperty(itemWithIdGetter, 'id', {
        get() {
          idGetterCalled = true;
          return 42;
        },
        enumerable: true,
        configurable: true
      });

      const mockId = createMockApi({ searchResult: [itemWithIdGetter] });
      const resId = await observeDownloadCompletion(mockId.api, 42, {
        signal: new AbortController().signal,
        timeoutMs: 5000
      });
      expect(resId).toBe('unverified');
      expect(idGetterCalled).toBe(false);

      let stateGetterCalled = false;
      const itemWithStateGetter = { id: 42 };
      Object.defineProperty(itemWithStateGetter, 'state', {
        get() {
          stateGetterCalled = true;
          return 'complete';
        },
        enumerable: true,
        configurable: true
      });

      const mockState = createMockApi({ searchResult: [itemWithStateGetter] });
      const resState = await observeDownloadCompletion(mockState.api, 42, {
        signal: new AbortController().signal,
        timeoutMs: 5000
      });
      expect(resState).toBe('unverified');
      expect(stateGetterCalled).toBe(false);
    });

    it('never reads unrelated private browser metadata on search item (filename, url, error, etc.)', async () => {
      let trappedProp = '';
      const safeItem = { id: 42, state: 'complete' };
      for (const prop of ['filename', 'url', 'finalUrl', 'error', 'danger', 'mime', 'body']) {
        Object.defineProperty(safeItem, prop, {
          get() {
            trappedProp = prop;
            throw new Error(`Touched unrelated property: ${prop}`);
          },
          enumerable: true,
          configurable: true
        });
      }

      const mock = createMockApi({ searchResult: [safeItem] });
      const result = await observeDownloadCompletion(mock.api, 42, {
        signal: new AbortController().signal,
        timeoutMs: 5000
      });

      expect(result).toBe('completed');
      expect(trappedProp).toBe('');
    });

    it('onChanged delta with accessor descriptor for state or current resolves unverified and never invokes getters', async () => {
      const mock = createMockApi();
      const controller = new AbortController();

      const promise1 = observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      let stateTrap = false;
      const deltaWithStateGetter = { id: 42 };
      Object.defineProperty(deltaWithStateGetter, 'state', {
        get() {
          stateTrap = true;
          return { current: 'complete' };
        },
        enumerable: true,
        configurable: true
      });

      mock.emitChanged(deltaWithStateGetter);
      const res1 = await promise1;
      expect(res1).toBe('unverified');
      expect(stateTrap).toBe(false);

      // Current accessor
      const mock2 = createMockApi();
      const promise2 = observeDownloadCompletion(mock2.api, 42, {
        signal: new AbortController().signal,
        timeoutMs: 5000
      });

      let currentTrap = false;
      const deltaWithCurrentGetter = { id: 42, state: {} };
      Object.defineProperty(deltaWithCurrentGetter.state, 'current', {
        get() {
          currentTrap = true;
          return 'complete';
        },
        enumerable: true,
        configurable: true
      });

      mock2.emitChanged(deltaWithCurrentGetter);
      const res2 = await promise2;
      expect(res2).toBe('unverified');
      expect(currentTrap).toBe(false);
    });

    it('synchronous callback during onChanged.addListener completes immediately and never queries search', async () => {
      const mock = createMockApi({
        syncDeltaOnAdd: { id: 42, state: { current: 'complete' } }
      });
      const controller = new AbortController();

      const result = await observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      expect(result).toBe('completed');
      expect(mock.searchCalls.length).toBe(0);
      expect(mock.removeListenerCalls).toBe(1);
    });

    it('cleanup reentry is idempotent: removeListener triggering reentrant delta or abort has no effect', async () => {
      let reentrantCallCount = 0;
      let mockRef: ReturnType<typeof createMockApi>;

      const mock = createMockApi({
        onRemoveListener: () => {
          reentrantCallCount++;
          // Trigger reentrant onChanged and abort
          if (mockRef) {
            mockRef.emitChanged({ id: 42, state: { current: 'interrupted' } });
          }
        }
      });
      mockRef = mock;

      const controller = new AbortController();
      const promise = observeDownloadCompletion(mock.api, 42, {
        signal: controller.signal,
        timeoutMs: 5000
      });

      mock.emitChanged({ id: 42, state: { current: 'complete' } });
      const result = await promise;

      expect(result).toBe('completed');
      expect(reentrantCallCount).toBe(1);
      expect(mock.removeListenerCalls).toBe(1);
    });
  });
});
