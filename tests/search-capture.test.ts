import { EventEmitter } from 'node:events';
import type { Page, Response as PWResponse } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { SEARCH_APP_ID, SEARCH_MTOP_API } from '../src/session/search-mtop.js';
import {
  captureSearchOffersForAction,
  startSearchPageCaptureV1,
  startSearchOfferCapture,
} from '../src/session/search-capture.js';
import {
  compileSearchPageRequestV1,
  compileSearchParameterSetV1,
} from '../src/session/search-compiler.js';

class MockPage extends EventEmitter {
  on(event: 'response', listener: (response: PWResponse) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  off(event: 'response', listener: (response: PWResponse) => void): this;
  off(event: 'close', listener: () => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  emitResponse(response: PWResponse): void {
    this.emit('response', response);
  }

  emitClose(): void {
    this.emit('close');
  }
}

function page(): Page & MockPage {
  return new MockPage() as Page & MockPage;
}

function response(url: string, body: string): PWResponse {
  return {
    url: () => url,
    text: async () => body,
  } as unknown as PWResponse;
}

function searchUrl(params: {
  appId?: string;
  method?: string;
  beginPage?: number | string;
  sortType?: string;
}): string {
  return `https://h5api.m.1688.com/h5/${SEARCH_MTOP_API}/1.0/?data=${encodeURIComponent(
    JSON.stringify({
      appId: params.appId ?? SEARCH_APP_ID,
      params: JSON.stringify({
        method: params.method,
        beginPage: params.beginPage,
        sortType: params.sortType,
      }),
    }),
  )}`;
}

function body(...offerIds: string[]): string {
  return `mtopjsonp1(${JSON.stringify({
    data: {
      data: {
        OFFER: {
          items: offerIds.map((offerId) => ({
            data: { offerId, title: `Offer ${offerId}` },
          })),
        },
      },
    },
  })})`;
}

describe('startSearchOfferCapture', () => {
  it('captures offers matching appId, method, and target page', async () => {
    const mockPage = page();
    let targetPage = 2;
    const capture = startSearchOfferCapture({
      page: mockPage,
      requireMethod: 'getOfferList',
      targetPage: () => targetPage,
    });

    const wait = capture.wait({ timeoutMs: 50, intervalMs: 1 });
    mockPage.emitResponse(response(searchUrl({ method: 'other', beginPage: 2 }), body('ignore-method')));
    mockPage.emitResponse(response(searchUrl({ method: 'getOfferList', beginPage: 1 }), body('ignore-page')));
    mockPage.emitResponse(response(searchUrl({ method: 'getOfferList', beginPage: 2 }), body('ok')));

    const result = await wait;
    expect(result.status).toBe('captured');
    expect(result.offers.map((o) => o.offerId)).toEqual(['ok']);
    expect(result.diagnostics).toMatchObject({
      disposed: false,
      finalStatus: 'captured',
      timedOut: false,
      matchedCount: 1,
    });
    expect(result.diagnostics.startedAt).toBeTruthy();
    expect(result.diagnostics.endedAt).toBeTruthy();
    expect(capture.diagnostics().matchedCount).toBe(1);
    expect(JSON.stringify(result.diagnostics)).not.toContain('getOfferList');
    expect(JSON.stringify(result.diagnostics)).not.toContain('beginPage');
    targetPage = 3;
  });

  it('ignores default search responses when a sorted response is required', async () => {
    const mockPage = page();
    const capture = startSearchOfferCapture({
      page: mockPage,
      requireMethod: 'getOfferList',
      requireSortType: 'va_price_asc',
      targetPage: () => 1,
    });

    const wait = capture.wait({ timeoutMs: 50, intervalMs: 1 });
    mockPage.emitResponse(
      response(searchUrl({ method: 'getOfferList', beginPage: 1 }), body('default')),
    );
    mockPage.emitResponse(
      response(
        searchUrl({
          method: 'getOfferList',
          beginPage: 1,
          sortType: 'va_price_asc',
        }),
        body('sorted'),
      ),
    );

    const result = await wait;
    expect(result.status).toBe('captured');
    expect(result.offers.map((o) => o.offerId)).toEqual(['sorted']);
  });

  it('can capture unscoped WirelessRecommend POST-style responses when enabled', async () => {
    const mockPage = page();
    const capture = startSearchOfferCapture({
      page: mockPage,
      allowUnscopedWirelessRecommend: true,
    });

    const wait = capture.wait({ timeoutMs: 50, intervalMs: 1 });
    mockPage.emitResponse(
      response(
        `https://h5api.m.1688.com/h5/${SEARCH_MTOP_API}/2.0/?type=originaljson`,
        body('similar'),
      ),
    );

    const result = await wait;
    expect(result.status).toBe('captured');
    expect(result.offers.map((o) => o.offerId)).toEqual(['similar']);
  });

  it('keeps the largest matching response when requested', async () => {
    const mockPage = page();
    const capture = startSearchOfferCapture({
      page: mockPage,
      keep: 'largest',
    });

    const result = await capture.waitForAction(
      async () => {
        mockPage.emitResponse(response(searchUrl({}), body('one')));
        mockPage.emitResponse(response(searchUrl({}), body('one', 'two')));
      },
      { timeoutMs: 5, intervalMs: 1 },
    );

    expect(result.status).toBe('captured');
    expect(result.offers.map((o) => o.offerId)).toEqual(['one', 'two']);
  });

  it('returns timeout when no matching offer response arrives', async () => {
    const capture = startSearchOfferCapture({ page: page() });

    const result = await capture.wait({ timeoutMs: 1, intervalMs: 1 });

    expect(result.status).toBe('timeout');
    expect(result.offers).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      finalStatus: 'timeout',
      timedOut: true,
    });
  });

  it('returns blocked when the blocked predicate becomes true', async () => {
    const capture = startSearchOfferCapture({ page: page() });

    const result = await capture.wait({
      timeoutMs: 50,
      intervalMs: 1,
      isBlocked: () => true,
    });

    expect(result.status).toBe('blocked');
    expect(result.offers).toEqual([]);
  });

  it('returns browser_closed when the page is closed by predicate', async () => {
    const capture = startSearchOfferCapture({ page: page() });

    const result = await capture.wait({
      timeoutMs: 50,
      intervalMs: 1,
      isClosed: () => true,
    });

    expect(result.status).toBe('browser_closed');
    expect(result.offers).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      finalStatus: 'browser_closed',
      timedOut: false,
    });
  });

  it('returns browser_closed when the page close event fires', async () => {
    const mockPage = page();
    const capture = startSearchOfferCapture({ page: mockPage });

    const wait = capture.wait({ timeoutMs: 50, intervalMs: 1 });
    mockPage.emitClose();
    const result = await wait;

    expect(result.status).toBe('browser_closed');
    expect(result.offers).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      finalStatus: 'browser_closed',
      timedOut: false,
    });
  });

  it('returns stream_closed when the capture is disposed before a response arrives', async () => {
    const capture = startSearchOfferCapture({ page: page() });

    capture.dispose();
    const result = await capture.wait({ timeoutMs: 50, intervalMs: 1 });

    expect(result.status).toBe('stream_closed');
    expect(result.offers).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      finalStatus: 'stream_closed',
      timedOut: false,
      disposed: true,
    });
  });

  it('scopes listener cleanup around an action', async () => {
    const mockPage = page();

    const result = await captureSearchOffersForAction(
      { page: mockPage },
      async () => {
        mockPage.emitResponse(response(searchUrl({}), body('scoped')));
      },
      { timeoutMs: 50, intervalMs: 1 },
    );

    expect(result.status).toBe('captured');
    expect(result.offers.map((o) => o.offerId)).toEqual(['scoped']);
    expect(result.diagnostics).toMatchObject({
      disposed: false,
      finalStatus: 'captured',
    });
    expect(mockPage.listenerCount('response')).toBe(0);
    expect(mockPage.listenerCount('close')).toBe(0);
  });

  it('cleans up scoped listeners when the action fails', async () => {
    const mockPage = page();

    await expect(
      captureSearchOffersForAction(
        { page: mockPage },
        async () => {
          throw new Error('navigation failed');
        },
        { timeoutMs: 50, intervalMs: 1 },
      ),
    ).rejects.toThrow('navigation failed');

    expect(mockPage.listenerCount('response')).toBe(0);
    expect(mockPage.listenerCount('close')).toBe(0);
  });

  it('records parser failures in diagnostics', async () => {
    const mockPage = page();
    const capture = startSearchOfferCapture({ page: mockPage });

    const wait = capture.wait({ timeoutMs: 5, intervalMs: 1 });
    mockPage.emitResponse(response(searchUrl({}), 'not jsonp'));
    const result = await wait;

    expect(result.status).toBe('timeout');
    expect(result.diagnostics.failureCount).toBe(1);
    expect(result.diagnostics.lastError?.message).toBeTruthy();
    expect(result.diagnostics.failures[0]?.url).toContain(SEARCH_MTOP_API);
  });
});

