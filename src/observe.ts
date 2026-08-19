import type { Locator, Page } from 'playwright';

/**
 * An element you can look at but not touch.
 *
 * A full Locator carries click, fill, hover and the rest, so handing one out
 * hands out the ability to interact off the record. These are everything the
 * driver needs in order to observe, and none of them changes anything.
 */
export type ReadOnlyElement = Pick<
  Locator,
  'boundingBox' | 'count' | 'innerText' | 'waitFor'
>;

/**
 * The page, minus the ability to interact with it.
 *
 * The driver has to watch for things the walkthrough does not do: which
 * terminal screen the wizard reached, what it said, whether the entry tile
 * exists yet. All of that is observation. Every INTERACTION belongs to the
 * Actor, which records as it acts.
 *
 * Holding a raw Page alongside an Actor made that a matter of discipline, and
 * the click that once went unrecorded was written exactly that way: the video
 * showed two presses and the transcript admitted one, and the only thing that
 * could have caught it was somebody reading the code. A PageView cannot express
 * an interaction, so the rule belongs to the compiler now.
 */
export type PageView = {
  /** Observe an element by testID. Read-only by construction. */
  find: (testId: string) => ReadOnlyElement;
  /**
   * Whichever of these turns up first, for deciding which terminal screen the
   * wizard reached.
   */
  findAny: (testIds: string[]) => ReadOnlyElement;
  /** Everything the page currently says, for reporting a failure. */
  text: () => Promise<string>;
};

const tid = (name: string) => `[data-testid="${name}"]`;

export const viewOf = (page: Page): PageView => ({
  find: testId => page.locator(tid(testId)),
  findAny: testIds =>
    testIds
      .map(testId => page.locator(tid(testId)))
      .reduce((locator, next) => locator.or(next))
      .first(),
  text: async () =>
    (await page.locator('body').innerText()).replace(/\n+/g, ' | '),
});
