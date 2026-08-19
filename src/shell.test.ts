import { describe, expect, it } from 'vitest';

import { realShell } from './shell';

/**
 * The real implementation, run against real commands.
 *
 * Everything downstream injects a fake Shell, so this is the one place the
 * actual spawn is exercised. Without it the seam is tested and the thing it
 * stands in for is not, which is the failure mode where every test passes and
 * nothing works.
 */
describe('realShell', () => {
  it('returns what the command printed', async () => {
    const { stdout } = await realShell('echo', ['hello harness']);

    expect(stdout.trim()).toBe('hello harness');
  });

  it('gives back a string, not a Buffer', async () => {
    // execFile's type admits a Buffer, and every caller parses the result as
    // text. A Buffer here would make `.split` and `.trim` behave subtly wrong
    // rather than fail loudly.
    const { stdout } = await realShell('echo', ['x']);

    expect(typeof stdout).toBe('string');
  });

  it('rejects when the command fails, rather than returning empty output', async () => {
    // take.ts reads ffprobe output and refuses a probe that printed nothing.
    // That guard only helps if a failed spawn throws instead of arriving here
    // as an empty string.
    await expect(realShell('false', [])).rejects.toThrow();
  });

  it('names the missing program, and what it was wanted for', async () => {
    // Node says `spawn ffprobe ENOENT`, which names neither what to install nor
    // why anything wanted it. This surfaces at the END of a walkthrough that
    // otherwise worked, to someone running the recorder for the first time.
    await expect(
      realShell('ffprobe-that-is-not-installed', []),
    ).rejects.toThrow(
      /ffprobe-that-is-not-installed is not installed, or not on PATH/,
    );
  });

  it('says how to install it, for both package managers', async () => {
    await expect(
      realShell('ffprobe-that-is-not-installed', []),
    ).rejects.toThrow(/brew install ffmpeg.*apt-get install ffmpeg/);
  });

  it('leaves a real failure to speak for itself', async () => {
    // A program that ran and exited non-zero has its own diagnostic, and
    // replacing it with an install hint would be actively misleading.
    await expect(realShell('false', [])).rejects.toThrow(
      /Command failed|exit code/,
    );
  });

  it('keeps the original error as the cause, so nothing is lost', async () => {
    const thrown = await realShell('ffprobe-that-is-not-installed', []).then(
      () => undefined,
      (error: Error) => error,
    );

    expect((thrown?.cause as { code?: string })?.code).toBe('ENOENT');
  });
});
