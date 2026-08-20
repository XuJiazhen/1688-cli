import { createHash } from 'node:crypto';
import type { FrameLocator, Locator, Page } from 'playwright';
import { CliError } from '../io/errors.js';

export function imFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[src*="def_cbu_web_im_core"]');
}

export async function findImInput(page: Page): Promise<Locator> {
  const input = imFrame(page).locator('pre.edit[contenteditable="true"]').first();
  try {
    await input.waitFor({ state: 'visible', timeout: 20000 });
    return input;
  } catch {
    throw new CliError(
      22,
      'STABLE_LOCATOR_NOT_FOUND',
      'Could not locate 旺旺 IM chat input.',
      {
        category: 'locator',
        locatorDescription: 'wangwang chat input',
        locatorStrategies: ['iframe def_cbu_web_im_core >> pre.edit[contenteditable=true]'],
        currentUrl: page.url(),
        retryable: true,
      },
    );
  }
}

export async function clickConversationByName(
  page: Page,
  names: string[],
): Promise<string | null> {
  const frame = imFrame(page);
  for (const name of names) {
    if (!name) continue;
    const item = frame.locator(`text=${name}`).first();
    const visible = await item.isVisible({ timeout: 2000 }).catch(() => false);
    if (!visible) continue;
    try {
      await item.click({ force: true, timeout: 5000 });
      return name;
    } catch (e) {
      throw new CliError(
        14,
        'STABLE_LOCATOR_BLOCKED',
        `Located 旺旺 conversation "${name}", but it was not clickable: ${(e as Error).message}`,
        {
          category: 'locator',
          locatorDescription: 'wangwang sidebar conversation',
          locatorStrategies: names.map((n) => `iframe text=${n}`),
          currentUrl: page.url(),
          retryable: true,
        },
      );
    }
  }
  return null;
}

export async function waitForConversationActivated(
  page: Page,
  matchedName: string | null,
  args: { orderId?: string },
): Promise<void> {
  const activated = await page
    .waitForFunction(
      () => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe[src*="def_cbu_web_im_core"]',
        );
        const body = iframe?.contentDocument?.body?.innerText ?? '';
        return !/您尚未选择联系人/.test(body) && body.length > 50;
      },
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!activated) {
    throw new CliError(
      26,
      'CONVERSATION_NOT_SELECTED',
      `Conversation panel did not activate for ${matchedName}. ` +
        (args.orderId
          ? `OrderId ${args.orderId} was passed but conversation never opened.`
          : 'Sidebar click did not switch to conversation.'),
      {
        category: 'locator',
        locatorDescription: 'wangwang active conversation panel',
        locatorStrategies: ['iframe body text does not contain 您尚未选择联系人'],
        currentUrl: page.url(),
        retryable: true,
      },
    );
  }
}

export async function clickImSendButton(page: Page): Promise<void> {
  const button = imFrame(page).locator('button.send-btn:has-text("发送")').first();
  try {
    await button.click({ force: true, timeout: 5000 });
  } catch (e) {
    throw new CliError(
      14,
      'STABLE_LOCATOR_BLOCKED',
      `Located 旺旺 send button, but it was not clickable: ${(e as Error).message}`,
      {
        category: 'locator',
        locatorDescription: 'wangwang send button',
        locatorStrategies: ['iframe button.send-btn:has-text("发送")'],
        currentUrl: page.url(),
        retryable: true,
      },
    );
  }
}

export async function waitForMessageSent(
  page: Page,
  message: string,
): Promise<void> {
  const sent = await page
    .waitForFunction(
      (msg) => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe[src*="def_cbu_web_im_core"]',
        );
        const doc = iframe?.contentDocument;
        if (!doc) return false;
        const edit = doc.querySelector<HTMLElement>(
          'pre.edit[contenteditable="true"]',
        );
        const editText = (edit?.innerText ?? '').replace(/\s+/g, '');
        if (editText.length === 0) return true;
        const body = doc.body?.innerText ?? '';
        return body.includes(msg);
      },
      message,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!sent) {
    throw new CliError(
      24,
      'SEND_UNCONFIRMED',
      'Send clicked but neither input cleared nor message appeared in scrollback.',
    );
  }
}

