import { describe, it, expect } from 'vitest';
import {
  createManualClock,
  createDeterministicRandom,
  createDeferred,
  awaitWithSignal,
  AsyncResultQueue
} from '../helpers/deterministic.ts';
import { createFakeFetch } from '../helpers/fake-fetch.ts';
import { CANONICAL_SPREADSHEET_ID } from '../helpers/fixtures.ts';

describe('T10b Deterministic Helpers', () => {
  describe('ManualClock', () => {
    it('advances and sets time deterministically and rejects non-safe or negative numbers', () => {
      const clock = createManualClock(1000);
      expect(clock.now()).toBe(1000);
      expect(clock.advance(500)).toBe(1500);
      expect(clock.now()).toBe(1500);
      expect(clock.set(3000)).toBe(3000);
      expect(clock.now()).toBe(3000);

      expect(() => clock.advance(-1)).toThrow(RangeError);
      expect(() => clock.advance(1.5)).toThrow(RangeError);
      expect(() => clock.advance(NaN)).toThrow(RangeError);
      expect(() => clock.advance(Infinity)).toThrow(RangeError);
      expect(() => clock.set(-10)).toThrow(RangeError);
      expect(() => clock.set(2.5)).toThrow(RangeError);
      expect(() => createManualClock(-1)).toThrow(RangeError);
      expect(() => createManualClock(0.5)).toThrow(RangeError);
    });

    it('fails on advance overflow without poisoning clock', () => {
      const clock = createManualClock(Number.MAX_SAFE_INTEGER);
      expect(clock.now()).toBe(Number.MAX_SAFE_INTEGER);
      expect(() => clock.advance(1)).toThrow(RangeError);
      expect(clock.now()).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('DeterministicRandom', () => {
    it('replays sequence, rejects invalid numbers, and fails on exhaustion', () => {
      expect(() => createDeterministicRandom([0.1, 1.0])).toThrow(RangeError);
      expect(() => createDeterministicRandom([-0.1])).toThrow(RangeError);

      const rng = createDeterministicRandom([0.125, 0.5, 0.875]);
      expect(rng.remaining()).toBe(3);
      expect(rng.next()).toBe(0.125);
      expect(rng.next()).toBe(0.5);
      expect(rng.next()).toBe(0.875);
      expect(rng.remaining()).toBe(0);
      expect(() => rng.next()).toThrow(/exhausted/);
    });
  });

  describe('Deferred & awaitWithSignal', () => {
    it('resolves, rejects, and tracks settlement state', async () => {
      const defRes = createDeferred<string>();
      expect(defRes.isSettled()).toBe(false);
      defRes.resolve('done');
      expect(defRes.isSettled()).toBe(true);
      await expect(defRes.promise).resolves.toBe('done');

      const defRej = createDeferred<number>();
      defRej.reject(new Error('fail'));
      expect(defRej.isSettled()).toBe(true);
      await expect(defRej.promise).rejects.toThrow('fail');
    });

    it('handles pre-aborted signal immediately', async () => {
      const controller = new AbortController();
      controller.abort(new DOMException('Pre-cancelled', 'AbortError'));
      const def = createDeferred<string>();

      await expect(awaitWithSignal(def.promise, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Pre-cancelled'
      });
      // Late settlement consumed safely
      def.reject(new Error('late failure'));
    });

    it('aborts in-flight and consumes late settlement without unhandled rejection', async () => {
      const controller = new AbortController();
      const def = createDeferred<string>();
      const promise = awaitWithSignal(def.promise, controller.signal);

      controller.abort();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

      // Late resolve and late reject after cancellation do not crash process
      def.resolve('late value');
      const def2 = createDeferred<string>();
      const ctrl2 = new AbortController();
      const p2 = awaitWithSignal(def2.promise, ctrl2.signal);
      ctrl2.abort();
      await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
      def2.reject(new Error('late error'));
    });
  });

  describe('AsyncResultQueue', () => {
    it('does not execute a custom step after cancellation before its microtask', async () => {
      const queue = new AsyncResultQueue<string>();
      let executed = false;
      queue.enqueue(async () => { executed = true; return 'unexpected'; });
      const controller = new AbortController();
      const pending = queue.next(controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(executed).toBe(false);
    });
    it('processes values, errors, and deferred steps in FIFO order then throws on exhaustion', async () => {
      const queue = new AsyncResultQueue<string>();
      const deferred = createDeferred<string>();
      queue.enqueueValue('first');
      queue.enqueueError(new Error('second fail'));
      queue.enqueueDeferred(deferred);

      expect(queue.remaining).toBe(3);
      expect(await queue.next()).toBe('first');
      await expect(queue.next()).rejects.toThrow('second fail');

      const pendingNext = queue.next();
      deferred.resolve('third resolved');
      expect(await pendingNext).toBe('third resolved');
      expect(queue.consumed).toBe(3);
      expect(queue.remaining).toBe(0);

      await expect(queue.next()).rejects.toThrow(/exhausted/);
    });

    it('gates pre-aborted signal before executing or consuming outcome', async () => {
      const queue = new AsyncResultQueue<string>();
      queue.enqueueValue('preserved');

      const controller = new AbortController();
      controller.abort(new DOMException('Pre-aborted', 'AbortError'));

      await expect(queue.next(controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Pre-aborted'
      });
      expect(queue.remaining).toBe(1);
      expect(queue.consumed).toBe(0);
      expect(await queue.next()).toBe('preserved');
      expect(queue.consumed).toBe(1);
    });

    it('aborts custom step that ignores signal argument', async () => {
      const queue = new AsyncResultQueue<string>();
      const deferred = createDeferred<string>();
      // Custom step ignores signal parameter entirely
      queue.enqueue(() => deferred.promise);

      const controller = new AbortController();
      const nextPromise = queue.next(controller.signal);

      controller.abort();
      await expect(nextPromise).rejects.toMatchObject({ name: 'AbortError' });
      deferred.resolve('late outcome');
    });
  });

  describe('FakeFetch', () => {
    const testUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CANONICAL_SPREADSHEET_ID}`;

    it('handles string, URL, and Request inputs with method overrides', async () => {
      const fake = createFakeFetch();
      fake.enqueueResponse({ status: 200, body: '{"ok":true}' }, { expectedMethod: 'GET' });
      fake.enqueueResponse({ status: 200, body: '{"updated":true}' }, { expectedMethod: 'POST' });

      const res1 = await fake(new URL(testUrl));
      expect(await res1.json()).toEqual({ ok: true });

      const req = new Request(testUrl, { method: 'GET' });
      const res2 = await fake(req, { method: 'POST', body: 'payload' });
      expect(await res2.json()).toEqual({ updated: true });

      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[0]?.method).toBe('GET');
      expect(fake.calls[1]?.method).toBe('POST');
      expect(fake.calls[1]?.body).toBe('payload');
    });

    it('preserves HTTP 403, 429, and 503 responses with headers/body text without auto-throwing', async () => {
      const fake = createFakeFetch();
      const forbiddenPayload = JSON.stringify({
        error: { code: 403, message: 'The caller does not have permission' }
      });
      const rateLimitPayload = JSON.stringify({
        error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' }
      });
      const serviceUnavailablePayload = JSON.stringify({
        error: { code: 503, message: 'Service Unavailable', status: 'UNAVAILABLE' }
      });

      fake.enqueueResponse({
        status: 403,
        statusText: 'Forbidden',
        headers: { 'Content-Type': 'application/json' },
        body: forbiddenPayload
      });
      fake.enqueueResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '60', 'Content-Type': 'application/json' },
        body: rateLimitPayload
      });
      fake.enqueueResponse({
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Retry-After': '120', 'Content-Type': 'application/json' },
        body: serviceUnavailablePayload
      });

      const res403 = await fake(testUrl);
      expect(res403.status).toBe(403);
      expect(res403.statusText).toBe('Forbidden');
      expect(await res403.text()).toBe(forbiddenPayload);

      const res429 = await fake(testUrl);
      expect(res429.status).toBe(429);
      expect(res429.headers.get('Retry-After')).toBe('60');
      expect(await res429.text()).toBe(rateLimitPayload);

      const res503 = await fake(testUrl);
      expect(res503.status).toBe(503);
      expect(res503.headers.get('Retry-After')).toBe('120');
      expect(await res503.text()).toBe(serviceUnavailablePayload);
    });

    it('handles signal inheritance, live overrides, explicit null, and pre-abort gating', async () => {
      const fake = createFakeFetch();

      // 1. Inherited abort from Request.signal
      const abortedController = new AbortController();
      abortedController.abort(new DOMException('Inherited abort', 'AbortError'));
      const reqAborted = new Request(testUrl, { signal: abortedController.signal });
      await expect(fake(reqAborted)).rejects.toMatchObject({ name: 'AbortError', message: 'Inherited abort' });

      // 2. Override live signal over aborted request
      const liveController = new AbortController();
      fake.enqueueResponse({ body: 'live ok' });
      const resLive = await fake(reqAborted, { signal: liveController.signal });
      expect(await resLive.text()).toBe('live ok');

      // 3. Explicit null signal disables Request.signal inheritance
      fake.enqueueResponse({ body: 'null ok' });
      const resNull = await fake(reqAborted, { signal: null });
      expect(await resNull.text()).toBe('null ok');

      // 4. Pre-aborted custom handler is NOT executed and step remains queued
      let customRan = false;
      fake.enqueueStep({
        handle: () => {
          customRan = true;
          return new Response('custom ok');
        }
      });
      const preAbortedCtrl = new AbortController();
      preAbortedCtrl.abort(new DOMException('Pre-aborted custom', 'AbortError'));
      await expect(fake(testUrl, { signal: preAbortedCtrl.signal })).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Pre-aborted custom'
      });
      expect(customRan).toBe(false);
      expect(fake.remaining()).toBe(1);
    });

    it('cancels stalled streaming request body on in-flight abort without swallowing error', async () => {
      const fake = createFakeFetch();
      fake.enqueueResponse({ body: 'stream done' });

      const controller = new AbortController();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          streamController = c;
        }
      });

      const reqWithStream = new Request(testUrl, {
        method: 'POST',
        body: stream,
        ...( { duplex: 'half' } as Record<string, unknown> )
      });

      const fetchPromise = fake(reqWithStream, { signal: controller.signal });
      controller.abort(new DOMException('Stream body aborted', 'AbortError'));

      await expect(fetchPromise).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Stream body aborted'
      });

      try {
        streamController.close();
      } catch {
        // stream cleanup
      }
    });

    it('sanitizes synthetic secrets and URLs from error messages', async () => {
      const secretToken = 'sec_super_secret_token_12345';
      const secretUrl = `https://sheets.googleapis.com/v4/spreadsheets/abc?token=${secretToken}`;

      // Unexpected call
      const fake1 = createFakeFetch();
      let unexpectedErr!: Error;
      try {
        await fake1(secretUrl);
      } catch (err) {
        unexpectedErr = err as Error;
      }
      expect(unexpectedErr).toBeDefined();
      expect(unexpectedErr.message).not.toContain(secretToken);
      expect(unexpectedErr.message).not.toContain('spreadsheets');

      // URL mismatch
      const fake2 = createFakeFetch();
      fake2.enqueueResponse({}, { expectedUrl: secretUrl });
      let mismatchErr!: Error;
      try {
        await fake2('https://other.example.com');
      } catch (err) {
        mismatchErr = err as Error;
      }
      expect(mismatchErr).toBeDefined();
      expect(mismatchErr.message).not.toContain(secretToken);
      expect(mismatchErr.message).not.toContain('spreadsheets');
      expect(mismatchErr.message).not.toContain('other.example.com');
    });

    it('matches expectedUrl deterministically with global/sticky regexes without mutating lastIndex', async () => {
      const fake = createFakeFetch();
      const globalRegex = /spreadsheets/g;
      globalRegex.lastIndex = 7;
      fake.enqueueResponse({ body: 'first' }, { expectedUrl: globalRegex });
      fake.enqueueResponse({ body: 'second' }, { expectedUrl: globalRegex });

      expect(await (await fake(testUrl)).text()).toBe('first');
      expect(globalRegex.lastIndex).toBe(7);
      expect(await (await fake(testUrl)).text()).toBe('second');
      expect(globalRegex.lastIndex).toBe(7);

      const stickyRegex = /https:\/\/sheets\.googleapis\.com/y;
      stickyRegex.lastIndex = 4;
      fake.enqueueResponse({ body: 'third' }, { expectedUrl: stickyRegex });
      expect(await (await fake(testUrl)).text()).toBe('third');
      expect(stickyRegex.lastIndex).toBe(4);
      fake.enqueueResponse({}, { expectedUrl: /spreadsheets/y });
      await expect(fake(testUrl)).rejects.toThrow(/URL mismatch/);
    });

    it('requires exactly one configured outcome per FakeFetchStep', () => {
      const fake = createFakeFetch();

      // Empty step rejected
      expect(() => fake.enqueueStep({})).toThrow(/must configure exactly one outcome, got none/);

      // Conflicting outcomes rejected
      expect(() =>
        fake.enqueueStep({
          response: {},
          error: new Error('boom')
        })
      ).toThrow(/conflicting outcomes/);

      expect(() =>
        fake.enqueueStep({
          response: {},
          deferred: createDeferred<Response>()
        })
      ).toThrow(/conflicting outcomes/);

      expect(() =>
        fake.enqueueStep({
          error: new Error('boom'),
          handle: () => new Response()
        })
      ).toThrow(/conflicting outcomes/);

      // Initial steps validate as well
      expect(() => createFakeFetch([{}])).toThrow(/must configure exactly one outcome, got none/);

      // enqueueResponse() explicitly queues default 200 {}
      fake.enqueueResponse();
      expect(fake.remaining()).toBe(1);
    });

    it('provides fresh unconsumed response bodies across successive calls', async () => {
      const fake = createFakeFetch();
      fake.enqueueResponse({ body: 'chunk-1' });
      fake.enqueueResponse({ body: 'chunk-2' });

      const r1 = await fake(testUrl);
      const r2 = await fake(testUrl);
      expect(await r1.text()).toBe('chunk-1');
      expect(await r2.text()).toBe('chunk-2');
    });

    it('supports in-flight abort on deferred response', async () => {
      const fake = createFakeFetch();
      const deferred = createDeferred<Response>();
      fake.enqueueDeferred(deferred);

      const controller = new AbortController();
      const fetchPromise = fake(testUrl, { signal: controller.signal });

      controller.abort();
      await expect(fetchPromise).rejects.toMatchObject({ name: 'AbortError' });
      deferred.resolve(new Response('too late'));
    });

    it('fails closed on unexpected calls, method mismatch, and URL mismatch', async () => {
      const fake = createFakeFetch();
      fake.enqueueResponse({ status: 200 }, { expectedUrl: testUrl, expectedMethod: 'POST' });

      await expect(fake(testUrl, { method: 'GET' })).rejects.toThrow(/method mismatch/);

      fake.reset();
      fake.enqueueResponse({ status: 200 }, { expectedUrl: 'https://exact.example.com' });
      await expect(fake('https://other.example.com')).rejects.toThrow(/URL mismatch/);

      fake.reset();
      await expect(fake('https://unexpected.example.com')).rejects.toThrow(/Unexpected fetch call/);
    });
  });
});
