import type { TakeCheck } from './assess';
import type { Press } from './press-mark';
import type { ScreenChange } from './screen-log';

/** An interaction, as the driver recorded it, on the same clock as a screen. */
export type Interaction = {
  target: string;
  /** When the target was painted and had stopped moving. */
  readyAtMs: number;
  /**
   * When the press happened.
   *
   * As the harness recorded it, which is when it CALLED click, not when the
   * input landed. See {@link asObserved}: the page reports the real
   * pointerdown, and every check below is better for comparing two observed
   * moments than one observed and one assumed.
   */
  clickedAtMs: number;
};

/**
 * Replaces each interaction's press time with the one the PAGE saw.
 *
 * The harness timestamps a press when it calls click, but playwright then
 * resolves the selector, checks actionability, scrolls, and computes a hit
 * target before any input is dispatched, so the recorded moment can precede
 * the real one by most of a second. Every timing check compares a press
 * against a screen change, and the screen change has always been observed in
 * the page, so this was the one side of the comparison still being guessed.
 *
 * Unmatched interactions are returned rather than dropped. A click the harness
 * believes it made and the page never saw is not a rounding error, it is the
 * defect this whole file exists to catch, and silently keeping the assumed
 * timestamp would hide it behind checks that then pass.
 */
export const asObserved = (
  interactions: Interaction[],
  presses: Press[],
): { observed: Interaction[]; unobserved: Interaction[] } => {
  const spent = new Set<number>();
  const observed: Interaction[] = [];
  const unobserved: Interaction[] = [];
  for (const interaction of interactions) {
    const index = presses.findIndex(
      (press, at) =>
        !spent.has(at) &&
        press.testId === interaction.target &&
        press.atEpochMs >= interaction.readyAtMs,
    );
    if (index === -1) {
      unobserved.push(interaction);
      continue;
    }
    spent.add(index);
    observed.push({ ...interaction, clickedAtMs: presses[index].atEpochMs });
  }
  return { observed, unobserved };
};

export type TimingIntent = {
  /**
   * Screens that legitimately arrive with nothing pressed since the last one,
   * such as the very first screen of a take.
   */
  arrivesUnprompted: string[];
  /**
   * How long a press has to be visible on its target before the screen is
   * allowed to change under it.
   */
  minPressVisibleMs: number;
  // No markMs. There used to be a check here that a press mark had finished
  // before the next screen arrived, computed from the mark's configured
  // lifetime, because playwright's annotation ran for a fixed duration whatever
  // the page did. The mark is drawn by the page now and removed the moment its
  // target leaves the DOM, so it cannot outlive the screen it was drawn on and
  // there is no arithmetic left to do. The property moved from a take-level
  // check to press-mark.ts, where it is enforced, and to press-mark.test.ts,
  // where "clears its marks as soon as the target leaves" covers it.
};

/** The first screen to arrive strictly after a moment. */
const nextScreenAfter = (
  screens: ScreenChange[],
  atMs: number,
): ScreenChange | undefined => screens.find(screen => screen.atEpochMs > atMs);

/**
 * Checks that each interaction reads as cause and then effect.
 *
 * This exists because "the click is drawn at the wrong time" was, for a long
 * time, only ever a thing someone SAW. The driver knew when it clicked, the
 * page now reports when the screen changed, and both are on the same clock, so
 * the complaint becomes arithmetic.
 *
 * Four things are checked, and each one has been wrong at least once:
 *
 * - every click the script made was SEEN by the page. A click the page never
 *   registered leaves the rest of these vacuously true.
 * - every screen was reached by clicking something, so nothing arrived on its
 *   own that the walkthrough was supposed to have caused.
 * - the target was still there when it was clicked, i.e. no screen arrived
 *   between the target settling and the click landing on it. When that fails,
 *   the click was aimed at something that had already gone.
 * - the press was visible on its target for a readable moment BEFORE the screen
 *   changed. This is the one the eye keeps catching: the app navigates within
 *   milliseconds of a click, so unless the press is held, the indicator and the
 *   new screen arrive together and the press appears to belong to the screen it
 *   caused rather than the one it acted on.
 *
 * A fifth used to live here, that the mark had finished before the next screen.
 * It is gone because the mark now dies with its target rather than on a timer,
 * so the case cannot arise. See TimingIntent.
 */
export const assessTiming = (
  recorded: Interaction[],
  screens: ScreenChange[],
  intent: TimingIntent,
  presses: Press[] = [],
): TakeCheck[] => {
  // Timed by the page wherever the page saw it. With no presses reported at
  // all, every interaction is unobserved and the check below says so loudly,
  // rather than the rest quietly grading assumed timestamps.
  const { observed, unobserved } = asObserved(recorded, presses);
  const interactions = observed;
  const stale = interactions.filter(interaction => {
    const arrived = nextScreenAfter(screens, interaction.readyAtMs);
    return arrived !== undefined && arrived.atEpochMs < interaction.clickedAtMs;
  });

  const changes = interactions.map(interaction => ({
    interaction,
    arrived: nextScreenAfter(screens, interaction.clickedAtMs),
  }));

  const rushed = changes.filter(
    ({ interaction, arrived }) =>
      arrived !== undefined &&
      arrived.atEpochMs - interaction.clickedAtMs < intent.minPressVisibleMs,
  );

  // A screen with no click behind it and no standing reason to appear on its
  // own. Playwright already guarantees the other direction, since click()
  // auto-waits and throws rather than clicking something absent, so every click
  // demonstrably landed on a real control. This is the converse, and it is the
  // one that can go wrong quietly: a page that moves without being driven.
  const unexplained = screens.filter((screen, index) => {
    if (intent.arrivesUnprompted.includes(screen.testId)) return false;
    // Attributed by ORDER, not by elapsed time. A window was tried first and
    // was simply wrong: that step arrives well over three seconds after the
    // click that causes it, because the app does slow work in between, and it
    // was reported as appearing out of nowhere. What actually makes a screen
    // explained is that something was pressed since the previous screen, however
    // long the app then took.
    const previous = screens[index - 1]?.atEpochMs ?? 0;
    return !interactions.some(
      interaction =>
        interaction.clickedAtMs > previous &&
        interaction.clickedAtMs <= screen.atEpochMs,
    );
  });

  return [
    {
      label: `every click was seen by the page${describe(
        unobserved.map(interaction => interaction.target),
      )}`,
      didPass: unobserved.length === 0,
    },
    {
      label: `every screen was reached by clicking something${describe(
        unexplained.map(screen => screen.testId),
      )}`,
      didPass: unexplained.length === 0,
    },
    {
      label: `every click landed on a target that was still there${describe(
        stale.map(interaction => interaction.target),
      )}`,
      didPass: stale.length === 0,
    },
    {
      label: `every press was visible for ${
        intent.minPressVisibleMs
      }ms before its screen changed${describe(
        rushed.map(({ interaction }) => interaction.target),
      )}`,
      didPass: rushed.length === 0,
    },
  ];
};

/** Names the offenders, so a failure says which interaction rather than how many. */
const describe = (targets: string[]): string =>
  targets.length === 0 ? '' : `: ${targets.join(', ')}`;
