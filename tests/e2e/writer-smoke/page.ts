/**
 * T36a Extension Page Script for Real MV3 Writer Browser Smoke Harness.
 * Installs CSP violation and window error observers BEFORE starting worker.
 * Connects to dedicated module worker, receives transferred artifact buffers,
 * waits for native transfer detachment observation, encodes small bytes to base64,
 * terminates worker on completion/error, and exposes window.__WRITER_SMOKE__ for CDP runner.
 */

interface CspViolationRecord {
  blockedURI: string;
  violatedDirective: string;
  effectiveDirective: string;
}

interface SmokeArtifactPayload {
  filename: string;
  mimeType: string;
  byteLength: number;
  base64: string;
}

interface SmokeResult {
  done: boolean;
  error: string | null;
  cspViolations: CspViolationRecord[];
  pageErrors: string[];
  transferredBufferByteLengths?: number[] | undefined;
  jsonArtifact?: SmokeArtifactPayload | undefined;
  csvArtifacts?: SmokeArtifactPayload[] | undefined;
  xlsxArtifacts?: SmokeArtifactPayload[] | undefined;
  negativeResult?: {
    caughtErrorCode: string | null;
  } | undefined;
}

declare global {
  interface Window {
    __cspViolations: CspViolationRecord[];
    __pageErrors: string[];
    __WRITER_SMOKE__: SmokeResult | null;
  }
}

// 1. Install CSP and error observers BEFORE starting worker
window.__cspViolations = [];
window.__pageErrors = [];
window.__WRITER_SMOKE__ = null;

document.addEventListener('securitypolicyviolation', (e: SecurityPolicyViolationEvent) => {
  window.__cspViolations.push({
    blockedURI: e.blockedURI,
    violatedDirective: e.violatedDirective,
    effectiveDirective: e.effectiveDirective
  });
});

window.addEventListener('error', (e: ErrorEvent) => {
  window.__pageErrors.push(e.message || String(e));
});

window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const reason = e.reason;
  window.__pageErrors.push(reason instanceof Error ? reason.message : String(reason));
});

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// 2. Instantiate dedicated ES module worker
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

// Terminate worker on window unload/beforeunload
window.addEventListener('beforeunload', () => {
  worker.terminate();
});
window.addEventListener('unload', () => {
  worker.terminate();
});

function handleFailure(errMsg: string): void {
  worker.terminate();
  window.__pageErrors.push(errMsg);
  window.__WRITER_SMOKE__ = {
    done: true,
    error: errMsg,
    cspViolations: window.__cspViolations,
    pageErrors: window.__pageErrors
  };
  const statusEl = document.getElementById('smoke-status');
  if (statusEl) statusEl.textContent = 'error';
}

worker.onerror = (e: ErrorEvent) => {
  handleFailure(e.message || 'Worker runtime error');
};

worker.onmessageerror = () => {
  handleFailure('Worker message deserialization failed');
};

interface StagedPayload {
  jsonArtifact: { filename: string; mimeType: string; byteLength: number; data: Uint8Array };
  csvArtifacts: Array<{ filename: string; mimeType: string; byteLength: number; data: Uint8Array }>;
  xlsxArtifacts: Array<{ filename: string; mimeType: string; byteLength: number; data: Uint8Array }>;
  negativeResult?: { caughtErrorCode: string | null };
}

let stagedPayload: StagedPayload | null = null;
let stagedObservation: number[] | null = null;

function finalizeIfReady(): void {
  if (!stagedPayload || !stagedObservation) return;

  const data = stagedPayload;
  const jsonArt = data.jsonArtifact;
  const csvArts = data.csvArtifacts || [];
  const xlsxArts = data.xlsxArtifacts || [];

  window.__WRITER_SMOKE__ = {
    done: true,
    error: null,
    cspViolations: window.__cspViolations,
    pageErrors: window.__pageErrors,
    transferredBufferByteLengths: stagedObservation,
    jsonArtifact: {
      filename: jsonArt.filename,
      mimeType: jsonArt.mimeType,
      byteLength: jsonArt.byteLength,
      base64: uint8ArrayToBase64(jsonArt.data)
    },
    csvArtifacts: csvArts.map(a => ({
      filename: a.filename,
      mimeType: a.mimeType,
      byteLength: a.byteLength,
      base64: uint8ArrayToBase64(a.data)
    })),
    xlsxArtifacts: xlsxArts.map(a => ({
      filename: a.filename,
      mimeType: a.mimeType,
      byteLength: a.byteLength,
      base64: uint8ArrayToBase64(a.data)
    })),
    negativeResult: data.negativeResult
  };

  // Terminate worker after receiving observation
  worker.terminate();

  const statusEl = document.getElementById('smoke-status');
  if (statusEl) statusEl.textContent = 'complete';
}

worker.onmessage = (event: MessageEvent) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'SMOKE_COMPLETE' && data.success) {
    stagedPayload = data;
    finalizeIfReady();
  } else if (data.type === 'TRANSFER_OBSERVATION' && Array.isArray(data.transferredBufferByteLengths)) {
    stagedObservation = data.transferredBufferByteLengths;
    finalizeIfReady();
  } else if (data.type === 'SMOKE_ERROR') {
    handleFailure(String(data.error || 'Worker smoke error'));
  }
};

// 3. Signal worker to start execution
worker.postMessage({ type: 'START' });
