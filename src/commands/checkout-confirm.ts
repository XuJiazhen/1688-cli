import readline from 'node:readline/promises';
import type { BrowserContext, Page } from 'playwright';
import { withSession } from '../session/context.js';
import { isDaemonReachable } from '../daemon/client.js';
import { emit, info, isJson } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import { sleep } from '../session/wait.js';
import { clickSubmitOrderButton } from '../session/checkout-locators.js';
import {
  clickCartCheckoutButton,
  clickCartRowCheckbox,
  uncheckAllCartRows,
  waitForAnyCartRowChecked,
  waitForCartItems,
} from '../session/cart-locators.js';
import { executeRaw as cartListExecute } from './cart-list.js';
import { type CheckoutPrepareResult } from './checkout-prepare.js';

export interface CheckoutConfirmOpts {
  cartIds: string[];
  yes?: boolean;
  agent?: boolean;
  profile?: string;
}

export interface CheckoutConfirmArgs {
  cartIds: string[];
  headed?: boolean;
}

export interface CheckoutConfirmResult {
  ok: boolean;
  placed: boolean;
  finalUrl: string;
  orderId: string | null;
  message: string;
  preview: CheckoutPrepareResult;
}

const CART_URL = 'https://cart.1688.com/';

/**
 * Low-level executor: navigate, parse preview, click 提交订单, return result.
 * No prompts. Keep this behind CLI-level confirmation gates.
 */
export async function execute(
  ctx: BrowserContext,
  args: CheckoutConfirmArgs,
): Promise<CheckoutConfirmResult> {
  if (!Array.isArray(args.cartIds) || args.cartIds.length === 0) {
    throw new CliError(2, 'BAD_INPUT', 'cartIds required.');
  }
  for (const id of args.cartIds) {
    if (!/^\d+$/.test(id)) {
      throw new CliError(2, 'BAD_INPUT', `Invalid cartId: ${id}`);
    }
  }

  return withRecovery(
    ctx,
    { cmd: 'checkout-confirm', args },
    () => executeRaw(ctx, args),
    { headed: args.headed === true, maxRetries: 0 },
  );
}

