/** One thing a fake was asked to do, and what it was asked with. */
export type Asked = { did: string; with: unknown[] };

/**
 * Wraps a fake so every call it receives is recorded, at every depth.
 *
 * Structural, not a convention. Recording IS the dispatch: the proxy is the only
 * path to the object, so a method cannot be added that escapes it, and nothing
 * has to remember to write it down.
 *
 * That matters because every gap found in these fakes so far was an argument
 * accepted and dropped. A route handler stored but never invoked, waitFor
 * options ignored, grantPermissions discarded, a timeout thrown away. Each hid a
 * real defect until some test happened to need that one field, and each was then
 * fixed by adding one more recorder by hand.
 *
 * Nested objects are wrapped too and reported by path, so `page.screencast.start`
 * arrives as `screencast.start`.
 */
/** Wraps anything worth wrapping, and passes everything else straight back. */
/**
 * Whether calling a member of this object needs the REAL object as `this`.
 *
 * Anything that is not a plain object or a function carries internal slots a
 * proxy cannot forward, so binding the proxy as `this` makes it throw.
 */
const hasOwnSlots = (target: object): boolean => {
  if (typeof target === 'function') return false;
  const proto = Object.getPrototypeOf(target) as object | null;
  return proto !== Object.prototype && proto !== null;
};

/**
 * The real object behind a proxy this module made.
 *
 * Needed because a method reached through a proxy is called with the PROXY as
 * `this`, and a built-in reads its internal slots off `this`. Without a way
 * back to the real object, `fake.seen.add(1)` is an incompatible receiver.
 */
const realOf = new WeakMap<object, object>();

const wrapped = (
  value: unknown,
  asked: Asked[],
  path: string,
  cache: WeakMap<object, unknown>,
): unknown => {
  if (value === null) return value;
  // Functions too. A function handed back from a call used to escape entirely,
  // because typeof it is not 'object', so every call made on it was invisible.
  if (typeof value !== 'object' && typeof value !== 'function') return value;
  // Arrays included. Copying them into a new array read the items but returned
  // a different array each time and threw every write away.
  return recording(value as object, asked, path, cache);
};

/** What a method should see as `this`: the real object when a proxy cannot be it. */
const selfFor = (thisArg: unknown): unknown => {
  if (typeof thisArg !== 'object' || thisArg === null) return thisArg;
  return hasOwnSlots(thisArg) ? (realOf.get(thisArg) ?? thisArg) : thisArg;
};

export const recording = <T extends object>(
  real: T,
  asked: Asked[],
  path = '',
  // Memoised, so reading the same member twice yields the same wrapper. Without
  // it every access minted a fresh proxy, so `fake.nested === fake.nested` was
  // false and anything keying a Set or Map on a fake changed meaning.
  cache: WeakMap<object, unknown> = new WeakMap(),
): T => {
  const existing = cache.get(real);
  if (existing) return existing as T;

  const proxy: T = new Proxy(real, {
    // The fake itself may BE a function. Without this trap, calling the proxy
    // directly went unrecorded.
    apply: (target, thisArg, args) => {
      asked.push({ did: path || 'call', with: args });
      const returned = Reflect.apply(
        target as unknown as (...a: unknown[]) => unknown,
        selfFor(thisArg),
        args,
      );
      // Under `name()`, never under `name`. A function handed back is worth
      // recording, but sharing the caller's name made one call that returned a
      // function count as two, in the assertion the ledger exists for.
      const from = `${path || 'call'}()`;
      return returned instanceof Promise
        ? returned.then(resolved => wrapped(resolved, asked, from, cache))
        : wrapped(returned, asked, from, cache);
    },
    // Reached because a function member is itself a proxy. It used to be a
    // fresh arrow, and `new` on an arrow is a TypeError, so this trap only ever
    // fired for a fake that WAS a constructor at the root.
    construct: (target, args) => {
      asked.push({ did: `${path}.new`, with: args });
      return wrapped(
        Reflect.construct(
          target as unknown as new (...a: unknown[]) => object,
          args,
        ),
        asked,
        `${path}()`,
        cache,
      ) as object;
    },
    // The other two ways to write. Without them a fake could be emptied or
    // redefined and the ledger would say nothing happened, which is the same
    // hole `set` was added to close.
    deleteProperty: (target, key) => {
      asked.push({
        did: `${path ? `${path}.` : ''}${String(key)} delete`,
        with: [],
      });
      return Reflect.deleteProperty(target, key);
    },
    defineProperty: (target, key, attributes) => {
      asked.push({
        did: `${path ? `${path}.` : ''}${String(key)} define`,
        with: [attributes],
      });
      return Reflect.defineProperty(target, key, attributes);
    },
    // Writes passed straight through and unrecorded. A fake whose state the
    // driver sets is a fake whose state nothing can assert on.
    set: (target, key, value) => {
      asked.push({
        did: `${path ? `${path}.` : ''}${String(key)} =`,
        with: [value],
      });
      return Reflect.set(target, key, value);
    },
    get: (target, key, receiver) => {
      // Receiver is the PROXY on a plain object, so a GETTER that reads
      // `this.other` is recorded like any other call. On anything with internal
      // slots it is the raw target, because a proxy has no slots to read.
      const value = Reflect.get(
        target,
        key,
        hasOwnSlots(target) ? target : receiver,
      ) as unknown;
      const name = path ? `${path}.${String(key)}` : String(key);
      // A proxy, not a fresh wrapper. One proxy serves the call, `new` and
      // identity at once, and a wrapper minted per read served none of them.
      return wrapped(value, asked, name, cache);
    },
  });

  cache.set(real, proxy);
  realOf.set(proxy, real);
  return proxy;
};

/**
 * Reading the ledger back, in the terms a test thinks in.
 *
 * Names match by SUFFIX, so a test asks for `screencast.start` and does not care
 * that the call arrived as `pages[0].screencast.start`. Recording everything
 * structurally makes paths positional, and a test that had to spell out
 * `pages[0]` would break the day the fake handed back its page differently.
 */
export type Ledger = {
  /** Everything, in order, for the rare assertion that wants the raw list. */
  all: Asked[];
  /** Whether the fake was ever asked to do this. */
  did: (name: string) => boolean;
  /** How many times, which is how a doubled call is caught. */
  count: (name: string) => number;
  /** What it was passed the first time. */
  argsOf: (name: string) => unknown[] | undefined;
  /** What it was passed every time. */
  everyArgsOf: (name: string) => unknown[][];
  /** Whether one thing happened before another, and BOTH happened. */
  didBefore: (first: string, second: string) => boolean;
};

const matches = (did: string, name: string) =>
  did === name || did.endsWith(`.${name}`);

export const ledgerOf = (asked: Asked[]): Ledger => {
  const indexOf = (name: string) =>
    asked.findIndex(entry => matches(entry.did, name));
  return {
    all: asked,
    did: name => indexOf(name) >= 0,
    count: name => asked.filter(entry => matches(entry.did, name)).length,
    argsOf: name => asked.find(entry => matches(entry.did, name))?.with,
    everyArgsOf: name =>
      asked.filter(entry => matches(entry.did, name)).map(entry => entry.with),
    // Both, deliberately. Comparing indexOf results lets a missing call read as
    // -1, which sorts before everything and passes an ordering assertion that
    // should have failed.
    didBefore: (first, second) => {
      const at = indexOf(first);
      const then = indexOf(second);
      return at >= 0 && then >= 0 && at < then;
    },
  };
};
