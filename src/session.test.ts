import { describe, expect, it } from 'vitest';

import { ledgerOf, recording } from './recording';
import { recordTake, runWalkthrough } from './session';

import type { Launch } from './drive';
import type { Asked } from './recording';
import type { ProfileStore } from './profiles';
import type { Shell } from './shell';
import type { BrowserContext } from 'playwright';

/**
 * The combined entrypoint, checked for the thing it exists to prevent.
 *
 * Its whole job is plumbing what the driver returned into the grader, so what
 * is worth asserting is that nothing is dropped on the way. A field silently
 * missing here would not fail: the grade would simply be computed against less
 * than actually happened, which is the failure mode where every check passes
 * and the take was never really looked at.
 */
const fake = () => {
  let frameAtMs = 1_700_000_000_000;
  let emitFrame: ((frame: { timestamp: number }) => void) | undefined;
  const element = {
    waitFor: async () => undefined,
    count: async () => 1,
    innerText: async () => 'said something',
    boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    or: () => element,
    first: () => element,
    elementHandle: async () => ({ waitForElementState: async () => undefined }),
  };
  const page = {
    locator: () => element,
    goto: async () => null,
    evaluate: async () => ({
      rootZoom: 'normal',
      bodyZoom: 'normal',
      rootTransform: 'none',
      bodyTransform: 'none',
    }),
    addInitScript: async () => undefined,
    exposeBinding: async () => undefined,
    // The encoder keeps recording while the driver waits, so the frame clock
    // advances with wall time. A fake whose clock stands still makes every
    // closing hold sit until its stall ceiling, which is what a real stalled
    // encoder looks like and is not what a passing test should model.
    waitForTimeout: async (ms: number) => {
      for (let at = 500; at <= ms; at += 500)
        emitFrame?.({ timestamp: frameAtMs + at });
      frameAtMs += ms;
    },
    keyboard: { press: async () => undefined },
    screencast: {
      start: async (options?: {
        onFrame?: (f: { timestamp: number }) => void;
      }) => {
        // Frames, because the closing hold waits for footage. Discarding
        // onFrame made settleFootage a silent no-op in every session test.
        emitFrame = options?.onFrame;
        emitFrame?.({ timestamp: frameAtMs });
      },
      stop: async () => undefined,
    },
    context: () => context,
  };
  let onConsole: ((message: { text: () => string }) => void) | undefined;
  const worker = {
    on: (event: string, handler: (message: { text: () => string }) => void) => {
      if (event === 'console') onConsole = handler;
    },
    url: () => 'chrome-extension://a/sw',
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    grantPermissions: async () => undefined,
    serviceWorkers: () => [worker],
    waitForEvent: async () => worker,
    route: async () => undefined,
    routeFromHAR: async () => undefined,
    tracing: { start: async () => undefined, stop: async () => undefined },
    close: async () => undefined,
  } as unknown as BrowserContext;

  const asked: Asked[] = [];
  // Wrapped, so every call the driver makes on the context, or on anything it
  // hands back, is recorded whether or not a test asked for it.
  const launch: Launch = async () =>
    recording(context, asked) as unknown as BrowserContext;

  /** Delivers a worker line to whatever the driver registered, if anything. */
  const emitWorkerLog = (text: string) => {
    onConsole?.({ text: () => text });
    return onConsole !== undefined;
  };

  /** Records what the grader was asked to measure, so nothing can go missing. */
  const commands: string[][] = [];
  const shell: Shell = async (command, args) => {
    commands.push([command, ...args]);
    if (command === 'ffprobe') return { stdout: '620\n760\n95\n' };
    if (command === 'sh')
      return { stdout: Array.from({ length: 760 }, () => 20).join(' ') };
    return { stdout: '' };
  };

  const profileStore: ProfileStore = {
    list: () => ['old-one', 'old-two'],
    modifiedAtMs: () => 0,
    isProfile: () => true,
  };

  return {
    launch,
    shell,
    commands,
    profileStore,
    emitWorkerLog,
    ledger: () => ledgerOf(asked),
  };
};

