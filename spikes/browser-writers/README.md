# Browser writer feasibility spike

Isolated synthetic-data harness, not the production extension. Node 24.14.0/npm 11.9.0 were used for the reviewed run. Dependencies are pinned in `package-lock.json`.

```powershell
npm ci --prefix spikes/browser-writers
npm --prefix spikes/browser-writers run build
npm --prefix spikes/browser-writers run spike:node
npm --prefix spikes/browser-writers run spike:chrome
```

The Chrome runner uses the installed Chrome executable. Set `CHROME_PATH` for another installation. It launches an isolated headless browser and uses `Extensions.loadUnpacked`; no personal Chrome profile or Google credentials are needed. This experimental CDP interface was tested with Chrome 156 and may differ in other versions. If a restricted sandbox cannot see the executable, the Chrome check needs execution access to the installed browser.

Generated fixtures, XLSX/ZIP outputs, browser summaries, build output and node_modules are ignored by Git. No Google data is acquired. The synthetic fixture includes A1/D50/Z90000, Unicode, inert formula text, an empty worksheet and a range starting at C5. XLSX is independently parsed with SheetJS and XML inspection; CSV is parsed with csv-parse. SheetJS is a test-only reader of our generated fixtures and must not be shipped as a production dependency or used to parse untrusted user files without a separate dependency/security review.

Limits: no Google API/permission evidence, no full-workbook memory benchmark, no desktop-reader repair-prompt or CSV formula-execution validation. Name edge cases are printed for inspection; only the main three-sheet name mapping has explicit assertions. Memory snapshots are page-only, not worker peak memory. The writer is a spike: it has no production permission/coverage gate and must not be imported into production as-is.

See `docs/evidence/browser-writers.md` for reviewed results and remaining checks.
