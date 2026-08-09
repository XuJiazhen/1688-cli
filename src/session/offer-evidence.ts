export interface SupplierServiceScore {
  key: string;
  label: string;
  score: number | null;
}

export interface ShopCardMetric {
  key: string;
  valueText: string | null;
  value: number | null;
  unit: string | null;
}

export interface ShopCardInfo {
  name: string | null;
  url: string | null;
  shopType: string | null;
  iconType: string | null;
  badge: {
    code: string;
    label: string | null;
    imageUrl: string | null;
  } | null;
  mainCategoryName: string | null;
  years: number | null;
  attention: {
    isFollowing: boolean | null;
    followersText: string | null;
    operationType: string | null;
  };
  metrics: ShopCardMetric[];
  /** Decimal ratio in the range 0..1. */
  returnRate: number | null;
  serviceScore: number | null;
  /** Decimal ratio in the range 0..1. */
  onTimeDeliveryRate: number | null;
  /** Decimal ratio in the range 0..1. */
  positiveReviewRate: number | null;
  companyId: string | null;
  companyLabel: string | null;
  companyIcons: Array<{ title: string; link: string | null }>;
  shopTags: string[];
  factoryCardUrl: string | null;
  factoryAuthText: string | null;
  serviceScores: SupplierServiceScore[];
}

export interface ConsignmentMetric {
  key: string;
  name: string | null;
  valueText: string | null;
}

export interface ConsignmentPrice {
  text: string | null;
  price: number | null;
  minimumQuantity: number | null;
}

export interface ConsignmentOperation {
  name: string | null;
  operationType: string | null;
  displayStatus: string | null;
  buttonType: string | null;
  displayType: string | null;
  imageUrl: string | null;
  backgroundColor: string | null;
}

export interface ConsignmentProtection {
  serviceName: string | null;
  description: string | null;
  actions: Array<{
    text: string | null;
    url: string | null;
    appUrl: string | null;
  }>;
}

export interface ConsignmentInfo {
  name: string | null;
  /** Boolean page-model flags observed in the request that loaded this card. */
  offerFlags: Record<string, boolean>;
  metrics: ConsignmentMetric[];
  orderCount30dText: string | null;
  orderCount7dText: string | null;
  /** Decimal ratio in the range 0..1. */
  delivery24hRate: number | null;
  /** Decimal ratio in the range 0..1. */
  delivery48hRate: number | null;
  downstreamListingCountText: string | null;
  distributorCountText: string | null;
  offerPublishedAtText: string | null;
  prices: ConsignmentPrice[];
  minimumQuantity: number | null;
  onePieceEligible: boolean | null;
  onePiecePrice: number | null;
  operations: ConsignmentOperation[];
  protections: ConsignmentProtection[];
  supportedChannels: Array<{ name: string | null; iconUrl: string | null }>;
}

export type OfferSourceKindV1 = 'shop-card' | 'offer-consignment';

export interface OfferSourceSidecarV1 {
  schema: 'collector.offer-source-sidecar.v1';
  source: OfferSourceKindV1;
  authoritySource?: 'offer-core';
  offerId: string;
  memberId: string;
  correlatedOfferId: string | null;
  correlatedMemberId: string | null;
  pageActionId: string;
  remoteRequestAttemptId: string;
  capturedAt: string;
  authorityEvidence?: {
    schema: 'collector.offer-core-consignment-authority.v1';
    sourcePath: 'contextResult.global.globalData.model.consignModel.consignOffer';
    sourceValue: false;
    offerId: string;
    memberId: string;
    supportingSignals: {
      hasConsignPrice: false;
      supportConsignIssuing: false;
      isSupportConsignIssuing: false;
    };
  };
  sanitizedRawPayload: unknown;
}

