import type { BrowserContext, Page, Response as PWResponse } from 'playwright';
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import {
  waitForCollectionPageAvailability,
  withRecovery,
} from '../session/recovery.js';
import { sleep } from '../session/wait.js';
import { parseMtop } from '../session/mtop.js';
import {
  startResponseCapture,
  type ResponseCaptureDiagnostics,
} from '../session/response-capture.js';
import { withIsolatedOperationPages } from '../session/page-lifecycle.js';
import { debugTmpPath } from '../util/temp.js';
import {
  mapConsignmentPayload,
  mapShopCardPayload,
  type ConsignmentInfo,
  type ShopCardInfo,
} from '../session/offer-evidence.js';
import {
  buildOfferMediaManifest,
  parseOfferDetailsEvidence,
  type OfferDetailsEvidence,
  type OfferMediaManifest,
} from '../session/offer-media.js';

export interface OfferOpts {
  offerId?: string;
  offerIds?: string[];
  profile?: string;
  headed?: boolean;
  pro?: boolean;
}

export interface OfferFailure {
  offerId: string;
  code: string;
  message: string;
}

export interface OfferBatchResult {
  mode: 'batch';
  total: number;
  success: number;
  failed: number;
  offerIds: string[];
  offers: OfferResult[];
  failures: OfferFailure[];
}

export interface OfferArgs {
  offerId: string;
  headed?: boolean;
  captureTimeoutMs?: number;
  onRawComponent?: (
    component: 'core' | 'sku' | 'detail' | 'shop-card' | 'consignment',
    rawPayload: unknown,
  ) => Promise<void>;
}

export interface OfferResult {
  offerId: string;
  title: string;
  url: string;
  priceRange: string | null;
  priceMin: number | null;
  priceMax: number | null;
  /** Display unit ("件" / "个" / "米" ...) */
  unitName: string | null;
  /** 起订量 — minimum order quantity for a single SKU buy. */
  minOrderQty: number | null;
  /** 混批起订量 — minimum quantity when mixing SKUs in one order. */
  mixOrderQty: number | null;
  /** Bulk-discount tiers, e.g. [{minQty: 1, price: 4.16}, {minQty: 100, price: 3.50}]. */
  priceTiers: PriceTier[];
  /** Long-form detail page URL (rich images / text). */
  detailUrl: string | null;
  /**
   * Sanitized visible text from offer_details.content. Null means the response
   * was readable but contained no visible text; omission means the detail
   * response was not collected or unreadable.
   */
  detailText?: string | null;
  /** Product attributes (材质 / 规格 / 产地 ...). Empty when the seller
   *  didn't fill them in. */
  attributes: ProductAttribute[];
  /** Per-SKU package dimensions (件重尺) when the seller filled them in.
   *  Empty array for small items (clothes, etc.) where 1688 omits this. */
  packageInfo: SkuPackage[];
  supplier: {
    name: string | null;
    loginId: string | null;
    memberId: string | null;
    userId: string | null;
  };
  /** Structured evidence from mtop.1688.moga.pc.shopcard. */
  shopCard: ShopCardInfo | null;
  /** Structured evidence from offerPCConsignInfoService. */
  consignment: ConsignmentInfo | null;
  freight: {
    receiveAddress: string | null;
    sendArea: string | null;
    province: string | null;
    city: string | null;
    unitWeight: number | null;
  };
  saledCount: number | null;
  categoryId: string | null;
  options: SkuOption[];
  skus: SkuVariant[];
  mainImage: string | null;
  images: string[];
  /** URL-only media inventory. Image bytes are deliberately not downloaded. */
  media: OfferMediaManifest;
  sources: {
    shopCardResponseObserved: boolean;
    shopCardCaptured: boolean;
    consignmentResponseObserved: boolean;
    consignmentCaptured: boolean;
    detailMediaResponseObserved: boolean;
    detailMediaCaptured: boolean;
  };
}

export interface OfferSourceCaptureEvidenceV1 {
  responseObserved: boolean;
  responseSucceeded: boolean;
  correlatedOfferId: string | null;
  correlatedMemberId: string | null;
  rawPayload: unknown | null;
  authoritativeEmpty?: {
    sourcePath: string;
    sourceValue: unknown;
    reasonCode: string;
  };
}

export interface OfferSourceCaptureEvidenceSetV1 {
  shopCard: OfferSourceCaptureEvidenceV1;
  consignment: OfferSourceCaptureEvidenceV1;
  components: {
    core: unknown;
    sku: unknown | null;
    detail: unknown | null;
  };
}

interface OfferSourceResponseCaptureV1<T> {
  value: T | null;
  requestUrl: string;
  responseSucceeded: boolean;
  rawPayload: unknown;
  authoritativeEmpty?: OfferSourceCaptureEvidenceV1['authoritativeEmpty'];
}

const OFFER_SOURCE_CAPTURE_EVIDENCE = new WeakMap<
  OfferResult,
  OfferSourceCaptureEvidenceSetV1
>();

export function readOfferSourceCaptureEvidenceV1(
  offer: OfferResult,
): OfferSourceCaptureEvidenceSetV1 | null {
  return OFFER_SOURCE_CAPTURE_EVIDENCE.get(offer) ?? null;
}

export interface PriceTier {
  minQty: number;
  price: number;
}

export interface ProductAttribute {
  name: string;
  value: string;
}

export interface SkuPackage {
  skuId: string;
  spec: string;
  /** cm */
  length: number | null;
  width: number | null;
  height: number | null;
  /** Stated weight (raw value — 1688 sometimes uses grams or kg per offer). */
  weight: number | null;
  /** Volume (cm³). */
  volume: number | null;
}

export interface SkuOption {
  prop: string;
  values: { name: string; imageUrl: string | null }[];
}

export interface SkuVariant {
  skuId: string;
  specs: string;
  price: number | null;
  /** Bulk-tier price when 1688 surfaces a separate multi-piece price. */
  multiPrice: number | null;
  stock: number | null;
  saleCount: number | null;
  availability: {
    price: 'available' | 'not-present';
    stock: 'available' | 'not-present';
    saleCount: 'available' | 'not-present';
  };
  /** Best-effort image URL derived from the first option (颜色/款式) match. */
  image: string | null;
}

const SKU_API_RE = /wosc\.queryofferskuselectormodel/i;
const SHOPCARD_API_RE = /mtop\.1688\.moga\.pc\.shopcard/i;
const OFFER_DETAIL_SERVICE_PATH_RE =
  /^\/h5\/mtop\.1688\.mmga\.offerdetail\.service\/1\.0\/?$/i;
const OFFER_DETAILS_CONTENT_RE = /itemcdn\.tmall\.com\/1688offer\//i;
let DETAIL_SEQ = 0;

