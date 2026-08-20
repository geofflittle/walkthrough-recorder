import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { finishRun, recordTake, runFromTake } from '../../src/index';

import type { Step } from '../../src/index';

/**
 * The smallest complete example: a shop, recorded walking through itself.
 *
 * It exists to prove the recorder knows nothing about any particular app. There
 * is no backend here at all, and every app-specific
 * fact lives in the `app` object below rather than inside the recorder.
 */

/** The values this script refers to. Its own vocabulary, checked by the compiler. */
type ShopRef = 'discountCode' | 'orderNumber';

const SHOP: Step<ShopRef>[] = [
  { do: 'click', target: 'shop-cart-primary' },
  { do: 'awaitScreen', target: 'shop-pay-step' },
  // Read off the page mid-run, exactly like a generated confirmation code or any
  // other value a script cannot know in advance.
  {
    do: 'capture',
    as: 'orderNumber',
    wordTemplate: 'shop-order-{index}',
    count: 1,
  },
  { do: 'type', target: 'shop-code-value', value: 'discountCode' },
  // On and then off again, which is how you show what an option DOES without
  // leaving it set. The mark is drawn by the page from the real press, so it is
  // still on the control when the note appears underneath it.
  { do: 'click', target: 'shop-gift-toggle' },
  { do: 'click', target: 'shop-gift-toggle' },
  { do: 'click', target: 'shop-pay-primary' },
];

const main = async () => {
  const here = resolve(__dirname);
  rmSync(`${here}/.profile`, { recursive: true, force: true });

  const result = await recordTake({
    script: SHOP,
    bindings: { discountCode: 'SAVE10' },
    // Short. The closing rest was longer than the whole walkthrough before it,
    // which reads as a screenshot rather than a demo.
    finishHoldMs: 800,
    app: {
      extensionPath: `${here}/extension`,
      viewport: { width: 620, height: 760 },
      screenPattern: /^shop-(cart|pay)-step$|^shop-checkout-ok$/,
      // The first screen arrives without anything being pressed, so the
      // "every screen was reached by clicking something" check exempts it.
      arrivesUnprompted: ['shop-cart-step'],
      // No backend, so nothing is ever routed. An app with one names its calls
      // here and can then replay them from a HAR.
      providerUrls: '**/*this-shop-has-no-backend*/**',
      submitPattern: /\/api\/orders$/,
      // Best outcome first: the derivation takes the first that matched and
      // falls back to the last, so an unreadable run counts as abandoned.
      terminalScreens: [
        { name: 'checkout-done', testId: 'shop-checkout-ok' },
        { name: 'abandoned', testId: 'shop-cart-step' },
      ],
      entryPath: 'shop.html',
      readyTestId: 'shop-cart-primary',
      // Stated, because the library now requires it. This take is eight
      // seconds, and it used to inherit a default meant for another app's long run.
      plausibleSeconds: { least: 5, most: 60 },
      mustLearn: [
        { ref: 'orderNumber', whyItMatters: 'it is the only receipt' },
      ],
    },
    profileDir: `${here}/.profile`,
    // Where the raw recording is written, and where the finished mp4 goes.
    // recordTake grades the second one, so the checks below describe the file
    // anyone would actually open.
    videoPath: `${here}/shop.mp4`,
  });

  console.log(`ended on:  ${result.terminalState}`);
  // KEYS only. `learned` is whatever the script read off the page, and for a
  // app, the only copy of what the run just produced. Dumping the whole
  // bag to stdout is a habit an example should not teach.
  console.log(`learned:   ${Object.keys(result.learned).join(', ')}`);
  console.log(`transcript:${result.timelinePath ?? ' none'}`);

  // The checks are the half that makes this more than a screen recorder. A
  // failing take should fail the command, not merely mention it.
  // The library's, not a hand-rolled copy. Every consumer needs to turn an
  // outcome into an exit code, and two hand-written versions of that rule
  // already disagreed about a run whose teardown returned nothing.
  // finishRun, not reportRun plus a loop. Writing that loop by hand is how one
  // path came to print its successes and silently drop every failure.
  finishRun(runFromTake(result), { videoPath: `${here}/shop.mp4` });
};

void main();
