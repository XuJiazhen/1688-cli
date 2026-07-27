# Playbook: Add Mtop Capture

1. Probe the browser flow manually only when needed and safe.
2. Capture the smallest stable endpoint/method/appId signal.
3. Add parsing logic under `src/session` when it is shared, or in the command
   module when it is command-specific.
4. Save representative payloads as tests fixtures when they do not contain
   sensitive account data.
5. Return structured `CliError` failures for timeout, login redirect,
   risk-control, and parse failure.
6. Update `docs/JSON_CONTRACTS.md` if the capture changes agent-facing output.
7. Run focused parser/capture tests, then `pnpm agent-context`.

For a page-Runtime request:

1. Build the unauthenticated request shape in a pure function. Accept only
   business scope fields; never accept Cookie, token, `sign`, or caller-owned
   authentication headers.
2. Load an authorized page and wait for `window.lib.mtop.request` with a
   bounded deadline.
3. Install the response listener before evaluating the Runtime request.
4. Correlate API, component, stable subject identity, page, category,
   keyword, and sort. Use a broader optional target only for sanitized scope
   mismatch diagnostics.
5. Bound Runtime readiness, Runtime Promise, response capture, page state,
   and cancellation separately. Do not rely on the outer process timeout.
6. Send both the Runtime return and network response through one parser; only
   that parser may produce facts.
7. Record counts, durations, parser version, hashed scope, and terminal code.
   Redact URLs and never write replayable request material.

Runtime/DOM fallback must be explicit. A successful Runtime request cannot be
followed by DOM actions. Deterministic schema, scope, and control failures are
not fallback candidates.
