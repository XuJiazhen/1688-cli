import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { CliError } from '../io/errors.js';
import {
  compileSearchPageRequestV1,
  assertSearchPageDerivationV1,
  type CanonicalSearchParameterSetV1,
  type CompiledSearchPageRequestV1,
} from './search-compiler.js';
import type { SearchPageCaptureV1 } from './search-capture.js';

export const SEARCH_PAGINATION_PROTOCOL_RETRY_LIMIT = 3 as const;

export interface SearchPageRuntimePortV1 {
  createPage(): Promise<Page>;
  pageSessionId(page: Page): Promise<string>;
  fetchPage(input: {
    page: Page;
    compiledRequest: CompiledSearchPageRequestV1;
    ordinal: number;
    purpose: 'forward' | 'replay';
    signal?: AbortSignal;
  }): Promise<SearchPageCaptureV1>;
  closePage(page: Page): Promise<void>;
  onPageCommitted?(input: {
    capture: SearchPageCaptureV1;
    binding: SearchPageAttemptBindingV1;
  }): Promise<void>;
  pace(delayMs: number, signal?: AbortSignal): Promise<void>;
  randomDelayMs(): number;
}

export interface SearchRemoteAttemptV1 {
  ordinal: number;
  logicalPage: number;
  purpose: 'forward' | 'replay';
  status: 'succeeded' | 'failed' | 'cancelled';
  requestBusinessHash: string;
  responseBusinessHash: string | null;
  newOfferCount: number;
  hasMore: boolean | null;
  errorCode: string | null;
}

export interface SearchPageAttemptBindingV1 {
  logicalPage: number;
  attemptOrdinal: number;
  purpose: 'forward' | 'replay';
  requestBusinessHash: string;
  responseBusinessHash: string;
}

export interface SearchRuntimeResultV1 {
  status: 'completed' | 'partial' | 'cancelled';
  pages: SearchPageCaptureV1[];
  attempts: SearchRemoteAttemptV1[];
  pageAttemptBindings: SearchPageAttemptBindingV1[];
  offers: SearchPageCaptureV1['page']['offers'];
  duplicates: Array<{
    offerId: string;
    firstPage: number;
    duplicatePage: number;
  }>;
  terminalReason: 'source-end' | 'configured-page-limit' | 'configured-offer-limit' | null;
  lastCompletedPage: number;
  errorCode: string | null;
  createdPages: 1;
  closedPages: 1;
  remainingOwnedPages: 0;
}

