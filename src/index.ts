/**
 * Everything an app needs to record itself walking through its own UI.
 *
 * The recorder knows nothing about any particular app: what to drive, what its
 * screens are called, what it ends on and what its script refers to are all
 * supplied by the caller. See examples/shop for the smallest complete one.
 */
export { recordTake, runWalkthrough } from './session';
export { finishRun, reportRun, runFromTake } from './reportable';
export type { FinishedRun, RunReport } from './reportable';
export { runSession } from './run';
export type {
  RecordedTake,
  SessionIntent,
  SessionOutcome,
  SessionSteps,
} from './run';
export { ffmpegScreenRecorder, noRecorder } from './recorder';
export type { Recorder } from './recorder';
export { recordWalkthrough, realLaunch, terminalStateFrom } from './drive';
export { makeFootage } from './footage';
export type { Footage } from './footage';
export { staleProfiles, realProfileStore } from './profiles';
export type { ProfileStore } from './profiles';
export type {
  DriveResult,
  Launch,
  RecordOptions,
  TerminalScreen,
} from './drive';

export type { Step } from './script';
export { performWalkthrough, performerFor } from './perform';
export type { Bindings, Performer } from './perform';

export { makeActor } from './actor';
export type { Actor, Present } from './actor';

export { finishTake } from './take';
export { assessTake, failedChecks } from './assess';
export type { TakeCheck, TakeFacts, TakeIntent } from './assess';
export { assessTiming, asObserved } from './timing';
export type { Interaction, TimingIntent } from './timing';
export {
  allowedPresses,
  assessPresses,
  assessSequence,
  expectedFrom,
  firstDivergence,
  targetsOf,
} from './sequence';

export { makeTimeline } from './timeline';
export type { Timeline, TimelineEvent } from './timeline';

export { watchScreens } from './screen-log';
export type { Installable, ScreenChange, ScreenPattern } from './screen-log';
export { watchPresses, PRESS_MARK_MS } from './press-mark';
export type { Press } from './press-mark';

export { contactSheets } from './contact-sheet';
export { appendTake, takeRecord, realHost } from './record';
export { compareTakes, readTakes } from './history';
export { trafficModeFor, recordedSubmit } from './replay';
export type { TrafficMode, RecordedTraffic } from './replay';
export { realShell } from './shell';
export type { Shell } from './shell';
