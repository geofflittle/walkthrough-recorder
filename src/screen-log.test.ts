// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { appendChange, observerSource, watchScreens } from './screen-log';

import type { ScreenChange } from './screen-log';

const CALLBACK = '__demoScreenChange';

/**
 * Runs the real observer against a real DOM and collects what it reported.
 *
 * The script is the harness's only piece of in-page logic, and until it was
 * extracted it could only be exercised by recording a whole take. Its rules
 * decide what every timing check sees, so a change to them that looked
 * harmless would show up as a screen log that was subtly wrong rather than as
 * a failure.
 */
/**
 * The pattern under test, supplied here rather than imported from the observer.
 * It used to be the observer's default, which meant this suite proved the
 * observer worked against one app's screen names and said nothing about the
 * general case.
 */
const PATTERN =
  /-step$|^shop-(confirm-step|checkout-ok|failed|declined|cart-step|address-step)$/;

const observing = () => {
  const seen: ScreenChange[] = [];
  (window as unknown as Record<string, unknown>)[CALLBACK] = (
    change: ScreenChange,
  ) => seen.push(change);
  document.body.innerHTML = '';

  (0, eval)(observerSource(PATTERN));
  return {
    seen,
    render: async (html: string) => {
      document.body.innerHTML = html;
      // MutationObserver delivers on a microtask.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
};

describe('the in-page observer', () => {
  it('reports a screen when one appears', async () => {
    const { seen, render } = observing();

    await render('<div data-testid="shop-confirm-step"></div>');

    expect(seen.map(change => change.testId)).toEqual(['shop-confirm-step']);
  });

  it('reports the INNERMOST match, which is the screen a viewer would name', async () => {
    // A step renders inside a frame carrying its own testID. Taking the first
    // match would name the container on every screen, so the log would report
    // one screen for the whole run and every timing check would compare against
    // an arrival that never moved.
    const { seen, render } = observing();

    await render(`
      <div data-testid="shop-cart-step">
        <div data-testid="shop-review-step"></div>
      </div>
    `);

    expect(seen.at(-1)?.testId).toBe('shop-review-step');
  });

  it('ignores testIDs that are not screens', async () => {
    // Nearly every node in the app carries a testID. Reporting them all would
    // bury the screen changes the checks actually ask about.
    const { seen, render } = observing();

    await render(`
      <button data-testid="shop-cart-primary"></button>
      <input data-testid="shop-code-value" />
    `);

    expect(seen).toEqual([]);
  });

  it('stays quiet while the same screen is merely redrawn', async () => {
    const { seen, render } = observing();

    await render('<div data-testid="shop-confirm-step"></div>');
    await render(
      '<div data-testid="shop-confirm-step"><span>more</span></div>',
    );

    expect(seen).toHaveLength(1);
  });

  it('reports each screen in the order they arrived', async () => {
    const { seen, render } = observing();

    await render('<div data-testid="shop-cart-step"></div>');
    await render('<div data-testid="shop-address-step"></div>');
    await render('<div data-testid="shop-review-step"></div>');
    await render('<div data-testid="shop-checkout-ok"></div>');

    expect(seen.map(change => change.testId)).toEqual([
      'shop-cart-step',
      'shop-address-step',
      'shop-review-step',
      'shop-checkout-ok',
    ]);
  });

  it('timestamps on the page clock, which is the clock the timeline uses', async () => {
    const before = Date.now();
    const { seen, render } = observing();

    await render('<div data-testid="shop-checkout-ok"></div>');

    expect(seen[0].atEpochMs).toBeGreaterThanOrEqual(before);
    expect(seen[0].atEpochMs).toBeLessThanOrEqual(Date.now());
  });

  it('says nothing when the screen goes away and nothing replaces it', async () => {
    const { seen, render } = observing();

    await render('<div data-testid="shop-confirm-step"></div>');
    await render('<span>loading</span>');

    expect(seen).toHaveLength(1);
  });
});

describe('appendChange', () => {
  it('keeps a change that names a different screen', () => {
    expect(
      appendChange([{ testId: 'a-screen', atEpochMs: 1 }], {
        testId: 'another-screen',
        atEpochMs: 2,
      }),
    ).toEqual([
      { testId: 'a-screen', atEpochMs: 1 },
      { testId: 'another-screen', atEpochMs: 2 },
    ]);
  });

  it('drops a repeat of the screen already logged', () => {
    // A reload replays the page's idea of the current screen. The duplicate is
    // not harmless: the timing checks ask when the screen after a press
    // arrived, so a phantom arrival would make a press look like it landed on
    // a screen that had already moved on.
    const changes = [{ testId: 'a-screen', atEpochMs: 1 }];

    expect(appendChange(changes, { testId: 'a-screen', atEpochMs: 900 })).toBe(
      changes,
    );
  });

  it('keeps a screen that comes back after another one, since that is real', () => {
    // Going back a step is a genuine arrival, and the check that every screen
    // was reached by pressing something has to see it.
    expect(
      appendChange(
        [
          { testId: 'a-screen', atEpochMs: 1 },
          { testId: 'another-screen', atEpochMs: 2 },
        ],
        { testId: 'a-screen', atEpochMs: 3 },
      ),
    ).toHaveLength(3);
  });
});

describe('watchScreens', () => {
  /** Two functions, which is the whole point of narrowing the parameter. */
  const installable = () => {
    const scripts: string[] = [];
    let report: ((source: unknown, change: ScreenChange) => void) | undefined;
    return {
      scripts,
      page: {
        addInitScript: async (script: string) => {
          scripts.push(script);
        },
        exposeBinding: async (
          _name: string,
          function_: (source: unknown, change: ScreenChange) => void,
        ) => {
          report = function_;
        },
      } as unknown as Parameters<typeof watchScreens>[0],
      send: (change: ScreenChange) => report?.({}, change),
    };
  };

  it('installs the observer with the caller pattern', async () => {
    const { page, scripts } = installable();

    await watchScreens(page, { screenPattern: /^shop-.*-step$/ });

    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('shop-');
  });

  it('collects what the page reports, in order', async () => {
    const { page, send } = installable();

    const log = await watchScreens(page, { screenPattern: /-step$/ });
    send({ testId: 'one-step', atEpochMs: 10 });
    send({ testId: 'two-step', atEpochMs: 20 });

    expect(log.changes().map(change => change.testId)).toEqual([
      'one-step',
      'two-step',
    ]);
  });

  it('drops a repeat, so a reload is not a phantom arrival', async () => {
    // The timing checks ask when the screen AFTER a press arrived, so a
    // duplicate at reload time makes a press look like it landed on the wrong
    // screen. appendChange is tested directly above; this proves it is wired.
    const { page, send } = installable();

    const log = await watchScreens(page, { screenPattern: /-step$/ });
    send({ testId: 'one-step', atEpochMs: 10 });
    send({ testId: 'one-step', atEpochMs: 20 });

    expect(log.changes()).toHaveLength(1);
  });

  it('hands back a copy, so a caller cannot edit the log', async () => {
    const { page, send } = installable();

    const log = await watchScreens(page, { screenPattern: /-step$/ });
    send({ testId: 'one-step', atEpochMs: 10 });
    log.changes().push({ testId: 'forged', atEpochMs: 99 });

    expect(log.changes()).toHaveLength(1);
  });

  it("keeps the caller's regex flags when rebuilding it in the page", () => {
    // RED. observerSource rebuilds the pattern as new RegExp(source), dropping
    // flags. A caller passing /^SCREEN-/i gets case-insensitive matching in
    // their editor's mental model and case-sensitive matching in the page, so
    // the observer logs nothing, the screen log comes back empty, and four
    // timing checks used to pass on it while the command exited zero.
    expect(observerSource(/^screen-/i)).toContain('"i"');
  });

  it('emits the pattern and its flags as the page will compile them', () => {
    // Asserted on the generated source rather than parsed back out of it. My
    // first attempt pulled the arguments apart with a regex, which tested my
    // parsing rather than the emitted code.
    expect(observerSource(/^screen-/i)).toContain(
      'new RegExp("^screen-", "i")',
    );
  });

  it('refuses a stateful flag rather than carrying it into the page', () => {
    // RED. Keeping the caller's flags was right for i and u and wrong for g
    // and y: test on a global regex advances lastIndex, and the matcher is
    // built once and reused across every id, so a g-flagged pattern silently
    // logs every other screen.
    const source = observerSource(/-step$/g);

    expect(source).not.toContain('"g"');
  });
});