export async function runCompiledSearchActionV1(input: {
  parameterSet: CanonicalSearchParameterSetV1;
  port: SearchPageRuntimePortV1;
  startPage?: number;
  purpose?: 'forward' | 'replay';
  replayThroughPage?: number;
  forwardPageBudget: number;
  replayPageBudget: number;
  signal?: AbortSignal;
}): Promise<SearchRuntimeResultV1> {
  const startPage = input.startPage ?? 1;
  const pageSchedule = createPageSchedule({
    startPage,
    maxPages: input.parameterSet.maxPages,
    defaultPurpose: input.purpose ?? 'forward',
    replayThroughPage: input.replayThroughPage,
  });
  const page = await input.port.createPage();
  const pages: SearchPageCaptureV1[] = [];
  const attempts: SearchRemoteAttemptV1[] = [];
  const pageAttemptBindings: SearchPageAttemptBindingV1[] = [];
  const offers: SearchPageCaptureV1['page']['offers'] = [];
  const duplicates: SearchRuntimeResultV1['duplicates'] = [];
  const seen = new Map<string, number>();
  const fingerprints = new Set<string>();
  let terminalReason: SearchRuntimeResultV1['terminalReason'] = null;
  let errorCode: string | null = null;
  let status: SearchRuntimeResultV1['status'] = 'partial';
  let previousCompiled: CompiledSearchPageRequestV1 | null = null;
  try {
    assertBudget(input.forwardPageBudget, 'forwardPageBudget');
    assertBudget(input.replayPageBudget, 'replayPageBudget');
    const pageSessionId = await input.port.pageSessionId(page);
    for (const { logicalPage, purpose } of pageSchedule) {
      throwIfAborted(input.signal);
      let capture: SearchPageCaptureV1 | null = null;
      for (let retry = 0; retry < SEARCH_PAGINATION_PROTOCOL_RETRY_LIMIT; retry++) {
        consumeBudget(purpose, attempts, input.forwardPageBudget, input.replayPageBudget);
        const compiledRequest = compileSearchPageRequestV1({
          parameterSet: input.parameterSet,
          page: logicalPage,
          pageSessionId,
        });
        if (previousCompiled && retry === 0) {
          assertSearchPageDerivationV1(previousCompiled, compiledRequest);
        }
        const ordinal = attempts.length + 1;
        try {
          const observed = await input.port.fetchPage({
            page,
            compiledRequest,
            ordinal,
            purpose,
            signal: input.signal,
          });
          const uniqueIds = new Set(observed.page.offers.map((offer) => offer.offerId));
          const newCount = [...uniqueIds].filter((offerId) => !seen.has(offerId)).length;
          const repeatedFingerprint = fingerprints.has(observed.page.responseBusinessHash);
          const noProgress = observed.page.hasMore &&
            (observed.page.offers.length === 0 || newCount === 0 || repeatedFingerprint);
          attempts.push({
            ordinal,
            logicalPage,
            purpose,
            status: noProgress ? 'failed' : 'succeeded',
            requestBusinessHash: compiledRequest.requestBusinessHash,
            responseBusinessHash: observed.page.responseBusinessHash,
            newOfferCount: newCount,
            hasMore: observed.page.hasMore,
            errorCode: noProgress ? 'SEARCH_PAGINATION_NO_PROGRESS' : null,
          });
          if (noProgress) {
            errorCode = 'SEARCH_PAGINATION_NO_PROGRESS';
            if (retry + 1 < SEARCH_PAGINATION_PROTOCOL_RETRY_LIMIT) {
              await input.port.pace(input.port.randomDelayMs(), input.signal);
              continue;
            }
            return result('partial');
          }
          capture = observed;
          pageAttemptBindings.push({
            logicalPage,
            attemptOrdinal: ordinal,
            purpose,
            requestBusinessHash: compiledRequest.requestBusinessHash,
            responseBusinessHash: observed.page.responseBusinessHash,
          });
          previousCompiled = compiledRequest;
          break;
        } catch (error) {
          const code = collectorErrorCode(error);
          attempts.push({
            ordinal,
            logicalPage,
            purpose,
            status: input.signal?.aborted ? 'cancelled' : 'failed',
            requestBusinessHash: compiledRequest.requestBusinessHash,
            responseBusinessHash: null,
            newOfferCount: 0,
            hasMore: null,
            errorCode: code,
          });
          errorCode = code;
          if (input.signal?.aborted) return result('cancelled');
          if (!isRetryableProtocol(error) || retry + 1 >= SEARCH_PAGINATION_PROTOCOL_RETRY_LIMIT) {
            return result('partial');
          }
          await input.port.pace(input.port.randomDelayMs(), input.signal);
        }
      }
      if (!capture) return result('partial');
      pages.push(capture);
      fingerprints.add(capture.page.responseBusinessHash);
      for (const offer of capture.page.offers) {
        const firstPage = seen.get(offer.offerId);
        if (firstPage !== undefined) {
          duplicates.push({ offerId: offer.offerId, firstPage, duplicatePage: logicalPage });
          continue;
        }
        seen.set(offer.offerId, logicalPage);
        if (
          isEligibleSearchOffer(input.parameterSet.advertisementPolicy, offer) &&
          offers.length < input.parameterSet.maxOffers
        ) {
          offers.push(offer);
        }
      }
      await input.port.onPageCommitted?.({
        capture,
        binding: pageAttemptBindings.at(-1)!,
      });

      if (!capture.page.hasMore) {
        terminalReason = 'source-end';
        return result('completed');
      }
      if (offers.length >= input.parameterSet.maxOffers) {
        terminalReason = 'configured-offer-limit';
        return result('completed');
      }
      if (logicalPage >= input.parameterSet.maxPages) {
        terminalReason = 'configured-page-limit';
        return result('completed');
      }
      await input.port.pace(input.port.randomDelayMs(), input.signal);
    }
    return result(status);
  } finally {
    await input.port.closePage(page);
  }

  function result(nextStatus: SearchRuntimeResultV1['status']): SearchRuntimeResultV1 {
    status = nextStatus;
    return {
      status,
      pages: [...pages],
      attempts: [...attempts],
      pageAttemptBindings: [...pageAttemptBindings],
      offers: [...offers],
      duplicates: [...duplicates],
      terminalReason,
      lastCompletedPage:
        pages.at(-1)?.compiledRequest.page ?? (pageSchedule[0]?.logicalPage ?? startPage) - 1,
      errorCode,
      createdPages: 1,
      closedPages: 1,
      remainingOwnedPages: 0,
    };
  }
}