export function createOfferSourceSidecarV1(input: {
  source: OfferSourceKindV1;
  authoritySource?: 'offer-core';
  offerId: string;
  memberId: string;
  correlatedOfferId: string | null;
  correlatedMemberId: string | null;
  pageActionId: string;
  remoteRequestAttemptId: string;
  capturedAt: string;
  rawPayload: unknown;
}): { artifactRef: string; artifact: OfferSourceSidecarV1 } {
  if (input.authoritySource === 'offer-core' && input.source !== 'offer-consignment') {
    throw new TypeError('Offer core authority is only valid for Consignment absence.');
  }
  const offerId = requiredId(input.offerId, 'offerId');
  const memberId = requiredId(input.memberId, 'memberId');
  if (
    input.authoritySource === 'offer-core'
    && !offerCoreAuthorityPayloadMatches(input.rawPayload, offerId, memberId, true)
  ) {
    throw new TypeError('Offer core Consignment sidecar authority is invalid.');
  }
  const artifact: OfferSourceSidecarV1 = {
    schema: 'collector.offer-source-sidecar.v1',
    source: input.source,
    ...(input.authoritySource === 'offer-core'
      ? { authoritySource: input.authoritySource }
      : {}),
    offerId,
    memberId,
    correlatedOfferId: optionalId(input.correlatedOfferId, 'correlatedOfferId'),
    correlatedMemberId: optionalId(input.correlatedMemberId, 'correlatedMemberId'),
    pageActionId: requiredId(input.pageActionId, 'pageActionId'),
    remoteRequestAttemptId: requiredId(
      input.remoteRequestAttemptId,
      'remoteRequestAttemptId',
    ),
    capturedAt: new Date(input.capturedAt).toISOString(),
    ...(input.authoritySource === 'offer-core'
      ? { authorityEvidence: offerCoreAuthorityEvidence(offerId, memberId) }
      : {}),
    sanitizedRawPayload: sanitizeOfferSourcePayloadV1(
      input.rawPayload,
      [],
      input.authoritySource === 'offer-core',
    ),
  };
  assertOfferCoreSidecarAuthority(artifact);
  const digest = evidenceHash(artifact).slice('sha256:'.length);
  return Object.freeze({
    artifactRef: `artifact:offer-source-${input.source}-${digest}`,
    artifact: Object.freeze(artifact),
  });
}

export function assertOfferSourceSidecarBindingV1(
  artifactRef: string,
  artifact: OfferSourceSidecarV1,
): void {
  assertOfferCoreSidecarAuthority(artifact);
  const digest = evidenceHash(artifact).slice('sha256:'.length);
  if (
    artifact.schema !== 'collector.offer-source-sidecar.v1' ||
    artifactRef !== `artifact:offer-source-${artifact.source}-${digest}`
  ) {
    throw new TypeError('Offer source sidecar content does not match its artifact reference.');
  }
}

const OFFER_SOURCE_REVISIONS = Object.freeze({
  'shop-card': {
    schema: 'offer-shop-card-observation-receipt-v1',
    schemaRevision: 'shop-card-source-v1@1',
    parserRevision: 'shop-card-parser-v1@1',
  },
  'offer-consignment': {
    schema: 'offer-consignment-observation-receipt-v1',
    schemaRevision: 'offer-consignment-source-v1@1',
    parserRevision: 'offer-consignment-parser-v1@1',
  },
} as const);

const OFFER_SOURCE_EMPTY_SENTINELS: Readonly<
  Record<OfferSourceKindV1, ReadonlyArray<{
    sourcePath: string;
    reasonCode: string;
    valueKind: 'structurally-empty' | 'false';
  }>>
> = Object.freeze({
  'shop-card': Object.freeze([
    {
      sourcePath: 'data',
      reasonCode: 'SHOP_CARD_SUCCESS_EMPTY_SENTINEL',
      valueKind: 'structurally-empty' as const,
    },
  ]),
  'offer-consignment': Object.freeze([
    {
      sourcePath: 'data.data.data.data',
      reasonCode: 'CONSIGNMENT_SUCCESS_EMPTY_SENTINEL',
      valueKind: 'structurally-empty' as const,
    },
    {
      sourcePath: 'data.data.data',
      reasonCode: 'CONSIGNMENT_SUCCESS_EMPTY_SENTINEL',
      valueKind: 'structurally-empty' as const,
    },
    {
      sourcePath: 'contextResult.global.globalData.model.consignModel.consignOffer',
      reasonCode: 'CONSIGNMENT_CORE_DECLARED_UNSUPPORTED',
      valueKind: 'false' as const,
    },
  ]),
});

export interface OfferSourceTerminalReceiptV1 {
  schema:
    | 'offer-shop-card-observation-receipt-v1'
    | 'offer-consignment-observation-receipt-v1';
  source: OfferSourceKindV1;
  authoritySource?: 'offer-core';
  offerId: string;
  memberId: string;
  pageActionId: string;
  remoteRequestAttemptId: string;
  responseObserved: boolean;
  responseSucceeded: boolean;
  correlation: 'matched' | 'failed';
  schemaRevision: string;
  parserRevision: string;
  state: 'available' | 'not-present' | 'failed';
  absenceProof?: {
    sourcePath: string;
    sourceValueHash: string;
    reasonCode: string;
    authorityArtifactRef?: string;
  };
  rawEvidenceRefs: string[];
  fieldObservationRefs?: string[];
  error?: CollectorErrorV1;
  receiptContentHash: string;
}

