# JSON Contracts

The CLI auto-switches to JSON when stdout is piped. Stable JSON output is part
of the agent contract. Prefer additive changes; do not rename or remove fields
without an explicit breaking-change decision.

## Output Rules

- `--json` forces JSON in a TTY.
- `--pretty` indents JSON by two spaces.
- `--get <path>` prints one dot-path. Scalars are raw lines; objects and arrays
  remain JSON.
- `--pick <paths>` emits a JSON object with each requested path as a key.
- Watch commands emit line-delimited JSON, one object per new event/message.

## `whoami`

```ts
{ loggedIn: true, memberId: string, nick: string, lastVerifiedAt: string }
{ loggedIn: false }
```

## `daemon status`

`daemon status` is profile-scoped. When `--profile` is omitted, `profile` is
`default`.

```ts
{
  profile: string,
  running: boolean,
  pid?: number,
  reachable?: boolean,
  version?: string | null,
  expectedVersion?: string,
  versionMatches?: boolean,
  stats?: {
    profile: string,
    version: string,
    startedAt: string,
    pid: number,
    commandCount: number,
    lastRequestAt: string | null,
    lastError: string | null,
    uptimeMs: number,
    activeClients: number,
    browser: {
      profile: string | null,
      browserAlive: boolean,
      pageCount: number,
      currentUrl: string | null,
      pageState: object | null,
      loggedIn: boolean | null,
    },
    health: object,
  },
}
```

## `profile status`

```ts
{
  profile: {
    name: string,
    path: string,
    exists: boolean,
    locked: boolean,
    loggedIn: boolean,
    recentRequestId: string | null,
    recentStatus: string | null,
    recentErrorCode: string | null,
    daemon: {
      profile: string,
      running: boolean,
      pid?: number,
      reachable?: boolean,
      version?: string | null,
      expectedVersion?: string,
      versionMatches?: boolean,
    },
  },
  state: {
    version: 1,
    memberId?: string,
    nick?: string,
    loggedInAt?: string,
    lastVerifiedAt?: string,
  } | null,
}
```

## `doctor`

`doctor --profile <name>` checks that profile's directory, lock, state,
daemon, and live daemon socket. JSON output includes the selected `profile` and
the matching profile-scoped daemon status.

```ts
{
  ok: boolean,
  profile: string,
  checks: Array<{ name: string, status: "ok" | "warn" | "fail", message: string, fix?: string }>,
  version: VersionInfo,
  daemon: DaemonStatus | null,
}
```

## `search`, `similar`, `image-search`

Shop-card and consignment percentage fields described as decimal ratios use
`0..1` (`0.96` means 96%). Search-list percentages retain the existing
percentage-point convention (`26` means 26%) for compatibility.

```ts
{
  keyword?: string,
  imageId?: string,
  offerId?: string,
  sort?: "relevance" | "best-selling" | "price-asc" | "price-desc",
  filters?: object,
  totalBeforeFilter?: number,
  total: number,
  offers: Array<{
    offerId: string,
    title: string,
    price: { text: string, min: number | null, max: number | null },
    purchase: {
      priceTiers: Array<{
        quantityText: string | null,
        minimumQuantity: number | null,
        price: number | null,
      }>,
      minimumQuantity: number | null,
      onePieceEligible: boolean | null,
    },
    supplier: {
      name: string | null,
      loginId: string | null,
      memberId: string | null,
      shopUrl: string | null,
      years: number | null,
      badgeImageUrl: string | null,
      tradeService: {
        compositeScore: number | null,
        consultationScore: number | null,
        logisticsScore: number | null,
        disputeScore: number | null,
        returnScore: number | null,
        goodsScore: number | null,
        inspectionCreditUrl: string | null,
        sameDesignUrl: string | null,
      },
    },
    location: { province: string | null, city: string | null },
    bizType: string | null,
    verified: { factory: boolean, business: boolean, superFactory: boolean },
    tags: string[],
    serviceTags?: string[],
    productBadges?: string[],
    specHighlights?: string[],
    demand?: {
      orderCountText: string | null,
      orderCount: number | null,
      repurchaseRateText: string | null,
      repurchaseRate: number | null,
      soldCountText: string | null,
      soldCount: number | null,
      shopReturnRateText: string | null,
      shopReturnRate: number | null,
    },
    isP4P: boolean,
    turnover: string | null,
    url: string,
    image: string | null,
    images: string[],
  }>
}
```

