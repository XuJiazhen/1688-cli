import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../src/io/errors.js';
import { eventsFile } from '../src/session/paths.js';
import {
  appendEvent,
  endEvent,
  eventFromError,
  readRecentEvents,
  sanitizeForEvent,
  startEvent,
} from '../src/session/events.js';

let tmpHome: string;
let previousHome: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-events-'));
  previousHome = process.env.BB1688_HOME;
  process.env.BB1688_HOME = tmpHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.BB1688_HOME;
  else process.env.BB1688_HOME = previousHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('command events', () => {
  it('writes and reads recent events from the 1688 home', async () => {
    await appendEvent(startEvent({ requestId: 'req-1', cmd: 'search' }));
    await appendEvent(endEvent({ requestId: 'req-1', cmd: 'search', startedAt: Date.now() - 5 }));

    expect(eventsFile()).toBe(path.join(tmpHome, 'events.jsonl'));
    const events = await readRecentEvents();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ requestId: 'req-1', cmd: 'search', phase: 'start' });
    expect(events[1]).toMatchObject({ requestId: 'req-1', cmd: 'search', phase: 'end', status: 'ok' });
    expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('limits reads to the most recent entries', async () => {
    await appendEvent(startEvent({ requestId: 'req-1', cmd: 'one' }));
    await appendEvent(startEvent({ requestId: 'req-2', cmd: 'two' }));
    await appendEvent(startEvent({ requestId: 'req-3', cmd: 'three' }));

    const events = await readRecentEvents(2);

    expect(events.map((e) => e.requestId)).toEqual(['req-2', 'req-3']);
  });

  it('redacts sensitive nested fields before writing', async () => {
    await appendEvent({
      ts: new Date().toISOString(),
      requestId: 'req-secret',
      cmd: 'seller-chat',
      phase: 'error',
      status: 'error',
      warnings: [
        {
          code: 'TEST',
          message: 'warning message',
          details: {
            token: 'abc',
            nested: { authorization: 'Bearer xyz', safe: 'ok' },
          },
        },
      ],
    });

    const raw = await fs.readFile(eventsFile(), 'utf8');
    expect(raw).not.toContain('abc');
    expect(raw).not.toContain('Bearer xyz');
    expect(raw).toContain('[redacted]');
    expect(raw).toContain('ok');
  });

  it('builds error events from CliError details', () => {
    const error = new CliError(4, 'RISK_CONTROL', 'blocked', {
      artifactDir: '/tmp/artifact',
      currentUrl: 'https://punish.1688.com/',
      pageState: 'rate_limited',
      category: 'risk_control',
      retryable: true,
    });

    const event = eventFromError({
      requestId: 'req-error',
      cmd: 'search',
      profile: 'work',
      startedAt: Date.now() - 10,
      error,
    });

    expect(event).toMatchObject({
      requestId: 'req-error',
      cmd: 'search',
      profile: 'work',
      phase: 'error',
      status: 'error',
      artifactDir: '/tmp/artifact',
      errorCode: 'RISK_CONTROL',
      pageState: 'rate_limited',
      retryable: true,
      verification: {
        state: 'risk_control',
        reason: 'rate_limited',
        currentUrl: 'https://punish.1688.com/',
      },
    });
  });

  it('redacts sensitive keys in arbitrary values', () => {
    expect(
      sanitizeForEvent({
        cookie: 'a=b',
        safe: ['x', { password: 'secret', visible: true }],
      }),
    ).toEqual({
      cookie: '[redacted]',
      safe: ['x', { password: '[redacted]', visible: true }],
    });
  });

  it('redacts sensitive query values from URL fields', () => {
    expect(sanitizeForEvent({
      currentUrl:
        'https://h5api.m.1688.com/h5/catalog/1.0/?api=catalog&sign=secret&data=private',
    })).toEqual({
      currentUrl:
        'https://h5api.m.1688.com/h5/catalog/1.0/?api=catalog&sign=%5Bredacted%5D&data=%5Bredacted%5D',
    });
  });
});
