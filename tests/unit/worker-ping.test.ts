import { describe, it, expect } from 'vitest';
import { handleWorkerMessage } from '../../src/runtime/export-worker.ts';

describe('Export worker deterministic smoke ping protocol', () => {
  it('rejects a non-string payload instead of reflecting arbitrary objects', () => {
    expect(handleWorkerMessage({ type: 'PING', id: 'invalid-payload', payload: { unexpected: true } }).type).toBe('ERROR');
  });
  it('responds with PONG echoing correlation id for valid PING message', () => {
    const response = handleWorkerMessage({
      type: 'PING',
      id: 'msg-corr-123',
      payload: 'deterministic-smoke'
    });

    expect(response).toEqual({
      type: 'PONG',
      id: 'msg-corr-123',
      payload: 'deterministic-smoke',
      echo: 'PONG:msg-corr-123'
    });
  });

  it('rejects PING message without id', () => {
    const response = handleWorkerMessage({
      type: 'PING',
      payload: 'missing-id'
    });

    expect(response.type).toBe('ERROR');
    if (response.type === 'ERROR') {
      expect(response.error).toContain('id is required');
    }
  });

  it('rejects PING message with empty or whitespace id', () => {
    const emptyIdResponse = handleWorkerMessage({
      type: 'PING',
      id: ''
    });
    expect(emptyIdResponse.type).toBe('ERROR');

    const wsIdResponse = handleWorkerMessage({
      type: 'PING',
      id: '   '
    });
    expect(wsIdResponse.type).toBe('ERROR');
  });

  it('rejects PING message with non-string id', () => {
    const numIdResponse = handleWorkerMessage({
      type: 'PING',
      id: 12345 as unknown as string
    });
    expect(numIdResponse.type).toBe('ERROR');
  });

  it('rejects null or non-object payloads', () => {
    expect(handleWorkerMessage(null).type).toBe('ERROR');
    expect(handleWorkerMessage(undefined).type).toBe('ERROR');
    expect(handleWorkerMessage('string-payload').type).toBe('ERROR');
    expect(handleWorkerMessage(123).type).toBe('ERROR');
  });

  it('rejects unsupported message types or missing type', () => {
    const response = handleWorkerMessage({
      type: 'EXTRACT_SHEETS_WITH_TOKEN',
      id: 'leak-test'
    });
    expect(response.type).toBe('ERROR');

    const noTypeResponse = handleWorkerMessage({
      id: 'no-type'
    });
    expect(noTypeResponse.type).toBe('ERROR');
  });
});
