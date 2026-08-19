import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The published surface, which nothing has ever resolved.
 *
 * Both consumers dodge it: the shop example imports '../../src/index' by
 * relative path, and the other consumer holds a byte-copy of the whole library. So the README's
 * first line, `import { recordTake } from 'walkthrough-recorder'`, has never
 * been executed by anyone.
 *
 * These assert the contract. The proof that it RESOLVES is the pack-and-install
 * job in CI, because only a real install can tell you whether a consumer's
 * tsconfig can see the types.
 */
const ROOT = resolve(__dirname, '..');
const manifest = JSON.parse(
  readFileSync(`${ROOT}/package.json`, 'utf8'),
) as Record<string, unknown>;

describe('the published package', () => {
  it('does not point consumers at TypeScript source', () => {
    // main: './src/index.ts' means a consumer either hits
    // ERR_UNKNOWN_FILE_EXTENSION at runtime or compiles 3700 lines of someone
    // else's source under their own tsconfig.
    expect(String(manifest.main ?? '')).not.toMatch(/\.ts$/);
  });

  it('declares where its types are', () => {
    expect(manifest.types ?? manifest.typings).toBeDefined();
  });

  it('declares an exports map, so deep imports cannot bypass the surface', () => {
    expect(manifest.exports).toBeDefined();
  });

  it('ships only what it means to ship', () => {
    // Without `files`, the tarball carries examples/, the .profile directory,
    // and the two CLI entrypoints that execute on import.
    expect(manifest.files).toBeDefined();
  });

  it('has a build, since it publishes JavaScript', () => {
    expect((manifest.scripts as Record<string, string>)?.build).toBeDefined();
  });

  it('builds an entry point that actually exists', () => {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });

    expect(existsSync(`${ROOT}/${String(manifest.main)}`)).toBe(true);
    expect(existsSync(`${ROOT}/${String(manifest.types)}`)).toBe(true);
  });
});
