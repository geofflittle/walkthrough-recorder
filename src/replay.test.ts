import { describe, expect, it } from 'vitest';

import { trafficModeFor, recordedSubmit } from './replay';

/** How THIS app names its submit inside a recording. */
const SUBMIT = /v1\/orders/;

import type { RecordedTraffic } from './replay';

const entry = ({
  url = 'https://api.example.test/v1/orders',
  method = 'POST',
  status = 200,
  text = 'a'.repeat(64),
}) => ({ request: { url, method }, response: { status, content: { text } } });

const har = (entries: RecordedTraffic['log']['entries']): RecordedTraffic => ({
  log: { entries },
});

describe('recordedSubmit', () => {
  it('finds the submission a recorded run made', () => {
    expect(
      recordedSubmit(
        har([
          entry({ url: 'https://shop.test/v1/catalogue', method: 'GET' }),
          entry({}),
        ]),
        SUBMIT,
      ),
    ).toEqual({ status: 200, body: 'a'.repeat(64) });
  });

  it('ignores a submission that failed', () => {
    // A HAR recorded from a run whose submission was rejected would otherwise
    // teach the replay to reject too, and every replayed take would end on
    // 'failed'.
    expect(
      recordedSubmit(har([entry({ status: 400, text: 'nope' })]), SUBMIT),
    ).toBe(undefined);
  });

  it('ignores reads of the submit endpoint', () => {
    // Only the POST is the submission. A GET against a similar path is not.
    expect(recordedSubmit(har([entry({ method: 'GET' })]), SUBMIT)).toBe(
      undefined,
    );
  });

  it('is undefined when the recording has no submission at all', () => {
    // A HAR captured from a run that never got as far as submitting. The caller
    // has to be able to tell that apart, since replaying without it means the
    // take cannot reach its done screen.
    expect(
      recordedSubmit(
        har([entry({ url: 'https://shop.test/v1/catalogue', method: 'GET' })]),
        SUBMIT,
      ),
    ).toBe(undefined);
  });

  it('is undefined when the submission recorded no body', () => {
    // Every later lookup is keyed on the transaction id in that body, so an
    // empty one is useless and must not be served as if it were fine.
    // Built inline rather than through the helper, whose default text would
    // fill in the very thing this is checking for.
    expect(
      recordedSubmit(
        har([
          {
            request: { url: 'https://shop.test/v1/orders', method: 'POST' },
            response: { status: 200, content: {} },
          },
        ]),
        SUBMIT,
      ),
    ).toBe(undefined);
  });
});

describe('trafficModeFor', () => {
  const harPath = '/tmp/demo-traffic.har';

  it('is live when nothing was asked for', () => {
    // The default has to be the one that produces a real, verifiable take.
    expect(
      trafficModeFor({ replay: false, shouldRecordHar: false, harPath }),
    ).toEqual({ kind: 'live' });
  });

  it('records when asked, which only makes sense against the real backend', () => {
    expect(
      trafficModeFor({ replay: false, shouldRecordHar: true, harPath }),
    ).toEqual({ kind: 'record', path: harPath });
  });

  it('replays when asked', () => {
    expect(
      trafficModeFor({ replay: true, shouldRecordHar: false, harPath }),
    ).toEqual({ kind: 'replay', path: harPath });
  });

  it('prefers replay when both are asked for, so nothing is spent', () => {
    // Asking to record while replaying is a contradiction, and of the two
    // readings only one writes for real. Take the other.
    expect(
      trafficModeFor({ replay: true, shouldRecordHar: true, harPath }),
    ).toEqual({ kind: 'replay', path: harPath });
  });
});

describe('recordedSubmit for an app with a different backend', () => {
  const shopHar = (url: string, method = 'POST') => ({
    log: {
      entries: [
        {
          request: { url, method },
          response: { status: 200, content: { text: '{"orderId":"TS-4417"}' } },
        },
      ],
    },
  });

  it('finds the call the CALLER named, not one hardcoded endpoint', () => {
    // The seam. This matched `url.includes('tx/submit')`, so a shop could route
    // its own submit and still get nothing back: the route went on, the lookup
    // found no entry, and the request fell through to the real network.
    expect(
      recordedSubmit(shopHar('https://shop.test/api/orders'), /\/api\/orders$/),
    ).toEqual({ status: 200, body: '{"orderId":"TS-4417"}' });
  });

  it('ignores a recorded call the pattern does not name', () => {
    expect(
      recordedSubmit(shopHar('https://shop.test/api/basket'), /\/api\/orders$/),
    ).toBe(undefined);
  });

  it('still answers only a POST, whatever the pattern', () => {
    // A GET is a read, and reads replay by matching. Answering one here would
    // shadow the recording for a request it can serve properly.
    expect(
      recordedSubmit(
        shopHar('https://shop.test/api/orders', 'GET'),
        /\/api\/orders$/,
      ),
    ).toBe(undefined);
  });
});
