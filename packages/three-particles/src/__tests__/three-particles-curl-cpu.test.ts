import * as THREE from 'three';
import { createParticleSystem } from '../js/effects/three-particles/three-particles.js';
import type { ParticleSystem } from '../js/effects/three-particles/types.js';

/**
 * Curl noise on the CPU backend (the one the TRAIL renderer and the WebGL
 * fallback run on): neighbours must flow together, as they do on the GPU.
 */
const positions = (ps: ParticleSystem): Float32Array =>
  (ps.instance as THREE.Points).geometry.attributes.position
    .array as Float32Array;

const activeIndices = (ps: ParticleSystem): number[] => {
  const attr = (ps.instance as THREE.Points).geometry.attributes.isActive;
  const out: number[] = [];
  for (let i = 0; i < attr.count; i++) if (attr.getX(i)) out.push(i);
  return out;
};

const createSystem = (noise: Record<string, unknown>) => {
  const startTime = 1000;
  const ps = createParticleSystem(
    {
      maxParticles: 40,
      duration: 5,
      looping: true,
      startLifetime: 10,
      startSpeed: 0,
      emission: { rateOverTime: 4000 },
      // A small box, so the particles are close neighbours in the field.
      shape: { shape: 'BOX', box: { scale: { x: 0.2, y: 0.2, z: 0.2 } } },
      noise: {
        isActive: true,
        strength: 1,
        frequency: 0.5,
        positionAmount: 1,
        ...noise,
      },
    } as any,
    startTime
  );
  const step = (t: number) =>
    ps.update({ now: startTime + t, delta: 0.016, elapsed: t / 1000 });
  return { ps, step };
};

/** Mean cosine between every particle's displacement and the group's mean. */
const coherence = (
  before: Float32Array,
  after: Float32Array,
  idx: number[]
) => {
  const d = idx.map((i) => [
    after[i * 3] - before[i * 3],
    after[i * 3 + 1] - before[i * 3 + 1],
    after[i * 3 + 2] - before[i * 3 + 2],
  ]);
  const mean = d
    .reduce((m, v) => [m[0] + v[0], m[1] + v[1], m[2] + v[2]], [0, 0, 0])
    .map((v) => v / d.length);
  const ml = Math.hypot(...mean);
  let cos = 0;
  let moved = 0;
  for (const v of d) {
    const l = Math.hypot(...v);
    if (l > 1e-9) {
      moved++;
      cos += (v[0] * mean[0] + v[1] * mean[1] + v[2] * mean[2]) / (l * ml);
    }
  }
  return { cos: cos / Math.max(moved, 1), moved, meanLength: ml };
};

describe('curl noise on the CPU backend', () => {
  it('moves neighbouring particles along the same flow', () => {
    const { ps, step } = createSystem({ curl: true });
    step(16);
    const idx = activeIndices(ps);
    expect(idx.length).toBeGreaterThan(20);
    const before = Float32Array.from(positions(ps));
    for (let t = 32; t <= 320; t += 16) step(t);
    const { cos, moved, meanLength } = coherence(before, positions(ps), idx);
    expect(moved).toBe(idx.length);
    expect(meanLength).toBeGreaterThan(0.005);
    expect(cos).toBeGreaterThan(0.9);
    ps.dispose();
  });

  it('the legacy noise does not — each particle wanders on its own', () => {
    const { ps, step } = createSystem({ curl: false, useRandomOffset: true });
    step(16);
    const idx = activeIndices(ps);
    const before = Float32Array.from(positions(ps));
    for (let t = 32; t <= 320; t += 16) step(t);
    const { cos } = coherence(before, positions(ps), idx);
    expect(cos).toBeLessThan(0.7);
    ps.dispose();
  });

  it('is scaled by delta, so a stalled clock moves nothing', () => {
    const { ps, step } = createSystem({ curl: true });
    step(16);
    const before = Float32Array.from(positions(ps));
    ps.update({ now: 1032, delta: 0, elapsed: 0.032 });
    expect(Array.from(positions(ps))).toEqual(Array.from(before));
    ps.dispose();
  });

  it('pushes only one way along an axis set to POSITIVE or NEGATIVE', () => {
    // A wide box: across it the field's y component takes both signs.
    const run = (direction?: Record<string, string>) => {
      const startTime = 1000;
      const ps = createParticleSystem(
        {
          maxParticles: 200,
          duration: 5,
          looping: true,
          startLifetime: 10,
          startSpeed: 0,
          emission: { rateOverTime: 40000 },
          shape: { shape: 'BOX', box: { scale: { x: 12, y: 12, z: 12 } } },
          noise: {
            isActive: true,
            curl: true,
            strength: 1,
            frequency: 0.5,
            positionAmount: 1,
            drift: { x: 0, y: 0, z: 0 },
            ...(direction ? { direction } : {}),
          },
        } as any,
        startTime
      );
      const step = (t: number) =>
        ps.update({ now: startTime + t, delta: 0.016, elapsed: t / 1000 });
      step(16);
      const idx = activeIndices(ps);
      const before = Float32Array.from(positions(ps));
      step(32);
      const after = positions(ps);
      const dy = idx.map((i) => after[i * 3 + 1] - before[i * 3 + 1]);
      const dx = idx.map((i) => after[i * 3] - before[i * 3]);
      ps.dispose();
      return { dy, dx };
    };

    const both = run();
    expect(both.dy.some((v) => v > 1e-7)).toBe(true);
    expect(both.dy.some((v) => v < -1e-7)).toBe(true);

    const up = run({ y: 'POSITIVE' });
    expect(up.dy.length).toBeGreaterThan(100);
    expect(up.dy.every((v) => v >= 0)).toBe(true);
    expect(up.dy.some((v) => v > 1e-7)).toBe(true);
    // The other axes keep both signs.
    expect(up.dx.some((v) => v > 1e-7)).toBe(true);
    expect(up.dx.some((v) => v < -1e-7)).toBe(true);

    const down = run({ y: 'NEGATIVE' });
    expect(down.dy.every((v) => v <= 0)).toBe(true);
    expect(down.dy.some((v) => v < -1e-7)).toBe(true);
  });
});
