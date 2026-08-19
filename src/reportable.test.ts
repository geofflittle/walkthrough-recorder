import { describe, expect, it } from 'vitest';

import { finishRun, reportRun } from './reportable';

/**
 * Both consumers hand-rolled this and the two disagreed: the shop exited 0 when
 * failedChecks was empty but teardown returned nothing, where the other consumer exited 1 off
 * `ok`. That is the bug its own reporter documents as fixed, reintroduced in
 * the example a stranger copies.
 */
const RUN = {
  ok: false,
  failedChecks: [] as string[],
  // Graded by default, so a test about anything else is not silently also a
  // test about an ungraded take.
  grade: { failedChecks: [] as string[] },
  videoPath: '/takes/demo.webm',
};

describe('reportRun', () => {
  it('exits non-zero for a run that is not ok, whatever its check list says', () => {
    // The disagreement, settled. A run that worked correctly but never returned
    // the work is not ok while its check list is empty.
    expect(reportRun(RUN).exitCode).toBe(1);
  });

  it('exits zero for a run that is ok', () => {
    expect(reportRun({ ...RUN, ok: true }).exitCode).toBe(0);
  });

  it('refuses to pass a run that graded nothing', () => {
    // An empty failedChecks is true of a take that passed everything AND of one
    // nothing looked at.
    const report = reportRun({ ...RUN, ok: true, grade: undefined });

    expect(report.exitCode).toBe(1);
    expect(report.err.join('\n')).toContain('nothing graded the take');
  });

  it('reports every failed check, and the count as a detail', () => {
    const { err } = reportRun({ ...RUN, failedChecks: ['one', 'two'] });

    expect(err.join('\n')).toContain('one, two');
    expect(err.join('\n')).toContain('2 check(s) failed');
  });

  it('names the finished file on a recorded run', () => {
    const { out } = reportRun(
      { ...RUN, ok: true },
      { videoPath: '/takes/demo.mp4' },
    );

    expect(out).toContain('video: /takes/demo.mp4');
  });

  it('fails the command when a recording was asked for and never produced', () => {
    // Both halves in one test on purpose. The message existed before and the
    // exit code ignored it, so asserting the line alone is what let a run with
    // no video pass.
    const report = reportRun({
      ...RUN,
      ok: true,
      grade: undefined,
      videoPath: undefined,
    });

    expect(report.err.join('\n')).toContain('nothing graded the take');
    expect(report.exitCode).toBe(1);
  });

  it('says nothing was recorded when nothing was asked for', () => {
    const { out, err } = reportRun(
      { ...RUN, ok: true, videoPath: undefined },
      { shouldRecord: false },
    );

    expect(out).toContain('no video (RECORD=0)');
    expect(err).not.toContain('no recording was produced');
  });

  it('leads with the settlement line only the app can write', () => {
    // The app knows where its work and its workspace went. The library does
    // not, which is the whole reason this is a parameter rather than a field.
    const { out } = reportRun(
      { ...RUN, ok: true },
      { settlement: '  refunded (abc123), profile removed' },
    );

    expect(out[0]).toBe('  refunded (abc123), profile removed');
  });

  it('does not fail a run that never asked to be recorded', async () => {
    // RECORD=0 is a documented mode, and the first attempt at a grade broke it:
    // the exit rule punished every run that came back without one, including
    // the runs that never asked.
    const report = reportRun(
      { ...RUN, ok: true, grade: undefined, videoPath: undefined },
      { shouldRecord: false },
    );

    expect(report.exitCode).toBe(0);
    expect(report.err.join('\n')).not.toContain('nothing graded');
  });

  it('still fails a run that WAS asked to record and graded nothing', () => {
    // The other side, so the fix cannot be a blanket exemption.
    expect(
      reportRun({ ...RUN, ok: true, grade: undefined }, { shouldRecord: true })
        .exitCode,
    ).toBe(1);
  });
});

describe('finishRun', () => {
  const said = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      say: {
        log: (l: string) => out.push(l),
        error: (l: string) => err.push(l),
      },
      out,
      err,
    };
  };

  it('prints the failures, which a caller doing this by hand forgot', () => {
    // The defect this exists for: one call site printed `out` and never `err`,
    // so a failed replay take said nothing about why.
    const { say, err } = said();

    finishRun({ ...RUN, failedChecks: ['frame is 620x760'] }, {}, say);

    expect(err.join('\n')).toContain('frame is 620x760');
  });

  it('prints what the run has to say', () => {
    const { say, out } = said();

    finishRun({ ...RUN, ok: true }, { settlement: '  all done' }, say);

    expect(out).toContain('  all done');
  });

  it('returns the same report reportRun would', () => {
    const { say } = said();

    expect(finishRun({ ...RUN, ok: true }, {}, say)).toEqual(
      reportRun({ ...RUN, ok: true }),
    );
  });
});
