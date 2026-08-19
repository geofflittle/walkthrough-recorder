// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRESS_MARK_MS, pressMarkSource, watchPresses } from './press-mark';

import type { Press } from './press-mark';

/**
 * The mark, run against a real DOM.
 *
 * Worth testing at all because this script is a string: nothing type-checks it,
 * nothing imports it, and the last page script written this way threw on its
 * first line and ran zero times while everything around it looked healthy. The
 * only way to know it works is to run it.
 */
const MARK_MS = 200;

const reported: unknown[] = [];

const setReporter = () => {
  reported.length = 0;
  (window as unknown as Record<string, unknown>).__demoPress = (
    press: unknown,
  ) => reported.push(press);
};

const press = (target: Element, at = { x: 120, y: 300 }): void => {
  target.dispatchEvent(
    // MouseEvent, because jsdom has no PointerEvent constructor. The listener
    // keys off the event TYPE, which is the same either way.
    new window.MouseEvent('pointerdown', {
      bubbles: true,
      clientX: at.x,
      clientY: at.y,
    }),
  );
};

const targetWithId = (id = 'a-button') => {
  document.body.innerHTML = `<div data-testid="${id}"><span id="label">Go</span></div>`;
  return document.querySelector(`[data-testid="${id}"]`) as Element;
};

beforeAll(() => {
  // Once, like a document gets it. Installing per test would stack listeners on
  // jsdom's single shared document and draw a mark per install, which is
  // exactly what the script's own guard exists to prevent.

  eval(pressMarkSource(MARK_MS));
});

beforeEach(() => {
  document.body.innerHTML = '';
  setReporter();
  vi.useRealTimers();
});

describe('pressMarkSource', () => {
  it('installs without touching the DOM, so it cannot throw before listening', () => {
    // The failure that made this necessary. An earlier version appended a
    // stylesheet to document.documentElement at the top of the script, which an
    // init script can run before it exists, so it threw and never reached
    // addEventListener. The handler ran zero times and nothing said so.

    expect(() => {
      eval(pressMarkSource(MARK_MS));
    }).not.toThrow();
  });

  it('reports the testID the event actually landed on', () => {
    // Read back from the event, not from a selector the harness resolved
    // earlier. A press attributed to a stale target is how a mark ends up
    // claiming a control the click never touched.
    targetWithId();

    press(document.querySelector('#label') as Element);

    expect(reported[0]).toMatchObject({ testId: 'a-button', x: 120, y: 300 });
  });

  it('reports an empty testID rather than failing on a press that hit nothing', () => {
    // A press on the page background is not an error, and throwing here would
    // take the listener down for every later press too.
    press(document.body);

    expect(reported[0]).toMatchObject({ testId: '' });
  });

  it('draws exactly one dot per press', () => {
    // One press, one mark. Two marks for one click is the defect this whole
    // mechanism replaced, so it is worth asserting rather than assuming.
    press(targetWithId());

    expect(document.querySelectorAll('[data-demo-mark="dot"]')).toHaveLength(1);
  });

  it('draws the dot at the press, not at the element', () => {
    // The coordinates come from the event, which is what makes the mark
    // impossible to draw somewhere the click did not land.
    press(targetWithId(), { x: 200, y: 90 });
    const dot = document.querySelector('[data-demo-mark="dot"]') as HTMLElement;

    expect(dot.style.left).toBe('178px');
    expect(dot.style.top).toBe('68px');
  });

  it('outlines the element the event hit', () => {
    press(targetWithId());

    expect(document.querySelectorAll('[data-demo-mark="ring"]')).toHaveLength(
      1,
    );
  });

  it('draws no outline when the press hit nothing that carries a testID', () => {
    press(document.body);

    expect(document.querySelector('[data-demo-mark="ring"]')).toBeNull();
    expect(document.querySelector('[data-demo-mark="dot"]')).not.toBeNull();
  });

  it('clears its marks after the given lifetime', async () => {
    // They have to go, or a screen accumulates every press ever made on it.
    press(targetWithId());
    expect(document.querySelectorAll('[data-demo-mark]')).toHaveLength(2);

    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-demo-mark]')).toHaveLength(0);
    });
  });

  it('clears its marks as soon as the target leaves, before the timer', async () => {
    // The mark describes a control. A fixed-position mark appended to the body
    // survives a re-render that replaces the whole screen, so it would sit
    // there describing something gone. Measured on a take, five screens arrived
    // inside the mark's lifetime and it outlived every one.
    const target = targetWithId();
    press(target);
    expect(document.querySelectorAll('[data-demo-mark]')).toHaveLength(2);

    target.remove();

    // Waits for the removal, not for the lifetime. If this only passed once
    // MARK_MS had elapsed it would prove nothing about the coupling, so the
    // timeout is deliberately shorter than the mark's own lifetime.
    await vi.waitFor(
      () => {
        expect(document.querySelectorAll('[data-demo-mark]')).toHaveLength(0);
      },
      { timeout: MARK_MS - 80 },
    );
  });

  it('still draws when nothing is listening for the report', () => {
    // exposeBinding installs the callback separately from the init script, and
    // ordering between them is not something this can assume. Drawing is the
    // part a viewer sees, so it must not depend on the reporting half.
    delete (window as unknown as Record<string, unknown>).__demoPress;

    press(targetWithId());

    expect(document.querySelector('[data-demo-mark="dot"]')).not.toBeNull();
  });

  it('draws above everything, since the app owns the stacking below it', () => {
    press(targetWithId());
    const dot = document.querySelector('[data-demo-mark="dot"]') as HTMLElement;

    expect(dot.style.position).toBe('fixed');
    expect(dot.style.pointerEvents).toBe('none');
    expect(Number(dot.style.zIndex)).toBeGreaterThan(2_000_000_000);
  });
});

