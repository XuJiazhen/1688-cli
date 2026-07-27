// Routes a command either through the selected profile daemon (fast) or inline
// (slow but self-contained). Headed mode stays inline.

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
  noDaemon?: boolean;
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

  const skipDaemon =
    opts.headed === true ||
    opts.noDaemon === true ||
    process.env.BB1688_NO_DAEMON === '1';

  if (!skipDaemon) {
    // Auto-start daemon if not running. Keeps the "warm browser" promise
    // after `npm i -g` (postinstall kills the daemon) without requiring the
    // user to re-run `1688 login` or `daemon start` manually.
    if (!(await isDaemonReachable(profile))) {
      try {
        const { ensureFreshDaemon } = await import('../daemon/manager.js');
        info(`Starting daemon for profile "${profile}" (one-time)...`);
        await ensureFreshDaemon(profile);
      } catch {
        // Couldn't start — fall through to inline.
      }
    } else {
      try {
        const { ensureFreshDaemon } = await import('../daemon/manager.js');
        const result = await ensureFreshDaemon(profile);
        if (result.restarted) {
          info(`Restarted daemon for profile "${profile}" to match current CLI version.`);
        }
      } catch {
        // Couldn't refresh — fall through to the normal daemon/inline logic.
      }
    }
    if (await isDaemonReachable(profile)) {
      try {
        const data = await daemonCall<TData>(name, args, requestId, profile);
        await finishOk();
        return data;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code && code !== 'ECONNREFUSED' && code !== 'ENOENT') {
          await finishError(e);
          throw e;
        }
      }
    }
  }

  // Inline path. If a daemon is alive, it holds the lock — we must pause it
  // for the duration so this inline call can grab the lock and open its own
  // browser context on the shared profile. Restart on exit.
  const daemonMgr = await maybePauseDaemon(profile);
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
  } finally {
    await daemonMgr.resume();
  }
}

async function maybePauseDaemon(profile: string): Promise<{ resume: () => Promise<void> }> {
  try {
    const { status, stop, start } = await import('../daemon/manager.js');
    const st = await status(profile);
    if (!st.running) return { resume: async () => {} };
    info(`Pausing daemon for profile "${profile}" for inline run...`);
    await stop(profile);
    return {
      resume: async () => {
        try {
          info(`Resuming daemon for profile "${profile}"...`);
          await start(profile);
        } catch (e) {
          info(`(Daemon resume failed for profile "${profile}": ${(e as Error).message})`);
        }
      },
    };
  } catch {
    return { resume: async () => {} };
  }
}
