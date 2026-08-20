import type { BrowserContext, Page } from 'playwright';
import { CliError } from '../io/errors.js';
import { buildStoreCatalogUrl } from '../commands/supplier-catalog.js';
import {
  clickImOfferShareButton,
  clickImSendButton,
  countImOfferCards,
  findImInput,
  findRecentOwnOfferCard,
  findRecentOwnTextMessage,
  waitForConversationActivated,
  waitForNewImOfferCard,
  waitForOwnTextMessage,
} from './im-locators.js';
import {
  assertStoreSampleProfileObservationV1,
  parseStoreProfileMemberAuthorityV1,
  waitForStoreCatalogRuntime,
  type StoreSampleProfileObservationV1,
} from './catalog-runtime.js';
import { waitForCollectionPageAvailability } from './recovery.js';
import {
  assertStoreProfilePayloadState,
  captureStoreProfileForAction,
  requestStoreProfileFromPage,
} from './store-profile-capture.js';
import { mapStoreProfilePayload } from './store-profile.js';

export const SUPPLIER_INQUIRY_ACTIONS = Object.freeze([
  'open_store_conversation',
  'share_offer',
  'send_text',
  'read_messages',
] as const);

export type SupplierInquiryAction = (typeof SUPPLIER_INQUIRY_ACTIONS)[number];

export interface SupplierInquiryActionInput {
  readonly action: SupplierInquiryAction;
  readonly conversationScope: 'store' | 'offer';
  readonly idempotencyKey: string;
  readonly canonicalStoreId?: string;
  readonly memberId: string;
  readonly normalizedStoreUrl: string;
  readonly offerId?: string;
  readonly text?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly timeoutMs?: number;
}

export interface SupplierInquiryMessage {
  readonly cid: string;
  readonly messageId: string;
  readonly sender: 'seller';
  readonly type: 'text' | 'product_card' | 'conversation_event';
  readonly text: string | null;
  readonly offerId: string | null;
  readonly occurredAt: string;
  readonly cursorAfter: string;
  readonly card?: Readonly<{
    title: string | null;
    price: string | null;
    image: string | null;
    url: string | null;
  }>;
}

export interface SupplierInquiryActionExecutionOptions {
  readonly allowExternalSideEffect?: boolean;
  readonly persistRawEvidence: (payload: unknown) => Promise<string>;
}

export interface SupplierInquiryActionResult {
  readonly action: SupplierInquiryAction;
  readonly idempotencyKey: string;
  readonly conversation: Readonly<{
    canonicalStoreId: string;
    memberId: string;
    normalizedStoreUrl: string;
    observedMemberId: string;
    observedStoreUrl: string;
    identityRawEvidenceRef: string;
    activationUrl: string;
    activationVerifiedAt: string;
    cid: string | null;
    scope: 'store' | 'offer';
    offerId: string | null;
    directUrl: string;
  }>;
  readonly openedAt?: string;
  readonly sentAt?: string;
  readonly messageId?: string;
  readonly cardAnchorId?: string;
  readonly offerId?: string;
  readonly card?: Readonly<{
    offerId: string;
    title: string | null;
    price: string | null;
    image: string | null;
    url: string | null;
    domSha256: string;
  }>;
  readonly replayed?: boolean;
  readonly messages?: readonly SupplierInquiryMessage[];
  readonly nextCursor?: string | null;
}

export interface SupplierInquiryWsFrame {
  readonly direction: 'sent' | 'received';
  readonly method: string;
  readonly mid: string | null;
  readonly payload: string;
}

export interface ParsedImMessage {
  readonly cid: string;
  readonly messageId: string;
  readonly senderNick: string | null;
  readonly receiverNick: string | null;
  readonly senderName: string;
  readonly occurredAt: string;
  readonly type: 'text' | 'product_card' | 'conversation_event';
  readonly text: string | null;
  readonly offerId: string | null;
  readonly card?: SupplierInquiryMessage['card'];
}

interface SupplierInquiryCursorV1 {
  readonly schema: 'supplier-inquiry-message-cursor.v1';
  readonly cid: string;
  readonly messageId: string;
}