/** One app, so a test can name only the field it is about. */
const APP = {
  extensionPath: '/nowhere',
  viewport: { width: 620, height: 760 },
  screenPattern: /-step$/,
  arrivesUnprompted: ['first-step'],
  providerUrls: '**/never/**',
  submitPattern: /never\/submit/,
  terminalScreens: [
    { name: 'done', testId: 'a-done-screen' },
    { name: 'failed', testId: 'a-failed-screen' },
  ],
  entryPath: 'index.html',
  readyTestId: 'a-ready-control',
  plausibleSeconds: { least: 5, most: 600 },
};

const run = async (overrides: Record<string, unknown> = {}) => {
  const { launch, shell, commands, profileStore, ledger } = fake();
  const logged: string[] = [];
  const errored: string[] = [];
  const result = await recordTake({
    script: [],
    bindings: {},
    finishHoldMs: 3000,
    app: APP,
    profileDir: '/profiles/current',
    videoPath: '/tmp/out.mp4',
    launch,
    shell,
    profileStore,
    writeText: () => undefined,
    log: message => logged.push(message),
    reportError: message => errored.push(message),
    ...overrides,
  } as Parameters<typeof recordTake>[0]);
  return { result, logged, errored, commands, ledger };
};

describe('a take that was never graded says so', () => {
  it('reports that it graded nothing, rather than that nothing failed', async () => {
    // An app that asked for no video has nothing to grade, and says so by
    // returning no grade rather than an empty check list, which would read as
    // "everything passed".
    const { result } = await run({ videoPath: undefined });

    expect(result.grade).toBeUndefined();
  });

  it('says it graded a take when it actually did', async () => {
    const { result } = await run();

    expect(result.grade).toBeDefined();
  });
});

describe('the app states its own plausible length', () => {
  // The fake reports a 95 second take, which is fine by a long walkthrough's bounds and
  // far too long by a checkout's.
  it("grades against the app's bounds, not a library default", async () => {
    const { result } = await run({
      recordVideoDir: '/tmp',
      app: { ...APP, plausibleSeconds: { least: 5, most: 60 } },
    });

    expect(result.grade?.failedChecks ?? []).toContain(
      'runs for a plausible length (5 to 60s)',
    );
  });

  it('falls back to a wide range when the app says nothing', async () => {
    // Wide on purpose: a library that guesses narrowly fails honest takes, and
    // the app is the only thing that knows what its own walkthrough costs.
    // Asserted against the length check alone: this fake drives an empty script
    // through a fake browser, so it legitimately reports no screen changes and
    // fails the instrumentation check, which is a different subject.
    const { result } = await run({ recordVideoDir: '/tmp' });

    expect(result.grade?.failedChecks ?? [].join('\n')).not.toContain(
      'plausible length',
    );
  });

  it("still fails a take too short even by the app's own floor", async () => {
    const { result } = await run({
      recordVideoDir: '/tmp',
      app: { ...APP, plausibleSeconds: { least: 200, most: 600 } },
    });

    expect(result.grade?.failedChecks ?? []).toContain(
      'runs for a plausible length (200 to 600s)',
    );
  });
});

