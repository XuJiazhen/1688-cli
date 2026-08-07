# Spec: Profile Daemon

> Status: draft
> Product: 1688-cli daemon/session runtime
> Scope: profile-scoped daemon processes, browser contexts, locks, runtime artifacts, and diagnostics

## 1. Summary

`1688-cli` supports multiple local profiles, but the warm daemon runtime is
currently global/default-oriented. This spec changes daemon ownership to one
daemon per profile so commands run against the daemon for their selected
profile, different profiles can operate in parallel, and default-profile
behavior remains compatible for users who do not pass `--profile`.

## 2. Goals

- Resolve every command profile to `default` when no profile is supplied.
- Support `1688 serve --profile <name>`.
- Support `1688 daemon start|stop|status|reload --profile <name>`.
- Route ordinary dispatched commands such as `search --profile acc-a` to the
  daemon for `acc-a` when that daemon is reachable.
- Keep headed mode and explicitly daemon-disabled runs inline.
- Use one persistent browser context per daemon, bound to that daemon profile.
- Use profile-scoped lock, socket or named pipe, pid, version, log, and state
  artifacts.
- Allow different profiles to run concurrently without sharing one process lock.
- Surface profile names in daemon, lock, and diagnostic error messages.
- Preserve default behavior for commands that omit `--profile`.

## 3. Non-goals

- Do not build one daemon that multiplexes multiple profiles.
- Do not change checkout confirmation safety or route `checkout confirm`
  through the daemon.
- Do not run live 1688 login, search, or browser mutation checks as automated
  verification.
- Do not change command result contracts except for additive diagnostic fields
  on daemon/profile/doctor surfaces.
- Do not migrate or delete historical global daemon artifacts automatically
  beyond normal stale-artifact cleanup for the selected profile.

## 4. Behavior contract

- `defaultProfileName(profile)` resolves missing, empty, or whitespace-only
  profile input to `default`.
- Runtime artifact helpers accept an optional profile argument and use the
  resolved profile:
  - `socketPath(profile)`
  - `pidFile(profile)`
  - `daemonVersionFile(profile)`
  - `daemonLogFile(profile)`
  - `lockFile(profile)`
  - `stateFile(profile)`
- Windows named pipe names include both the root hash and a profile-derived
  segment so two profiles under the same `BB1688_HOME` do not collide.
- Non-Windows daemon sockets are profile-scoped filesystem paths under the
  selected profile/runtime area.
- `acquireLock(profile)` locks only the selected profile.
- Inline sessions use `profilePath(profile)` and `acquireLock(profile)`.
- A daemon process is bound to exactly one profile at startup.
- `getSharedContext(profile)` creates or reuses the browser context only for
  the daemon-bound profile and stores cookies/session in that profile's
  persistent context directory.
- `runOnSharedCtx` serializes operations within one daemon process only.
- `dispatch(name, args, { profile })` requires the selected Profile daemon.
- Inline execution exists only for an explicit headed intervention such as
  login or risk recovery; normal commands never fall back from daemon RPC.
- `login --profile <name> --headed` is the explicit interactive identity and
  risk-recovery entry point. Normal business commands remain daemon-only.
- `doctor --profile <name>` checks the selected profile's directory, lock,
  state, daemon, and live daemon socket status.
- `profile status <name>` reports the selected profile's profile directory,
  profile-scoped lock, profile-scoped state, recent event, and daemon status.
- Error messages for daemon running, start timeout, lock busy, stale daemon, and
  daemon pause identify the affected profile.

## 5. Verification

- Focused unit coverage for profile-scoped paths, including Windows pipe names.
- Focused unit coverage for profile status using profile-scoped locks/states.
- Focused unit coverage for doctor platform helpers and profile-aware daemon
  checks where deterministic.
- Typecheck with `pnpm typecheck`.
- Deterministic tests with `pnpm test:unit`.
- Regenerate generated docs with `pnpm agent-context` after command/source/test
  changes.
- Run `pnpm agent-verify` as the final local gate.

## 6. Acceptance criteria

- `1688 daemon start --profile acc-a` starts only the `acc-a` daemon.
- `1688 daemon start --profile acc-b` can coexist with `acc-a`.
- `1688 daemon status --profile acc-a` and `--profile acc-b` inspect different
  artifacts and sockets.
- `1688 serve --profile acc-a` binds a daemon to `acc-a`.
- `1688 search "..." --profile acc-a` tries the `acc-a` daemon first.
- `1688 search "..." --profile acc-b` tries the `acc-b` daemon first.
- A lock held by `acc-a` does not make `acc-b` report `LOCK_BUSY`.
- A daemon pause or risk-control state in one profile is represented in that
  profile daemon status and does not stop another profile daemon.
- Commands without `--profile` continue to use the `default` profile.

## 7. Assumptions and open questions

- [ASSUMED] Profile names used by real workflows are simple names such as
  `default`, `acc-a`, or `work`, without path separators.
- [ASSUMED] Moving default daemon artifacts behind profile-aware helpers is
  compatible because all public commands use those helpers rather than fixed
  artifact paths.
- [ASSUMED] Historical global `state.json` does not need an automated migration
  for this change; a profile-specific state file is authoritative once this
  version runs.
