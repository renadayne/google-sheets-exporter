import { describe, it, expect, vi } from 'vitest';
import { DomainError, SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import { readBoundedJson, MAX_DECODED_BYTES_CAP } from '../../src/source/response-body.ts';

function makeStream(
  chunks: readonly Uint8Array[],
  onCancel?: () => Promise<void> | void
): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel() {
      return onCancel ? onCancel() : undefined;
    }
  });
}

describe('T21a1 readBoundedJson', () => {
  it('valid multichunk Unicode with codepoint split and BOM', async () => {
    // BOM: EF BB BF (3 bytes). '{"msg":"' (8 bytes). '🌍' (F0 9F 8C 8D, 4 bytes). '"}' (2 bytes).
    // Total independent exact byte count = 17 bytes.
    const part1 = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x22, 0x6d, 0x73, 0x67, 0x22, 0x3a, 0x22, 0xf0, 0x9f]);
    const part2 = new Uint8Array([0x8c, 0x8d, 0x22, 0x7d]);
    expect(part1.byteLength + part2.byteLength).toBe(17);

    const stream = makeStream([part1, part2]);
    const res = new Response(stream);
    const result = await readBoundedJson(res, {
      maxDecodedBytes: 64,
      signal: new AbortController().signal
    });

    expect(result.byteCount).toBe(17);
    expect(result.payload).toEqual({ msg: '🌍' });
  });

  it('same valid body at exact cap and cap-1', async () => {
    const payload = { test: 'consistent-payload', values: [10, 20, 30] };
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    const exactCap = encoded.byteLength;

    // Exact cap -> succeeds
    const resExact = new Response(makeStream([encoded]));
    const result = await readBoundedJson(resExact, {
      maxDecodedBytes: exactCap,
      signal: new AbortController().signal
    });
    expect(result.byteCount).toBe(exactCap);
    expect(result.payload).toEqual(payload);

    // Exact cap - 1 -> BYTE_LIMIT_EXCEEDED
    const resCapMinus1 = new Response(makeStream([encoded]));
    await expect(
      readBoundedJson(resCapMinus1, {
        maxDecodedBytes: exactCap - 1,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'BYTE_LIMIT_EXCEEDED' });
  });

  it('exact cap/cap-1 with absent and misleading compressed Content-Length', async () => {
    const ac = new AbortController();
    // '{"a":1}' = 7 bytes. Cap = 8 -> Cap - 1 = 7. Misleading large Content-Length.
    const body7 = new TextEncoder().encode('{"a":1}');
    const resCapMinus1 = new Response(makeStream([body7]), {
      headers: { 'Content-Length': '999999' }
    });
    const r1 = await readBoundedJson(resCapMinus1, { maxDecodedBytes: 8, signal: ac.signal });
    expect(r1.byteCount).toBe(7);
    expect(r1.payload).toEqual({ a: 1 });

    // '{"ab":1}' = 8 bytes. Exact Cap = 8. Absent Content-Length.
    const body8 = new TextEncoder().encode('{"ab":1}');
    const resExactCap = new Response(makeStream([body8]));
    const r2 = await readBoundedJson(resExactCap, { maxDecodedBytes: 8, signal: ac.signal });
    expect(r2.byteCount).toBe(8);
    expect(r2.payload).toEqual({ ab: 1 });

    // '{"abc":1}' = 9 bytes. Exceeds Cap = 8. Misleading small Content-Length.
    const body9 = new TextEncoder().encode('{"abc":1}');
    const resOverCap = new Response(makeStream([body9]), {
      headers: { 'Content-Length': '2' }
    });
    await expect(
      readBoundedJson(resOverCap, { maxDecodedBytes: 8, signal: ac.signal })
    ).rejects.toMatchObject({ code: 'BYTE_LIMIT_EXCEEDED' });
  });

  it('many one-byte fragments with independent byte count/payload expected (20k)', async () => {
    const rawData = 'z'.repeat(20000);
    const payload = { key: rawData };
    const fullBytes = new TextEncoder().encode(JSON.stringify(payload));
    const expectedByteCount = fullBytes.byteLength;
    expect(expectedByteCount).toBeGreaterThan(20000);

    const oneByteFragments: Uint8Array[] = [];
    for (let i = 0; i < fullBytes.byteLength; i++) {
      oneByteFragments.push(fullBytes.subarray(i, i + 1));
    }

    const stream = makeStream(oneByteFragments);
    const res = new Response(stream);
    const result = await readBoundedJson(res, {
      maxDecodedBytes: expectedByteCount + 512,
      signal: new AbortController().signal
    });

    expect(result.byteCount).toBe(expectedByteCount);
    expect(result.payload).toEqual(payload);
  });

  it('empty body/malformed JSON/invalid UTF8 reject with static SOURCE_UNSUPPORTED', async () => {
    const signal = new AbortController().signal;

    // Empty body (null)
    await expect(
      readBoundedJson(new Response(null), { maxDecodedBytes: 64, signal })
    ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });

    // Empty stream (0 bytes)
    await expect(
      readBoundedJson(new Response(makeStream([])), { maxDecodedBytes: 64, signal })
    ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });

    // Malformed JSON
    await expect(
      readBoundedJson(new Response('{"unclosed":'), { maxDecodedBytes: 64, signal })
    ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });

    // Invalid UTF-8 bytes
    const invalidBytes = new Uint8Array([0xff, 0xfe, 0xff]);
    await expect(
      readBoundedJson(new Response(makeStream([invalidBytes])), { maxDecodedBytes: 64, signal })
    ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
  });

  it('preabort no body reads', async () => {
    const ac = new AbortController();
    ac.abort();

    const body = new ReadableStream<Uint8Array>();
    const res = new Response(body);
    const getReaderSpy = vi.spyOn(res.body!, 'getReader');

    await expect(
      readBoundedJson(res, { maxDecodedBytes: 64, signal: ac.signal })
    ).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });

    expect(getReaderSpy).not.toHaveBeenCalled();
  });

  it('abort stalled read with cancel that never resolves (pull starts first)', async () => {
    const ac = new AbortController();
    let pullStartedResolve!: () => void;
    const pullStarted = new Promise<void>((r) => {
      pullStartedResolve = r;
    });

    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        pullStartedResolve();
        return new Promise(() => {}); // never resolves
      },
      cancel() {
        cancelCalled = true;
        return new Promise(() => {}); // never resolves
      }
    });

    const promise = readBoundedJson(new Response(stream), {
      maxDecodedBytes: 64,
      signal: ac.signal
    });

    // Deterministically wait until pull starts before aborting
    await pullStarted;
    ac.abort();

    await expect(promise).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(cancelCalled).toBe(true);
  });

  it('late stream reject after cancellation without unhandled rejection (pull starts first)', async () => {
    let pullStartedResolve!: () => void;
    const pullStarted = new Promise<void>((r) => {
      pullStartedResolve = r;
    });

    let lateReject!: (err: Error) => void;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise((_, reject) => {
          lateReject = reject;
          pullStartedResolve();
        });
      }
    });

    const ac = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const promise = readBoundedJson(new Response(stream), {
        maxDecodedBytes: 64,
        signal: ac.signal
      });

      // Deterministically wait until pull starts before aborting
      await pullStarted;
      ac.abort();
      await expect(promise).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });

      // Late stream rejection
      lateReject(new Error('late stream failure'));
      await new Promise((r) => setTimeout(r, 20));

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('stream errors redacted and classified as NETWORK_OFFLINE', async () => {
    const secret = 'SECRET_TOKEN_EXPOSED_98765';
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(`Transport stream crashed with ${secret}`);
      }
    });

    const ac = new AbortController();
    const err = await readBoundedJson(new Response(stream), {
      maxDecodedBytes: 64,
      signal: ac.signal
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DomainError);
    const domainErr = err as DomainError;
    expect(domainErr.code).toBe('NETWORK_OFFLINE');
    expect(domainErr.message).toBe(SAFE_ERROR_MESSAGES.NETWORK_OFFLINE);
    expect(JSON.stringify(domainErr)).not.toContain(secret);
    expect(String(domainErr)).not.toContain(secret);
  });

  it('provider DomainError classified NETWORK_OFFLINE', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new DomainError('RESTRICTED_ACCESS');
      }
    });

    const ac = new AbortController();
    const err = await readBoundedJson(new Response(stream), {
      maxDecodedBytes: 64,
      signal: ac.signal
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DomainError);
    const domainErr = err as DomainError;
    expect(domainErr.code).toBe('NETWORK_OFFLINE');
    expect(domainErr.message).toBe(SAFE_ERROR_MESSAGES.NETWORK_OFFLINE);
  });

  it('injected DomainError with mutated message or throwing code cannot leak raw diagnostic', async () => {
    const mutated = new DomainError('BYTE_LIMIT_EXCEEDED');
    Object.defineProperty(mutated, 'message', {
      value: 'RAW_SECRET_LEAK_IN_MUTATED_MESSAGE'
    });

    const throwingCode = new DomainError('CONFIG_INVALID');
    Object.defineProperty(throwingCode, 'code', {
      get() {
        throw new Error('RAW_SECRET_LEAK_IN_CODE_GETTER');
      }
    });

    for (const error of [mutated, throwingCode]) {
      const stream = new ReadableStream<Uint8Array>({ pull() { throw error; } });
      const failure = await readBoundedJson(new Response(stream), {
        maxDecodedBytes: 64, signal: new AbortController().signal
      }).catch(reason => reason);
      expect(failure).toMatchObject({ code: 'NETWORK_OFFLINE', message: SAFE_ERROR_MESSAGES.NETWORK_OFFLINE });
      expect(failure).not.toBe(error);
      expect(JSON.stringify(failure)).not.toContain('RAW_SECRET');
    }
  });

  it('registers pending cancellation before read invokes a synchronous aborting pull', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull() { controller.abort(); return new Promise(() => {}); }
    }, { highWaterMark: 0 });
    await expect(readBoundedJson(new Response(stream), {
      maxDecodedBytes: 64, signal: controller.signal
    })).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(stream.locked).toBe(false);
  });

  it('contains a signal getter failure inside a rejected read continuation', async () => {
    let reading = false;
    const controller = new AbortController();
    const signal = {
      get aborted() { if (reading) throw new Error('RAW_SECRET_RUNTIME_SIGNAL'); return false; },
      addEventListener: controller.signal.addEventListener.bind(controller.signal),
      removeEventListener: controller.signal.removeEventListener.bind(controller.signal)
    } as AbortSignal;
    const stream = new ReadableStream<Uint8Array>({
      pull() { reading = true; throw new Error('RAW_SECRET_READ'); }
    }, { highWaterMark: 0 });
    await expect(readBoundedJson(new Response(stream), { maxDecodedBytes: 64, signal }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', message: SAFE_ERROR_MESSAGES.CONFIG_INVALID });
  });

  it('malformed signal/body getters static errors', async () => {
    const validSignal = new AbortController().signal;

    // Throwing signal.aborted getter -> CONFIG_INVALID
    const badSignalAborted = {
      get aborted(): boolean {
        throw new Error('signal.aborted getter threw');
      },
      addEventListener() {},
      removeEventListener() {}
    } as unknown as AbortSignal;
    await expect(
      readBoundedJson(new Response('{}'), {
        maxDecodedBytes: 64,
        signal: badSignalAborted
      })
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    // Throwing signal.addEventListener getter -> CONFIG_INVALID
    const badSignalAdd = {
      aborted: false,
      get addEventListener() {
        throw new Error('addEventListener getter threw');
      },
      removeEventListener() {}
    } as unknown as AbortSignal;
    await expect(
      readBoundedJson(new Response('{}'), {
        maxDecodedBytes: 64,
        signal: badSignalAdd
      })
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    // Throwing response.body getter -> SOURCE_UNSUPPORTED
    const badResponseBody = {
      get body() {
        throw new Error('response.body getter threw');
      }
    } as unknown as Response;
    await expect(
      readBoundedJson(badResponseBody, {
        maxDecodedBytes: 64,
        signal: validSignal
      })
    ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });

    // Throwing body.getReader getter -> SOURCE_UNSUPPORTED
    const badBodyReaderGetter = {
      body: {
        get getReader() {
          throw new Error('getReader getter threw');
        }
      }
    } as unknown as Response;
    await expect(
      readBoundedJson(badBodyReaderGetter, {
        maxDecodedBytes: 64,
        signal: validSignal
      })
    ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });

    // Throwing getReader() invocation -> SOURCE_UNSUPPORTED
    const badBodyReaderCall = {
      body: {
        getReader() {
          throw new Error('getReader() threw');
        }
      }
    } as unknown as Response;
    await expect(
      readBoundedJson(badBodyReaderCall, {
        maxDecodedBytes: 64,
        signal: validSignal
      })
    ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
  });

  it('add/remove listener same function and final stream lock released', async () => {
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, 'addEventListener');
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

    const stream = makeStream([new TextEncoder().encode('{"ok":true}')]);
    const res = new Response(stream);

    const result = await readBoundedJson(res, { maxDecodedBytes: 64, signal: ac.signal });
    expect(result.payload).toEqual({ ok: true });

    expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    const addedListener = addSpy.mock.calls[0][1];
    const removedListener = removeSpy.mock.calls[0][1];
    expect(addedListener).toBe(removedListener);

    expect(stream.locked).toBe(false);
  });

  it('cancellation cleanup and listener removal on limit breach and bad config', async () => {
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, 'addEventListener');
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

    // Limit exceeded path
    const bigStream = makeStream([new TextEncoder().encode('{"large":123456789}')]);
    await expect(
      readBoundedJson(new Response(bigStream), { maxDecodedBytes: 5, signal: ac.signal })
    ).rejects.toMatchObject({ code: 'BYTE_LIMIT_EXCEEDED' });

    expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    const added = addSpy.mock.calls[0][1];
    const removed = removeSpy.mock.calls[0][1];
    expect(added).toBe(removed);

    // Bad config rejects with CONFIG_INVALID
    await expect(
      readBoundedJson(new Response(), { maxDecodedBytes: -1, signal: ac.signal })
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      readBoundedJson(new Response(), {
        maxDecodedBytes: MAX_DECODED_BYTES_CAP + 1,
        signal: ac.signal
      })
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      readBoundedJson(new Response(), { maxDecodedBytes: 10, signal: {} as AbortSignal })
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});
