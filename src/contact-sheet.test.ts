import { describe, expect, it } from 'vitest';

import { contactSheets } from './contact-sheet';

import type { SheetFiles } from './contact-sheet';
import type { Shell } from './shell';

/** Records every command, and answers ffprobe with a fixed duration. */
const harness = ({
  durationSeconds = 60,
  shotsPerSlice = 24,
}: { durationSeconds?: number; shotsPerSlice?: number } = {}) => {
  const commands: string[][] = [];
  const shell: Shell = async (command, args) => {
    commands.push([command, ...args]);
    return { stdout: command === 'ffprobe' ? `${durationSeconds}\n` : '' };
  };
  const files: SheetFiles = {
    make: () => undefined,
    list: () =>
      Array.from(
        { length: shotsPerSlice },
        (_, index) => `${String(index + 1).padStart(3, '0')}.png`,
      ),
  };
  const of = (command: string) => commands.filter(([name]) => name === command);
  return { shell, files, commands, of };
};

const argumentAfter = (command: string[], flag: string) =>
  command[command.indexOf(flag) + 1];

describe('contactSheets', () => {
  it('cuts the range into slices of one sheet each', async () => {
    // 6 by 4 at 4fps is 6 seconds a sheet, so a minute is ten of them.
    const { shell, files } = harness({ durationSeconds: 60 });

    const sheets = await contactSheets({
      videoPath: 'take.mp4',
      sweepId: 'run',
      outputDir: '/out',
      shell,
      files,
    });

    expect(sheets).toHaveLength(10);
    expect(sheets[0]).toEqual({
      path: '/out/sheet-run-0.0s.png',
      fromSeconds: 0,
      toSeconds: 6,
    });
    expect(sheets.at(-1)).toEqual({
      path: '/out/sheet-run-54.0s.png',
      fromSeconds: 54,
      toSeconds: 60,
    });
  });

  it('never emits a slice narrower than a single frame', async () => {
    // The bug this exists for. Accumulating the slice width lands just under a
    // range that divides evenly (27.4 plus 4.8 is 32.199999999999996), so the
    // loop admitted one more pass whose -ss and -to rounded to the same string,
    // and ffmpeg aborts with "-to value smaller than -ss".
    const { shell, files, of } = harness();

    await contactSheets({
      videoPath: 'take.mp4',
      sweepId: 'run',
      outputDir: '/out',
      fromSeconds: 27.4,
      toSeconds: 32.2,
      fps: 10,
      columns: 8,
      rows: 6,
      shell,
      files,
    });

    for (const command of of('ffmpeg'))
      expect(Number(argumentAfter(command, '-to'))).toBeGreaterThan(
        Number(argumentAfter(command, '-ss')),
      );
  });

  it('produces exactly one sheet for a range that is one sheet wide', async () => {
    const { shell, files } = harness();

    const sheets = await contactSheets({
      videoPath: 'take.mp4',
      sweepId: 'run',
      outputDir: '/out',
      fromSeconds: 27.4,
      toSeconds: 32.2,
      fps: 10,
      columns: 8,
      rows: 6,
      shell,
      files,
    });

    expect(sheets).toEqual([
      { path: '/out/sheet-run-27.4s.png', fromSeconds: 27.4, toSeconds: 32.2 },
    ]);
  });

  it('stops at the requested end rather than the end of the video', async () => {
    const { shell, files } = harness({ durationSeconds: 600 });

    const sheets = await contactSheets({
      videoPath: 'take.mp4',
      sweepId: 'run',
      outputDir: '/out',
      fromSeconds: 10,
      toSeconds: 22,
      shell,
      files,
    });

    expect(sheets.map(sheet => sheet.fromSeconds)).toEqual([10, 16]);
  });

  it('seeks after the input, so the labels are not keyframe-rounded', async () => {
    // A sheet whose labels are approximate is worse than no sheet, because it
    // is read against the transcript. Seeking before -i snaps to the nearest
    // keyframe, which on this footage is whole seconds.
    const { shell, files, of } = harness();

    await contactSheets({
      videoPath: 'take.mp4',
      sweepId: 'run',
      outputDir: '/out',
      shell,
      files,
    });

    const [command] = of('ffmpeg');
    expect(command.indexOf('-ss')).toBeGreaterThan(command.indexOf('-i'));
  });

  it('labels every frame with its position in the whole video', async () => {
    // Not its position within the slice. The label exists to be matched against
    // a transcript timestamp, so a second sheet counting from zero again would
    // make every frame past the first sheet a lie.
    const { shell, files, of } = harness({ shotsPerSlice: 3 });

    await contactSheets({
      videoPath: 'take.mp4',
      sweepId: 'run',
      outputDir: '/out',
      fromSeconds: 12,
      toSeconds: 18,
      fps: 2,
      columns: 3,
      rows: 1,
      shell,
      files,
    });

    const labels = of('montage')[1].filter(argument => argument.endsWith('s'));
    expect(labels).toEqual(['13.50s', '14.00s', '14.50s']);
  });

  it('asks the video how long it is when no end is given', async () => {
    const { shell, files, of } = harness({ durationSeconds: 12 });

    const sheets = await contactSheets({
      videoPath: 'take.mp4',
      sweepId: 'run',
      outputDir: '/out',
      shell,
      files,
    });

    expect(of('ffprobe')[0]).toContain('take.mp4');
    expect(sheets).toHaveLength(2);
  });

  it('clears the output directory before writing into it', async () => {
    // Otherwise a narrower second run leaves the first run's sheets behind and
    // they read as part of the same sweep.
    const made: string[] = [];
    const { shell, files } = harness();

    await contactSheets({
      videoPath: 'take.mp4',
      outputDir: '/out',
      shell,
      files: { ...files, make: (directory: string) => made.push(directory) },
    });

    // Ordering, not position: the output directory must exist before any frame
    // directory inside it, and asserting an index breaks on any earlier make.
    expect(made).toContain('/out');
    expect(made.indexOf('/out')).toBeLessThan(
      made.findIndex(directory => directory.startsWith('/out/frames-')),
    );
  });

  it('keeps one sweep out of another, since neither is deleted', async () => {
    // Nothing here removes anything, so a second sweep at a different rate over
    // the same range would extract into a directory still holding the first
    // sweep's frames, and the tiler globs whatever it finds.
    const made: string[] = [];
    const { shell, files } = harness({ durationSeconds: 12 });

    await contactSheets({
      videoPath: 'take.mp4',
      outputDir: '/out',
      sweepId: 'second',
      shell,
      files: { ...files, make: (directory: string) => made.push(directory) },
    });

    expect(made).toContain('/out/frames-second-0.0');
    expect(made).toContain('/out/frames-second-6.0');
  });

  it('names each sheet after the sweep that produced it', async () => {
    // Same reason. Two sweeps writing sheet-0.0s.png would have the second
    // silently overwrite the first.
    const { shell, files } = harness();
    const [sheet] = await contactSheets({
      videoPath: 'take.mp4',
      outputDir: '/out',
      sweepId: 'first',
      shell,
      files,
    });

    expect(sheet.path).toBe('/out/sheet-first-0.0s.png');
  });
});