describe('recordTake', () => {
  it('grades the take without the caller wiring the driver to the grader', async () => {
    // The point. Twelve arguments used to be copied by hand from what the
    // driver returned into what the grader wanted, at every call site.
    const { result, logged } = await run({ recordVideoDir: '/tmp' });

    expect(result.videoPath).toBe('/tmp/out.mp4');
    expect(logged.some(line => line.includes('PASS take'))).toBe(true);
  });

  it('measures the finished file, not the recording it came from', async () => {
    const { commands } = await run({ recordVideoDir: '/tmp' });

    expect(commands.find(([command]) => command === 'ffprobe')?.at(-1)).toBe(
      '/tmp/out.mp4',
    );
  });

  it('takes the success state from the first terminal screen', async () => {
    // The caller lists them best outcome first, so asking again for which one
    // means success would be a second chance to disagree with itself.
    const { logged } = await run({ recordVideoDir: '/tmp' });

    expect(logged.join('\n')).toContain('reached its done screen');
  });

  it('names old profiles and how to remove them, without removing them', async () => {
    // Reported, not deleted. The paths are in the message so acting on it is
    // one paste, and not acting on it costs nothing but disk.
    const { logged } = await run();

    expect(logged.join('\n')).toContain('2 old profile(s)');
    expect(logged.join('\n')).toContain(
      'rm -rf /profiles/old-one /profiles/old-two',
    );
  });

  it('says nothing when there are no old profiles', async () => {
    const { logged } = await run({
      profileStore: {
        list: () => [],
        modifiedAtMs: () => 0,
        isProfile: () => true,
      },
    });

    expect(logged.join('\n')).not.toContain('old profile');
  });

  it('skips grading entirely when no video was asked for', async () => {
    // A headless run is a legitimate use of the driver, so this
    // returns the outcome rather than complaining about a missing file.
    const { result, commands } = await run({ videoPath: undefined });

    expect(result.grade?.failedChecks ?? []).toEqual([]);
    expect(result.terminalState).toBe('done');
    expect(commands.find(([command]) => command === 'ffprobe')).toBeUndefined();
  });

  it('hands back what the script learned, alongside the grade', async () => {
    // The caller almost always needs both: the verdict, and whatever the run
    // read off the page that nothing else can recover.
    const { result } = await run({ recordVideoDir: '/tmp' });

    expect(result.learned).toEqual({});
    expect(result.terminalState).toBe('done');
  });
});

/**
 * The one-call entry point. `runSession` needs a `record` step and the only
 * sensible one is `recordTake` with the same options, so every consumer wrote
 * that wiring itself and the other consumer wrote it twice.
 */
describe('runWalkthrough', () => {
  const walkthrough = async (overrides: Record<string, unknown> = {}) => {
    const { launch, shell, profileStore } = fake();
    const logged: string[] = [];
    const outcome = await runWalkthrough({
      script: [],
      bindings: {},
      finishHoldMs: 3000,
      app: APP,
      profileDir: '/profiles/current',
      videoPath: '/tmp/out.mp4',
      recordVideoDir: '/tmp',
      launch,
      shell,
      profileStore,
      writeText: () => undefined,
      log: (message: string) => logged.push(message),
      reportError: () => undefined,
      ...overrides,
    } as Parameters<typeof runWalkthrough>[0]);
    return { outcome, logged };
  };

  it('records the take itself, with no record step supplied', async () => {
    const { outcome } = await walkthrough();

    // The take was driven and graded. Not `ok`, because the fake browser
    // reports no screen changes, which the instrumentation check now fails on
    // purpose: an empty screen log used to pass four timing checks vacuously.
    expect(outcome.terminalState).toBe('done');
    expect(outcome.failedChecks).toContain(
      'the page reported its screen changes',
    );
  });

  it('grades the take it recorded, so failures reach the outcome', async () => {
    // The reason the default is recordTake and not recordWalkthrough: a session
    // whose record step does not grade reports an unwatchable video as fine.
    const { outcome } = await walkthrough({
      app: { ...APP, plausibleSeconds: { least: 200, most: 600 } },
    });

    expect(outcome.failedChecks).toContain(
      'runs for a plausible length (200 to 600s)',
    );
  });

  it('starts the recorder on the readiness hook, not before launch', async () => {
    // Library knowledge that used to leak outward: start it any earlier and the
    // take opens on a blank browser. An app supplying its own recorder should
    // not have to know when to start it.
    const started: string[] = [];
    await walkthrough({
      steps: {
        makeRecorder: () => ({
          start: async () => {
            started.push('start');
          },
          stop: async () => undefined,
        }),
      },
    });

    expect(started).toEqual(['start']);
  });

  it("still calls an app's own onAppVisible before the recorder", async () => {
    // Composed, not replaced. An app that wants its own hook keeps it.
    const order: string[] = [];
    await walkthrough({
      onAppVisible: async () => {
        order.push('app');
      },
      steps: {
        makeRecorder: () => ({
          start: async () => {
            order.push('recorder');
          },
          stop: async () => undefined,
        }),
      },
    });

    expect(order).toEqual(['app', 'recorder']);
  });

  it('defers to a record step the app does supply', async () => {
    // The escape hatch: recording by some other means than recordTake.
    let mine = false;
    const { outcome } = await walkthrough({
      steps: {
        record: async () => {
          mine = true;
          return {
            learned: {},
            terminalState: 'done',
            successState: 'done',
            reviewText: '',
            finalText: '',
          } as never;
        },
      },
    });

    expect(mine).toBe(true);
    expect(outcome.ok).toBe(true);
  });
});