async function executeRaw(
  ctx: BrowserContext,
  args: CheckoutConfirmArgs,
): Promise<CheckoutConfirmResult> {
  info('Verifying cart items...');
  const cart = await cartListExecute(ctx);
  const missing = args.cartIds.filter(
    (id) => !cart.items.some((i) => i.cartId === id),
  );
  if (missing.length > 0) {
    throw new CliError(
      12,
      'CART_ITEM_NOT_FOUND',
      `cartId(s) not found: ${missing.join(', ')}`,
    );
  }

  const page = await ctx.newPage();
  try {
    await navigateToPreview(page, args.cartIds, cart);
    const preview = await parsePreview(page);
    info('Placing order...');
    const result = await submitOrder(page);
    return { ...result, preview };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function run(opts: CheckoutConfirmOpts): Promise<void> {
  assertNotSupervisorManaged();
  if (!opts.cartIds || opts.cartIds.length === 0) {
    throw new CliError(2, 'BAD_INPUT', 'At least one cartId is required.');
  }

  // ── Non-interactive paths: --agent or --yes → inline route, no prompt ──
  //    Difference: --yes still requires TTY (real user fast-tracking);
  //    --agent skips TTY check (agent who already got user authorization).
  if (opts.agent || opts.yes) {
    if (opts.yes && !opts.agent && (!process.stdin.isTTY || isJson())) {
      throw new CliError(
        20,
        'TTY_REQUIRED',
        '--yes still requires a real terminal. ' +
          'Use --agent if you are an agent invocation.',
      );
    }
    info(
      opts.agent
        ? '[agent mode] No prompt; user authorization is the caller\'s responsibility.'
        : '[--yes] Skipping prompt.',
    );
    const data = await runConfirmedInline(opts.cartIds, opts.profile);
    emit({
      human: () => printResult(data),
      data,
    });
    return;
  }

  // ── Default: TTY + interactive y/N + auto-pause daemon + inline ───────
  if (isJson() || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      20,
      'TTY_REQUIRED',
      'checkout confirm refuses non-interactive invocation. ' +
        'Run from a real terminal, or pass --agent if you are an agent that ' +
        'already obtained user authorization.',
    );
  }

  await withDaemonPaused(opts.profile, async () => {
    await withSession(
      { headless: true, profile: opts.profile },
      async (ctx) => {
        // Verify + nav + parse preview, then prompt user, then submit.
        if (!Array.isArray(opts.cartIds) || opts.cartIds.length === 0) {
          throw new CliError(2, 'BAD_INPUT', 'cartIds required.');
        }
        info('Verifying cart items...');
        const cart = await cartListExecute(ctx);
        const missing = opts.cartIds.filter(
          (id) => !cart.items.some((i) => i.cartId === id),
        );
        if (missing.length > 0) {
          throw new CliError(
            12,
            'CART_ITEM_NOT_FOUND',
            `cartId(s) not found: ${missing.join(', ')}`,
          );
        }
        const page = await ctx.newPage();
        try {
          await navigateToPreview(page, opts.cartIds, cart);
          const preview = await parsePreview(page);
          printPreview(preview);
          if (!opts.yes) {
            await yesNoConfirm(
              `\nPlace this order for ¥${preview.totalAmount.toFixed(
                2,
              )}? [y/N] `,
            );
          } else {
            process.stderr.write(
              `\n(--yes) Placing order for ¥${preview.totalAmount.toFixed(
                2,
              )}...\n`,
            );
          }
          info('\nPlacing order...');
          const result = await submitOrder(page);
          emit({
            human: () => printResult({ ...result, preview }),
            data: { ...result, preview },
          });
        } finally {
          await page.close().catch(() => {});
        }
      },
      { cmd: 'checkout-confirm', args: { cartIds: opts.cartIds } },
    );
  });
}

async function runConfirmedInline(
  cartIds: string[],
  profile?: string,
): Promise<CheckoutConfirmResult> {
  return withDaemonPaused(profile, () =>
    withSession({ headless: true, profile }, (ctx) =>
      execute(ctx, { cartIds, headed: false }),
      { cmd: 'checkout-confirm', args: { cartIds } },
    ),
  );
}

async function withDaemonPaused<T>(profile: string | undefined, fn: () => Promise<T>): Promise<T> {
  assertNotSupervisorManaged();
  if (await isDaemonReachable(profile)) {
    throw new CliError(
      20,
      'SUPERVISOR_INTERVENTION_REQUIRED',
      'Checkout confirmation requires the Supervisor to drain and stop the Profile daemon first.',
    );
  }
  return fn();
}

function assertNotSupervisorManaged(): void {
  if (process.env.BB1688_SUPERVISOR_MANAGED === '1') {
    throw new CliError(
      20,
      'SUPERVISOR_INTERVENTION_REQUIRED',
      'Checkout confirmation is not available inside a Supervisor-managed Profile runtime.',
    );
  }
}

async function navigateToPreview(
  page: Page,
  cartIds: string[],
  cart: Awaited<ReturnType<typeof cartListExecute>>,
): Promise<void> {
  await page.goto(CART_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  if (/login\.1688\.com|login\.taobao\.com/.test(page.url())) {
    throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
  }
  await waitForCartItems(page);
  await sleep(1500);

  await uncheckAllCartRows(page);
  await sleep(1000);

  for (const cartId of cartIds) {
    const item = cart.items.find((i) => i.cartId === cartId)!;
    await clickCartRowCheckbox(page, item);
    await sleep(600);
  }

  await waitForAnyCartRowChecked(page);

  // Click 结算; retry up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    await clickCartCheckoutButton(page);
    const navigated = await page
      .waitForURL(/smart_make_order|order\.1688\.com\/order/i, {
        timeout: 6000,
      })
      .then(() => true)
      .catch(() => false);
    if (navigated) break;
    if (attempt === 3) {
      throw new CliError(
        18,
        'PREVIEW_NAV_FAILED',
        `Did not reach checkout preview after ${attempt} attempts. URL: ${page.url()}`,
      );
    }
    await sleep(1500);
  }
  await sleep(2500);
}

async function parsePreview(page: Page): Promise<CheckoutPrepareResult> {
  const html = await page.content();
  const m = html.match(/data-source="([^"]+sumPayment[^"]+)"/);
  if (!m) {
    throw new CliError(
      19,
      'PREVIEW_NOT_FOUND',
      'Could not locate preview data on page.',
    );
  }
  const decoded = m[1]!
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  const raw = JSON.parse(decoded) as {
    orders?: {
      sumPayment?: number;
      sumPaymentNoCarriage?: number;
      sumCarriage?: number;
      sumTaxAmount?: number;
      receiveAddress?: {
        fullName?: string;
        mobile?: string;
        address?: string;
        addressCodeText?: string;
      };
      simpleSeller?: {
        memberId?: string;
        loginId?: string;
        companyName?: string;
      };
      cargoGroupedByLogistics?: {
        cargoList?: {
          offerId?: number | string;
          orderCargos?: {
            cartId?: number | string;
            cargoNumber?: string;
            cargoSkuNumber?: string;
            commonQuantity?: number;
            finalUnitPrice?: number;
            amount?: number;
          }[];
        }[];
      }[];
    }[];
  };
  const orders = raw.orders ?? [];
  if (orders.length === 0) {
    throw new CliError(19, 'PREVIEW_EMPTY', 'No orders in preview.');
  }
  const cents = (n: number | undefined) =>
    n === undefined ? 0 : Math.round(n) / 100;

  let total = 0,
    product = 0,
    shipping = 0,
    tax = 0;
  const out: CheckoutPrepareResult['orders'] = [];
  let firstAddr: typeof orders[0]['receiveAddress'] | undefined;
  for (const o of orders) {
    total += cents(o.sumPayment);
    product += cents(o.sumPaymentNoCarriage);
    shipping += cents(o.sumCarriage);
    tax += cents(o.sumTaxAmount);
    if (!firstAddr) firstAddr = o.receiveAddress;
    const items: CheckoutPrepareResult['orders'][number]['items'] = [];
    for (const cg of o.cargoGroupedByLogistics ?? []) {
      for (const c of cg.cargoList ?? []) {
        for (const oc of c.orderCargos ?? []) {
          items.push({
            cartId: oc.cartId !== undefined ? String(oc.cartId) : '',
            offerId: c.offerId !== undefined ? String(c.offerId) : '',
            productNumber: oc.cargoNumber ?? null,
            skuNumber: oc.cargoSkuNumber ?? null,
            quantity: oc.commonQuantity ?? 0,
            unitPrice: oc.finalUnitPrice ?? 0,
            amount: oc.amount ?? 0,
          });
        }
      }
    }
    out.push({
      seller: {
        memberId: o.simpleSeller?.memberId ?? null,
        loginId: o.simpleSeller?.loginId ?? null,
        companyName: o.simpleSeller?.companyName ?? null,
      },
      totalAmount: cents(o.sumPayment),
      productAmount: cents(o.sumPaymentNoCarriage),
      shippingAmount: cents(o.sumCarriage),
      items,
    });
  }
  return {
    ok: true,
    url: page.url(),
    totalAmount: total,
    productAmount: product,
    shippingAmount: shipping,
    taxAmount: tax,
    receiveAddress: {
      fullName: firstAddr?.fullName ?? null,
      mobile: firstAddr?.mobile ?? null,
      address: firstAddr?.address ?? null,
      region: firstAddr?.addressCodeText ?? null,
    },
    orders: out,
  };
}

function printPreview(p: CheckoutPrepareResult): void {
  process.stderr.write('\n══ ABOUT TO PLACE ORDER ══\n\n');
  process.stderr.write(`  TOTAL:    ¥${p.totalAmount.toFixed(2)}\n`);
  process.stderr.write(
    `            items ¥${p.productAmount.toFixed(2)} + shipping ¥${p.shippingAmount.toFixed(
      2,
    )}` +
      (p.taxAmount > 0 ? ` + tax ¥${p.taxAmount.toFixed(2)}` : '') +
      '\n',
  );
  process.stderr.write(
    `  ship to: ${p.receiveAddress.fullName ?? '?'} ${p.receiveAddress.mobile ?? ''}\n`,
  );
  process.stderr.write(
    `           ${p.receiveAddress.region ?? ''} ${p.receiveAddress.address ?? ''}\n\n`,
  );
  for (const o of p.orders) {
    process.stderr.write(`  Seller: ${o.seller.companyName ?? '?'}\n`);
    for (const it of o.items) {
      process.stderr.write(
        `    * cartId=${it.cartId}  ${it.quantity}×¥${it.unitPrice.toFixed(
          2,
        )} = ¥${it.amount.toFixed(2)}\n`,
      );
    }
  }
  process.stderr.write(
    '\nThis will PLACE the order. Payment is NOT charged — pay on 1688 app/website.\n',
  );
}

async function yesNoConfirm(prompt: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(prompt);
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new CliError(130, 'CANCELED', 'Order canceled.');
    }
  } finally {
    rl.close();
  }
}