function createPageSchedule(input: {
  startPage: number;
  maxPages: number;
  defaultPurpose: 'forward' | 'replay';
  replayThroughPage?: number;
}): Array<{ logicalPage: number; purpose: 'forward' | 'replay' }> {
  if (!Number.isInteger(input.startPage) || input.startPage < 1) {
    throw new CliError(2, 'SEARCH_START_PAGE_INVALID', 'startPage must be a positive integer.');
  }
  if (input.replayThroughPage === undefined) {
    return Array.from(
      { length: Math.max(0, input.maxPages - input.startPage + 1) },
      (_, index) => ({
        logicalPage: input.startPage + index,
        purpose: input.defaultPurpose,
      }),
    );
  }
  if (
    input.defaultPurpose !== 'forward' ||
    !Number.isInteger(input.replayThroughPage) ||
    input.replayThroughPage < 0 ||
    input.startPage !== input.replayThroughPage + 1
  ) {
    throw new CliError(
      2,
      'SEARCH_RECOVERY_SCHEDULE_INVALID',
      'Safe replay must replay pages 1..checkpoint before the immediately following forward page.',
    );
  }
  const replay = Array.from(
    { length: input.replayThroughPage },
    (_, index) => ({ logicalPage: index + 1, purpose: 'replay' as const }),
  );
  const forward = Array.from(
    { length: Math.max(0, input.maxPages - input.startPage + 1) },
    (_, index) => ({ logicalPage: input.startPage + index, purpose: 'forward' as const }),
  );
  return [...replay, ...forward];
}

function isEligibleSearchOffer(
  advertisementPolicy: CanonicalSearchParameterSetV1['advertisementPolicy'],
  offer: SearchPageCaptureV1['page']['offers'][number],
): boolean {
  return advertisementPolicy === 'archive-and-mark' || !offer.isP4P;
}