export function createOfferSourceTerminalReceiptV1(input: {
  source: OfferSourceKindV1;
  authoritySource?: 'offer-core';
  offerId: string;
  memberId: string;
  pageActionId: string;
  remoteRequestAttemptId: string;
  responseObserved: boolean;
  responseSucceeded: boolean;
  correlatedOfferId: string | null;
  correlatedMemberId: string | null;
  parsedValue: ShopCardInfo | ConsignmentInfo | null;
  authoritativeEmpty?: {
    sourcePath: string;
    sourceValue: unknown;
    reasonCode: string;
  };
  rawEvidenceRefs: string[];
  fieldObservationRefs?: string[];
  error?: CollectorErrorV1;
}): OfferSourceTerminalReceiptV1 {
  const rawEvidenceRefs = [...new Set(input.rawEvidenceRefs.map((ref) => requiredId(ref, 'rawEvidenceRef')))].sort();
  const rawEvidenceComplete = rawEvidenceRefs.length > 0 && rawEvidenceRefs.every(
    (ref) => isOfferSourceArtifactRefV1(ref, input.source),
  );
  const fieldObservationRefs = [...new Set(
    (input.fieldObservationRefs ?? []).map((ref) => requiredId(ref, 'fieldObservationRef')),
  )].sort();
  const correlation: OfferSourceTerminalReceiptV1['correlation'] =
    input.correlatedOfferId === input.offerId &&
    input.correlatedMemberId === input.memberId
      ? 'matched'
      : 'failed';
  const dedicatedResponseReady = input.authoritySource === undefined
    && input.responseObserved
    && input.responseSucceeded;
  const offerCoreAbsenceReady = input.authoritySource === 'offer-core'
    && input.source === 'offer-consignment'
    && !input.responseObserved
    && !input.responseSucceeded
    && rawEvidenceRefs.length === 1;
  let state: OfferSourceTerminalReceiptV1['state'] = 'failed';
  let absenceProof: OfferSourceTerminalReceiptV1['absenceProof'];
  if (
    dedicatedResponseReady &&
    correlation === 'matched' &&
    input.parsedValue !== null &&
    rawEvidenceComplete
  ) {
    state = 'available';
  } else if (
    (dedicatedResponseReady || offerCoreAbsenceReady) &&
    correlation === 'matched' &&
    input.parsedValue === null &&
    input.authoritativeEmpty &&
    rawEvidenceComplete
  ) {
    assertRegisteredAuthoritativeEmpty(input.source, input.authoritativeEmpty);
    state = 'not-present';
    absenceProof = {
      sourcePath: input.authoritativeEmpty.sourcePath,
      sourceValueHash: evidenceHash(input.authoritativeEmpty.sourceValue),
      reasonCode: input.authoritativeEmpty.reasonCode,
      ...(input.authoritySource === 'offer-core'
        ? { authorityArtifactRef: rawEvidenceRefs[0]! }
        : {}),
    };
  }
  const error = state === 'failed'
    ? input.error ?? {
        code: sourceFailureCode({ ...input, rawEvidenceRefs }),
        category: correlation === 'failed' ? 'protocol' : 'timeout',
        retryable: correlation !== 'failed',
        actionRequired: null,
        recoveryAction: correlation === 'failed'
          ? 'inspect-source-correlation'
          : 'retry-offer-detail',
      }
    : undefined;
  const content = {
    schema: OFFER_SOURCE_REVISIONS[input.source].schema,
    source: input.source,
    ...(input.authoritySource === 'offer-core'
      ? { authoritySource: input.authoritySource }
      : {}),
    offerId: requiredId(input.offerId, 'offerId'),
    memberId: requiredId(input.memberId, 'memberId'),
    pageActionId: requiredId(input.pageActionId, 'pageActionId'),
    remoteRequestAttemptId: requiredId(input.remoteRequestAttemptId, 'remoteRequestAttemptId'),
    responseObserved: input.responseObserved,
    responseSucceeded: input.responseSucceeded,
    correlation,
    schemaRevision: OFFER_SOURCE_REVISIONS[input.source].schemaRevision,
    parserRevision: OFFER_SOURCE_REVISIONS[input.source].parserRevision,
    state,
    ...(absenceProof ? { absenceProof } : {}),
    rawEvidenceRefs,
    ...(input.source === 'shop-card'
      ? { fieldObservationRefs }
      : {}),
    ...(error ? { error } : {}),
  };
  return Object.freeze({
    ...content,
    receiptContentHash: evidenceHash(content),
  });
}

