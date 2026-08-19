import type { Page } from 'playwright';

/** A screen appearing, on the same clock the driver records its actions on. */
export type ScreenChange = { testId: string; atEpochMs: number };

/** What the page calls the moment it sees a new screen. */
const CALLBACK = '__demoScreenChange';

/**
 * Which testIDs count as a screen a viewer would name.
 *
 * Supplied by the caller, with no default on purpose. A default here would be
 * one app's screen names living inside the generic observer, which is the kind
 * of coupling that makes this module unliftable into a package of its own.
 */
export type ScreenPattern = RegExp;

/**
 * Drops a change that repeats the screen already on the log.
 *
 * A reload replays the page's idea of the current screen even though nothing
 * changed for a viewer, and a duplicate here is not harmless: the timing checks
 * ask when the screen after a press arrived, so a phantom arrival at the moment
 * of a reload would make a press look like it landed on the wrong screen.
 *
 * Separate from the binding so it can be exercised without a browser.
 */
export const appendChange = (
  changes: ScreenChange[],
  change: ScreenChange,
): ScreenChange[] =>
  changes.at(-1)?.testId === change.testId ? changes : [...changes, change];

/**
 * The observer, as source.
 *
 * Passed as SOURCE, not as a function, and that is not a style choice. tsx
 * compiles a function argument before playwright serialises it, and esbuild
 * injects a `__name` helper for the named arrow functions inside, which does
 * not exist in the page. The script threw `ReferenceError: __name is not
 * defined` on every document, so the observer was never installed and the
 * screen log came back empty while the binding sat there looking healthy.
 *
 * Built by a function rather than written inline so a test can run it against a
 * real DOM. Its rules (which testIDs count as a screen, and that the INNERMOST
 * match wins) decide what the whole timing check sees, and they used to live
 * only inside a string nothing could reach.
 */
/**
 * Flags are carried through EXCEPT g and y.
 *
 * A caller's i or u changes what matches and must survive. A g or y makes
 * `test` stateful, and this matcher is built once and reused across every id,
 * so it would report every other screen. `appFaults` refuses such a pattern
 * outright; this strip is the second line of defence for a caller reaching
 * `observerSource` directly.
 */
export const observerSource = (
  screenPattern: ScreenPattern,
  callback: string = CALLBACK,
): string => `(() => {
    var matcher = new RegExp(${JSON.stringify(
      screenPattern.source,
    )}, ${JSON.stringify(screenPattern.flags.replace(/[gy]/g, ''))});
    var report = window[${JSON.stringify(callback)}];
    var previous = '';
    function look() {
      // The LAST match wins: a step renders inside a frame carrying its own
      // testID, and the innermost one is the screen a viewer would name.
      var ids = Array.prototype.slice
        .call(document.querySelectorAll('[data-testid]'))
        .map(function (node) { return node.getAttribute('data-testid') || ''; })
        .filter(function (id) { return matcher.test(id); });
      var current = ids.length ? ids[ids.length - 1] : '';
      if (!current || current === previous) return;
      previous = current;
      if (report) report({ testId: current, atEpochMs: Date.now() });
    }
    function start() {
      new MutationObserver(look).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-testid'],
      });
      look();
    }
    // Started from readiness: an init script runs before the document
    // necessarily has anything to watch.
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  })()`;

/**
 * The slice of a page this needs, rather than the whole of playwright's Page.
 *
 * Two methods, so a fake is two functions. Taking the full Page meant testing
 * the wiring cost a stub of an interface with hundreds of members, which is why
 * the installer went untested while the script it installs did not.
 */
export type Installable = Pick<Page, 'addInitScript' | 'exposeBinding'>;

/**
 * Watches for the app moving from one screen to the next, and timestamps it.
 *
 * This is the datum the harness was missing, and without it a whole class of
 * complaint could not be checked. The driver knows when it clicked and when a
 * locator resolved, but nothing knew when the SCREEN actually changed, so "the
 * press was drawn after the button was gone" could only ever be settled by
 * watching, which is how the same defect got fixed three times.
 *
 * Observed in the page rather than measured off the video, on purpose. A pixel
 * diff can say that something changed but not what, and it cannot name the
 * screen that arrived. The DOM already knows, and Date.now() in the page is the
 * same clock the timeline uses, so the two compare directly.
 *
 * Each change is pushed OUT to node as it happens, rather than piling up in a
 * page variable to be collected at the end. An earlier version did the latter
 * and always came back empty: an init script runs afresh for every document, so
 * any navigation inside the extension quietly replaced the array and discarded
 * everything before it. Pushing also means a take that dies partway still
 * yields the changes it saw.
 */
export const watchScreens = async (
  page: Installable,
  { screenPattern }: { screenPattern: ScreenPattern },
): Promise<{ changes: () => ScreenChange[] }> => {
  let changes: ScreenChange[] = [];
  await page.exposeBinding(CALLBACK, (_source, change: ScreenChange) => {
    changes = appendChange(changes, change);
  });

  await page.addInitScript(observerSource(screenPattern));

  return { changes: () => [...changes] };
};
