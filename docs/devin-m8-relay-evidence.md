# M8 stage: offline Pi + Relay effect evidence

Date: 2026-09-26. One bounded AgentLens coding stage, **10 ACU maximum**, SWE-2 High verified in the webpage. Branch `devin/m8-relay-evidence`; create a PR and stop without merging.

## Read first

Read `PROJECT.md`, `DELIVERY.md`, `docs/m8-relay-dogfood.md`, the existing Pi importer, storage/import atomicity, inspect/diff and TUI patterns. The source contract and accepted experiment are:

- Relay main `4a08b78`, report https://github.com/mat973252/Relay/blob/main/reports/INDEPENDENT_PI_RELAY_LINK_ACCEPTANCE_2026-09-26.md
- Replay script https://github.com/mat973252/Relay/blob/main/reports/pi-relay-link-probe-2026-09-26/probe/probe.mjs
- Relay `relay effects --history --json` emits `{schema:"relay.effect-history/1", histories:[{record,events,coverage}]}` from one journal snapshot. Inspect the accepted Relay types rather than guessing fields.

## Goal and limits

Let a developer inspect an actual Pi session and its matching Relay effect evidence locally, without inventing events. Pi Run/tool normalization retains its existing documented semantics. Relay history is **separate observed evidence**, never renamed into an AgentEvent or used to fabricate Run/Step/Recovery.

The accepted association is only an exact key match: persisted tool call `actionId` and `operationId` → `${actionId}:${operationId}`, with matching MCP kind where available. It does not prove exclusive ownership or causality. A key can be reused across calls/sessions and journal has no Pi identity. Always label this distinction; do not claim bidirectional session association.

No Relay product code, live journal access, network ingestion, real provider/model service, user sessions/credentials, execution/reconcile, npm publication, web UI or unrelated refactor. Relay safety gate stays CLOSED; no Step6/7 or production trace claims. M8 stays pending independent acceptance.

## Required product behavior

1. Add optional offline evidence import for the existing Pi session import (e.g. `agentlens import <session.jsonl> --format pi --relay-history <history.json>`). Existing formats/commands remain compatible. Read local files only. Require explicit Pi format; fail clearly for incompatible options.
2. Validate the Relay export version, statuses, IDs/keys, observed transition chain/order, last observed state versus latest snapshot, and coverage semantics. Empty/legacy history remains unavailable, not backfilled. Preserve PREPARED/SUBMITTED/UNKNOWN/CONFIRMED/FAILED exactly. Reject contradictory or malformed evidence before writing.
3. Use a minimal separate evidence model/store consistent with current SQLite patterns. Save Run and attached evidence atomically. Duplicate imports, invalid sidecars and interrupted transactions must not leave partial rows. Persist source content hashes and minimal provenance. Allowlist only non-secret fields needed for effect ID/key/kind/status, transition sequence/from/to/cause/time and coverage. Never persist/export provider free-form reason, remoteRef, result payload, intent, or arbitrary sidecar extras. Do not add duplicated raw Pi arguments/results to the new evidence store.
4. Match only actual `relay_submit_action` tool-call arguments, with exact strings and existing Pi tool-call identity. No time/path/prose guessing. Show matched, unmatched or multiple candidate calls honestly. Repeated key/call reuse must not be presented as exclusive attribution; every match is ownership-unverified. Missing arguments or a mismatched kind must not link. Evidence not matched to this session stays explicitly unassociated.
5. `inspect` text/JSON and TUI Run detail must show effect latest state, observed transitions, coverage, provenance hashes and exact-match limitations. UNKNOWN must remain visible even when Pi protocol/tool result succeeded or normalized Run passed. Missing Recovery is unknown/unrecorded, not “none” or a fabricated event. Preserve original source timestamps and sequence; do not claim causal ordering from different clocks.
6. `diff` CLI/JSON and TUI must compare this evidence separately from Run/tool metrics, enough to distinguish confirmed from unknown and history unavailable from observed. No synthesized token/duration/recovery metrics. Keep existing compact TUI style, 80x24 usability and NO_COLOR behavior.
7. Document exact commands, safe input contract, provenance/normalization limitations and read-only nature. Update README/DELIVERY to stage implementation only; do not mark M8 independently accepted yourself.

## Evidence and meaningful tests

Generate actual disposable Pi session files via the accepted probe, deterministic local fake model and 127.0.0.1 provider only; export the matching offline Relay histories. Do not manufacture session JSONL or use the report's summarized entries as an original transcript. Preserve sanitized test fixtures and provenance (Relay source SHA, Pi/Node versions, script/session/export hashes, source timestamps); copying actual generated files is allowed. The fake model's reported token values are simulated, not real model measurements.

Exercise success, commit-then-503 UNKNOWN and two-calls cases. Check missing arguments, mismatched kind/key, repeated-key candidates, unassociated evidence, legacy/no events, invalid transition/last-state conflicts, unsupported version and invalid/duplicate import atomicity. Use sentinel strings in rejected/discarded free-form sidecar fields and verify none enter the new evidence table or rendered evidence. Existing Pi source payload semantics need not be changed; document that boundary.

Record input SHA-256 and mtime before and after import/inspect/diff/TUI: originals must remain unchanged. Verify existing traces without a sidecar render unchanged. Run frozen install/lint/all tests/build and npm pack + installation outside the repo. Check Ubuntu Node22/24 CI; provide actual TUI screenshots from a terminal, not mock images. Windows verification is Codex's independent gate; report honestly if unavailable.

## Stop and return

Return PR URL, exact head SHA, changed-file scope, commands/results, fixture provenance and unresolved limitations. Stop after PR. If an actual Pi session cannot be imported without inventing required facts, report that exact blocker; do not force Relay effects into a synthetic Run or silently expand this stage.
