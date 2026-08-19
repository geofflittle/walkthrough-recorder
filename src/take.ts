import { writeFileSync } from 'node:fs';

import { assessTake, failedChecks } from './assess';
import { appendTake, realHost, takeRecord } from './record';
import {
  allowedPresses,
  assessPresses,
  assessSequence,
  expectedFrom,
} from './sequence';
import { realShell } from './shell';
import { assessTiming } from './timing';

import type { TakeIntent } from './assess';
import type { Press } from './press-mark';
import type { HostFacts } from './record';
import type { ScreenChange } from './screen-log';
import type { Step } from './script';
import type { Shell } from './shell';
import type { TimelineEvent } from './timeline';
import type { Interaction, TimingIntent } from './timing';

/** Chromium's backdrop grey, and how close a row has to be to count as it. */
const BACKDROP_GREY = 130;
const GREY_TOLERANCE = 4;

export type VideoFacts = {
  width: number;
  height: number;
  durationSeconds: number;
};

/**
 * What ffprobe said, as three numbers.
 *
 * Separate from the call so it can be exercised without a video. It is more
 * than a cast: a probe that fails prints nothing on stdout, and the numbers
 * would then come back as NaN and flow into the frame-size check, which
 * compares them and reports a mismatch rather than a broken measurement.
 */
export const parseProbe = (stdout: string): VideoFacts => {
  const [width, height, durationSeconds] = stdout
    .trim()
    .split('\n')
    .map(Number);
  if (![width, height, durationSeconds].every(Number.isFinite))
    throw new Error(`could not read width, height and duration from ${stdout}`);
  return { width, height, durationSeconds };
};

/**
 * How many rows at the BOTTOM are flat backdrop grey.
 *
 * The band is the space the compositor never painted, so it is uniform by
 * nature and one averaged value per row is enough to find it.
 *
 * Loud when the scan is short, rather than counting what it has. Returning a
 * number from a truncated read would report a clean frame whenever the
 * measurement itself failed, which is how a spike once "proved" there was no
 * padding when the scan had simply produced too few rows to see it.
 */
export const bandHeight = (rows: number[], height: number): number => {
  if (rows.length < height)
    throw new Error(
      `backdrop scan read ${rows.length} rows of an expected ${height}`,
    );
  let band = 0;
  for (let row = height - 1; row >= 0; row -= 1) {
    if (Math.abs(rows[row] - BACKDROP_GREY) > GREY_TOLERANCE) break;
    band += 1;
  }
  return band;
};

/** Dimensions and length of a finished file, straight from the file. */
const measureVideo = async (shell: Shell, videoPath: string) => {
  const { stdout } = await shell('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    videoPath,
  ]);
  return parseProbe(stdout);
};