`search --deeppro` keeps the normal `search` fields and adds:

```ts
{
  deeppro: {
    enabled: true,
    total: number,
    success: number,
    failed: number,
    offerIds: string[],
    offers: OfferResult[],
    failures: Array<{
      offerId: string,
      code: string,
      message: string,
      attempts: number,
    }>,
  },
}
```

`similar` uses this shape only when 1688's official same-product endpoint
returns comparable offers. The command intentionally does not fall back to
keyword or image search. When the official endpoint returns the current empty
image-search shell, JSON error output uses:

```ts
{
  ok: false,
  code: "SIMILAR_UNAVAILABLE",
  message: string,
  details: {
    offerId: string,
    source: "official-similar-page",
    category: "similar_unavailable",
    failureKind: "similar_unavailable",
    recoveryAction: "none",
    retryable: false,
    recoverHint: string,
    artifactDir?: string,
    currentUrl?: string,
  }
}
```

## `research`

Normal JSON result:

```ts
{
  queries: string[],
  sort: "relevance" | "best-selling" | "price-asc" | "price-desc",
  filters: object,
  maxPerQuery: number,
  enrichTop: number,
  total: number,
  enrichedCount: number,
  items: Array<{
    sourceKeyword: string,
    sourceRank: number,
    globalRank: number,
    offer: Offer,
    demand: {
      turnoverText: string | null,
      orderCount: number | null,
      repurchaseRate: number | null,
    },
    supplier: {
      years: number | null,
      verified: Offer["verified"],
      tags: string[],
      isAd: boolean,
    },
    score: number,
    scoreBreakdown: Array<{ name: string, points: number, reason: string }>,
    enriched?: OfferDetailSummary,
    error?: { code: string, message: string },
  }>,
}
```

`--jsonl` emits one research item per line. `--csv` emits a CSV table.

## `compare`

```ts
{
  total: number,
  ok: number,
  failed: number,
  items: Array<{
    offerId: string,
    ok: boolean,
    score: number | null,
    scoreBreakdown: Array<{ name: string, points: number, reason: string }>,
    summary: OfferDetailSummary | null,
    error?: { code: string, message: string },
  }>,
}
```

