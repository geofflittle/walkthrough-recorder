import { writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { recordWalkthrough, settleFootage } from './drive';
import { ledgerOf, recording } from './recording';

import type { Asked, Ledger } from './recording';

import { makeFootage } from './footage';

import type { Launch } from './drive';
import type { BrowserContext } from 'playwright';

/** Only the part of playwright's Route the driver uses. */
type FulfilledWith = { status: number; contentType: string; body: string };
type FakeRoute = { fulfill: (options: FulfilledWith) => Promise<void> };

/** What the driver reads off the page to decide whether it is scaled. */
type Scaling = {
  rootZoom: string;
  bodyZoom: string;
  rootTransform: string;
  bodyTransform: string;
};
const UNSCALED: Scaling = {
  rootZoom: 'normal',
  bodyZoom: 'normal',
  rootTransform: 'none',
  bodyTransform: 'none',
};

/**
 * The orderings the recorder enforces, checked without launching a browser.
 *
 * Every one of these has broken at least once, and every one was found by
 * watching a two-minute take and noticing something looked wrong. They are all
 * orderings, which is the cheapest possible thing to assert, and they went
 * unasserted for one reason: this file created its own browser, so there was no
 * way to observe what it did to one.
 */
const fakeBrowser = ({ scaling = UNSCALED }: { scaling?: Scaling } = {}) => {
  /**
   * Everything the driver asked the browser to do, in order, with what it asked
   * WITH. One ledger rather than an accessor per question, because every gap in
   * this fake so far was an argument it accepted and dropped: a route handler it
   * never invoked, waitFor options it ignored, grantPermissions it discarded.
   * Each hid a real defect until a test happened to need that one field.
   */
  const asked: Asked[] = [];
  // Launch is the one thing not reachable through the context, since it is what
  // RETURNS the context. Everything else is recorded by the wrapper.
  const note = (what: string, withWhat: unknown[] = []) => {
    asked.push({ did: what, with: withWhat });
  };

  const element = {
    waitFor: async (_options?: { timeout?: number }) => {},
    count: async () => 1,
    innerText: async () => 'the page said this',
    boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    or: () => element,
    first: () => element,
    elementHandle: async () => ({
      waitForElementState: async () => undefined,
    }),
  };

  let onFrame: ((frame: { timestamp: number }) => void) | undefined;
  const page = {
    locator: () => element,
    goto: async () => {
      return null;
    },
    // The shape scaling.ts reads. Returning a bare string made it iterate the
    // characters and report the page as scaled "0=n, 1=o, 2=n, 3=e", which is
    // the fake being wrong rather than the guard.
    evaluate: async () => scaling,
    addInitScript: async () => {},
    exposeBinding: async () => {},
    waitForTimeout: async () => undefined,
    keyboard: { press: async () => undefined },
    screencast: {
      start: async (options?: {
        path?: string;
        onFrame?: (frame: { timestamp: number }) => void;
      }) => {
        // Frames, because the closing hold now waits for footage rather than
        // for the clock. Without them the fake records nothing and the hold
        // falls through to its ceiling.
        onFrame = options?.onFrame;
        for (let at = 0; at <= 200_000; at += 500)
          onFrame?.({ timestamp: 1_700_000_000_000 + at });
      },
      stop: async () => {},
    },
    context: () => context,
  };

  // Same reason as the route handler: registering a listener proves nothing
  // about what it does with a message, and the whole point of this one is that
  // it filters.
  let onConsole: ((message: { text: () => string }) => void) | undefined;
  const worker = {
    on: (event: string, handler: (message: { text: () => string }) => void) => {
      if (event === 'console') onConsole = handler;
    },
    url: () => 'chrome-extension://abc/sw',
  };

  // Stored rather than discarded, so a test can make the fake DO what the route
  // says. Recording that a route was installed proves the wiring and nothing
  // about what it serves, which is the half that matters to a replayed take.
  const handlers = new Map<string, (route: FakeRoute) => Promise<void>>();
  const context = {
    pages: () => [page],
    newPage: async () => page,
    grantPermissions: async (_permissions: string[]) => {},
    serviceWorkers: () => [worker],
    waitForEvent: async () => worker,
    route: async (
      url: string | RegExp,
      handler: (route: FakeRoute) => Promise<void>,
    ) => {
      handlers.set(String(url), handler);
    },
    routeFromHAR: async (_path: string) => {},
    tracing: {
      start: async () => {},
      stop: async () => {},
    },
    close: async () => {},
  } as unknown as BrowserContext;

  const launch: Launch = async (_profileDirectory, options) => {
    note('launch', [options ?? {}]);
    // Wrapped, so every call the driver makes on the context, or on anything it
    // hands back, is recorded whether or not a test asked for it. Nothing below
    // writes a recorder by hand, and nothing can be added that escapes one.
    return recording(context, asked) as BrowserContext;
  };

  /** Runs the handler installed for a url, and reports what it fulfilled. */
  const serve = async (url: string) => {
    let served: FulfilledWith | undefined;
    await handlers.get(url)?.({
      fulfill: async options => {
        served = options;
      },
    });
    return served;
  };

  /** Delivers a line to whatever the driver registered, if it registered one. */
  const emitWorkerLog = (text: string) => {
    onConsole?.({ text: () => text });
    return onConsole !== undefined;
  };

  return {
    launch,
    /** One reading surface. Adding a question no longer means adding a recorder. */
    ledger: () => ledgerOf(asked),
    serve,
    emitWorkerLog,
  };
};

/** One app, minimal, so a test can name only the field it is about. */
const APP = {
  extensionPath: '/nowhere',
  viewport: { width: 620, height: 760 },
  screenPattern: /-step$/,
  arrivesUnprompted: [],
  providerUrls: '**/never/**',
  submitPattern: /never\/submit/,
  terminalScreens: [{ name: 'done', testId: 'a-done-screen' }],
  entryPath: 'index.html',
  readyTestId: 'a-ready-control',
  plausibleSeconds: { least: 5, most: 600 },
};

const run = async (
  overrides: Record<string, unknown> = {},
  fakeOptions: { scaling?: Scaling } = {},
) => {
  const { launch, ledger, serve, emitWorkerLog } = fakeBrowser(fakeOptions);
  const result = await recordWalkthrough({
    script: [],
    bindings: {},
    finishHoldMs: 0,
    app: APP,
    profileDir: '/nowhere/profile',
    launch,
    ...overrides,
  });
  return { result, ledger, serve, emitWorkerLog };
};

describe('recordWalkthrough orderings', () => {
  it('installs both page observers BEFORE navigating anywhere', async () => {
    // An init script runs per document, so one installed after the first
    // navigation never sees the screen already on show. That is exactly how the
    // screen log came back empty while the binding sat there looking healthy.
    const { ledger } = await run();

    expect(ledger().did('addInitScript')).toBe(true);
    expect(ledger().didBefore('addInitScript', 'goto')).toBe(true);
  });

  it('exposes the binding before installing the script that calls it', async () => {
    // The page script reads window[CALLBACK] at press time, so the order is
    // survivable either way, but a binding installed after a document has
    // already loaded is not there for that document.
    const { ledger } = await run();

    expect(ledger().didBefore('exposeBinding', 'addInitScript')).toBe(true);
  });

  it('closes the context only AFTER the recording is stopped', async () => {
    // Closing first truncates the file. The take then ends wherever the encoder
    // happened to be rather than where the walkthrough ended.
    const { ledger } = await run({ recordVideoDir: '/tmp' });

    expect(ledger().didBefore('screencast.stop', 'close')).toBe(true);
  });

  it('starts the recording before performing any step', async () => {
    // The timeline is zeroed on the same line the screencast starts, so a
    // transcript timestamp IS a video timestamp. Starting late reintroduces the
    // two-clock problem that took a mapping table to paper over.
    const { ledger } = await run({ recordVideoDir: '/tmp' });

    expect(ledger().didBefore('goto', 'screencast.start')).toBe(true);
    expect(ledger().didBefore('screencast.start', 'close')).toBe(true);
  });

  it('installs a frame callback, so the hold can watch the recording', async () => {
    // Both path and onFrame together, which the API allows. The file is the
    // deliverable, the frames are how the harness knows what is in it.
    const { ledger } = await run({ recordVideoDir: '/tmp' });

    expect(
      (ledger().argsOf('screencast.start')?.[0] as { path?: string })?.path,
    ).toContain('/tmp/');
    expect(
      typeof (ledger().argsOf('screencast.start')?.[0] as { onFrame?: unknown })
        ?.onFrame,
    ).toBe('function');
  });

  it('records nothing when no video directory is asked for', async () => {
    // The grading path runs on headless runs too, so this must not throw.
    const { ledger } = await run();

    expect(ledger().did('screencast.start')).toBe(false);
  });

  it("carries the app's success state, so nothing restates it", async () => {
    // terminalScreens is ordered best outcome first, so the first IS the
    // success state. Downstream reads this rather than being told again.
    const { result } = await run();

    expect(result.successState).toBe('done');
  });

  it('does not return a reviewText no driver can populate', async () => {
    // RED. drive.ts assigns the literal '' and never anything else, yet the
    // field is on the public DriveResult and run.ts branches on it, so that
    // branch is unreachable in production. Only a fabricated fixture supplies a
    // non-empty value, which is why the branch reads as covered.
    const { result } = await run();

    expect(Object.keys(result)).not.toContain('reviewText');
  });

  it('reports the terminal screen the app declared', async () => {
    const { result } = await run();

    expect(result.terminalState).toBe('done');
  });

  it('refuses an unprompted screen the pattern can never match', async () => {
    // arrivesUnprompted is compared against screen testIds, and the observer
    // only logs testIds matching screenPattern. An entry the pattern cannot
    // match is a dead exemption, and naming a BUTTON rather than the screen it
    // sits on is the easy way to write one.
    await expect(
      run({
        app: {
          ...APP,
          screenPattern: /-step$/,
          arrivesUnprompted: ['a-button-not-a-screen'],
        },
      }),
    ).rejects.toThrow(/a-button-not-a-screen/);
  });

  it('accepts an unprompted screen the pattern does match', async () => {
    await expect(
      run({
        app: {
          ...APP,
          screenPattern: /-step$/,
          arrivesUnprompted: ['first-step'],
        },
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a stateful screenPattern, which makes matching order-dependent', async () => {
    // RED. appFaults calls screenPattern.test inside a filter, so a g-flagged
    // pattern with two entries makes the second fail and the driver refuses a
    // legitimate app. The same statefulness halves the in-page screen log.
    await expect(
      run({
        app: {
          ...APP,
          screenPattern: /-step$/g,
          arrivesUnprompted: ['first-step'],
        },
      }),
    ).rejects.toThrow(/flag/i);
  });

  it.each(['submitPattern', 'workerLogPattern'])(
    'refuses a stateful %s too, not just the one that was found first',
    async field => {
      // Both call `test` repeatedly on one instance, submitPattern inside a
      // find over HAR entries and workerLogPattern on every console line, so a
      // g flag makes each match every other time. The guard named only
      // screenPattern, which is the field the original bug happened to be in.
      await expect(
        run({ app: { ...APP, [field]: /submit/g } }),
      ).rejects.toThrow(/flag/i);
    },
  );

  it.each(['submitPattern', 'workerLogPattern'])(
    'refuses a stateful %s too, not just the one that was found first',
    async field => {
      // Both call `test` repeatedly on one instance, submitPattern inside a
      // find over HAR entries and workerLogPattern on every console line, so a
      // g flag makes each match every other time. The guard named only
      // screenPattern, which is the field the original bug happened to be in.
      await expect(
        run({ app: { ...APP, [field]: /submit/g } }),
      ).rejects.toThrow(/flag/i);
    },
  );

  it('refuses to finish when a value the app requires was never learned', async () => {
    // The check that used to be hardcoded to recoveredCode. An empty
    // script learns nothing, so this must throw with the app's own reason.
    await expect(
      run({
        app: {
          ...APP,
          mustLearn: [
            { ref: 'orderNumber', whyItMatters: 'it is the only receipt' },
          ],
        },
      }),
    ).rejects.toThrow(/orderNumber, it is the only receipt/);
  });
});

describe('one app, one statement of how long it may take', () => {
  it('waits for a terminal screen no longer than the app calls plausible', async () => {
    // RED. drive.ts hardcodes waitFor({ timeout: 400_000 }), which is one app's
    // long-run number duplicated from its own script. The app already states
    // how long it may take, via plausibleSeconds.most, and a shop whose whole
    // take is eight seconds sits for 6m40 before failing.
    const { ledger } = await run({
      app: { ...APP, plausibleSeconds: { least: 5, most: 60 } },
    });

    expect(
      Math.max(
        0,
        ...ledger()
          .everyArgsOf('waitFor')
          .map(a => (a[0] as { timeout?: number } | undefined)?.timeout ?? 0),
      ),
    ).toBe(60_000);
  });
});

describe('traffic modes', () => {
  const har = { path: '/tmp/drive-test-traffic.har' };

  // A real file, because replay reads the recording off disk to find the one
  // call it must answer itself.
  writeFileSync(
    har.path,
    JSON.stringify({
      log: {
        entries: [
          {
            request: { url: 'https://x.test/never/submit', method: 'POST' },
            response: { status: 200, content: { text: 'a-tx-id' } },
          },
        ],
      },
    }),
  );

  it('live touches no routing at all', async () => {
    // The default. Anything routed here would silently serve a stale fixture
    // during a run whose whole point is that it hits the real backend.
    const { ledger } = await run();

    expect(ledger().did('route')).toBe(false);
  });

  it('accepts the live mode and routes nothing for it', async () => {
    // trafficModeFor returns { kind: 'live' } for a normal run, and every caller
    // was mapping that to undefined before passing it. Accepting it here means
    // a caller hands over what it was given.
    const { ledger } = await run({ har: { kind: 'live' } });

    expect(ledger().did('route')).toBe(false);
    expect(
      (ledger().argsOf('launch')?.[0] as Record<string, unknown>).recordHar,
    ).toBeUndefined();
  });

  it('replay serves the provider from the HAR', async () => {
    const { ledger } = await run({ har: { kind: 'replay', ...har } });

    expect(ledger().argsOf('routeFromHAR')?.[0]).toBe(har.path);
  });

  it('replay answers the submit itself, since a HAR cannot', async () => {
    // A submission is not a lookup: replaying the recorded response is the only
    // way a replayed take reaches its done screen without writing anything.
    const { ledger } = await run({ har: { kind: 'replay', ...har } });

    // The SAME pattern that found the recorded entry, not a second spelling of
    // it. A glob beside the regex meant renaming the endpoint in one and not
    // the other left recordedSubmit satisfied while the route matched nothing,
    // so the submission reached the real network on a run billed as looks only.
    expect(ledger().argsOf('route')?.[0]).toBe(APP.submitPattern);
  });

  it('record captures the provider on the way out, and routes nothing', async () => {
    // Recording is a launch option, not a route: routing during a capture would
    // intercept the very traffic being captured.
    const { ledger } = await run({
      har: { kind: 'record', ...har },
    });

    expect(
      (ledger().argsOf('launch')?.[0] as Record<string, unknown>).recordHar,
    ).toMatchObject({
      path: har.path,
      urlFilter: '**/never/**',
    });
    expect(ledger().did('route')).toBe(false);
  });

  it('serves the recorded submission itself, body and all', async () => {
    // What the route DOES, not that one was installed. The take reaches its
    // done screen by reading the id out of this body, so an empty or defaulted
    // response ends the walkthrough on failed while every wiring check passes.
    const { serve } = await run({ har: { kind: 'replay', ...har } });

    expect(await serve(String(APP.submitPattern))).toEqual({
      status: 200,
      contentType: 'application/json',
      body: 'a-tx-id',
    });
  });

  it('routes no submit at all when the recording has none to serve', async () => {
    // Better than fulfilling with something invented: the run then fails on the
    // app's own terms, and the log says the recording is the reason.
    const empty = { path: '/tmp/drive-test-empty.har' };
    writeFileSync(empty.path, JSON.stringify({ log: { entries: [] } }));

    const { ledger, serve } = await run({ har: { kind: 'replay', ...empty } });

    expect(ledger().did('route')).toBe(false);
    expect(await serve('**/never/submit')).toBeUndefined();
  });

  it('records only the provider, not the extension assets', async () => {
    // An unfiltered HAR carries every page and bundle the extension loads,
    // which is both enormous and pointless as a traffic fixture.
    const { ledger } = await run({ har: { kind: 'record', ...har } });

    expect(
      (
        (ledger().argsOf('launch')?.[0] as Record<string, unknown>)
          .recordHar as { urlFilter: string }
      ).urlFilter,
    ).toBe('**/never/**');
  });
});

describe('the scaled page guard', () => {
  const zoomed = { ...UNSCALED, rootZoom: '1.25' };
  const transformed = {
    ...UNSCALED,
    bodyTransform: 'matrix(2, 0, 0, 2, 0, 0)',
  };

  it('refuses to record a page the browser is scaling', async () => {
    // Not a cosmetic complaint. Playwright draws its cursor and press
    // indicators in page coordinates without accounting for zoom, so a scaled
    // page records every annotation somewhere the click did not happen, and the
    // take looks subtly wrong in a way no output check can see.
    await expect(run({}, { scaling: zoomed })).rejects.toThrow(
      /the page is scaled/,
    );
  });

  it('names the fault, so the cause is fixable without bisecting css', async () => {
    await expect(run({}, { scaling: zoomed })).rejects.toThrow(/rootZoom/);
    await expect(run({}, { scaling: transformed })).rejects.toThrow(
      /bodyTransform/,
    );
  });

  it('refuses BEFORE starting to record, so no broken file is left behind', async () => {
    // A take that throws after the encoder starts leaves a partial mp4 that
    // looks like a real one.
    const { launch, ledger } = fakeBrowser({ scaling: zoomed });
    await expect(
      recordWalkthrough({
        script: [],
        bindings: {},
        finishHoldMs: 0,
        app: APP,
        profileDir: '/nowhere/profile',
        recordVideoDir: '/tmp',
        launch,
      }),
    ).rejects.toThrow(/the page is scaled/);

    expect(ledger().did('screencast.start')).toBe(false);
  });

  it('records a page that is not scaled', async () => {
    await expect(run()).resolves.toBeDefined();
  });
});

describe('the service worker log', () => {
  const pattern = { ...APP, workerLogPattern: /submit/ };

  it('prints a worker line the app asked to see', async () => {
    // The work runs in the worker, so its console is the only place the real
    // provider error appears. The wizard shows a generic message either way.
    const seen = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { emitWorkerLog } = await run({ app: pattern });

    emitWorkerLog('submit failed: already spent');

    expect(seen).toHaveBeenCalledWith('  [sw] submit failed: already spent');
    seen.mockRestore();
  });

  it('drops a worker line the app did not ask for', async () => {
    // An extension worker is noisy. Printing all of it buries the one line the
    // pattern exists to surface.
    const seen = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { emitWorkerLog } = await run({ app: pattern });

    emitWorkerLog('service worker registered');

    expect(seen).not.toHaveBeenCalled();
    seen.mockRestore();
  });

  it('truncates a line long enough to bury the rest of the log', async () => {
    const seen = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { emitWorkerLog } = await run({ app: pattern });

    emitWorkerLog(`submit ${'x'.repeat(1000)}`);

    expect(seen.mock.calls[0][0]).toHaveLength('  [sw] '.length + 300);
    seen.mockRestore();
  });

  it('listens to nothing when the app named no pattern', async () => {
    // The default. An app with no worker, or no interest in its console, must
    // not have a listener installed on its behalf.
    const { emitWorkerLog } = await run();

    expect(emitWorkerLog('submit failed')).toBe(false);
  });
});

describe('video modes', () => {
  it('fixes the viewport when recording, so the encoder has a size', async () => {
    const { ledger } = await run({ recordVideoDir: '/tmp' });

    expect(
      (ledger().argsOf('launch')?.[0] as Record<string, unknown>).viewport,
    ).toEqual({ width: 620, height: 760 });
  });

  it('follows the window when not recording', async () => {
    // null, not the app viewport: a headless run has no encoder to satisfy
    // and a fixed viewport would letterbox the real browser for no reason.
    const { ledger } = await run();

    expect(
      (ledger().argsOf('launch')?.[0] as Record<string, unknown>).viewport,
    ).toBeNull();
  });

  it('pins colour scheme and motion, so a machine cannot change the take', async () => {
    // The app reads both from the OS. A machine in dark mode recorded a dark
    // theme, and one with reduced motion recorded a spinner that did not spin.
    const { ledger } = await run({ recordVideoDir: '/tmp' });

    expect(
      (ledger().argsOf('launch')?.[0] as Record<string, unknown>).colorScheme,
    ).toBe('light');
    expect(
      (ledger().argsOf('launch')?.[0] as Record<string, unknown>).reducedMotion,
    ).toBe('no-preference');
  });

  it('renders at device resolution only when recording', async () => {
    const recorded = await run({ recordVideoDir: '/tmp' });
    const chainOnly = await run();

    const launchedBy = (run: { ledger: () => Ledger }) =>
      run.ledger().argsOf('launch')?.[0] as Record<string, unknown>;

    expect(launchedBy(recorded).deviceScaleFactor).toBe(2);
    expect(launchedBy(chainOnly).deviceScaleFactor).toBeUndefined();
  });

  it('traces nothing unless a caller asks for one', async () => {
    // The default, and the reason it is a default: a trace costs 15 to 20MB a
    // run and nothing in the library reads one. It was once the transcript's
    // clock, which is no longer true.
    const { ledger } = await run({ recordVideoDir: '/tmp' });

    expect(ledger().did('tracing.start')).toBe(false);
  });

  it('traces when a caller asks, for opening after a take went wrong', async () => {
    const { ledger } = await run({ recordVideoDir: '/tmp', traceDir: '/tmp' });

    expect(ledger().did('tracing.start')).toBe(true);
    // Stopped before the context closes, or the file is never written.
    expect(ledger().didBefore('tracing.stop', 'close')).toBe(true);
  });

  it("drives playwright's own chromium unless the app names another", async () => {
    // undefined, not a path. This was a hardcoded /Applications/Brave path, so
    // the recorder could not run on any machine without that exact browser at
    // that exact location, including every CI runner.
    const { ledger } = await run();

    expect(
      (ledger().argsOf('launch')?.[0] as Record<string, unknown>)
        .executablePath,
    ).toBeUndefined();
  });

  it('drives the browser the app named, when it names one', async () => {
    const { ledger } = await run({ browserPath: '/opt/some/browser' });

    expect(
      (ledger().argsOf('launch')?.[0] as Record<string, unknown>)
        .executablePath,
    ).toBe('/opt/some/browser');
  });

  it('asks for the clipboard only when the script uses it', async () => {
    // A paste affordance reads the real clipboard, so a script that touches it
    // needs the permission. One that does not should not be handed it, and this
    // was granted unconditionally on behalf of one app's long-value step.
    const { ledger } = await run({
      script: [{ do: 'hold', ms: 0, note: 'a beat' }],
    });

    expect(
      ledger()
        .everyArgsOf('grantPermissions')
        .map(a => a[0]),
    ).toEqual([]);
  });

  it('asks for the clipboard when a step does touch it', async () => {
    const { ledger } = await run({
      script: [{ do: 'setClipboard', value: 'aPhrase' }],
      bindings: { aPhrase: 'some words' },
    });

    expect(
      ledger()
        .everyArgsOf('grantPermissions')
        .map(a => a[0]),
    ).toEqual([['clipboard-read', 'clipboard-write']]);
  });

  it('sees a clipboard step inside an optional branch', async () => {
    const { ledger } = await run({
      script: [
        {
          do: 'ifPresent',
          target: 'a-prompt',
          required: false,
          then: [{ do: 'setClipboard', value: 'aPhrase' }],
        },
      ],
      bindings: { aPhrase: 'some words' },
    });

    expect(
      ledger()
        .everyArgsOf('grantPermissions')
        .map(a => a[0]),
    ).toEqual([['clipboard-read', 'clipboard-write']]);
  });

  it('loads the app as an unpacked extension', async () => {
    const { ledger } = await run();

    expect(
      (ledger().argsOf('launch')?.[0] as Record<string, unknown>).args,
    ).toContain('--load-extension=/nowhere');
  });
});

describe('settleFootage', () => {
  const AT = 1_787_000_000_000;

  it('returns at once when the footage already covers the hold', async () => {
    // The seam this needed: Footage is injectable now, so a test can hand the
    // driver a frame clock it controls instead of waiting on a real encoder.
    const footage = makeFootage();
    footage.sawFrame(AT);
    footage.sawFrame(AT + 5000);

    await settleFootage(footage, 800, { ceilingMs: 50, fromMs: AT });

    expect(footage.waiting()).toBe(0);
  });

  it('gives up at the ceiling when the encoder stalls', async () => {
    // A stalled encoder must fail loudly rather than hang. Nothing exercised
    // this before, because Footage was constructed inside recordWalkthrough and
    // the fake pumped 200 seconds of frames synchronously.
    const footage = makeFootage();
    footage.sawFrame(AT);

    const startedAt = Date.now();
    await settleFootage(footage, 5000, { ceilingMs: 30 });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(footage.waiting()).toBe(1);
  });

  it('does nothing at all when no frame ever arrived', async () => {
    const footage = makeFootage();

    await settleFootage(footage, 5000, { ceilingMs: 30 });

    expect(footage.waiting()).toBe(0);
  });

  it('waits only for the hold, measured from when the hold began', async () => {
    // RED. drive.ts samples recordedUntilMs() AFTER performer.hold has already
    // elapsed, then waits for finishHoldMs MORE footage past that point, so
    // every take holds twice. A replayed take showed an 11020ms tail
    // against a 7000ms hold and I read it as the seam working.
    const footage = makeFootage();
    footage.sawFrame(AT);
    // The hold ran: the encoder is now exactly one hold past where it started.
    footage.sawFrame(AT + 800);

    await settleFootage(footage, 800, { ceilingMs: 40, fromMs: AT });

    expect(footage.waiting()).toBe(0);
  });
});
