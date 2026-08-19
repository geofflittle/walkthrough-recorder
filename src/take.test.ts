import { describe, expect, it } from 'vitest';

import { expectedFrom } from './sequence';
import { bandHeight, finishTake, parseProbe } from './take';

import type { Step } from './script';
import type { Shell } from './shell';

/**
 * Any script, since these tests are about grading a take rather than about one
 * app's walkthrough. Using the real one made this file depend on the wizard.
 */
const A_SCRIPT: Step<'aValue'>[] = [
  { do: 'click', target: 'a-button' },
  { do: 'awaitScreen', target: 'a-screen' },
  { do: 'type', target: 'a-field', value: 'aValue' },
  { do: 'click', target: 'a-submit' },
];

/** A probe answer for a take that is the right shape and long enough. */
const GOOD_PROBE = '620\n760\n120.5\n';

/** A frame with nothing but page in it, as raw rows for the band scan. */
const CLEAN_ROWS = Array.from({ length: 760 }, () => 20).join(' ');

const shellReturning = ({ probe = GOOD_PROBE, rows = CLEAN_ROWS } = {}): {
  shell: Shell;
  commands: string[][];
} => {
  const commands: string[][] = [];
  const shell: Shell = async (command, args) => {
    commands.push([command, ...args]);
    if (command === 'ffprobe') return { stdout: probe };
    if (command === 'sh') return { stdout: rows };
    return { stdout: '' };
  };
  return { shell, commands };
};

const runTake = async (
  overrides: Partial<Parameters<typeof finishTake>[0]> = {},
) => {
  const logged: string[] = [];
  const errored: string[] = [];
  const { shell, commands } = shellReturning();
  const result = await finishTake({
    recordingPath: '/tmp/take.webm',
    videoPath: '/tmp/take.mp4',
    intent: {
      width: 620,
      height: 760,
      finishHoldMs: 4500,
      successState: 'done',
      plausibleSeconds: { least: 20, most: 600 },
    },
    timing: {
      arrivesUnprompted: ['first-screen'],
      minPressVisibleMs: 140,
    },
    // Real instrumentation, matching A_SCRIPT. These were all empty, which meant
    // the happy-path fixture ran four timing checks vacuously and the test that
    // says it "reports every check it ran" proved almost nothing.
    interactions: [
      { target: 'a-button', readyAtMs: 1000, clickedAtMs: 1500 },
      { target: 'a-submit', readyAtMs: 4000, clickedAtMs: 4500 },
    ],
    screens: [
      { testId: 'first-screen', atEpochMs: 500 },
      { testId: 'a-screen', atEpochMs: 2000 },
      { testId: 'done-screen', atEpochMs: 5000 },
    ],
    presses: [
      { testId: 'a-button', atEpochMs: 1500, x: 10, y: 10 },
      { testId: 'a-submit', atEpochMs: 4500, x: 10, y: 20 },
    ],
    script: A_SCRIPT,
    // The transcript of a run that did exactly what the script said, so the
    // happy path is genuinely green rather than green apart from one. Stamped
    // with times because a transcript has them, and the history reads them.
    events: expectedFrom(A_SCRIPT).map((event, index) => ({
      ...event,
      at: index * 1000,
      durationMs: 200,
    })),
    lastEventMs: 100_000,
    terminalState: 'done',
    log: message => logged.push(message),
    reportError: message => errored.push(message),
    shell,
    writeText: () => undefined,
    ...overrides,
  });
  return { result, logged, errored, commands };
};

describe('parseProbe', () => {
  it('reads width, height and duration', () => {
    expect(parseProbe(GOOD_PROBE)).toEqual({
      width: 620,
      height: 760,
      durationSeconds: 120.5,
    });
  });

  it('refuses a probe that printed nothing', () => {
    // A failed probe writes its complaint to stderr and leaves stdout empty.
    // Without this the three numbers arrive as NaN and reach the frame-size
    // check, which compares them and reports a MISMATCH, so a measurement that
    // never happened is indistinguishable from a take of the wrong shape.
    expect(() => parseProbe('')).toThrow(/could not read/);
  });

  it('refuses a probe that printed too few numbers', () => {
    expect(() => parseProbe('620\n760\n')).toThrow(/could not read/);
  });
});

describe('bandHeight', () => {
  it('finds no band on a frame that is page all the way down', () => {
    expect(
      bandHeight(
        Array.from({ length: 760 }, () => 20),
        760,
      ),
    ).toBe(0);
  });

  it('counts only the run at the very bottom', () => {
    // 700 rows of page, then 60 of Chromium's unpainted grey.
    const rows = [
      ...Array.from({ length: 700 }, () => 20),
      ...Array.from({ length: 60 }, () => 130),
    ];

    expect(bandHeight(rows, 760)).toBe(60);
  });

  it('allows the grey to be slightly off, since it is sampled not read', () => {
    const rows = [...Array.from({ length: 758 }, () => 20), 132, 128];

    expect(bandHeight(rows, 760)).toBe(2);
  });

  it('stops at page content, so grey higher up is not counted', () => {
    // A grey-ish row in the middle of the page is not the backdrop, and
    // counting to it would report a band far taller than the real one.
    const rows = [
      ...Array.from({ length: 400 }, () => 130),
      ...Array.from({ length: 350 }, () => 20),
      ...Array.from({ length: 10 }, () => 130),
    ];

    expect(bandHeight(rows, 760)).toBe(10);
  });

  it('refuses a scan that came back short', () => {
    // The failure this exists for: a truncated read used to be counted as
    // whatever it contained, so a measurement that had not seen the bottom of
    // the frame reported a clean one.
    expect(() => bandHeight([20, 20], 760)).toThrow(
      'backdrop scan read 2 rows of an expected 760',
    );
  });
});