export function assertOfferSourceReceiptsCompleteV1(input: {
  offerId: string;
  memberId: string;
  pageActionId: string;
  remoteRequestAttemptId: string;
  remoteRawEvidenceRefs: string[];
  shopCard: OfferSourceTerminalReceiptV1;
  consignment: OfferSourceTerminalReceiptV1;
}): void {
  for (const [source, receipt] of [
    ['shop-card', input.shopCard],
    ['offer-consignment', input.consignment],
  ] as const) {
    const expected = OFFER_SOURCE_REVISIONS[source];
    const { receiptContentHash, ...content } = receipt;
    const absenceProofValid = receipt.state !== 'not-present' || (
      receipt.absenceProof !== undefined &&
      isRegisteredAbsenceProof(source, receipt.absenceProof) &&
      /^sha256:[0-9a-f]{64}$/.test(receipt.absenceProof.sourceValueHash)
    );
    const sourceAuthorityComplete = receipt.authoritySource === undefined
      ? receipt.responseObserved && receipt.responseSucceeded
      : receipt.authoritySource === 'offer-core'
        && source === 'offer-consignment'
        && receipt.state === 'not-present'
        && !receipt.responseObserved
        && !receipt.responseSucceeded
        && receipt.absenceProof?.reasonCode
          === 'CONSIGNMENT_CORE_DECLARED_UNSUPPORTED'
        && receipt.rawEvidenceRefs.length === 1
        && receipt.absenceProof.authorityArtifactRef
          === receipt.rawEvidenceRefs[0];
    if (
      receipt.source !== source ||
      receipt.schema !== expected.schema ||
      receipt.schemaRevision !== expected.schemaRevision ||
      receipt.parserRevision !== expected.parserRevision ||
      receipt.offerId !== input.offerId ||
      receipt.memberId !== input.memberId ||
      receipt.pageActionId !== input.pageActionId ||
      receipt.remoteRequestAttemptId !== input.remoteRequestAttemptId ||
      !sourceAuthorityComplete ||
      receipt.correlation !== 'matched' ||
      !['available', 'not-present'].includes(receipt.state) ||
      receipt.rawEvidenceRefs.length === 0 ||
      receipt.rawEvidenceRefs.some((ref) => !isOfferSourceArtifactRefV1(ref, source)) ||
      receipt.rawEvidenceRefs.some((ref) => !input.remoteRawEvidenceRefs.includes(ref)) ||
      !absenceProofValid ||
      (receipt.state === 'available' && receipt.absenceProof !== undefined) ||
      receipt.error !== undefined ||
      receiptContentHash !== evidenceHash(content)
    ) {
      throw new TypeError(`${source} terminal source receipt is absent, failed, or belongs to another scope.`);
    }
  }
}

function sourceFailureCode(input: {
  source: OfferSourceKindV1;
  responseObserved: boolean;
  responseSucceeded: boolean;
  correlatedOfferId: string | null;
  correlatedMemberId: string | null;
  offerId: string;
  memberId: string;
  rawEvidenceRefs: string[];
}): string {
  const prefix = input.source === 'shop-card' ? 'SHOP_CARD' : 'OFFER_CONSIGNMENT';
  if (!input.responseObserved) return `${prefix}_RESPONSE_NOT_OBSERVED`;
  if (!input.responseSucceeded) return `${prefix}_RESPONSE_NOT_SUCCESS`;
  if (input.rawEvidenceRefs.length === 0) return `${prefix}_RAW_EVIDENCE_MISSING`;
  if (input.rawEvidenceRefs.some((ref) => !isOfferSourceArtifactRefV1(ref, input.source))) {
    return `${prefix}_RAW_EVIDENCE_INVALID`;
  }
  if (input.correlatedOfferId !== input.offerId || input.correlatedMemberId !== input.memberId) {
    return `${prefix}_SCOPE_MISMATCH`;
  }
  return `${prefix}_PARSE_FAILED`;
}

function isOfferSourceArtifactRefV1(
  value: string,
  source: OfferSourceKindV1,
): boolean {
  return new RegExp(`^artifact:offer-source-${source}-[0-9a-f]{64}$`, 'u').test(value);
}

const OFFER_CORE_CONSIGNMENT_SIGNS_PATH = [
  'contextResult',
  'global',
  'globalData',
  'model',
  'consignModel',
  'consignSign',
  'signs',
] as const;

const OFFER_CORE_AUTHORITY_VALUE_PATHS = [
  ['contextResult', 'data', 'gallery', 'fields', 'offerId'],
  ['contextResult', 'global', 'globalData', 'model', 'sellerModel', 'memberId'],
  [
    ...OFFER_CORE_CONSIGNMENT_SIGNS_PATH,
    'isSupportConsignIssuing',
  ],
] as const;

