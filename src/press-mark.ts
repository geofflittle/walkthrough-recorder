import type { Installable } from './screen-log';

/**
 * A press, as the PAGE saw it: the real pointerdown, its coordinates, and the
 * testID of whatever was under it.
 */
export type Press = {
  /** The testID the event landed on, or '' if it hit nothing that carries one. */
  testId: string;
  atEpochMs: number;
  x: number;
  y: number;
};

/** What the page calls the moment a press happens. */
const CALLBACK = '__demoPress';

/**
 * How long the mark stays on screen after the press that drew it.
 *
 * Outlives the press deliberately, so the mark is still there when the app
 * reacts. It cannot land early no matter what this is set to, because it is
 * drawn BY the press.
 */
export const PRESS_MARK_MS = 420;

/**
 * The press mark, as source.
 *
 * Drawn by the page from the real pointerdown, rather than by the harness from
 * knowledge that a click API call is about to happen. That difference is the
 * whole point.
 *
 * playwright's own showActions annotates the CALL: it draws the decoration,
 * plays it for its full duration, and only then dispatches the input, so its
 * duration is a lead time and the mark always finishes before the app reacts.
 * Measured, the delay between "done scrolling" and "performing click action"
 * tracked the dial exactly (0.005s with no annotation, 0.306s at 300, 0.907s at
 * 900, 1.808s at 1800), and at 900 a viewer saw an indicator play and then, a
 * beat later, a button react. Two events for one click.
 *
 * Here there is one dispatch. The same pointerdown the button handles is the
 * one that draws the mark, so the mark cannot precede the input, cannot land on
 * the screen the click already replaced, and cannot sit somewhere the click did
 * not, because it reads the event's own coordinates and its own target.
 *
 * Passed as SOURCE for the same reason the screen observer is: tsx compiles a
 * function argument before playwright serialises it, and esbuild injects a
 * `__name` helper that does not exist in the page.
 */
export const pressMarkSource = (
  markMs: number = PRESS_MARK_MS,
  callback: string = CALLBACK,
): string => `(() => {
    // Installed at most once per document. addInitScript runs per document and
    // exposeBinding is separate, so nothing structurally stops this running
    // twice, and two listeners would draw two marks for one press, which is the
    // very defect the page-drawn mark exists to remove.
    if (window.__demoPressInstalled) return;
    window.__demoPressInstalled = true;

    // The listener goes on FIRST, before anything touches the DOM. An init
    // script runs before document.documentElement necessarily exists, and an
    // earlier version appended a stylesheet at the top, threw, and never
    // reached this line. The handler ran zero times while everything else
    // looked healthy, which is exactly how it went unnoticed.
    document.addEventListener(
      'pointerdown',
      function (event) {
        var report = window[${JSON.stringify(callback)}];
        var target = event.target;
        var carrier = target && target.closest
          ? target.closest('[data-testid]')
          : null;
        if (report)
          report({
            testId: carrier ? carrier.getAttribute('data-testid') || '' : '',
            atEpochMs: Date.now(),
            x: Math.round(event.clientX),
            y: Math.round(event.clientY),
          });

        var root = document.body || document.documentElement;
        if (!root) return;
        var marks = [];

        // Outlines the element the EVENT hit, read back from the event, not
        // from a selector resolved seconds earlier. An outline drawn from a
        // stale box is how a mark ends up beside the control it claims.
        if (carrier && carrier.getBoundingClientRect) {
          var box = carrier.getBoundingClientRect();
          var ring = document.createElement('div');
          ring.setAttribute('data-demo-mark', 'ring');
          ring.style.cssText = [
            'position:fixed',
            'left:' + (box.left - 3) + 'px',
            'top:' + (box.top - 3) + 'px',
            'width:' + (box.width + 6) + 'px',
            'height:' + (box.height + 6) + 'px',
            'border:2px solid rgba(255,0,64,.9)',
            'border-radius:10px',
            'pointer-events:none',
            'z-index:2147483646'
          ].join(';');
          root.appendChild(ring);
          marks.push(ring);
        }

        var dot = document.createElement('div');
        dot.setAttribute('data-demo-mark', 'dot');
        dot.style.cssText = [
          'position:fixed',
          'left:' + (event.clientX - 22) + 'px',
          'top:' + (event.clientY - 22) + 'px',
          'width:44px',
          'height:44px',
          'border-radius:50%',
          'background:rgba(255,0,64,.55)',
          'pointer-events:none',
          'z-index:2147483647'
        ].join(';');
        root.appendChild(dot);
        marks.push(dot);

        // The mark dies with its target, not only on a timer.
        //
        // A mark is fixed-position and appended to the body, so a re-render
        // that replaces the whole screen leaves it sitting there, describing a
        // control that is gone. Measured on a take: five screens arrived within
        // the mark's lifetime and it outlived every one of them. Tying it to
        // the element it marks means it cannot, whatever the timer says.
        var expiry = Date.now() + ${markMs};
        function sweep() {
          var gone = carrier && !carrier.isConnected;
          if (!gone && Date.now() < expiry) {
            requestAnimationFrame(sweep);
            return;
          }
          for (var i = 0; i < marks.length; i++) marks[i].remove();
        }
        requestAnimationFrame(sweep);
      },
      true,
    );
  })()`;

/**
 * Draws every press into the page, and reports it back out.
 *
 * Reporting is not decoration. The harness used to timestamp a press by noting
 * when it CALLED click, which is not when the press happened: playwright spends
 * time resolving, checking actionability and, with showActions on, deliberately
 * waiting. Now the timestamp comes from the page, off the same event, on the
 * same clock the screen log uses, so "was the press visible before the screen
 * changed" compares two things that were both observed rather than one observed
 * and one assumed.
 */
export const watchPresses = async (
  page: Installable,
  { markMs = PRESS_MARK_MS } = {},
): Promise<{ presses: () => Press[] }> => {
  const presses: Press[] = [];
  await page.exposeBinding(CALLBACK, (_source, press: Press) => {
    presses.push(press);
  });

  await page.addInitScript(pressMarkSource(markMs));

  return { presses: () => [...presses] };
};