describe('strict Search PageAction capture', () => {
  it('drains a deferred raw archive before action cancellation returns', async () => {
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1',
      filterConfigSnapshotHash: `sha256:${'1'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1',
      serializerCapabilitySnapshotHash: `sha256:${'2'.repeat(64)}`,
      filterParams: {}, selectedOptions: [], maxPages: 1, maxOffers: 60,
      advertisementPolicy: 'exclude-p4p',
    });
    const compiledRequest = compileSearchPageRequestV1({
      parameterSet, page: 1, pageSessionId: 'session-1',
    });
    const mockPage = page();
    let archiveStarted!: () => void;
    const started = new Promise<void>((resolve) => { archiveStarted = resolve; });
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });
    let archiveCompleted = false;
    let returned = false;
    const capture = startSearchPageCaptureV1({
      page: mockPage,
      compiledRequest,
      timeoutMs: 50,
      onRawResponse: async () => {
        archiveStarted();
        await archiveGate;
        archiveCompleted = true;
      },
    });
    const pending = capture.waitForAction(async () => {
      mockPage.emitResponse(response(
        `https://h5api.m.1688.com/h5/${SEARCH_MTOP_API}/1.0/?data=${
          encodeURIComponent(compiledRequest.outerDataJson)
        }`,
        body('1001'),
      ));
      throw new Error('fixture cancellation');
    }).finally(() => { returned = true; });
    await started;
    expect(returned).toBe(false);
    releaseArchive();
    await expect(pending).rejects.toThrow('fixture cancellation');
    expect(archiveCompleted).toBe(true);
  });

  it('bounds a stuck raw archive drain with an explicit cleanup failure', async () => {
    vi.useFakeTimers();
    try {
      const parameterSet = compileSearchParameterSetV1({
        keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
        filterConfigSnapshotId: 'filter-1',
        filterConfigSnapshotHash: `sha256:${'1'.repeat(64)}`,
        serializerCapabilitySnapshotId: 'serializer-1',
        serializerCapabilitySnapshotHash: `sha256:${'2'.repeat(64)}`,
        filterParams: {}, selectedOptions: [], maxPages: 1, maxOffers: 60,
        advertisementPolicy: 'exclude-p4p',
      });
      const compiledRequest = compileSearchPageRequestV1({
        parameterSet, page: 1, pageSessionId: 'session-1',
      });
      const mockPage = page();
      let releaseArchive!: () => void;
      const gate = new Promise<void>((resolve) => { releaseArchive = resolve; });
      const capture = startSearchPageCaptureV1({
        page: mockPage, compiledRequest, timeoutMs: 100,
        onRawResponse: async () => gate,
      });
      const pending = capture.waitForAction(async () => {
        mockPage.emitResponse(response(
          `https://h5api.m.1688.com/h5/${SEARCH_MTOP_API}/1.0/?data=${
            encodeURIComponent(compiledRequest.outerDataJson)
          }`,
          body('1001'),
        ));
        throw new Error('fixture cancellation');
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'COLLECTOR_CAPTURE_DRAIN_TIMEOUT',
        details: { retryable: false },
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      releaseArchive();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers the correlated response bytes before strict parsing fails', async () => {
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1',
      filterConfigSnapshotHash: `sha256:${'1'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1',
      serializerCapabilitySnapshotHash: `sha256:${'2'.repeat(64)}`,
      filterParams: {}, selectedOptions: [], maxPages: 1, maxOffers: 60,
      advertisementPolicy: 'exclude-p4p',
    });
    const compiledRequest = compileSearchPageRequestV1({
      parameterSet, page: 1, pageSessionId: 'session-1',
    });
    const mockPage = page();
    const rawResponses: string[] = [];
    const capture = startSearchPageCaptureV1({
      page: mockPage,
      compiledRequest,
      timeoutMs: 50,
      onRawResponse: async (rawResponseText) => { rawResponses.push(rawResponseText); },
    });
    await expect(capture.waitForAction(async () => {
      mockPage.emitResponse(response(
        `https://h5api.m.1688.com/h5/${SEARCH_MTOP_API}/1.0/?data=${
          encodeURIComponent(compiledRequest.outerDataJson)
        }`,
        '{malformed-search-response',
      ));
    })).rejects.toBeTruthy();
    expect(rawResponses).toEqual(['{malformed-search-response']);
  });

  it('returns a typed retryable timeout instead of an unclassified Error', async () => {
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1',
      filterConfigSnapshotHash: `sha256:${'1'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1',
      serializerCapabilitySnapshotHash: `sha256:${'2'.repeat(64)}`,
      filterParams: {}, selectedOptions: [], maxPages: 1, maxOffers: 60,
      advertisementPolicy: 'exclude-p4p',
    });
    const capture = startSearchPageCaptureV1({
      page: page(),
      compiledRequest: compileSearchPageRequestV1({
        parameterSet, page: 1, pageSessionId: 'session-1',
      }),
      timeoutMs: 1,
    });
    await expect(capture.waitForAction(async () => undefined)).rejects.toMatchObject({
      code: 'SEARCH_RESPONSE_TIMEOUT',
      details: { category: 'timeout', retryable: true },
    });
  });
});