const IM_BASE =
  'https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html';

export function buildSupplierConversationUrl(input: {
  memberId: string;
  offerId?: string;
}): string {
  const memberId = requiredText(input.memberId, 'memberId', 256);
  const offerId = input.offerId === undefined
    ? undefined
    : numericId(input.offerId, 'offerId');
  const url = new URL(IM_BASE);
  url.searchParams.set('touid', `cnalichn${memberId}`);
  url.searchParams.set('siteid', 'cnalichn');
  url.searchParams.set('status', '1');
  url.searchParams.set('portalId', '');
  url.searchParams.set('gid', '');
  url.searchParams.set('offerId', offerId ?? '');
  url.searchParams.set('itemsId', '');
  url.searchParams.set('orderId', '');
  url.hash = '/';
  return url.toString();
}

export function encodeSupplierInquiryCursor(input: {
  cid: string;
  messageId: string;
}): string {
  const cursor: SupplierInquiryCursorV1 = {
    schema: 'supplier-inquiry-message-cursor.v1',
    cid: requiredText(input.cid, 'cursor.cid', 512),
    messageId: requiredText(input.messageId, 'cursor.messageId', 512),
  };
  return `im-v1:${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`;
}

export function decodeSupplierInquiryCursor(value: string): SupplierInquiryCursorV1 {
  if (!value.startsWith('im-v1:')) {
    throw new TypeError('Supplier inquiry cursor must use the im-v1 format.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice('im-v1:'.length), 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('Supplier inquiry cursor payload is invalid.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Supplier inquiry cursor payload must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (record['schema'] !== 'supplier-inquiry-message-cursor.v1') {
    throw new TypeError('Supplier inquiry cursor schema is unsupported.');
  }
  return {
    schema: 'supplier-inquiry-message-cursor.v1',
    cid: requiredText(record['cid'], 'cursor.cid', 512),
    messageId: requiredText(record['messageId'], 'cursor.messageId', 512),
  };
}

export function parseSupplierInquiryWsFrames(
  frames: readonly SupplierInquiryWsFrame[],
): readonly ParsedImMessage[] {
  const requestMethods = new Map<string, string>();
  const requestedCids = new Map<string, string>();
  for (const frame of frames) {
    if (frame.direction !== 'sent' || frame.mid === null) continue;
    requestMethods.set(frame.mid, frame.method);
    if (frame.method !== '/r/MessageManager/listUserMessages') continue;
    try {
      const body = (JSON.parse(frame.payload) as { body?: unknown }).body;
      if (Array.isArray(body) && typeof body[0] === 'string') {
        requestedCids.set(frame.mid, body[0]);
      }
    } catch {
      // Malformed non-authoritative frames are ignored.
    }
  }

  const messages = new Map<string, ParsedImMessage>();
  for (const frame of frames) {
    if (
      frame.direction !== 'received'
      || frame.mid === null
      || requestMethods.get(frame.mid) !== '/r/MessageManager/listUserMessages'
    ) continue;
    let body: unknown;
    try {
      body = (JSON.parse(frame.payload) as { body?: unknown }).body;
    } catch {
      continue;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) continue;
    const models = (body as Record<string, unknown>)['userMessageModels'];
    if (!Array.isArray(models)) continue;
    const requestedCid = requestedCids.get(frame.mid);
    for (const model of models) {
      const parsed = parseMessageModel(model, requestedCid);
      if (parsed !== null) messages.set(`${parsed.cid}:${parsed.messageId}`, parsed);
    }
  }
  return Object.freeze([...messages.values()].sort(compareMessages));
}

export function messagesAfterSupplierInquiryCursor(
  messages: readonly ParsedImMessage[],
  cursorValue: string | null | undefined,
  limit: number,
): Readonly<{
  messages: readonly ParsedImMessage[];
  nextCursor: string | null;
}> {
  const boundedLimit = positiveInteger(limit, 'limit', 200);
  const cursor = cursorValue === null || cursorValue === undefined
    ? null
    : decodeSupplierInquiryCursor(cursorValue);
  let candidates = [...messages];
  if (cursor !== null) {
    const sameConversation = candidates.filter((message) => message.cid === cursor.cid);
    const exactIndex = sameConversation.findIndex(
      (message) => message.messageId === cursor.messageId,
    );
    if (exactIndex >= 0) {
      candidates = sameConversation.slice(exactIndex + 1);
    } else if (/^\d+$/.test(cursor.messageId) && sameConversation.every(
      (message) => /^\d+$/.test(message.messageId),
    )) {
      const cursorId = BigInt(cursor.messageId);
      candidates = sameConversation.filter((message) => BigInt(message.messageId) > cursorId);
    } else if (sameConversation.length === 0) {
      candidates = [];
    } else {
      throw new TypeError('Supplier inquiry cursor message is outside the bounded history window.');
    }
  }
  const selected = Object.freeze(candidates.slice(0, boundedLimit));
  const last = selected.at(-1);
  return Object.freeze({
    messages: selected,
    nextCursor: last === undefined
      ? cursorValue ?? null
      : encodeSupplierInquiryCursor(last),
  });
}

export async function executeSupplierInquiryAction(
  context: BrowserContext,
  inputValue: SupplierInquiryActionInput,
  options?: SupplierInquiryActionExecutionOptions,
): Promise<SupplierInquiryActionResult> {
  if (options === undefined) {
    throw new CliError(
      2,
      'MANAGED_SUPPLIER_INQUIRY_REQUIRED',
      'Supplier inquiry actions require the fenced production daemon and durable evidence authority.',
      { category: 'contract', retryable: false },
    );
  }
  const input = validateActionInput(inputValue);
  const page = await context.newPage();
  const frames: SupplierInquiryWsFrame[] = [];
  captureWsFrames(page, frames);
  try {
    const storeIdentity = await verifySupplierStoreIdentity(page, input, options);
    const directUrl = buildSupplierConversationUrl({
      memberId: input.memberId,
      ...(input.conversationScope === 'offer' ? { offerId: input.offerId } : {}),
    });
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (/login\.(?:1688|taobao)\.com/.test(page.url())) {
      throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
    }
    const editor = await findImInput(page);
    await waitForConversationActivated(page, input.memberId, {});
    const activation = verifyActivatedConversationTarget(page.url(), input);
    const conversation = () => ({
      canonicalStoreId: input.canonicalStoreId,
      memberId: input.memberId,
      normalizedStoreUrl: input.normalizedStoreUrl,
      observedMemberId: storeIdentity.memberId,
      observedStoreUrl: storeIdentity.canonicalShopUrl,
      identityRawEvidenceRef: storeIdentity.rawEvidenceRef,
      activationUrl: activation.url,
      activationVerifiedAt: activation.verifiedAt,
      cid: latestConversationId(frames),
      scope: input.conversationScope,
      offerId: input.offerId ?? null,
      directUrl,
    } as const);

    if (input.action === 'open_store_conversation') {
      return Object.freeze({
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        conversation: conversation(),
        openedAt: new Date().toISOString(),
      });
    }
    if (input.action === 'share_offer') {
      const existing = await findRecentOwnOfferCard(page, input.offerId!);
      if (existing !== null) {
        return Object.freeze({
          action: input.action,
          idempotencyKey: input.idempotencyKey,
          conversation: conversation(),
          offerId: existing.offerId,
          cardAnchorId: existing.cardAnchorId,
          messageId: latestOwnOfferMessage(frames, input.memberId, existing.offerId)?.messageId
            ?? existing.cardAnchorId,
          sentAt: existing.observedAt,
          replayed: true,
          card: cardResult(existing),
        });
      }
      if (options.allowExternalSideEffect === false) {
        throw new CliError(
          24,
          'SUPPLIER_INQUIRY_OUTCOME_UNKNOWN',
          'The prior offer-card action has no durable result and no matching card is observable; refusing a second send.',
          { category: 'protocol', retryable: false, idempotencyKey: input.idempotencyKey },
        );
      }
      const previousCardCount = await countImOfferCards(page);
      await clickImOfferShareButton(page);
      const card = await waitForNewImOfferCard(page, previousCardCount, input.offerId!);
      return Object.freeze({
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        conversation: conversation(),
        offerId: card.offerId,
        cardAnchorId: card.cardAnchorId,
        messageId: latestOwnOfferMessage(frames, input.memberId, card.offerId)?.messageId
          ?? card.cardAnchorId,
        sentAt: card.observedAt,
        card: cardResult(card),
      });
    }
    if (input.action === 'send_text') {
      const existing = await findRecentOwnTextMessage(page, input.text!);
      if (existing !== null) {
        return Object.freeze({
          action: input.action,
          idempotencyKey: input.idempotencyKey,
          conversation: conversation(),
          messageId: existing.anchorId,
          sentAt: existing.observedAt,
          replayed: true,
        });
      }
      if (options.allowExternalSideEffect === false) {
        throw new CliError(
          24,
          'SUPPLIER_INQUIRY_OUTCOME_UNKNOWN',
          'The prior text-send action has no durable result and no matching message is observable; refusing a second send.',
          { category: 'protocol', retryable: false, idempotencyKey: input.idempotencyKey },
        );
      }
      await editor.click({ force: true });
      await editor.fill('');
      await page.keyboard.type(input.text!, { delay: 20 });
      await clickImSendButton(page);
      const sent = await waitForOwnTextMessage(page, input.text!);
      return Object.freeze({
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        conversation: conversation(),
        messageId: latestOwnMessage(frames, input.memberId)?.messageId ?? sent.anchorId,
        sentAt: sent.observedAt,
      });
    }

    await waitForMessageBatch(frames, input.timeoutMs!);
    const allMessages = parseSupplierInquiryWsFrames(frames);
    const sellerMessages = allMessages.flatMap((message) => {
      const sender = classifyConversationMessage(message, input.memberId);
      if (sender === 'seller') return [message];
      if (sender === 'self') return [];
      throw new CliError(
        24,
        'MESSAGE_SENDER_UNATTRIBUTED',
        `Message ${message.messageId} has no reliable sender identity in conversation ${message.cid}.`,
        {
          category: 'protocol',
          retryable: false,
          messageId: message.messageId,
          cid: message.cid,
        },
      );
    });
    const bounded = messagesAfterSupplierInquiryCursor(
      sellerMessages,
      input.cursor,
      input.limit!,
    );
    const messages = bounded.messages.map((message) => {
      const cursorAfter = encodeSupplierInquiryCursor(message);
      return Object.freeze({
        cid: message.cid,
        messageId: message.messageId,
        sender: 'seller' as const,
        type: message.type,
        text: message.text,
        offerId: message.offerId,
        occurredAt: message.occurredAt,
        cursorAfter,
        ...(message.card === undefined ? {} : { card: message.card }),
      });
    });
    const lastObserved = allMessages.at(-1);
    const nextCursor = bounded.nextCursor
      ?? (lastObserved === undefined ? input.cursor ?? null : encodeSupplierInquiryCursor(lastObserved));
    return Object.freeze({
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      conversation: conversation(),
      messages: Object.freeze(messages),
      nextCursor,
    });
  } finally {
    await page.close().catch(() => undefined);
  }
}

export const execute = executeSupplierInquiryAction;

async function verifySupplierStoreIdentity(
  page: Page,
  input: SupplierInquiryActionInput,
  options: SupplierInquiryActionExecutionOptions,
): Promise<Readonly<StoreSampleProfileObservationV1 & { rawEvidenceRef: string }>> {
  const navigationUrl = buildStoreCatalogUrl(input.normalizedStoreUrl, { sort: 'wangpu_score' });
  await page.goto(navigationUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (/login\.(?:1688|taobao)\.com/u.test(page.url())) {
    throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
  }
  await waitForCollectionPageAvailability(page, { headed: true });
  await waitForStoreCatalogRuntime(page, { timeoutMs: 15_000 });
  const captured = await captureStoreProfileForAction(
    page,
    { memberId: input.memberId, timeoutMs: 15_000 },
    () => requestStoreProfileFromPage(page, input.memberId, {
      runtimeReadyTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
    }),
  );
  if (captured.captured === null) {
    throw new CliError(
      9,
      'SUPPLIER_CONVERSATION_STORE_IDENTITY_UNVERIFIED',
      'The target store did not expose an authoritative member and canonical shop identity.',
      { category: 'protocol', retryable: false },
    );
  }
  assertStoreProfilePayloadState(captured.captured.payload, captured.diagnostics);
  const rawEvidenceRef = await options.persistRawEvidence(captured.captured.payload);
  const profile = mapStoreProfilePayload(
    captured.captured.payload,
    captured.captured.collectedAt,
    { sourceRef: captured.captured.sourceRef, rawRef: rawEvidenceRef },
  );
  const observation: StoreSampleProfileObservationV1 = {
    ...parseStoreProfileMemberAuthorityV1(captured.captured.payload, profile.source),
    canonicalShopUrl: input.normalizedStoreUrl,
    observedAt: captured.captured.collectedAt,
    profile,
  };
  assertStoreSampleProfileObservationV1(
    observation,
    input.memberId,
    input.normalizedStoreUrl,
  );
  return Object.freeze({ ...observation, rawEvidenceRef });
}

function cardResult(card: Readonly<{
  offerId: string;
  title: string | null;
  price: string | null;
  image: string | null;
  url: string | null;
  domSha256: string;
}>): NonNullable<SupplierInquiryActionResult['card']> {
  return Object.freeze({
    offerId: card.offerId,
    title: card.title,
    price: card.price,
    image: card.image,
    url: card.url,
    domSha256: card.domSha256,
  });
}

function verifyActivatedConversationTarget(
  observedUrl: string,
  input: SupplierInquiryActionInput,
): Readonly<{ url: string; verifiedAt: string }> {
  const url = new URL(observedUrl);
  const expectedOfferId = input.conversationScope === 'offer' ? input.offerId ?? '' : '';
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'air.1688.com'
    || url.searchParams.get('touid') !== `cnalichn${input.memberId}`
    || url.searchParams.get('siteid') !== 'cnalichn'
    || (url.searchParams.get('offerId') ?? '') !== expectedOfferId
  ) {
    throw new CliError(
      26,
      'SUPPLIER_CONVERSATION_IDENTITY_MISMATCH',
      'The activated conversation URL does not match the verified target store/member binding.',
      {
        category: 'protocol',
        retryable: false,
        observedUrl,
        expectedMemberId: input.memberId,
        expectedOfferId,
      },
    );
  }
  return Object.freeze({ url: url.toString(), verifiedAt: new Date().toISOString() });
}

function validateActionInput(input: SupplierInquiryActionInput): SupplierInquiryActionInput & {
  canonicalStoreId: string;
  limit: number;
  timeoutMs: number;
} {
  if (!SUPPLIER_INQUIRY_ACTIONS.includes(input.action)) {
    throw new TypeError('Supplier inquiry action is invalid.');
  }
  const canonicalStoreId = requiredUuid(input.canonicalStoreId, 'canonicalStoreId');
  const memberId = requiredText(input.memberId, 'memberId', 256);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey', 1_024);
  let normalizedStoreUrl: string;
  try {
    normalizedStoreUrl = new URL(input.normalizedStoreUrl).toString();
  } catch {
    throw new TypeError('normalizedStoreUrl must be an absolute URL.');
  }
  const offerId = input.offerId === undefined ? undefined : numericId(input.offerId, 'offerId');
  if (input.action === 'open_store_conversation' && input.conversationScope !== 'store') {
    throw new TypeError('open_store_conversation requires store scope.');
  }
  if (input.conversationScope === 'offer' && offerId === undefined) {
    throw new TypeError('Offer-scoped supplier inquiry action requires offerId.');
  }
  if (input.action === 'share_offer' && input.conversationScope !== 'offer') {
    throw new TypeError('share_offer requires offer scope.');
  }
  const text = input.action === 'send_text'
    ? requiredText(input.text, 'text', 500)
    : input.text;
  const limit = positiveInteger(input.limit ?? 50, 'limit', 200);
  const timeoutMs = positiveInteger(input.timeoutMs ?? 15_000, 'timeoutMs', 30_000);
  if (input.cursor !== undefined && input.cursor !== null) decodeSupplierInquiryCursor(input.cursor);
  return Object.freeze({
    ...input,
    canonicalStoreId,
    idempotencyKey,
    memberId,
    normalizedStoreUrl,
    ...(offerId === undefined ? {} : { offerId }),
    ...(text === undefined ? {} : { text }),
    limit,
    timeoutMs,
  });
}

function captureWsFrames(page: Page, frames: SupplierInquiryWsFrame[]): void {
  page.on('websocket', (socket) => {
    const append = (direction: SupplierInquiryWsFrame['direction'], raw: string | Buffer): void => {
      const payload = typeof raw === 'string' ? raw : raw.toString();
      let method = '';
      let mid: string | null = null;
      try {
        const frame = JSON.parse(payload) as { lwp?: unknown; headers?: { mid?: unknown } };
        method = typeof frame.lwp === 'string' ? frame.lwp : '';
        mid = typeof frame.headers?.mid === 'string' ? frame.headers.mid : null;
      } catch {
        // Retaining the frame is useful for matching a later response even when metadata is absent.
      }
      frames.push(Object.freeze({ direction, method, mid, payload }));
    };
    socket.on('framesent', (frame) => append('sent', frame.payload));
    socket.on('framereceived', (frame) => append('received', frame.payload));
  });
}

async function waitForMessageBatch(
  frames: readonly SupplierInquiryWsFrame[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (parseSupplierInquiryWsFrames(frames).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function parseMessageModel(value: unknown, requestedCid: string | undefined): ParsedImMessage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const model = value as Record<string, unknown>;
  const recall = model['recallFeature'];
  if (recall !== null && typeof recall === 'object' && !Array.isArray(recall)) {
    if (typeof (recall as Record<string, unknown>)['code'] === 'string') return null;
  }
  const messageValue = model['message'];
  if (messageValue === null || typeof messageValue !== 'object' || Array.isArray(messageValue)) {
    return null;
  }
  const message = messageValue as Record<string, unknown>;
  const cid = optionalText(message['cid']) ?? requestedCid;
  const messageId = optionalText(message['messageId']);
  const occurredMs = Number(message['createAt']);
  if (cid === undefined || messageId === undefined || !Number.isFinite(occurredMs)) return null;
  const extension = recordOrEmpty(message['extension']);
  const content = recordOrEmpty(message['content']);
  const senderNick = optionalText(extension['sender_nick'])
    ?? optionalText(extension['senderNick'])
    ?? optionalText(extension['sender_id'])
    ?? optionalText(extension['senderId'])
    ?? optionalText(extension['from_id'])
    ?? optionalText(extension['fromId'])
    ?? optionalText(message['sender_nick'])
    ?? optionalText(message['senderNick'])
    ?? optionalText(message['senderId'])
    ?? null;
  const receiverNick = optionalText(extension['receiver_nick'])
    ?? optionalText(extension['receiverNick'])
    ?? optionalText(extension['receiver_id'])
    ?? optionalText(extension['receiverId'])
    ?? optionalText(extension['to_id'])
    ?? optionalText(extension['toId'])
    ?? optionalText(message['receiver_nick'])
    ?? optionalText(message['receiverNick'])
    ?? optionalText(message['receiverId'])
    ?? null;
  const senderName = optionalText(extension['senderNickName'])
    ?? (senderNick === null ? '' : normalizePlatformUser(senderNick));
  const contentType = Number(content['contentType']);
  const textPayload = recordOrEmpty(content['text']);
  const customPayload = recordOrEmpty(content['custom']);
  let text = optionalText(textPayload['content']) ?? null;
  let type: ParsedImMessage['type'] = 'text';
  let offerId: string | null = null;
  let card: ParsedImMessage['card'];
  if (contentType === 1 && text !== null) {
    const match = text.match(/https?:\/\/detail\.1688\.com\/offer\/(\d+)\.html/i);
    if (match !== null) {
      type = 'product_card';
      offerId = match[1]!;
      card = Object.freeze({ title: null, price: null, image: null, url: text });
    }
  } else if (contentType === 101) {
    text = optionalText(customPayload['summary']) ?? optionalText(customPayload['title']) ?? null;
    const businessId = optionalText(extension['bizuniqueID']) ?? '';
    const url = optionalText(customPayload['url'])
      ?? optionalText(customPayload['itemUrl'])
      ?? optionalText(customPayload['offerUrl'])
      ?? null;
    const match = `${businessId}\n${url ?? ''}`.match(/(?:offer|item)[^0-9]*(\d{6,})/iu);
    if (/offer/i.test(businessId) || match !== null) {
      type = 'product_card';
      offerId = match?.[1] ?? null;
      card = Object.freeze({
        title: text,
        price: optionalText(customPayload['price']) ?? null,
        image: optionalText(customPayload['image'])
          ?? optionalText(customPayload['imageUrl'])
          ?? null,
        url,
      });
    } else {
      type = 'conversation_event';
    }
  } else if (contentType !== 1) {
    type = 'conversation_event';
  }
  return Object.freeze({
    cid,
    messageId,
    senderNick,
    receiverNick,
    senderName,
    occurredAt: new Date(occurredMs).toISOString(),
    type,
    text,
    offerId,
    ...(card === undefined ? {} : { card }),
  });
}

function latestConversationId(frames: readonly SupplierInquiryWsFrame[]): string | null {
  return parseSupplierInquiryWsFrames(frames).at(-1)?.cid ?? null;
}

function latestOwnMessage(
  frames: readonly SupplierInquiryWsFrame[],
  sellerMemberId: string,
): ParsedImMessage | undefined {
  return [...parseSupplierInquiryWsFrames(frames)]
    .reverse()
    .find((message) => classifyConversationMessage(message, sellerMemberId) === 'self');
}

function latestOwnOfferMessage(
  frames: readonly SupplierInquiryWsFrame[],
  sellerMemberId: string,
  offerId: string,
): ParsedImMessage | undefined {
  return [...parseSupplierInquiryWsFrames(frames)]
    .reverse()
    .find((message) => message.type === 'product_card'
      && message.offerId === offerId
      && classifyConversationMessage(message, sellerMemberId) === 'self');
}

export function classifyConversationMessage(
  message: Pick<ParsedImMessage, 'senderNick' | 'receiverNick'>,
  sellerMemberId: string,
): 'seller' | 'self' | 'unknown' {
  const sender = message.senderNick === null
    ? null
    : normalizePlatformUser(message.senderNick);
  if (sender === sellerMemberId) return 'seller';
  if (sender !== null && sender !== '') return 'self';
  const receiver = message.receiverNick === null
    ? null
    : normalizePlatformUser(message.receiverNick);
  if (receiver === sellerMemberId) return 'self';
  if (receiver !== null && receiver !== '') return 'seller';
  return 'unknown';
}

function normalizePlatformUser(value: string): string {
  return value.replace(/^cnalichn/, '').split(':', 1)[0] ?? '';
}

function compareMessages(left: ParsedImMessage, right: ParsedImMessage): number {
  const byTime = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  if (byTime !== 0) return byTime;
  if (/^\d+$/.test(left.messageId) && /^\d+$/.test(right.messageId)) {
    const leftId = BigInt(left.messageId);
    const rightId = BigInt(right.messageId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  }
  return left.messageId.localeCompare(right.messageId);
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim();
  return normalized.length === 0 ? undefined : normalized;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const normalized = optionalText(value);
  if (normalized === undefined || normalized.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return normalized;
}

function requiredUuid(value: unknown, field: string): string {
  const normalized = requiredText(value, field, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)) {
    throw new TypeError(`${field} must be a UUID.`);
  }
  return normalized.toLowerCase();
}

function numericId(value: unknown, field: string): string {
  const normalized = requiredText(value, field, 64);
  if (!/^\d+$/.test(normalized)) throw new TypeError(`${field} must contain only digits.`);
  return normalized;
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new TypeError(`${field} must be an integer between 1 and ${maximum}.`);
  }
  return Number(value);
}
