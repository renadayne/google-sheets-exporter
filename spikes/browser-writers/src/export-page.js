function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}

const cspViolations = [];
self.addEventListener('securitypolicyviolation', e => {
  cspViolations.push({
    blockedURI: e.blockedURI,
    violatedDirective: e.violatedDirective,
    effectiveDirective: e.effectiveDirective
  });
});

async function runWorkerCancelTest() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
    let lateMessagesAfterTerminate = 0;
    let terminatedAt = 0;

    worker.addEventListener('message', event => {
      const data = event.data;
      if (terminatedAt > 0) {
        lateMessagesAfterTerminate++;
        return;
      }
      if (data && data.type === 'HEAVY_STARTED') {
        const t0 = performance.now();
        worker.terminate();
        terminatedAt = performance.now();
        const terminateCallMs = terminatedAt - t0;
        setTimeout(() => {
          resolve({
            terminatedCleanly: lateMessagesAfterTerminate === 0,
            terminateCallMs: Number(terminateCallMs.toFixed(3)),
            lateMessagesAfterTerminate
          });
        }, 150);
      }
    });

    worker.addEventListener('error', err => {
      reject(new Error(`Cancel worker error: ${err.message}`));
    });

    worker.postMessage({ type: 'RUN_HEAVY_FOR_CANCEL', jobId: 'cancel-job-1' });
  });
}

async function runFullBrowserSpike() {
  const statusEl = document.getElementById('status');
  statusEl.textContent = 'RUNNING';

  const cancelResult = await runWorkerCancelTest();

  const workerResult = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', event => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'SPIKE_COMPLETE') {
        worker.terminate();
        resolve(data);
      } else if (data.type === 'SPIKE_ERROR') {
        worker.terminate();
        reject(new Error(data.error));
      }
    });
    worker.addEventListener('error', err => {
      worker.terminate();
      reject(new Error(`Worker runtime error: ${err.message}`));
    });
    worker.postMessage({ type: 'RUN_SYNTHETIC_SPIKE', jobId: 'spike-job-1' });
  });

  // Verify Blob URL creation & revocation lifecycle in extension page
  const xlsxBlob = new Blob([workerResult.xlsxBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const blobUrl = URL.createObjectURL(xlsxBlob);
  const blobUrlCreated = blobUrl.startsWith('blob:chrome-extension://') || blobUrl.startsWith('blob:');
  const beforeRevoke = await fetch(blobUrl);
  const readableBeforeRevoke = beforeRevoke.ok &&
    (await beforeRevoke.arrayBuffer()).byteLength === workerResult.xlsxBuffer.byteLength;
  URL.revokeObjectURL(blobUrl);
  let revokedCleanly = false;
  try {
    await fetch(blobUrl);
  } catch {
    revokedCleanly = true;
  }

  const pageMemory =
    typeof performance !== 'undefined' && performance.memory
      ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
        }
      : null;

  const output = {
    environment: {
      userAgent: navigator.userAgent,
      origin: location.origin,
      protocol: location.protocol,
      isExtensionPage: location.protocol === 'chrome-extension:'
    },
    pageMemory,
    cspViolations,
    blobLifecycle: {
      blobUrlCreated,
      readableBeforeRevoke,
      blobUrlPrefix: blobUrl.split('/').slice(0, 3).join('/'),
      revokedCleanly
    },
    cancelResult,
    metrics: workerResult.metrics,
    nameMappings: workerResult.nameMappings,
    nameEdgeMappings: workerResult.nameEdgeMappings,
    manifest: workerResult.manifest,
    guardChecks: workerResult.guardChecks,
    xlsxBase64: arrayBufferToBase64(workerResult.xlsxBuffer),
    zipBase64: arrayBufferToBase64(workerResult.zipBuffer)
  };

  window.__T04_SPIKE_RESULT__ = output;
  statusEl.textContent = 'DONE';
  return output;
}

window.__RUN_T04_SPIKE__ = runFullBrowserSpike;
runFullBrowserSpike().catch(err => {
  const statusEl = document.getElementById('status');
  statusEl.textContent = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  window.__T04_SPIKE_ERROR__ = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
});
