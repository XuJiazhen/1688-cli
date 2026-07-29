import type { BrowserContext, Page } from 'playwright';
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { parseMtopJsonp } from '../session/mtop.js';
import { startResponseCapture } from '../session/response-capture.js';
import {
  waitForCollectionPageAvailability,
  withRecovery,
} from '../session/recovery.js';
import { sleep } from '../session/wait.js';
import {
  mapShopCardPayload as mapSharedShopCardPayload,
  type ShopCardInfo,
  type SupplierServiceScore,
} from '../session/offer-evidence.js';
import type { SupplierQualification } from '../session/supplier-qualification.js';
import {
  captureSupplierQualificationForAction,
  requestSupplierQualificationFromPage,
} from '../session/qualification-capture.js';

export type { SupplierServiceScore } from '../session/offer-evidence.js';

const SHOPCARD_API_RE = /mtop\.1688\.moga\.pc\.shopcard/i;
const FACTORY_CARD_API_RE =
  /mtop\.com\.alibaba\.china\.factory\.card\.common\.fn\.mtop\.tpp\.faas/i;

export interface SupplierInspectOpts {
  target: string;
  profile?: string;
  headed?: boolean;
}

export interface SupplierInspectArgs {
  target: string;
  headed?: boolean;
}

export interface SupplierNavigationResolution {
  memberId: string | null;
  shopUrl: string | null;
}

export interface SupplierTarget {
  input: string;
  type: 'offerId' | 'memberId';
  offerId: string | null;
  memberId: string | null;
}

export interface SupplierInspectResult {
  target: SupplierTarget;
  supplier: {
    name: string | null;
    loginId: string | null;
    memberId: string | null;
    userId: string | null;
    companyId: string | null;
    shopUrl: string | null;
    shopUrls: Record<string, string>;
    identity: string | null;
    signs: Record<string, boolean>;
  };
  factory: {
    isFactory: boolean;
    superFactory: boolean;
    tpYears: number | null;
    medalLevel: string | null;
    thirdPartyAuthProvider: string | null;
    establishedAtText: string | null;
    location: string | null;
    address: string | null;
    coordinates: { latitude: number | null; longitude: number | null };
    productionService: string | null;
    employeeScale: string | null;
    workerCount: string | null;
    profile: string | null;
    tags: string[];
  };
  trust: {
    companyLabel: string | null;
    retentionRate: number | null;
    companyIcons: Array<{ title: string; link: string | null }>;
    shopTags: string[];
    serviceScores: SupplierServiceScore[];
  };
  shopCard: ShopCardInfo | null;
  offers: {
    availableCount: number | null;
    source: 'factory-card-dom' | null;
  };
  qualification: SupplierQualification | null;
  sources: {
    offerUrl: string | null;
    factoryCardUrl: string | null;
    shopcardCaptured: boolean;
    factoryCardCaptured: boolean;
    qualificationCaptured: boolean;
  };
  warnings: string[];
}

interface OfferSupplierData {
  name: string | null;
  loginId: string | null;
  memberId: string | null;
  userId: string | null;
  identity: string | null;
  signs: Record<string, boolean>;
  shopUrl: string | null;
  shopUrls: Record<string, string>;
}

type ShopCardData = ShopCardInfo;

interface FactoryCardData {
  name: string | null;
  loginId: string | null;
  memberId: string | null;
  shopUrl: string | null;
  tpYears: number | null;
  medalLevel: string | null;
  thirdPartyAuthProvider: string | null;
  establishedAtText: string | null;
  location: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  productionService: string | null;
  employeeScale: string | null;
  workerCount: string | null;
  profile: string | null;
  superFactory: boolean;
  tags: string[];
}

interface OfferProbe {
  offerUrl: string;
  seller: OfferSupplierData | null;
  shopCard: ShopCardData | null;
  shopcardCaptured: boolean;
}

interface FactoryProbe {
  factoryCardUrl: string;
  factory: FactoryCardData | null;
  availableOfferCount: number | null;
  factoryCardCaptured: boolean;
}

export async function run(opts: SupplierInspectOpts): Promise<void> {
  normalizeSupplierTarget(opts.target);
  const data = await dispatch<SupplierInspectArgs, SupplierInspectResult>(
    'supplier-inspect',
    { target: opts.target, headed: opts.headed },
    { headed: opts.headed, profile: opts.profile },
  );
  emit({
    human: () => printSupplierInspect(data),
    data,
  });
}

