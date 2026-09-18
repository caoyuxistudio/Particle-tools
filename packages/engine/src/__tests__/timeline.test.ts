import { createTimeline, defaultTimelineSettings, sanitizeTimelineSettings, timecode } from '../timeline';

describe('timeline', () => {
  it('starts playing at the start of a 1200-frame project at 60 fps, the range the whole of it', () => {
    const t = createTimeline();
    expect(t.settings()).toEqual(defaultTimelineSettings());
    expect(t.isPlaying()).toBe(true);
    expect(t.frame()).toBe(0);
  });

  it('real time: the step is the wall clock, clamped, and frames may be skipped', () => {
    const t = createTimeline({ fps: 60, start: 0, end: 600 });
    expect(t.advance(1 / 60).delta).toBeCloseTo(1 / 60, 9);
    expect(t.frame()).toBe(1);
    // A slow frame: three frame numbers go by at once.
    expect(t.advance(3 / 60).delta).toBeCloseTo(3 / 60, 9);
    expect(t.frame()).toBe(4);
    // A hidden tab comes back as one bounded step.
    expect(t.advance(30).delta).toBe(0.1);
    expect(t.frame()).toBe(10);
  });

  it('real time off: exactly one frame a draw, however long the draw took', () => {
    const t = createTimeline({ fps: 30, start: 0, end: 300, realtime: false });
    for (const wall of [0.001, 0.5, 2, 0.016]) {
      const before = t.frame();
      expect(t.advance(wall).delta).toBeCloseTo(1 / 30, 9);
      expect(t.frame()).toBe(before + 1);
    }
  });

  it('paused, nothing moves', () => {
    const t = createTimeline();
    t.pause();
    expect(t.advance(1)).toEqual({ delta: 0, wrapped: false });
    expect(t.frame()).toBe(0);
    t.play();
    expect(t.advance(1 / 60).delta).toBeGreaterThan(0);
  });

  it('stop goes back to the start, paused, and asks for a restart', () => {
    const t = createTimeline({ start: 20, end: 200, realtime: false });
    for (let i = 0; i < 50; i++) t.advance(0);
    expect(t.frame()).toBe(70);
    expect(t.stop()).toBe(true);
    expect(t.frame()).toBe(20);
    expect(t.isPlaying()).toBe(false);
  });

  it('loops: the end wraps to the start, and the step says so', () => {
    const t = createTimeline({ start: 10, end: 13, realtime: false, loop: true });
    const seen: number[] = [];
    let wraps = 0;
    for (let i = 0; i < 8; i++) {
      if (t.advance(0).wrapped) wraps += 1;
      seen.push(t.frame());
    }
    expect(seen).toEqual([11, 12, 13, 10, 11, 12, 13, 10]);
    expect(wraps).toBe(2);
  });

  it('without loop it holds on the last frame, and play starts over', () => {
    const t = createTimeline({ start: 0, end: 3, realtime: false, loop: false });
    for (let i = 0; i < 6; i++) t.advance(0);
    expect(t.frame()).toBe(3);
    expect(t.isPlaying()).toBe(false);
    t.play();
    expect(t.frame()).toBe(0);
  });

  it('a new frame rate keeps the moment, not the number', () => {
    const t = createTimeline({ fps: 60, start: 0, end: 600, realtime: false });
    for (let i = 0; i < 120; i++) t.advance(0);
    expect(t.seconds()).toBeCloseTo(2, 9);
    t.configure({ fps: 30, start: 0, end: 300, realtime: false });
    expect(t.frame()).toBe(60);
    expect(t.seconds()).toBeCloseTo(2, 9);
  });

  it('keeps the position inside a range that moved', () => {
    const t = createTimeline({ start: 0, end: 600, realtime: false });
    for (let i = 0; i < 300; i++) t.advance(0);
    t.configure({ start: 0, end: 100 });
    expect(t.frame()).toBe(100);
    t.configure({ start: 400, end: 500 });
    expect(t.frame()).toBe(400);
  });

  it('makes sense of whatever settings it is handed', () => {
    expect(sanitizeTimelineSettings({ fps: 0, start: -5, end: -9 })).toMatchObject({ fps: 1, start: 0, end: 1 });
    expect(sanitizeTimelineSettings({ fps: 29.97 }).fps).toBe(30);
    expect(sanitizeTimelineSettings(null)).toEqual(defaultTimelineSettings());
    expect(sanitizeTimelineSettings({ start: 50, end: 10 }).end).toBe(51);
  });

  it('keeps the range inside the project length', () => {
    expect(sanitizeTimelineSettings({ length: 9000, start: 100, end: 8000 })).toMatchObject({ length: 9000, start: 100, end: 8000 });
    expect(sanitizeTimelineSettings({ length: 300, start: 0, end: 900 }).end).toBe(300);
    expect(sanitizeTimelineSettings({ length: 300, start: 500, end: 900 })).toMatchObject({ start: 299, end: 300 });
    // A length alone: the range is the whole of it. A piece from before length existed: long enough for its range.
    expect(sanitizeTimelineSettings({ length: 9000 })).toMatchObject({ start: 0, end: 9000 });
    expect(sanitizeTimelineSettings({ start: 0, end: 5000 }).length).toBe(5000);
  });

  it('setPosition moves time inside the range and nowhere else', () => {
    const t = createTimeline({ length: 1200, start: 100, end: 500, realtime: false });
    t.setPosition(300);
    expect(t.frame()).toBe(300);
    t.setPosition(5);
    expect(t.frame()).toBe(100);
    t.setPosition(9999);
    expect(t.frame()).toBe(500);
  });

  it('writes timecode as mm:ss:ff at the frame rate', () => {
    expect(timecode(0, 60)).toBe('00:00:00');
    expect(timecode(59, 60)).toBe('00:00:59');
    expect(timecode(60, 60)).toBe('00:01:00');
    expect(timecode(3725, 60)).toBe('01:02:05');
    expect(timecode(45, 30)).toBe('00:01:15');
  });
});
