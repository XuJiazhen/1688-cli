import { EventEmitter } from 'node:events';
import type { Page, Response as PWResponse } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { startResponseCapture } from '../src/session/response-capture.js';

class MockPage extends EventEmitter {
  on(event: 'response', listener: (response: PWResponse) => void): this {
    return super.on(event, listener);
  }

  off(event: 'response', listener: (response: PWResponse) => void): this {
    return super.off(event, listener);
  }

  emitResponse(response: PWResponse): void {
    this.emit('response', response);
  }
}

function page(): Page & MockPage {
  return new MockPage() as Page & MockPage;
}

function response(url: string, body = ''): PWResponse {
  return {
    url: () => url,
    text: async () => body,
  } as unknown as PWResponse;
}

describe('startResponseCapture', () => {
  it('returns parsed values from matching responses', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: /api/,
      parse: async (resp) => JSON.parse(await resp.text()) as { ok: boolean },
    });

    const wait = capture.wait();
    mockPage.emitResponse(response('https://example.com/api', '{"ok":true}'));

    expect(await wait).toEqual({ ok: true });
  });

  it('returns null on timeout', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 5,
      matcher: /api/,
      parse: async () => ({ ok: true }),
    });

    expect(await capture.wait()).toBeNull();
  });

  it('ignores non-matching responses', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 5,
      matcher: /api/,
      parse: async () => ({ ok: true }),
    });

    const wait = capture.wait();
    mockPage.emitResponse(response('https://example.com/other'));

    expect(await wait).toBeNull();
  });

  it('ignores null parser results and waits for the next match', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: /api/,
      parse: async (resp) => {
        const text = await resp.text();
        return text === 'ready' ? { ok: true } : null;
      },
    });

    const wait = capture.wait();
    mockPage.emitResponse(response('https://example.com/api', 'not-yet'));
    mockPage.emitResponse(response('https://example.com/api', 'ready'));

    expect(await wait).toEqual({ ok: true });
  });

  it('ignores parser errors and waits for the next match', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: /api/,
      parse: async (resp) => JSON.parse(await resp.text()) as { ok: boolean },
    });

    const wait = capture.wait();
    mockPage.emitResponse(response('https://example.com/api', 'not json'));
    mockPage.emitResponse(response('https://example.com/api', '{"ok":true}'));

    expect(await wait).toEqual({ ok: true });
  });

  it('supports function matchers', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: (resp) => resp.url().includes('/wanted'),
      parse: async () => ({ ok: true }),
    });

    const wait = capture.wait();
    mockPage.emitResponse(response('https://example.com/other'));
    mockPage.emitResponse(response('https://example.com/wanted'));

    expect(await wait).toEqual({ ok: true });
  });

  it('removes the listener after success', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: /api/,
      parse: async () => ({ ok: true }),
    });

    const wait = capture.wait();
    expect(mockPage.listenerCount('response')).toBe(1);
    mockPage.emitResponse(response('https://example.com/api'));
    await wait;

    expect(mockPage.listenerCount('response')).toBe(0);
  });

  it('removes the listener after timeout', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 5,
      matcher: /api/,
      parse: async () => ({ ok: true }),
    });

    expect(await capture.wait()).toBeNull();
    expect(mockPage.listenerCount('response')).toBe(0);
  });

  it('allows dispose to be called repeatedly', () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: /api/,
      parse: async () => ({ ok: true }),
    });

    capture.dispose();
    capture.dispose();

    expect(mockPage.listenerCount('response')).toBe(0);
  });

  it('reuses the same wait promise', async () => {
    const mockPage = page();
    const parse = vi.fn(async () => ({ ok: true }));
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: /api/,
      parse,
    });

    const first = capture.wait();
    const second = capture.wait();
    mockPage.emitResponse(response('https://example.com/api'));

    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(mockPage.listenerCount('response')).toBe(0);
  });

  it('records parser errors', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: /api/,
      parse: async (resp) => JSON.parse(await resp.text()) as { ok: boolean },
    });

    const wait = capture.wait();
    mockPage.emitResponse(response('https://example.com/api', 'not json'));
    mockPage.emitResponse(response('https://example.com/api', '{"ok":true}'));

    expect(await wait).toEqual({ ok: true });
    const diagnostics = capture.diagnostics();
    expect(diagnostics.failureCount).toBe(1);
    expect(diagnostics.failures[0]).toMatchObject({
      phase: 'parse',
      url: 'https://example.com/api',
    });
  });

  it('redacts sensitive query values from diagnostics without changing matching', async () => {
    const mockPage = page();
    const matcher = vi.fn((resp: PWResponse) =>
      resp.url().includes('sign=secret-sign'),
    );
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher,
      parse: async (resp) => {
        const body = await resp.text();
        if (body === 'bad') throw new Error('parse failed');
        return body === 'ready' ? { ok: true } : null;
      },
    });
    const sensitiveUrl =
      'https://h5api.m.1688.com/h5/mtop.example.catalog/1.0/' +
      '?api=mtop.example.catalog&sign=secret-sign&_m_h5_tk=secret-token' +
      '&data=%7B%22memberId%22%3A%22b2b-secret%22%7D';

    const wait = capture.wait();
    mockPage.emitResponse(response(sensitiveUrl, 'bad'));
    mockPage.emitResponse(response(sensitiveUrl, 'empty'));
    mockPage.emitResponse(response(sensitiveUrl, 'ready'));

    expect(await wait).toEqual({ ok: true });
    expect(matcher).toHaveBeenCalledTimes(3);
    const diagnosticsText = JSON.stringify(capture.diagnostics());
    expect(diagnosticsText).toContain('mtop.example.catalog');
    expect(diagnosticsText).not.toContain('secret-sign');
    expect(diagnosticsText).not.toContain('secret-token');
    expect(diagnosticsText).not.toContain('b2b-secret');
    expect(capture.diagnostics().lastSeenUrl).toContain('sign=%5Bredacted%5D');
  });

  it('records empty parser results', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 5,
      matcher: /api/,
      parse: async () => null,
    });

    const wait = capture.wait();
    mockPage.emitResponse(response('https://example.com/api'));

    expect(await wait).toBeNull();
    const diagnostics = capture.diagnostics();
    expect(diagnostics.matchedCount).toBe(1);
    expect(diagnostics.emptyResultCount).toBe(1);
    expect(diagnostics.emptyResults[0]).toMatchObject({
      url: 'https://example.com/api',
    });
  });

  it('records timeout diagnostics when no response matched', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 5,
      matcher: /api/,
      parse: async () => ({ ok: true }),
    });

    const wait = capture.wait();
    mockPage.emitResponse(response('https://example.com/other'));

    expect(await wait).toBeNull();
    const diagnostics = capture.diagnostics();
    expect(diagnostics.timedOut).toBe(true);
    expect(diagnostics.seenCount).toBe(1);
    expect(diagnostics.matchedCount).toBe(0);
    expect(diagnostics.lastSeenUrl).toBe('https://example.com/other');
  });

  it('records matcher errors', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 5,
      matcher: () => {
        throw new Error('bad matcher');
      },
      parse: async () => ({ ok: true }),
    });

    const wait = capture.wait();
    mockPage.emitResponse(response('https://example.com/api'));

    expect(await wait).toBeNull();
    const diagnostics = capture.diagnostics();
    expect(diagnostics.failureCount).toBe(1);
    expect(diagnostics.failures[0]).toMatchObject({
      phase: 'match',
      message: 'bad matcher',
    });
  });

  it('redacts sensitive response URLs embedded in diagnostic error messages', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 5,
      matcher: (resp) => {
        throw new Error(`matcher failed for ${resp.url()}`);
      },
      parse: async () => ({ ok: true }),
    });
    const sensitiveUrl =
      'https://h5api.m.1688.com/h5/mtop.example/1.0/?api=mtop.example&sign=secret-sign&data=secret-data';

    const wait = capture.wait();
    mockPage.emitResponse(response(sensitiveUrl));

    expect(await wait).toBeNull();
    const message = capture.diagnostics().failures[0]?.message ?? '';
    expect(message).toContain('api=mtop.example');
    expect(message).not.toContain('secret-sign');
    expect(message).not.toContain('secret-data');
  });

  it('keeps diagnostics available after dispose', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: /api/,
      parse: async () => ({ ok: true }),
    });

    const wait = capture.wait();
    mockPage.emitResponse(response('https://example.com/api'));
    await wait;
    capture.dispose();

    expect(capture.diagnostics()).toMatchObject({
      disposed: true,
      settled: true,
      matchedCount: 1,
      parsedCount: 1,
    });
  });

  it('returns copied diagnostics arrays', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 5,
      matcher: /api/,
      parse: async () => null,
    });

    const wait = capture.wait();
    mockPage.emitResponse(response('https://example.com/api'));
    await wait;

    const diagnostics = capture.diagnostics();
    diagnostics.emptyResults.length = 0;

    expect(capture.diagnostics().emptyResults).toHaveLength(1);
  });

  it('captures responses emitted during waitForAction actions', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: /api/,
      parse: async (resp) => JSON.parse(await resp.text()) as { ok: boolean },
    });

    const result = await capture.waitForAction(async () => {
      mockPage.emitResponse(response('https://example.com/api', '{"ok":true}'));
      return 'clicked';
    });

    expect(result.actionResult).toBe('clicked');
    expect(result.response).toEqual({ ok: true });
    expect(result.diagnostics).toMatchObject({
      disposed: true,
      settled: true,
      matchedCount: 1,
      parsedCount: 1,
    });
    expect(mockPage.listenerCount('response')).toBe(0);
  });

  it('disposes and rethrows when waitForAction actions fail', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: /api/,
      parse: async () => ({ ok: true }),
    });

    await expect(
      capture.waitForAction(async () => {
        throw new Error('click failed');
      }),
    ).rejects.toThrow('click failed');

    expect(mockPage.listenerCount('response')).toBe(0);
    expect(capture.diagnostics()).toMatchObject({
      disposed: true,
      timedOut: false,
    });
  });

  it('preserves parser diagnostics through waitForAction', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 50,
      matcher: /api/,
      parse: async (resp) => JSON.parse(await resp.text()) as { ok: boolean },
    });

    const result = await capture.waitForAction(async () => {
      mockPage.emitResponse(response('https://example.com/api', 'not json'));
      mockPage.emitResponse(response('https://example.com/api', '{"ok":true}'));
    });

    expect(result.response).toEqual({ ok: true });
    expect(result.diagnostics.failureCount).toBe(1);
    expect(result.diagnostics.failures[0]).toMatchObject({ phase: 'parse' });
  });

  it('preserves empty-result diagnostics through waitForAction', async () => {
    const mockPage = page();
    const capture = startResponseCapture({
      page: mockPage,
      timeoutMs: 5,
      matcher: /api/,
      parse: async () => null,
    });

    const result = await capture.waitForAction(async () => {
      mockPage.emitResponse(response('https://example.com/api'));
    });

    expect(result.response).toBeNull();
    expect(result.diagnostics).toMatchObject({
      timedOut: true,
      emptyResultCount: 1,
    });
  });
});