## `supplier inspect`

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
    companyIcons: Array<{ title: string, link: string | null }>,
    shopTags: string[],
    serviceScores: Array<{ key: string, label: string, score: number | null }>,
  },
  shopCard: ShopCardInfo | null,
  offers: { availableCount: number | null, source: "factory-card-dom" | null },
  sources: {
    offerUrl: string | null,
    factoryCardUrl: string | null,
    shopcardCaptured: boolean,
    factoryCardCaptured: boolean,
  },
  warnings: string[],
}
```

V1 supports offerId, offer URL, `b2b-*` memberId, and factory-card URL.
loginId-only input is rejected because live probing showed it can resolve to
the wrong supplier.

## `supplier search`, `supplier research`

Supplier discovery uses 1688 company search
(`companySearchBusinessService`). It must not be treated as offer-search
supplier aggregation.

```ts
{
  queries: string[],
  source: {
    kind: "company-search",
    endpoint: "companySearchBusinessService",
    offerAggregation: false,
  },
  filters: {
    factoryOnly: boolean,
    province: string | null,
    city: string | null,
    minYears: number | null,
    minRepeatRate: number | null,
    minResponseRate: number | null,
  },
  maxPerQuery: number,
  enrichTop: number,
  totalBeforeFilter: number,
  total: number,
  enrichedCount: number,
  items: Array<{
    sourceKeyword: string,
    sourceRank: number,
    globalRank: number,
    supplier: {
      companyName: string,
      loginId: string | null,
      memberId: string | null,
      enterpriseId: string | null,
      realUserId: string | null,
      companyId: string | null,
      shopUrl: string | null,
      factoryCardUrl: string | null,
      domainUri: string | null,
      location: {
        province: string | null,
        city: string | null,
        address: string | null,
        latitude: number | null,
        longitude: number | null,
      },
      productionService: string | null,
      businessMode: string | null,
      tp: {
        memberLevel: string | null,
        serviceYears: number | null,
        tpNum: number | null,
      },
      factory: {
        isFactory: boolean,
        factoryTag: string | null,
        factoryLevel: string | null,
        shiliFactory: boolean,
        shiliCompany: boolean,
        superFactory: boolean,
        businessInspection: boolean,
        factoryInspection: boolean,
        qiJianCompany: boolean,
        safePurchase: boolean,
        trust: boolean,
      },
      service: {
        compositeScore: number | null,
        wwResponseRate: number | null,
        repeatRate: number | null,
        complianceRate: number | null,
      },
      demand: {
        payOrderCount3m: number | null,
        payAmount3m: number | null,
        fuzzyPayAmount3m: string | null,
        saleQuantity3m: number | null,
        memberBookedCount: number | null,
      },
      tags: string[],
      offersPreview: Array<{
        offerId: string | null,
        title: string,
        url: string | null,
        price: { text: string | null, value: number | null },
        unit: string | null,
        image: string | null,
        bookedCount: number | null,
        saleQuantity: number | null,
        quantitySumMonth: number | null,
        brief: string | null,
      }>,
    },
    score: number,
    scoreBreakdown: Array<{ name: string, points: number, reason: string }>,
    inspect?: SupplierInspectResult,
    error?: { code: string, message: string },
  }>,
}
```

`supplier search` defaults to `--enrich 0`; `supplier research` defaults to
`--enrich top:10`. `--jsonl` emits one supplier item per line. `--csv` emits a
CSV table.

## `offer`

```ts
{
  offerId: string,
  title: string,
  url: string,
  priceRange: string | null,
  priceMin: number | null,
  priceMax: number | null,
  unitName: string | null,
  minOrderQty: number | null,
  mixOrderQty: number | null,
  priceTiers: Array<{ minQty: number, price: number }>,
  detailUrl: string | null,
  attributes: Array<{ name: string, value: string }>,
  packageInfo: Array<{
    skuId: string,
    spec: string,
    length: number | null,
    width: number | null,
    height: number | null,
    weight: number | null,
    volume: number | null,
  }>,
  supplier: {
    name: string | null,
    loginId: string | null,
    memberId: string | null,
    userId: string | null,
  },
  shopCard: ShopCardInfo | null,
  consignment: ConsignmentInfo | null,
  freight: {
    receiveAddress: string | null,
    sendArea: string | null,
    province: string | null,
    city: string | null,
    unitWeight: number | null,
  },
  saledCount: number | null,
  categoryId: string | null,
  options: Array<{ prop: string, values: Array<{ name: string, imageUrl: string | null }> }>,
  skus: Array<{
    skuId: string,
    specs: string,
    price: number | null,
    multiPrice: number | null,
    stock: number | null,
    saleCount: number | null,
    availability: {
      price: "available" | "not-present",
      stock: "available" | "not-present",
      saleCount: "available" | "not-present",
    },
    image: string | null,
  }>,
  mainImage: string | null,
  images: string[],
  media: {
    availability: "available" | "not-present" | "failed",
    items: Array<{
      role: "main" | "sku" | "detail",
      order: number,
      originalUrl: string,
      normalizedUrl: string,
      sourceField: string,
    }>,
    source: EvidenceSource,
    warnings: Array<{ code: string, message: string, order?: number }>,
  },
  sources: {
    shopCardResponseObserved: boolean,
    shopCardCaptured: boolean,
    consignmentResponseObserved: boolean,
    consignmentCaptured: boolean,
  },
}
```

`ShopCardInfo` is shared by `offer` and `supplier inspect`:

```ts
{
  name: string | null,
  url: string | null,
  shopType: string | null,
  iconType: string | null,
  badge: { code: string, label: string | null, imageUrl: string | null } | null,
  mainCategoryName: string | null,
  years: number | null,
  attention: {
    isFollowing: boolean | null,
    followersText: string | null,
    operationType: string | null,
  },
  metrics: Array<{
    key: string,
    valueText: string | null,
    value: number | null,
    unit: string | null,
  }>,
  returnRate: number | null,
  serviceScore: number | null,
  onTimeDeliveryRate: number | null,
  positiveReviewRate: number | null,
  companyId: string | null,
  companyLabel: string | null,
  companyIcons: Array<{ title: string, link: string | null }>,
  shopTags: string[],
  factoryCardUrl: string | null,
  factoryAuthText: string | null,
  serviceScores: Array<{ key: string, label: string, score: number | null }>,
}
```

Known shop-card badge codes are mapped to labels and canonical image URLs.
Unknown codes are preserved in `badge.code` with nullable label/image fields;
the mapper does not assume the current badge list is exhaustive.

`ConsignmentInfo` comes from `offerPCConsignInfoService`:

```ts
{
  name: string | null,
  offerFlags: Record<string, boolean>,
  metrics: Array<{ key: string, name: string | null, valueText: string | null }>,
  orderCount30dText: string | null,
  orderCount7dText: string | null,
  delivery24hRate: number | null,
  delivery48hRate: number | null,
  downstreamListingCountText: string | null,
  distributorCountText: string | null,
  offerPublishedAtText: string | null,
  prices: Array<{
    text: string | null,
    price: number | null,
    minimumQuantity: number | null,
  }>,
  minimumQuantity: number | null,
  onePieceEligible: boolean | null,
  onePiecePrice: number | null,
  operations: Array<{
    name: string | null,
    operationType: string | null,
    displayStatus: string | null,
    buttonType: string | null,
    displayType: string | null,
    imageUrl: string | null,
    backgroundColor: string | null,
  }>,
  protections: Array<{
    serviceName: string | null,
    description: string | null,
    actions: Array<{ text: string | null, url: string | null, appUrl: string | null }>,
  }>,
  supportedChannels: Array<{ name: string | null, iconUrl: string | null }>,
}
```

Fuzzy counts such as `100以内` remain text rather than being promoted to an
exact count. Unknown consignment names and operation codes are preserved.
`offerFlags` preserves boolean page-model signals observed in the card request
(for example `isOnePsale`, `isCrossBorderOffer`, or customization flags); these
are page evidence, not a substitute for supplier confirmation.

When `offer` receives multiple IDs, it emits a batch envelope instead of the
single-offer shape:

```ts
{
  mode: "batch",
  total: number,
  success: number,
  failed: number,
  offerIds: string[],
  offers: OfferResult[],
  failures: Array<{
    offerId: string,
    code: string,
    message: string,
  }>,
}
```

## `seller messages`

One-shot result:

```ts
{
  conversation: string,
  total: number,
  messages: Array<{
    sender: string,
    time: string | null,
    isMine: boolean,
    content: string,
    read: boolean,
    kind: "text" | "offerCard" | "orderCard" | "autoReply"
        | "assessment" | "image" | "other",
    card?: {
      title: string | null,
      price: string | null,
      image: string | null,
      url: string | null,
    },
    messageId?: string,
  }>,
}
```

Watch mode emits one object per new message:

```ts
{ conversation: string, message: Message }
```

## `cart add`

```ts
{
  ok: boolean,
  added: CartItem,
  isNewRow: boolean,
  addedQuantity: number,
}
```

## `order list`

Orders include buyer actions, service entries, and display badges. Preserve
`actions[]`, `services[]`, and `badges[]` because downstream agents use them to
decide what follow-up is possible.

## Collection Protocol v1

`collect` and production Browser Workers execute one bounded collection unit.
The final selection target, rule evaluation, database cache, review pool, and
`QualifiedSKU` count belong to the business system and are not CLI fields.

```ts
type CollectionUnit = {
  schemaVersion: 1,
  unitId: string,
  taskId?: string,
  kind: "search-page" | "store-catalog" | "store-categories"
      | "store-qualification" | "offer-detail" | "offer-media-manifest",
  subject: {
    keyword?: string,
    offerId?: string,
    supplier?: { memberId?: string, shopUrl?: string, sourceOfferId?: string },
  },
  scope?: {
    requestedScope?: "page" | "bounded-pages" | "full-scan",
    categoryId?: string,
    storeKeyword?: string,
    sort?: string,
    cursor?: string,
    pageSize?: number,
    maxPagesPerBatch?: number,
    requestedFacts?: string[],
  },
  limits?: { maxItems?: number, deadlineMs?: number },
}
```

The result is a versioned, idempotently ingestible batch:

```ts
type CollectionBatch = {
  schemaVersion: 1,
  batchId: string,
  unitId: string,
  kind: CollectionUnit["kind"],
  status: "completed" | "partial" | "blocked" | "failed",
  startedAt: string,
  completedAt: string,
  subject: Record<string, unknown>,
  scope: Record<string, unknown>,
  observations: Array<Record<string, unknown>>,
  completeness: {
    requestedScope: "page" | "bounded-pages" | "full-scan",
    state: "complete" | "truncated" | "unknown",
    observedPages: number[],
    failedPages: number[],
    expectedItems?: number,
    uniqueItems: number,
  },
  duplicateObservations: Array<{
    key: string,
    firstSource: string,
    duplicateSource: string,
  }>,
  warnings: Array<{ code: string, message: string, details?: object }>,
  errors: Array<{ code: string, message: string, retryable?: boolean, details?: object }>,
  checkpoint?: CollectionCheckpoint,
  actionRequired?: { type: "login" | "risk-control", message: string },
  rawEvidenceRefs: string[],
  metrics: Record<string, number>,
}