export async function execute(
  ctx: BrowserContext,
  args: SupplierInspectArgs,
): Promise<SupplierInspectResult> {
  normalizeSupplierTarget(args.target);
  return withRecovery(
    ctx,
    { cmd: 'supplier-inspect', args },
    () => executeRaw(ctx, args),
    { headed: args.headed === true, maxRetries: 1 },
  );
}

export async function resolveSupplierNavigationFromOffer(
  ctx: BrowserContext,
  args: { offerId: string; headed?: boolean },
): Promise<SupplierNavigationResolution> {
  if (!/^\d+$/.test(args.offerId)) {
    throw new CliError(2, 'BAD_INPUT', `Invalid offerId: ${args.offerId}`);
  }
  return withRecovery(
    ctx,
    { cmd: 'supplier-navigation-from-offer', args },
    async () => {
      const probe = await inspectOfferTarget(
        ctx,
        args.offerId,
        args.headed === true,
      );
      return {
        memberId:
          probe.seller?.memberId ??
          (probe.shopCard?.factoryCardUrl
            ? extractMemberIdFromUrl(probe.shopCard.factoryCardUrl)
            : null),
        shopUrl: probe.seller?.shopUrl ?? probe.shopCard?.url ?? null,
      };
    },
    { headed: args.headed === true, maxRetries: 1 },
  );
}

async function executeRaw(
  ctx: BrowserContext,
  args: SupplierInspectArgs,
): Promise<SupplierInspectResult> {
  const target = normalizeSupplierTarget(args.target);
  const warnings: string[] = [];

  let offerProbe: OfferProbe | null = null;
  let factoryProbe: FactoryProbe | null = null;
  let qualification: SupplierQualification | null = null;
  let memberId = target.memberId;

  if (target.type === 'offerId' && target.offerId) {
    offerProbe = await inspectOfferTarget(
      ctx,
      target.offerId,
      args.headed === true,
    );
    memberId = offerProbe.seller?.memberId ?? memberId;
    if (!memberId && offerProbe.shopCard?.factoryCardUrl) {
      memberId = extractMemberIdFromUrl(offerProbe.shopCard.factoryCardUrl);
    }
    if (!memberId) {
      warnings.push('Offer page did not expose a supplier memberId; factory-card enrichment skipped.');
    }
  }

  if (memberId) {
    try {
      factoryProbe = await inspectFactoryCard(
        ctx,
        memberId,
        args.headed === true,
      );
    } catch (error) {
      if (target.type === 'memberId') throw error;
      warnings.push(`Factory-card enrichment failed: ${errorMessage(error)}`);
    }
  }

  const qualificationShopUrl =
    factoryProbe?.factory?.shopUrl ??
    offerProbe?.seller?.shopUrl ??
    offerProbe?.shopCard?.url ??
    null;
  if (memberId && qualificationShopUrl) {
    try {
      qualification = await inspectStoreQualification(
        ctx,
        qualificationShopUrl,
        memberId,
        args.headed === true,
      );
      if (!qualification) {
        warnings.push('Store page did not emit a correlated qualification response.');
      }
    } catch (error) {
      warnings.push(`Qualification enrichment failed: ${errorMessage(error)}`);
    }
  }

  const result = assembleSupplierInspectResult({
    target: { ...target, memberId: target.memberId ?? memberId ?? null },
    offerProbe,
    factoryProbe,
    qualification,
    warnings,
  });

  if (!hasSupplierIdentity(result)) {
    throw new CliError(
      9,
      'SUPPLIER_NOT_FOUND',
      `Could not inspect supplier from target: ${args.target}`,
    );
  }

  return result;
}

async function inspectStoreQualification(
  ctx: BrowserContext,
  shopUrl: string,
  memberId: string,
  headed: boolean,
): Promise<SupplierQualification | null> {
  const page = await ctx.newPage();
  try {
    info(`Inspecting registered business scope ${memberId}...`);
    const result = await captureSupplierQualificationForAction(
      page,
      { memberId, timeoutMs: 15_000 },
      async () => {
        await goto1688(page, shopUrl, 'supplier shop', headed);
        await requestSupplierQualificationFromPage(page, memberId);
      },
    );
    return result.qualification;
  } finally {
    await page.close().catch(() => {});
  }
}

