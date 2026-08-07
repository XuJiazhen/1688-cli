import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { mapOffer } from '../src/session/search-mtop.js';
import {
  compileSearchParameterSetV1,
  type CanonicalSearchParameterSetV1,
} from '../src/session/search-compiler.js';
import {
  createSearchTerminalReceiptV1,
  runCompiledSearchActionV1,
  type SearchPageRuntimePortV1,
} from '../src/session/search-runtime.js';
import type { SearchPageCaptureV1 } from '../src/session/search-capture.js';
import { CliError } from '../src/io/errors.js';

function parameterSet(
  maxPages = 3,
  maxOffers = 500,
  advertisementPolicy: CanonicalSearchParameterSetV1['advertisementPolicy'] = 'exclude-p4p',
): CanonicalSearchParameterSetV1 {
  return compileSearchParameterSetV1({
    keyword: 'fixture', sort: 'relevance',
    filterConfigSnapshotId: 'filters-1', filterConfigSnapshotHash: `sha256:${'1'.repeat(64)}`,
    serializerCapabilitySnapshotId: 'serializers-1', serializerCapabilitySnapshotHash: `sha256:${'2'.repeat(64)}`,
    filterParams: {}, selectedOptions: [], maxPages, maxOffers,
    advertisementPolicy,
  });
}

function offer(id: string) {
  return mapOffer({ data: { offerId: id, title: `Offer ${id}` } })!;
}

function runtime(pages: Array<{ ids: string[]; hasMore: boolean; fingerprint?: string; p4pIds?: string[] }>) {
  let call = 0;
  let closeCount = 0;
  const port: SearchPageRuntimePortV1 = {
    createPage: async () => ({}) as Page,
    pageSessionId: async () => 'session-1',
    fetchPage: async ({ compiledRequest }) => {
      const entry = pages[call++]!;
      return {
        compiledRequest,
        observedAt: '2026-07-31T00:00:00.000Z',
        page: {
          offers: entry.ids.map((id) => ({ ...offer(id), isP4P: entry.p4pIds?.includes(id) ?? false })), rawItems: [], hasMore: entry.hasMore,
          found: 1000,
          responseBusinessHash: entry.fingerprint ?? `sha256:${String(call).padStart(64, '0')}`,
        },
        sanitizedRequest: {
          appId: '32517', method: 'getOfferList', page: compiledRequest.page,
          pageSize: 60, sort: 'normal', descendOrder: true,
          pageSessionHash: compiledRequest.pageSessionHash, filterParams: {},
          requestBusinessHash: compiledRequest.requestBusinessHash,
        },
      } satisfies SearchPageCaptureV1;
    },
    closePage: async () => { closeCount++; },
    pace: async () => {},
    randomDelayMs: () => 3_000,
  };
  return { port, calls: () => call, closes: () => closeCount };
}

