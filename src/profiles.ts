import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The slice of the filesystem this uses, so a test needs no disk.
 *
 * Reads only. Nothing here deletes anything: which files are worth keeping is
 * the person's call, and a library that guesses wrong takes something it cannot
 * give back. An earlier version inferred a root from the profile's parent and
 * removed everything stale in it, which deleted an example's source file, its
 * extension and its last take the first time a profile was put somewhere
 * ordinary.
 */
export type ProfileStore = {
  list: (directory: string) => string[];
  modifiedAtMs: (path: string) => number;
  /** Whether this path is a browser profile, as opposed to anything else. */
  isProfile: (path: string) => boolean;
};

export const realProfileStore: ProfileStore = {
  list: directory => readdirSync(directory),
  modifiedAtMs: path => statSync(path).mtimeMs,
  // Every chromium profile has a Default directory inside it, and nothing else
  // does. A name test would not do: an app is free to call its profile
  // anything, and this needs to be certain rather than likely.
  isProfile: path =>
    statSync(join(path, 'Default'), { throwIfNoEntry: false })?.isDirectory() ??
    false,
};

/**
 * Profiles left by earlier runs, oldest first.
 *
 * Reported rather than removed. A profile is around 80MB, so a day of iterating
 * fills a disk, and a full disk breaks playwright's own writes and surfaces as
 * failures that look like anything but a full disk. Naming them is enough for
 * someone to act on, and it cannot cost anyone a file they wanted.
 *
 * NEVER includes the profile of the run asking, whatever its age. A long take
 * can outlive the cutoff while it is still being written to.
 */
export const staleProfiles = (
  currentProfile: string,
  {
    keepHours = 6,
    now = Date.now,
    store = realProfileStore,
  }: { keepHours?: number; now?: () => number; store?: ProfileStore } = {},
): string[] => {
  const root = dirname(currentProfile);
  const cutoff = now() - keepHours * 60 * 60 * 1000;
  const stale: string[] = [];
  try {
    for (const entry of store.list(root)) {
      const path = `${root}/${entry}`;
      if (path === currentProfile) continue;
      if (!store.isProfile(path)) continue;
      if (store.modifiedAtMs(path) > cutoff) continue;
      stale.push(path);
    }
  } catch {
    // No profile root yet, or it is not readable. Nothing to report, and this
    // is housekeeping: failing the take over it would be worse than the
    // clutter.
    return stale;
  }
  return stale;
};
