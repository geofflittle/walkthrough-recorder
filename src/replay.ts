/** The shape of a HAR, to the depth this needs it. */
export type RecordedTraffic = {
  log: {
    entries: {
      request: { url: string; method: string };
      response: { status: number; content: { text?: string } };
    }[];
  };
};

export type RecordedResponse = { status: number; body: string };

/**
 * The response a recorded run got when it submitted.
 *
 * Needed because a replayed take cannot simply serve the submission back the
 * way it serves the reads. An app that builds a FRESH payload every run never
 * matches the recorded request body, so the recording is skipped and the
 * request falls through to the real network. A replay can only ever replay
 * reads.
 *
 * Answering with the recorded response is also what keeps the rest consistent.
 * Whatever the app does next is keyed on the id in that response, so a made-up
 * id would find nothing in the recording and the take would stall
 * waiting for a confirmation that never comes.
 */
export const recordedSubmit = (
  har: RecordedTraffic,
  /**
   * Which POST is the one that cannot be replayed by matching.
   *
   * Supplied by the caller. This was `url.includes('tx/submit')`, one app's
   * endpoint inside the generic replay, so a second app could route its own
   * submit and still get nothing back: the route was installed, the lookup
   * found no entry, and the request fell through to the network.
   */
  submitPattern: RegExp,
): RecordedResponse | undefined => {
  const entry = har.log.entries.find(
    candidate =>
      candidate.request.method === 'POST' &&
      submitPattern.test(candidate.request.url) &&
      candidate.response.status >= 200 &&
      candidate.response.status < 300,
  );
  if (!entry?.response.content.text) return undefined;
  return { status: entry.response.status, body: entry.response.content.text };
};

/** How a run treats the backend: live, capturing it, or serving it back. */
export type TrafficMode =
  | { kind: 'live' }
  | { kind: 'record'; path: string }
  | { kind: 'replay'; path: string };

/**
 * Decides whether a run touches the backend, and how.
 *
 * Pulled out and made pure because it is the most consequential branch in the
 * harness and the easiest to get silently wrong. A run that believes it is
 * replaying but is not will write to the real backend. A run that
 * believes it is recording but is replaying will capture nothing and leave the
 * fixture stale without saying so. Neither failure announces itself at the time.
 *
 * Replay wins when both are asked for, rather than the two being treated as a
 * contradiction to throw on. Recording is only ever useful against a live
 * backend, so if someone asks for both, the safe reading of their intent is the
 * one that spends nothing.
 */
export const trafficModeFor = ({
  replay,
  shouldRecordHar,
  harPath,
}: {
  replay: boolean;
  shouldRecordHar: boolean;
  harPath: string;
}): TrafficMode => {
  if (replay) return { kind: 'replay', path: harPath };
  if (shouldRecordHar) return { kind: 'record', path: harPath };
  return { kind: 'live' };
};
