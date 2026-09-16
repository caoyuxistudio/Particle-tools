import {
  MAX_TOUCH_SAMPLES,
  TOUCH_SAMPLE_STRIDE,
  TouchWakeState,
  applyTouchWakeCPU,
  defaultTouchWakeParams,
  wakeDisplacement,
} from '../touch-wake';

const params = {
  strength: 1,
  wake: 0.4,
  swirl: 0,
  normal: { x: 0, y: 1, z: 0 },
};
const sample = (over = {}) => ({
  x: 0,
  y: 0,
  z: 0,
  radius: 1,
  vx: 2,
  vy: 0,
  vz: 0,
  time: 0,
  ...over,
});

describe('touch wake displacement', () => {
  it('drags a particle at the finger along with it, scaled by the frame', () => {
    const out = wakeDisplacement(
      0,
      0,
      0,
      [sample()],
      1,
      0,
      0.5,
      params,
      [0, 0, 0]
    );
    expect(out[0]).toBeCloseTo(1, 9); // 2 units/s × 0.5 s
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('fades with distance as a gaussian of the radius', () => {
    const at = (d: number) =>
      wakeDisplacement(d, 0, 0, [sample()], 1, 0, 1, params, [0, 0, 0])[0];
    expect(at(1)).toBeCloseTo(2 * Math.exp(-1), 9);
    expect(at(3)).toBeLessThan(at(1));
    expect(at(5)).toBe(0); // below the cutoff
  });

  it('fades with age as an exponential of the wake constant', () => {
    const later = wakeDisplacement(
      0,
      0,
      0,
      [sample()],
      1,
      0.4,
      1,
      params,
      [0, 0, 0]
    )[0];
    expect(later).toBeCloseTo(2 * Math.exp(-1), 9);
  });

  it('a still finger does nothing', () => {
    const out = wakeDisplacement(
      0,
      0,
      0,
      [sample({ vx: 0 })],
      1,
      0,
      1,
      params,
      [0, 0, 0]
    );
    expect(out).toEqual([0, 0, 0]);
  });

  it('a sample without a radius does nothing', () => {
    const out = wakeDisplacement(
      0,
      0,
      0,
      [sample({ radius: 0 })],
      1,
      0,
      1,
      params,
      [0, 0, 0]
    );
    expect(out).toEqual([0, 0, 0]);
  });

  it('swirl turns about the path in the plane of the normal', () => {
    const swirl = { ...params, strength: 0, swirl: 1 };
    // A particle beside the finger (along +z, finger moving +x): the tangent
    // of a turn about the y axis lies along ±x, never along y.
    const out = wakeDisplacement(
      0,
      0,
      0.5,
      [sample()],
      1,
      0,
      1,
      swirl,
      [0, 0, 0]
    );
    expect(out[1]).toBe(0);
    expect(Math.abs(out[0])).toBeGreaterThan(0);
    // Mirrored across the path, the turn goes the other way.
    const other = wakeDisplacement(
      0,
      0,
      -0.5,
      [sample()],
      1,
      0,
      1,
      swirl,
      [0, 0, 0]
    );
    expect(Math.sign(other[0])).toBe(-Math.sign(out[0]));
  });

  it('samples add up', () => {
    const two = [sample(), sample({ vx: 0, vz: 3 })];
    const out = wakeDisplacement(0, 0, 0, two, 2, 0, 1, params, [0, 0, 0]);
    expect(out[0]).toBeCloseTo(2, 9);
    expect(out[2]).toBeCloseTo(3, 9);
  });

  it('applies to a position array and reports whether it moved', () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0]);
    expect(applyTouchWakeCPU(positions, 0, [sample()], 1, 0, 0.5, params)).toBe(
      true
    );
    expect(positions[0]).toBeCloseTo(1, 6);
    expect(applyTouchWakeCPU(positions, 3, [sample()], 1, 0, 0.5, params)).toBe(
      false
    );
    expect(positions[3]).toBe(10);
  });
});

describe('touch wake state', () => {
  it('keeps the most recent samples and packs them for the GPU', () => {
    const state = new TouchWakeState(0);
    for (let i = 0; i < MAX_TOUCH_SAMPLES + 3; i += 1) {
      state.push(sample({ x: i, time: i }));
    }
    expect(state.count).toBe(MAX_TOUCH_SAMPLES);
    expect(state.list[0].x).toBe(3);
    const data = state.encode();
    expect(data.length).toBe(MAX_TOUCH_SAMPLES * TOUCH_SAMPLE_STRIDE);
    expect(data[0]).toBe(3);
    expect(data[7]).toBe(3);
    expect(data[3]).toBe(1); // radius
  });

  it('prunes samples too old to matter', () => {
    const state = new TouchWakeState(0);
    state.push(sample({ time: 0 }));
    state.push(sample({ time: 5 }));
    state.prune(5, 0.4);
    expect(state.count).toBe(1);
    expect(state.list[0].time).toBe(5);
    state.clear();
    expect(state.count).toBe(0);
    expect(state.encode()[3]).toBe(0);
  });

  it('stamps a pushed sample with its own clock when no time is given', () => {
    const state = new TouchWakeState();
    state.push(sample({ time: undefined }));
    expect(state.list[0].time).toBeGreaterThanOrEqual(0);
    expect(state.list[0].time).toBeLessThan(1);
  });

  it('fills the params from a config, with defaults', () => {
    expect(defaultTouchWakeParams(undefined)).toEqual({
      strength: 1,
      wake: 0.4,
      swirl: 0.3,
      normal: { x: 0, y: 1, z: 0 },
      maxSpeed: 8,
    });
    expect(defaultTouchWakeParams({ wake: 0 }).wake).toBe(0.01);
  });
});
