import type { TakeCheck } from './assess';
import type { DriveResult } from './drive';
import { noRecorder } from './recorder';

import type { OnLearned } from './perform';
import type { Recorder } from './recorder';

/** What a session needs back from recording, graded or not. */
export type RecordedTake = DriveResult & {
  /**
   * The take's own verdict, ABSENT when nothing graded the take.
   *
   * One field rather than a boolean beside a list, because "was it graded" and
   * "what failed" are one fact and storing them apart lets them disagree. An
   * empty list here means every check passed. No list at all means no check ran.
   */
  grade?: { failedChecks: string[] };
  /** Where the transcript was written, when one was. */
  timelinePath?: string;
};

/**
 * The work an app does around a take.
 *
 * Named for the shape rather than for any domain: something is prepared, a take
 * is recorded, the result is checked against the world outside the app, and
 * whatever was prepared is put back. Any app with real setup around a take has
 * that sequence under some other set of names.
 */
export type SessionSteps<Setup> = {
  /**
   * Prepare whatever the walkthrough needs. Its result reaches `check`.
   *
   * Optional, because a run against a recorded backend has no world to prepare.
   * Omitting it, `check` and `tearDown` together is what a replayed take is:
   * drive the app, grade the video, and claim nothing about the world.
   */
  setUp?: () => Promise<Setup>;
  /**
   * An external recorder to run around the take, for an app recorded by
   * something other than the browser.
   *
   * Optional, because the usual answer is nothing: `recordTake` records through
   * the page, so there is no separate process to start and stop. Requiring it
   * meant every caller wrote `makeRecorder: noRecorder` to say so.
   */
  makeRecorder?: () => Recorder;
  /**
   * Record the take. Usually `recordTake`, which also grades the video.
   *
   * Typed to carry a grade because the alternative is the caller wiring the
   * driver to the grader itself, which is sixteen arguments of pure re-plumbing
   * and was how one call site drifted from the other.
   *
   * `onLearned` is handed in so the step can report a captured value the
   * instant it exists. A value that waits for the take to return has to survive
   * every throw site in between, and that value may be the only copy of what the run
   * has already produced.
   */
  record: (recorder: Recorder, onLearned: OnLearned) => Promise<RecordedTake>;
  /**
   * Check the outcome against the world OUTSIDE the app.
   *
   * Separate from the take checks, which grade the video. This is for the
   * question the recording cannot answer: did the thing the app claimed to do
   * actually happen.
   */
  check?: (input: {
    setup: Setup;
    learned: Record<string, string | undefined>;
  }) => Promise<TakeCheck[]>;
  /**
   * Put back what setUp prepared, returning a receipt when it worked.
   *
   * The receipt is load-bearing rather than informational: an empty result is
   * indistinguishable from a teardown that silently moved nothing, so the
   * workspace is kept whenever one is missing.
   */
  tearDown?: (
    learned: Record<string, string | undefined>,
  ) => Promise<string | undefined>;
  /**
   * Remove whatever the run left behind, when it is safe to.
   *
   * Optional, and the library never does this itself: it decides WHEN a
   * workspace may go, the app decides what that means and performs it. An app
   * with nothing to discard omits this and nothing is discarded.
   */
  discardWorkspace?: () => void;
  /**
   * Where a run's narration goes. Defaults to the console.
   *
   * Optional for the same reason `makeRecorder` is: the usual answer was the
   * console, and requiring it meant every caller wrote the same two wrappers.
   */
  log?: (message: string) => void;
  reportError?: (message: string) => void;
};

/** What the app wants said, and when the run counts as having succeeded. */
export type SessionIntent = {
  /**
   * The terminal screen that means the app did what it set out to do.
   *
   * Usually derived rather than stated: an app already lists its terminal
   * screens best outcome first, so the first of those IS this. Supply it only
   * to grade against something other than the app's own best outcome.
   */
  successState?: string;
  /**
   * A value the run learns that must be shouted before anything can throw.
   *
   * Optional, and the reason it exists is specific: the value may be the only copy of
   * something the run has already produced, so losing it to a later
   * exception loses it for good. An app with no such value omits this.
   */
  announce?: { ref: string; as: string };
  keepWorkspace: boolean;
};

export type SessionOutcome = Pick<
  DriveResult,
  | 'interactions'
  | 'presses'
  | 'screens'
  | 'timeline'
  | 'timelineOriginEpochMs'
  | 'timelineText'
  | 'videoPath'
> & {
  ok: boolean;
  terminalState: string;
  learned: Record<string, string | undefined>;
  /** Every check that did not hold, from the video AND from the world. */
  failedChecks: string[];
  /** Carried from the take, so nothing downstream has to infer it. */
  grade?: { failedChecks: string[] };
  timelinePath?: string;
  didDiscardWorkspace: boolean;
  teardownReceipt?: string;
};

/**
 * Set up, record, check, and put everything back.
 *
 * Ordering here is load-bearing rather than incidental, so it is stated once:
 * the announced value is printed before anything below can throw, the verdict
 * is computed before the workspace is destroyed, and the workspace survives
 * whenever teardown might not have completed.
 */
