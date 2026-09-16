import {
  snoise3,
  cnoise3,
  curlNoise,
  CURL_EPS,
  PERLIN_GAIN,
} from '../curl-noise';

describe('curl noise on the CPU', () => {
  it('simplex noise is deterministic, bounded and not flat', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const x = Math.sin(i * 12.9898) * 43.5;
      const y = Math.sin(i * 78.233) * 43.5;
      const z = Math.sin(i * 37.719) * 43.5;
      const v = snoise3(x, y, z);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(snoise3(x, y, z));
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThan(-1.05);
    expect(max).toBeLessThan(1.05);
    // This gradient set (the TSL port's) peaks near ±0.37, not ±1.
    expect(max - min).toBeGreaterThan(0.5);
  });

  it('is continuous: a tiny step moves the value a tiny amount', () => {
    // Off the lattice: at an exact three-way tie of the skewed fractions the
    // simplex pick degenerates (a measure-zero case the GPU shares).
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37 - 30.123;
      const y = i * 0.11 + 4.071;
      const z = -i * 0.23 + 0.317;
      const a = snoise3(x, y, z);
      const b = snoise3(x + 1e-4, y, z);
      expect(Math.abs(a - b)).toBeLessThan(1e-2);
    }
  });

  it('is a curl: with the same stencil its divergence vanishes', () => {
    // The kernel builds the curl from central differences with step eps.
    // Differencing the result again with the same step commutes exactly, so
    // any sign or component slip in the assembly shows up as a non-zero
    // divergence. (With a different outer step the residual is O(eps²) and
    // large — the field is only approximately solenoidal at eps = 0.35.)
    const out = { x: 0, y: 0, z: 0 };
    const at = (x: number, y: number, z: number) => {
      curlNoise(out, x, y, z, 1, 1.2);
      return { x: out.x, y: out.y, z: out.z };
    };
    const h = CURL_EPS;
    let divMax = 0;
    let magSum = 0;
    for (let i = 0; i < 60; i++) {
      const x = Math.sin(i * 1.7) * 6 + 0.123;
      const y = Math.cos(i * 2.3) * 6 + 0.071;
      const z = Math.sin(i * 0.9) * 6 + 0.317;
      const dx = (at(x + h, y, z).x - at(x - h, y, z).x) / (2 * h);
      const dy = (at(x, y + h, z).y - at(x, y - h, z).y) / (2 * h);
      const dz = (at(x, y, z + h).z - at(x, y, z - h).z) / (2 * h);
      const v = at(x, y, z);
      divMax = Math.max(divMax, Math.abs(dx + dy + dz));
      magSum += Math.hypot(v.x, v.y, v.z);
    }
    expect(magSum / 60).toBeGreaterThan(0.05);
    expect(divMax).toBeLessThan(1e-9);
  });

  it('is spatially coherent: neighbours flow the same way', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    let cosSum = 0;
    for (let i = 0; i < 100; i++) {
      const x = Math.sin(i * 1.3) * 5;
      const y = Math.cos(i * 0.7) * 5;
      const z = Math.sin(i * 2.1) * 5;
      curlNoise(a, x, y, z, 0.5, 3);
      curlNoise(b, x + 0.05, y - 0.03, z + 0.04, 0.5, 3);
      const la = Math.hypot(a.x, a.y, a.z);
      const lb = Math.hypot(b.x, b.y, b.z);
      cosSum += (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
    }
    expect(cosSum / 100).toBeGreaterThan(0.95);
  });

  it('drifts with time rather than jumping', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    curlNoise(a, 1, 2, 3, 0.5, 10);
    curlNoise(b, 1, 2, 3, 0.5, 10.016);
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.05);
  });
});

