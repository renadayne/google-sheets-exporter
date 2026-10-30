import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { verifyArtifacts } from './verify-artifacts.mjs';

const CHROME_PATH =
  process.env.CHROME_PATH ||
  'C:\\Users\\huytu\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const distDir = resolve(import.meta.dirname, '../dist');
const artifactsDir = resolve(import.meta.dirname, '../artifacts');

mkdirSync(artifactsDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
  args: [
    '--headless=new',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check'
  ]
});

try {
  const browserCdp = await browser.newBrowserCDPSession();
  const { id: extensionId } = await browserCdp.send('Extensions.loadUnpacked', {
    path: distDir
  });
  assert.ok(extensionId, 'Extensions.loadUnpacked must return an extensionId');
  const exportPageUrl = `chrome-extension://${extensionId}/export.html`;

  const { targetId } = await browserCdp.send('Target.createTarget', {
    url: exportPageUrl
  });
  const { sessionId } = await browserCdp.send('Target.attachToTarget', {
    targetId,
    flatten: false
  });

  let nextMsgId = 1;
  const pending = new Map();
  const pageErrors = [];
  const consoleErrors = [];

  browserCdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const msg = JSON.parse(event.message);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.text || 'Runtime.exceptionThrown');
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push(msg.params?.args?.map(a => a.value ?? a.description).join(' '));
    }
  });

  function sendToPage(method, params = {}) {
    const id = nextMsgId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`Chrome page command timed out: ${method}`));
      }, 10000);
      pending.set(id, { resolve: res, reject: rej, timer });
      browserCdp
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params })
        })
        .catch(err => {
          clearTimeout(timer);
          pending.delete(id);
          rej(err);
        });
    });
  }

  await sendToPage('Runtime.enable');
  await sendToPage('Performance.enable');

  let result = null;
  let spikeError = null;
  for (let i = 0; i < 120; i++) {
    const evalRes = await sendToPage('Runtime.evaluate', {
      expression:
        'JSON.stringify({ done: Boolean(window.__T04_SPIKE_RESULT__), error: window.__T04_SPIKE_ERROR__ || null, result: window.__T04_SPIKE_RESULT__ || null })',
      returnByValue: true
    });
    const valStr = evalRes?.result?.value;
    if (valStr) {
      const parsed = JSON.parse(valStr);
      if (parsed.error) {
        spikeError = parsed.error;
        break;
      }
      if (parsed.done && parsed.result) {
        result = parsed.result;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 250));
  }

  if (spikeError) {
    throw new Error(`Extension worker spike error: ${spikeError}`);
  }
  assert.ok(result, 'Timed out waiting for window.__T04_SPIKE_RESULT__ in extension page');

  const perfMetricsRes = await sendToPage('Performance.getMetrics');
  const perfMetrics = Object.fromEntries(
    (perfMetricsRes?.metrics || [])
      .filter(m => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'JSEventListeners'].includes(m.name))
      .map(m => [m.name, m.value])
  );
  assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join('; ')}`);
  assert.equal(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join('; ')}`);
  assert.equal(result.cspViolations.length, 0, 'Expected zero CSP violations');
  assert.equal(result.environment.isExtensionPage, true, 'Must run inside chrome-extension:// page');
  assert.equal(result.blobLifecycle.blobUrlCreated, true, 'Must create a Blob URL');
  assert.equal(result.blobLifecycle.readableBeforeRevoke, true, 'Blob must be readable before revocation');
  assert.equal(result.blobLifecycle.revokedCleanly, true, 'Revoked Blob URL must reject subsequent reads');
  assert.equal(result.cancelResult.terminatedCleanly, true, 'Worker must terminate cleanly on cancel');
  assert.equal(result.cancelResult.lateMessagesAfterTerminate, 0, 'Zero late messages after terminate');
  assert.ok(
    result.guardChecks.every(g => g.rejected && g.matchedExpectedCode),
    'All XLSX representability guard checks must reject with expected code'
  );

  const xlsxBytes = new Uint8Array(Buffer.from(result.xlsxBase64, 'base64'));
  const zipBytes = new Uint8Array(Buffer.from(result.zipBase64, 'base64'));

  const chromeXlsxPath = resolve(artifactsDir, 'chrome-worker-3tab.xlsx');
  const chromeZipPath = resolve(artifactsDir, 'chrome-worker-3tab-csv.zip');
  writeFileSync(chromeXlsxPath, xlsxBytes);
  writeFileSync(chromeZipPath, zipBytes);

  const verification = verifyArtifacts({
    xlsxBytes,
    zipBytes,
    label: 'chrome-mv3-worker'
  });

  const summary = {
    status: 'PASS',
    mode: 'chrome-mv3-worker',
    chromeExecutable: CHROME_PATH,
    extensionOrigin: result.environment.origin,
    userAgent: result.environment.userAgent,
    cspViolations: result.cspViolations.length,
    pageErrors: pageErrors.length,
    consoleErrors: consoleErrors.length,
    blobLifecycle: result.blobLifecycle,
    cancelResult: result.cancelResult,
    pageMemory: result.pageMemory,
    cdpPerformanceMetrics: perfMetrics,
    metrics: result.metrics,
    guardChecks: result.guardChecks,
    verification,
    artifacts: {
      xlsxPath: chromeXlsxPath,
      zipPath: chromeZipPath
    }
  };

  writeFileSync(resolve(artifactsDir, 'chrome-spike-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
