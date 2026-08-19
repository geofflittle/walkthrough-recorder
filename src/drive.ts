import { readFileSync } from 'node:fs';

import { chromium } from 'playwright';

import { viewOf } from './observe';
import { performerFor } from './perform';
import { watchPresses } from './press-mark';
import { recordedSubmit } from './replay';
import { scalingFaults } from './scaling';
import { watchScreens } from './screen-log';
import { makeFootage } from './footage';
import { makeTimeline } from './timeline';

import type { Bindings } from './perform';
import type { Press } from './press-mark';
import type { TrafficMode, RecordedTraffic } from './replay';
import type { ScreenPattern } from './screen-log';
import type { ScreenChange } from './screen-log';
import type { Step } from './script';
import type { TimelineEvent } from './timeline';
import type { Footage } from './footage';
import type { OnLearned } from './perform';
import type { Interaction } from './timing';
import type { BrowserContext } from 'playwright';

/**
 * Render at device resolution, not CSS resolution.
 *
 * The display is Retina, so the UI is drawn at 2x. Recording at CSS size
 * captures half the pixels the browser actually painted, which is why earlier
 * takes looked soft. Capturing at 2x and downsampling to 1080p keeps text
 * crisp instead of upscaling something that was never sharp.
 */
const DEVICE_SCALE = 2;

/** How long to linger before each action. Tuned by watching, not by theory. */
const DWELL_MS = 500;

/**
 * Marks are drawn by the PAGE now, not annotated by playwright.
 *
 * showActions is gone entirely, and this is the note explaining why so nobody
 * turns it back on. It draws its decoration, plays it for the full `duration`,
 * and only THEN dispatches the input, so that duration is a lead time rather
 * than a display length. Measured on a one-button page, the delay between
 * playwright reporting "done scrolling" and "performing click action" tracked
 * the dial exactly:
 *
 *   no showActions   0.005s
 *   duration  300    0.306s
 *   duration  900    0.907s
 *   duration 1800    1.808s
 *
 * At 900 a viewer saw the indicator play and then, a beat later, the button
 * react, which is two events for one click. Across fourteen clicks in one take
 * the gap was 0.905 to 0.937s, dead constant, which is what proved it was this
 * and not the app or a busy machine.
 *
 * The deeper problem is that showActions annotates the CALL while the input
 * goes to the renderer separately, so a mark and its effect are two things that
 * can only ever be approximately aligned. press-mark.ts draws from the real
 * pointerdown instead, which is the same event the button handles.
 *
 * It also cost the pointer decoration, which was already off: the pointer
 * animated toward the action point while the press dot sat there for the whole
 * window, so during the travel there were two marks on screen at once.
 */

/**
 * The page is NOT zoomed, and that is load-bearing rather than incidental.
 *
 * A 0.68 zoom used to fit the tall review step into the frame, and it silently
 * broke every indicator playwright draws. The coordinates it reports are
 * already in the zoomed page's space, and the screencast overlay scales them
 * again, so the cursor, the highlight and the press all landed at the true
 * position times the zoom. Measured: a button whose centre sat at y 427 had its
 * indicator drawn at y 290, and 427 times 0.68 is 290. On the entry screen
 * that put the pointer on the FIRST tile while the click landed on the third,
 * which read as a mis-click and was in fact a mis-drawn cursor.
 *
 * The frame is taller instead, and the review step is scrolled where it still
 * does not fit.
 */

/**
 * A screen the run can END on, named by the caller.
 *
 * `name` is what the transcript and the checks report, `testId` is what the
 * page renders. Keeping them separate lets an app name its screens whatever it
 * likes without the recorder knowing its testID scheme.
 */
export type TerminalScreen = { name: string; testId: string };

/**
 * Obtaining a browser, as a value rather than an import.
 *
 * Narrowed to what this file actually uses, so a fake is a handful of members
 * rather than the whole of playwright's BrowserContext.
 */