describe('classic Perlin on the CPU', () => {
  it('is zero on every lattice point and bounded off it', () => {
    for (let i = -5; i <= 5; i++)
      for (let j = -3; j <= 3; j++)
        expect(Math.abs(cnoise3(i, j, i - j))).toBeLessThan(1e-9);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin(i * 12.9898) * 43.5;
      const y = Math.sin(i * 78.233) * 43.5;
      const z = Math.sin(i * 37.719) * 43.5;
      const v = cnoise3(x, y, z);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(cnoise3(x, y, z));
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThan(-1.2);
    expect(max).toBeLessThan(1.2);
    expect(max - min).toBeGreaterThan(1);
  });

  it('is continuous', () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37 - 30.123;
      const y = i * 0.11 + 4.071;
      const z = -i * 0.23 + 0.317;
      expect(Math.abs(cnoise3(x, y, z) - cnoise3(x + 1e-4, y, z))).toBeLessThan(
        1e-2
      );
    }
  });

  it('as a curl field it is divergence-free with the same stencil, and about as fast as simplex', () => {
    const out = { x: 0, y: 0, z: 0 };
    const at = (x: number, y: number, z: number, perlin: boolean) => {
      curlNoise(out, x, y, z, 1, 1.2, 0.15, 0.11, 0.13, perlin);
      return { x: out.x, y: out.y, z: out.z };
    };
    const h = CURL_EPS;
    let divMax = 0;
    let sSq = 0;
    let pSq = 0;
    for (let i = 0; i < 60; i++) {
      const x = Math.sin(i * 1.7) * 6 + 0.123;
      const y = Math.cos(i * 2.3) * 6 + 0.071;
      const z = Math.sin(i * 0.9) * 6 + 0.317;
      const dx = (at(x + h, y, z, true).x - at(x - h, y, z, true).x) / (2 * h);
      const dy = (at(x, y + h, z, true).y - at(x, y - h, z, true).y) / (2 * h);
      const dz = (at(x, y, z + h, true).z - at(x, y, z - h, true).z) / (2 * h);
      divMax = Math.max(divMax, Math.abs(dx + dy + dz));
      const p = at(x, y, z, true);
      const s = at(x, y, z, false);
      pSq += p.x * p.x + p.y * p.y + p.z * p.z;
      sSq += s.x * s.x + s.y * s.y + s.z * s.z;
    }
    expect(divMax).toBeLessThan(1e-9);
    // PERLIN_GAIN is set from this ratio over many points; here a loose check.
    const ratio = Math.sqrt(pSq / 60) / Math.sqrt(sSq / 60);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
    expect(PERLIN_GAIN).toBeCloseTo(0.49, 2);
  });
});

describe("the field's drift", () => {
  it('at zero the field stands still in time', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 50; i++) {
      const x = Math.sin(i * 1.7) * 6;
      const y = Math.cos(i * 2.3) * 6;
      const z = Math.sin(i * 0.9) * 6;
      curlNoise(a, x, y, z, 0.7, 0, 0, 0, 0);
      curlNoise(b, x, y, z, 0.7, 37.5, 0, 0, 0);
      expect(b).toEqual(a);
    }
  });

  it('is a translation: the field at time t is the field at t = 0 shifted by drift · t / frequency', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    const f = 0.5;
    const t = 2.5;
    const d = { x: 0.3, y: -0.2, z: 0.1 };
    for (let i = 0; i < 50; i++) {
      const x = Math.sin(i * 1.7) * 6;
      const y = Math.cos(i * 2.3) * 6;
      const z = Math.sin(i * 0.9) * 6;
      curlNoise(a, x, y, z, f, t, d.x, d.y, d.z);
      curlNoise(
        b,
        x + (d.x * t) / f,
        y + (d.y * t) / f,
        z + (d.z * t) / f,
        f,
        0,
        d.x,
        d.y,
        d.z
      );
      expect(a.x).toBeCloseTo(b.x, 9);
      expect(a.y).toBeCloseTo(b.y, 9);
      expect(a.z).toBeCloseTo(b.z, 9);
    }
  });

  it('defaults to the motion the field has always had, (0.15, 0.11, 0.13)', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    curlNoise(a, 1.2, -0.4, 3.3, 0.8, 4.2);
    curlNoise(b, 1.2, -0.4, 3.3, 0.8, 4.2, 0.15, 0.11, 0.13, false);
    expect(a).toEqual(b);
  });
});
