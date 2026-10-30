/**
 * Dedicated Web Worker Stub.
 * Ownership: Heavy CPU processing (future serialization / normalization).
 * Invariant: Never receives or handles auth tokens or secrets.
 * Supports deterministic smoke ping for T07 MV3 harness verification.
 */

export interface PingMessage {
  type: 'PING';
  id: string;
  payload?: string | undefined;
}

export interface PongMessage {
  type: 'PONG';
  id: string;
  payload?: string | undefined;
  echo: string;
}

export interface ErrorMessage {
  type: 'ERROR';
  id?: string | undefined;
  error: string;
}

export type WorkerInMessage = PingMessage;
export type WorkerOutMessage = PongMessage | ErrorMessage;

export function handleWorkerMessage(data: unknown): WorkerOutMessage {
  if (typeof data !== 'object' || data === null) {
    return { type: 'ERROR', error: 'Invalid message: expected object' };
  }

  const msg = data as Partial<PingMessage>;

  if (msg.type === 'PING') {
    if (typeof msg.id !== 'string' || !msg.id.trim()) {
      return { type: 'ERROR', error: 'Invalid PING message: id is required' };
    }
    if (msg.payload !== undefined && typeof msg.payload !== 'string') {
      return { type: 'ERROR', error: 'Invalid PING message: payload must be a string' };
    }
    return {
      type: 'PONG',
      id: msg.id,
      payload: msg.payload,
      echo: `PONG:${msg.id}`
    };
  }

  return { type: 'ERROR', error: `Unsupported message type: ${String(msg.type)}` };
}

// In dedicated worker runtime, listen for messages
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.addEventListener('message', (event: MessageEvent) => {
    const response = handleWorkerMessage(event.data);
    self.postMessage(response);
  });
}
