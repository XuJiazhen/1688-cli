import { createHash } from 'node:crypto';
import type { BrowserContext } from 'playwright';
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { executeRaw as cartListExecute } from './cart-list.js';
import { readState } from '../session/state.js';
import { sleep } from '../session/wait.js';
import type {
  SupplierInquiryActionInput,
  SupplierInquiryActionResult,
} from '../session/supplier-inquiry-actions.js';

export interface SellerInquireOpts {
  offerId: string;
  message: string;
  to?: string; // explicit seller loginId
  profile?: string;
  headed?: boolean;
}

export async function run(opts: SellerInquireOpts): Promise<void> {
  if (!opts.offerId || !/^\d+$/.test(opts.offerId)) {
    throw new CliError(2, 'BAD_INPUT', 'Valid offerId required.');
  }
  if (!opts.message?.trim()) {
    throw new CliError(2, 'BAD_INPUT', 'Message cannot be empty.');
  }

  const state = await readState(opts.profile);
  if (!state.nick) {
    throw new CliError(
      3,
      'NOT_LOGGED_IN',
      'Cannot determine your loginId. Run `1688 whoami` first.',
    );
  }

  // 1. Resolve seller loginId
  let sellerLoginId = opts.to ?? null;
  let sellerName: string | null = null;
  if (!sellerLoginId) {
    sellerLoginId = await tryFindSeller(opts.offerId, opts);
    if (!sellerLoginId) {
      throw new CliError(
        30,
        'SELLER_UNKNOWN',
        `Cannot find seller for offer ${opts.offerId}. ` +
          'Pass --to <sellerLoginId> explicitly, OR add the item to cart first ' +
          `(1688 cart add ${opts.offerId} --sku ... --qty 1) so 1688 can ` +
          'identify the seller.',
      );
    }
  }
  info(`Seller: ${sellerLoginId}${sellerName ? ` (${sellerName})` : ''}`);

  // The manual command and fenced production RPC share these exact actions.
  // Product context is established only by the UI's “发送链接” control; a raw
  // offer URL is never used as a production-success fallback.
  const actionBase = {
    conversationScope: 'offer' as const,
    memberId: sellerLoginId,
    normalizedStoreUrl: 'https://shop.1688.com/',
    offerId: opts.offerId,
  };
  info('Sharing and verifying the offer card');
  const card = await dispatch<SupplierInquiryActionInput, SupplierInquiryActionResult>(
    'supplier-inquiry-action',
    {
      ...actionBase,
      action: 'share_offer',
      idempotencyKey: `manual:share:${opts.offerId}`,
    },
    { headed: opts.headed, profile: opts.profile },
  );
  info(`Sending message 2/2: question`);
  const data = await dispatch<SupplierInquiryActionInput, SupplierInquiryActionResult>(
    'supplier-inquiry-action',
    {
      ...actionBase,
      action: 'send_text',
      idempotencyKey: `manual:text:${opts.offerId}:${createHash('sha256')
        .update(opts.message, 'utf8')
        .digest('hex')}`,
      text: opts.message,
    },
    { headed: opts.headed, profile: opts.profile },
  );

  emit({
    human: () => {
      process.stdout.write(`✓ Inquiry sent to ${sellerLoginId}\n`);
      process.stdout.write(`  msg 1 (card):     ${card.cardAnchorId ?? card.messageId}\n`);
      process.stdout.write(`  msg 2 (question): ${opts.message}\n`);
      process.stdout.write(`  at: ${data.sentAt}\n`);
    },
    data: {
      ok: true,
      sentTo: sellerLoginId,
      offerId: opts.offerId,
      cardAnchorId: card.cardAnchorId ?? card.messageId,
      question: opts.message,
      sentAt: data.sentAt,
    },
  });
}

/**
 * Find seller's loginId for an offerId. Strategy:
 *  1) Read window.FE_GLOBALS.offerLoginId from the product detail page (works
 *     for ALL offers — best path)
 *  2) Fallback: cart match (if for some reason the page lookup fails)
 */
async function tryFindSeller(
  offerId: string,
  opts: { profile?: string; headed?: boolean },
): Promise<string | null> {
  // Primary: scrape window.FE_GLOBALS.offerLoginId from detail page
  info(`Reading seller loginId from detail page...`);
  try {
    const loginId = await dispatch<
      { offerId: string },
      { offerLoginId: string | null }
    >('detail-feglobals', { offerId }, { headed: opts.headed, profile: opts.profile });
    if (loginId.offerLoginId) {
      info(`Found from FE_GLOBALS: seller=${loginId.offerLoginId}`);
      return loginId.offerLoginId;
    }
  } catch {
    /* fall through */
  }

  // Fallback: check cart
  info(`Looking up offer ${offerId} in cart...`);
  try {
    const cart = await dispatch<
      { headed?: boolean },
      Awaited<ReturnType<typeof cartListExecute>>
    >(
      'cart-list',
      { headed: opts.headed },
      { headed: opts.headed, profile: opts.profile },
    );
    const item = cart.items.find((i) => i.offerId === offerId);
    if (item?.seller.loginId) {
      info(`Found in cart: seller=${item.seller.loginId}`);
      return item.seller.loginId;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Standalone executor: scrape FE_GLOBALS from offer detail page
export async function scrapeFeGlobals(
  ctx: BrowserContext,
  args: { offerId: string },
): Promise<{ offerLoginId: string | null }> {
  const page = await ctx.newPage();
  try {
    await page.goto(
      `https://detail.1688.com/offer/${args.offerId}.html`,
      { waitUntil: 'domcontentloaded', timeout: 25000 },
    );
    // The script tag containing FE_GLOBALS is in the initial HTML, so we don't
    // need to wait for JS to run — but a small delay helps if redirects happen.
    await sleep(1500);
    const result = await page.evaluate(() => {
      const w = window as unknown as { FE_GLOBALS?: { offerLoginId?: string } };
      return { offerLoginId: w.FE_GLOBALS?.offerLoginId ?? null };
    });
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}
