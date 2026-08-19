import type { Timeline } from './timeline';
import type { Interaction } from './timing';
import type { Page } from 'playwright';

/**
 * The one thing the driver talks to.
 *
 * Every interaction goes through here, which is what makes two otherwise
 * scattered concerns free. Timing is recorded because each method records it,
 * not because a caller remembered. Pacing lives in the pause each method takes
 * before acting.
 *
 * Adding an interaction later gets both by construction. That is the point of
 * routing everything through one object rather than calling `page` directly.
 */
/**
 * Proof that a control was on screen and had stopped moving.
 *
 * The whole point is that this cannot be written down: the brand is a unique
 * symbol with no exported value, so the only way to hold one is to have
 * awaited it. Every method that acts on the page takes one of these instead of
 * a testID string, which makes an unreactive interaction a type error rather
 * than a convention someone has to remember.
 *
 * Before this, click() happened to await readiness first, and nothing stopped
 * the next method, or a direct page.locator(...).click(), from skipping it.
 * Playwright's own auto-wait would have thrown rather than mis-firing, so the
 * old arrangement was safe at runtime and silent at review time, which is the
 * wrong way round.
 */
declare const proven: unique symbol;
export type Present = { readonly [proven]: true; readonly testId: string };

export type Actor = {
  /**
   * Wait until a target is painted AND has stopped moving.
   *
   * The primitive the rest of this is built on, not a helper. Every interaction
   * begins here, because acting on a target that has not settled is what makes
   * a walkthrough look automated: playwright's own auto-wait is invisible to
   * the renderer, which schedules the pointer's travel to START before the
   * keyframe it is travelling to, so the pointer sets off toward a control
   * while that control is still being painted.
   */
  awaitReady: (testId: string, timeout?: number) => Promise<Present>;
  /** Click a testID, after pausing so the viewer sees where it is going. */
  click: (
    target: Present,
    options?: { timeout?: number; dwellMs?: number; beforeMs?: number },
  ) => Promise<void>;
  /** Put the value on the clipboard, then paste it into a field. */
  fill: (target: Present, value: string) => Promise<void>;
  /** Type into a field, a character at a time. */
  type: (target: Present, value: string, perKeyMs?: number) => Promise<void>;
  /** Wait for a screen, recording how long it took to arrive. */
  awaitScreen: (testId: string, timeout?: number) => Promise<void>;
  /** Hold, so a viewer can read. The note says what they are reading. */
  linger: (ms: number, note?: string) => Promise<void>;
  /** Scroll a below-the-fold target into view smoothly, then settle on it. */
  revealBottom: (target: Present, settleMs?: number) => Promise<void>;
  /** Put a value on the clipboard, for the affordances that read it. */
  setClipboard: (value: string) => Promise<void>;
  /** Read text without touching anything, so it is not recorded as an action. */
  textOf: (testId: string) => Promise<string>;
  /**
   * Whether a control turns up, for the parts of the wizard that are optional.
   *
   * `required` separates the two failures an instantaneous check cannot: a
   * sheet that mounts late, and one that never comes. Where a step cannot
   * proceed without it, absence is an error rather than a branch not taken.
   */
  appears: (
    testId: string,
    options: { timeout: number; required: boolean },
  ) => Promise<boolean>;
  /** How many nodes match, for deciding which terminal screen was reached. */
  count: (testId: string) => Promise<number>;
  /**
   * Every interaction, with the moment its target settled and the moment it was
   * clicked, both on the wall clock the page's screen log also uses. Recorded
   * so the ordering of press against screen change is checkable rather than
   * something to be watched for.
   */
  interactions: () => Interaction[];
  // Deliberately NO page here.
  //
  // Exposing it handed every holder of an Actor a way around the actor, which
  // is exactly how a click into a field once happened without being recorded:
  // the video showed two presses and the transcript admitted one. With the page
  // unreachable from here, "acted without recording it" stops being something
  // to remember and becomes something that does not compile.
};

