/**
 * The colour source's levers move under live particles: updateConfig with a
 * new particleColorInstance recolours the particles already out, from their
 * birth positions, without rebuilding the system. CPU path; the source is a
 * two-texel image — red on the left, blue on the right — read through a
 * stubbed canvas.
 */
import * as THREE from 'three';
import { createParticleSystem } from '../js/effects/three-particles/three-particles.js';
import type { ParticleSystem } from '../js/effects/three-particles/types.js';

class FakeContext {
  drawImage(): void {}
  getImageData(_x: number, _y: number, w: number, h: number) {
    const data = new Uint8ClampedArray(w * h * 4);
    // Column 0 red, column 1 blue, opaque.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        data[o] = x === 0 ? 255 : 0;
        data[o + 2] = x === 0 ? 0 : 255;
        data[o + 3] = 255;
      }
    }
    return { data };
  }
}
class FakeCanvas {
  width = 0;
  height = 0;
  getContext(): FakeContext {
    return new FakeContext();
  }
}

beforeAll(() => {
  (globalThis as any).document = { createElement: () => new FakeCanvas() };
});
afterAll(() => {
  delete (globalThis as any).document;
});

const map = {
  image: { width: 2, height: 1 },
  userData: {},
} as unknown as THREE.Texture;

const colorInstance = (over: Record<string, unknown> = {}) => ({
  isActive: true,
  map,
  plane: 'XZ',
  area: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1 },
  wrap: 'ZERO',
  offset: { x: 0, y: 0, z: 0 },
  ...over,
});

/** A still, motionless system on a 2 × 2 rectangle in the XY plane (z = 0). */
const createSystem = (maxParticles = 64, rateOverTime = 4000) => {
  const startTime = 1000;
  const ps = createParticleSystem(
    {
      maxParticles,
      duration: 5,
      looping: true,
      startLifetime: 10,
      startSpeed: 0,
      emission: { rateOverTime },
      shape: { shape: 'RECTANGLE', rectangle: { scale: { x: 2, y: 2 } } },
      particleColorInstance: colorInstance(),
    } as any,
    startTime
  );
  const step = (t: number) =>
    ps.update({ now: startTime + t, delta: 0.016, elapsed: t / 1000 });
  return { ps, step };
};

const attrs = (ps: ParticleSystem) =>
  (ps.instance as THREE.Points).geometry.attributes as Record<
    string,
    THREE.BufferAttribute
  >;

const live = (ps: ParticleSystem): number[] => {
  const a = attrs(ps).isActive;
  const out: number[] = [];
  for (let i = 0; i < a.count; i++) if (a.getX(i)) out.push(i);
  return out;
};

const rgb = (ps: ParticleSystem, i: number): [number, number, number] => {
  const c = attrs(ps).color;
  return [c.getX(i), c.getY(i), c.getZ(i)];
};

const isRed = (c: number[]) => c[0] > 0.99 && c[1] < 0.01 && c[2] < 0.01;
const isBlue = (c: number[]) => c[0] < 0.01 && c[1] < 0.01 && c[2] > 0.99;
const isBlack = (c: number[]) => c[0] < 0.01 && c[1] < 0.01 && c[2] < 0.01;

describe('a lever on the colour source recolours the particles already out', () => {
  it('births read the texel under x; a new offset moves every live particle off the source', () => {
    const { ps, step } = createSystem();
    step(100);
    const idx = live(ps);
    expect(idx.length).toBeGreaterThan(20);
    const pos = attrs(ps).position;
    for (const i of idx) {
      const c = rgb(ps, i);
      expect(pos.getX(i) < 0 ? isRed(c) : isBlue(c)).toBe(true);
    }

    const before = idx.map((i) => [pos.getX(i), pos.getY(i), pos.getZ(i)]);
    ps.updateConfig({
      particleColorInstance: colorInstance({ offset: { x: 5, y: 0, z: 0 } }),
    } as any);

    // Same particles, same places, new colours: nothing was rebuilt.
    expect(live(ps)).toEqual(idx);
    idx.forEach((i, k) => {
      expect([pos.getX(i), pos.getY(i), pos.getZ(i)]).toEqual(before[k]);
      expect(isBlack(rgb(ps, i))).toBe(true);
    });
    ps.dispose();
  });

  it('STRETCH under the same offset runs the left texel over everything', () => {
    const { ps, step } = createSystem();
    step(100);
    const idx = live(ps);
    ps.updateConfig({
      particleColorInstance: colorInstance({
        offset: { x: 5, y: 0, z: 0 },
        wrap: 'STRETCH',
      }),
    } as any);
    for (const i of idx) expect(isRed(rgb(ps, i))).toBe(true);
    ps.dispose();
  });

  it('the look changes without a readback: a hue turn swaps red for blue', () => {
    const { ps, step } = createSystem();
    step(100);
    const idx = live(ps);
    const reds = idx.filter((i) => isRed(rgb(ps, i)));
    expect(reds.length).toBeGreaterThan(5);
    // 180° around the hue wheel: red becomes cyan, not blue — check the red
    // channel is gone and something else is lit.
    ps.updateConfig({
      particleColorInstance: colorInstance({
        colorTweak: { saturation: 1, contrast: 1, hue: 180 },
      }),
    } as any);
    for (const i of reds) {
      const c = rgb(ps, i);
      expect(c[0]).toBeLessThan(0.05);
      expect(c[1] + c[2]).toBeGreaterThan(0.2);
    }
    ps.dispose();
  });

  it('recolorParticles with nothing changed reports the count and changes no colour', () => {
    const { ps, step } = createSystem();
    step(100);
    const idx = live(ps);
    const before = idx.map((i) => rgb(ps, i));
    expect(ps.recolorParticles!()).toBe(idx.length);
    idx.forEach((i, k) => expect(rgb(ps, i)).toEqual(before[k]));
    ps.dispose();
  });

  it('a live tweak stays with its system: the next system is born untouched', () => {
    const a = createSystem();
    a.step(100);
    a.ps.updateConfig({
      particleColorInstance: colorInstance({
        colorTweak: { saturation: 1, contrast: 1, hue: 180 },
      }),
    } as any);
    a.ps.dispose();
    const b = createSystem();
    b.step(100);
    const idx = live(b.ps);
    const pos = attrs(b.ps).position;
    for (const i of idx) {
      const c = rgb(b.ps, i);
      expect(
        pos.getX(i) < -0.01 ? isRed(c) : pos.getX(i) > 0.01 ? isBlue(c) : true
      ).toBe(true);
    }
    b.ps.dispose();
  });

  it('a later birth uses the new settings too', () => {
    // A slow emitter, so the first step leaves room for births after the change.
    const { ps, step } = createSystem(200, 300);
    step(100);
    ps.updateConfig({
      particleColorInstance: colorInstance({
        offset: { x: 5, y: 0, z: 0 },
        wrap: 'STRETCH',
      }),
    } as any);
    const before = live(ps).length;
    step(200);
    const idx = live(ps);
    expect(idx.length).toBeGreaterThan(before);
    for (const i of idx) expect(isRed(rgb(ps, i))).toBe(true);
    ps.dispose();
  });
});