describe('PRESS_MARK_MS', () => {
  it('outlives a press, so the mark is still there when the app reacts', () => {
    // The mark cannot land early whatever this is, because the press draws it.
    // It CAN vanish too soon, which would put the effect on an unmarked screen.
    expect(PRESS_MARK_MS).toBeGreaterThan(300);
  });
});

describe('watchPresses', () => {
  /** Two functions, which is the whole point of narrowing the parameter. */
  const installable = () => {
    const scripts: string[] = [];
    let report: ((source: unknown, press: Press) => void) | undefined;
    return {
      scripts,
      page: {
        addInitScript: async (script: string) => {
          scripts.push(script);
        },
        exposeBinding: async (
          _name: string,
          function_: (source: unknown, press: Press) => void,
        ) => {
          report = function_;
        },
      } as unknown as Parameters<typeof watchPresses>[0],
      send: (press: Press) => report?.({}, press),
    };
  };

  const aPress = (testId: string, atEpochMs: number): Press => ({
    testId,
    atEpochMs,
    x: 1,
    y: 2,
  });

  it('installs the mark script with the given lifetime', async () => {
    const { page, scripts } = installable();

    await watchPresses(page, { markMs: 1234 });

    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('1234');
  });

  it('keeps every press, including repeats on one control', async () => {
    // Unlike screens, a repeat is real: the reveal toggle is pressed twice
    // on purpose, and asObserved pairs each press with its own interaction.
    const { page, send } = installable();

    const log = await watchPresses(page);
    send(aPress('a-toggle', 10));
    send(aPress('a-toggle', 20));

    expect(log.presses().map(press => press.atEpochMs)).toEqual([10, 20]);
  });

  it('hands back a copy, so a caller cannot edit the log', async () => {
    const { page, send } = installable();

    const log = await watchPresses(page);
    send(aPress('a-button', 10));
    log.presses().push(aPress('forged', 99));

    expect(log.presses()).toHaveLength(1);
  });
});