export type Launch = (
  profileDirectory: string,
  options: Parameters<typeof chromium.launchPersistentContext>[1],
) => Promise<BrowserContext>;

export const realLaunch: Launch = async (profileDirectory, options) =>
  chromium.launchPersistentContext(profileDirectory, options);

/**
 * Which terminal screen the run reached, given how many nodes matched each
 * screen's testID, in the order the caller listed them.
 *
 * Extracted because this single value decides whether the run is graded further
 * at all, and everything around it needs a browser. Falls back to the LAST
 * screen listed rather than the first: the caller orders these best to worst,
 * and a run whose state cannot be read has not demonstrably succeeded. Treating
 * the unreadable case as success is how a refusal gets recorded as a working
 * demo.
 */
export const terminalStateFrom = (
  matchCounts: number[],
  screens: TerminalScreen[],
): string =>
  screens[matchCounts.findIndex(count => count > 0)]?.name ??
  screens.at(-1)?.name ??
  'unknown';

export type DriveResult = {
  terminalState: string;
  /**
   * The screen the app calls success, carried so nothing downstream has to be
   * told it a second time. It is `terminalScreens[0].name`, which the app has
   * already stated once.
   */
  successState: string;
  /**
   * When the recording started, which is also when the timeline was zeroed, so
   * a transcript timestamp is already a video timestamp.
   */
  timelineOriginEpochMs?: number;
  /** What happened and when, relative to the timeline's own zero. */
  timeline: TimelineEvent[];
  /** Each interaction's ready and click moments, for grading their ordering. */
  interactions: Interaction[];
  /** When each screen arrived, as the page itself saw it. */
  screens: ScreenChange[];
  presses: Press[];
  /** Renders the transcript once the video offset is known. */
  timelineText: (toVideoMs?: (atMs: number) => number) => string;
  /** Where playwright wrote the page recording, when one was asked for. */
  videoPath?: string;
  /** Everything the script read off the page, by name. May be the only copy. */
  learned: Bindings<string>;
  finalText: string;
};

/**
 * Everything `recordWalkthrough` needs, named so callers can build one.
 *
 * Extracted from the inline parameter object because `recordTake` wraps this
 * function and had no way to say "the same options, plus a few". A consumer
 * assembling options in one place and passing them through also gets a type
 * error rather than a silently dropped field.
 */