const tid = (name: string) => `[data-testid="${name}"]`;

/**
 * Quiet between a control being ready and the pointer setting off for it.
 *
 * A pacing beat now, and nothing more. It used to carry an invariant: the old
 * renderer composited the pointer afterwards and began each travel a fixed time
 * BEFORE the keyframe it travelled to, so this pause had to exceed that travel
 * or the pointer set off before its target was painted. playwright draws the
 * pointer live as the action happens, so that failure is no longer expressible
 * and this is free to be chosen for how it looks.
 */
const SETTLE_MS = 400;

/** Extra beat before a field is used, on top of the settle. */
const FIELD_DWELL_MS = 250;

/**
 * How long the mouse button is held down, between mousedown and mouseup.
 *
 * This is the only still moment a press gets, and that is why it is this long.
 * The mark is drawn on mousedown and the app reacts on mouseup, so the hold is
 * exactly the window in which a viewer sees the mark against a screen that is
 * not yet repainting.
 *
 * Measured across one take, as screen motion during each mark's lifetime and
 * the delay before the next full repaint:
 *
 *   3.72s   motion 18.02   next change  320ms
 *   7.52s   motion 14.55   next change  280ms
 *  16.96s   motion 13.18   next change  400ms
 *  38.00s   motion 14.43   next change  360ms
 *  41.96s   motion  0.42   next change 2480ms
 *  81.56s   motion  0.44   next change 1960ms
 *
 * The last two are the presses that read clearly. They are not marked for
 * longer, every mark lasts 280 to 440ms, they simply happen to open a modal
 * that does not repaint the page, so the mark sits on a still screen. The rest
 * compete with a whole screen arriving underneath them and the eye reads the
 * transition instead.
 *
 * Lengthening the hold buys that stillness honestly. The alternative, delaying
 * the input after drawing the mark, is what playwright's showActions did, and
 * it decoupled the mark from its effect by however long it waited.
 */
export const PRESS_HOLD_MS = 320;

/** The paste chord this machine's viewer would recognise. */
const PASTE_KEY = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';

/**
 * Nothing here marks a click. The PAGE does, from the press itself.
 *
 * See press-mark.ts. What matters here is that this file does not participate:
 * it dispatches a real click and the mark follows from that same event, so
 * there is nothing to keep in step and nothing that can drift.
 *
 * Marking from THIS side was tried twice for a post-render and both were worse.
 * An overlay injected into the page never survived, because the render was
 * built from playwright's own screenshots and a ring that lives 600ms is simply
 * absent from the frames it kept. A marker written with `tracing.group` did
 * render, but four seconds early, because a group's timestamp is not on the
 * clock markers were reconciled against.
 */
