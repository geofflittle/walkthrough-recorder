import { describe, expect, it } from 'vitest';

import { scalingFaults } from './scaling';

import type { PageScaling } from './scaling';

const UNSCALED: PageScaling = {
  rootZoom: '1',
  bodyZoom: '1',
  rootTransform: 'none',
  bodyTransform: 'none',
};

describe('scalingFaults', () => {
  it('finds nothing wrong with an unscaled page', () => {
    expect(scalingFaults(UNSCALED)).toEqual([]);
  });

  it('accepts an identity matrix, which is how some engines report none', () => {
    expect(
      scalingFaults({
        ...UNSCALED,
        rootTransform: 'matrix(1, 0, 0, 1, 0, 0)',
      }),
    ).toEqual([]);
  });

  it('catches the zoom that misdrew every indicator', () => {
    // The exact value the harness used. Playwright kept clicking correctly and
    // drawing the cursor at position times 0.68, which read as mis-clicks.
    expect(scalingFaults({ ...UNSCALED, rootZoom: '0.68' })).toEqual([
      'rootZoom=0.68',
    ]);
  });

  it('catches a scale applied through a transform rather than zoom', () => {
    // Same hazard, different property, so checking only zoom would miss it.
    expect(
      scalingFaults({
        ...UNSCALED,
        bodyTransform: 'matrix(0.8, 0, 0, 0.8, 0, 0)',
      }),
    ).toEqual(['bodyTransform=matrix(0.8, 0, 0, 0.8, 0, 0)']);
  });

  it('names every offender, so a fix is not whack-a-mole', () => {
    expect(
      scalingFaults({
        rootZoom: '0.68',
        bodyZoom: '0.9',
        rootTransform: 'scale(2)',
        bodyTransform: 'none',
      }),
    ).toHaveLength(3);
  });
});