export const runSession = async <Setup>(
  steps: SessionSteps<Setup>,
  { successState: statedSuccess, announce, keepWorkspace }: SessionIntent,
): Promise<SessionOutcome> => {
  // Bound once, so every use below reads the same whether the caller supplied
  // them or not.
  const log =
    steps.log ??
    ((message: string) => {
      console.log(message);
    });
  const reportError =
    steps.reportError ??
    ((message: string) => {
      console.error(message);
    });

  // Cast, because a session with no setUp has nothing to give `check`, and a
  // caller that omits one omits the other.
  if (steps.setUp) log('=== SET UP ===');
  // Announced the instant a capture binds it, never after the take returns.
  // Everything between the capture and the end of recording can throw, and each
  // new throw site would otherwise reopen the same hole. Announcing here means
  // there is no window to defend.
  let announced = false;
  const announceNow = (ref: string, value: string) => {
    if (!announce || announced || ref !== announce.ref) return;
    announced = true;
    log(`${announce.as}=${value}`);
  };

  const setup = (await steps.setUp?.()) as Setup;

  log('=== RECORD ===');
  const recorder = steps.makeRecorder?.() ?? noRecorder();
  let stopFailure: unknown;
  const {
    learned,
    terminalState,
    successState: recordedSuccess,
    finalText,
    grade,
    ...recording
  } = await steps.record(recorder, announceNow).finally(async () => {
    // Reflected, never rethrown. A .finally whose handler rejects DISCARDS the
    // resolved value, and the value here contains the only copy of whatever the
    // run learned, which may be the only copy of what the run has
    // already produced. A recorder that cannot stop is worth reporting, never worth
    // trading the take for.
    stopFailure = await recorder.stop().then(
      () => undefined,
      (error: unknown) => error,
    );
  });

  // The app stated its terminal screens once, best outcome first, and the
  // recorder carried the first of them through. Asking the caller to repeat it
  // is how the two drift.
  const successState = statedSuccess ?? recordedSuccess ?? '';

  // First, and unconditionally. Whatever this is, a later exception must not be
  // what loses it.
  // A backstop only. The value is normally out the moment it was captured, via
  // onLearned. This covers a record step that never reports one, for instance a
  // caller supplying its own.
  if (announce && !announced)
    log(`${announce.as}=${learned[announce.ref] ?? ''}`);
  log(`ended on: ${terminalState}`);
  // A failed check, not a printed line. Reporting it and nothing else meant a
  // recorder whose own message is "recording produced no data" exited zero, so
  // a run with no usable video passed. It rides with every other failure now,
  // which is what makes it reach `ok` and the exit code.
  const takeFailures = grade?.failedChecks ?? [];
  const stopFailures = stopFailure
    ? [`the recorder failed to stop: ${stopFailure}`]
    : [];

  if (terminalState !== successState) {
    // The app already decided. Say so, rather than letting the outside checks
    // fail confusingly for something that was never attempted. The workspace is
    // kept because a failure can follow PARTIAL work, so whatever the run
    // created must stay reachable by more than a line of terminal output.
    reportError(
      `  did not reach ${successState}. Final screen: ${finalText.slice(
        0,
        400,
      )}`,
    );
    return {
      ok: false,
      terminalState,
      learned,
      // The take's own failures still count. A run that never reached its
      // success state can still have produced an unwatchable video, and losing
      // that here would report the recording as fine.
      failedChecks: [...takeFailures, ...stopFailures],
      grade,
      didDiscardWorkspace: false,
      ...recording,
    };
  }

  if (steps.check) log('=== CHECK ===');
  const checks = (await steps.check?.({ setup, learned })) ?? [];
  for (const check of checks) {
    log(`  ${check.didPass ? 'PASS' : 'FAIL'} ${check.label}`);
  }
  const failedChecks = [
    ...takeFailures,
    ...stopFailures,
    ...checks.filter(check => !check.didPass).map(check => check.label),
  ];

  if (steps.tearDown) log('=== TEAR DOWN ===');
  const teardownReceipt = await steps.tearDown?.(learned);
  // Nothing to put back is not the same as failing to put it back. A session
  // with no tearDown is complete without a receipt, and treating its absence as
  // failure would keep every replayed take's workspace and report it as broken.
  const didTearDown = !steps.tearDown || Boolean(teardownReceipt);
  if (!didTearDown) {
    reportError(
      '  TEARDOWN RETURNED NOTHING: keep whatever was announced above.',
    );
  }

  const didDiscardWorkspace =
    Boolean(steps.discardWorkspace) && didTearDown && !keepWorkspace;
  if (didDiscardWorkspace) steps.discardWorkspace?.();

  return {
    ok: failedChecks.length === 0 && didTearDown,
    terminalState,
    learned,
    failedChecks,
    grade,
    didDiscardWorkspace,
    teardownReceipt,
    ...recording,
  };
};
