/**
 * T36c1 Dedicated Worker Host Composition
 * Bounded composition connecting dedicated WorkerSession with actual WorkerWriters and transferable transport.
 * Extracts transferable ArrayBuffers for STAGED_ARTIFACTS with deduplication and strict ownership validation.
 * Invariant: Never handles auth tokens, network, browser globals, timers, or persistent caches.
 */

import type { Artifact } from '../contracts/domain.ts';
import type { WorkerResponse } from '../contracts/messages.ts';
import { DomainError } from '../contracts/errors.ts';
import type { WorkerSession } from './worker-session.ts';
import { createWorkerSession } from './worker-session.ts';
import { createWorkerWriter } from './worker-writers.ts';

function collectTransferables(artifacts: readonly Artifact[]): Transferable[] {
  if (!Array.isArray(artifacts)) {
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }

  const transferSet = new Set<Transferable>();

  for (let i = 0; i < artifacts.length; i++) {
    const artifact = artifacts[i];
    if (!artifact || typeof artifact !== 'object') {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    const data = artifact.data;
    if (data instanceof Uint8Array) {
      const buf = data.buffer;
      const isGenuineArrayBuffer =
        buf instanceof ArrayBuffer &&
        !(typeof SharedArrayBuffer !== 'undefined' && (buf as unknown) instanceof SharedArrayBuffer);

      if (
        data.byteOffset !== 0 ||
        data.byteLength !== buf.byteLength ||
        !isGenuineArrayBuffer
      ) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      transferSet.add(buf);
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      // Blob artifacts (general domain allows) not transferlisted
      continue;
    } else {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
  }

  return Array.from(transferSet);
}

export function createWorkerHost(
  post: (response: WorkerResponse, transfer: Transferable[]) => void
): WorkerSession {
  if (typeof post !== 'function') {
    throw new DomainError('INTERNAL_ERROR');
  }

  return createWorkerSession({
    createWriter: createWorkerWriter,
    emit(response: WorkerResponse): void {
      if (response.type === 'STAGED_ARTIFACTS') {
        const transfer = collectTransferables(response.artifacts);
        post(response, transfer);
        return;
      }

      post(response, []);
    },
  });
}
