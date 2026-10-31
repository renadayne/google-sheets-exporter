import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../..');

async function main() {
  const validatorPath = resolve(PROJECT_ROOT, 'src/contracts/generated/validators.js');
  const code = await readFile(validatorPath, 'utf8');

  // CSP compliance check: codeGeneration strings:false, wasm:false
  const context = vm.createContext({}, {
    codeGeneration: {
      strings: false,
      wasm: false
    }
  });

  const module = new vm.SourceTextModule(code, { context });

  // Self-contained check: must have zero imports
  await module.link((specifier) => {
    throw new Error(`Forbidden external import attempted: "${specifier}"`);
  });

  await module.evaluate();

  const { validateReport, validateExport } = module.namespace;

  if (typeof validateReport !== 'function' || typeof validateExport !== 'function') {
    throw new Error('Validator module must export validateReport and validateExport functions');
  }

  // 1. Valid metadata-only report
  const metadataReport = JSON.parse(
    await readFile(resolve(PROJECT_ROOT, 'tests/fixtures/exports/metadata-report-only.json'), 'utf8')
  );
  if (validateReport(metadataReport) !== true) {
    throw new Error('validateReport failed for valid metadata-only report fixture');
  }
  if (validateExport(metadataReport) !== false) {
    throw new Error('validateExport unexpectedly passed for metadata-only report fixture');
  }

  // 2. Valid raw multi-tab export document
  const rawExportDoc = JSON.parse(
    await readFile(resolve(PROJECT_ROOT, 'tests/fixtures/exports/raw-multitab.json'), 'utf8')
  );
  if (validateExport(rawExportDoc) !== true) {
    throw new Error('validateExport failed for valid raw multi-tab export fixture');
  }
  // Metadata-only validator must reject export doc containing unevaluated sheets
  if (validateReport(rawExportDoc) !== false) {
    throw new Error('validateReport unexpectedly passed for raw multi-tab export fixture (has sheets)');
  }

  // 3. Mutated / invalid payload
  const invalidPayload = { schemaVersion: '1.0' };
  if (validateReport(invalidPayload) !== false) {
    throw new Error('validateReport unexpectedly passed for incomplete payload');
  }
  if (validateExport(invalidPayload) !== false) {
    throw new Error('validateExport unexpectedly passed for incomplete payload');
  }

  process.stdout.write(JSON.stringify({ ok: true, verifiedChecks: 6 }) + '\n');
}

main().catch((err) => {
  // Never dump validator code body on failure
  process.stderr.write(JSON.stringify({ ok: false, error: err.name, message: err.message.slice(0, 300) }) + '\n');
  process.exit(1);
});
