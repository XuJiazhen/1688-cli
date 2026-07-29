import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanFixtureSecrets } from '../src/session/redaction.js';

async function fixtureFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? fixtureFiles(target) : [target];
  }));
  return nested.flat();
}

describe('committed replay fixtures', () => {
  it('contain no replayable credentials or unrelated personal contacts', async () => {
    const root = path.join(process.cwd(), 'tests', 'fixtures');
    const findings: Array<{ file: string; violations: string[] }> = [];
    for (const file of await fixtureFiles(root)) {
      const violations = scanFixtureSecrets(await readFile(file, 'utf8'));
      if (violations.length > 0) {
        findings.push({ file: path.relative(process.cwd(), file), violations });
      }
    }
    expect(findings).toEqual([]);
  });

  it('keeps JSON fixture payloads within each directory allowlist', async () => {
    const root = path.join(process.cwd(), 'tests', 'fixtures');
    const violations: string[] = [];
    for (const directory of [
      'store-catalog',
      'store-profile',
      'store-qualification',
    ]) {
      const fixtureDirectory = path.join(root, directory);
      const manifest = JSON.parse(
        await readFile(path.join(fixtureDirectory, 'manifest.json'), 'utf8'),
      ) as { allowedTopLevelFields: string[] };
      const allowed = new Set(manifest.allowedTopLevelFields);
      for (const file of await fixtureFiles(fixtureDirectory)) {
        if (!file.endsWith('.json') || file.endsWith('manifest.json')) continue;
        const payload = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        const unexpected = Object.keys(payload).filter((key) => !allowed.has(key));
        if (unexpected.length) {
          violations.push(`${path.relative(process.cwd(), file)}: ${unexpected.join(', ')}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
