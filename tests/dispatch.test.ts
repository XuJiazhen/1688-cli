import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/session/dispatch.js';

describe('dispatch request correlation', () => {
  it.each(['.', '..', 'unsafe/request'])(
    'rejects unsafe requestId %s before command dispatch',
    async (requestId) => {
      await expect(
        dispatch('unknown-command', {}, { requestId }),
      ).rejects.toThrow('non-traversing identifier');
    },
  );
});
