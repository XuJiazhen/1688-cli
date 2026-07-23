# Feature Backlog

This file records product ideas that should survive chat context loss. Status
is intentionally lightweight: `Idea`, `Planned`, `Active`, or `Done`.

Last updated: 2026-07-23

## Production Evidence Collection

| Feature | Status | Notes |
|---|---|---|
| Collection protocol v1 | Done | Added versioned `CollectionUnit`, `CollectionBatch`, checkpoints, fingerprints, field availability, partial results, and login/risk action requirements. |
| Incremental search batches | Done | `collect` can fetch one search page with source rank, supplier identity, deduplication, and a resumable cursor while preserving legacy `search` output. |
| Store catalog collector | Done | `supplier catalog` and `collect` support bounded all-offer scans, categories, category filtering, store keyword search, UI-backed sorting, deduplication, drift warnings, and page checkpoints. |
| Supplier qualification facts | Done | Qualification collection includes registered business scope, business line, company identity, service/summary facts, certificates, images, and explicit availability. |
| Offer media manifests | Done | Offer collection preserves nullable SKU facts and extracts ordered main, SKU, and detail image references without downloading image bytes. |
| Fixture/Playwright parity | Done | All six collection kinds run through the same runtime contract with sanitized fixture replay and live Playwright adapters. |
| Central diagnostic redaction | Done | Response diagnostics, events, artifacts, evidence references, and fixtures reject or redact cookies, authorization, MTOP tokens, signatures, request data, phone numbers, and unrelated identity fields. |

## Sourcing Research

| Feature | Status | Notes |
|---|---|---|
| `1688 search --sort` | Done | Added `relevance`, `best-selling`, `price-asc`, and `price-desc`; local deterministic sorting is the contract, with remote sort hints where known. |
| Search filters | Done | Added price range, province/city, verified supplier, minimum turnover/order count, and optional ad exclusion. |
| `1688 research <keyword...>` | Done | Multi-keyword research records `sourceKeyword`, rank, demand signals, supplier trust signals, score, JSON/JSONL/CSV output. |
| Top-N enrichment | Done | `research --enrich top:N` enriches only top N results through `offer` detail extraction. |
| Supplier quality fields | Done | Search retains supplier/member IDs, direct badge images, trade-service scores, demand, service tags, and product/spec signals; offer detail adds structured shop-card metrics. |
| Consignment evidence | Done | `offer` captures `offerPCConsignInfoService`, including mode, quantity/price, pickup rates, protections, actions, and supported channels. |
| `1688 supplier inspect` | Done | Inspect supplier/factory trust signals from offerId or `b2b-*` memberId. loginId-only lookup is intentionally rejected until a deterministic resolver exists. |
| `1688 supplier search` | Done | Supplier discovery now comes from 1688 company search (`companySearchBusinessService`) with GBK keyword encoding, not offer-result aggregation. |
| `1688 supplier research` | Done | Scores company-search suppliers and optionally enriches top N via `supplier inspect`; supports JSONL/CSV export. |
| `1688 compare <offerId...>` | Done | Compares price tiers, MOQ, sales signals, supplier identity, SKU depth, stock, freight/package hints, and score. |
| Export formats | Done | Added `--jsonl` and `--csv` for research datasets while keeping normal command JSON stable for agents. |
| Sourcing score | Done | Computed, explainable V1 score from price, demand, supplier tenure, verification, tags, and ad status. |

## Agent Maps

| Feature | Status | Notes |
|---|---|---|
| Short agent entrypoint | Done | `AGENTS.md` is now a concise routing map; durable detail moved into `docs/`. |
| Documentation map | Done | `docs/README.md` now maps commands, JSON contracts, safety, reliability, workflow, specs, playbooks, exec plans, and generated indexes. |
| Architecture map | Done | `ARCHITECTURE.md` describes CLI layers, command ownership, session/daemon boundaries, and verification surfaces. |
| Specs directory | Done | Domain specs live under `docs/specs/` instead of `docs/product-specs/`. |
| Playbooks | Done | Added playbooks for adding commands, changing JSON output, debugging risk control, adding mtop capture, and release/update work. |
| Generated context | Done | `scripts/generate_agent_context.mjs` generates command, module, test, and JSON-shape indexes under `docs/generated/`. |
| Agent verification gate | Done | Added `pnpm agent-context`, `pnpm docs-check`, `pnpm agent-map-check`, `pnpm test:unit`, and `pnpm agent-verify`. |
| Agent map grader | Done | `scripts/check_agent_map.mjs` checks required docs, generated indexes, package scripts, and short-map constraints. |
| Quality score | Done | `docs/QUALITY_SCORE.md` tracks agent-readiness, known gaps, and latest verification. |
| Live doctor gate split | Planned | Full `pnpm test` still includes `tests/doctor-live.test.ts`; consider adding explicit `pnpm test:live` and making `pnpm test` deterministic or clearly documented. |
| JSON schema/snapshot tests | Idea | Add tests that lock stable agent-facing JSON contracts beyond the heuristic `docs/generated/json-shapes.md` index. |
| AST-based JSON shape index | Idea | Replace the current regex/heuristic interface extractor with TypeScript AST parsing when shape extraction needs more precision. |

## Platform Compatibility

| Feature | Status | Notes |
|---|---|---|
| Windows CLI compatibility baseline | Done | Implemented cross-platform build, root-hashed Windows named-pipe daemon isolation, platform-aware doctor/postinstall hints, `os.tmpdir()` debug paths, PowerShell docs, and deterministic tests. Verified with focused tests, `pnpm build`, `pnpm test:unit`, `pnpm agent-verify`, and `npm pack --dry-run`; manual Windows smoke checklist remains documented in the spec. |
