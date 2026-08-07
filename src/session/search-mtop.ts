import { createHash } from 'node:crypto';
import { parseMtopJsonp } from './mtop.js';
import { CliError } from '../io/errors.js';
import {
  SEARCH_FILTER_REQUEST_KEYS,
} from './search-contract.js';
import type { CapturedSearchRequestBusinessV1 } from './search-compiler.js';
import {
  redactCollectorTextV1,
  sanitizeCollectorPayloadV1,
} from './collector-raw-archive.js';

export const SEARCH_MTOP_API = 'mtop.relationrecommend.wirelessrecommend.recommend';
export const SEARCH_APP_ID = '32517';

export interface Offer {
  offerId: string;
  title: string;
  price: { text: string; min: number | null; max: number | null };
  purchase: {
    priceTiers: Array<{
      quantityText: string | null;
      minimumQuantity: number | null;
      price: number | null;
    }>;
    minimumQuantity: number | null;
    onePieceEligible: boolean | null;
  };
  supplier: {
    name: string | null;
    loginId: string | null;
    memberId: string | null;
    shopUrl: string | null;
    years: number | null;
    badgeImageUrl: string | null;
    tradeService: {
      compositeScore: number | null;
      consultationScore: number | null;
      logisticsScore: number | null;
      disputeScore: number | null;
      returnScore: number | null;
      goodsScore: number | null;
      inspectionCreditUrl: string | null;
      sameDesignUrl: string | null;
    };
  };
  location: { province: string | null; city: string | null };
  bizType: string | null;
  verified: { factory: boolean; business: boolean; superFactory: boolean };
  tags: string[];
  serviceTags?: string[];
  productBadges?: string[];
  specHighlights?: string[];
  demand?: {
    orderCountText: string | null;
    orderCount: number | null;
    repurchaseRateText: string | null;
    repurchaseRate: number | null;
    soldCountText: string | null;
    soldCount: number | null;
    shopReturnRateText: string | null;
    shopReturnRate: number | null;
  };
  isP4P: boolean;
  turnover: string | null;
  url: string;
  image: string | null;
  images: string[];
}

export interface RawOfferItem {
  cellType?: string;
  data?: {
    offerId?: string;
    title?: string;
    priceInfo?: { price?: string };
    offerPicUrl?: string;
    loginId?: string;
    memberId?: string;
    province?: string;
    city?: string;
    bookedCount?: string;
    afterPrice?: { text?: string };
    offerRepurchaseRate?: string;
    turnHead?: { percent?: string };
    repurchaseRate?: string;
    repurchaseRateText?: string;
    orderCount?: string | number;
    orderCountText?: string;
    serviceTags?: Array<string | { text?: string }>;
    productBadges?: { text?: string }[];
    offerTags?: { serviceTags?: Array<string | { text?: string }> };
    titleTags?: Array<{ brandTitle?: string; text?: string; url?: string }>;
    marketTags?: Array<{ text?: string; tagType?: string; iconUrl?: string }>;
    offerMiddle?: Array<{ text?: string; tagType?: string; iconUrl?: string }>;
    list?: { guide?: Array<{ text?: string }> };
    odPicUrl?: string;
    isP4P?: string;
    bizType?: string;
    factoryInspection?: string;
    businessInspection?: string;
    superFactory?: string;
    tags?: { text?: string }[];
    winPortUrl?: string;
    shop?: {
      text?: string;
      tpYear?: string;
      newPic?: string;
      loginIdOfUtf8?: string;
    };
    shopAddition?: {
      shopLinkUrl?: string;
      tradeService?: {
        compositeNewScore?: string | number;
        consultationScore?: string | number;
        logisticsScore?: string | number;
        disputeScore?: string | number;
        returnScore?: string | number;
        goodsScore?: string | number;
        inspectionCreditUrl?: string;
        sameDesignUrl?: string;
      };
      quantityPrices?: Array<{
        quantity?: string;
        value?: string | number;
      }>;
    };
  };
}