function sanitizeOfferSourcePayloadV1(
  value: unknown,
  path: readonly string[] = [],
  preserveOfferCoreAuthorityValues = false,
): unknown {
  if (
    preserveOfferCoreAuthorityValues
    && path.length === OFFER_CORE_CONSIGNMENT_SIGNS_PATH.length
    && path.every(
      (segment, index) => segment === OFFER_CORE_CONSIGNMENT_SIGNS_PATH[index],
    )
  ) {
    const signs = recordOrNull(value);
    return {
      isSupportConsignIssuing: sanitizeOfferSourcePayloadV1(
        signs?.isSupportConsignIssuing,
        [...path, 'isSupportConsignIssuing'],
        true,
      ),
    };
  }
  if (
    preserveOfferCoreAuthorityValues
    &&
    (
      typeof value === 'string'
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
    )
    && OFFER_CORE_AUTHORITY_VALUE_PATHS.some((authorityPath) =>
      authorityPath.length === path.length
      && authorityPath.every((segment, index) => segment === path[index]))
  ) {
    return value;
  }
  const key = path.at(-1);
  const normalizedKey = key?.toLowerCase().replace(/[^a-z0-9]/gu, '') ?? '';
  if (
    (
      /(?:authorization|cookie|password|secret|token|signature|^sign|mh5tk|headers)/u
        .test(normalizedKey)
      || /(?:contact|mobile|phone|telephone|email|wechat|wangwang|identitycard|idcard|bankaccount|principal|legalperson|legalrepresentative)/u
        .test(normalizedKey)
    )
  ) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    const piiRedacted = redactEmbeddedPiiV1(value);
    if (piiRedacted !== value) {
      return piiRedacted;
    }
    if (/^\+?\d[\d\s()-]{6,}\d$/u.test(value)) {
      return '[redacted]';
    }
    if (/^https?:\/\//iu.test(value)) {
      try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        url.hash = '';
        for (const queryKey of [...url.searchParams.keys()]) {
          if (!['api', 'v', 'version', 'type', 'method'].includes(queryKey.toLowerCase())) {
            url.searchParams.delete(queryKey);
          }
        }
        url.searchParams.sort();
        return url.toString();
      } catch {
        return '[redacted-url]';
      }
    }
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitizeOfferSourcePayloadV1(
        item,
        [...path, String(index)],
        preserveOfferCoreAuthorityValues,
      ));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .map(([childKey, child]) => [
        childKey,
        sanitizeOfferSourcePayloadV1(
          child,
          [...path, childKey],
          preserveOfferCoreAuthorityValues,
        ),
      ]),
  );
}

function redactEmbeddedPiiV1(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted]')
    .replace(
      /(^|[^\d])(?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8}(?!\d)/gu,
      '$1[redacted]',
    )
    .replace(/(^|[^\d])\+\d[\d\s()-]{6,}\d(?!\d)/gu, '$1[redacted]')
    .replace(/\b\d{17}[\dX]\b/giu, '[redacted]')
    .replace(/\b\d{16,19}\b/gu, '[redacted]')
    .replace(
      /((?:phone|mobile|telephone|tel|wechat|weixin|手机|电话|联系方式|微信)\s*[:：=-]?\s*)\+?[\d\s()-]{7,}\d/giu,
      '$1[redacted]',
    );
}

function assertRegisteredAuthoritativeEmpty(
  source: OfferSourceKindV1,
  empty: { sourcePath: string; sourceValue: unknown; reasonCode: string },
): void {
  const registered = registeredAbsenceSentinel(source, empty);
  const valueMatches = registered?.valueKind === 'false'
    ? empty.sourceValue === false
    : registered?.valueKind === 'structurally-empty'
      && isStructurallyEmpty(empty.sourceValue);
  if (!valueMatches) {
    throw new TypeError(`${source} authoritative-empty proof is not a registered versioned sentinel.`);
  }
}

function isRegisteredAbsenceProof(
  source: OfferSourceKindV1,
  proof: { sourcePath: string; reasonCode: string; sourceValueHash?: string },
): boolean {
  const registered = registeredAbsenceSentinel(source, proof);
  if (registered === undefined) return false;
  if (proof.sourceValueHash === undefined) return true;
  return registered.valueKind === 'false'
    ? proof.sourceValueHash === evidenceHash(false)
    : REGISTERED_EMPTY_VALUE_HASHES.has(proof.sourceValueHash);
}

function registeredAbsenceSentinel(
  source: OfferSourceKindV1,
  proof: { sourcePath: string; reasonCode: string },
) {
  return OFFER_SOURCE_EMPTY_SENTINELS[source].find(
    (registered) =>
      registered.sourcePath === proof.sourcePath
      && registered.reasonCode === proof.reasonCode,
  );
}

function assertOfferCoreSidecarAuthority(artifact: OfferSourceSidecarV1): void {
  if (artifact.authoritySource === undefined) return;
  const expectedEvidence = offerCoreAuthorityEvidence(artifact.offerId, artifact.memberId);
  if (
    artifact.authoritySource !== 'offer-core'
    || artifact.source !== 'offer-consignment'
    || artifact.authorityEvidence === undefined
    || evidenceHash(artifact.authorityEvidence)
      !== evidenceHash(expectedEvidence)
    || !offerCoreAuthorityPayloadMatches(
      artifact.sanitizedRawPayload,
      artifact.offerId,
      artifact.memberId,
      true,
    )
  ) {
    throw new TypeError('Offer core Consignment sidecar authority is invalid.');
  }
}