export type RecordOptions<Ref extends string> = {
  /** The walkthrough to perform. The caller owns it, this file interprets it. */
  script: Step<Ref>[];
  /** Values the script refers to by name, such as a phrase or a password. */
  bindings: Bindings<Ref>;
  /** How long to rest on the final screen once the script ends. */
  finishHoldMs: number;
  /**
   * Everything about the app under test, which is the whole of what used to be
   * hardcoded here. Named as one group so a second app is a call site rather
   * than an edit to this file.
   */
  app: {
    /** Unpacked extension directory to load. */
    extensionPath: string;
    /** Viewport, which is also the recording's pixel size. */
    viewport: { width: number; height: number };
    /** Which testIDs name a screen, for the screen log. */
    screenPattern: ScreenPattern;
    /** Screens that legitimately arrive with nothing pressed before them. */
    arrivesUnprompted: string[];
    /** Glob for the backend calls a replay serves from a HAR. */
    providerUrls: string;
    /**
     * The one call a replay must answer itself, both to find and to route.
     *
     * ONE field, though it is used for two things. A glob stood beside it for
     * the routing, defended as a different question, and playwright's `route`
     * takes a RegExp just as happily. Two spellings of one endpoint meant
     * renaming it in one and not the other left the recorded entry found and
     * the route matching nothing, so the submission went to the real network
     * on a run whose whole promise is that it moves nothing.
     */
    submitPattern: RegExp;
    /**
     * Screens the run can end on, best outcome first.
     *
     * The FIRST is the app's success state, and everything downstream derives
     * it from here rather than asking again. Stated twice it can drift, and a
     * run graded against a success state the app no longer has fails every
     * take while every screen behaves.
     */
    terminalScreens: TerminalScreen[];
    /**
     * How long a take of THIS app can plausibly run, in seconds.
     *
     * An app fact, not a per-take one: one app's walkthrough is never under
     * twenty seconds, another finishes in eight, and a grader with one hardcoded
     * floor called every short take broken.
     *
     * REQUIRED, so there is no default to state twice. It was optional, and the
     * same 600 ended up written in the driver's terminal wait and again in the
     * grader's ceiling, free to disagree.
     */
    plausibleSeconds: { least: number; most: number };
    /**
     * Values the script MUST have learned by the end, and why each matters.
     *
     * What is worth refusing over is the app's to say. It might be an order
     * number, a recovery code, or nothing at all.
     */
    mustLearn?: { ref: Ref; whyItMatters: string }[];
    /**
     * Page to open inside the extension, relative to its root.
     *
     * Was `/expo/index.html`, hardcoded. It is the app's own build layout, and
     * an extension that ships its UI anywhere else could not be driven at all.
     */
    entryPath: string;
    /**
     * The control whose appearance means the app is ready to be driven.
     *
     * The tab UI hydrates before its first control exists, so this is waited on
     * rather than a fixed sleep. Which control that is belongs to the app.
     */
    readyTestId: string;
    /**
     * Which service-worker console lines to echo, or omit to echo none.
     *
     * The interesting failure usually surfaces here rather than in the UI,
     * which shows a generic message. What counts as interesting is the app's
     * vocabulary, so the pattern is the caller's.
     */
    workerLogPattern?: RegExp;
  };
  /** A fresh profile, since a used one may skip the screens the take is about. */
  profileDir: string;
  /**
   * Record the page here. Playwright captures from inside the browser, so it
   * needs no macOS permission, cannot pick up a lock screen or another window,
   * and has no device index to get wrong. Viewport only, so no browser chrome.
   */
  recordVideoDir?: string;
  /**
   * Write a playwright trace here, for opening in its viewer after a take went
   * wrong. Off unless asked: nothing in this library reads one, and a trace
   * costs 15 to 20MB a run.
   */
  traceDir?: string;
  /**
   * Fires once the extension is on screen and before the first click. The
   * caller decides what that moment is for, so this file knows nothing about
   * recording and a second walkthrough can reuse it.
   */
  onAppVisible?: () => Promise<void>;
  /**
   * Which browser binary to drive. Left undefined, playwright launches the
   * chromium it ships with, which is the only one every consumer is guaranteed
   * to have.
   *
   * This defaulted to a hardcoded `/Applications/Brave Browser.app` path, which
   * made the recorder unrunnable anywhere but one laptop. A replayed take on
   * playwright's own chromium passes every check, so the preference was never
   * load-bearing, and a browser is the app's to name alongside its extension
   * and its viewport.
   */
  browserPath?: string;
  /**
   * Record the backend traffic to a HAR, or serve it back from one.
   *
   * The provider is the only thing here that is slow AND out of our hands: a
   * discovery scan, a submission and their confirmations. Replaying it turns a
   * take into a render, which is what makes iterating on how the video LOOKS
   * affordable. Only the provider host is captured, so the extension's own
   * pages and assets still load normally.
   */
  har?: TrafficMode;
  // `live` is accepted and routes nothing, so a caller can pass what
  // `trafficModeFor` returned without first mapping that case to undefined.
  /** Names the recording file, so a take is identifiable on disk. */
  runName?: string;
  /**
   * Told the instant a capture binds a value, before anything else runs.
   *
   * Every line after a capture can throw, and the captured value may be the
   * only copy. Handing it over here makes the window zero rather than
   * defended.
   */
  onLearned?: OnLearned;
  /**
   * How a browser is obtained. Injected, and this is the seam that was missing.
   *
   * Everything else here got one (Shell in take.ts, the host in record.ts, the
   * Page in actor.ts) and reached near-total coverage. This function created
   * its own browser, so 360 of its lines could only be reached by launching
   * one, and the ORDERINGS it enforces went unchecked: observers installed
   * before any navigation, the screencast started before the timeline is
   * zeroed, the screencast stopped and the logs drained before the context
   * closes. Each of those has broken at least once, and each was found by
   * watching a two-minute take rather than by a test.
   */
  launch?: Launch;
  /**
   * The frame clock the closing hold waits on. Injected so a test can hand it
   * one that stops advancing, which is the only way to reach the stall ceiling
   * without a real encoder falling behind.
   */
  footage?: Footage;
  /** How long the closing hold waits for frames before giving up. */
  settleCeilingMs?: number;
};