export const IM_OFFER_SHARE_LOCATOR_STRATEGIES = Object.freeze([
  'page button:has-text("发送链接")',
  'page [role="button"]:has-text("发送链接")',
  'iframe button:has-text("发送链接")',
  'iframe [role="button"]:has-text("发送链接")',
] as const);

export interface SharedOfferCardObservation {
  readonly cardAnchorId: string;
  readonly offerId: string;
  readonly title: string | null;
  readonly price: string | null;
  readonly image: string | null;
  readonly url: string | null;
  readonly domSha256: string;
  readonly observedAt: string;
}

const IM_OFFER_CARD_SELECTOR =
  '.message-item .text-od-wrap, .message-item .od-wrap, .message-item .offer-card-wrap';
const OWN_IM_OFFER_CARD_SELECTOR = [
  '.message-item.self .text-od-wrap',
  '.message-item.self .od-wrap',
  '.message-item.self .offer-card-wrap',
  '.message-item[class*="self"] .text-od-wrap',
  '.message-item[class*="self"] .od-wrap',
  '.message-item[class*="self"] .offer-card-wrap',
].join(', ');

export async function clickImOfferShareButton(page: Page): Promise<void> {
  const candidates = [
    page.locator('button:has-text("发送链接")').first(),
    page.locator('[role="button"]:has-text("发送链接")').first(),
    imFrame(page).locator('button:has-text("发送链接")').first(),
    imFrame(page).locator('[role="button"]:has-text("发送链接")').first(),
  ];
  for (const candidate of candidates) {
    if (!await candidate.isVisible({ timeout: 1_500 }).catch(() => false)) continue;
    try {
      await candidate.click({ force: true, timeout: 5_000 });
      return;
    } catch (error) {
      throw new CliError(
        14,
        'STABLE_LOCATOR_BLOCKED',
        `Located the 旺旺 offer share control, but it was not clickable: ${String(error)}`,
        {
          category: 'locator',
          locatorDescription: 'wangwang offer share button',
          locatorStrategies: [...IM_OFFER_SHARE_LOCATOR_STRATEGIES],
          currentUrl: page.url(),
          retryable: true,
        },
      );
    }
  }
  throw new CliError(
    22,
    'STABLE_LOCATOR_NOT_FOUND',
    'Could not locate the 旺旺 “发送链接” offer share control.',
    {
      category: 'locator',
      locatorDescription: 'wangwang offer share button',
      locatorStrategies: [...IM_OFFER_SHARE_LOCATOR_STRATEGIES],
      currentUrl: page.url(),
      retryable: true,
    },
  );
}

export async function countImOfferCards(page: Page): Promise<number> {
  return imFrame(page).locator(IM_OFFER_CARD_SELECTOR).count();
}

