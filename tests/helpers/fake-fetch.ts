import type { Fetch } from '../../src/contracts/ports.ts';
import { awaitWithSignal, type Deferred } from './deterministic.ts';

export interface FakeResponseInit {
  readonly status?: number | undefined;
  readonly statusText?: string | undefined;
  readonly headers?: HeadersInit | undefined;
  readonly body?: string | null | undefined;
}

export interface FakeFetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
  readonly signal?: AbortSignal | undefined;
}

export interface FakeFetchExpectation {
  readonly expectedUrl?: string | RegExp | ((url: string) => boolean) | undefined;
  readonly expectedMethod?: string | undefined;
}

export interface FakeFetchStep extends FakeFetchExpectation {
  readonly response?: FakeResponseInit | undefined;
  readonly error?: Error | undefined;
  readonly deferred?: Deferred<Response> | undefined;
  readonly handle?: ((call: FakeFetchCall) => Promise<Response> | Response) | undefined;
}

export interface FakeFetch extends Fetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  readonly fetch: Fetch;
  readonly calls: readonly FakeFetchCall[];
  readonly enqueueResponse: (response?: FakeResponseInit, expectations?: FakeFetchExpectation) => FakeFetch;
  readonly enqueueError: (error: Error, expectations?: FakeFetchExpectation) => FakeFetch;
  readonly enqueueDeferred: (deferred: Deferred<Response>, expectations?: FakeFetchExpectation) => FakeFetch;
  readonly enqueueStep: (step: FakeFetchStep) => FakeFetch;
  readonly remaining: () => number;
  readonly reset: () => void;
}

function validateStep(step: FakeFetchStep): void {
  let outcomeCount = 0;
  if (step.response !== undefined) outcomeCount++;
  if (step.error !== undefined) outcomeCount++;
  if (step.deferred !== undefined) outcomeCount++;
  if (step.handle !== undefined) outcomeCount++;

  if (outcomeCount === 0) {
    throw new Error('FakeFetchStep must configure exactly one outcome, got none');
  }
  if (outcomeCount > 1) {
    throw new Error(`FakeFetchStep must configure exactly one outcome, got ${outcomeCount} conflicting outcomes`);
  }
}

function matchesRegex(regex: RegExp, url: string): boolean {
  return new RegExp(regex.source, regex.flags).test(url);
}

export function createFakeFetch(initialSteps?: Iterable<FakeFetchStep> | undefined): FakeFetch {
  const queue: FakeFetchStep[] = [];
  if (initialSteps) {
    for (const step of initialSteps) {
      validateStep(step);
      queue.push(step);
    }
  }
  const calls: FakeFetchCall[] = [];

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal =
      init?.signal === null
        ? undefined
        : init?.signal !== undefined
          ? init.signal
          : (input instanceof Request ? input.signal : undefined);

    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    }

    let url: string;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      url = input.url;
    }

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));

    let body: string | null = null;
    if (typeof init?.body === 'string') {
      body = init.body;
    } else if (init?.body instanceof Uint8Array) {
      body = new TextDecoder().decode(init.body);
    } else if (input instanceof Request && !input.bodyUsed) {
      try {
        const textPromise = input.clone().text();
        body = await (signal ? awaitWithSignal(textPromise, signal) : textPromise);
        if (body === '') body = null;
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        body = null;
      }
    }

    signal?.throwIfAborted();
    const callRecord: FakeFetchCall = Object.freeze({
      url,
      method,
      headers,
      body,
      signal
    });
    calls.push(callRecord);

    const callIndex = calls.length;
    const step = queue.shift();
    if (!step) {
      throw new Error(`Unexpected fetch call #${callIndex}: [${method}]`);
    }

    if (step.expectedMethod && step.expectedMethod.toUpperCase() !== method) {
      throw new Error(
        `Fetch method mismatch on call #${callIndex}: expected ${step.expectedMethod.toUpperCase()}, got ${method}`
      );
    }

    if (step.expectedUrl) {
      const matches =
        typeof step.expectedUrl === 'string'
          ? step.expectedUrl === url
          : step.expectedUrl instanceof RegExp
            ? matchesRegex(step.expectedUrl, url)
            : step.expectedUrl(url);

      if (!matches) {
        throw new Error(`Fetch URL mismatch on call #${callIndex}`);
      }
    }

    if (step.error) {
      return awaitWithSignal(Promise.reject(step.error), signal);
    }
    if (step.deferred) {
      return awaitWithSignal(step.deferred.promise, signal);
    }
    if (step.handle) {
      return awaitWithSignal(Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return step.handle!(callRecord);
      }), signal);
    }
    if (step.response) {
      const respInit = step.response;
      const status = respInit.status ?? 200;
      const statusText = respInit.statusText ?? (status === 200 ? 'OK' : '');
      const responseInit: ResponseInit = {
        status,
        statusText,
        ...(respInit.headers !== undefined ? { headers: respInit.headers } : {})
      };
      const response = new Response(respInit.body ?? null, responseInit);
      return awaitWithSignal(Promise.resolve(response), signal);
    }

    throw new Error('FakeFetchStep has no configured outcome');
  };

  const target = handler as unknown as Record<string, unknown>;
  target['fetch'] = handler;
  target['calls'] = calls;
  target['enqueueResponse'] = (response: FakeResponseInit = {}, expectations?: FakeFetchExpectation): FakeFetch => {
    const step: FakeFetchStep = {
      ...expectations,
      response: { ...response }
    };
    validateStep(step);
    queue.push(step);
    return handler as FakeFetch;
  };
  target['enqueueError'] = (error: Error, expectations?: FakeFetchExpectation): FakeFetch => {
    const step: FakeFetchStep = {
      ...expectations,
      error
    };
    validateStep(step);
    queue.push(step);
    return handler as FakeFetch;
  };
  target['enqueueDeferred'] = (deferred: Deferred<Response>, expectations?: FakeFetchExpectation): FakeFetch => {
    const step: FakeFetchStep = {
      ...expectations,
      deferred
    };
    validateStep(step);
    queue.push(step);
    return handler as FakeFetch;
  };
  target['enqueueStep'] = (step: FakeFetchStep): FakeFetch => {
    validateStep(step);
    queue.push(step);
    return handler as FakeFetch;
  };
  target['remaining'] = (): number => queue.length;
  target['reset'] = (): void => {
    queue.length = 0;
    calls.length = 0;
  };

  return handler as FakeFetch;
}
