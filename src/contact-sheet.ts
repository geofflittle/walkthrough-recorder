import { mkdirSync, readdirSync } from 'node:fs';

import { realShell } from './shell';

import type { Shell } from './shell';

export type Sheet = { path: string; fromSeconds: number; toSeconds: number };

/**
 * The scratch directory this works in, as a value.
 *
 * Injected for the same reason the shell is: the interesting logic here is how
 * a range is cut into slices and what each frame is labelled, and neither of
 * those needs a disk.
 *
 * Creates only. Nothing here deletes anything, including the frames it
 * extracts: what to keep is the reader's call, not this library's.
 */
export type SheetFiles = {
  make: (directory: string) => void;
  /** The extracted frames, in the order ffmpeg numbered them. */
  list: (directory: string) => string[];
};

const defaultFiles: SheetFiles = {
  make: directory => mkdirSync(directory, { recursive: true }),
  list: directory =>
    readdirSync(directory)
      .filter(name => name.endsWith('.png'))
      .sort(),
};

/**
 * Tiles a stretch of a take into labelled contact sheets.
 *
 * Built because sampling a handful of frames at guessed timestamps kept missing
 * what a viewer saw at once: a control decorated twice, a pointer arriving
 * before its screen, a label bleeding onto the screen after. Playwright's
 * annotations last a few hundred milliseconds, so a sample every second or two
 * falls between them and reports nothing wrong.
 *
 * Deliberately many small frames rather than a few large ones. A fault in a
 * walkthrough is nearly always in the RELATIONSHIP between neighbouring frames,
 * this appeared and then that moved, which a sheet shows and a single frame
 * cannot.
 *
 * Extracted with ffmpeg and tiled with ImageMagick, because this ffmpeg was
 * built without drawtext and an unlabelled tile is only half a reading: it
 * shows what happened but not when, which is the half needed to line a frame up
 * against the transcript.
 */
export const contactSheets = async ({
  videoPath,
  outputDir,
  fromSeconds = 0,
  toSeconds,
  fps = 4,
  columns = 6,
  rows = 4,
  tileWidth = 200,
  shell = realShell,
  files = defaultFiles,
  sweepId = String(process.pid),
}: {
  videoPath: string;
  outputDir: string;
  fromSeconds?: number;
  /** Defaults to the end of the video. */
  toSeconds?: number;
  /** Frames per second sampled. 4 is dense enough to catch a 300ms label. */
  fps?: number;
  columns?: number;
  rows?: number;
  tileWidth?: number;
  /** Injected so the slicing can be exercised without a video or ffmpeg. */
  shell?: Shell;
  files?: SheetFiles;
  /**
   * Distinguishes this sweep's frames from an earlier one's.
   *
   * Needed because nothing is deleted: a second sweep at a different rate over
   * the same range would otherwise extract into a directory still holding the
   * first sweep's PNGs, and the tiler globs whatever it finds. Defaults to the
   * process id, which separates runs without a clock or a cleanup.
   */
  sweepId?: string;
}): Promise<Sheet[]> => {
  files.make(outputDir);

  const { stdout } = await shell('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    videoPath,
  ]);
  const end = toSeconds ?? Number(stdout.trim());
  const perSheet = (columns * rows) / fps;

  const sheets: Sheet[] = [];
  // Stops a frame short of the end rather than at it. Accumulating perSheet
  // lands just under a range that divides evenly (27.4 plus 4.8 is
  // 32.199999999999996), so the guard admits one more pass whose slice is
  // narrower than a single frame, and ffmpeg refuses a -to equal to its -ss.
  for (let at = fromSeconds; at < end - 1 / fps; at += perSheet) {
    const stop = Math.min(at + perSheet, end);
    const frames = `${outputDir}/frames-${sweepId}-${at.toFixed(1)}`;
    files.make(frames);
    await shell('ffmpeg', [
      '-loglevel',
      'error',
      // Seeking AFTER -i, so the times are exact rather than snapped to the
      // nearest keyframe. A sheet whose labels are approximate is worse than
      // none, since it would be read against the transcript.
      '-i',
      videoPath,
      '-ss',
      at.toFixed(3),
      '-to',
      stop.toFixed(3),
      '-vf',
      `fps=${fps},scale=${tileWidth}:-1`,
      `${frames}/%03d.png`,
    ]);

    const shots = files.list(frames);
    const path = `${outputDir}/sheet-${sweepId}-${at.toFixed(1)}s.png`;
    await shell('montage', [
      ...shots.flatMap((name, index) => [
        '-label',
        `${(at + index / fps).toFixed(2)}s`,
        `${frames}/${name}`,
      ]),
      '-tile',
      `${columns}x${rows}`,
      '-geometry',
      '+3+3',
      '-background',
      '#555555',
      '-fill',
      'white',
      // Named explicitly: ImageMagick here has no default font configured and
      // fails with "unable to read font" rather than falling back to one.
      '-font',
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '-pointsize',
      '13',
      path,
    ]);
    // Rounded to milliseconds, because `at` accumulates: over a long sweep the
    // boundary a caller prints drifts into 32.199999999999996, which reads as a
    // measurement rather than the arithmetic it is.
    sheets.push({
      path,
      fromSeconds: Number(at.toFixed(3)),
      toSeconds: Number(stop.toFixed(3)),
    });
  }
  return sheets;
};
