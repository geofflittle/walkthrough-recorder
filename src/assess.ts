/** One thing that was checked about a finished take, and whether it held. */
export type TakeCheck = { label: string; didPass: boolean };

/** What a take has to be, measured off the finished file and its transcript. */
export type TakeFacts = {
  /** Dimensions of the mp4 that was written. */
  width: number;
  height: number;
  /** Its length in seconds. */
  durationSeconds: number;
  /** Milliseconds of the last entry in the transcript. */
  lastEventMs: number;
  /** Which screen the wizard finished on. */
  terminalState: string;
  /**
   * Rows of flat Chromium backdrop grey along the bottom, if any. Zero on a
   * take whose frame matches what the window actually paints.
   */
  backdropRows: number;
};

/** What the take was asked to be, so a check compares intent against result. */
export type TakeIntent = {
  width: number;
  height: number;
  /** The hold on the terminal screen, which the take must not end before. */
  finishHoldMs: number;
  /** Which terminal screen counts as the run having succeeded. */
  successState: string;
  /**
   * What length makes this take believable, in seconds.
   *
   * The caller's, because a long walkthrough and a two-screen checkout have
   * nothing in common here. This was hardcoded at 20 to 600 and failed the
   * eight-second example that ships with the library, which is a floor tuned
   * for one app sitting in the generic grader.
   */
  plausibleSeconds: { least: number; most: number };
};

/**
 * Grades a finished take against the things that have actually gone wrong.
 *
 * Every check here corresponds to a defect that shipped at least once and was
 * caught by eye rather than by code, which is the whole reason this exists. A
 * take used to be judged by watching it, so a regression cost a viewing, and
 * changes traded one defect for another without anything noticing.
 *
 * Pure on purpose: the facts are measured elsewhere with ffprobe and ffmpeg, so
 * the judgement can be tested without producing a video.
 */
export const assessTake = (
  facts: TakeFacts,
  intent: TakeIntent,
): TakeCheck[] => [
  {
    // Shipped wrong twice: once scaled to a landscape preset which cropped the
    // sides off a portrait take, once at the viewport's size rather than the
    // window's, which is what the backdrop check below covers.
    label: `frame is ${intent.width}x${intent.height}`,
    didPass: facts.width === intent.width && facts.height === intent.height,
  },
  {
    // The grey band. Allowed a couple of rows because encoders round.
    label: 'no backdrop band along the bottom',
    didPass: facts.backdropRows <= 2,
  },
  {
    // Named by the caller, both the state and the wording. It read
    // "wizard reached its done screen" against a hardcoded 'done', which is one
    // app's success state and one app's vocabulary sitting in the generic
    // grader. A run that ends somewhere else is not a failure of this file.
    label: `reached its ${intent.successState} screen`,
    didPass: facts.terminalState === intent.successState,
  },
  {
    // The take ended a second after the last click once, so the screen the
    // whole walkthrough builds to was never readable. The hold is deliberate,
    // so the file must outlast the last thing that happens in it.
    label: 'holds on the final screen after the last action',
    // Allowance is the larger of a fifth of the hold and half a second, capped
    // at four fifths so a real tail is always required. Uncapped, a hold of 500
    // or less demanded a tail of zero and the check went fully vacuous.
    //
    // The fifth-or-half-second floor exists because
    // what the encoder loses off the tail is roughly absolute rather than
    // proportional. A flat fifth gave a 7000ms hold 1400ms of slack and an
    // 800ms hold only 160ms, so the short one failed on a two-cpu CI runner
    // while the take itself was fine.
    didPass:
      facts.durationSeconds * 1000 - facts.lastEventMs >=
      intent.finishHoldMs -
        Math.min(
          Math.max(intent.finishHoldMs * 0.2, 500),
          intent.finishHoldMs * 0.8,
        ),
  },
  {
    // A transcript that runs past the end of its own video is describing a file
    // that does not exist. That happened whenever the two clocks disagreed.
    label: 'transcript ends within the video',
    didPass: facts.lastEventMs <= facts.durationSeconds * 1000,
  },
  {
    // Guards against a take that is technically valid and useless: a few
    // seconds of nothing, or an hour because something hung.
    label: `runs for a plausible length (${intent.plausibleSeconds.least} to ${intent.plausibleSeconds.most}s)`,
    didPass:
      facts.durationSeconds > intent.plausibleSeconds.least &&
      facts.durationSeconds < intent.plausibleSeconds.most,
  },
];

/** The checks that did not hold, by label. */
export const failedChecks = (checks: TakeCheck[]): string[] =>
  checks.filter(check => !check.didPass).map(check => check.label);