export function createSearchTerminalReceiptV1(input: {
  collectionTaskId: string;
  searchQueryKeyHash: string;
  querySnapshotHash: string;
  completedSearchSegmentIds: string[];
  completedPageActionIds: string[];
  result: SearchRuntimeResultV1;
  eligibleCandidateIds: string[];
  eligibleObservations?: Array<{
    logicalPage: number;
    sourceOrdinal: number;
    offerId: string;
    isP4P: boolean;
    responseBusinessHash: string;
  }>;
  advertisementPolicy: CanonicalSearchParameterSetV1['advertisementPolicy'];
  terminalAt: string;
}) {
  if (input.result.status !== 'completed' || input.result.terminalReason === null) {
    throw new CliError(9, 'SEARCH_NOT_TERMINAL', 'Partial, cancelled, or failed search cannot publish a terminal receipt.');
  }
  const completedPages = input.result.pages.map(
    (capture) => capture.compiledRequest.page,
  );
  const expectedPages = Array.from(
    { length: input.result.lastCompletedPage },
    (_, index) => index + 1,
  );
  if (JSON.stringify(completedPages) !== JSON.stringify(expectedPages)) {
    throw new CliError(
      9,
      'SEARCH_OBSERVATION_UNIVERSE_INCOMPLETE',
      'Search terminal receipt requires a contiguous observation universe beginning at page 1.',
    );
  }
  const eligibleObservations = input.eligibleObservations === undefined
    ? input.result.pages.flatMap((capture) =>
        capture.page.offers.flatMap((offer, sourceOrdinal) =>
          isEligibleSearchOffer(input.advertisementPolicy, offer)
            ? [{
                logicalPage: capture.compiledRequest.page,
                sourceOrdinal,
                offerId: offer.offerId,
                isP4P: offer.isP4P,
                responseBusinessHash: capture.page.responseBusinessHash,
              }]
            : []
        )
      )
    : input.eligibleObservations.map((observation) => ({ ...observation }));
  const observationCandidateIds = [...new Set(
    eligibleObservations.map((observation) => observation.offerId),
  )].sort();
  const candidateIds = [...new Set(input.eligibleCandidateIds)].sort();
  if (JSON.stringify(candidateIds) !== JSON.stringify(observationCandidateIds)) {
    throw new CliError(
      9,
      'SEARCH_TERMINAL_CANDIDATE_UNIVERSE_MISMATCH',
      'Search terminal candidate identities must be derived from its eligible observation universe.',
      { category: 'contract', retryable: false },
    );
  }
  const content = {
    schema: 'search-query-terminal-receipt-v1' as const,
    collectionTaskId: input.collectionTaskId,
    searchQueryKeyHash: input.searchQueryKeyHash,
    querySnapshotHash: input.querySnapshotHash,
    terminalReason: input.result.terminalReason,
    completedSearchSegmentIds: [...new Set(input.completedSearchSegmentIds)].sort(),
    completedPageActionIds: [...new Set(input.completedPageActionIds)].sort(),
    lastCompletedPage: input.result.lastCompletedPage,
    eligibleSearchHitObservationSetHash: hash({
      schema: 'eligible-search-hit-observation-set-v1',
      observations: eligibleObservations,
    }),
    eligibleCandidateSetHash: hash({
      schema: 'eligible-candidate-set-v1',
      candidateIds,
    }),
    terminalAt: new Date(input.terminalAt).toISOString(),
  };
  return Object.freeze({ ...content, receiptHash: hash(content) });
}

export type SearchTerminalReceiptV1 = ReturnType<
  typeof createSearchTerminalReceiptV1
>;

export function assertSearchTerminalReceiptV1(
  receipt: SearchTerminalReceiptV1,
): void {
  const { receiptHash, ...content } = receipt;
  if (
    receipt.schema !== 'search-query-terminal-receipt-v1' ||
    !['source-end', 'configured-page-limit', 'configured-offer-limit'].includes(
      receipt.terminalReason,
    ) ||
    !/^sha256:[0-9a-f]{64}$/u.test(receipt.eligibleSearchHitObservationSetHash) ||
    !/^sha256:[0-9a-f]{64}$/u.test(receipt.eligibleCandidateSetHash) ||
    receiptHash !== hash(content)
  ) {
    throw new TypeError('Search terminal receipt is invalid or corrupted.');
  }
}

function consumeBudget(
  purpose: 'forward' | 'replay',
  attempts: SearchRemoteAttemptV1[],
  forwardBudget: number,
  replayBudget: number,
): void {
  const consumed = attempts.filter((attempt) => attempt.purpose === purpose).length;
  const available = purpose === 'forward' ? forwardBudget : replayBudget;
  if (consumed >= available) {
    throw new CliError(9, `SEARCH_${purpose.toUpperCase()}_BUDGET_EXHAUSTED`, `${purpose} page budget is exhausted.`, {
      category: 'contract',
      retryable: false,
      recoveryAction: 'reserve-page-budget',
    });
  }
}

function assertBudget(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError(2, 'SEARCH_BUDGET_INVALID', `${field} must be a non-negative integer.`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CliError(9, 'COLLECTION_CANCELLED', 'Search action was cancelled.', {
      category: 'cancelled',
      retryable: false,
      recoveryAction: 'lookup-terminal-receipt',
    });
  }
}

function collectorErrorCode(error: unknown): string {
  return error instanceof CliError ? error.code : 'SEARCH_REMOTE_REQUEST_FAILED';
}

function isRetryableProtocol(error: unknown): boolean {
  return error instanceof CliError &&
    ['protocol', 'timeout', 'network'].includes(String(error.details.category ?? ''));
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}
