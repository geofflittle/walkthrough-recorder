#!/usr/bin/env node
import { contactSheets } from '../contact-sheet';

/**
 * Reads a take back the way a viewer watches it, but all at once.
 *
 * `walkthrough-sheets <video.mp4> [fromSeconds] [toSeconds] [fps]`
 *
 * Defaults sweep the whole video at 4fps, dense enough that no annotation
 * falls between two samples. Narrow the range and raise the rate to inspect a
 * single press: `walkthrough-sheets take.mp4 16 18 20`.
 *
 * Sheets land beside the video, in a `sheets` directory, so they are discarded
 * with whatever holds the take.
 */
const main = async () => {
  const [videoPath, from, to, fps] = process.argv.slice(2);
  if (!videoPath) {
    console.error(
      'usage: walkthrough-sheets <video.mp4> [fromSeconds] [toSeconds] [fps]',
    );
    process.exitCode = 1;
    return;
  }

  const sheets = await contactSheets({
    videoPath,
    outputDir: `${videoPath.replace(/\/[^/]+$/, '')}/sheets`,
    fromSeconds: from ? Number(from) : 0,
    toSeconds: to ? Number(to) : undefined,
    fps: fps ? Number(fps) : 4,
  });
  for (const sheet of sheets)
    console.log(
      `${sheet.path}  ${sheet.fromSeconds.toFixed(
        1,
      )}s to ${sheet.toSeconds.toFixed(1)}s`,
    );
};

void main();