/**
 * Waits for the recording to catch up with the hold just taken, or gives up.
 *
 * Bounded, because a stalled encoder must fail loudly rather than hang. The
 * ceiling is generous: this is only ever waiting out a lag the machine has
 * already demonstrated, not waiting for something that may never happen.
 */
export const settleFootage = async (
  footage: Footage,
  holdMs: number,
  {
    ceilingMs = holdMs * 2 + 2000,
    fromMs,
  }: { ceilingMs?: number; fromMs?: number } = {},
) => {
  // Anchored to when the hold BEGAN. Sampling the encoder's current position
  // here waits for a second full hold, because the wall-clock hold has already
  // elapsed by the time this runs, and every take then ends with twice the
  // closing rest it asked for.
  const recordedTo = fromMs ?? footage.recordedUntilMs();
  if (recordedTo === undefined) return;
  if ((footage.recordedUntilMs() ?? 0) >= recordedTo + holdMs) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    footage.awaitFootage(recordedTo, holdMs),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, ceilingMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

/** Whether any step, including inside an ifPresent branch, touches the clipboard. */
export const usesClipboard = <Ref extends string>(
  steps: Step<Ref>[],
): boolean =>
  steps.some(step =>
    step.do === 'setClipboard' || step.do === 'paste'
      ? true
      : step.do === 'ifPresent'
        ? usesClipboard(step.then)
        : false,
  );

/** Names every regex field an app states that carries a stateful flag. */
const statefulPatterns = (app: object): string[] =>
  Object.entries(app)
    .filter(([, value]) => value instanceof RegExp && /[gy]/.test(value.flags))
    .map(
      ([field, value]) =>
        `${field} carries the ${(value as RegExp).flags} flag, and a stateful regex matches every other subject, so drop g and y`,
    );

/**
 * Refuses an app whose fields contradict each other, before a browser starts.
 *
 * Every one of these otherwise surfaces as a playwright timeout minutes later,
 * naming a selector rather than the field that was wrong. The unprompted check
 * is the sharpest: an entry the screen pattern cannot match is DEAD, because
 * the observer only ever logs testIds that matched, so the exemption silently
 * never fires and nobody learns until a genuinely unprompted screen appears.
 */
export const appFaults = (app: {
  screenPattern: ScreenPattern;
  arrivesUnprompted: string[];
  terminalScreens: TerminalScreen[];
}): string[] => [
  ...app.arrivesUnprompted
    .filter(testId => !app.screenPattern.test(testId))
    .map(
      testId =>
        `arrivesUnprompted names ${testId}, which screenPattern ${String(
          app.screenPattern,
        )} cannot match, so the exemption can never fire`,
    ),
  // Every pattern the app states, not the one field the original bug was in.
  // A stateful flag makes `test` advance lastIndex, and each of these is built
  // once and reused: screenPattern across every id, submitPattern across every
  // HAR entry, workerLogPattern across every console line. So a g-flagged
  // pattern matches every OTHER subject. Found by walking the descriptor, so a
  // pattern added later is covered without anyone remembering to add it here.
  // Refused by name rather than stripped, because a caller who wrote it meant
  // something.
  ...statefulPatterns(app),
  ...(app.terminalScreens.length === 0
    ? ['terminalScreens is empty, so no run can be graded against anything']
    : []),
];

export const recordWalkthrough = async <Ref extends string>({
  script,
  bindings,
  finishHoldMs,
  app,
  profileDir,
  recordVideoDir,
  traceDir,
  onAppVisible,
  har,
  runName = 'take',
  browserPath,
  launch = realLaunch,
  onLearned,
  footage: suppliedFootage,
  settleCeilingMs,
}: RecordOptions<Ref>): Promise<DriveResult> => {
  const faults = appFaults(app);
  if (faults.length > 0)
    throw new Error(`this app cannot be recorded: ${faults.join('; ')}`);

  const timeline = makeTimeline();
  const context = await launch(profileDir, {
    executablePath: browserPath,
    headless: false,
    // A fixed viewport when recording: `null` follows the window and playwright
    // needs a size to encode. Recorded at the render resolution so the picture
    // is never upscaled, which is what made an earlier take look blocky.
    viewport: recordVideoDir ? app.viewport : null,
    // Pinned, because an app that reads either from the OS would record
    // differently on a different machine: dark on a dark desktop, and a
    // spinner that does not spin where reduced motion is on.
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    ...(recordVideoDir ? { deviceScaleFactor: DEVICE_SCALE } : {}),
    ...(har?.kind === 'record'
      ? {
          // Bodies embedded, since the responses ARE the fixture. Filtered to
          // the provider so the HAR does not also carry the extension's assets.
          recordHar: {
            path: har.path,
            mode: 'full' as const,
            content: 'embed' as const,
            urlFilter: app.providerUrls,
          },
        }
      : {}),
    args: [
      `--disable-extensions-except=${app.extensionPath}`,
      `--load-extension=${app.extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    if (har?.kind === 'replay') {
      // fallback, not abort: anything the recording missed still goes to the
      // network, so a slightly stale HAR degrades into a slow run rather than a
      // broken one.
      await context.routeFromHAR(har.path, {
        url: app.providerUrls,
        notFound: 'fallback',
        update: false,
      });
      // Registered AFTER the HAR so it wins, since playwright matches the most
      // recently added route first. The submission is the one request a
      // recording cannot answer: an app that builds a fresh payload every run
      // never matches a recorded body, so the request would fall through to the
      // real network. Answering with the RECORDED response keeps the recorded
      // id consistent with everything the app looks up afterwards.
      const submitted = recordedSubmit(
        JSON.parse(readFileSync(har.path, 'utf8')) as RecordedTraffic,
        app.submitPattern,
      );
      if (submitted)
        await context.route(app.submitPattern, async route =>
          route.fulfill({
            status: submitted.status,
            contentType: 'application/json',
            body: submitted.body,
          }),
        );
      else
        console.error(
          '  replay HAR has no successful submission, the take cannot reach done',
        );
    }
    // Off unless a caller asks. Nothing here reads a trace: it is for opening
    // in playwright's own viewer after a take went wrong, which is the only
    // reason to pay 15 to 20MB a run for one.
    //
    // It used to be the transcript's clock, and that is why it started before
    // navigation. The renderer that needed trace time is gone, so the timeline
    // is zeroed when the screencast starts and a transcript timestamp IS a
    // video timestamp.
    if (traceDir)
      await context.tracing.start({ screenshots: true, snapshots: true });

    // The extension id is only knowable once its service worker registers.
    let [worker] = context.serviceWorkers();
    if (!worker)
      worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    // Work an extension does in its service worker reports there, not in the
    // page, so its console is where the real error appears while the UI shows
    // only a generic message.
    const workerLogPattern = app.workerLogPattern;
    if (workerLogPattern)
      worker.on('console', message => {
        const text = message.text();
        if (workerLogPattern.test(text))
          console.log(`  [sw] ${text.slice(0, 300)}`);
      });
    const extensionId = new URL(worker.url()).host;

    // Reuse the context's own page rather than opening one. A persistent
    // context already has an about:blank page, and playwright records EVERY
    // page, so newPage() left two videos: a blank one and the real one. The
    // renderer picked the blank one and produced 48 seconds of white.
    const [existing] = context.pages();
    const page = existing ?? (await context.newPage());
    // Everything the walkthrough does goes through the actor, which records
    // the timing, paces the step, and marks the click.
    // showClicks off: the renderer draws the cursor and click effect from the
    // trace, which places them better than an injected overlay can.
    // showClicks on: the library's cursorOverlay did not render in two takes,
    // so the marker is drawn into the page where it is certainly captured.
    // Installed before any navigation, so the very first screen is recorded.
    // This is the only source of truth for WHEN a screen changed, which is what
    // makes a press landing after its target checkable rather than watchable.
    const screenLog = await watchScreens(page, {
      screenPattern: app.screenPattern,
    });

    // Presses are drawn BY the page, from the real pointerdown, rather than
    // annotated by playwright around the call that causes it. See press-mark.ts
    // for why: showActions withholds the input until its decoration has played,
    // so its duration is a lead time and the mark always finishes before the
    // app reacts. Installed before any navigation, like the screen log.
    const pressLog = await watchPresses(page);

    // A Performer, not an Actor. It can run steps and it can rest, and it
    // has no way to click, type or reach the page, so the walkthrough cannot
    // be written imperatively here even by accident.
    const performer = performerFor<Ref>({ page, timeline, dwellMs: DWELL_MS });
    // From here on the page is observed through a Stage, which has no way to
    // express an interaction. Every touch belongs to the actor, which records
    // as it acts, and that is now the compiler's rule rather than a habit.
    const view = viewOf(page);

    // Only when the script actually uses the clipboard. A paste affordance reads
    // the real clipboard, so a script with setClipboard or paste needs this and
    // one without it should not be handed a permission it never asked for.
    if (usesClipboard(script))
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto(`chrome-extension://${extensionId}/${app.entryPath}`, {
      waitUntil: 'domcontentloaded',
    });
    // The tab UI hydrates before the entry tile exists, so wait on the tile
    // rather than a fixed sleep.
    await view.find(app.readyTestId).waitFor({ timeout: 60_000 });
    // Refuse to record while anything scales the page.
    //
    // The indicators playwright draws use coordinates that do NOT account for a
    // zoom or transform on the root, while the clicks themselves do. So a scaled
    // page silently produces a video where every cursor, highlight and press is
    // drawn at position times the scale, pointing at the wrong control, while
    // the app behaves perfectly. That cost several rounds of looking for a
    // timing bug that was really a drawing bug, so the state is now refused
    // rather than tolerated.
    const scaling = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      return {
        rootZoom: root.zoom,
        bodyZoom: body.zoom,
        rootTransform: root.transform,
        bodyTransform: body.transform,
      };
    });
    const scaled = scalingFaults(scaling);
    if (scaled.length > 0)
      throw new Error(
        `the page is scaled (${scaled.join(
          ', ',
        )}), and playwright draws its indicators without accounting for that, so every cursor and press would be drawn at the wrong place`,
      );

    await onAppVisible?.();

    // The recording begins HERE, on the screen the walkthrough is about to act
    // on, because page.screencast is started explicitly rather than following
    // the context's lifetime. That one fact removes a great deal: there is no
    // startup to trim, no sync flash to find, no reconciling a recording that
    // began at launch against a trace that began later, and no piecewise map
    // from one clock to the other. The timeline is zeroed on the same line, so
    // a transcript timestamp IS a video timestamp.
    const videoPath = recordVideoDir
      ? `${recordVideoDir}/${runName}.webm`
      : undefined;
    const footage = suppliedFootage ?? makeFootage();
    if (videoPath) {
      await page.screencast.start({
        path: videoPath,
        size: app.viewport,
        // Both together, which the API allows. The file is the deliverable and
        // the frames are how the harness knows what is actually in it.
        onFrame: ({ timestamp }) => footage.sawFrame(timestamp),
      });
      // No showActions. Everything it drew, the page now draws from the event
      // itself, and without the lead time it imposed on every click.
    }
    timeline.start();

    // The whole walkthrough, interpreted from one list.
    //
    // It used to be written out here as imperative calls, with a second
    // hand-written copy elsewhere used to check them. Two representations of
    // one thing, free to disagree in either direction. Now the list IS the
    // walkthrough, and the checker derives its expectations from the same list,
    // so a run matching its script is true by construction.
    //
    // performWalkthrough talks only to the actor, never to the page, which is
    // what makes recording inseparable from acting. The click into a field that
    // once happened without being logged cannot happen here.
    const learned = await performer.perform(script, bindings, onLearned);
    for (const { ref, whyItMatters } of app.mustLearn ?? [])
      if (!learned[ref])
        throw new Error(
          `the walkthrough finished without learning ${ref}, ${whyItMatters}`,
        );

    // The app's own terminal testIDs, not a substring match on the page. An
    // overlaid screen leaves whatever it covers mounted underneath, so text
    // matching ends the wait on any chip that happens to say "error" or
    // "success", minutes before the outcome the take is about actually lands.
    await view
      .findAny(app.terminalScreens.map(screen => screen.testId))
      // The app's own bound, not a number baked in here. This was 400_000, one
      // app's own long-run figure duplicated from its own script, so a shop whose
      // whole take is eight seconds sat for 6m40 before failing.
      .waitFor({ timeout: app.plausibleSeconds.most * 1000 });

    // Which one it was, not just that one appeared: a refusal and a success are
    // otherwise indistinguishable to the caller, which then blames the backend
    // checks for a verdict the app already made.
    const reached = await Promise.all(
      app.terminalScreens.map(async screen => view.find(screen.testId).count()),
    );
    const terminalState = terminalStateFrom(reached, app.terminalScreens);
    const successState = app.terminalScreens[0]?.name ?? '';

    // Held, because the terminal screen IS the payoff and an earlier take gave
    // it about a second before the file ended.
    const holdBeganAtMs = footage.recordedUntilMs();
    await performer.hold(finishHoldMs, 'reading the outcome');
    // Then held again until the FOOTAGE arrives. The wait above is wall clock,
    // and the encoder runs behind it: measured on an idle laptop, 3060ms of
    // waiting produced 2216ms of frames. On a two-cpu CI runner that gap ended
    // a take before its closing hold and failed the grader on a take that was
    // otherwise fine.
    if (videoPath)
      await settleFootage(footage, finishHoldMs, {
        ceilingMs: settleCeilingMs,
        fromMs: holdBeganAtMs,
      });

    const finalText = await view.text();

    if (traceDir) await context.tracing.stop({ path: `${traceDir}/trace.zip` });
    // Stopped explicitly, so the file is finalised while the page still exists
    // and the take ends where the walkthrough ends rather than at browser close.
    if (videoPath) await page.screencast.stop();
    await context.close();
    return {
      interactions: performer.interactions(),
      screens: screenLog.changes(),
      presses: pressLog.presses(),
      learned,
      terminalState,
      successState,
      finalText,
      timeline: timeline.events(),
      timelineText: timeline.format,
      timelineOriginEpochMs: timeline.originEpochMs(),
      videoPath,
    };
  } finally {
    // Safe to call twice: playwright ignores a close on a closed context, and
    // this still runs when the walk throws before the close above.
    await context.close();
  }
};