describe('finishTake', () => {
  it('grades the take and reports every check it ran', async () => {
    const { logged, result } = await runTake();

    expect(result.videoPath).toBe('/tmp/take.mp4');
    expect(logged.filter(line => line.includes('take '))).not.toHaveLength(0);
    expect(result.failedChecks).toEqual([]);
  });

  it('says so out loud when there were no screen changes to check against', async () => {
    // The failure that made this necessary: four of the timing checks compare
    // presses against screen changes, and with no screen changes they have
    // nothing to disagree with, so they all passed on an empty log and the
    // suite reported a take it had not actually looked at.
    const { errored } = await runTake({ screens: [] });

    expect(errored).toContain(
      '  no screen changes were recorded, so click timing went unchecked',
    );
  });

  it('stays quiet about screen changes when there were some', async () => {
    const { errored } = await runTake({
      screens: [{ testId: 'first-screen', atEpochMs: 1000 }],
    });

    expect(errored.join('\n')).not.toContain('went unchecked');
  });

  it('reports a failing check as FAIL and returns it', async () => {
    // Graded against an intent it cannot meet: the probe says 620x760 and the
    // intent asks for a phone.
    const { errored, result } = await runTake({
      intent: {
        width: 390,
        height: 844,
        finishHoldMs: 4500,
        successState: 'done',
        plausibleSeconds: { least: 20, most: 600 },
      },
    });

    expect(errored.some(line => line.startsWith('  FAIL take'))).toBe(true);
    expect(result.failedChecks).not.toHaveLength(0);
  });

  it('writes the transcript beside the video, named after it', async () => {
    const written: [string, string][] = [];
    await runTake({
      timelineText: () => '00:00.0  click a-button',
      writeText: (path, text) => written.push([path, text]),
    });

    expect(written).toEqual([
      ['/tmp/take.timeline.txt', '00:00.0  click a-button\n'],
    ]);
  });

  it('writes no transcript when the run produced none', async () => {
    const written: string[] = [];
    const { result } = await runTake({
      writeText: path => written.push(path),
    });

    expect(written).toEqual([]);
    expect(result.timelinePath).toBeUndefined();
  });

  it('converts the recording to a scrubbable mp4', async () => {
    // faststart specifically: without it the file has to download in full
    // before it can be seeked, which is most of what makes a take awkward to
    // review.
    const { commands } = await runTake();
    const ffmpeg = commands.find(([command]) => command === 'ffmpeg');

    expect(ffmpeg).toContain('/tmp/take.webm');
    expect(ffmpeg).toContain('+faststart');
    expect(ffmpeg?.at(-1)).toBe('/tmp/take.mp4');
  });

  it('measures the finished mp4, not the recording it came from', async () => {
    // The checks describe what a viewer will open. Probing the webm would grade
    // a file nobody watches, and the two differ in exactly the ways being
    // checked once the container changes.
    const { commands } = await runTake();

    expect(commands.find(([command]) => command === 'ffprobe')?.at(-1)).toBe(
      '/tmp/take.mp4',
    );
  });

  it('fails the take when the page reported no screen changes at all', async () => {
    // RED. An empty screen log is the single most likely instrumentation
    // failure: the observer source once threw on every document, so nothing was
    // logged while the binding sat there looking healthy. All four timing
    // checks then pass, and the only signal is a reportError that never enters
    // failedChecks, so the command exits 0 on a take nothing graded.
    const { result } = await runTake({
      interactions: [
        { target: 'a-button', readyAtMs: 1000, clickedAtMs: 2000 },
      ],
      screens: [],
      presses: [{ testId: 'a-button', atEpochMs: 2000, x: 10, y: 10 }],
    });

    expect(result.failedChecks).not.toEqual([]);
  });

  it('fails a take where the page drew more presses than the script asked', async () => {
    // RED, and the reason this check exists at all. press-mark.ts draws a mark
    // per real pointerdown, so a control that fires two produces two marks for
    // one gesture, which is the defect the whole grader was built around.
    //
    // assessPresses is fed the TIMELINE, whose only production source is one
    // record per script step, so drawn can never exceed asked and the check can
    // never fail. The page's own press log, which finishTake already receives,
    // is the input that can.
    const { result } = await runTake({
      script: [{ do: 'click', target: 'a-button' }],
      interactions: [
        { target: 'a-button', readyAtMs: 1000, clickedAtMs: 2000 },
      ],
      screens: [{ testId: 'next-step', atEpochMs: 3000 }],
      presses: [
        { testId: 'a-button', atEpochMs: 2000, x: 10, y: 10 },
        { testId: 'a-button', atEpochMs: 2040, x: 10, y: 10 },
      ],
    });

    expect(result.failedChecks).toContain(
      'a control was drawn as pressed more often than the script asked: a-button (+1)',
    );
  });
});
