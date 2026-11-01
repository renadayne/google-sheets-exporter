# Writer dependency review

Checked 2026-11-01 UTC. Offline implementation evidence; release security review remains pending.

Root runtime candidates are pinned to ExcelJS 4.4.0 and fflate 0.8.3. Independent test readers are dev-only: fast-xml-parser 5.11.2, csv-parse 5.6.0 and SheetJS 0.20.3. SheetJS uses the versioned tarball URL documented by its [official installation guide](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/), with lockfile integrity. The older isolated browser spike has its own dependency tree and is not covered by these root updates.

## fflate patch check

The [ZIP64 advisory](https://github.com/advisories/GHSA-px8p-9vwx-vf98) lists 0.8.3 as patched. Before updating the root installation, an isolated 0.8.3 candidate was compared with root 0.8.2 using the browser ESM entry points under Node 24.14.0:

- Four synthetic entries: `Data.csv`, `Empty.csv`, `Offset.csv`, `manifest.json`; fixed ZIP timestamp.
- Independent central-directory parsing and Node `zlib.inflateRawSync` recovered the exact expected names and payloads for both archives.
- The two archives were byte-identical at 503 bytes for this fixture only.
- A malformed ZIP64 sentinel fixture without its extra field terminated in a bounded child process. It did **not** reject the fixture; termination is the checked property.

Machine-local patch scripts/results remain ignored under `.local/`; this is a recorded manual check, not a committed CI regression. T36a now verifies updated root writer encoding in a real Chrome MV3 module Worker, including independent native ZIP/CSV oracles; see [root writer browser evidence](root-writer-browser.md). Wider ZIP corpus and malformed-ZIP64 browser decoder checks remain pending. No universal compatibility or malformed-archive rejection claim follows.

## Remaining audit findings

After pinning fflate 0.8.3, `npm audit --omit=dev --json` exited 1: **9 moderate, 0 high, 0 critical** across 196 production dependency entries. fflate is no longer reported. A nonzero audit result is not a passing check.

Reported package nodes: archiver, archiver-utils, exceljs, glob, minimatch, readdir-glob, rimraf, uuid and zip-stream. These include transitive propagation of the [minimatch amplification advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249) and [uuid output-buffer bounds advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq); nine package nodes do not mean nine independent advisories. npm proposes a major ExcelJS downgrade to 3.4.0 for several findings. That downgrade was not applied without compatibility evidence.

Before release, review actual browser bundle reachability, supported upstream remediation and compatibility. No assertion that the affected paths are unreachable has been established. T43 dependency/release review, desktop reader checks and browser writer integration remain pending.