describe('compiled Search pagination runtime', () => {
  it('continues through 55 and 59 item short pages while source says hasMore', async () => {
    const first = Array.from({ length: 55 }, (_, index) => `1${index.toString().padStart(3, '0')}`);
    const second = Array.from({ length: 59 }, (_, index) => `2${index.toString().padStart(3, '0')}`);
    const fake = runtime([
      { ids: first, hasMore: true },
      { ids: second, hasMore: true },
      { ids: ['3000'], hasMore: false },
    ]);
    const result = await runCompiledSearchActionV1({
      parameterSet: parameterSet(), port: fake.port,
      forwardPageBudget: 5, replayPageBudget: 0,
    });
    expect(result).toMatchObject({
      status: 'completed', terminalReason: 'source-end',
      lastCompletedPage: 3, createdPages: 1, closedPages: 1,
    });
    expect(result.offers).toHaveLength(115);
    expect(fake.calls()).toBe(3);
    expect(fake.closes()).toBe(1);
  });

  it.each([
    ['empty', [], 'same'],
    ['duplicate', ['1000'], 'different'],
    ['fingerprint', ['2000'], 'same'],
  ] as const)('retries hasMore no-progress (%s) three times and never completes', async (_case, ids, fingerprintMode) => {
    const firstFingerprint = `sha256:${'a'.repeat(64)}`;
    const retryFingerprint = fingerprintMode === 'same' ? firstFingerprint : `sha256:${'b'.repeat(64)}`;
    const fake = runtime([
      { ids: ['1000'], hasMore: true, fingerprint: firstFingerprint },
      { ids: [...ids], hasMore: true, fingerprint: retryFingerprint },
      { ids: [...ids], hasMore: true, fingerprint: retryFingerprint },
      { ids: [...ids], hasMore: true, fingerprint: retryFingerprint },
    ]);
    const result = await runCompiledSearchActionV1({
      parameterSet: parameterSet(), port: fake.port,
      forwardPageBudget: 10, replayPageBudget: 0,
    });
    expect(result).toMatchObject({
      status: 'partial', terminalReason: null,
      errorCode: 'SEARCH_PAGINATION_NO_PROGRESS', lastCompletedPage: 1,
    });
    expect(result.attempts.slice(1)).toHaveLength(3);
    expect(() => createSearchTerminalReceiptV1({
      collectionTaskId: 'task', searchQueryKeyHash: `sha256:${'1'.repeat(64)}`,
      querySnapshotHash: `sha256:${'2'.repeat(64)}`,
      completedSearchSegmentIds: ['segment'], completedPageActionIds: ['action'],
      result, eligibleCandidateIds: [], advertisementPolicy: 'exclude-p4p',
      terminalAt: '2026-07-31T00:00:00.000Z',
    })).toThrow(/cannot publish/i);
  });

  it('does not borrow replay budget from forward budget and always closes the page', async () => {
    const fake = runtime([{ ids: ['1000'], hasMore: false }]);
    await expect(runCompiledSearchActionV1({
      parameterSet: parameterSet(1), port: fake.port, purpose: 'replay',
      forwardPageBudget: 10, replayPageBudget: 0,
    })).rejects.toMatchObject({ code: 'SEARCH_REPLAY_BUDGET_EXHAUSTED' });
    expect(fake.calls()).toBe(0);
    expect(fake.closes()).toBe(1);
  });

  it('binds a captured page to the actual successful retry ordinal and replay purpose', async () => {
    const fake = runtime([{ ids: ['1000'], hasMore: false }]);
    const successfulFetch = fake.port.fetchPage;
    let first = true;
    fake.port.fetchPage = async (input) => {
      if (first) {
        first = false;
        throw new CliError(9, 'SEARCH_PROTOCOL_RETRY', 'retry fixture', {
          category: 'protocol', retryable: true,
        });
      }
      return successfulFetch(input);
    };
    const result = await runCompiledSearchActionV1({
      parameterSet: parameterSet(1), port: fake.port, purpose: 'replay',
      forwardPageBudget: 0, replayPageBudget: 2,
    });
    expect(result.attempts).toMatchObject([
      { ordinal: 1, purpose: 'replay', status: 'failed' },
      { ordinal: 2, purpose: 'replay', status: 'succeeded' },
    ]);
    expect(result.pageAttemptBindings).toEqual([{
      logicalPage: 1,
      attemptOrdinal: 2,
      purpose: 'replay',
      requestBusinessHash: result.pages[0]?.compiledRequest.requestBusinessHash,
      responseBusinessHash: result.pages[0]?.page.responseBusinessHash,
    }]);
  });

  it('replays the complete checkpoint before forwarding and charges each purpose separately', async () => {
    const fake = runtime([
      { ids: ['1000'], hasMore: true },
      { ids: ['1000', '2000'], hasMore: true },
      { ids: ['3000'], hasMore: false },
    ]);
    const result = await runCompiledSearchActionV1({
      parameterSet: parameterSet(3),
      port: fake.port,
      startPage: 3,
      replayThroughPage: 2,
      forwardPageBudget: 1,
      replayPageBudget: 2,
    });
    expect(result).toMatchObject({
      status: 'completed', terminalReason: 'source-end', lastCompletedPage: 3,
    });
    expect(result.pages.map((capture) => capture.compiledRequest.page)).toEqual([1, 2, 3]);
    expect(result.attempts.map((attempt) => attempt.purpose)).toEqual([
      'replay', 'replay', 'forward',
    ]);
    expect(result.offers.map((entry) => entry.offerId)).toEqual(['1000', '2000', '3000']);

    const firstPageRetry = runtime([{ ids: ['1000'], hasMore: false }]);
    const firstPageResult = await runCompiledSearchActionV1({
      parameterSet: parameterSet(1), port: firstPageRetry.port,
      startPage: 1, replayThroughPage: 0,
      forwardPageBudget: 1, replayPageBudget: 0,
    });
    expect(firstPageResult.attempts).toMatchObject([{ purpose: 'forward' }]);
  });

  it('cannot freeze a terminal universe that begins after page 1', async () => {
    const fake = runtime([{ ids: ['2000'], hasMore: false }]);
    const result = await runCompiledSearchActionV1({
      parameterSet: parameterSet(2), port: fake.port, startPage: 2,
      forwardPageBudget: 1, replayPageBudget: 0,
    });
    expect(result.status).toBe('completed');
    expect(() => createSearchTerminalReceiptV1({
      collectionTaskId: 'task', searchQueryKeyHash: `sha256:${'1'.repeat(64)}`,
      querySnapshotHash: `sha256:${'2'.repeat(64)}`,
      completedSearchSegmentIds: ['segment-2'], completedPageActionIds: ['action'],
      result, eligibleCandidateIds: ['2000'], advertisementPolicy: 'exclude-p4p',
      terminalAt: '2026-07-31T00:00:00.000Z',
    })).toThrowError(expect.objectContaining({
      code: 'SEARCH_OBSERVATION_UNIVERSE_INCOMPLETE',
    }));
  });

  it('hashes ordered SearchHit observations independently from the candidate ID set', async () => {
    const single = runtime([{ ids: ['1000'], hasMore: false }]);
    const duplicate = runtime([{ ids: ['1000', '1000'], hasMore: false }]);
    const ordered = runtime([{ ids: ['1000', '2000'], hasMore: false }]);
    const reversed = runtime([{ ids: ['2000', '1000'], hasMore: false }]);
    const singleResult = await runCompiledSearchActionV1({
      parameterSet: parameterSet(1), port: single.port,
      forwardPageBudget: 1, replayPageBudget: 0,
    });
    const duplicateResult = await runCompiledSearchActionV1({
      parameterSet: parameterSet(1), port: duplicate.port,
      forwardPageBudget: 1, replayPageBudget: 0,
    });
    const orderedResult = await runCompiledSearchActionV1({
      parameterSet: parameterSet(1), port: ordered.port,
      forwardPageBudget: 1, replayPageBudget: 0,
    });
    const reversedResult = await runCompiledSearchActionV1({
      parameterSet: parameterSet(1), port: reversed.port,
      forwardPageBudget: 1, replayPageBudget: 0,
    });
    const receipt = (result: typeof singleResult, candidateIds = ['1000']) =>
      createSearchTerminalReceiptV1({
        collectionTaskId: 'task', searchQueryKeyHash: `sha256:${'1'.repeat(64)}`,
        querySnapshotHash: `sha256:${'2'.repeat(64)}`,
        completedSearchSegmentIds: ['segment'], completedPageActionIds: ['action'],
        result, eligibleCandidateIds: candidateIds, advertisementPolicy: 'exclude-p4p',
        terminalAt: '2026-07-31T00:00:00.000Z',
      });
    const singleReceipt = receipt(singleResult);
    const duplicateReceipt = receipt(duplicateResult);
    expect(singleReceipt.eligibleCandidateSetHash).toBe(duplicateReceipt.eligibleCandidateSetHash);
    expect(singleReceipt.eligibleSearchHitObservationSetHash)
      .not.toBe(duplicateReceipt.eligibleSearchHitObservationSetHash);
    expect(singleReceipt.eligibleSearchHitObservationSetHash)
      .not.toBe(singleReceipt.eligibleCandidateSetHash);
    const orderedReceipt = receipt(orderedResult, ['1000', '2000']);
    const reversedReceipt = receipt(reversedResult, ['2000', '1000']);
    expect(orderedReceipt.eligibleCandidateSetHash).toBe(reversedReceipt.eligibleCandidateSetHash);
    expect(orderedReceipt.eligibleSearchHitObservationSetHash)
      .not.toBe(reversedReceipt.eligibleSearchHitObservationSetHash);
  });

  it('freezes eligible sets only for a normal terminal result', async () => {
    const fake = runtime([{ ids: ['1000'], hasMore: false }]);
    const result = await runCompiledSearchActionV1({
      parameterSet: parameterSet(1), port: fake.port,
      forwardPageBudget: 1, replayPageBudget: 0,
    });
    const receipt = createSearchTerminalReceiptV1({
      collectionTaskId: 'task', searchQueryKeyHash: `sha256:${'1'.repeat(64)}`,
      querySnapshotHash: `sha256:${'2'.repeat(64)}`,
      completedSearchSegmentIds: ['segment'], completedPageActionIds: ['action'],
      result, eligibleCandidateIds: ['1000'], advertisementPolicy: 'exclude-p4p',
      terminalAt: '2026-07-31T00:00:00.000Z',
    });
    expect(receipt).toMatchObject({ terminalReason: 'source-end', lastCompletedPage: 1 });
    expect(receipt.receiptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => createSearchTerminalReceiptV1({
      collectionTaskId: 'task', searchQueryKeyHash: `sha256:${'1'.repeat(64)}`,
      querySnapshotHash: `sha256:${'2'.repeat(64)}`,
      completedSearchSegmentIds: ['segment'], completedPageActionIds: ['action'],
      result, eligibleCandidateIds: ['invented-id'], advertisementPolicy: 'exclude-p4p',
      terminalAt: '2026-07-31T00:00:00.000Z',
    })).toThrowError(expect.objectContaining({
      code: 'SEARCH_TERMINAL_CANDIDATE_UNIVERSE_MISMATCH',
    }));
  });

  it('archives P4P observations but excludes them from eligible results and hashes by policy', async () => {
    const excluded = runtime([{ ids: ['1000', '2000'], p4pIds: ['1000'], hasMore: false }]);
    const excludedResult = await runCompiledSearchActionV1({
      parameterSet: parameterSet(1, 10, 'exclude-p4p'),
      port: excluded.port,
      forwardPageBudget: 1,
      replayPageBudget: 0,
    });
    expect(excludedResult.pages[0]?.page.offers.map((entry) => entry.offerId)).toEqual(['1000', '2000']);
    expect(excludedResult.offers.map((entry) => entry.offerId)).toEqual(['2000']);
    const excludedReceipt = createSearchTerminalReceiptV1({
      collectionTaskId: 'task', searchQueryKeyHash: `sha256:${'1'.repeat(64)}`,
      querySnapshotHash: `sha256:${'2'.repeat(64)}`,
      completedSearchSegmentIds: ['segment'], completedPageActionIds: ['action'],
      result: excludedResult, eligibleCandidateIds: ['2000'], advertisementPolicy: 'exclude-p4p',
      terminalAt: '2026-07-31T00:00:00.000Z',
    });

    const archived = runtime([{ ids: ['1000', '2000'], p4pIds: ['1000'], hasMore: false }]);
    const archivedResult = await runCompiledSearchActionV1({
      parameterSet: parameterSet(1, 10, 'archive-and-mark'),
      port: archived.port,
      forwardPageBudget: 1,
      replayPageBudget: 0,
    });
    expect(archivedResult.offers.map((entry) => entry.offerId)).toEqual(['1000', '2000']);
    const archivedReceipt = createSearchTerminalReceiptV1({
      collectionTaskId: 'task', searchQueryKeyHash: `sha256:${'1'.repeat(64)}`,
      querySnapshotHash: `sha256:${'2'.repeat(64)}`,
      completedSearchSegmentIds: ['segment'], completedPageActionIds: ['action'],
      result: archivedResult, eligibleCandidateIds: ['1000', '2000'],
      advertisementPolicy: 'archive-and-mark', terminalAt: '2026-07-31T00:00:00.000Z',
    });
    expect(excludedReceipt.eligibleSearchHitObservationSetHash)
      .not.toBe(archivedReceipt.eligibleSearchHitObservationSetHash);
  });

  it('clips the terminal observation and candidate universe exactly at maxOffers', async () => {
    const fake = runtime([{
      ids: ['9000', '1000', '1000', '2000', '3000'],
      p4pIds: ['9000'],
      hasMore: true,
    }]);
    const result = await runCompiledSearchActionV1({
      parameterSet: parameterSet(1, 2, 'exclude-p4p'),
      port: fake.port,
      forwardPageBudget: 1,
      replayPageBudget: 0,
    });
    expect(result).toMatchObject({
      status: 'completed',
      terminalReason: 'configured-offer-limit',
    });
    expect(result.offers.map((entry) => entry.offerId)).toEqual(['1000', '2000']);
    const responseBusinessHash = result.pages[0]!.page.responseBusinessHash;
    const allEligibleObservations = [
      { logicalPage: 1, sourceOrdinal: 1, offerId: '1000', isP4P: false, responseBusinessHash },
      { logicalPage: 1, sourceOrdinal: 2, offerId: '1000', isP4P: false, responseBusinessHash },
      { logicalPage: 1, sourceOrdinal: 3, offerId: '2000', isP4P: false, responseBusinessHash },
      { logicalPage: 1, sourceOrdinal: 4, offerId: '3000', isP4P: false, responseBusinessHash },
    ];
    const input = {
      collectionTaskId: 'task', searchQueryKeyHash: `sha256:${'1'.repeat(64)}`,
      querySnapshotHash: `sha256:${'2'.repeat(64)}`,
      completedSearchSegmentIds: ['segment'], completedPageActionIds: ['action'],
      result, eligibleCandidateIds: ['1000', '2000'],
      advertisementPolicy: 'exclude-p4p' as const,
      terminalAt: '2026-07-31T00:00:00.000Z',
    };
    const fromOverflow = createSearchTerminalReceiptV1({
      ...input,
      eligibleObservations: allEligibleObservations,
    });
    const fromExactCut = createSearchTerminalReceiptV1({
      ...input,
      eligibleObservations: allEligibleObservations.slice(0, 3),
    });
    expect(fromOverflow.eligibleSearchHitObservationSetHash)
      .toBe(fromExactCut.eligibleSearchHitObservationSetHash);
    expect(() => createSearchTerminalReceiptV1({
      ...input,
      eligibleCandidateIds: ['1000', '2000', '3000'],
      eligibleObservations: allEligibleObservations,
    })).toThrowError(expect.objectContaining({
      code: 'SEARCH_TERMINAL_CANDIDATE_UNIVERSE_MISMATCH',
    }));
  });
});
