// Automated commands require the selected Profile daemon. Explicit headed
// mode remains available only as an operator intervention path.

import type { BrowserContext } from 'playwright';
import { withSession } from './context.js';
import { isDaemonReachable, daemonCall } from '../daemon/client.js';
import { makeRequestId } from '../daemon/protocol.js';
import { info } from '../io/output.js';
import { defaultProfileName } from './paths.js';
import {
  appendEventBestEffort,
  endEvent,
  eventFromError,
  startEvent,
} from './events.js';

export interface DispatchOpts {
  headed?: boolean;
  profile?: string;
  requestId?: string;
}

type Executor<TArgs, TData> = (
  ctx: BrowserContext,
  args: TArgs,
) => Promise<TData>;

// Lazy-imported registry of command executors. Each entry must export `execute`.
// login/logout are deliberately omitted — they have interactive flows (QR render,
// stdin confirmation) that don't transit cleanly through a socket; they stay inline.
const REGISTRY: Record<string, () => Promise<Executor<unknown, unknown>>> = {
  search: () =>
    import('../commands/search.js').then((m) => m.execute as Executor<unknown, unknown>),
  whoami: () =>
    import('../commands/whoami.js').then((m) => m.execute as Executor<unknown, unknown>),
  'order-list': () =>
    import('../commands/order-list.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'order-get': () =>
    import('../commands/order-get.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'order-logistics': () =>
    import('../commands/order-logistics.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  offer: () =>
    import('../commands/offer.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'image-search': () =>
    import('../commands/image-search.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'cart-list': () =>
    import('../commands/cart-list.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'cart-remove': () =>
    import('../commands/cart-remove.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'cart-add': () =>
    import('../commands/cart-add.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'checkout-prepare': () =>
    import('../commands/checkout-prepare.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'seller-chat': () =>
    import('../commands/seller-chat.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'seller-messages': () =>
    import('../commands/seller-messages.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'supplier-inquiry-action': () =>
    import('./supplier-inquiry-actions.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  inbox: () =>
    import('../commands/inbox.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'detail-feglobals': () =>
    import('../commands/seller-inquire.js').then(
      (m) => m.scrapeFeGlobals as Executor<unknown, unknown>,
    ),
  similar: () =>
    import('../commands/similar.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'supplier-inspect': () =>
    import('../commands/supplier-inspect.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'supplier-catalog': () =>
    import('../commands/supplier-catalog.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  collect: () =>
    import('../commands/collect.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
  'supplier-search': () =>
    import('../commands/supplier-search.js').then(
      (m) => m.execute as Executor<unknown, unknown>,
    ),
};

export async function loadExecutor<TArgs, TData>(
  name: string,
): Promise<Executor<TArgs, TData>> {
  const loader = REGISTRY[name];
  if (!loader) throw new Error(`Unknown command: ${name}`);
  return (await loader()) as Executor<TArgs, TData>;
}

export async function dispatch<TArgs, TData>(
  name: string,
  args: TArgs,
  opts: DispatchOpts = {},
): Promise<TData> {
  if (process.env.BB1688_SUPERVISOR_MANAGED === '1') {
    throw new TypeError(
      'Supervisor-managed PageActions must use direct fenced RPC; legacy dispatch and inline fallback are disabled.',
    );
  }
  const profile = defaultProfileName(opts.profile);
  const requestId = opts.requestId ?? makeRequestId();
  if (
    requestId === '.' ||
    requestId === '..' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
  ) {
    throw new TypeError(
      'Dispatch requestId must be a non-traversing identifier containing only letters, numbers, dot, underscore, colon, or hyphen.',
    );
  }
  const startedAt = Date.now();
  await appendEventBestEffort(
    startEvent({ requestId, cmd: name, profile }),
  );

  const finishOk = async () => {
    await appendEventBestEffort(
      endEvent({ requestId, cmd: name, startedAt, profile }),
    );
  };
  const finishError = async (error: unknown) => {
    await appendEventBestEffort(
      eventFromError({ requestId, cmd: name, startedAt, profile, error }),
    );
  };

  if (opts.headed !== true) {
    if (!(await isDaemonReachable(profile))) {
      throw new TypeError(
        `Profile "${profile}" has no Supervisor-managed daemon; inline fallback is disabled.`,
      );
    }
    try {
      const data = await daemonCall<TData>(name, args, requestId, profile);
      await finishOk();
      return data;
    } catch (error) {
      await finishError(error);
      throw error;
    }
  }

  info(`Opening explicit headed intervention for profile "${profile}".`);
  try {
    const fn = await loadExecutor<TArgs, TData>(name);
    const data = await withSession(
      { headless: !opts.headed, profile },
      (ctx) => fn(ctx, args),
      { requestId, cmd: name, args },
    );
    await finishOk();
    return data;
  } catch (error) {
    await finishError(error);
    throw error;
  }
}
