// Wire protocol for the 1688 daemon. Newline-delimited JSON over a Unix socket
// on macOS/Linux or a named pipe on Windows.

import type {
  PageActionCancelV1,
  PageActionExecuteResponseV1,
  PageActionReceiptLookupV1,
  PageActionRequestV1,
} from '../collection/page-action-contracts.js';

export interface Request {
  id: string;
  cmd: string;
  args: unknown;
}

export interface OkResponse {
  id: string;
  ok: true;
  data: unknown;
}

export interface ErrResponse {
  id: string;
  ok: false;
  exitCode: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type Response = OkResponse | ErrResponse;

export const PAGE_ACTION_DAEMON_COMMANDS = {
  execute: 'collector.pageAction.execute',
  cancel: 'collector.pageAction.cancel',
  lookupReceipt: 'collector.pageAction.lookupReceipt',
} as const;

export interface PageActionExecuteDaemonRequest extends Request {
  cmd: typeof PAGE_ACTION_DAEMON_COMMANDS.execute;
  args: PageActionRequestV1;
}

export interface PageActionCancelDaemonRequest extends Request {
  cmd: typeof PAGE_ACTION_DAEMON_COMMANDS.cancel;
  args: PageActionCancelV1;
}

export interface PageActionReceiptLookupDaemonRequest extends Request {
  cmd: typeof PAGE_ACTION_DAEMON_COMMANDS.lookupReceipt;
  args: PageActionReceiptLookupV1;
}

export type PageActionDaemonRequest =
  | PageActionExecuteDaemonRequest
  | PageActionCancelDaemonRequest
  | PageActionReceiptLookupDaemonRequest;

export type PageActionExecuteDaemonResponse = OkResponse & {
  data: PageActionExecuteResponseV1;
};

export function makeRequestId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
