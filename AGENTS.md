# Repository working instructions

## Task execution

- The user selected Antigravity with explicit model `gemini-3.8-flash-medium` for implementation. Do not silently use the CLI default or another model. No nested delegation.
- Codex is the tech lead: review only after the delegated task finishes, verify actual changes, then commit/push accepted steps. Implementers must not commit/push unless their task explicitly delegates that action.
- Read `docs/task-status.md`, the assigned task card in `tasks.md`, and only the relevant architecture sections/contracts. Avoid loading every planning document into each small task.
- Implement one bounded task or explicitly assigned subtask. Do not expand scope or alter a public contract to make your test pass. Report a specific blocker/change request if necessary.
- User is asleep/offline: avoid new interactive approval requests. Use existing granted permissions where available. If an action needs a fresh approval, record the exact pending action and continue independent runnable work. Do not bypass permission controls.

## Correctness and evidence

- Official API shapes and reviewed contracts are authoritative. Never invent fields, error meanings, supported modes, guarantees or account-detection capabilities. Consult primary documentation for uncertain API facts.
- Synthetic fixtures are not live API/tenant evidence. Mark unrun OAuth, IRM/DLP, reader compatibility and benchmark checks pending rather than passed.
- Current Drive restriction shape is `downloadRestrictions.effectiveDownloadRestrictionWithContext.{restrictedForReaders,restrictedForWriters}`. Do not add generic `restricted`, `type` or policy-reason fields inside that Google object.
- A successful Sheets read, OAuth consent or role label does not prove export permission. Denied/uncertain permission must not trigger another extraction path.
- Preserve absolute coordinates, selected scopes, types and meaningful text. Never compact sparse data, silently truncate, or evaluate source formulas.
- Tests need independent expected behavior. Validate every relevant oracle field; include negative cases for actual risk. A hard-coded success flag is not a check.
- Never fabricate a dependency/test framework under `node_modules` or mask missing packages with handwritten framework declarations. Use real locked dependencies; if installation is blocked, mark checks pending. Committed build configs must not reference an agent's private scratch/cache directory.

## Changes and handoff

- Keep code/data/temp files inside this workspace. Machine-specific bridge configuration and prompts are ignored under `.local/`. Do not commit credentials, private keys, real workbook contents, node_modules, browser profiles or generated artifacts.
- No global installs, account changes or cloud resource creation without an explicit task authorizing them. Local dependency installation for an assigned build task is in scope.
- Run targeted checks appropriate to the task; run broader checks only when changed behavior/failures justify them. Never describe an unrun check as passed.
- Write a concise `docs/handoffs/Txx.md`: files, exact checks/results, review corrections, pending work. Stop after your assigned task.

The current implementation plan permits offline foundation/pure-data work while live G1/G7 prerequisites remain pending. This permission does not approve a production acquisition gate or a release claim.
