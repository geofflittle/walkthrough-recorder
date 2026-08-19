/**
 * What a finished run should say, and what it should exit with.
 *
 * In the library because both consumers wrote their own and the two disagreed:
 * one exited 0 when its check list was empty but teardown returned nothing,
 * where the other exited 1 off `ok`. For a library whose whole promise is that
 * a bad take fails the command, how a run turns into an exit code is the
 * library's job, not something every app rediscovers.
 *
 * Failure is read in ONE place, from `ok`. The check count is a detail added to
 * the message, never a second way of deciding, because a run can fail for
 * reasons that never reach a check list.
 */
export type FinishedRun = {
  ok: boolean;
  failedChecks: string[];
  /**
   * The take's own verdict, ABSENT when nothing graded the take.
   *
   * Presence is the proof, which is why this is an object and not a flag. Two
   * booleans stood here, `graded` and `wanted`, and a caller could set either
   * to anything: they were claims about work rather than the work's result. The
   * pair went wrong in both directions, first punishing every run that never
   * asked for a video, then agreeing with each other so exactly that the rule
   * comparing them could not fire at all.
   */
  grade?: { failedChecks: string[] };
  videoPath?: string;
};

export type RunReport = {
  out: string[];
  err: string[];
  exitCode: number;
};

/**
 * A finished run from a take alone, for an app that checks nothing else.
 *
 * Here rather than at each call site because the arithmetic is the same every
 * time and the example wrote its own, which is how a hand-rolled `ok` came to
 * ignore whether anything had been graded at all.
 */
export const runFromTake = (take: {
  grade?: { failedChecks: string[] };
  videoPath?: string;
}): FinishedRun => ({
  ok: (take.grade?.failedChecks.length ?? 0) === 0,
  failedChecks: take.grade?.failedChecks ?? [],
  grade: take.grade,
  videoPath: take.videoPath,
});

export const reportRun = (
  run: FinishedRun,
  {
    /** A line only the app can write, about what it left behind. */
    settlement,
    videoPath,
    shouldRecord = true,
  }: {
    settlement?: string;
    videoPath?: string;
    shouldRecord?: boolean;
  } = {},
): RunReport => {
  const out = settlement ? [settlement] : [];
  const err: string[] = [];

  if (run.failedChecks.length > 0)
    err.push(`  failed: ${run.failedChecks.join(', ')}`);

  // A take nothing looked at is not a passing take. An empty check list is true
  // of a run that passed everything AND of one that graded nothing, so the
  // question is answered by whether a grade came back at all, never by an empty
  // list. A run that never asked for a recording has nothing to grade and is
  // not failing by having nothing to report.
  const ungraded = shouldRecord && !run.grade;

  if (!shouldRecord) out.push('no video (RECORD=0)');
  else if (run.videoPath) out.push(`video: ${videoPath ?? run.videoPath}`);

  // Its own line, never an else. A missing video and an ungraded take are the
  // same failure from the caller's side, and the message that named only the
  // missing file was the one the exit code forgot to read.
  if (ungraded)
    err.push('  nothing graded the take, so nothing about it was checked');

  if (!run.ok && run.failedChecks.length > 0)
    err.push(`${run.failedChecks.length} check(s) failed`);

  return {
    out,
    err,
    // Read from `ok` and from whether a grade exists, and from nothing else.
    // Every past inversion here came from a rule with three terms.
    exitCode: run.ok && !ungraded ? 0 : 1,
  };
};

/**
 * Say what a finished run says, and set the exit code.
 *
 * The whole tail, not just the decision. reportRun returned three lists and
 * every consumer then wrote the same loop, which is why the rule has drifted
 * three times: once at the recordTake level, once at runSession, and once at
 * reporting, where a replay path printed `out` and silently dropped every
 * failure in `err`. One call site cannot drift from itself.
 */
export const finishRun = (
  run: FinishedRun,
  options: Parameters<typeof reportRun>[1] = {},
  say: { log: (line: string) => void; error: (line: string) => void } = console,
): RunReport => {
  const report = reportRun(run, options);
  for (const line of report.out) say.log(line);
  for (const line of report.err) say.error(line);
  process.exitCode = report.exitCode;
  return report;
};
