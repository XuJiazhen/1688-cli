import { describe, expect, it } from 'vitest';
import { managedStartTimeoutMs } from '../src/daemon/manager.js';

describe('managed daemon startup timeout', () => {
  it('keeps the default and accepts the bounded Compose cold-start override', () => {
    expect(managedStartTimeoutMs(undefined)).toBe(15_000);
    expect(managedStartTimeoutMs('60000')).toBe(60_000);
  });

  it.each(['14999', '120001', '1.5', 'not-a-number'])(
    'rejects an unsafe timeout value %s',
    (value) => expect(() => managedStartTimeoutMs(value)).toThrow(
      /BB1688_MANAGED_START_TIMEOUT_MS/,
    ),
  );
});