async function inspectOfferTarget(
  ctx: BrowserContext,
  offerId: string,
  headed: boolean,
): Promise<OfferProbe> {
  const page = await ctx.newPage();
  const offerUrl = `https://detail.1688.com/offer/${offerId}.html`;
  const shopCapture = startResponseCapture<ShopCardData>({
    page,
    timeoutMs: 5000,
    matcher: SHOPCARD_API_RE,
    parse: async (resp) => mapShopCardPayload(parseMtopJsonp(await resp.text())),
  });

  try {
    info(`Inspecting supplier from offer ${offerId}...`);
    await goto1688(page, offerUrl, 'offer page', headed);
    await page
      .waitForFunction(
        () => {
          const w = window as unknown as {
            context?: {
              result?: {
                data?: { productTitle?: { fields?: { shopInfo?: object } } };
                global?: { globalData?: { model?: { sellerModel?: object } } };
              };
            };
          };
          return !!(
            w.context?.result?.global?.globalData?.model?.sellerModel ||
            w.context?.result?.data?.productTitle?.fields?.shopInfo
          );
        },
        { timeout: 10000 },
      )
      .catch(() => {});
    await sleep(1500);

    const seller = await readOfferSellerContext(page);
    const shopCard = await shopCapture.wait();
    return {
      offerUrl,
      seller,
      shopCard,
      shopcardCaptured: shopCard !== null,
    };
  } finally {
    shopCapture.dispose();
    await page.close().catch(() => {});
  }
}

async function inspectFactoryCard(
  ctx: BrowserContext,
  memberId: string,
  headed: boolean,
): Promise<FactoryProbe> {
  const page = await ctx.newPage();
  const factoryCardUrl = buildFactoryCardUrl(memberId);
  const factoryCapture = startResponseCapture<FactoryCardData>({
    page,
    timeoutMs: 15000,
    matcher: FACTORY_CARD_API_RE,
    parse: async (resp) => mapFactoryCardPayload(parseMtopJsonp(await resp.text())),
  });

  try {
    info(`Inspecting factory card ${memberId}...`);
    await goto1688(page, factoryCardUrl, 'factory card', headed);
    await sleep(4000);
    const text = await page
      .evaluate(() => document.body?.innerText ?? '')
      .catch(() => '');
    const factory = await factoryCapture.wait();
    return {
      factoryCardUrl,
      factory,
      availableOfferCount: parseAvailableOfferCount(text),
      factoryCardCaptured: factory !== null,
    };
  } finally {
    factoryCapture.dispose();
    await page.close().catch(() => {});
  }
}

async function goto1688(
  page: Page,
  url: string,
  label: string,
  headed: boolean,
): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (error) {
    throw new CliError(
      9,
      'NETWORK_ERROR',
      `Failed to load ${label}: ${errorMessage(error)}`,
    );
  }
  await waitForCollectionPageAvailability(page, { headed });
}