export interface SearchMtopRequestMeta {
  appId?: string;
  method?: string;
  beginPage?: number;
  sortType?: string;
  keywords?: string;
  beginPageRaw?: string;
  pageSize?: number;
  pageId?: string;
  descendOrder?: boolean;
  filterParams?: Record<string, string | boolean | number>;
}

export interface SearchMtopPageV1 {
  offers: Offer[];
  rawItems: RawOfferItem[];
  hasMore: boolean;
  found: string | number | null;
  responseBusinessHash: string;
}

function bool(s?: string | boolean): boolean {
  return s === true || s === 'true';
}

function parseCountText(text: string | number | null | undefined): number | null {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (!text) return null;
  const compact = text.replace(/,/g, '').replace(/\s+/g, '');
  const match = compact.match(/(\d+(?:\.\d+)?)(万|w|W|亿|k|K)?/);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2] ?? '';
  const multiplier =
    unit === '亿'
      ? 100000000
      : unit === '万' || unit === 'w' || unit === 'W'
      ? 10000
      : unit === 'k' || unit === 'K'
      ? 1000
      : 1;
  return Math.round(value * multiplier);
}

function parsePercentText(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function textList(items: Array<string | { text?: string }> | undefined): string[] {
  return (items ?? [])
    .map((t) => (typeof t === 'string' ? t.trim() : t?.text?.trim() ?? ''))
    .filter((s): s is string => !!s);
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function parseNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function imageList(offerPicUrl?: string, mainImage?: string): string[] {
  return uniqueStrings([
    ...(mainImage ? [mainImage] : []),
    ...(offerPicUrl ?? '').split(','),
  ]);
}

function parseMinimumQuantity(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/(?:>=|>|≥)?\s*(\d+)/);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

export function mapOffer(item: RawOfferItem): Offer | null {
  const d = item.data;
  if (!d?.offerId) return null;
  const title = redactCollectorTextV1(
    (d.title ?? '').replace(/<[^>]*>/gu, '').trim(),
  );
  const priceRaw = d.priceInfo?.price;
  const price = priceRaw ? parseFloat(priceRaw) : null;
  const yearsRaw = d.shop?.tpYear;
  const years = yearsRaw ? parseInt(yearsRaw, 10) : null;
  const tags = (d.tags ?? [])
    .map((t) => t?.text?.trim() ?? '')
    .filter((s): s is string => !!s);
  const serviceTags = uniqueStrings([
    ...textList(d.serviceTags),
    ...textList(d.offerTags?.serviceTags),
    ...textList(d.offerMiddle),
    ...textList(d.marketTags),
  ]);
  const productBadges = uniqueStrings([
    ...textList(d.productBadges),
    ...(d.titleTags ?? [])
      .map((tag) => tag.brandTitle?.trim() ?? tag.text?.trim() ?? '')
      .filter(Boolean),
  ]);
  const specHighlights = textList(d.list?.guide);
  const orderCountText =
    d.orderCountText ??
    (typeof d.orderCount === 'string' ? d.orderCount : undefined) ??
    d.bookedCount ??
    null;
  const repurchaseRateText =
    d.repurchaseRateText ?? d.repurchaseRate ?? d.offerRepurchaseRate ?? null;
  const soldCountText = d.afterPrice?.text ?? null;
  const shopReturnRateText = d.turnHead?.percent ?? null;
  const tradeService = d.shopAddition?.tradeService;
  const images = imageList(d.offerPicUrl, d.odPicUrl);
  const listingPriceTiers = (d.shopAddition?.quantityPrices ?? []).map(
    (tier) => ({
      quantityText: tier.quantity?.trim() ?? null,
      minimumQuantity: parseMinimumQuantity(tier.quantity),
      price: parseNumber(tier.value),
    }),
  );
  const listingQuantities = listingPriceTiers
    .map((tier) => tier.minimumQuantity)
    .filter((quantity): quantity is number => quantity !== null);
  const listingMinimumQuantity = listingQuantities.length
    ? Math.min(...listingQuantities)
    : null;
  return {
    offerId: d.offerId,
    title,
    price: {
      text: priceRaw ? `¥${priceRaw}` : '',
      min: price,
      max: price,
    },
    purchase: {
      priceTiers: listingPriceTiers,
      minimumQuantity: listingMinimumQuantity,
      onePieceEligible:
        listingMinimumQuantity === null
          ? null
          : listingMinimumQuantity <= 1,
    },
    supplier: {
      name: d.shop?.text ?? null,
      loginId: d.loginId ?? null,
      memberId: d.memberId ?? null,
      shopUrl: normalizeLive1688ShopUrl(
        d.shopAddition?.shopLinkUrl ?? d.winPortUrl,
      ),
      years,
      badgeImageUrl: d.shop?.newPic ?? null,
      tradeService: {
        compositeScore: parseNumber(tradeService?.compositeNewScore),
        consultationScore: parseNumber(tradeService?.consultationScore),
        logisticsScore: parseNumber(tradeService?.logisticsScore),
        disputeScore: parseNumber(tradeService?.disputeScore),
        returnScore: parseNumber(tradeService?.returnScore),
        goodsScore: parseNumber(tradeService?.goodsScore),
        inspectionCreditUrl: tradeService?.inspectionCreditUrl ?? null,
        sameDesignUrl: tradeService?.sameDesignUrl ?? null,
      },
    },
    location: {
      province: d.province ?? null,
      city: d.city ?? null,
    },
    bizType: d.bizType ?? null,
    verified: {
      factory: bool(d.factoryInspection),
      business: bool(d.businessInspection),
      superFactory: bool(d.superFactory),
    },
    tags,
    ...(serviceTags.length ? { serviceTags } : {}),
    ...(productBadges.length ? { productBadges } : {}),
    ...(specHighlights.length ? { specHighlights } : {}),
    demand: {
      orderCountText,
      orderCount:
        typeof d.orderCount === 'number'
          ? d.orderCount
          : parseCountText(orderCountText),
      repurchaseRateText,
      repurchaseRate: parsePercentText(repurchaseRateText),
      soldCountText,
      soldCount: parseCountText(soldCountText),
      shopReturnRateText,
      shopReturnRate: parsePercentText(shopReturnRateText),
    },
    isP4P: bool(d.isP4P) || /(?:^|[_-])p4p(?:[_-]|$)/iu.test(item.cellType ?? ''),
    turnover: d.bookedCount ?? null,
    url: `https://detail.1688.com/offer/${d.offerId}.html`,
    image: images[0] ?? null,
    images,
  };
}

export function readSearchMtopRequestMeta(url: string): SearchMtopRequestMeta | null {
  if (!url.includes(SEARCH_MTOP_API)) return null;
  try {
    const dataParam = new URLSearchParams(new URL(url).search).get('data') ?? '';
    if (!dataParam) return null;
    const dataObj = JSON.parse(dataParam) as {
      appId?: unknown;
      params?: string;
    };
    const params = JSON.parse(dataObj.params ?? '{}') as {
      method?: string;
      beginPage?: number | string;
      sortType?: string;
      keywords?: string;
      pageSize?: number | string;
      pageId?: string;
      descendOrder?: boolean | string;
      [key: string]: unknown;
    };
    const beginPage = params.beginPage === undefined ? undefined : Number(params.beginPage);
    const filterParams: Record<string, string | boolean | number> = {};
    for (const key of SEARCH_FILTER_REQUEST_KEYS) {
      const value = params[key];
      if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
        filterParams[key] = value;
      }
    }
    const extended =
      params.keywords !== undefined || params.pageSize !== undefined ||
      params.pageId !== undefined || params.descendOrder !== undefined ||
      Object.keys(filterParams).length > 0;
    return {
      appId: String(dataObj.appId),
      method: params.method,
      beginPage,
      sortType: params.sortType,
      ...(typeof params.keywords === 'string' ? { keywords: params.keywords } : {}),
      ...(!extended || params.beginPage === undefined ? {} : { beginPageRaw: String(params.beginPage) }),
      ...(params.pageSize === undefined ? {} : { pageSize: Number(params.pageSize) }),
      ...(typeof params.pageId === 'string' ? { pageId: params.pageId } : {}),
      ...(typeof params.descendOrder === 'boolean'
        ? { descendOrder: params.descendOrder }
        : params.descendOrder === 'true'
          ? { descendOrder: true }
          : params.descendOrder === 'false'
            ? { descendOrder: false }
            : {}),
      ...(Object.keys(filterParams).length ? { filterParams } : {}),
    };
  } catch {
    return null;
  }
}

export function readCapturedSearchRequestBusinessV1(
  url: string,
): CapturedSearchRequestBusinessV1 | null {
  const meta = readSearchMtopRequestMeta(url);
  if (
    !meta?.appId ||
    !meta.method ||
    meta.keywords === undefined ||
    meta.beginPageRaw === undefined ||
    meta.pageSize === undefined ||
    !meta.pageId ||
    !meta.sortType ||
    meta.descendOrder === undefined
  ) {
    return null;
  }
  return {
    appId: meta.appId,
    method: meta.method,
    keywords: meta.keywords,
    beginPage: meta.beginPageRaw,
    pageSize: meta.pageSize,
    pageId: meta.pageId,
    sortType: meta.sortType,
    descendOrder: meta.descendOrder,
    filterParams: meta.filterParams ?? {},
  };
}

export function parseSearchMtopPageV1(text: string): SearchMtopPageV1 {
  const json = parseMtopJsonp<{
    ret?: unknown;
    data?: {
      code?: unknown;
      success?: unknown;
      data?: {
        OFFER?: {
          items?: unknown;
          hasMore?: unknown;
          found?: unknown;
        };
      };
    };
  }>(text);
  const ret = Array.isArray(json?.ret) ? json.ret : [];
  if (!ret.some((entry) => typeof entry === 'string' && /SUCCESS/i.test(entry))) {
    searchProtocolError('SEARCH_RESPONSE_RET_NOT_SUCCESS', 'Search response ret is not successful.');
  }
  const data = json?.data;
  if (
    !(data?.success === true || data?.success === 'true') ||
    !(data.code === 200 || data.code === '200' || data.code === 'SUCCESS')
  ) {
    searchProtocolError('SEARCH_RESPONSE_STATUS_NOT_SUCCESS', 'Search response code/success contract failed.');
  }
  const offer = data.data?.OFFER;
  if (!offer || !Array.isArray(offer.items)) {
    searchProtocolError('SEARCH_RESPONSE_SCHEMA_DRIFT', 'Search response lacks OFFER.items[].');
  }
  const hasMore = normalizeHasMore(offer.hasMore);
  const rawItems = offer.items as RawOfferItem[];
  const offers = rawItems.map(mapOffer).filter((item): item is Offer => item !== null);
  return {
    offers,
    rawItems,
    hasMore,
    found:
      typeof offer.found === 'string' || typeof offer.found === 'number'
        ? offer.found
        : null,
    responseBusinessHash: searchResponseHash({
      schema: 'search-response-business-v1',
      rawItems: sanitizeCollectorPayloadV1(rawItems),
      offers,
      hasMore,
      found: offer.found ?? null,
    }),
  };
}

export function parseOfferItemsFromMtopText(text: string): Offer[] {
  const json = parseMtopJsonp<{
    data?: { data?: { OFFER?: { items?: RawOfferItem[] } } };
  }>(text);
  const items = json?.data?.data?.OFFER?.items ?? [];
  return items.map(mapOffer).filter((o): o is Offer => o !== null);
}

function normalizeHasMore(value: unknown): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  searchProtocolError('SEARCH_RESPONSE_HAS_MORE_INVALID', 'Search response OFFER.hasMore is missing or invalid.');
}

function searchProtocolError(code: string, message: string): never {
  throw new CliError(9, code, message, {
    category: 'protocol',
    retryable: false,
    recoveryAction: 'refresh-search-contract',
  });
}

function normalizeLive1688ShopUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'http:'
      && url.username === ''
      && url.password === ''
      && /(?:^|\.)1688\.com$/iu.test(url.hostname)
    ) {
      url.protocol = 'https:';
      return url.toString();
    }
  } catch {
    return value;
  }
  return value;
}

function searchResponseHash(value: unknown): string {
  const canonical = JSON.stringify(value);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
