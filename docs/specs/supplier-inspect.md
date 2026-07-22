# Supplier Inspect

This spec defines the first reliable supplier-level inspection command for
`1688-cli`. It is read-only and aimed at sourcing decisions after a buyer or
agent has found an offer or supplier `memberId`.

## Goal

Help an agent or buyer answer:

- Who is the supplier behind this offer?
- Does the supplier expose factory/trust/service signals?
- What factory card data is available: location, years, authentication,
  production scope, staff/scale hints, and available offer count?
- Which fields are observed from 1688 payloads versus unavailable?

## Non-Goals

- Do not bypass login, risk control, or slider verification.
- Do not bulk scrape supplier catalogs.
- Do not claim loginId lookup is reliable when the current site cannot resolve
  it deterministically.
- Do not perform write actions such as inquiry, favorite, cart, or checkout.
- Do not invent scores that are not backed by observed payload fields.

## Probe Findings

Live headed probe on 2026-05-31 found these useful sources:

- Offer detail page:
  - `window.context.result.global.globalData.model.sellerModel`
  - `mtop.1688.moga.pc.shopcard`
- Factory card page:
  - `https://sale.1688.com/factory/card.html?memberId=<memberId>`
  - `mtop.com.alibaba.china.factory.card.common.fn.mtop.tpp.faas`
- Factory card DOM text can expose a visible available-offer count such as
  `共34个商品`.

Direct `loginId` factory-card lookup is not reliable. A probe with
`loginId=<sellerLoginId>` returned a different factory, so V1 must reject
loginId-only input with a clear error instead of returning possibly wrong data.

Samples confirmed on 2026-07-22 show the current shop-card payload under
`data.model`. It exposes `iconType`, main category, shop years, follower state,
return rate, service score, on-time delivery rate, and positive review rate.
Known badge codes are mapped for convenience, while unknown codes remain in
the output rather than being rejected.

## Command

```bash
1688 supplier inspect <offerId|memberId|offerUrl|factoryCardUrl>
```

Supported target forms:

- numeric `offerId`
- `https://detail.1688.com/offer/<offerId>.html`
- `b2b-*` supplier `memberId`
- factory-card URL with a `memberId` query parameter

Unsupported in V1:

- loginId-only input, because live probe showed it can misresolve

Options:

```bash
--profile <name>
--headed
```

## JSON Contract

```ts
{
  target: {
    input: string,
    type: "offerId" | "memberId",
    offerId: string | null,
    memberId: string | null,
  },
  supplier: {
    name: string | null,
    loginId: string | null,
    memberId: string | null,
    userId: string | null,
    companyId: string | null,
    shopUrl: string | null,
    shopUrls: Record<string, string>,
    identity: string | null,
    signs: Record<string, boolean>,
  },
  factory: {
    isFactory: boolean,
    superFactory: boolean,
    tpYears: number | null,
    medalLevel: string | null,
    thirdPartyAuthProvider: string | null,
    establishedAtText: string | null,
    location: string | null,
    address: string | null,
    coordinates: { latitude: number | null, longitude: number | null },
    productionService: string | null,
    employeeScale: string | null,
    workerCount: string | null,
    profile: string | null,
    tags: string[],
  },
  trust: {
    companyLabel: string | null,
    retentionRate: number | null,
    companyIcons: Array<{ title: string; link: string | null }>,
    shopTags: string[],
    serviceScores: Array<{ key: string; label: string; score: number | null }>,
  },
  shopCard: ShopCardInfo | null,
  offers: {
    availableCount: number | null,
    source: "factory-card-dom" | null,
  },
  sources: {
    offerUrl: string | null,
    factoryCardUrl: string | null,
    shopcardCaptured: boolean,
    factoryCardCaptured: boolean,
  },
  warnings: string[],
}
```

`ShopCardInfo` is defined in `docs/JSON_CONTRACTS.md`. All fields are additive
and nullable. Missing values mean the current page or payload did not expose
the signal. Shop-card percentage metrics are decimal ratios (`0.99` means
99%).

## Failure Semantics

- `BAD_INPUT`: target is empty, malformed, or loginId-only.
- `NOT_LOGGED_IN`: session expired.
- `RISK_CONTROL`: 1688 risk challenge appeared; retry with `--headed`.
- `NETWORK_ERROR`: navigation failed.
- `SUPPLIER_NOT_FOUND`: no supplier identity could be read from a supported
  target.

## Verification

- Unit tests cover target normalization and payload assembly helpers.
- A live smoke test should inspect a known offerId and confirm:
  - supplier identity is present
  - memberId is present
  - factory-card capture succeeds when memberId exists
  - `loginId` direct input fails with `BAD_INPUT`
