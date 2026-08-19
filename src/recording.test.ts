import { describe, expect, it } from 'vitest';

import { ledgerOf, recording } from './recording';

import type { Asked } from './recording';

describe('recording', () => {
  it('records a call nobody wrote a recorder for', () => {
    // The property that makes this structural rather than a convention: this
    // method was added to the fake and NOTHING in the recording code mentions
    // it. If someone finds a way around the wrapper, this test fails.
    const asked: Asked[] = [];
    const fake = recording({ somethingNobodyAnticipated: () => 'ok' }, asked);

    fake.somethingNobodyAnticipated();

    expect(ledgerOf(asked).did('somethingNobodyAnticipated')).toBe(true);
  });

  it('records what the call was passed', () => {
    const asked: Asked[] = [];
    const fake = recording(
      { grantPermissions: (_p: string[]) => undefined },
      asked,
    );

    fake.grantPermissions(['clipboard-read']);

    expect(ledgerOf(asked).argsOf('grantPermissions')).toEqual([
      ['clipboard-read'],
    ]);
  });

  it('reaches a nested fake, by path', () => {
    // page.screencast.start is where the recorder starts, and a nested object
    // would otherwise be the obvious way around the wrapper.
    const asked: Asked[] = [];
    const fake = recording(
      { screencast: { start: (_o: object) => undefined } },
      asked,
    );

    fake.screencast.start({ path: '/tmp/x.webm' });

    expect(ledgerOf(asked).argsOf('screencast.start')).toEqual([
      { path: '/tmp/x.webm' },
    ]);
  });

  it('still returns what the fake returns', () => {
    // Recording must not change behaviour, or the fake stops standing in for
    // the real thing and every test built on it is measuring the wrapper.
    const asked: Asked[] = [];
    const fake = recording({ count: () => 3 }, asked);

    expect(fake.count()).toBe(3);
  });

  it('keeps the order calls arrived in', () => {
    const asked: Asked[] = [];
    const fake = recording(
      { first: () => undefined, second: () => undefined },
      asked,
    );

    fake.second();
    fake.first();

    expect(ledgerOf(asked).didBefore('second', 'first')).toBe(true);
  });

  it('leaves values alone', () => {
    const asked: Asked[] = [];
    const fake = recording({ url: 'chrome-extension://abc/sw' }, asked);

    expect(fake.url).toBe('chrome-extension://abc/sw');
    expect(asked).toEqual([]);
  });
});

