/** How the page reports its own scaling, straight from getComputedStyle. */
export type PageScaling = {
  rootZoom: string;
  bodyZoom: string;
  rootTransform: string;
  bodyTransform: string;
};

/** The values that mean "nothing is scaling this". */
const NEUTRAL = new Set([
  'none',
  '1',
  'normal',
  '',
  'matrix(1, 0, 0, 1, 0, 0)',
]);

/**
 * Anything scaling the page, named, or an empty list when nothing is.
 *
 * Recording a scaled page has to be refused rather than tolerated. Playwright
 * dispatches clicks through coordinates that account for a zoom or transform on
 * the root, and draws its cursor, highlight and action label through
 * coordinates that do not. So a scaled page yields a video where the wizard
 * behaves perfectly and every indicator points at the wrong control, drawn at
 * position times the scale. Measured at 0.68: a button centred at y 427 had its
 * cursor drawn at y 290, two rows above the thing being clicked.
 *
 * That is invisible to every other check here, because the run is correct. It
 * cost several rounds of hunting a timing bug that was really a drawing one.
 */
export const scalingFaults = (scaling: PageScaling): string[] =>
  Object.entries(scaling)
    .filter(([, value]) => !NEUTRAL.has(value))
    .map(([name, value]) => `${name}=${value}`);