/** Rows of flat backdrop grey, sampled mid-take where the page is settled. */
const measureBackdropRows = async (
  shell: Shell,
  videoPath: string,
  { height, durationSeconds }: { height: number; durationSeconds: number },
): Promise<number> => {
  const { stdout } = await shell(
    'sh',
    [
      '-c',
      `ffmpeg -loglevel error -i ${JSON.stringify(videoPath)} -ss ${(
        durationSeconds / 2
      ).toFixed(
        2,
      )} -frames:v 1 -vf "scale=1:${height}:flags=area" -f rawvideo -pix_fmt gray - | od -An -tu1 -v`,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return bandHeight(
    stdout.trim().split(/\s+/).filter(Boolean).map(Number),
    height,
  );
};

/**
 * Turns a recording into the two things anyone wants: a watchable video and a
 * transcript whose timestamps match it.
 *
 * Almost nothing happens here any more, and that is the point. This file used
 * to render the take from a trace, cut a grey band the renderer added, locate a
 * sync flash, decide whether a speed table could be trusted, map the timeline
 * through it, then trim the startup off the front and shift every timestamp to
 * match. All of that existed to reconcile two clocks: playwright's recording
 * began when the browser context did, while the renderer's speed segments were
 * expressed in trace time.
 *
 * page.screencast removed the need for every one of those steps. The recording
 * starts on the line where the walkthrough starts, the pointer and annotations
 * are painted into it as the actions happen, and the timeline is zeroed at the
 * same moment. So a transcript timestamp IS a video timestamp, with no mapping
 * left to get wrong, and the only work here is a container change.
 */
export const finishTake = async ({
  recordingPath,
  videoPath,
  timelineText,
  intent,
  timing,
  interactions,
  screens,
  presses,
  script,
  events,
  lastEventMs,
  terminalState,
  log,
  reportError,
  shell = realShell,
  writeText = (path, text) => {
    writeFileSync(path, text);
  },
  appendLine,
  host = realHost,
  now = Date.now,
}: {
  /** The webm playwright wrote. */
  recordingPath: string;
  /** Where the mp4 goes. The transcript sits beside it. */
  videoPath: string;
  timelineText?: (toVideoMs?: (atMs: number) => number) => string;
  /** What the take was asked to be, so the result can be graded against it. */
  intent: TakeIntent;
  timing: TimingIntent;
  interactions: Interaction[];
  screens: ScreenChange[];
  /** Presses as the page saw them, which is what the timing checks trust. */
  presses: Press[];
  /**
   * The script the run was asked to perform.
   *
   * Passed in rather than imported, because the sequence checks grade the
   * transcript against it. They used to default to one app's script, so a take
   * of anything else was compared to that one script and reported as diverging
   * on step one.
   */
  script: Step<string>[];
  /**
   * Everything the run did, in order, with the duration of anything that took
   * time. The checks read only the kind and target, but the history needs the
   * durations, and splitting that into two arguments would be two
   * representations of one transcript, free to disagree.
   */
  events: TimelineEvent[];
  /** The last thing that happened, and where the app ended, for grading. */
  lastEventMs: number;
  terminalState: string;
  log: (message: string) => void;
  reportError: (message: string) => void;
  /** Injected so the grading can be exercised without a video on disk. */
  shell?: Shell;
  writeText?: (path: string, text: string) => void;
  appendLine?: (path: string, line: string) => void;
  host?: () => HostFacts;
  now?: () => number;
}): Promise<{
  videoPath: string;
  timelinePath?: string;
  failedChecks: string[];
}> => {
  // mp4 rather than the webm as recorded, because that is what plays everywhere
  // without a second thought. faststart so it can be scrubbed before it has
  // fully downloaded.
  await shell('ffmpeg', [
    '-loglevel',
    'error',
    '-i',
    recordingPath,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-y',
    videoPath,
  ]);
  log(`video: ${videoPath}`);

  const timelinePath = timelineText
    ? videoPath.replace(/\.mp4$/, '.timeline.txt')
    : undefined;
  if (timelineText && timelinePath) {
    // No mapping argument, deliberately. The timeline was zeroed when the
    // recording started, so its own clock is already the video's.
    writeText(timelinePath, `${timelineText()}\n`);
    log(`timeline: ${timelinePath}`);
  }

  // Graded against what it was asked to be, every time, because until this
  // existed a take was only ever judged by watching it, which meant a
  // regression cost a viewing and changes traded one defect for another.
  const measured = await measureVideo(shell, videoPath);
  const checks = [
    ...assessTake(
      {
        ...measured,
        lastEventMs,
        terminalState,
        backdropRows: await measureBackdropRows(shell, videoPath, measured),
      },
      intent,
    ),
    ...assessTiming(interactions, screens, timing, presses),
    ...assessSequence(events, expectedFrom(script)),
    // The page's own press log, not the timeline. The timeline records one
    // press per script step, so grading it against the script compared the
    // script to itself and the check could never fail. A mark is drawn per real
    // pointerdown, so only this input can show a control drawn twice.
    ...assessPresses(
      presses.map(press => ({ kind: 'click' as const, target: press.testId })),
      allowedPresses(script),
    ),
  ];
  const scriptedPresses = [...allowedPresses(script).values()].reduce(
    (total, count) => total + count,
    0,
  );
  checks.push(
    {
      // The single most likely instrumentation failure, and the one that used
      // to be reported as a log line while four timing checks passed vacuously
      // and the command exited zero. The observer source once threw on every
      // document, so nothing was logged while the binding sat there healthy.
      label: 'the page reported its screen changes',
      didPass: screens.length > 0,
    },
    {
      label: 'the page reported the presses the script asked for',
      didPass: scriptedPresses === 0 || presses.length > 0,
    },
  );

  if (screens.length === 0)
    reportError(
      '  no screen changes were recorded, so click timing went unchecked',
    );
  for (const check of checks) {
    (check.didPass ? log : reportError)(
      `  ${check.didPass ? 'PASS' : 'FAIL'} take ${check.label}`,
    );
  }
  const failed = failedChecks(checks);

  // Appended, not written: comparing one take against an earlier one is the
  // only way to tell a slow machine from a slower app, and the transcript
  // beside the video is always the current take.
  const historyPath = videoPath.replace(/\.mp4$/, '.takes.jsonl');
  const record = takeRecord({
    events,
    video: measured,
    terminalState,
    failedChecks: failed,
    host: host(),
    runAtEpochMs: now(),
  });
  appendTake(historyPath, record, appendLine);
  log(
    `  host load ${record.host.load[0].toFixed(1)} across ${
      record.host.cpus
    } cpus, history: ${historyPath}`,
  );

  return { videoPath, timelinePath, failedChecks: failed };
};
