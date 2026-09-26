# pi-relay fixtures — provenance

Generated 2026-09-26 by the independently accepted probe
`reports/pi-relay-link-probe-2026-09-26/probe/probe.mjs` (SHA-256
`88b3f4d3fb97e90150b9092a04692a1f300f9c7df7236e8f12a11d4674f814b7`) in the
Relay repository at main `4a08b78b6fb933b278178807e0179fb1d2f7f2f9`, with
Node `v24.19.0`, Pi `@earendil-works/pi-coding-agent` `0.87.0`, pnpm
`10.33.0`, on `linux x64`. See Relay's
`reports/INDEPENDENT_PI_RELAY_LINK_ACCEPTANCE_2026-09-26.md`.

Generation: real Pi `AgentSession` with a deterministic local fake
provider/model (reported token values are simulated, not real model
measurements) and a loopback provider bound to `127.0.0.1`; the real,
unmodified Relay MCP server committed the effects into an isolated journal.
`relay-history-*.json` are verbatim `relay effects --history --json`
(`relay.effect-history/1`) exports of those journals.

`session-*.jsonl` are the actual persisted Pi session files with only
machine-local paths sanitized (`<probe-workspace>`, `<pi-package>`); all
entries, ids, arguments and timestamps are as generated — they are not
hand-authored transcripts.

| File | SHA-256 (as committed) |
| --- | --- |
| session-success.jsonl | `43d1971970a44b2751f990fe2a0603cb035f378d88253a94b2554965c24e1332` |
| session-ambiguous.jsonl | `3bf4818bb798a7a2b12b71680b765cee002c7b4150244f8ffb4b4965c97bbeaf` |
| session-two-calls.jsonl | `8ee2ab21d7e673ee559881c7888e7cd7df68383285e95171ec9f7c8e88bbb6dc` |
| relay-history-success.json | `55b180d3edb2d48dd663e4026bcebaafddd9a76787c773793151e7636781a2ef` |
| relay-history-ambiguous.json | `df3ccf365b3e4bb016390f229051ff6aafb72e49240b042b6d21e3da7470e701` |
| relay-history-two-calls.json | `7e54a787d56c1bd263ae9655fcb9015d16d569d64b235614b4464a7e40dc1812` |

Scenarios: `success` = one `counter-increment` call ending `CONFIRMED`;
`ambiguous` = commit-then-HTTP-503 ending `UNKNOWN`; `two-calls` = two
`counter-increment` calls in one session, both `CONFIRMED`.
