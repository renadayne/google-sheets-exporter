/**
 * T36a Real MV3 Dedicated Module Worker Writer Smoke Harness Runner
 *
 * Exercises root writer modules in an actual Chrome MV3 page + locally bundled
 * dedicated ES module Worker under strict script-src 'self' without unsafe-eval.
 *
 * Supports --build-only for offline packaging verification without Chrome execution.
 * When Chrome executable is not accessible in the sandbox environment, logs pending
 * status and exits with status 2 for tech lead execution on host.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { build } from 'vite';
import { parseZipArchive } from '../helpers/zip-reader.ts';
import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';
import { XMLParser } from 'fast-xml-parser';
import { isExportReport, isJsonExportDocument } from '../../src/contracts/validation.ts';

const buildOnly = process.argv.includes('--build-only');
const isBridge = process.argv.includes('--bridge');
const isClient = process.argv.includes('--client');

if (isBridge && isClient) {
  console.error('[T36a E2E] Flags --bridge and --client are mutually exclusive.');
  process.exit(1);
}

const workspaceRoot = resolve(import.meta.dirname, '../..');
const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const runDir = resolve(workspaceRoot, '.local/writer-browser-smoke', runId);
const outDir = resolve(runDir, 'dist');
const profileDir = resolve(runDir, 'profile');
const downloadsDir = resolve(runDir, 'downloads');

// Security check: validate resolved paths stay strictly within workspace
const relOut = relative(workspaceRoot, outDir);
const relProfile = relative(workspaceRoot, profileDir);
const relDownloads = relative(workspaceRoot, downloadsDir);
if (
  relOut.startsWith('..') || isAbsolute(relOut) ||
  relProfile.startsWith('..') || isAbsolute(relProfile) ||
  relDownloads.startsWith('..') || isAbsolute(relDownloads)
) {
  throw new Error('[T36a E2E] Target paths must resolve strictly within workspace root');
}

console.log('[T36a E2E] Workspace root:', workspaceRoot);
console.log('[T36a E2E] Target dist directory:', outDir);
console.log('[T36a E2E] Target profile directory:', profileDir);
console.log('[T36a E2E] Target downloads directory:', downloadsDir);

// 1. Check Chrome accessibility when full browser execution is required
const CHROME_PATH =
  process.env.CHROME_PATH ||
  join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe');

console.log('[T36a E2E] Chrome path candidate:', CHROME_PATH);

if (!buildOnly) {
  let chromeAccessible = false;
  try {
    chromeAccessible = existsSync(CHROME_PATH);
  } catch (err) {
    console.warn(`[T36a E2E] Chrome path check failed (${err.code || err.message}).`);
  }

  if (!chromeAccessible) {
    console.warn('[T36a E2E] PENDING BROWSER EXECUTION: Chrome executable is not accessible at path:');
    console.warn(`  ${CHROME_PATH}`);
    console.warn('  Reason: Sandbox permission boundary or file absence. Running in sandboxed offline environment.');
    console.warn('  Verification status: BROWSER_EXECUTION_PENDING');
    process.exit(2);
  }
}

// 2. Build extension bundle using installed Vite 8 API with configFile: false
console.log('[T36a E2E] Building writer smoke extension bundle with Vite...');
try {
  mkdirSync(outDir, { recursive: true });
} catch (err) {
  if (err.code === 'EPERM' || err.code === 'EACCES') {
    console.warn(`[T36a E2E] PENDING: Workspace .local write permission restricted in sandbox (${err.code}).`);
    process.exit(2);
  }
  throw err;
}

try {
  await build({
    configFile: false,
    base: './',
    root: resolve(workspaceRoot, 'tests/e2e/writer-smoke'),
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      rolldownOptions: isBridge
        ? { input: resolve(workspaceRoot, 'tests/e2e/writer-smoke/bridge.html') }
        : isClient
          ? { input: resolve(workspaceRoot, 'tests/e2e/writer-smoke/client.html') }
          : undefined
    },
    worker: {
      format: 'es'
    }
  });
} catch (buildErr) {
  if (buildErr.code === 'EPERM' || buildErr.code === 'EACCES') {
    console.warn(`[T36a E2E] PENDING: Vite build failed due to sandbox filesystem permission (${buildErr.code}).`);
    process.exit(2);
  }
  throw buildErr;
}

// 3. Write the minimal strict-CSP fixture manifest.
const manifest = {
  manifest_version: 3,
  name: 'writer-browser-smoke',
  version: '0.1.0',
  description: 'Smoke test harness for root writer modules in dedicated worker',
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; worker-src 'self'"
  }
};

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
console.log('[T36a E2E] Manifest V3 generated successfully.');

if (buildOnly) {
  console.log('[T36a E2E] --build-only requested. Build completed successfully.');
  process.exit(0);
}

let chromium = null;
try {
  const pw = await import('playwright-core');
  chromium = pw.chromium;
} catch (e) {
  console.warn('[T36a E2E] PENDING: playwright-core could not be resolved:', e.message);
  process.exit(2);
}

let browser = null;
const previousTemp = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR'].map(key => [key, process.env[key]]));
let executionDeadline = 0;
function remainingMs(max = 15000) {
  const ms = executionDeadline - Date.now();
  if (ms <= 0) throw new Error('Writer smoke execution deadline exceeded');
  return Math.min(max, ms);
}
function bounded(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}
const pending = new Map();
let nextMsgId = 1;
const pageErrors = [];
const consoleErrors = [];

try {
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(downloadsDir, { recursive: true });

  // Playwright's ordinary launch exposes the browser-level CDP loader. Redirect
  // its generated profile/artifact temp directories into this owned workspace.
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = profileDir;
  executionDeadline = Date.now() + 60000;
  browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: ['--headless=new', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check'],
    timeout: remainingMs(15000),
    downloadsPath: downloadsDir
  });
  console.log('[T36a E2E] Chrome:', browser.version(), 'Node:', process.versions.node);
  const browserCdp = await bounded(browser.newBrowserCDPSession(), remainingMs(5000), 'Browser CDP timeout');
  const sendBrowser = (method, params = {}) =>
    bounded(browserCdp.send(method, params), remainingMs(5000), 'Browser CDP command timeout');
  const commandLine = await sendBrowser('Browser.getBrowserCommandLine');
  const profileArg = commandLine.arguments.find(arg => arg.startsWith('--user-data-dir='));
  assert.ok(profileArg, 'Owned Chrome profile argument must be observable');
  const actualProfile = resolve(profileArg.slice('--user-data-dir='.length));
  const profileRelative = relative(profileDir, actualProfile);
  assert.ok(profileRelative && !profileRelative.startsWith('..') && !isAbsolute(profileRelative),
    'Generated Chrome profile must stay inside the owned workspace temp directory');
  const { id: extensionId } = await sendBrowser('Extensions.loadUnpacked', { path: outDir });
  assert.ok(extensionId, 'Extensions.loadUnpacked must return the actual extension ID');
  const { targetId } = await sendBrowser('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await sendBrowser('Target.attachToTarget', { targetId, flatten: false });
  browserCdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const msg = JSON.parse(event.message);
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.text || 'Runtime.exceptionThrown');
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push(msg.params?.args?.map(a => a.value ?? a.description).join(' '));
    }
  });

  function sendToTarget(method, params = {}, timeoutMs = 15000) {
    timeoutMs = remainingMs(timeoutMs);
    const id = nextMsgId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`Page command timed out: ${method}`));
      }, timeoutMs);
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

  // Observers enabled BEFORE page script executes
  await sendToTarget('Page.enable');
  await sendToTarget('Runtime.enable');
  await sendToTarget('Security.enable').catch(() => {});

  // Navigate to extension page after observers are armed
  const pageFile = isBridge ? 'bridge.html' : isClient ? 'client.html' : 'index.html';
  const pageUrl = `chrome-extension://${extensionId}/${pageFile}`;
  console.log(`[T36a E2E] Navigating target to smoke extension page: ${pageUrl}`);
  await sendToTarget('Page.navigate', { url: pageUrl });

  console.log('[T36a E2E] Waiting for dedicated worker smoke execution to complete (60s absolute deadline)...');
  const overallDeadline = executionDeadline;
  let smokeResult = null;

  while (Date.now() < overallDeadline) {
    const remainingTime = overallDeadline - Date.now();
    if (remainingTime <= 0) break;
    const evalTimeout = Math.min(5000, remainingTime);

    let evalRes = null;
    try {
      evalRes = await sendToTarget('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__WRITER_SMOKE__ || null)',
        returnByValue: true
      }, evalTimeout);
    } catch {
      // Evaluation transient retry
    }

    const val = evalRes?.result?.value;
    if (val) {
      const parsed = JSON.parse(val);
      if (parsed && parsed.done) {
        smokeResult = parsed;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  assert.ok(smokeResult, 'window.__WRITER_SMOKE__ must complete within 60s absolute deadline');
  assert.equal(smokeResult.error, null, `Worker smoke test failed with error: ${smokeResult.error}`);

  // Query CSP violations, page runtime exceptions, and ALL page console errors
  assert.equal(smokeResult.cspViolations.length, 0, `CSP violations observed: ${JSON.stringify(smokeResult.cspViolations)}`);
  assert.equal(smokeResult.pageErrors.length, 0, `Page errors encountered: ${smokeResult.pageErrors.join('; ')}`);
  assert.equal(pageErrors.length, 0, `CDP runtime exceptions: ${pageErrors.join('; ')}`);
  assert.equal(consoleErrors.length, 0, `Page console errors observed: ${consoleErrors.join('; ')}`);

  console.log('[T36a E2E] Observed page console and runtime errors: 0.');
  console.log('[T36a E2E] Note: Dedicated worker runs in worker thread context; worker error events (onerror, onmessageerror) verified 0; page target CDP observes page runtime/console.');

  if (isBridge) {
    console.log('[T36a E2E] production worker sender detachment telemetry unavailable; host native structuredClone checked separately');
    assert.equal(smokeResult.transferredBufferByteLengths, undefined, 'transferredBufferByteLengths must be omitted in bridge mode');
    assert.ok(smokeResult.bridge, 'bridge telemetry must be reported');
    assert.deepEqual(smokeResult.bridge, {
      commands: 20,
      acks: 16,
      progress: 4,
      staged: 3,
      errors: 1,
      unexpected: 0
    });
  } else if (isClient) {
    console.log('[T36a E2E] production worker client sender detachment telemetry unavailable; host native structuredClone checked separately');
    assert.equal(smokeResult.transferredBufferByteLengths, undefined, 'transferredBufferByteLengths must be omitted in client mode');
    assert.ok(smokeResult.bridge, 'bridge telemetry must be reported');
    assert.deepEqual(smokeResult.bridge, {
      commands: 20,
      acks: 16,
      progress: 4,
      staged: 3,
      errors: 1,
      unexpected: 0
    });
    assert.ok(smokeResult.client, 'client telemetry must be reported in client mode');
    assert.deepEqual(smokeResult.client, {
      workersCreated: 4,
      workersTerminated: 4,
      progressCallbacks: 4
    });
  } else {
    // Genuine native transfer detachment observation: exactly four zeros
    assert.ok(Array.isArray(smokeResult.transferredBufferByteLengths), 'transferredBufferByteLengths must be reported');
    assert.deepEqual(
      smokeResult.transferredBufferByteLengths,
      [0, 0, 0, 0],
      'All 4 transferred ArrayBuffers must have byteLength == 0 after postMessage transfer'
    );
  }

  // Negative test: verify FORMAT_SERIALIZATION_FAILED was caught on coverage gap
  assert.ok(smokeResult.negativeResult, 'Negative test result must be reported');
  assert.equal(
    smokeResult.negativeResult.caughtErrorCode,
    'FORMAT_SERIALIZATION_FAILED',
    'Incomplete chunk coverage must fail with FORMAT_SERIALIZATION_FAILED'
  );

  // Shared test definitions for independent verification
  const scope30 = { sheetId: 30, r0: 2, c0: 1, r1: 5, c1: 4 };
  const scope10 = { sheetId: 10, r0: 0, c0: 0, r1: 2, c1: 2 };
  const scope20 = { sheetId: 20, r0: 0, c0: 0, r1: 3, c1: 3 };

  // Independent verification 1: JSON Export
  assert.ok(smokeResult.jsonArtifact, 'JSON artifact must be returned');
  const jsonBytes = Buffer.from(smokeResult.jsonArtifact.base64, 'base64');
  assert.equal(smokeResult.jsonArtifact.filename, 'Smoke Test Workbook.json');
  assert.equal(smokeResult.jsonArtifact.mimeType, 'application/json');
  assert.equal(smokeResult.jsonArtifact.byteLength, jsonBytes.length);

  const jsonDoc = JSON.parse(jsonBytes.toString('utf-8'));
  assert.ok(isJsonExportDocument(jsonDoc), 'JSON document must validate with isJsonExportDocument');

  assert.equal(jsonDoc.schemaVersion, '1.0');
  assert.deepEqual(jsonDoc.source, {
    id: 'smoke-test-source',
    title: 'Smoke Test Workbook',
    locale: 'en',
    timeZone: 'UTC'
  });
  assert.deepEqual(jsonDoc.export, {
    startedAt: '2026-11-02T00:00:00.000Z',
    producedAt: '2026-11-02T00:00:01.000Z',
    mode: 'formula_text',
    format: 'json',
    visibility: 'include_all',
    complete: true,
    consistency: 'not_atomic_no_change_detected',
    warnings: []
  });
  assert.deepEqual(jsonDoc.selectedScopes, [
    { sheetId: 30, rect: scope30 },
    { sheetId: 10, rect: scope10 },
    { sheetId: 20, rect: scope20 }
  ]);
  assert.deepEqual(jsonDoc.sheetOrder, [30, 10, 20]);
  assert.equal(jsonDoc.limitsVersion, '1.0');
  assert.deepEqual(jsonDoc.exclusions, []);
  assert.deepEqual(jsonDoc.nameMappings, [
    { sheetId: 30, originalTitle: 'Input/Data', exportedName: 'Input/Data' },
    { sheetId: 10, originalTitle: 'EmptyTab', exportedName: 'EmptyTab' },
    { sheetId: 20, originalTitle: 'Summary:Final', exportedName: 'Summary:Final' }
  ]);

  // Validate EVERY full cell object in all 3 sheets
  assert.equal(jsonDoc.sheets.length, 3);

  // Tab 1: Sheet 30
  assert.deepEqual(jsonDoc.sheets[0], {
    id: 30,
    title: 'Input/Data',
    index: 0,
    scope: scope30,
    visibility: { mode: 'include_all', excludedRows: [], excludedColumns: [] },
    cells: [
      { r: 2, c: 1, kind: 'string', value: 'Unicode: \u00e9 \u{1F31F}' },
      { r: 2, c: 2, kind: 'number', value: 45678.5, numberFormatType: 'DATE_TIME' },
      { r: 2, c: 3, kind: 'string', value: '=HYPERLINK("http://evil.com")', formulaText: '=HYPERLINK("http://evil.com")' },
      { r: 3, c: 1, kind: 'string', value: 'Literal _x000D_ test' },
      { r: 3, c: 2, kind: 'string', value: 'Line1\r\nLine2' },
      { r: 4, c: 2, kind: 'boolean', value: true }
    ]
  });

  // Tab 2: Sheet 10 (blank tab)
  assert.deepEqual(jsonDoc.sheets[1], {
    id: 10,
    title: 'EmptyTab',
    index: 1,
    scope: scope10,
    visibility: { mode: 'include_all', excludedRows: [], excludedColumns: [] },
    cells: []
  });

  // Tab 3: Sheet 20
  assert.deepEqual(jsonDoc.sheets[2], {
    id: 20,
    title: 'Summary:Final',
    index: 2,
    scope: scope20,
    visibility: { mode: 'include_all', excludedRows: [], excludedColumns: [] },
    cells: [
      { r: 0, c: 0, kind: 'string', value: 'Summary Title' },
      { r: 1, c: 1, kind: 'number', value: 100 },
      { r: 2, c: 2, kind: 'string', value: '=SUM(A1:B2)', formulaText: '=SUM(A1:B2)' }
    ]
  });

  // Independent verification 2: CSV Multi-tab ZIP archive
  assert.ok(Array.isArray(smokeResult.csvArtifacts) && smokeResult.csvArtifacts.length === 1);
  const csvZipBytes = Buffer.from(smokeResult.csvArtifacts[0].base64, 'base64');
  assert.equal(smokeResult.csvArtifacts[0].filename, 'Smoke Test Workbook.zip');
  assert.equal(smokeResult.csvArtifacts[0].mimeType, 'application/zip');
  assert.equal(smokeResult.csvArtifacts[0].byteLength, csvZipBytes.length);

  const csvZipEntries = parseZipArchive(csvZipBytes);
  assert.equal(csvZipEntries.length, 4, 'CSV ZIP must contain 3 sheet CSVs + manifest.json');
  assert.deepEqual(
    csvZipEntries.map(e => e.filename),
    ['Input_Data.csv', 'EmptyTab.csv', 'Summary_Final.csv', 'manifest.json']
  );

  // Full deepEqual rows for Sheet 30 CSV (including apostrophe-prefixed formula)
  const s30CsvRows = parse(Buffer.from(csvZipEntries[0].data), { bom: true, record_delimiter: '\r\n' });
  assert.deepEqual(s30CsvRows, [
    ['Unicode: \u00e9 \u{1F31F}', '45678.5', '\'=HYPERLINK("http://evil.com")'],
    ['Literal _x000D_ test', 'Line1\r\nLine2', ''],
    ['', 'TRUE', '']
  ]);

  // Full deepEqual rows for Sheet 10 (blank tab) CSV: 2 rows x 2 cols
  const s10CsvRows = parse(Buffer.from(csvZipEntries[1].data), { bom: true, record_delimiter: '\r\n' });
  assert.deepEqual(s10CsvRows, [
    ['', ''],
    ['', '']
  ]);

  // Full deepEqual rows for Sheet 20 CSV: 3 rows x 3 cols (including apostrophe-prefixed formula)
  const s20CsvRows = parse(Buffer.from(csvZipEntries[2].data), { bom: true, record_delimiter: '\r\n' });
  assert.deepEqual(s20CsvRows, [
    ['Summary Title', '', ''],
    ['', '100', ''],
    ['', '', '\'=SUM(A1:B2)']
  ]);

  // Verify manifest.json in CSV ZIP with isExportReport and full expected report fields
  const manifestData = JSON.parse(Buffer.from(csvZipEntries[3].data).toString('utf-8'));
  assert.ok(isExportReport(manifestData), 'manifest.json must validate as valid ExportReport');
  assert.equal(manifestData.schemaVersion, '1.0');
  assert.deepEqual(manifestData.source, {
    id: 'smoke-test-source',
    title: 'Smoke Test Workbook',
    locale: 'en',
    timeZone: 'UTC'
  });
  assert.deepEqual(manifestData.export, {
    startedAt: '2026-11-02T00:00:00.000Z',
    producedAt: '2026-11-02T00:00:01.000Z',
    mode: 'formula_text',
    format: 'csv',
    visibility: 'include_all',
    complete: true,
    consistency: 'not_atomic_no_change_detected',
    warnings: [
      {
        code: 'CSV_TEXT_ESCAPED',
        message: 'Some source strings were prefixed for CSV safety. JSON preserves original values.'
      }
    ]
  });
  assert.deepEqual(manifestData.selectedScopes, [
    { sheetId: 30, rect: scope30 },
    { sheetId: 10, rect: scope10 },
    { sheetId: 20, rect: scope20 }
  ]);
  assert.deepEqual(manifestData.sheetOrder, [30, 10, 20]);
  assert.equal(manifestData.limitsVersion, '1.0');
  assert.deepEqual(manifestData.exclusions, []);
  assert.deepEqual(manifestData.nameMappings, [
    { sheetId: 30, originalTitle: 'Input/Data', exportedName: 'Input_Data.csv' },
    { sheetId: 10, originalTitle: 'EmptyTab', exportedName: 'EmptyTab.csv' },
    { sheetId: 20, originalTitle: 'Summary:Final', exportedName: 'Summary_Final.csv' }
  ]);
  assert.deepEqual(manifestData.csvTransformCounts, {
    policy: 'apostrophe_prefix_v1',
    totalTransformedCells: 2,
    bySheet: [
      { sheetId: 30, transformedCells: 1 },
      { sheetId: 10, transformedCells: 0 },
      { sheetId: 20, transformedCells: 1 }
    ]
  });

  // Independent verification 3: XLSX Primary Workbook + Companion Report
  assert.ok(Array.isArray(smokeResult.xlsxArtifacts) && smokeResult.xlsxArtifacts.length === 2);
  const xlsxBytes = Buffer.from(smokeResult.xlsxArtifacts[0].base64, 'base64');
  const companionBytes = Buffer.from(smokeResult.xlsxArtifacts[1].base64, 'base64');

  assert.equal(smokeResult.xlsxArtifacts[0].filename, 'Smoke Test Workbook.xlsx');
  assert.equal(smokeResult.xlsxArtifacts[0].mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(smokeResult.xlsxArtifacts[0].byteLength, xlsxBytes.length);

  assert.equal(smokeResult.xlsxArtifacts[1].filename, 'Smoke Test Workbook.metadata.json');
  assert.equal(smokeResult.xlsxArtifacts[1].mimeType, 'application/json');
  assert.equal(smokeResult.xlsxArtifacts[1].byteLength, companionBytes.length);

  // Verify companion metadata JSON report
  const companionReport = JSON.parse(companionBytes.toString('utf-8'));
  assert.ok(isExportReport(companionReport), 'XLSX companion report must validate as ExportReport');
  assert.equal(companionReport.schemaVersion, '1.0');
  assert.deepEqual(companionReport.source, {
    id: 'smoke-test-source',
    title: 'Smoke Test Workbook',
    locale: 'en',
    timeZone: 'UTC'
  });
  assert.deepEqual(companionReport.export, {
    startedAt: '2026-11-02T00:00:00.000Z',
    producedAt: '2026-11-02T00:00:01.000Z',
    mode: 'formula_text',
    format: 'xlsx',
    visibility: 'include_all',
    complete: true,
    consistency: 'not_atomic_no_change_detected',
    warnings: []
  });
  assert.deepEqual(companionReport.selectedScopes, [
    { sheetId: 30, rect: scope30 },
    { sheetId: 10, rect: scope10 },
    { sheetId: 20, rect: scope20 }
  ]);
  assert.deepEqual(companionReport.sheetOrder, [30, 10, 20]);
  assert.equal(companionReport.limitsVersion, '1.0');
  assert.deepEqual(companionReport.exclusions, []);
  assert.deepEqual(companionReport.nameMappings, [
    { sheetId: 30, originalTitle: 'Input/Data', exportedName: 'Input_Data' },
    { sheetId: 10, originalTitle: 'EmptyTab', exportedName: 'EmptyTab' },
    { sheetId: 20, originalTitle: 'Summary:Final', exportedName: 'Summary_Final' }
  ]);

  // Verify XLSX workbook using SheetJS with exact 0-indexed to Excel coordinate mapping
  const wb = XLSX.read(xlsxBytes, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Input_Data', 'EmptyTab', 'Summary_Final']);

  // Tab 1 SheetJS cell values at correct Excel coordinates (0-indexed: r2,c1=B3; r2,c2=C3; r2,c3=D3; r3,c1=B4; r3,c2=C4; r4,c2=C5)
  const ws30 = wb.Sheets['Input_Data'];
  // B3 Unicode
  assert.equal(ws30['B3']?.v, 'Unicode: \u00e9 \u{1F31F}');
  assert.equal(ws30['B3']?.t, 's');
  assert.equal(ws30['B3']?.f, undefined, 'B3 must not have formula node');
  assert.equal(ws30['B3']?.l, undefined, 'B3 must not have hyperlink');

  // C3 Date Serial
  assert.equal(ws30['C3']?.v, 45678.5);
  assert.equal(ws30['C3']?.t, 'n');
  assert.equal(ws30['C3']?.f, undefined, 'C3 must not have formula node');
  assert.equal(ws30['C3']?.l, undefined, 'C3 must not have hyperlink');

  // D3 Formula Text (stored inert as scalar string)
  assert.equal(ws30['D3']?.v, '=HYPERLINK("http://evil.com")');
  assert.equal(ws30['D3']?.t, 's');
  assert.equal(ws30['D3']?.f, undefined, 'D3 must not have formula node');
  assert.equal(ws30['D3']?.l, undefined, 'D3 must not have hyperlink');

  // B4 Literal _x000D_ test
  assert.equal(ws30['B4']?.v, 'Literal _x000D_ test');
  assert.equal(ws30['B4']?.t, 's');
  assert.equal(ws30['B4']?.f, undefined, 'B4 must not have formula node');
  assert.equal(ws30['B4']?.l, undefined, 'B4 must not have hyperlink');

  // C4 CRLF
  // SheetJS normalizes CRLF; the independent ST_Xstring oracle below asserts original CRLF.
  assert.equal(ws30['C4']?.v, 'Line1\nLine2');
  assert.equal(ws30['C4']?.t, 's');
  assert.equal(ws30['C4']?.f, undefined, 'C4 must not have formula node');
  assert.equal(ws30['C4']?.l, undefined, 'C4 must not have hyperlink');

  // C5 Boolean
  assert.equal(ws30['C5']?.v, true);
  assert.equal(ws30['C5']?.t, 'b');
  assert.equal(ws30['C5']?.f, undefined, 'C5 must not have formula node');
  assert.equal(ws30['C5']?.l, undefined, 'C5 must not have hyperlink');

  // Tab 2: Blank tab empty
  const ws10 = wb.Sheets['EmptyTab'];
  assert.ok(ws10, 'Blank tab must exist');
  assert.deepEqual(Object.keys(ws10).filter(key => !key.startsWith('!')), [], 'Blank tab must have no data cells');

  // Tab 3: Sheet 20 (0-indexed: r0,c0=A1; r1,c1=B2; r2,c2=C3)
  const ws20 = wb.Sheets['Summary_Final'];
  // A1 Title
  assert.equal(ws20['A1']?.v, 'Summary Title');
  assert.equal(ws20['A1']?.t, 's');
  assert.equal(ws20['A1']?.f, undefined, 'A1 must not have formula node');
  assert.equal(ws20['A1']?.l, undefined, 'A1 must not have hyperlink');

  // B2 Number
  assert.equal(ws20['B2']?.v, 100);
  assert.equal(ws20['B2']?.t, 'n');
  assert.equal(ws20['B2']?.f, undefined, 'B2 must not have formula node');
  assert.equal(ws20['B2']?.l, undefined, 'B2 must not have hyperlink');

  // C3 Formula (stored inert as scalar string)
  assert.equal(ws20['C3']?.v, '=SUM(A1:B2)');
  assert.equal(ws20['C3']?.t, 's');
  assert.equal(ws20['C3']?.f, undefined, 'C3 must not have formula node');
  assert.equal(ws20['C3']?.l, undefined, 'C3 must not have hyperlink');

  // XML inspection: workbook, all worksheets, and relationship files
  const xlsxZipEntries = parseZipArchive(xlsxBytes);
  let sharedStringsXmlText = '';
  let workbookXmlText = '';
  const worksheetXmlTexts = [];

  for (const entry of xlsxZipEntries) {
    if (entry.filename === 'xl/workbook.xml') {
      workbookXmlText = Buffer.from(entry.data).toString('utf-8');
      assert.ok(!/<f[\s/>]/i.test(workbookXmlText), 'xl/workbook.xml must not contain formula <f>');
      assert.ok(!/<externalReference[\s/>]/i.test(workbookXmlText), 'xl/workbook.xml must not contain externalReference');
    } else if (entry.filename.startsWith('xl/worksheets/sheet') && entry.filename.endsWith('.xml')) {
      const xml = Buffer.from(entry.data).toString('utf-8');
      worksheetXmlTexts.push({ name: entry.filename, xml });
      assert.ok(!/<f[\s/>]/i.test(xml), `Worksheet ${entry.filename} must not contain formula node <f>`);
      assert.ok(!/<hyperlink[\s/>]/i.test(xml), `Worksheet ${entry.filename} must not contain hyperlink node`);
      assert.ok(!/<externalReference[\s/>]/i.test(xml), `Worksheet ${entry.filename} must not contain externalReference`);
    } else if (entry.filename.endsWith('.rels')) {
      const xml = Buffer.from(entry.data).toString('utf-8');
      assert.ok(!/TargetMode="External"/i.test(xml), `Relationships ${entry.filename} must not contain TargetMode="External"`);
    } else if (entry.filename === 'xl/sharedStrings.xml') {
      sharedStringsXmlText = Buffer.from(entry.data).toString('utf-8');
    }
  }

  assert.ok(workbookXmlText.length > 0, 'xl/workbook.xml must exist');
  assert.equal(worksheetXmlTexts.length, 3, 'Must contain 3 worksheet XML files');
  assert.ok(sharedStringsXmlText.length > 0, 'xl/sharedStrings.xml must exist in XLSX');

  // XML ST_Xstring one-pass check for exact original CRLF and literal _x000D_
  const xmlParserStrict = new XMLParser({
    ignoreAttributes: false,
    trimValues: false,
    parseTagValue: false
  });
  const sstXml = xmlParserStrict.parse(sharedStringsXmlText);
  const siEntries = Array.isArray(sstXml.sst.si) ? sstXml.sst.si : [sstXml.sst.si];

  function decodeOoxmlString(s) {
    return s.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  }

  const decodedSstStrings = siEntries.map(si => {
    const t = si.t;
    const raw = typeof t === 'string' ? t : (t?.['#text'] ?? '');
    return decodeOoxmlString(raw);
  });

  assert.ok(decodedSstStrings.includes('Literal _x000D_ test'), 'SST must preserve literal _x000D_');
  assert.ok(decodedSstStrings.includes('Line1\r\nLine2'), 'SST must preserve exact original CRLF');
  assert.ok(decodedSstStrings.includes('=HYPERLINK("http://evil.com")'), 'Formula must be stored as inert scalar string');
  assert.ok(decodedSstStrings.includes('=SUM(A1:B2)'), 'Formula must be stored as inert scalar string');

  console.log('[T36a E2E] Output oracles verified; closing the owned browser.');
  console.log(`[T36a E2E] Formats verified: JSON (${jsonBytes.length}B), CSV ZIP (${csvZipBytes.length}B, 3 tabs), XLSX (${xlsxBytes.length}B, 3 tabs) + companion report (${companionBytes.length}B).`);
  if (isBridge) {
    console.log('[T36a E2E] Production worker bridge verified: 20 commands, 16 ACKs, 4 PROGRESS, 3 STAGED, 1 ERROR, 0 unexpected.');
  } else if (isClient) {
    console.log('[T36a E2E] Production worker client verified: 4 workers created/terminated, 4 progress callbacks, 20 commands, 16 ACKs, 4 PROGRESS, 3 STAGED, 1 ERROR, 0 unexpected.');
  } else {
    console.log('[T36a E2E] Native transfer observation: 4 buffers detached ([0, 0, 0, 0]).');
  }
  console.log('[T36a E2E] Negative test verified: caught FORMAT_SERIALIZATION_FAILED on coverage gap.');
  console.log('[T36a E2E] Zero CSP violations, zero page/console errors, inert formulas confirmed.');
} finally {
  // Teardown: cancel all pending CDP command timers
  for (const [id, entry] of pending.entries()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('Runner teardown'));
  }
  pending.clear();

  try {
    if (browser) await bounded(browser.close(), 5000, 'Owned browser close timeout');
  } finally {
    for (const [key, value] of Object.entries(previousTemp)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
console.log('[T36a E2E] SUCCESS: independent writer oracles and owned browser teardown passed.');
process.exitCode = 0;
