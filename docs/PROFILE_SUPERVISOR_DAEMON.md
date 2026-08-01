# Profile Supervisor Daemon

The managed daemon is the production browser runtime for one 1688 Profile. It
owns one long-lived, headful PersistentContext and exposes a local framed RPC
socket. Worker processes never spawn a CLI command for ordinary collection.

## Start Contract

The Supervisor writes an absolute config file with mode `0600`, then invokes:

```sh
1688 daemon managed-start --supervisor-config /absolute/path/profile.json
```

`serve` refuses to start unless it receives that managed config or the
explicit `--legacy-rollback` flag. `1688 daemon start` is compatibility-only
and always selects the legacy rollback path.

The managed config schema is `profile-supervisor.daemon-config.v1`. It binds:

- `profileId`, `profileName`, and `daemonInstanceId`
- Supervisor and initial Context generations
- authoritative `databaseNow` plus its wall-clock sample time
- the short-lived credential HMAC key registry
- the PageAction capability keys and route allowlist
- an absolute trusted artifact directory
- optional acceptance journal, runtime event, and Store freshness settings

Unknown fields, weak keys, relative paths, group-readable secrets, future time
samples, and invalid PageAction routes fail before Chromium starts.

## RPC And Fencing

The socket accepts newline-delimited JSON frames up to 8 MiB. The allowlist is:

```text
collector.pageAction.execute
collector.pageAction.cancel
collector.pageAction.lookupReceipt
supervisor.status
supervisor.drain
supervisor.restart
supervisor.intervention.begin
supervisor.intervention.verify
supervisor.intervention.end
```

Collector requests present SupervisorLease, ProfileReservation, and
WorkUnitLease fences plus one renewal credential. Supervisor controls present
only the Supervisor fence plus one control credential. Credentials bind the
daemon and Context generation, hashed fencing tokens, RPC identity, canonical
request hash, deadline, validity interval, and key ID. Authorization is
rechecked before Page creation, each remote attempt, every checkpoint, and the
terminal commit. An expired or mismatched fence fails locally even when the
database is unavailable.

Execute is never blindly retried after a lost response. The caller must first
issue `lookupReceipt` with the original identities. The daemon's durable
acceptance journal distinguishes accepted, in-flight, terminal, and
idempotency-conflict states across process restarts.

## Page And Context Ownership

One managed daemon owns one Profile and one PersistentContext. Each WorkUnit
gets one registered Page. The Page registry records its owner, task type, URL
class, and lifecycle; unowned Pages are reconciled and closed during warmup.

The four production actions are exactly:

- `search-list`: one owned Page, frozen Search compiler, direct compiled URL
  navigation, exact MTOP parity capture, no filter or pagination clicks
- `offer-detail`: one owned Page and the complete Offer evidence bridge
- `store-qualification`: one owned Page and the frozen Business Info request
- `store-sample`: one owned Page and bounded phase-1 pages 1 through 3

Search creates no second Page and only calls `goto(compiled.navigationUrl)`.
Offer adapts the existing collector to a one-Page context instead of opening a
new context Page. Qualification and Store actions receive the same registered
Page from the daemon.

On success, failure, cancellation, lease loss, or drain, the automation owner
must close its Page. Cleanup failure puts the daemon through bounded recovery
and Context restart rather than reporting a false clean terminal state.

## Intervention

Risk-control intervention transfers the existing challenge Page to a bounded
InterventionSession in the same daemon PID, Chromium PID, and Context. A
successful return requires a safe identity probe on that Page. The daemon then
closes the Page, returns to warm state, and enforces the fixed recovery
cooldown. The runtime does not automate CAPTCHA or slider bypass.

## Process Ownership And Shutdown

`daemon.owner.json` is written with mode `0600` after warmup and contains the
Profile, daemon instance, Supervisor generation, Context generation, daemon
PID, and Chromium PID. A Context restart durably advances this artifact before
the restart RPC response.

The outer Supervisor manager may signal a process only when the requested
daemon instance and PID exactly match this artifact. Clean drain is followed
by exact process termination, stale lock cleanup, durable isolation proof, and
only then SupervisorLease release. A successor identity appearing during
isolation fails closed.

## Offline Verification

The deterministic gates do not use a real Profile:

```sh
pnpm typecheck
pnpm exec vitest run \
  tests/managed-bootstrap.test.ts \
  tests/file-acceptance-repository.test.ts \
  tests/page-registry.test.ts \
  tests/supervisor-rpc.test.ts \
  tests/supervisor-runtime.test.ts \
  tests/production-page-action-executor.test.ts
```

The managed bootstrap test starts a fake runtime on the real local socket,
sends all four strictly parsed and signed PageActions, verifies reachability,
and checks durable Context-generation advancement. Real Profile smoke remains
a separately authorized Gate.