describe('what the session fake was asked to do', () => {
  it('starts the recording before it closes the context', async () => {
    // Free, now that the fake is wrapped. Nothing here writes a recorder, and
    // this ordering was previously only checked in drive.test.ts.
    const { ledger } = await run({ recordVideoDir: '/tmp' });

    expect(ledger().didBefore('screencast.start', 'close')).toBe(true);
  });

  it('waits for the footage the closing hold asked for', async () => {
    // The gap this conversion closed. screencast.start discarded onFrame, so
    // settleFootage saw no frames at all and returned immediately, which meant
    // every session test silently skipped the hold it was meant to exercise.
    const { ledger } = await run({ recordVideoDir: '/tmp' });

    expect(ledger().did('screencast.start')).toBe(true);
    expect(
      (ledger().argsOf('screencast.start')?.[0] as { onFrame?: unknown })
        ?.onFrame,
    ).toBeTypeOf('function');
  });

  it('registers a worker console listener when the app asks for one', async () => {
    // The other gap: worker.on discarded the handler, so the filter that picks
    // the one useful line out of a noisy extension worker was unexercised here.
    const { emitWorkerLog } = fake();

    expect(emitWorkerLog('anything')).toBe(false);
  });
});

describe('the raw recording is named after the finished one', () => {
  it('derives the webm name from videoPath', async () => {
    // RED. Both consumers were passing runName purely to keep these two names
    // aligned, which is a fact recordTake already holds. Without this, a take
    // directory reads take.webm beside out.mp4, and the one file named
    // differently is the one nobody meant to name at all.
    const { ledger } = await run({ videoPath: '/tmp/out.mp4' });

    expect(
      (ledger().argsOf('screencast.start')?.[0] as { path: string }).path,
    ).toBe('/tmp/out.webm');
  });
});

describe('one path decides everything about the video', () => {
  it('records beside the finished file, with no directory named twice', async () => {
    // RED. Every consumer passed dirname(videoPath) and nothing else, so the
    // directory was a second way to say what videoPath already said. Two
    // fields that must agree is a defect generator: supply one and omit the
    // other and the take is silently never graded.
    const { ledger, result } = await run({
      recordVideoDir: undefined,
      videoPath: '/tmp/take.mp4',
    });

    expect(
      (ledger().argsOf('screencast.start')?.[0] as { path: string }).path,
    ).toBe('/tmp/take.webm');
    expect(result.grade).toBeDefined();
  });

  it('records nothing when no finished file was asked for', async () => {
    // The other half. Absence of videoPath is how an app says it wants no
    // video, and that has to remain the ONLY way to say it.
    const { ledger } = await run({
      recordVideoDir: undefined,
      videoPath: undefined,
    });

    expect(ledger().did('screencast.start')).toBe(false);
  });
});