async function submitOrder(page: Page): Promise<{
  ok: boolean;
  placed: boolean;
  finalUrl: string;
  orderId: string | null;
  message: string;
}> {
  const beforeUrl = page.url();

  await sleep(1500);
  await clickSubmitOrderButton(page);

  // Wait for nav to cashier/order/pay, or success text in body.
  const deadline = Date.now() + 30000;
  let finalUrl = page.url();
  while (Date.now() < deadline) {
    finalUrl = page.url();
    if (
      finalUrl !== beforeUrl &&
      /cashier|alipay|pay\.1688|trade\.1688|order|buy_now/i.test(finalUrl)
    ) {
      break;
    }
    const txt = await page
      .evaluate(() => (document.body?.innerText ?? '').slice(0, 800))
      .catch(() => '');
    if (/下单成功|订单提交成功|请在.*分钟内付款|订单号/.test(txt)) break;
    await sleep(1000);
  }

  // URL may have orderId nested in a URL-encoded returnURL parameter, so
  // decodeURIComponent first.
  const decodedUrl = (() => {
    try {
      return decodeURIComponent(finalUrl);
    } catch {
      return finalUrl;
    }
  })();
  const orderIdMatch =
    decodedUrl.match(/[?&]orderId=(\d{12,})/) ??
    decodedUrl.match(/orderIds?=([\d,]+)/);
  let orderId: string | null = orderIdMatch ? orderIdMatch[1]! : null;
  if (!orderId) {
    const txt = await page
      .evaluate(() => document.body?.innerText ?? '')
      .catch(() => '');
    const idMatch = txt.match(/订单号[:：\s]*(\d{12,})/);
    if (idMatch) orderId = idMatch[1]!;
  }

  const placed = finalUrl !== beforeUrl || orderId !== null;
  return {
    ok: true,
    placed,
    finalUrl,
    orderId,
    message: placed
      ? `Order placed. Pay on 1688 app/website. Final URL: ${finalUrl}`
      : 'Submit clicked, but no clear success signal observed. Check 1688 directly.',
  };
}

function printResult(r: CheckoutConfirmResult): void {
  process.stdout.write('\n');
  if (r.placed) {
    process.stdout.write('✓ Order placed.\n');
    if (r.orderId) process.stdout.write(`  orderId: ${r.orderId}\n`);
    process.stdout.write(`  URL:     ${r.finalUrl}\n`);
    process.stdout.write(
      '\nPay on 1688 app or in browser. 1688 does NOT handle payment.\n',
    );
  } else {
    process.stdout.write('⚠ Submit clicked but success unconfirmed.\n');
    process.stdout.write(`  URL: ${r.finalUrl}\n`);
    process.stdout.write(
      '  Check `1688 order list` to verify whether the order was created.\n',
    );
  }
}