export async function waitForNewImOfferCard(
  page: Page,
  previousCount: number,
  expectedOfferId: string,
): Promise<SharedOfferCardObservation> {
  const cards = imFrame(page).locator(IM_OFFER_CARD_SELECTOR);
  const deadline = Date.now() + 12_000;
  const observedOfferIds = new Set<string>();
  while (Date.now() < deadline) {
    const count = await cards.count().catch(() => 0);
    if (count > previousCount) {
      for (let index = previousCount; index < count; index += 1) {
        const observation = await observeOfferCard(cards.nth(index));
        for (const offerId of observation.offerIds) observedOfferIds.add(offerId);
        if (!observation.offerIds.includes(expectedOfferId)) continue;
        return toSharedOfferCardObservation(observation, expectedOfferId);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new CliError(
    24,
    'OFFER_CARD_UNCONFIRMED',
    '“发送链接” was clicked, but no new 旺旺 card proved the requested offer identity.',
    {
      category: 'locator',
      locatorDescription: 'new wangwang offer card',
      locatorStrategies: [
        'iframe .message-item .text-od-wrap',
        'iframe .message-item .od-wrap',
        'iframe .message-item .offer-card-wrap',
      ],
      currentUrl: page.url(),
      previousCount,
      expectedOfferId,
      observedOfferIds: [...observedOfferIds],
      retryable: true,
    },
  );
}

export async function findRecentOwnOfferCard(
  page: Page,
  expectedOfferId: string,
): Promise<SharedOfferCardObservation | null> {
  const cards = imFrame(page).locator(OWN_IM_OFFER_CARD_SELECTOR);
  const count = await cards.count().catch(() => 0);
  for (let index = count - 1; index >= Math.max(0, count - 20); index -= 1) {
    const observation = await observeOfferCard(cards.nth(index));
    if (observation.offerIds.includes(expectedOfferId)) {
      return toSharedOfferCardObservation(observation, expectedOfferId);
    }
  }
  return null;
}

export function offerIdFromImCardEvidence(value: string): string | null {
  const normalized = value.trim();
  if (/^\d{5,}$/u.test(normalized)) return normalized;
  const patterns = [
    /\/offer\/(\d{5,})\.html(?:[?#/]|$)/iu,
    /[?&](?:offerId|offer_id|itemId|item_id)=(\d{5,})(?:[&#]|$)/iu,
    /(?:data-(?:offer|item)-id|(?:offer|item)Id)\s*[=:]\s*["']?(\d{5,})/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

interface RawOfferCardObservation {
  readonly title: string | null;
  readonly price: string | null;
  readonly image: string | null;
  readonly url: string | null;
  readonly html: string;
  readonly offerIds: readonly string[];
}

async function observeOfferCard(card: Locator): Promise<RawOfferCardObservation> {
  const raw = await card.evaluate((element) => {
    const title = element.querySelector('.odName, .od-name, [class*="odName"]')
      ?.textContent?.trim().slice(0, 200) ?? null;
    const price = element.querySelector('.odPrice, .od-price, [class*="odPrice"]')
      ?.textContent?.replace(/\s+/g, '').replace('￥', '¥').trim() ?? null;
    const image = element.querySelector('img')?.getAttribute('src') ?? null;
    const nodes = [element, ...element.querySelectorAll('*')];
    const evidence = nodes.flatMap((node) => [...node.attributes]
      .filter((attribute) => /(?:href|url|offer|item)/iu.test(attribute.name))
      .map((attribute) => `${attribute.name}=${attribute.value}`));
    const urls = nodes.flatMap((node) => node instanceof HTMLAnchorElement && node.href
      ? [node.href]
      : []);
    return {
      title,
      price,
      image,
      url: urls.find((value) => /\/offer\/\d+\.html/iu.test(value)) ?? null,
      evidence: [...evidence, ...urls],
      html: element.outerHTML.slice(0, 16_384),
    };
  });
  const offerIds = [...new Set(raw.evidence
    .map(offerIdFromImCardEvidence)
    .filter((value): value is string => value !== null))];
  return { ...raw, offerIds };
}

function toSharedOfferCardObservation(
  observation: RawOfferCardObservation,
  expectedOfferId: string,
): SharedOfferCardObservation {
  const domSha256 = createHash('sha256').update(observation.html, 'utf8').digest('hex');
  return Object.freeze({
    cardAnchorId: `dom:${domSha256}`,
    offerId: expectedOfferId,
    title: observation.title,
    price: observation.price,
    image: observation.image,
    url: observation.url,
    domSha256,
    observedAt: new Date().toISOString(),
  });
}

export async function findRecentOwnTextMessage(
  page: Page,
  message: string,
): Promise<{ anchorId: string; observedAt: string } | null> {
  const items = imFrame(page).locator('.message-item.self, .message-item[class*="self"]');
  const count = await items.count().catch(() => 0);
  for (let index = count - 1; index >= Math.max(0, count - 20); index -= 1) {
    const item = items.nth(index);
    const text = await item.innerText().catch(() => '');
    if (!text.includes(message)) continue;
    const observedAt = new Date().toISOString();
    return {
      anchorId: `dom:${createHash('sha256')
        .update(`${text}\n${index}`, 'utf8')
        .digest('hex')}`,
      observedAt,
    };
  }
  return null;
}

export async function waitForOwnTextMessage(
  page: Page,
  message: string,
): Promise<{ anchorId: string; observedAt: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await findRecentOwnTextMessage(page, message);
    if (observation !== null) return observation;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new CliError(
    24,
    'SEND_UNCONFIRMED',
    'Send clicked, but the exact text did not appear in the outgoing 旺旺 scrollback.',
    {
      category: 'locator',
      locatorDescription: 'outgoing wangwang text message',
      locatorStrategies: [
        'iframe .message-item.self',
        'iframe .message-item[class*=self]',
      ],
      currentUrl: page.url(),
      retryable: true,
    },
  );
}