type CollectionCheckpoint = {
  schemaVersion: 1,
  unitFingerprint: string,
  kind: CollectionUnit["kind"],
  subject: Record<string, unknown>,
  scope: Record<string, unknown>,
  nextCursor?: string,
  nextPage?: number,
  completedPages: number[],
  seenKeys: string[],
  pendingKeys: string[],
  attemptCounts: Record<string, number>,
  updatedAt: string,
}
```

Changing the target keyword, supplier, offer, category, store keyword, sort,
page size, requested scope, or requested facts changes `unitFingerprint`.
Changing retry identity, deadline, item limit, or pages per batch does not.
An incompatible checkpoint fails with `CHECKPOINT_INCOMPATIBLE`.

Field evidence distinguishes a real empty value from unavailable data:

```ts
type Evidence<T> =
  | { availability: "available", value: T, source: EvidenceSource }
  | {
      availability: "not-present" | "not-collected" | "failed",
      value: null,
      source: EvidenceSource,
      error?: { code: string, message: string },
    }

type EvidenceSource = {
  sourceType: "search-payload" | "offer-payload" | "supplier-payload"
      | "store-catalog" | "page-dom",
  api?: string,
  componentKey?: string,
  fieldPath?: string,
  sourceRef: string,
  collectedAt: string,
  collectorVersion: string,
  parserVersion: string,
  rawRef?: string,
}
```

Public references and diagnostics must not contain Cookie, Authorization,
MTOP token, `sign`, or request `data`. Existing authentication errors remain
`NOT_LOGGED_IN` (exit 3) and `RISK_CONTROL` (exit 4); a batch uses
`actionRequired` to tell the scheduler what human action is needed.

Kind-specific observations are additive records inside the common batch:

| Kind | Observation payload |
|---|---|
| `search-page` | `offerId`, full normalized search `offer`, source page, page/raw rank, remote sort, and collection time |
| `store-catalog` | `offerId`, normalized store offer, source page/position, query/category/sort metadata, supplier identity, and collection time |
| `store-categories` | store identity, `offerCount`, category tree/counts, and parsed plus raw `userDefined` state |
| `store-qualification` | company/business-scope facts as `Evidence`, certificates/images, and certificate-list availability |
| `offer-detail` | `offerId`, normalized `OfferResult`, and collection time |
| `offer-media-manifest` | `offerId`, ordered main/SKU/detail media manifest, and collection time |

An empty `certificates` array with `certificateListAvailability: "available"`
means the returned list contained no certificate items; it does not mean that
the supplier lacks business registration or other qualification facts.
Unknown SKU price, stock, or sales remain `null` with `availability` rather
than becoming zero. Media observations contain URL references only; no image
bytes are downloaded by this protocol.

The public command accepts inline JSON, `@file`, or stdin, with an optional
checkpoint and complete-result file:

```bash
1688 collect @unit.json --checkpoint @checkpoint.json --output batch.json --json
cat unit.json | 1688 collect - --json
```

`supplier catalog` is a convenience command that constructs a catalog or
category `CollectionUnit`; `--full` remains bounded by `--max-pages` and
`--max-items` in the current invocation.

## Generated Shape Index

Run `pnpm agent-context` to refresh `docs/generated/json-shapes.md`, which
indexes exported TypeScript interfaces from command modules.
