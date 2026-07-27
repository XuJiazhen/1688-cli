import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { CliError } from '../src/io/errors.js';
import { captureFailureArtifact } from '../src/session/artifacts.js';

function mockContext(): BrowserContext {
  return {
    pages: () => [],
  } as unknown as BrowserContext;
}

describe('captureFailureArtifact', () => {
  it('rejects a traversal requestId at the filesystem boundary', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-artifacts-'));
    const previousHome = process.env.BB1688_HOME;
    process.env.BB1688_HOME = home;
    try {
      await expect(
        captureFailureArtifact(
          mockContext(),
          { requestId: '..', cmd: 'collect', args: {} },
          new Error('fixture failure'),
        ),
      ).rejects.toThrow('safe path segment');
      await expect(fs.readdir(home)).resolves.toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.BB1688_HOME;
      else process.env.BB1688_HOME = previousHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('persists response capture diagnostics from CliError details', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-artifacts-'));
    const previousHome = process.env.BB1688_HOME;
    process.env.BB1688_HOME = home;
    try {
      const responseCapture = {
        timeoutMs: 10,
        startedAt: '2026-05-15T00:00:00.000Z',
        disposed: true,
        settled: false,
        timedOut: true,
        seenCount: 1,
        matchedCount: 1,
        parsedCount: 0,
        emptyResultCount: 0,
        failureCount: 1,
        lastSeenUrl: 'https://example.com/api',
        lastMatchedUrl: 'https://example.com/api',
        failures: [
          {
            at: '2026-05-15T00:00:00.001Z',
            phase: 'parse',
            url: 'https://example.com/api',
            name: 'SyntaxError',
            message: 'Unexpected token',
          },
        ],
        emptyResults: [],
      };
      const error = new CliError(11, 'NO_CART_DATA', 'missing cart data', {
        category: 'response_capture',
        responseCapture,
      });

      const details = await captureFailureArtifact(
        mockContext(),
        { cmd: 'cart-list', args: {} },
        error,
      );

      expect(details.artifactDir).toBeTruthy();
      const artifactDir = details.artifactDir!;
      const responseCaptureFile = JSON.parse(
        await fs.readFile(path.join(artifactDir, 'response-capture.json'), 'utf8'),
      );
      const meta = JSON.parse(
        await fs.readFile(path.join(artifactDir, 'meta.json'), 'utf8'),
      );

      expect(responseCaptureFile).toEqual(responseCapture);
      expect(meta.error.details.responseCapture).toEqual(responseCapture);
    } finally {
      if (previousHome === undefined) {
        delete process.env.BB1688_HOME;
      } else {
        process.env.BB1688_HOME = previousHome;
      }
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('redacts network URLs and command metadata before persisting artifacts', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-artifacts-'));
    const previousHome = process.env.BB1688_HOME;
    process.env.BB1688_HOME = home;
    try {
      const secretUrl =
        'https://h5api.m.1688.com/h5/catalog/1.0/?api=catalog&sign=secret&data=%7B%22memberId%22%3A%22private%22%7D';
      const details = await captureFailureArtifact(
        mockContext(),
        { cmd: 'collect', args: { requestUrl: secretUrl, token: 'secret' } },
        new CliError(1, 'CAPTURE_TIMEOUT', `Timed out at ${secretUrl}`),
        {
          trace: {
            console: [],
            pageErrors: [],
            network: {
              recent: [{ url: secretUrl }],
              failed: [],
              httpErrors: [],
            },
          },
        },
      );

      const networkText = await fs.readFile(
        path.join(details.artifactDir!, 'network.json'),
        'utf8',
      );
      const metaText = await fs.readFile(
        path.join(details.artifactDir!, 'meta.json'),
        'utf8',
      );
      expect(`${networkText}\n${metaText}`).not.toContain('secret');
      expect(`${networkText}\n${metaText}`).not.toContain('private');
      expect(networkText).toContain('api=catalog');
      expect(networkText).toContain('%5Bredacted%5D');
    } finally {
      if (previousHome === undefined) delete process.env.BB1688_HOME;
      else process.env.BB1688_HOME = previousHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each(['RISK_CONTROL', 'COLLECTION_CANCELLED'] as const)(
    'does not persist screenshot or HTML for a %s failure on an opaque challenge URL',
    async (code) => {
      const home = await fs.mkdtemp(
        path.join(os.tmpdir(), 'bb1688-artifacts-'),
      );
      const previousHome = process.env.BB1688_HOME;
      process.env.BB1688_HOME = home;
      let screenshotCalls = 0;
      let contentCalls = 0;
      const secret = 'must-not-persist';
      const challengeUrl = `https://m.1688.com/verify/${secret}`;
      const page = {
        isClosed: () => false,
        url: () => challengeUrl,
        title: async () => '',
        evaluate: async () => '',
        screenshot: async () => {
          screenshotCalls++;
        },
        content: async () => {
          contentCalls++;
          return `<html><input value="${secret}"></html>`;
        },
      };
      const context = {
        pages: () => [page],
      } as unknown as BrowserContext;

      try {
        const details = await captureFailureArtifact(
          context,
          { cmd: 'collect', args: {} },
          new CliError(
            code === 'RISK_CONTROL' ? 4 : 9,
            code,
            'Manual verification did not finish.',
          ),
        );
        const files = await fs.readdir(details.artifactDir!);
        const persisted = await Promise.all(
          files.map((file) =>
            fs.readFile(path.join(details.artifactDir!, file), 'utf8'),
          ),
        );

        expect(screenshotCalls).toBe(0);
        expect(contentCalls).toBe(0);
        expect(files).not.toContain('screenshot.png');
        expect(files).not.toContain('page.html');
        expect(persisted.join('\n')).not.toContain(secret);
        expect(details.currentUrl).toBe('[redacted-url]');
      } finally {
        if (previousHome === undefined) delete process.env.BB1688_HOME;
        else process.env.BB1688_HOME = previousHome;
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );

  it('redacts the returned URL for an ordinary failure page', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-artifacts-'));
    const previousHome = process.env.BB1688_HOME;
    process.env.BB1688_HOME = home;
    const secret = 'ordinary-secret';
    const page = {
      isClosed: () => false,
      url: () => `https://m.1688.com/offers?token=${secret}`,
      title: async () => '1688 offers',
      evaluate: async () => 'ordinary store page',
      screenshot: async () => {},
      content: async () => '<html>ordinary store page</html>',
    };
    const context = {
      pages: () => [page],
    } as unknown as BrowserContext;

    try {
      const details = await captureFailureArtifact(
        context,
        { cmd: 'collect', args: {} },
        new CliError(1, 'CAPTURE_TIMEOUT', 'Capture timed out.'),
      );
      const files = await fs.readdir(details.artifactDir!);
      const persisted = await Promise.all(
        files.map((file) =>
          fs.readFile(path.join(details.artifactDir!, file), 'utf8'),
        ),
      );

      expect(details.currentUrl).toContain('%5Bredacted%5D');
      expect(details.currentUrl).not.toContain(secret);
      expect(persisted.join('\n')).not.toContain(secret);
    } finally {
      if (previousHome === undefined) delete process.env.BB1688_HOME;
      else process.env.BB1688_HOME = previousHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
