# Test Helpers Guide

Shared deterministic testing utilities, synthetic fixtures, and scripted fake ports for Google Sheets Exporter.

## Modules

- `deterministic.ts`: `createManualClock`, `createDeterministicRandom`, `createDeferred`, `awaitWithSignal`, and `AsyncResultQueue`.
- `fixtures.ts`: Canonical synthetic fixtures (`createCanonicalWorkbookMeta`, `createSyntheticAccountContext`, `createSyntheticPermittedEligibility`, `createCanonicalWriterContext`, etc.) and transport payload helpers.
- `fake-fetch.ts`: Scripted `fetch` replacement for HTTP transport testing.
- `fake-ports.ts`: Scripted domain port fakes (`createFakeAuthPort`, `createFakePermissionPort`, `createFakeSheetsPort`, `createFakeSourceObservationPort`, `createFakeWriterPort`, `createFakeDownloadPort`). Configure each outcome explicitly; never mix metadata and grid payloads from different fixtures.

## Fake Ports Usage

Each fake port factory returns an object implementing the exact port contract from `src/contracts/ports.ts` under strict TypeScript, along with explicit per-method `AsyncResultQueue` instances and call logs:

```ts
import { createFakePermissionPort, createFakeWriterPort } from '../helpers/fake-ports.ts';
import { createSyntheticPermittedEligibility } from '../helpers/fixtures.ts';

const perm = createFakePermissionPort();
perm.checkQueue.enqueueValue(createSyntheticPermittedEligibility());

const writer = createFakeWriterPort();
writer.beginQueue.enqueueValue(undefined);
writer.abortQueue.enqueueValue(undefined);
```

### Cancellation and Abort

- All operational methods accept `signal: AbortSignal`.
- Pre-aborted signals reject immediately with `AbortError` without consuming queue steps.
- In-flight aborts cancel pending deferreds; late results are ignored.
- `WriterPort.abort()` accepts no signal argument and remains callable after cancellation.

### Event Logging

Pass an `eventLog` array in `FakePortOptions` to observe multi-port execution order across ports (e.g. asserting that a final permission check immediately precedes download publication).

## Design Limitations

1. **AuthPort Limitation**: Fake auth never holds real Google credentials or validates refresh tokens. Stateful principal-binding verification belongs to production auth (T17); tests script outcomes explicitly with synthetic tokens and principal keys.
2. **WriterPort Limitation**: Fake writer does not execute serialization algorithms, validate export schemas, or enforce ledger completeness. Real schema verification belongs to T24/T25/T26.
3. **DownloadPort Limitation**: Fake download does not invoke browser extension APIs (`chrome.downloads`); publication decisions remain strictly under controller test authority.
4. **No Auto-Outcomes**: Unconfigured or exhausted calls fail with descriptive errors. Fakes never auto-generate permissions, workbook metadata, or completed downloads.
