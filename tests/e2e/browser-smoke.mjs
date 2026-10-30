import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME_PATH =
  process.env.CHROME_PATH ||
  join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe');

const distDir = resolve(import.meta.dirname, '../../dist');

console.log('[T07 E2E] Target dist directory:', distDir);
console.log('[T07 E2E] Chrome path candidate:', CHROME_PATH);

if (!existsSync(distDir)) {
  console.error('[T07 E2E] ERROR: dist directory does not exist. Run "npm run build" first.');
  process.exit(1);
}

const manifestPath = join(distDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('[T07 E2E] ERROR: dist/manifest.json not found.');
  process.exit(1);
}

let chromeAccessible = false;
try {
  chromeAccessible = existsSync(CHROME_PATH);
} catch (err) {
  console.warn(`[T07 E2E] Chrome path check failed (${err.code || err.message}).`);
}

if (!chromeAccessible) {
  console.warn('[T07 E2E] PENDING BROWSER EXECUTION: Chrome executable is not accessible at path:');
  console.warn(`  ${CHROME_PATH}`);
  console.warn('  Reason: Sandbox permission boundary or file absence. Running in sandboxed offline environment.');
  console.warn('  Verification status: BROWSER_SMOKE_PENDING_APPROVAL');
  // Exit with explicit nonzero status (exit 2) for pending/unavailable browser
  process.exit(2);
}

let chromium = null;
try {
  const pw = await import('playwright-core');
  chromium = pw.chromium;
} catch (e) {
  console.warn('[T07 E2E] PENDING: playwright-core could not be resolved from local dependencies:', e.message);
  process.exit(2);
}

let browser = null;
try {
  // Proven spike loader: chromium.launch creates a fresh temporary profile automatically
  browser = await chromium.launch({
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

  const browserCdp = await browser.newBrowserCDPSession();
  const { id: extensionId } = await browserCdp.send('Extensions.loadUnpacked', {
    path: distDir
  });

  assert.ok(extensionId, 'Extensions.loadUnpacked must return extensionId');
  console.log(`[T07 E2E] Unpacked extension loaded with ID: ${extensionId}`);

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
        rej(new Error(`Page command timed out: ${method}`));
      }, 10000);
      pending.set(id, { resolve: res, reject: rej, timer });
      browserCdp.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method, params })
      }).catch(err => {
        clearTimeout(timer);
        pending.delete(id);
        rej(err);
      });
    });
  }

  await sendToPage('Runtime.enable');
  await sendToPage('Security.enable').catch(() => {});

  // Observe and capture any CSP violations in the extension page
  await sendToPage('Runtime.evaluate', {
    expression: `
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({
          blockedURI: e.blockedURI,
          violatedDirective: e.violatedDirective,
          effectiveDirective: e.effectiveDirective
        });
      });
    `
  });

  // Bounded poll for deterministic smoke result (max 10s: 50 * 200ms)
  let smokeResult = null;
  const maxAttempts = 50;
  for (let i = 0; i < maxAttempts; i++) {
    const evalRes = await sendToPage('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__T07_SMOKE__ || null)',
      returnByValue: true
    });

    const val = evalRes?.result?.value;
    if (val) {
      const parsed = JSON.parse(val);
      if (parsed && parsed.done) {
        smokeResult = parsed;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }

  assert.ok(smokeResult, 'window.__T07_SMOKE__ must complete within bounded wait');
  assert.equal(smokeResult.configStatus, 'CONFIG_REQUIRED', 'Unconfigured build must show CONFIG_REQUIRED');
  assert.equal(smokeResult.isConfigured, false, 'Unconfigured build isConfigured must be false');
  assert.equal(smokeResult.signInDisabled, true, 'Sign-in button must be disabled in unconfigured scaffold');
  assert.ok(smokeResult.workerPong, 'Worker smoke pong must be received');
  assert.equal(smokeResult.workerPong.echo, 'PONG:smoke-ping-1');

  // Query DOM for sign-in button state
  const btnEval = await sendToPage('Runtime.evaluate', {
    expression: 'document.getElementById("btn-signin")?.disabled',
    returnByValue: true
  });
  assert.equal(btnEval?.result?.value, true, 'Sign-in button DOM element must be disabled');

  // Query DOM for CSP violations
  const cspEval = await sendToPage('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__cspViolations || [])',
    returnByValue: true
  });
  const cspViolations = JSON.parse(cspEval?.result?.value || '[]');
  assert.equal(cspViolations.length, 0, `CSP violations observed: ${JSON.stringify(cspViolations)}`);

  const cspConsoleErrors = consoleErrors.filter(e => /content security policy|csp|violates/i.test(e));
  assert.equal(cspConsoleErrors.length, 0, `CSP console errors observed: ${cspConsoleErrors.join('; ')}`);
  assert.equal(pageErrors.length, 0, `Page errors encountered: ${pageErrors.join(', ')}`);
  assert.equal(consoleErrors.length, 0, `Console errors encountered: ${consoleErrors.join(', ')}`);

  console.log('[T07 E2E] SUCCESS: Chrome extension loaded, export.html rendered, CONFIG_REQUIRED verified, sign-in disabled, zero CSP violations, worker smoke pong verified.');
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
}