function offerCoreAuthorityPayloadMatches(
  payload: unknown,
  offerId: string,
  memberId: string,
  requireNestedIssuingSignal: boolean,
): boolean {
  const model = objectAt(
    payload,
    ['contextResult', 'global', 'globalData', 'model'],
  );
  const gallery = objectAt(
    payload,
    ['contextResult', 'data', 'gallery', 'fields'],
  );
  const seller = recordOrNull(model?.sellerModel);
  const consign = recordOrNull(model?.consignModel);
  const consignSign = recordOrNull(consign?.consignSign);
  const signs = recordOrNull(consignSign?.signs);
  return stringOrNull(gallery?.offerId) === offerId
    && stringOrNull(seller?.memberId) === memberId
    && consign?.consignOffer === false
    && consign?.hasConsignPrice === false
    && consignSign?.supportConsignIssuing === false
    && (
      !requireNestedIssuingSignal
      || signs?.isSupportConsignIssuing === false
    );
}

function offerCoreAuthorityEvidence(
  offerId: string,
  memberId: string,
): NonNullable<OfferSourceSidecarV1['authorityEvidence']> {
  return {
    schema: 'collector.offer-core-consignment-authority.v1',
    sourcePath: 'contextResult.global.globalData.model.consignModel.consignOffer',
    sourceValue: false,
    offerId,
    memberId,
    supportingSignals: {
      hasConsignPrice: false,
      supportConsignIssuing: false,
      isSupportConsignIssuing: false,
    },
  };
}

function isStructurallyEmpty(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && value !== null && Object.keys(value).length === 0;
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new TypeError(`${field} is invalid.`);
  return trimmed;
}

function optionalId(value: string | null, field: string): string | null {
  return value === null ? null : requiredId(value, field);
}

function evidenceHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalizeEvidence(value)), 'utf8').digest('hex')}`;
}

function canonicalizeEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeEvidence);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalizeEvidence(record[key])]),
    );
  }
  return value;
}

const REGISTERED_EMPTY_VALUE_HASHES = new Set(
  [null, [], {}].map((value) => evidenceHash(value)),
);

const SHOP_BADGES: Record<string, { label: string; imageUrl: string }> = {
  cjgc_global: {
    label: '超级工厂全球供',
    imageUrl:
      'https://img.alicdn.com/imgextra/i4/O1CN014ntq3r24nkFVzJqfW_!!6000000007436-55-tps-106-16.svg',
  },
  slsj: {
    label: '实力商家',
    imageUrl:
      'https://img.alicdn.com/imgextra/i2/O1CN01OBjMFF1f96iPN27qq_!!6000000003963-55-tps-78-20.svg',
  },
  ytqj: {
    label: '源头旗舰',
    imageUrl:
      'https://img.alicdn.com/imgextra/i1/O1CN01Ev234b26zJUUSp7eQ_!!6000000007732-55-tps-84-20.svg',
  },
};

export function mapShopCardPayload(payload: unknown): ShopCardInfo | null {
  const data = objectAt(payload, ['data']);
  if (!data) return null;
  const model = objectAt(data, ['model']);
  if (model) return mapModernShopCard(model);
  return mapLegacyShopCard(data);
}

function mapModernShopCard(model: Record<string, unknown>): ShopCardInfo | null {
  const metrics = arrayAt(model, ['shopData'])
    .map((raw) => {
      const item = recordOrNull(raw);
      if (!item) return null;
      const key = stringOrNull(item.dataKey);
      if (!key) return null;
      const valueText = stringOrNull(item.dataValue);
      return {
        key,
        valueText,
        value: numberOrNull(valueText),
        unit: stringOrNull(item.unit),
      } satisfies ShopCardMetric;
    })
    .filter((item): item is ShopCardMetric => item !== null);
  const metric = (key: string) => metrics.find((item) => item.key === key);
  const iconType = stringOrNull(model.iconType);
  const knownBadge = iconType ? SHOP_BADGES[iconType] : undefined;
  const shopButton = objectAt(model, ['shopButton']);
  const serviceScore = metric('店铺服务分')?.value ?? null;
  const badge = iconType
    ? {
        code: iconType,
        label: knownBadge?.label ?? null,
        imageUrl: knownBadge?.imageUrl ?? null,
      }
    : null;
  const info: ShopCardInfo = {
    name: stringOrNull(model.shopName),
    url: normalizeUrl(stringOrNull(model.shopUrl)),
    shopType: stringOrNull(model.shopType),
    iconType,
    badge,
    mainCategoryName: stringOrNull(model.mainCategoryName),
    years: parseInteger(model.tpYear),
    attention: {
      isFollowing: booleanOrNull(shopButton?.attentionRelation),
      followersText: stringOrNull(shopButton?.fuzzyFavCount),
      operationType: stringOrNull(shopButton?.type),
    },
    metrics,
    returnRate: percentRatio(metric('店铺回头率')?.valueText),
    serviceScore,
    onTimeDeliveryRate: percentRatio(metric('准时发货率')?.valueText),
    positiveReviewRate: percentRatio(metric('店铺好评率')?.valueText),
    companyId: null,
    companyLabel: badge?.label ?? null,
    companyIcons: badge?.imageUrl
      ? [{ title: badge.label ?? badge.code, link: badge.imageUrl }]
      : [],
    shopTags: [],
    factoryCardUrl: null,
    factoryAuthText: null,
    serviceScores:
      serviceScore === null
        ? []
        : [{ key: 'shop_service_score', label: 'shop', score: serviceScore }],
  };
  return hasShopCardEvidence(info) ? info : null;
}

function mapLegacyShopCard(data: Record<string, unknown>): ShopCardInfo | null {
  const factoryInfo = objectAt(data, ['factoryInfo']);
  const shopProperty = objectAt(factoryInfo, ['shopProperty']);
  const appData = objectAt(data, ['appData']);
  const lindormData = objectAt(data, ['lindormDataModel']);
  const appServices = arrayAt(appData, ['serviceList']);
  const serviceRaw = appServices.length
    ? appServices
    : arrayAt(lindormData, ['serviceStarList']);
  const serviceScores = serviceRaw
    .map(mapServiceScore)
    .filter((score) => score.key);
  const companyLabel = stringOrNull(data.companyLabel);
  const info: ShopCardInfo = {
    name: stringOrNull(data.companyName),
    url: normalizeUrl(stringOrNull(data.shopUrl)),
    shopType: null,
    iconType: null,
    badge: companyLabel
      ? { code: companyLabel, label: companyLabel, imageUrl: null }
      : null,
    mainCategoryName: null,
    years: null,
    attention: {
      isFollowing: null,
      followersText: null,
      operationType: null,
    },
    metrics: [],
    returnRate:
      percentRatio(data.retentionRate) ?? numberOrNull(data.retentionRate),
    serviceScore: null,
    onTimeDeliveryRate: null,
    positiveReviewRate: null,
    companyId: stringOrNull(data.companyId),
    companyLabel,
    companyIcons: arrayAt(data, ['companyIcons'])
      .map((raw) => {
        const item = recordOrNull(raw);
        return {
          title: stringOrNull(item?.title) ?? '',
          link: normalizeUrl(stringOrNull(item?.link)),
        };
      })
      .filter((item) => item.title),
    shopTags: arrayAt(factoryInfo, ['shopTag'])
      .map((raw) => stringOrNull(recordOrNull(raw)?.text))
      .filter((text): text is string => text !== null),
    factoryCardUrl: normalizeUrl(
      stringOrNull(shopProperty?.pcLinkUrl) ??
        stringOrNull(shopProperty?.linkUrl),
    ),
    factoryAuthText: stringOrNull(shopProperty?.authText),
    serviceScores,
  };
  return hasShopCardEvidence(info) ? info : null;
}

export function mapConsignmentPayload(
  payload: unknown,
  requestUrl?: string,
): ConsignmentInfo | null {
  const candidates = [
    objectAt(payload, ['data', 'data', 'data', 'data']),
    objectAt(payload, ['data', 'data', 'data']),
  ];
  const data = candidates.find(
    (candidate) =>
      candidate &&
      (stringOrNull(candidate.name) ||
        arrayAt(candidate, ['adviseList']).length > 0 ||
        arrayAt(candidate, ['priceInfoList']).length > 0 ||
        arrayAt(candidate, ['operateButtonList']).length > 0 ||
        arrayAt(candidate, ['protectionInfoList']).length > 0 ||
        arrayAt(candidate, ['supportList']).length > 0),
  );
  if (!data) return null;
  const metrics = arrayAt(data, ['adviseList'])
    .map((raw) => {
      const item = recordOrNull(raw);
      const key = stringOrNull(item?.key);
      if (!key) return null;
      return {
        key,
        name: stringOrNull(item?.name),
        valueText: stringOrNull(item?.value),
      } satisfies ConsignmentMetric;
    })
    .filter((item): item is ConsignmentMetric => item !== null);
  const metricText = (key: string) =>
    metrics.find((item) => item.key === key)?.valueText ?? null;
  const prices = arrayAt(data, ['priceInfoList']).map((raw) => {
    const item = recordOrNull(raw);
    const text = stringOrNull(item?.text);
    return {
      text,
      price: numberOrNull(item?.price),
      minimumQuantity: parseMinimumQuantity(text),
    } satisfies ConsignmentPrice;
  });
  const quantities = prices
    .map((item) => item.minimumQuantity)
    .filter((value): value is number => value !== null);
  const minimumQuantity = quantities.length ? Math.min(...quantities) : null;
  const onePiecePrice =
    prices.find((item) => item.minimumQuantity === 1)?.price ?? null;
  const operations = arrayAt(data, ['operateButtonList']).map((raw) => {
    const item = recordOrNull(raw);
    return {
      name: stringOrNull(item?.name),
      operationType: stringOrNull(item?.operateType),
      displayStatus: stringOrNull(item?.operateDisplayStatus),
      buttonType: stringOrNull(item?.buttonType),
      displayType: stringOrNull(item?.disType),
      imageUrl: normalizeUrl(stringOrNull(item?.imgUrl)),
      backgroundColor: stringOrNull(item?.backgroundColor),
    } satisfies ConsignmentOperation;
  });
  const protections = arrayAt(data, ['protectionInfoList']).map((raw) => {
    const item = recordOrNull(raw);
    return {
      serviceName: stringOrNull(item?.serviceName),
      description: stringOrNull(item?.description),
      actions: arrayAt(item, ['actions']).map((actionRaw) => {
        const action = recordOrNull(actionRaw);
        return {
          text: stringOrNull(action?.text),
          url: normalizeUrl(stringOrNull(action?.url)),
          appUrl: normalizeUrl(stringOrNull(action?.appUrl)),
        };
      }),
    } satisfies ConsignmentProtection;
  });
  const supportedChannels = arrayAt(data, ['supportList']).map((raw) => {
    const item = recordOrNull(raw);
    return {
      name: stringOrNull(item?.name),
      iconUrl: normalizeUrl(stringOrNull(item?.icon)),
    };
  });
  const name = stringOrNull(data.name);
  if (
    !name &&
    metrics.length === 0 &&
    prices.length === 0 &&
    operations.length === 0 &&
    protections.length === 0 &&
    supportedChannels.length === 0
  ) {
    return null;
  }
  return {
    name,
    offerFlags: parseOfferModelSignFromUrl(requestUrl),
    metrics,
    orderCount30dText: metricText('orderCnt30d'),
    orderCount7dText: metricText('orderCnt7d'),
    delivery24hRate: percentRatio(metricText('offerDelivery24hRate')),
    delivery48hRate: percentRatio(metricText('offerDelivery48hRate')),
    downstreamListingCountText: metricText('outDistributeCnt'),
    distributorCountText: metricText('distributorCnt'),
    offerPublishedAtText: metricText('offerPublishDate'),
    prices,
    minimumQuantity,
    onePieceEligible:
      minimumQuantity === null ? null : minimumQuantity <= 1,
    onePiecePrice,
    operations,
    protections,
    supportedChannels,
  };
}

export function parseOfferModelSignFromUrl(
  requestUrl: string | undefined,
): Record<string, boolean> {
  if (!requestUrl) return {};
  try {
    const dataText = new URL(requestUrl).searchParams.get('data');
    if (!dataText) return {};
    const data = JSON.parse(dataText) as {
      mmgaRequest?: { offerModelSign?: Record<string, unknown> };
    };
    const flags: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(
      data.mmgaRequest?.offerModelSign ?? {},
    )) {
      if (typeof value === 'boolean') flags[key] = value;
    }
    return flags;
  } catch {
    return {};
  }
}

function hasShopCardEvidence(info: ShopCardInfo): boolean {
  return !!(
    info.name ||
    info.url ||
    info.companyId ||
    info.companyLabel ||
    info.mainCategoryName ||
    info.metrics.length ||
    info.companyIcons.length ||
    info.shopTags.length ||
    info.factoryCardUrl ||
    info.serviceScores.length
  );
}

function mapServiceScore(raw: unknown): SupplierServiceScore {
  const item = recordOrNull(raw);
  const key = stringOrNull(item?.serviceKey) ?? '';
  return {
    key,
    label: serviceScoreLabel(key),
    score: numberOrNull(item?.score),
  };
}

function serviceScoreLabel(key: string): string {
  const labels: Record<string, string> = {
    cst_group_value_new: 'response',
    lgt_group_value_new: 'logistics',
    dspt_group_value: 'dispute',
    goods_group_value: 'goods',
    rdf_group_value_new: 'repurchase',
  };
  return labels[key] ?? key;
}

function parseMinimumQuantity(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/(?:>=|>|\u2265)?\s*(\d+)\s*\u4ef6/);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

function percentRatio(value: unknown): number | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number / 100 : null;
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
  return recordOrNull(current);
}

function arrayAt(value: unknown, path: string[]): unknown[] {
  const parent = path.length ? objectAt(value, path.slice(0, -1)) : value;
  const key = path.at(-1);
  const result =
    key && parent && typeof parent === 'object'
      ? (parent as Record<string, unknown>)[key]
      : parent;
  return Array.isArray(result) ? result : [];
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = stringOrNull(value);
  if (!text) return null;
  const number = Number(text.replace(/,/g, '').replace('%', ''));
  return Number.isFinite(number) ? number : null;
}

function parseInteger(value: unknown): number | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const match = text.match(/\d+/);
  return match?.[0] ? parseInt(match[0], 10) : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizeUrl(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}
import { createHash } from 'node:crypto';
import type { CollectorErrorV1 } from '../collection/page-action-contracts.js';
