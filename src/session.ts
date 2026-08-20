import { PRESS_HOLD_MS } from './actor';
import { recordWalkthrough } from './drive';
import { staleProfiles } from './profiles';
import { finishTake } from './take';
import { runSession } from './run';

import type { RecordOptions } from './drive';
import type { ProfileStore } from './profiles';
import type {
  RecordedTake,
  SessionIntent,
  SessionOutcome,
  SessionSteps,
} from './run';
import type { Shell } from './shell';

/**
 * Drive an app through its script and grade the result, in one call.
 *
 * This exists because the two halves were always used together and wiring them
 * up was twelve lines of pure re-plumbing: everything `finishTake` needs is
 * either something `recordWalkthrough` just returned or something the caller
 * already handed in. Every consumer would write that block, every one could get
 * a field wrong silently, and the one consumer that existed wrote it TWICE,
 * once for a replayed run and once for a live one, which is exactly how the two
 * drifted apart.
 *
 * Both halves stay exported. Recording without grading is reasonable, and so is
 * grading a take that was recorded elsewhere.
 */
export type TakeOptions<Ref extends string> = RecordOptions<Ref> & {
  /**
   * Where the finished mp4 goes. The transcript sits beside it.
   *
   * OPTIONAL, and its absence is how an app says it wants no recording. Both
   * this and `recordVideoDir` have to be present for a take to be graded, so
   * supplying one and omitting the other produces a run with no grade, which
   * the report then fails rather than passing silently.
   */
  videoPath?: string;
  /** How long a previous run's browser profile is kept. */
  keepProfileHours?: number;
  log?: (message: string) => void;
  reportError?: (message: string) => void;
  shell?: Shell;
  profileStore?: ProfileStore;
};

export const recordTake = async <Ref extends string>({
  videoPath,
  keepProfileHours,
  log = message => {
    console.log(message);
  },
  reportError = message => {
    console.error(message);
  },
  shell,
  profileStore,
  ...driving
}: TakeOptions<Ref>): Promise<RecordedTake> => {
  // Reported first, and never fatal. Each run leaves a profile of around 80MB,
  // and a disk filled by them surfaces as playwright write failures that look
  // like anything but this. Named rather than deleted: what is worth keeping is
  // the reader's call.
  const stale = staleProfiles(driving.profileDir, {
    keepHours: keepProfileHours,
    store: profileStore,
  });
  if (stale.length > 0)
    log(
      `  ${
        stale.length
      } old profile(s) left from earlier runs, remove with:\n    rm -rf ${stale.join(
        ' ',
      )}`,
    );

  // Named after the finished file, because a caller who says where the mp4
  // goes has already said what this take is called. Both consumers were
  // passing runName for exactly this and nothing else, which made it a fact
  // stated twice rather than a decision anyone wanted to make.
  const driven = await recordWalkthrough({
    runName: videoPath?.replace(/^.*\//, '').replace(/\.mp4$/, ''),
    ...driving,
  });

  // Nothing to grade without a recording. A headless run is a
  // legitimate use of the driver, so this returns rather than complaining, and
  // it returns NO grade. The absence is the whole signal: an empty check list
  // would be indistinguishable from a take that passed everything.
  if (!videoPath || !driving.recordVideoDir) return driven;

  const finished = await finishTake({
    // Narrowed by the two guards above: both videoPath and the recording exist.
    recordingPath: driven.videoPath as string,
    videoPath,
    timelineText: driven.timelineText,
    intent: {
      width: driving.app.viewport.width,
      height: driving.app.viewport.height,
      finishHoldMs: driving.finishHoldMs,
      successState: driven.successState,
      // The app's own, and only the app's. This carried a second default that
      // could disagree with the driver's terminal wait.
      plausibleSeconds: driving.app.plausibleSeconds,
    },
    timing: {
      // The package's own constant, not a caller's decision: it is how long
      // the driver holds a press, so nothing else could be the right threshold
      // for "was the press visible before the screen changed".
      minPressVisibleMs: PRESS_HOLD_MS,
      arrivesUnprompted: driving.app.arrivesUnprompted,
    },
    events: driven.timeline,
    interactions: driven.interactions,
    screens: driven.screens,
    presses: driven.presses,
    script: driving.script,
    lastEventMs: driven.timeline.at(-1)?.at ?? 0,
    terminalState: driven.terminalState,
    log,
    reportError,
    shell,
  });

  // The mp4 wins over the webm the driver wrote: the finished file is the one
  // anyone opens, and it is the one that was graded.
  const { failedChecks, ...paths } = finished;
  return { ...driven, ...paths, grade: { failedChecks } };
};

/**
 * Record a take and run a session around it, in one call.
 *
 * The seam this closes: `runSession` needs a `record` step, and the only
 * sensible one is `recordTake` with the same options. Every consumer therefore
 * wrote that wiring itself, and the other consumer wrote it twice, once for its live run and
 * once for its replay loop, which is how the two drifted apart before.
 *
 * It also stops one piece of library knowledge leaking outward. The recorder
 * has to be started on the readiness hook rather than before launch, or the
 * take opens on a blank browser. That is this file's business, not an app's.
 */
export const runWalkthrough = async <Setup, Ref extends string>({
  steps = {},
  intent = { keepWorkspace: false },
  ...taking
}: TakeOptions<Ref> & {
  steps?: Omit<SessionSteps<Setup>, 'record'> & {
    /** Supply one only to record by some other means than `recordTake`. */
    record?: SessionSteps<Setup>['record'];
  };
  intent?: SessionIntent;
}): Promise<SessionOutcome> =>
  runSession<Setup>(
    {
      ...steps,
      record:
        steps.record ??
        (async (recorder, onLearned) =>
          recordTake({
            ...taking,
            onLearned,
            onAppVisible: async () => {
              await taking.onAppVisible?.();
              await recorder.start();
            },
          })),
    },
    intent,
  );