export const makeActor = ({
  page,
  timeline,
  dwellMs = 500,
}: {
  page: Page;
  timeline: Timeline;
  /** Pause before each action. Overridden per step by the walkthrough. */
  dwellMs?: number;
}): Actor => {
  const interactions: Interaction[] = [];

  /**
   * Painted, and holding still.
   *
   * Visibility alone is not enough: a control that has just mounted is often
   * mid-transition, and its box moves for a few frames afterwards. That is the
   * difference between the pointer arriving somewhere and the pointer arriving
   * where the control ends up.
   */
  const awaitReady = async (
    testId: string,
    timeout = 25_000,
  ): Promise<Present> => {
    await timeline.span({ kind: 'ready', target: testId }, async () => {
      // ONE wait, not two. 'stable' already means visible AND the bounding box
      // unchanged across two consecutive animation frames, so waiting on
      // visibility first was redundant, and each extra step widened the window
      // in which the handle could go stale.
      //
      // Reactive rather than sampled: this replaced a poll that read the box on
      // a timer and inferred the same thing. The poll was measured before being
      // deleted, and across a whole take all twenty waits finished in the
      // minimum two readings, while the app's transitions are invisible to
      // getAnimations() anyway, so it never once waited for anything.
      //
      // Via an ElementHandle because 'stable' lives on waitForElementState and
      // not on Locator.waitFor. Handles are discouraged for going stale, which
      // is survivable here: one is taken and used immediately, and if it does
      // go stale the wait throws and the run fails, rather than a take being
      // quietly recorded against a control that was never there.
      const handle = await page.locator(tid(testId)).elementHandle({ timeout });
      if (!handle) throw new Error(`${testId} never appeared`);
      await handle.waitForElementState('stable', { timeout });
    });
    // The only place a Present is minted, and only after the wait above.
    return { testId } as Present;
  };

  /**
   * The beat before a field is used. NOT a click.
   *
   * There used to be a real click here, so the transcript would admit to the
   * press a viewer could see. That was the right fix for the wrong shape.
   * playwright outlines the target of EVERY action, so one gesture reaching a
   * field was two actions on one element: the field lit up for the click, went
   * dark for about 150ms as that annotation expired, and lit up again for the
   * typing. Measured on a take, the password field at 28.5s and again at 29.6s.
   *
   * Stretching the annotation so the two overlap would hide it, and would come
   * apart again the first time a click took longer to round trip. So the second
   * action is gone instead: pressSequentially and locator.press both focus the
   * element before acting, which is what the click was really for. One gesture,
   * one action, one outline, and the transcript still matches the video because
   * there is no longer a press in either.
   */
  const settleBeforeField = async () => {
    await page.waitForTimeout(SETTLE_MS + FIELD_DWELL_MS);
  };

  return {
    awaitReady,
    click: async (
      { testId },
      { timeout = 25_000, dwellMs: hold = dwellMs, beforeMs = 0 } = {},
    ) => {
      const target = page.locator(tid(testId));
      // No wait here: holding a Present IS the wait, already done. That is the
      // point of the token. Playwright would still wait inside hover(), but
      // invisibly, and the renderer would schedule the pointer's travel to
      // begin during it, moving toward a button that has not been painted.
      const readyAtMs = Date.now();
      // A beat for the viewer to take the screen in, before the pointer moves.
      if (beforeMs > 0) await page.waitForTimeout(beforeMs);
      // NO hover before the press, and that is the whole point.
      //
      // playwright annotates EVERY action it recognises, so hovering a control
      // and then clicking it drew two decorations on the same button, each with
      // its own highlight and label, about a dwell apart. To a viewer that is
      // two clicks. The click already animates the pointer from wherever it was
      // and highlights the target, so the hover bought nothing and cost a
      // phantom press.
      //
      // The settle stays: it is what stops the pointer setting off before the
      // screen it is moving on has painted.
      await page.waitForTimeout(SETTLE_MS + hold);
      timeline.record({ kind: 'click', target: testId });
      interactions.push({ target: testId, readyAtMs, clickedAtMs: Date.now() });
      // A HELD press, not an instantaneous one. This is what actually couples
      // the indicator to the interaction: playwright's default click puts
      // mousedown and mouseup in the same millisecond, so the button never
      // enters its own pressed state and the app navigates before anything can
      // be seen. Holding for PRESS_HOLD_MS makes the interaction take real
      // time, the app renders its own :active styling, and the navigation fires
      // on release. The drawn press then sits on top of something true rather
      // than standing in for it.
      await target.click({ timeout, delay: PRESS_HOLD_MS });
    },
    fill: async (target, value) => {
      const { testId } = target;
      await settleBeforeField();
      timeline.record({ kind: 'type', target: testId, detail: 'pasted' });
      // NOT an interaction. `interactions` is the press log the timing checks
      // grade, and reaching a field no longer presses anything: pasting focuses
      // it and sends a keystroke. Recording it as a press made the harness
      // claim a press the page could never have seen, which is precisely what
      // the "every click was seen by the page" check is for.
      // An actual paste, clipboard and keystroke, not locator.fill.
      //
      // playwright titles each action with its argument, and fill's argument
      // here is twenty four words. The title is drawn at the frame's width, so
      // it ran edge to edge across the top for most of a second, clipped at
      // both ends and covering the wizard's step header. It also put the
      // a generated code in the video in plain text.
      //
      // A keystroke's title is the keystroke: `Press "Meta+V"`, a corner chip
      // that names no secret. Measured, all three: fill banded, press did not,
      // and typing a password fits the corner but still spells it out.
      //
      // Resolved to a real key rather than passing playwright's ControlOrMeta,
      // because the title is ON SCREEN. That spelling renders as
      // `Press "ControlOrMeta+V"`, which is a testing-library abstraction shown
      // to a viewer who is being told this is someone using the app.
      await page.evaluate(
        async text => navigator.clipboard.writeText(text),
        value,
      );
      // locator.press, not keyboard.press: it focuses the field as part of the
      // same action, which is what the removed click was for.
      await page.locator(tid(testId)).press(PASTE_KEY);
    },
    type: async (target, value, perKeyMs = 45) => {
      const { testId } = target;
      await settleBeforeField();
      // No interaction recorded, for the same reason as `fill` above:
      // pressSequentially focuses and types, and presses nothing.
      await timeline.span(
        { kind: 'type', target: testId, detail: `${value.length} chars` },
        async () =>
          // Focuses the field itself, so no separate click is needed.
          page
            .locator(tid(testId))
            .pressSequentially(value, { delay: perKeyMs }),
      );
    },
    awaitScreen: async (testId, timeout = 120_000) => {
      await timeline.span({ kind: 'enter', target: testId }, async () =>
        page.locator(tid(testId)).waitFor({ timeout }),
      );
      // How tall the app actually paints on this screen. The viewport is fixed
      // at launch, so any surplus shows as Chromium's grey backdrop rather than
      // page background, and knowing the real height is what lets it be cropped.
      const painted = await page.evaluate(
        () => document.documentElement.scrollHeight,
      );
      timeline.record({
        kind: 'note',
        target: testId,
        detail: `painted ${painted}px`,
      });
    },
    linger: async (ms, note) => {
      timeline.record({
        kind: 'wait',
        target: 'linger',
        durationMs: ms,
        detail: note,
      });
      // Just a wait. It used to tick, hovering the body every couple of
      // seconds, so that a post-render could tell a deliberate hold from a
      // long wait and decline to compress it. Nothing compresses anything now:
      // the recording is the take, and a hold occupies exactly the time it
      // asks for.
      //
      // The tick had to go rather than merely being redundant. Playwright
      // annotates a hover like any other action, so each tick outlined its
      // target, dotted it and titled it. The target was `body`, so every held
      // screen flashed blue end to end, and the closing hold on the result did
      // it four times.
      await page.waitForTimeout(ms);
    },
    revealBottom: async ({ testId }, settleMs = 1200) => {
      await timeline.span({ kind: 'scroll', target: testId }, async () => {
        await page.locator(tid(testId)).evaluate(element => {
          element.scrollIntoView({ behavior: 'smooth', block: 'end' });
        });
        // Long enough for the browser's smooth scroll to land and for the
        // viewer to register where it stopped, before anything is clicked.
        await page.waitForTimeout(settleMs);
      });
    },
    interactions: () => [...interactions],
    setClipboard: async value => {
      await page.evaluate(
        async text => navigator.clipboard.writeText(text),
        value,
      );
    },
    appears: async (testId, { timeout, required }) => {
      try {
        await page.locator(tid(testId)).waitFor({ timeout });
        return true;
      } catch (error) {
        if (required) throw error;
        return false;
      }
    },
    textOf: async testId => page.locator(tid(testId)).innerText(),
    count: async testId => page.locator(tid(testId)).count(),
  };
};
