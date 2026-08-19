import { describe, expect, it } from 'vitest';

import { staleProfiles } from './profiles';

import type { ProfileStore } from './profiles';

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;

const stale = (
  ages: Record<string, number>,
  current = '/profiles/current',
  keepHours = 6,
  notProfiles: string[] = [],
) => {
  const fake: ProfileStore = {
    list: () => Object.keys(ages),
    modifiedAtMs: path => NOW - (ages[path.split('/').pop() ?? ''] ?? 0) * HOUR,
    isProfile: path => !notProfiles.includes(path.split('/').pop() ?? ''),
  };
  return staleProfiles(current, { keepHours, now: () => NOW, store: fake });
};

describe('staleProfiles', () => {
  it('reports profiles older than the cutoff', () => {
    expect(stale({ old: 9, ancient: 40 })).toEqual([
      '/profiles/old',
      '/profiles/ancient',
    ]);
  });

  it('reports nothing rather than deleting anything', () => {
    // The whole point of the shape. This returns paths, and the person reading
    // them decides. A library cannot know that the profile it calls stale is
    // not the one holding the only copy of something.
    expect(stale({ old: 40 })).toEqual(['/profiles/old']);
  });

  it('leaves profiles inside the cutoff out of the report', () => {
    // A failed run keeps its profile on purpose, so anything it created stays
    // recoverable. Naming it hours later is fine, naming it minutes later
    // invites someone to remove a profile that is still needed.
    expect(stale({ recent: 1, alsoRecent: 5 })).toEqual([]);
  });

  it('never names the profile of the run asking, however old', () => {
    // A long take can outlive the cutoff while it is still being written to,
    // and a reader pasting the suggested command would break their own run.
    expect(stale({ current: 99, other: 99 })).toEqual(['/profiles/other']);
  });

  it('honours a caller who wants a different retention', () => {
    expect(stale({ old: 3 }, '/profiles/current', 2)).toEqual([
      '/profiles/old',
    ]);
  });

  it('names nothing rather than throwing when there is no root', () => {
    // First run on a machine. Housekeeping must never fail the take.
    const exploding: ProfileStore = {
      list: () => {
        throw new Error('ENOENT');
      },
      modifiedAtMs: () => 0,
      isProfile: () => true,
    };

    expect(staleProfiles('/nowhere/current', { store: exploding })).toEqual([]);
  });

  it('keeps what it found when the store fails partway', () => {
    // A directory that vanishes underneath the loop is not a reason to forget
    // the two already found.
    const flaky: ProfileStore = {
      list: () => ['a', 'b', 'c'],
      modifiedAtMs: path => {
        if (path.endsWith('c')) throw new Error('vanished');
        return 0;
      },
      isProfile: () => true,
    };

    expect(staleProfiles('/p/current', { store: flaky })).toEqual([
      '/p/a',
      '/p/b',
    ]);
  });

  it('names nothing that is not a browser profile', () => {
    // The root is inferred from the profile's parent, so an app that puts its
    // profile inside its own directory makes that directory the root. When this
    // deleted rather than reported, that cost an example its source file, its
    // extension and its last take.
    expect(
      stale(
        { 'record.ts': 40, extension: 40, 'shop.mp4': 40 },
        '/shop/.profile',
        6,
        ['record.ts', 'extension', 'shop.mp4'],
      ),
    ).toEqual([]);
  });

  it('still names the stale profiles beside them', () => {
    // The guard must not turn reporting off. A disk filled by 80MB profiles is
    // the problem this exists to surface.
    expect(
      stale({ 'record.ts': 40, 'demo-1234': 40 }, '/shop/.profile', 6, [
        'record.ts',
      ]),
    ).toEqual(['/shop/demo-1234']);
  });

  it('checks what a thing IS before checking how old it is', () => {
    // Ordering, because the age test is a stat on a path that may not be a
    // directory at all, and the answer is the same either way: not ours.
    expect(
      stale({ 'package.json': 999 }, '/app/.profile', 6, ['package.json']),
    ).toEqual([]);
  });
});