async function readOfferSellerContext(page: Page): Promise<OfferSupplierData | null> {
  const raw = await page
    .evaluate(() => {
      const w = window as unknown as {
        context?: {
          result?: {
            data?: {
              productTitle?: {
                fields?: {
                  shopInfo?: {
                    companyName?: string;
                    authCompanyName?: string;
                  };
                };
              };
            };
            global?: {
              globalData?: {
                model?: {
                  sellerModel?: {
                    companyName?: string;
                    loginId?: string;
                    memberId?: string;
                    userId?: number | string;
                    sellerIdentity?: string;
                    sellerSign?: unknown;
                    sellerWinportUrlMap?: Record<string, string>;
                    winportUrl?: string;
                  };
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
      const seller =
        w.context?.result?.global?.globalData?.model?.sellerModel ?? {};
      const shopInfo =
        w.context?.result?.data?.productTitle?.fields?.shopInfo ?? {};
      const feg = w.FE_GLOBALS ?? {};
      return {
        name: seller.companyName ?? shopInfo.companyName ?? shopInfo.authCompanyName ?? null,
        loginId: seller.loginId ?? feg.offerLoginId ?? feg.loginId ?? null,
        memberId: seller.memberId ?? feg.memberId ?? null,
        userId: seller.userId != null ? String(seller.userId) : null,
        identity: seller.sellerIdentity ?? null,
        sellerSign: seller.sellerSign ?? null,
        shopUrl: seller.winportUrl ?? seller.sellerWinportUrlMap?.defaultUrl ?? null,
        shopUrls: seller.sellerWinportUrlMap ?? {},
      };
    })
    .catch(() => null);

  if (!raw) return null;
  return {
    name: stringOrNull(raw.name),
    loginId: stringOrNull(raw.loginId),
    memberId: stringOrNull(raw.memberId),
    userId: stringOrNull(raw.userId),
    identity: stringOrNull(raw.identity),
    signs: booleanRecordFromSellerSign(raw.sellerSign),
    shopUrl: stringOrNull(raw.shopUrl),
    shopUrls: stringRecord(raw.shopUrls),
  };
}

export function normalizeSupplierTarget(raw: string): SupplierTarget {
  const input = (raw ?? '').trim();
  if (!input) {
    throw new CliError(2, 'BAD_INPUT', 'Supplier target is required.');
  }

  const fromUrl = parseTargetUrl(input);
  if (fromUrl) return fromUrl;

  if (/^\d+$/.test(input)) {
    return { input, type: 'offerId', offerId: input, memberId: null };
  }
  if (isMemberId(input)) {
    return { input, type: 'memberId', offerId: null, memberId: input };
  }

  throw new CliError(
    2,
    'BAD_INPUT',
    'Unsupported supplier target. Use an offerId, offer URL, b2b-* memberId, or factory-card URL. loginId-only lookup is not reliable yet.',
  );
}

function parseTargetUrl(input: string): SupplierTarget | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const offerFromPath = url.pathname.match(/\/offer\/(\d+)(?:\.html)?/);
  const offerId = offerFromPath?.[1] ?? url.searchParams.get('offerId');
  if (offerId && /^\d+$/.test(offerId)) {
    return { input, type: 'offerId', offerId, memberId: null };
  }

  const memberId = url.searchParams.get('memberId');
  if (memberId && isMemberId(memberId)) {
    return { input, type: 'memberId', offerId: null, memberId };
  }
  return null;
}

export function mapShopCardPayload(payload: unknown): ShopCardData | null {
  return mapSharedShopCardPayload(payload);
}

export function mapFactoryCardPayload(payload: unknown): FactoryCardData | null {
  const result = objectAt(payload, ['data', 'result']);
  if (!result) return null;
  const employee = objectAt(result, ['employeeData']);
  const employeeProductNum = objectAt(employee, ['productNum']);
  const tags = uniqueStrings([
    ...extractTagTexts(result.highQualityTagList),
    ...extractTagTexts(result.fcProcessTag),
    ...extractTagTexts(result.crossBorderAbility),
    ...extractTagTexts(result.foreignTrade),
    ...extractTagTexts(result.license),
    ...extractTagTexts(result.sesameCredit),
  ]);

  return {
    name: stringOrNull(result.name),
    loginId: stringOrNull(result.loginId),
    memberId: stringOrNull(result.memberId),
    shopUrl: normalizeUrl(stringOrNull(result.shopPcWpIndexUrl)),
    tpYears: parseInteger(result.tpYears),
    medalLevel: stringOrNull(result.medalLevel),
    thirdPartyAuthProvider: stringOrNull(result.factory3rdPartyAuthProvider),
    establishedAtText: stringOrNull(result.companyYearStarted),
    location: stringOrNull(result.location),
    address: stringOrNull(result.factoryDetailedAddress),
    latitude: numberOrNull(result.factoryLatitude),
    longitude: numberOrNull(result.factoryLongitude),
    productionService: stringOrNull(result.productionService),
    employeeScale:
      stringOrNull(employee?.workerNum2) ??
      stringOrNull(employeeProductNum?.productNum),
    workerCount: stringOrNull(employee?.deepWorkerNum2),
    profile: stringOrNull(result.factoryProfile),
    superFactory: result.superFactory === true,
    tags,
  };
}

export function parseAvailableOfferCount(text: string): number | null {
  const compact = text.replace(/\s+/g, '');
  const match =
    compact.match(/共(\d+)个商品/) ??
    compact.match(/工厂店共(\d+)个商品/) ??
    compact.match(/全部商品.*?(\d+)个/);
  if (!match) return null;
  return parseInteger(match[1]);
}

export function assembleSupplierInspectResult(input: {
  target: SupplierTarget;
  offerProbe: OfferProbe | null;
  factoryProbe: FactoryProbe | null;
  qualification?: SupplierQualification | null;
  warnings?: string[];
}): SupplierInspectResult {
  const offerSeller = input.offerProbe?.seller ?? null;
  const shopCard = input.offerProbe?.shopCard ?? null;
  const factory = input.factoryProbe?.factory ?? null;
  const shopTags = uniqueStrings([
    ...(shopCard?.shopTags ?? []),
    ...(shopCard?.factoryAuthText ? [shopCard.factoryAuthText] : []),
  ]);
  const factoryTags = uniqueStrings([
    ...(factory?.tags ?? []),
    ...shopTags,
  ]);
  const signs = offerSeller?.signs ?? {};
  const shopUrls = {
    ...(offerSeller?.shopUrls ?? {}),
    ...(factory?.shopUrl ? { defaultUrl: factory.shopUrl } : {}),
  };
  const availableCount = input.factoryProbe?.availableOfferCount ?? null;

  return {
    target: input.target,
    supplier: {
      name: factory?.name ?? offerSeller?.name ?? shopCard?.name ?? null,
      loginId: factory?.loginId ?? offerSeller?.loginId ?? null,
      memberId: factory?.memberId ?? offerSeller?.memberId ?? input.target.memberId,
      userId: offerSeller?.userId ?? null,
      companyId: shopCard?.companyId ?? null,
      shopUrl: factory?.shopUrl ?? offerSeller?.shopUrl ?? null,
      shopUrls,
      identity: offerSeller?.identity ?? null,
      signs,
    },
    factory: {
      isFactory:
        factory !== null ||
        signs.isFactoryDealer === true ||
        signs.isSlsj === true ||
        factoryTags.length > 0,
      superFactory: factory?.superFactory ?? false,
      tpYears: factory?.tpYears ?? null,
      medalLevel: factory?.medalLevel ?? null,
      thirdPartyAuthProvider: factory?.thirdPartyAuthProvider ?? null,
      establishedAtText: factory?.establishedAtText ?? null,
      location: factory?.location ?? null,
      address: factory?.address ?? null,
      coordinates: {
        latitude: factory?.latitude ?? null,
        longitude: factory?.longitude ?? null,
      },
      productionService: factory?.productionService ?? null,
      employeeScale: factory?.employeeScale ?? null,
      workerCount: factory?.workerCount ?? null,
      profile: factory?.profile ?? null,
      tags: factoryTags,
    },
    trust: {
      companyLabel: shopCard?.companyLabel ?? null,
      retentionRate: shopCard?.returnRate ?? null,
      companyIcons: shopCard?.companyIcons ?? [],
      shopTags,
      serviceScores: shopCard?.serviceScores ?? [],
    },
    shopCard,
    offers: {
      availableCount,
      source: availableCount !== null ? 'factory-card-dom' : null,
    },
    qualification: input.qualification ?? null,
    sources: {
      offerUrl: input.offerProbe?.offerUrl ?? null,
      factoryCardUrl: input.factoryProbe?.factoryCardUrl ?? null,
      shopcardCaptured: input.offerProbe?.shopcardCaptured ?? false,
      factoryCardCaptured: input.factoryProbe?.factoryCardCaptured ?? false,
      qualificationCaptured: input.qualification !== undefined && input.qualification !== null,
    },
    warnings: input.warnings ?? [],
  };
}

function printSupplierInspect(data: SupplierInspectResult): void {
  const s = data.supplier;
  process.stdout.write(`${s.name ?? s.loginId ?? s.memberId ?? data.target.input}\n`);
  if (s.loginId || s.memberId || s.userId) {
    process.stdout.write(
      `  identity: ${[
        s.loginId ? `loginId=${s.loginId}` : '',
        s.memberId ? `memberId=${s.memberId}` : '',
        s.userId ? `userId=${s.userId}` : '',
      ].filter(Boolean).join(' · ')}\n`,
    );
  }
  if (s.shopUrl) process.stdout.write(`  shop:     ${s.shopUrl}\n`);
  const years = data.factory.tpYears !== null ? `${data.factory.tpYears}年` : null;
  const auth = data.factory.thirdPartyAuthProvider
    ? `${data.factory.thirdPartyAuthProvider.toUpperCase()}认证`
    : null;
  const factoryLine = [
    data.factory.isFactory ? 'factory' : null,
    data.factory.superFactory ? 'super-factory' : null,
    years,
    auth,
    data.factory.medalLevel ? `medal ${data.factory.medalLevel}` : null,
  ].filter(Boolean).join(' · ');
  if (factoryLine) process.stdout.write(`  factory:  ${factoryLine}\n`);
  if (data.factory.location || data.factory.address) {
    process.stdout.write(
      `  address:  ${[data.factory.location, data.factory.address].filter(Boolean).join(' · ')}\n`,
    );
  }
  if (data.factory.productionService) {
    process.stdout.write(`  products: ${data.factory.productionService}\n`);
  }
  if (data.qualification?.registeredBusinessScope.availability === 'available') {
    process.stdout.write(
      `  scope:    ${data.qualification.registeredBusinessScope.value}\n`,
    );
  }
  if (data.offers.availableCount !== null) {
    process.stdout.write(`  offers:   ${data.offers.availableCount}\n`);
  }
  if (data.trust.shopTags.length) {
    process.stdout.write(`  tags:     ${data.trust.shopTags.slice(0, 8).join(' · ')}\n`);
  }
  if (data.trust.serviceScores.length) {
    const scores = data.trust.serviceScores
      .map((score) => `${score.label}:${score.score ?? '?'}`)
      .join(' · ');
    process.stdout.write(`  scores:   ${scores}\n`);
  }
  for (const warning of data.warnings) {
    process.stdout.write(`  warning:  ${warning}\n`);
  }
}

function buildFactoryCardUrl(memberId: string): string {
  return `https://sale.1688.com/factory/card.html?memberId=${encodeURIComponent(memberId)}`;
}

function hasSupplierIdentity(result: SupplierInspectResult): boolean {
  return !!(
    result.supplier.name ||
    result.supplier.loginId ||
    result.supplier.memberId ||
    result.supplier.shopUrl
  );
}

function extractMemberIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const memberId = parsed.searchParams.get('memberId');
    return memberId && isMemberId(memberId) ? memberId : null;
  } catch {
    return null;
  }
}

function isMemberId(value: string): boolean {
  return /^b2b-[A-Za-z0-9_-]+$/.test(value);
}

function booleanRecordFromSellerSign(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!raw || typeof raw !== 'object') return out;
  const rec = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(rec)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  const nested = rec.signs;
  if (nested && typeof nested === 'object') {
    for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[key] = value;
    }
  }
  return out;
}

function objectAt(
  value: unknown,
  path: string[],
): Record<string, unknown> | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === 'object'
    ? current as Record<string, unknown>
    : null;
}

function arrayAt(value: unknown, path: string[]): unknown[] {
  const current = path.length ? objectAt(value, path.slice(0, -1)) : value;
  const key = path.at(-1);
  const arr =
    key && current && typeof current === 'object'
      ? (current as Record<string, unknown>)[key]
      : current;
  return Array.isArray(arr) ? arr : [];
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const n = Number(value.trim().replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

function parseInteger(value: unknown): number | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const match = text.match(/\d+/);
  if (!match) return null;
  const n = parseInt(match[0]!, 10);
  return Number.isFinite(n) ? n : null;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const text = stringOrNull(raw);
    if (text) out[key] = text;
  }
  return out;
}

function normalizeUrl(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}

function extractTagTexts(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(extractTagTexts);
  if (typeof value !== 'object') return [];
  const rec = value as Record<string, unknown>;
  const direct =
    stringOrNull(rec.text) ??
    stringOrNull(rec.name) ??
    stringOrNull(rec.title) ??
    stringOrNull(rec.label) ??
    stringOrNull(rec.tagName);
  if (direct) return [direct];
  return [];
}

function uniqueStrings(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value && !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/i.test(value)),
    ),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