describe('reading the ledger back', () => {
  const asked: Asked[] = [];
  const fake = recording(
    {
      pages: () => [
        {
          goto: (_u: string) => undefined,
          screencast: { start: () => undefined },
        },
      ],
    },
    asked,
  );
  fake.pages()[0].goto('/one');
  fake.pages()[0].goto('/two');
  fake.pages()[0].screencast.start();

  it('finds a call by its method, not its position in the object graph', () => {
    // The whole point of matching by suffix. This arrived as
    // pages[0].screencast.start, and a test that had to spell that out would
    // break the day the fake handed back its page differently.
    expect(ledgerOf(asked).did('screencast.start')).toBe(true);
  });

  it('counts repeats, which is how a doubled call is caught', () => {
    expect(ledgerOf(asked).count('goto')).toBe(2);
  });

  it('gives every set of arguments, not just the first', () => {
    expect(ledgerOf(asked).everyArgsOf('goto')).toEqual([['/one'], ['/two']]);
  });

  it('answers ordering directly, rather than by comparing indexes', () => {
    expect(ledgerOf(asked).didBefore('goto', 'screencast.start')).toBe(true);
    expect(ledgerOf(asked).didBefore('screencast.start', 'goto')).toBe(false);
  });

  it('says no when one of the two never happened', () => {
    // Comparing indexOf results returns -1 for a missing call, which reads as
    // "before everything" and passes an ordering assertion vacuously.
    expect(ledgerOf(asked).didBefore('goto', 'neverCalled')).toBe(false);
    expect(ledgerOf(asked).didBefore('neverCalled', 'goto')).toBe(false);
  });

  it('records calls on a function it handed back', () => {
    // RED, demonstrated in three lines. `wrapped` returns any non-object
    // unchanged, and typeof aFunction is 'function', so a function returned
    // from a call escapes recording entirely, along with every call on it.
    const asked: Asked[] = [];
    const fake = recording({ makeHandler: () => (x: string) => x }, asked);

    fake.makeHandler()('BYPASS');

    expect(ledgerOf(asked).did('makeHandler')).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it('records a call on the fake itself when the fake is a function', () => {
    // RED. There is no apply trap, only get, so calling the proxy vanishes.
    const asked: Asked[] = [];
    const fake = recording(
      Object.assign((x: string) => x, { note: () => undefined }),
      asked,
    );

    fake('DIRECT');

    expect(asked).toHaveLength(1);
  });

  it("keeps a wrapped member's identity stable across reads", () => {
    // RED. Every access mints a fresh wrapper, so `toBe` against a member of
    // the fake fails and Set or Map keying on it changes meaning.
    const asked: Asked[] = [];
    const fake = recording({ nested: { go: () => undefined } }, asked);

    expect(fake.nested).toBe(fake.nested);
  });
});

describe('members that carry internal slots', () => {
  it('records a call on a built-in member without breaking it', () => {
    const asked: Asked[] = [];
    const real = {
      seen: new Set<string>(),
      at: new Date(0),
      matcher: /ab/,
      byName: new Map<string, number>(),
    };
    const fake = recording(real, asked);

    fake.seen.add('one');
    fake.byName.set('two', 2);

    expect(real.seen.has('one')).toBe(true);
    expect(real.byName.get('two')).toBe(2);
    expect(fake.at.getTime()).toBe(0);
    expect(fake.matcher.test('ab')).toBe(true);
    expect(ledgerOf(asked).did('seen.add')).toBe(true);
  });

  it('still records what a method of a plain object asks of itself', () => {
    const asked: Asked[] = [];
    const fake = recording(
      {
        inner: () => 'deep',
        outer(this: { inner: () => string }) {
          return this.inner();
        },
      },
      asked,
    );

    expect(fake.outer()).toBe('deep');
    expect(ledgerOf(asked).did('inner')).toBe(true);
  });
});

describe('members are proxies, not fresh wrappers', () => {
  it('lets a constructible member be constructed, and records it', () => {
    const asked: Asked[] = [];
    class Thing {
      constructor(public label: string) {}
      say() {
        return this.label;
      }
    }
    const fake = recording({ Thing }, asked);

    const made = new fake.Thing('one');

    expect(made.label).toBe('one');
    expect(ledgerOf(asked).did('Thing.new')).toBe(true);
  });

  it('records what is asked of something a constructible member built', () => {
    const asked: Asked[] = [];
    class Thing {
      say() {
        return 'said';
      }
    }
    const fake = recording({ Thing }, asked);

    expect(new fake.Thing().say()).toBe('said');
    expect(ledgerOf(asked).did('say')).toBe(true);
  });

  it('reads the same function member as the same value twice', () => {
    const asked: Asked[] = [];
    const fake = recording({ go: () => 'gone' }, asked);

    expect(fake.go).toBe(fake.go);
  });

  it('reads the same array member as the same value twice', () => {
    const asked: Asked[] = [];
    const fake = recording({ items: [1, 2] }, asked);

    expect(fake.items).toBe(fake.items);
  });

  it('lets a write through an array member reach the real array', () => {
    const asked: Asked[] = [];
    const real = { items: [] as number[] };
    const fake = recording(real, asked);

    fake.items.push(7);

    expect(real.items).toEqual([7]);
  });

  it('records what a getter asks of itself', () => {
    const asked: Asked[] = [];
    const fake = recording(
      {
        secret: () => 'hidden',
        get exposed(): string {
          return this.secret();
        },
      },
      asked,
    );

    expect(fake.exposed).toBe('hidden');
    expect(ledgerOf(asked).did('secret')).toBe(true);
  });

  it('does not count a call twice because it returned a function', () => {
    const asked: Asked[] = [];
    const fake = recording({ find: () => () => 'found' }, asked);

    fake.find()();

    expect(ledgerOf(asked).count('find')).toBe(1);
  });
});

describe('the other two ways to write', () => {
  it('records a delete', () => {
    const asked: Asked[] = [];
    const real: { gone?: number } = { gone: 1 };
    const fake = recording(real, asked);

    delete fake.gone;

    expect(real.gone).toBeUndefined();
    expect(ledgerOf(asked).did('gone delete')).toBe(true);
  });

  it('records a defineProperty', () => {
    const asked: Asked[] = [];
    const fake = recording({} as Record<string, unknown>, asked);

    Object.defineProperty(fake, 'added', { value: 1, configurable: true });

    expect(ledgerOf(asked).did('added define')).toBe(true);
  });
});
