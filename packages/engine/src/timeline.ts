// The timeline: the piece's time as something you hold, not something that
// happens to you.
//
// Time is a frame position on a range [start, end] at a frame rate. A front
// end asks it, once per drawn frame, how far the simulation should step:
//
//   real time on   the step is the wall clock's (clamped), and the position
//                  moves by step × fps — a slow frame skips frame numbers, the
//                  piece keeps its speed.
//   real time off  the step is exactly one frame, 1 / fps, however long the
//                  frame took to draw — every frame is simulated and rendered,
//                  a slow renderer plays in slow motion and never drops one.
//                  What a render to disk needs.
//
// At the end of the range the position wraps to the start (loop) or the
// timeline pauses there. The caller is told of a wrap. What it means for the
// simulation is the piece's choice (`restartOnLoop`): off, the frame counter
// goes round and the particles carry on, as a running installation does; on,
// every pass through the range starts from nothing, as a render of it would —
// a particle simulation is integrated step by step, so "frame 0 again" can
// only honestly mean the simulation from the beginning again.
//
// No DOM, no three, no clock of its own: the caller brings the wall delta.

export type TimelineSettings = {
  /** Frames a second: the step when real time is off, and what frame numbers mean. */
  fps: number;
  /** The whole project, in frames: the range is chosen inside 0 … length. */
  length: number;
  /** First and last frame of the range, inclusive. */
  start: number;
  end: number;
  /** At the end: back to the start (true) or pause there (false). */
  loop: boolean;
  /** See the header. */
  realtime: boolean;
  /** On a loop's wrap, start the simulation over (true) or let it carry on (false). */
  restartOnLoop: boolean;
};

export const defaultTimelineSettings = (): TimelineSettings => ({
  fps: 60,
  length: 1200,
  start: 0,
  end: 1200,
  loop: true,
  realtime: true,
  restartOnLoop: false,
});

/** Settings a timeline can run on, whatever it was handed. */
export const sanitizeTimelineSettings = (raw?: Partial<TimelineSettings> | null): TimelineSettings => {
  const d = defaultTimelineSettings();
  const fps = Number.isFinite(raw?.fps) ? Math.min(240, Math.max(1, Math.round(raw!.fps!))) : d.fps;
  const lengthRaw = Number.isFinite(raw?.length) ? Math.round(raw!.length!) : d.length;
  const endAsked = Number.isFinite(raw?.end) ? Math.round(raw!.end!) : Number.isFinite(raw?.length) ? lengthRaw : d.end;
  // A piece saved before there was a length: long enough for its range.
  const length = Math.max(2, Number.isFinite(raw?.length) ? lengthRaw : Math.max(lengthRaw, endAsked));
  const start = Math.min(length - 1, Number.isFinite(raw?.start) ? Math.max(0, Math.round(raw!.start!)) : d.start);
  return {
    fps,
    length,
    start,
    end: Math.min(length, Math.max(start + 1, endAsked)),
    loop: raw?.loop ?? d.loop,
    realtime: raw?.realtime ?? d.realtime,
    restartOnLoop: raw?.restartOnLoop ?? d.restartOnLoop,
  };
};

/** What one drawn frame means for the simulation. */
export type TimelineStep = {
  /** Seconds the simulation advances this frame; 0 while paused. */
  delta: number;
  /** The position went round from the end to the start on this step. */
  wrapped: boolean;
};

/** The longest real-time step, seconds: a hidden tab comes back as one step, not a minute. */
const MAX_REALTIME_STEP = 0.1;

export type Timeline = {
  settings: () => TimelineSettings;
  /** Takes new settings; the position is kept inside the new range. */
  configure: (raw?: Partial<TimelineSettings> | null) => void;
  play: () => void;
  pause: () => void;
  /** Back to the start and paused. Returns true: the simulation starts over. */
  stop: () => true;
  /** Back to the start, playing state kept (a piece was loaded). */
  rewind: () => void;
  /** Puts the position on a frame of the range. Time only: the caller owns what the simulation does about it. */
  setPosition: (frame: number) => void;
  isPlaying: () => boolean;
  /** The position, fractional while real time is on. */
  position: () => number;
  /** The whole frame the position is in. */
  frame: () => number;
  /** Seconds since frame 0 (not since the range's start). */
  seconds: () => number;
  /** Once per drawn frame, with the wall clock's delta in seconds. */
  advance: (wallDelta: number) => TimelineStep;
};

export const createTimeline = (initial?: Partial<TimelineSettings> | null): Timeline => {
  let s = sanitizeTimelineSettings(initial);
  let position = s.start;
  let playing = true;

  const configure = (raw?: Partial<TimelineSettings> | null): void => {
    const next = sanitizeTimelineSettings(raw);
    // The same moment at a new frame rate is a different frame number.
    if (next.fps !== s.fps) position = (position / s.fps) * next.fps;
    s = next;
    position = Math.min(s.end, Math.max(s.start, position));
  };

  const advance = (wallDelta: number): TimelineStep => {
    if (!playing) return { delta: 0, wrapped: false };
    const delta = s.realtime ? Math.min(MAX_REALTIME_STEP, Math.max(0, wallDelta)) : 1 / s.fps;
    const next = position + delta * s.fps;
    if (next <= s.end) {
      position = next;
      return { delta, wrapped: false };
    }
    if (s.loop) {
      position = s.start;
      return { delta, wrapped: true };
    }
    // Hold on the last frame; the step that reaches it is still simulated.
    const reached = Math.max(0, (s.end - position) / s.fps);
    position = s.end;
    playing = false;
    return { delta: reached, wrapped: false };
  };

  return {
    settings: () => ({ ...s }),
    configure,
    play: () => {
      // Play on a timeline that ran out is play from the start.
      if (position >= s.end && !s.loop) position = s.start;
      playing = true;
    },
    pause: () => {
      playing = false;
    },
    stop: () => {
      position = s.start;
      playing = false;
      return true;
    },
    rewind: () => {
      position = s.start;
    },
    setPosition: (frame: number) => {
      position = Math.min(s.end, Math.max(s.start, frame));
    },
    isPlaying: () => playing,
    position: () => position,
    frame: () => Math.floor(position + 1e-6),
    seconds: () => position / s.fps,
    advance,
  };
};

/** `mm:ss:ff` for a frame at a frame rate — the timecode under a timeline. */
export const timecode = (frame: number, fps: number): string => {
  const whole = Math.max(0, Math.floor(frame + 1e-6));
  const rate = Math.max(1, Math.round(fps));
  const seconds = Math.floor(whole / rate);
  const pad = (v: number, n = 2) => String(v).padStart(n, '0');
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}:${pad(whole % rate, rate > 99 ? 3 : 2)}`;
};
