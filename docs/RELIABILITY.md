# Reliability

`1688-cli` depends on a live website, browser automation, mtop responses, and a
real logged-in buyer session. Reliability work should make failures explicit
and recoverable for agents.

## Daemon

Each daemon routes commands for one profile through one persistent Chromium
context. Different profiles use different daemon processes, locks, sockets or
named pipes, pid/version/log files, state files, and persistent browser
directories.

Benefits:

- Saves Chrome cold-start time.
- Keeps one continuous logged-in session per profile.
- Adds inter-command jitter.
- Allows different profiles to run at the same time without sharing one
  process lock.

Use `1688 daemon start` near the beginning of a session with multiple 1688
commands. Use `1688 daemon start --profile <name>` for a non-default profile.
The daemon auto-stops after inactivity. Run `1688 daemon reload --profile
<name>` after package updates or after manually resolving profile-specific
browser issues.

`login`, `logout`, and `doctor` stay inline because they need interactive UI,
browser windows, or environment checks. `login --profile <name>` can
auto-start that profile daemon after the login state is available.

## Watch Mode

`1688 seller messages ... --watch` is designed to stay alive.

- It prints a baseline line to stderr.
- It emits one JSON object to stdout for each newly-arrived message.
- History is not re-emitted.
- Deduplication uses server-side `messageId` when present.
- It exits cleanly on SIGINT.

Agent loops should parse stdout line by line and should not assume the process
will exit by itself.

## Browser Recovery

Commands should detect and report:

- login redirects
- risk-control / slider pages
- closed browser windows
- empty mtop captures
- network failures
- rate limiting, which requires automatic backoff rather than manual slider
  verification

Use structured `CliError` exit codes so agents can choose the next safe step.
When a read command is already running with `--headed`, a detected slider
keeps that command and browser open until it is resolved or
`timeouts.headedVerificationMs` expires. Login redirects still require the
separate login flow, and rate limiting still exits for automatic backoff.

## Probes And Fixtures

Probe scripts under `scripts/probe-*.mjs` are useful for discovering page
behavior, selectors, and mtop payloads. They are not stable automated tests.

Stable behavior belongs in `tests/` with fixtures where possible.

## Catalog Transport

`store-catalog` defaults to the page Runtime transport. The adapter loads the
shop once, starts a scope-correlated response listener, and invokes
`window.lib.mtop.request` for the exact target page. The page owns cookies,
tokens, and request signing. The CLI neither accepts nor persists those
materials.

The supported modes are:

- `runtime`: exact-page Runtime requests only.
- `dom`: the legacy filter/sort/pagination UI path for diagnosis or rollback.
- `auto`: Runtime first; rebuild the loaded page once when the Runtime is
  unavailable, then use DOM only when the structured error explicitly permits
  fallback.

Runtime success never triggers DOM work. Schema changes, scope mismatches, and
missing DOM controls are deterministic protocol failures rather than reasons
to rotate through every Profile. Runtime request, correlated response, and
page-state waits have bounded deadlines. A catalog checkpoint starts directly
at `nextPage`; completed pages are not replayed. It carries the first observed
item/page cardinality plus a non-decreasing page ceiling so continuation
batches can report drift without completing early.

The correlated network response and a valid Runtime fulfillment both use the
same parser; the network response remains available when the page Runtime's
Promise does not settle. Before another page request, the adapter reloads a
page whose prior Runtime evaluation remained pending. MTOP validation return codes such as
`FAIL_SYS_USER_VALIDATE` and `RGV587_ERROR` become `RISK_CONTROL`, not parser
or request failures. Diagnostics retain only return codes and payload key/type
summaries; the validation URL is never persisted.

Catalog observations and batch metrics report transport, target page, request
count, Runtime readiness, response wait, parse time, parser version, fallback
count/reason, Runtime fulfillment status, and a hashed member scope.
Diagnostics must remain non-replayable.

Offer SKU and supplier qualification response waits are also bounded below the
outer process deadline. An explicit empty SSR SKU model is a valid empty
model; a captcha page is a risk-control state, not an empty product. Missing
correlated responses return `OFFER_SKU_RESPONSE_TIMEOUT` or
`QUALIFICATION_RESPONSE_TIMEOUT` with capture diagnostics.

When an external adapter cancels or times out `collect`, the process runner
terminates the POSIX process group so Chromium descendants cannot retain
stdio and delay the authoritative terminal result. The caller-supplied
request ID is preserved in CLI errors and successful batches.
The Browser Worker reuses one request ID through initial collection, headed
intervention, and its one login recovery retry.

## Live-Service Boundaries

`pnpm test:unit` is the deterministic default. `pnpm test` also runs live
doctor checks and may depend on local browser/session state. Browser or
account-mutating checks should be explicit, bounded, and documented in the
final response when they cannot be run.
