# Google Sheets Exporter

Chrome MV3 extension in development. The current shell builds and loads locally, shows `CONFIG_REQUIRED`, and verifies a local worker. Google sign-in and workbook export are still being implemented.

Tested tooling: Node 24.14.0, npm 11.9.0. Install from the exact lockfile:

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Load `dist/` through `chrome://extensions` → Developer mode → Load unpacked. The toolbar action opens the extension page. Sign-in is intentionally disabled in this scaffold.

The browser smoke test uses an isolated headless Chrome process with a temporary profile. Set `CHROME_PATH` if Chrome is installed elsewhere. Unavailable Chrome/tooling produces exit code 2 (pending), not a passing browser test. The reviewed run used Chrome 156 and confirmed page rendering, disabled sign-in, worker response, and no observed CSP errors.

`config/extension.example.json` contains only public placeholders. No Google Cloud project, OAuth client or Workspace tenant is configured. Configured-build manifest injection and real authentication must be completed together in the auth tasks; editing a placeholder alone does not enable export.

Execution status and commits: [docs/task-status.md](docs/task-status.md). Task cards: [tasks.md](tasks.md). Design and test strategy: [architecture.md](architecture.md), [test-plan.md](test-plan.md).

Independent synthetic spikes can also be run:

```powershell
node spikes/grid-fidelity/check-fixtures.mjs
node spikes/authorization/check-matrix.mjs
```

The isolated writer spike has separate dependencies and instructions in [spikes/browser-writers/README.md](spikes/browser-writers/README.md). Synthetic checks do not establish live Google permissions or Workspace policy behavior.