export async function execute(
  ctx: BrowserContext,
  args: OfferArgs,
): Promise<OfferResult> {
  if (!/^\d+$/.test(args.offerId)) {
    throw new CliError(2, 'BAD_INPUT', `Invalid offerId: ${args.offerId}`);
  }
  return withIsolatedOperationPages(ctx, () =>
    withRecovery(
      ctx,
      { cmd: 'offer', args },
      () => executeRaw(ctx, args),
      { headed: args.headed === true, maxRetries: 1 },
    ),
  );
}

export async function executeRaw(
  ctx: BrowserContext,
  args: OfferArgs,
): Promise<OfferResult> {
  const page = await ctx.newPage();
  const captureTimeoutMs = args.captureTimeoutMs ?? 18_000;

  const skuCapture = startResponseCapture<{ model: SkuBizModel | null; rawPayload: unknown }>({
    page,
    timeoutMs: captureTimeoutMs,
    matcher: SKU_API_RE,
    parse: async (resp) => {
      const text = await resp.text();
      if (process.env.BB1688_PROBE === '1') {
        try {
          const fs = await import('node:fs/promises');
          const file = debugTmpPath('1688-sku-raw.json');
          await fs.writeFile(file, text);
          process.stderr.write(
            `[probe] saved sku → ${file} (${text.length} bytes)\n`,
          );
        } catch {
          /* ignore */
        }
      }
      await args.onRawComponent?.('sku', text);
      const json = parseMtop<{ data?: { skuSelectorBizModel?: SkuBizModel } }>(text);
      return { model: json?.data?.skuSelectorBizModel ?? null, rawPayload: json };
    },
  });
  const shopCardCapture = startResponseCapture<OfferSourceResponseCaptureV1<ShopCardInfo>>({
    page,
    timeoutMs: captureTimeoutMs,
    matcher: SHOPCARD_API_RE,
    parse: async (resp) => {
      const rawResponseText = await resp.text();
      await args.onRawComponent?.('shop-card', rawResponseText);
      const rawPayload = parseMtop(rawResponseText);
      const value = mapShopCardPayload(rawPayload);
      return {
        value,
        requestUrl: resp.url(),
        responseSucceeded: isSuccessfulMtopPayload(rawPayload),
        rawPayload,
        ...(value === null
          ? authoritativeEmptyEvidence(rawPayload, 'shop-card')
          : {}),
      };
    },
  });
  const consignmentCapture = startResponseCapture<
    OfferSourceResponseCaptureV1<ConsignmentInfo>
  >({
    page,
    timeoutMs: captureTimeoutMs,
    matcher: (resp) =>
      matchesOfferDetailServiceResponseV1(resp.url(), 'offerPCConsignInfoService'),
    parse: async (resp) => {
      const rawResponseText = await resp.text();
      await args.onRawComponent?.('consignment', rawResponseText);
      const rawPayload = parseMtop(rawResponseText);
      const value = mapConsignmentPayload(rawPayload, resp.url());
      return {
        value,
        requestUrl: resp.url(),
        responseSucceeded: isSuccessfulMtopPayload(rawPayload),
        rawPayload,
        ...(value === null
          ? authoritativeEmptyEvidence(rawPayload, 'offer-consignment')
          : {}),
      };
    },
  });
  const offerDetailsCapture = startResponseCapture<{
    evidence: OfferDetailsEvidence;
    rawPayload: string;
  }>({
    page,
    timeoutMs: captureTimeoutMs,
    matcher: OFFER_DETAILS_CONTENT_RE,
    parse: async (resp) => {
      const rawPayload = await resp.text();
      await args.onRawComponent?.('detail', rawPayload);
      return {
        evidence: parseOfferDetailsEvidence(rawPayload, resp.url()),
        rawPayload,
      };
    },
  });
  const onResp = async (resp: PWResponse) => {
    // Probe: save every offerdetail.service response so we can see which
    // call carries productAttributes.
    if (
      process.env.BB1688_PROBE === '1' &&
      /mmga\.offerdetail\.service/i.test(resp.url())
    ) {
      try {
        const text = await resp.text();
        const fs = await import('node:fs/promises');
        DETAIL_SEQ++;
        const file = debugTmpPath(
          `1688-offerdetail-${String(DETAIL_SEQ).padStart(2, '0')}.json`,
        );
        await fs.writeFile(file, text);
        process.stderr.write(
          `[probe] saved offerdetail → ${file} (${text.length} bytes)\n`,
        );
      } catch {
        /* ignore */
      }
    }
  };
  page.on('response', onResp);

  if (process.env.BB1688_PROBE === '1') {
    const log = (line: string) => process.stderr.write(line + '\n');
    log('[probe] active (offer)');
    let mtopSeq = 0;
    let htmlSeq = 0;
    page.on('response', async (resp) => {
      const u = resp.url();
      const ct = resp.headers()['content-type'] ?? '';
      if (
        /\.(png|jpg|jpeg|gif|webp|css|woff2?|svg|ico|mp4|ttf|otf|js|map)(\?|$)/i.test(
          u,
        )
      )
        return;
      if (/mmstat\.com|google-analytics|alicdn\.com\/sufei/.test(u)) return;
      try {
        const path = new URL(u).pathname;
        // mtop OR any non-mtop XHR-style endpoint (wosc.*, *.json, etc.)
        const isApi =
          /mtop[.\/]|wosc\.|h5api|\/api\/|\/ajax\/|\.json/i.test(path) ||
          /json/i.test(ct);
        if (isApi) {
          let body = '';
          try {
            body = await resp.text();
          } catch {
            /* ignore */
          }
          const offerHits = (body.match(/"offerId|offerId":/g) ?? []).length;
          const titleHits = (body.match(/"subject"|"title"/g) ?? []).length;
          const priceHits = (body.match(/"price"|priceInfo|priceRange/g) ?? [])
            .length;
          log(
            `[api ] ${path.slice(0, 80)} ct=${ct.slice(0, 25)} bodyLen=${body.length} offerId×${offerHits} title×${titleHits} price×${priceHits}`,
          );
          if (body.length > 3000 && (offerHits > 0 || titleHits > 0)) {
            try {
              const fs = await import('node:fs/promises');
              const seq = (++mtopSeq).toString().padStart(2, '0');
              const tag = path.split('/').filter(Boolean).pop() ?? 'api';
              const file = debugTmpPath(`1688-offer-mtop-${seq}-${tag.slice(0, 40)}.json`);
              await fs.writeFile(file, body);
              log(`[api ] saved → ${file}`);
            } catch {
              /* ignore */
            }
          }
          return;
        }
        // HTML responses on detail.1688.com — likely SSR shell with inline data
        if (
          /detail\.1688\.com|detail\.m\.1688\.com/.test(u) &&
          /text\/html/i.test(ct)
        ) {
          const body = await resp.text();
          try {
            const fs = await import('node:fs/promises');
            const seq = (++htmlSeq).toString().padStart(2, '0');
            const file = debugTmpPath(`1688-offer-page-${seq}.html`);
            await fs.writeFile(file, body);
            // Probe for known inline-JSON variables.
            const markers = [
              'window.runParams',
              'window.detailData',
              'window.context',
              'window.offerDetail',
              'window.__INITIAL_DATA__',
              'window.__detail__',
              'window.__VITA_DATA__',
              'window.dataLayer',
              '"offerId":',
              '"subject":',
              '"sellerLoginId":',
            ];
            const hits = markers.filter((k) => body.includes(k));
            log(
              `[html] saved → ${file} (${body.length} bytes) markers=[${hits.join(', ')}]`,
            );
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    });
  }

  const url = `https://detail.1688.com/offer/${args.offerId}.html`;
  try {
    info(`Fetching offer ${args.offerId}...`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      throw new CliError(
        9,
        'NETWORK_ERROR',
        `Failed to load offer page: ${(e as Error).message}`,
        {
          category: 'network',
          retryable: true,
          recoveryAction: 'retry-admitted-navigation',
          cause: e instanceof Error ? e.name : 'UnknownNavigationFailure',
        },
      );
    }
    await waitForCollectionPageAvailability(page, {
      headed: args.headed === true,
    });

    const [sku, shopCardResponse, consignmentResponse, offerDetails, pageInfo] =
      await Promise.all([
        skuCapture.wait(),
        shopCardCapture.wait(),
        consignmentCapture.wait(),
        offerDetailsCapture.wait(),
        (async () => {
          const rawPage = await page.content();
          await args.onRawComponent?.('core', rawPage);
          return readPageInfo(page);
        })(),
      ]);
    assertOfferPageIdentityV1(pageInfo.canonicalOfferId, args.offerId);
    const requiredSku = requireSkuSelectorModel(
      selectSkuSelectorModel(sku?.model ?? null, pageInfo.skuModel),
      skuCapture.diagnostics(),
    );
    const shopCard = shopCardResponse?.value ?? null;
    const consignment = consignmentResponse?.value ?? null;
    const result = assemble(
      args.offerId,
      url,
      requiredSku,
      pageInfo,
      shopCard,
      consignment,
      offerDetails?.evidence ?? null,
      shopCardResponse !== null,
      consignmentResponse !== null,
      offerDetailsCapture.diagnostics().matchedCount > 0,
    );
    OFFER_SOURCE_CAPTURE_EVIDENCE.set(result, {
      shopCard: captureEvidence(shopCardResponse, result),
      consignment: captureEvidence(consignmentResponse, result),
      components: {
        core: pageInfo.rawPayload,
        sku: sku?.rawPayload ?? pageInfo.skuRawPayload,
        detail: offerDetails?.rawPayload ?? null,
      },
    });
    return result;
  } finally {
    skuCapture.dispose();
    shopCardCapture.dispose();
    consignmentCapture.dispose();
    offerDetailsCapture.dispose();
    await Promise.all([
      skuCapture.drain(),
      shopCardCapture.drain(),
      consignmentCapture.drain(),
      offerDetailsCapture.drain(),
    ]);
    page.off('response', onResp);
  }
}

function captureEvidence<T>(
  captured: OfferSourceResponseCaptureV1<T> | null,
  offer: OfferResult,
): OfferSourceCaptureEvidenceV1 {
  const correlation = captured === null
    ? { correlatedOfferId: null, correlatedMemberId: null }
    : resolveOfferSourceCorrelationScopeV1({
        requestUrl: captured.requestUrl,
        rawPayload: captured.rawPayload,
        observedOfferId: offer.offerId,
        observedSellerLoginId: offer.supplier.loginId,
        observedSellerMemberId: offer.supplier.memberId,
      });
  return {
    responseObserved: captured !== null,
    responseSucceeded: captured?.responseSucceeded ?? false,
    correlatedOfferId: correlation.correlatedOfferId,
    correlatedMemberId: correlation.correlatedMemberId,
    rawPayload: captured?.rawPayload ?? null,
    ...(captured?.authoritativeEmpty === undefined
      ? {}
      : { authoritativeEmpty: captured.authoritativeEmpty }),
  };
}

export function readOfferSourceCorrelationScopeV1(
  requestUrl: string,
  rawPayload: unknown,
): { correlatedOfferId: string | null; correlatedMemberId: string | null } {
  const correlation = readOfferSourceCorrelationEvidenceV1(requestUrl, rawPayload);
  return {
    correlatedOfferId: correlation.correlatedOfferId,
    correlatedMemberId: correlation.correlatedMemberId,
  };
}

export function resolveOfferSourceCorrelationScopeV1(input: {
  requestUrl: string;
  rawPayload: unknown;
  observedOfferId: string;
  observedSellerLoginId: string | null;
  observedSellerMemberId: string | null;
}): { correlatedOfferId: string | null; correlatedMemberId: string | null } {
  const correlation = readOfferSourceCorrelationEvidenceV1(
    input.requestUrl,
    input.rawPayload,
  );
  const requestCorrelation = readOfferSourceCorrelationEvidenceV1(
    input.requestUrl,
    null,
  );
  const requestSellerMatched = input.observedSellerLoginId !== null
    && input.observedSellerMemberId !== null
    && !requestCorrelation.loginIdentityConflict
    && requestCorrelation.correlatedLoginId === input.observedSellerLoginId;
  const canonicalScopeUnambiguous = !correlation.offerIdentityConflict
    && !correlation.memberIdentityConflict;
  const canonicalScopeMatchesObserved = (
    correlation.correlatedOfferId === null
      || correlation.correlatedOfferId === input.observedOfferId
  ) && (
    correlation.correlatedMemberId === null
      || correlation.correlatedMemberId === input.observedSellerMemberId
  );
  if (requestSellerMatched && canonicalScopeUnambiguous && canonicalScopeMatchesObserved) {
    return {
      correlatedOfferId: input.observedOfferId,
      correlatedMemberId: input.observedSellerMemberId,
    };
  }
  return {
    correlatedOfferId: correlation.correlatedOfferId,
    correlatedMemberId: correlation.correlatedMemberId,
  };
}

export function assertOfferPageIdentityV1(
  observedOfferId: string | null,
  expectedOfferId: string,
): void {
  if (observedOfferId === expectedOfferId) return;
  throw new CliError(
    9,
    'OFFER_PAGE_SCOPE_MISMATCH',
    'The loaded Offer page identity does not match the requested Offer.',
    {
      category: 'protocol',
      retryable: false,
      recoveryAction: 'reject-unproven-offer-page-scope',
    },
  );
}

export function matchesOfferDetailServiceResponseV1(
  requestUrl: string,
  expectedServiceName: string,
): boolean {
  const serviceNames = new Set<string>();
  try {
    const url = new URL(requestUrl);
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'h5api.m.1688.com'
      || !OFFER_DETAIL_SERVICE_PATH_RE.test(url.pathname)
    ) {
      return false;
    }
    for (const [key, value] of url.searchParams) {
      collectNamedScalars({ [key]: value }, 'servicename', serviceNames);
      collectNamedScalars(parseJsonString(value), 'servicename', serviceNames);
    }
  } catch {
    return false;
  }
  return serviceNames.size === 1 && serviceNames.has(expectedServiceName);
}

function readOfferSourceCorrelationEvidenceV1(
  requestUrl: string,
  rawPayload: unknown,
): {
  correlatedOfferId: string | null;
  correlatedMemberId: string | null;
  correlatedLoginId: string | null;
  offerIdentityConflict: boolean;
  memberIdentityConflict: boolean;
  loginIdentityConflict: boolean;
} {
  const requestPayloads: unknown[] = [];
  try {
    const url = new URL(requestUrl);
    for (const [key, value] of url.searchParams) {
      requestPayloads.push({ [key]: value }, parseJsonString(value));
    }
  } catch {
    return {
      correlatedOfferId: null,
      correlatedMemberId: null,
      correlatedLoginId: null,
      offerIdentityConflict: false,
      memberIdentityConflict: false,
      loginIdentityConflict: false,
    };
  }
  const offerIds = new Set<string>();
  const memberIds = new Set<string>();
  const loginIds = new Set<string>();
  for (const payload of [...requestPayloads, rawPayload]) {
    collectCorrelationValues(payload, offerIds, memberIds, loginIds);
  }
  return {
    correlatedOfferId: uniqueCorrelationValue(offerIds),
    correlatedMemberId: uniqueCorrelationValue(memberIds),
    correlatedLoginId: uniqueCorrelationValue(loginIds),
    offerIdentityConflict: offerIds.size > 1,
    memberIdentityConflict: memberIds.size > 1,
    loginIdentityConflict: loginIds.size > 1,
  };
}

function collectCorrelationValues(
  value: unknown,
  offerIds: Set<string>,
  memberIds: Set<string>,
  loginIds: Set<string>,
  depth = 0,
): void {
  if (depth > 10 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    if (parsed !== value) {
      collectCorrelationValues(parsed, offerIds, memberIds, loginIds, depth + 1);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) =>
      collectCorrelationValues(item, offerIds, memberIds, loginIds, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    const scalar = correlationScalar(child);
    if (scalar !== null && normalizedKey === 'offerid') offerIds.add(scalar);
    if (
      scalar !== null &&
      ['memberid', 'sellermemberid', 'suppliermemberid'].includes(normalizedKey)
    ) {
      memberIds.add(scalar);
    }
    if (
      scalar !== null
      && ['loginid', 'sellerloginid', 'supplierloginid'].includes(normalizedKey)
    ) {
      loginIds.add(scalar);
    }
    collectCorrelationValues(child, offerIds, memberIds, loginIds, depth + 1);
  }
}

function collectNamedScalars(
  value: unknown,
  expectedKey: string,
  values: Set<string>,
  depth = 0,
): void {
  if (depth > 10 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    if (parsed !== value) collectNamedScalars(parsed, expectedKey, values, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectNamedScalars(item, expectedKey, values, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    const scalar = correlationScalar(child);
    if (scalar !== null && normalizedKey === expectedKey) values.add(scalar);
    collectNamedScalars(child, expectedKey, values, depth + 1);
  }
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function correlationScalar(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function uniqueCorrelationValue(values: Set<string>): string | null {
  return values.size === 1 ? [...values][0] ?? null : null;
}

function isSuccessfulMtopPayload(value: unknown): boolean {
  const root = asRecord(value);
  const ret = Array.isArray(root?.ret) ? root.ret : [];
  const topLevelSuccess = ret.some(
    (entry) => typeof entry === 'string' && /^SUCCESS(?:::|$)/u.test(entry),
  );
  const data = asRecord(root?.data);
  return topLevelSuccess && data?.success !== false;
}

function authoritativeEmptyEvidence(
  payload: unknown,
  source: 'shop-card' | 'offer-consignment',
): Pick<OfferSourceResponseCaptureV1<never>, 'authoritativeEmpty'> {
  const paths = source === 'shop-card'
    ? [['data']]
    : [['data', 'data', 'data', 'data'], ['data', 'data', 'data']];
  for (const pathParts of paths) {
    const found = valueAt(payload, pathParts);
    if (found.found && isStructurallyEmpty(found.value)) {
      return {
        authoritativeEmpty: {
          sourcePath: pathParts.join('.'),
          sourceValue: found.value,
          reasonCode: source === 'shop-card'
            ? 'SHOP_CARD_SUCCESS_EMPTY_SENTINEL'
            : 'CONSIGNMENT_SUCCESS_EMPTY_SENTINEL',
        },
      };
    }
  }
  return {};
}

function valueAt(
  value: unknown,
  pathParts: string[],
): { found: boolean; value: unknown } {
  let current = value;
  for (const key of pathParts) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

function isStructurallyEmpty(value: unknown): boolean {
  return value === null ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
}

export function requireSkuSelectorModel(
  model: SkuBizModel | null,
  diagnostics: ResponseCaptureDiagnostics,
): SkuBizModel {
  if (model !== null) return model;
  throw new CliError(
    9,
    'OFFER_SKU_RESPONSE_TIMEOUT',
    'The offer page did not produce a usable SKU response or page model.',
    {
      category: 'timeout',
      failureKind: 'response-timeout',
      recoveryAction: 'retry-later',
      retryable: true,
      legacyCode: 'OFFER_SKU_CAPTURE_INCOMPLETE',
      matchedCount: diagnostics.matchedCount,
      parsedCount: diagnostics.parsedCount,
      emptyResultCount: diagnostics.emptyResultCount,
      failureCount: diagnostics.failureCount,
      timedOut: diagnostics.timedOut,
      responseCapture: diagnostics,
    },
  );
}

export interface SkuBizModel {
  skuProps?: { prop?: string; value?: { name?: string; imageUrl?: string }[] }[];
  skuInfoMap?: Record<
    string,
    {
      skuId?: string | number;
      specAttrs?: string;
      price?: string;
      discountPrice?: string;
      multiPrice?: string;
      canBookCount?: string;
      saleCount?: string | number;
    }
  >;
  skuPriceScale?: string;
  skuSelectorModel?: {
    tradeModel?: {
      beginAmount?: number | string;
      saleCount?: number | string;
      unit?: string;
      mixModel?: { mixAmount?: number | string };
      offerPriceModel?: {
        currentPrices?: { beginAmount?: number | string; price?: number | string }[];
      };
    };
  };
  extraInfo?: {
    freightInfo?: {
      unitWeight?: number;
      receiveAddress?: string;
      sendAddressCode?: string;
      sellerUserId?: number | string;
    };
  };
}

export interface ContextSkuModels {
  skuModel?: unknown;
  skuModelOrigin?: unknown;
  tradeModel?: unknown;
}

export function mapContextSkuBizModel(
  input: ContextSkuModels,
): SkuBizModel | null {
  for (const candidate of [input.skuModel, input.skuModelOrigin]) {
    const mapped = mapContextSkuCandidate(candidate, input.tradeModel);
    if (mapped !== null) return mapped;
  }
  return null;
}

export function selectSkuSelectorModel(
  captured: SkuBizModel | null,
  contextFallback: SkuBizModel | null,
): SkuBizModel | null {
  return captured ?? contextFallback;
}

function mapContextSkuCandidate(
  candidate: unknown,
  rawTradeModel: unknown,
): SkuBizModel | null {
  const source = asRecord(candidate);
  if (!source || !Object.hasOwn(source, 'skuInfoMap')) return null;
  const rawSkuInfoValue = source.skuInfoMap;
  const rawSkuInfoMap = asRecord(rawSkuInfoValue);
  const explicitlyEmptySkuList =
    (rawSkuInfoMap !== null && Object.keys(rawSkuInfoMap).length === 0) ||
    (Array.isArray(rawSkuInfoValue) && rawSkuInfoValue.length === 0);
  if (!rawSkuInfoMap && !explicitlyEmptySkuList) return null;

  const trade = asRecord(rawTradeModel);
  const tradeSkus = new Map<string, Record<string, unknown>>();
  const rememberTradeSkus = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const row = asRecord(item);
      const skuId = scalarString(row?.skuId);
      if (row && skuId) tradeSkus.set(skuId, row);
    }
  };
  rememberTradeSkus(asRecord(trade?.tradeWithoutPromotion)?.skuMapOriginal);
  rememberTradeSkus(trade?.skuMap);

  const skuInfoMap: NonNullable<SkuBizModel['skuInfoMap']> = {};
  for (const [key, value] of Object.entries(rawSkuInfoMap ?? {})) {
    const row = asRecord(value);
    const skuId = scalarString(row?.skuId);
    if (!row || !skuId) continue;
    const tradeRow = tradeSkus.get(skuId);
    const mapped = {
      skuId,
      specAttrs: scalarString(row.specAttrs) ?? key,
      price: scalarString(row.price),
      discountPrice: scalarString(row.discountPrice),
      multiPrice: scalarString(row.multiPrice),
      canBookCount:
        scalarString(tradeRow?.canBookCount) ??
        scalarString(row.canBookCount),
      saleCount: numericScalar(tradeRow?.saleCount ?? row.saleCount),
    };
    skuInfoMap[key] = mapped;
  }
  if (
    Object.keys(skuInfoMap).length === 0 &&
    !explicitlyEmptySkuList
  ) {
    return null;
  }

  const skuProps = Array.isArray(source.skuProps)
    ? source.skuProps.flatMap((value) => {
        const prop = asRecord(value);
        const propName = scalarString(prop?.prop);
        if (!prop || !propName) return [];
        const values = Array.isArray(prop.value)
          ? prop.value.flatMap((item) => {
              const option = asRecord(item);
              const name = scalarString(option?.name);
              if (!option || !name) return [];
              const imageUrl = scalarString(option.imageUrl);
              return [{ name, ...(imageUrl ? { imageUrl } : {}) }];
            })
          : [];
        return [{ prop: propName, value: values }];
      })
    : [];

  const currentPrices = Array.isArray(
    asRecord(trade?.offerPriceModel)?.currentPrices,
  )
    ? (
        asRecord(trade?.offerPriceModel)!.currentPrices as unknown[]
      ).flatMap((value) => {
        const row = asRecord(value);
        const beginAmount = numericScalar(row?.beginAmount);
        const price = numericScalar(row?.price);
        return beginAmount === undefined || price === undefined
          ? []
          : [{ beginAmount, price }];
      })
    : [];
  const mixAmount = numericScalar(asRecord(trade?.mixModel)?.mixAmount);
  const tradeModel = trade
    ? {
        beginAmount: numericScalar(trade.beginAmount),
        saleCount: numericScalar(trade.saleCount),
        unit: scalarString(trade.unit),
        ...(mixAmount === undefined
          ? {}
          : { mixModel: { mixAmount } }),
        ...(currentPrices.length === 0
          ? {}
          : { offerPriceModel: { currentPrices } }),
      }
    : undefined;

  return {
    skuInfoMap,
    skuProps,
    ...(typeof source.skuPriceScale === 'string'
      ? { skuPriceScale: source.skuPriceScale }
      : {}),
    ...(tradeModel ? { skuSelectorModel: { tradeModel } } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scalarString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function numericScalar(value: unknown): number | string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? value
      : undefined;
}

function canonicalOfferIdFromDetailUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || !['detail.1688.com', 'detail.m.1688.com'].includes(url.hostname)
    ) {
      return null;
    }
    return /^\/offer\/([1-9][0-9]*)\.html$/u.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

interface PageInfo {
  canonicalOfferId: string | null;
  title: string;
  supplierName: string | null;
  sellerLoginId: string | null;
  sellerMemberId: string | null;
  sellerUserId: string | null;
  saledCount: number | null;
  mainImage: string | null;
  images: string[];
  sendArea: string | null;
  province: string | null;
  city: string | null;
  categoryId: string | null;
  detailUrl: string | null;
  attributes: ProductAttribute[];
  packageInfo: SkuPackage[];
  skuModel: SkuBizModel | null;
  rawPayload: unknown;
  skuRawPayload: unknown;
}

/**
 * Extract product info from the inline `window.context.result.data` JS
 * object that 1688 ships in the SSR HTML response. Bypasses fragile DOM
 * selectors by letting Playwright serialize the parsed JS object back to
 * Node over the wire.
 *
 * Falls back to DOM scraping if the inline data isn't available for some
 * reason (e.g. server rendered a fallback view).
 */
async function readPageInfo(page: Page): Promise<PageInfo> {
  const debug = process.env.BB1688_DEBUG === '1';
  if (debug) {
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('[bb1688-probe]') || t.includes('[bb1688]'))
        process.stderr.write(t + '\n');
    });
  }

  try {
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          context?: {
            result?: { data?: { productTitle?: { fields?: object } } };
          };
        };
        return !!w.context?.result?.data?.productTitle?.fields;
      },
      { timeout: 8000 },
    );
  } catch {
    return scrapeDomFallback(page);
  }
  // Modest scroll to trigger lazy modules near the SKU + 参数 section.
  // Avoid scrolling to bottom — 1688 detail pages infinite-scroll related
  // products there, which can hang the renderer.
  try {
    await page.evaluate(() => window.scrollTo(0, 1500));
    await sleep(1000);
    await page.evaluate(() => window.scrollTo(0, 3000));
    await sleep(1000);
  } catch {
    /* best-effort */
  }

  const fromContext = await page
    .evaluate((debugMode: boolean) => {
      type ImageEntry =
        | string
        | {
            fullPathImageURI?: string;
            imageURI?: string;
            size310x310ImageURI?: string;
          };
      type TempModel = {
        companyName?: string;
        sellerLoginId?: string;
        sellerMemberId?: string;
        sellerUserId?: number | string;
        saledCount?: number | string;
        postCategoryId?: number | string;
        topCategoryId?: number | string;
      };
      type OfferData = {
        subject?: string;
        images?: ImageEntry[];
        freightInfo?: {
          sendAddress?: string;
          sendCityText?: string;
          sendProvinceText?: string;
          sendArea?: string;
        };
        tempModel?: TempModel;
      };
      type SellerModel = {
        companyName?: string;
        loginId?: string;
        memberId?: string;
        userId?: number | string;
      };
      const w = window as unknown as {
        context?: {
          result?: {
            data?: OfferData;
            global?: {
              globalData?: {
                model?: {
                  sellerModel?: SellerModel;
                  tradeModel?: unknown;
                };
              };
            };
          };
        };
        FE_GLOBALS?: {
          offerLoginId?: string;
          loginId?: string;
          memberId?: string;
        };
      };
      const d = w.context?.result?.data as Record<string, unknown> | undefined;
      if (!d) return null;
      const feg = w.FE_GLOBALS ?? {};
      const globalModel =
        w.context?.result?.global?.globalData?.model ?? {};
      const seller = globalModel.sellerModel ?? {};
      const skuDataJson =
        (
          d.Root as {
            fields?: {
              dataJson?: {
                skuModel?: unknown;
                skuModelOrigin?: unknown;
              };
            };
          }
        )?.fields?.dataJson ?? {};

      // description module — has detailUrl + leafCategoryId.
      const descFields = (d.description as {
        fields?: {
          detailUrl?: string;
          leafCategoryId?: number | string;
          detailVideoId?: string;
        };
      })?.fields ?? {};

      // Product attributes live in a deeply-nested branch (1688 typically
      // serializes them under `globalData.model.offerDetail.featureAttributes`,
      // but the wrapping path varies). Walk the entire window.context tree
      // (bounded depth) looking for the canonical featureAttributes array.
      const attributes: { name: string; value: string }[] = [];
      const root = (w.context ?? d) as Record<string, unknown>;
      const stack: { v: unknown; depth: number }[] = [{ v: root, depth: 0 }];
      while (stack.length && attributes.length === 0) {
        const { v, depth } = stack.shift()!;
        if (depth > 12) continue;
        if (!v || typeof v !== 'object') continue;
        if (Array.isArray(v)) {
          // Detect attribute-list array shape.
          if (v.length > 0 && typeof v[0] === 'object' && v[0] !== null) {
            const first = v[0] as Record<string, unknown>;
            if (
              typeof first.name === 'string' &&
              ('value' in first || 'values' in first)
            ) {
              for (const item of v) {
                if (!item || typeof item !== 'object') continue;
                const it = item as Record<string, unknown>;
                const name =
                  typeof it.name === 'string' ? it.name.trim() : '';
                let value = '';
                if (typeof it.value === 'string') value = it.value;
                else if (Array.isArray(it.values))
                  value = (it.values as unknown[])
                    .filter((x) => typeof x === 'string')
                    .join(',');
                if (name && value) attributes.push({ name, value });
              }
            }
          }
          for (const item of v) stack.push({ v: item, depth: depth + 1 });
        } else {
          // Prioritize keys that hint at attribute containers.
          const obj = v as Record<string, unknown>;
          // Direct hit
          const direct =
            obj.featureAttributes ?? obj.productAttributes ?? obj.attributes;
          if (Array.isArray(direct))
            stack.unshift({ v: direct, depth: depth + 1 });
          for (const k of Object.keys(obj))
            stack.push({ v: obj[k], depth: depth + 1 });
        }
      }

      // Package info — per-SKU dimensions/weight (件重尺).
      const packRaw = (
        d.productPackInfo as {
          fields?: { pieceWeightScale?: { pieceWeightScaleInfo?: unknown[] } };
        }
      )?.fields?.pieceWeightScale?.pieceWeightScaleInfo;
      const packageInfo: {
        skuId: string;
        spec: string;
        length: number | null;
        width: number | null;
        height: number | null;
        weight: number | null;
        volume: number | null;
      }[] = [];
      if (Array.isArray(packRaw)) {
        for (const p of packRaw) {
          if (!p || typeof p !== 'object') continue;
          const o = p as {
            skuId?: number | string;
            sku1?: string;
            length?: number;
            width?: number;
            height?: number;
            weight?: number;
            volume?: number;
          };
          packageInfo.push({
            skuId: o.skuId != null ? String(o.skuId) : '',
            spec: o.sku1 ?? '',
            length: o.length ?? null,
            width: o.width ?? null,
            height: o.height ?? null,
            weight: o.weight ?? null,
            volume: o.volume ?? null,
          });
        }
      }

      // Page is organized by widget modules; real data lives in `<mod>.fields`.
      const productTitle = (d.productTitle as {
        fields?: {
          title?: string;
          shopInfo?: {
            companyName?: string;
            authCompanyName?: string;
            sellerSlrServiceScore?: string;
          };
          newSaleCount?: string;
          unit?: string;
        };
      })?.fields ?? {};
      const gallery = (d.gallery as {
        fields?: {
          mainImage?: unknown;
          offerId?: number | string;
          subject?: string;
          video?: { coverUrl?: string; videoId?: string };
        };
      })?.fields ?? {};
      const shop = productTitle.shopInfo ?? {};

      const imgs: string[] = [];
      const rawImgs = gallery.mainImage;
      if (Array.isArray(rawImgs)) {
        for (const img of rawImgs) {
          if (typeof img === 'string') imgs.push(img);
          else if (img && typeof img === 'object') {
            const o = img as {
              fullPathImageURI?: string;
              size310x310ImageURI?: string;
              imageURI?: string;
            };
            const url =
              o.fullPathImageURI ?? o.size310x310ImageURI ?? o.imageURI ?? '';
            if (url) {
              imgs.push(
                url.startsWith('http') ? url : `https://cbu01.alicdn.com/${url}`,
              );
            }
          }
        }
      }
      const catId =
        descFields.leafCategoryId != null
          ? String(descFields.leafCategoryId)
          : null;
      return {
        sourcePayload: {
          contextResult: w.context?.result ?? null,
          feGlobals: feg,
        },
        skuContext: {
          skuModel: skuDataJson.skuModel,
          skuModelOrigin: skuDataJson.skuModelOrigin,
          tradeModel: globalModel.tradeModel,
        },
        detailUrl: descFields.detailUrl ?? null,
        attributes,
        packageInfo,
        canonicalOfferId:
          gallery.offerId == null ? null : String(gallery.offerId),
        title: productTitle.title ?? gallery.subject ?? '',
        supplierName:
          shop.companyName ?? shop.authCompanyName ?? seller.companyName ?? null,
        sellerLoginId:
          seller.loginId ?? feg.offerLoginId ?? feg.loginId ?? null,
        sellerMemberId: seller.memberId ?? feg.memberId ?? null,
        sellerUserId:
          seller.userId != null ? String(seller.userId) : null,
        saledCount: null,
        mainImage: imgs[0] ?? null,
        images: imgs,
        sendArea: null,
        province: null,
        city: null,
        categoryId: catId,
      };
    }, debug)
    .catch(() => null);

  if (!fromContext) return scrapeDomFallback(page);

  // Title from <title> as backup when subject empty.
  let title = fromContext.title;
  if (!title) {
    const raw = await page.title();
    title = raw.replace(/\s*-\s*阿里巴巴\s*$/, '').trim();
  }
  const { sourcePayload, skuContext, ...pageInfo } = fromContext;
  return {
    ...pageInfo,
    title,
    skuModel: mapContextSkuBizModel(skuContext),
    rawPayload: sourcePayload,
    skuRawPayload: skuContext,
  };
}

async function scrapeDomFallback(page: Page): Promise<PageInfo> {
  const raw = await page.title();
  const title = raw.replace(/\s*-\s*阿里巴巴\s*$/, '').trim();
  const info = await page.evaluate(() => {
    function txt(sel: string): string | null {
      const e = document.querySelector(sel);
      return e?.textContent?.trim() ?? null;
    }
    function imgSrc(sel: string): string | null {
      const e = document.querySelector(sel) as HTMLImageElement | null;
      return e?.src ?? e?.getAttribute('data-src') ?? null;
    }
    return {
      supplierName: txt('h1') ?? null,
      mainImage:
        imgSrc('.v-image-wrap img') ??
        imgSrc('.ant-image-img') ??
        imgSrc('img[alt*="主图"]'),
    };
  });
  let rawPayload: unknown = { title: raw, extracted: info };
  try {
    rawPayload = await page.content();
  } catch {
    // Some reduced test/browser adapters cannot expose the document source.
  }
  return {
    canonicalOfferId: canonicalOfferIdFromDetailUrl(page.url()),
    title,
    supplierName: info.supplierName,
    sellerLoginId: null,
    sellerMemberId: null,
    sellerUserId: null,
    saledCount: null,
    mainImage: info.mainImage,
    images: info.mainImage ? [info.mainImage] : [],
    sendArea: null,
    province: null,
    city: null,
    categoryId: null,
    detailUrl: null,
    attributes: [],
    packageInfo: [],
    skuModel: null,
    rawPayload,
    skuRawPayload: null,
  };
}

function assemble(
  offerId: string,
  url: string,
  sku: SkuBizModel | null,
  info: PageInfo,
  shopCard: ShopCardInfo | null,
  consignment: ConsignmentInfo | null,
  offerDetails: OfferDetailsEvidence | null,
  shopCardResponseObserved: boolean,
  consignmentResponseObserved: boolean,
  detailMediaResponseObserved: boolean,
): OfferResult {
  const priceRange = sku?.skuPriceScale ?? null;
  const { min: priceMin, max: priceMax } = parseRange(priceRange);

  const options: SkuOption[] = (sku?.skuProps ?? []).map((p) => ({
    prop: p.prop ?? '',
    values: (p.value ?? []).map((v) => ({
      name: v.name ?? '',
      imageUrl: v.imageUrl ?? null,
    })),
  }));

  // Build a map: option value name → image (e.g. "22管径长方头" → cbu URL).
  // Used to derive a per-SKU image since the SKU itself doesn't carry one.
  const valueImage = new Map<string, string>();
  for (const opt of options) {
    for (const v of opt.values) {
      if (v.imageUrl) valueImage.set(v.name, v.imageUrl);
    }
  }
  // SKU specs is HTML-encoded ("&gt;" = ">"). Split by either, take first part.
  // Falls back to the offer's main image when the seller didn't upload
  // per-spec thumbnails — keeps every SKU with a usable preview URL.
  const fallbackSkuImage =
    info.mainImage ?? options[0]?.values[0]?.imageUrl ?? null;
  function deriveSkuImage(spec: string): string | null {
    const firstPart = spec.split(/&gt;|>/)[0]?.trim() ?? '';
    return valueImage.get(firstPart) ?? fallbackSkuImage;
  }

  const skus: SkuVariant[] = Object.entries(sku?.skuInfoMap ?? {}).map(
    ([k, v]) => {
      const specs = v.specAttrs ?? k;
      const price = parseFloatOrNull(v.discountPrice ?? v.price);
      const stock = parseIntOrNull(v.canBookCount);
      const saleCount =
        typeof v.saleCount === 'number'
          ? v.saleCount
          : parseIntOrNull(v.saleCount);
      return {
        skuId: v.skuId == null ? '' : String(v.skuId),
        specs,
        price,
        multiPrice: parseFloatOrNull(v.multiPrice),
        stock,
        saleCount,
        availability: {
          price: price === null ? 'not-present' : 'available',
          stock: stock === null ? 'not-present' : 'available',
          saleCount: saleCount === null ? 'not-present' : 'available',
        },
        image: deriveSkuImage(specs),
      };
    },
  );

  const freight = {
    receiveAddress: sku?.extraInfo?.freightInfo?.receiveAddress ?? null,
    sendArea: info.sendArea,
    province: info.province,
    city: info.city,
    unitWeight: sku?.extraInfo?.freightInfo?.unitWeight ?? null,
  };

  const fallbackImage =
    info.mainImage ?? options[0]?.values[0]?.imageUrl ?? null;

  const trade = sku?.skuSelectorModel?.tradeModel;
  const priceTiers: PriceTier[] = (trade?.offerPriceModel?.currentPrices ?? [])
    .map((t) => ({
      minQty: parseIntOrNull(String(t.beginAmount ?? '')) ?? 0,
      price: parseFloatOrNull(String(t.price ?? '')) ?? 0,
    }))
    .filter((t) => t.minQty > 0 && t.price > 0);
  const tradeSaleCount =
    typeof trade?.saleCount === 'number'
      ? trade.saleCount
      : parseIntOrNull(trade?.saleCount as string | undefined);
  const skuSaleCount =
    skus.length > 0 && skus.every((skuItem) => skuItem.saleCount !== null)
      ? skus.reduce((sum, skuItem) => sum + (skuItem.saleCount ?? 0), 0)
      : null;
  const media = buildOfferMediaManifest({
    offerId,
    mainImage: fallbackImage,
    images: info.images,
    skus: skus.map((skuItem) => ({
      skuId: skuItem.skuId,
      image: skuItem.image,
    })),
    detail: offerDetails?.media ?? null,
  });

  return {
    offerId,
    title: info.title,
    url,
    priceRange,
    priceMin,
    priceMax,
    unitName: trade?.unit ?? null,
    minOrderQty: parseIntOrNull(String(trade?.beginAmount ?? '')),
    mixOrderQty: parseIntOrNull(String(trade?.mixModel?.mixAmount ?? '')),
    priceTiers,
    detailUrl: info.detailUrl,
    ...(offerDetails !== null && Object.hasOwn(offerDetails, 'detailText')
      ? { detailText: offerDetails.detailText }
      : {}),
    attributes: info.attributes,
    packageInfo: info.packageInfo,
    supplier: {
      name: info.supplierName,
      loginId: info.sellerLoginId,
      memberId: info.sellerMemberId,
      // sellerUserId is exposed via SKU mtop freightInfo; window.context omits it.
      userId:
        info.sellerUserId ??
        (sku?.extraInfo?.freightInfo?.sellerUserId != null
          ? String(sku.extraInfo.freightInfo.sellerUserId)
          : null),
    },
    shopCard,
    consignment,
    freight,
    saledCount:
      tradeSaleCount ??
      info.saledCount ??
      skuSaleCount,
    categoryId: info.categoryId,
    options,
    skus,
    mainImage: fallbackImage,
    images: info.images,
    media,
    sources: {
      shopCardResponseObserved,
      shopCardCaptured: shopCard !== null,
      consignmentResponseObserved,
      consignmentCaptured: consignment !== null,
      detailMediaResponseObserved,
      detailMediaCaptured: offerDetails?.media.availability === 'available',
    },
  };
}

function parseRange(s: string | null): { min: number | null; max: number | null } {
  if (!s) return { min: null, max: null };
  const matches = Array.from(s.matchAll(/([\d.]+)/g)).map((m) => parseFloat(m[1]!));
  if (matches.length === 0) return { min: null, max: null };
  return {
    min: matches[0] ?? null,
    max: matches.length > 1 ? matches[1]! : matches[0]!,
  };
}

function parseFloatOrNull(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export async function run(opts: OfferOpts): Promise<void> {
  // Normalise: single offerId or batch offerIds.
  const ids = opts.offerIds?.length
    ? opts.offerIds
    : opts.offerId
      ? [opts.offerId]
      : [];

  if (ids.length === 0) {
    throw new CliError(2, 'BAD_INPUT', 'offerId required.');
  }

  // Single ID — original behaviour, original JSON shape.
  if (ids.length === 1) {
    const data = await dispatch<OfferArgs, OfferResult>(
      'offer',
      { offerId: ids[0]!, headed: opts.headed },
      { headed: opts.headed, profile: opts.profile },
    );
    emit({
      human: () => printOffer(data),
      data,
    });
    return;
  }

  // Batch mode — multiple IDs, serial collection, partial results.
  const offers: OfferResult[] = [];
  const failures: OfferFailure[] = [];

  for (let i = 0; i < ids.length; i++) {
    const offerId = ids[i]!;
    if (!/^\d+$/.test(offerId)) {
      failures.push({ offerId, code: 'BAD_INPUT', message: 'Invalid offerId' });
      continue;
    }

    process.stderr.write(`[${i + 1}/${ids.length}] collecting offerId ${offerId}\n`);

    try {
      const data = await dispatch<OfferArgs, OfferResult>(
        'offer',
        { offerId, headed: opts.headed },
        { headed: opts.headed, profile: opts.profile },
      );
      offers.push(data);
    } catch (error) {
      const err = error as Error & { code?: string };
      const message = sanitiseFailMessage(err.message || String(error));
      failures.push({
        offerId,
        code: err.code || 'DEEP_COLLECT_FAILED',
        message,
      });
    }
  }

  const result: OfferBatchResult = {
    mode: 'batch',
    total: ids.length,
    success: offers.length,
    failed: failures.length,
    offerIds: ids,
    offers,
    failures,
  };

  emit({
    human: () => printBatch(result),
    data: result,
  });
}

function printOffer(o: OfferResult): void {
  process.stdout.write(`${o.title}\n`);
  process.stdout.write(`  offerId:  ${o.offerId}\n`);
  if (o.priceRange) {
    process.stdout.write(`  price:    ${o.priceRange}\n`);
  } else if (o.priceMin !== null) {
    const range =
      o.priceMax !== null && o.priceMax !== o.priceMin
        ? `¥${o.priceMin.toFixed(2)} - ¥${o.priceMax.toFixed(2)}`
        : `¥${o.priceMin.toFixed(2)}`;
    process.stdout.write(`  price:    ${range}\n`);
  }
  if (o.supplier.name) {
    process.stdout.write(`  supplier: ${o.supplier.name}\n`);
  }
  if (o.shopCard?.badge?.label || o.shopCard?.mainCategoryName) {
    process.stdout.write(
      `  shop:     ${[
        o.shopCard.badge?.label,
        o.shopCard.mainCategoryName,
      ].filter(Boolean).join(' · ')}\n`,
    );
  }
  if (o.consignment) {
    const price =
      o.consignment.onePiecePrice !== null
        ? ` · 1pc ¥${o.consignment.onePiecePrice}`
        : '';
    process.stdout.write(`  consign:  ${o.consignment.name ?? 'available'}${price}\n`);
  }
  if (o.freight.receiveAddress) {
    process.stdout.write(
      `  freight:  to ${o.freight.receiveAddress}` +
        (o.freight.unitWeight ? `, ${o.freight.unitWeight}kg/unit` : '') +
        '\n',
    );
  }
  process.stdout.write(`  url:      ${o.url}\n`);
  if (o.options.length) {
    process.stdout.write(`\nOptions (${o.options.length}):\n`);
    for (const opt of o.options) {
      process.stdout.write(
        `  ${opt.prop}: ${opt.values.map((v) => v.name).slice(0, 5).join(' | ')}`,
      );
      if (opt.values.length > 5)
        process.stdout.write(` ... (+${opt.values.length - 5})`);
      process.stdout.write('\n');
    }
  }
  if (o.skus.length) {
    const sample = o.skus.slice(0, 5);
    process.stdout.write(`\nSKUs (${o.skus.length} total, showing ${sample.length}):\n`);
    for (const s of sample) {
      const price = s.price !== null ? `¥${s.price.toFixed(2)}` : '?';
      const stock = s.stock !== null ? `${s.stock} in stock` : '';
      process.stdout.write(`  ${price.padEnd(10)} ${stock.padEnd(15)} ${s.specs}\n`);
    }
  }
}

function printBatch(result: OfferBatchResult): void {
  process.stdout.write(
    `Batch offer results: ${result.success}/${result.total} ok` +
      (result.failed ? `, ${result.failed} failed` : '') +
      '\n\n',
  );
  for (const o of result.offers) {
    process.stdout.write(
      `${o.offerId} | ${(o.title || '').slice(0, 80)}\n` +
        `  SKUs: ${o.skus.length} | packages: ${o.packageInfo.length}` +
        (o.priceRange ? ` | price: ${o.priceRange}` : '') +
        '\n\n',
    );
  }
  if (result.failures.length > 0) {
    process.stdout.write('Failures:\n');
    for (const f of result.failures) {
      process.stdout.write(`  ${f.offerId}  ${f.code}  ${f.message}\n`);
    }
  }
}

/** Strip long risk-control URLs from error messages. */
function sanitiseFailMessage(message: string): string {
  if (/x5secdata|punish|captcha|verify|nocaptcha/i.test(message)) {
    return '1688 触发滑块验证，请使用 --headed 手动处理。';
  }
  return message;
}
