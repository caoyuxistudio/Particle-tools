/**
 * Curl noise on the CPU — the same field the WebGPU kernel samples in
 * `webgpu/compute-modifiers.ts`, so a piece flows the same way whichever
 * backend runs it (the TRAIL renderer and the WebGL fallback are CPU-only).
 *
 * The simplex noise is a scalar port of `webgpu/tsl-noise.ts`, which is the
 * Ashima Arts / Stefan Gustavson implementation (MIT) with the same
 * permutation polynomial and constants, so the two evaluate the same field
 * to float precision. The curl is built exactly as the kernel builds it:
 * three potential components are the one noise sampled at large constant
 * offsets, the partials are central differences with the same epsilon.
 */

const ONE_THIRD = 1 / 3;
const ONE_SIXTH = 1 / 6;
const NS_X = 0.285714285714286; // 2/7
const NS_Y = -0.928571428571429; // 1/14 - 1
const N_ = 0.142857142857142; // 1/7

/** GLSL-style modulo: the result takes the sign of the divisor. */
const mod = (x: number, y: number): number => x - y * Math.floor(x / y);

/** permute(x) = mod(((x * 34) + 10) * x, 289) */
const permute = (x: number): number => mod((x * 34 + 10) * x, 289);

const taylorInvSqrt = (r: number): number =>
  1.79284291400159 - 0.85373472095314 * r;

/** Scratch for the four corner gradients, reused across calls. */
const gxs = new Float64Array(4);
const gys = new Float64Array(4);
const gzs = new Float64Array(4);

/**
 * 3D simplex noise, in roughly [-1, 1]. Same field as the GPU's `snoise3D`.
 */
export const snoise3 = (vx: number, vy: number, vz: number): number => {
  // Skew into the simplex grid.
  const s = (vx + vy + vz) * ONE_THIRD;
  const ix = Math.floor(vx + s);
  const iy = Math.floor(vy + s);
  const iz = Math.floor(vz + s);
  const t = (ix + iy + iz) * ONE_SIXTH;
  const x0x = vx - ix + t;
  const x0y = vy - iy + t;
  const x0z = vz - iz + t;

  // Which tetrahedron: g = step(x0.yzx, x0.xyz), l = 1 - g,
  // i1 = min(g.xyz, l.zxy), i2 = max(g.xyz, l.zxy).
  const gx = x0x >= x0y ? 1 : 0;
  const gy = x0y >= x0z ? 1 : 0;
  const gz = x0z >= x0x ? 1 : 0;
  const lx = 1 - gx;
  const ly = 1 - gy;
  const lz = 1 - gz;
  const i1x = Math.min(gx, lz);
  const i1y = Math.min(gy, lx);
  const i1z = Math.min(gz, ly);
  const i2x = Math.max(gx, lz);
  const i2y = Math.max(gy, lx);
  const i2z = Math.max(gz, ly);

  const x1x = x0x - i1x + ONE_SIXTH;
  const x1y = x0y - i1y + ONE_SIXTH;
  const x1z = x0z - i1z + ONE_SIXTH;
  const x2x = x0x - i2x + 2 * ONE_SIXTH;
  const x2y = x0y - i2y + 2 * ONE_SIXTH;
  const x2z = x0z - i2z + 2 * ONE_SIXTH;
  const x3x = x0x - 1 + 3 * ONE_SIXTH;
  const x3y = x0y - 1 + 3 * ONE_SIXTH;
  const x3z = x0z - 1 + 3 * ONE_SIXTH;

  // Hash the four corners: z, then y, then x.
  const iwx = mod(ix, 289);
  const iwy = mod(iy, 289);
  const iwz = mod(iz, 289);
  const p0 = permute(permute(permute(iwz) + iwy) + iwx);
  const p1 = permute(permute(permute(iwz + i1z) + iwy + i1y) + iwx + i1x);
  const p2 = permute(permute(permute(iwz + i2z) + iwy + i2y) + iwx + i2x);
  const p3 = permute(permute(permute(iwz + 1) + iwy + 1) + iwx + 1);

  // Hash → gradient direction on the octahedron, normalised approximately.
  const ps = [p0, p1, p2, p3];
  for (let c = 0; c < 4; c++) {
    const p = ps[c];
    const j = p - 49 * Math.floor(p * N_ * N_);
    const x_ = Math.floor(j * N_);
    const y_ = Math.floor(j - 7 * x_);
    let gxc = x_ * NS_X + NS_Y;
    let gyc = y_ * NS_X + NS_Y;
    const gzc = 1 - Math.abs(gxc) - Math.abs(gyc);
    if (gzc <= 0) {
      gxc -= Math.floor(gxc) + 0.5;
      gyc -= Math.floor(gyc) + 0.5;
    }
    const norm = taylorInvSqrt(gxc * gxc + gyc * gyc + gzc * gzc);
    gxs[c] = gxc * norm;
    gys[c] = gyc * norm;
    gzs[c] = gzc * norm;
  }

  // Corner contributions: max(0, 0.5 - |x|²)⁴ · (g · x).
  let m0 = Math.max(0.5 - (x0x * x0x + x0y * x0y + x0z * x0z), 0);
  let m1 = Math.max(0.5 - (x1x * x1x + x1y * x1y + x1z * x1z), 0);
  let m2 = Math.max(0.5 - (x2x * x2x + x2y * x2y + x2z * x2z), 0);
  let m3 = Math.max(0.5 - (x3x * x3x + x3y * x3y + x3z * x3z), 0);
  m0 *= m0;
  m1 *= m1;
  m2 *= m2;
  m3 *= m3;
  m0 *= m0;
  m1 *= m1;
  m2 *= m2;
  m3 *= m3;

  return (
    42 *
    (m0 * (gxs[0] * x0x + gys[0] * x0y + gzs[0] * x0z) +
      m1 * (gxs[1] * x1x + gys[1] * x1y + gzs[1] * x1z) +
      m2 * (gxs[2] * x2x + gys[2] * x2y + gzs[2] * x2z) +
      m3 * (gxs[3] * x3x + gys[3] * x3y + gzs[3] * x3z))
  );
};

/** The kernel's constants: finite-difference step and the potential offsets. */
export const CURL_EPS = 0.35;
const OY = [31.341, -43.23, 12.34];
const OZ = [-231.341, 124.23, -54.34];

/** The field's own motion, in field units per second, when the config says nothing. */
export const DEFAULT_DRIFT = { x: 0.15, y: 0.11, z: 0.13 };

/** A {@link NoiseDirection} as the sign the kernel takes: 0 both ways, ±1 one way. */
export const directionSign = (direction: string | undefined): number =>
  direction === 'POSITIVE' ? 1 : direction === 'NEGATIVE' ? -1 : 0;

/** One component of a displacement, folded onto the side `sign` names (0 = left alone). */
export const foldDirection = (value: number, sign: number): number =>
  sign === 0 ? value : sign * Math.abs(value);

/**
 * Classic Perlin's curl is stronger than this simplex port's (whose gradients
 * peak near ±0.37); Perlin's output is scaled by this so the same `strength`
 * gives about the same flow speed — measured as the ratio of the two fields'
 * root-mean-square speeds over random points.
 */
export const PERLIN_GAIN = 0.49;

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const fract = (x: number): number => x - Math.floor(x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const gx0s = new Float64Array(4);
const gy0s = new Float64Array(4);
const gz0s = new Float64Array(4);
const gx1s = new Float64Array(4);
const gy1s = new Float64Array(4);
const gz1s = new Float64Array(4);

/**
 * One lane of the gradient set: the hash to a gradient, as the GLSL does it
 * (step(gz, 0) folds the gradient back into the octahedron; step(0, g) is
 * the sign), then normalised the approximate way.
 */
const gradientLane = (
  h: number,
  gx: Float64Array,
  gy: Float64Array,
  gz: Float64Array,
  k: number
): void => {
  let x = h / 7;
  let y = fract(Math.floor(x) / 7) - 0.5;
  x = fract(x);
  const z = 0.5 - Math.abs(x) - Math.abs(y);
  const sz = z <= 0 ? 1 : 0;
  x -= sz * ((x >= 0 ? 1 : 0) - 0.5);
  y -= sz * ((y >= 0 ? 1 : 0) - 0.5);
  const n = taylorInvSqrt(x * x + y * y + z * z);
  gx[k] = x * n;
  gy[k] = y * n;
  gz[k] = z * n;
};

/**
 * Classic Perlin noise in 3D — a scalar port of Stefan Gustavson's
 * `cnoise` (webgl-noise, MIT), with this project's permute (the +10 fold),
 * so it agrees with the TSL `cnoise3D` to float precision. Zero at every
 * lattice point; output scaled by 2.2 as the original is, so roughly ±1.
 */
export const cnoise3 = (x: number, y: number, z: number): number => {
  const Pi0x = mod(Math.floor(x), 289);
  const Pi0y = mod(Math.floor(y), 289);
  const Pi0z = mod(Math.floor(z), 289);
  const Pi1x = mod(Pi0x + 1, 289);
  const Pi1y = mod(Pi0y + 1, 289);
  const Pi1z = mod(Pi0z + 1, 289);
  const Pf0x = fract(x);
  const Pf0y = fract(y);
  const Pf0z = fract(z);
  const Pf1x = Pf0x - 1;
  const Pf1y = Pf0y - 1;
  const Pf1z = Pf0z - 1;

  // Lanes: (x0,y0) (x1,y0) (x0,y1) (x1,y1), each at z0 and at z1.
  const ix0 = permute(Pi0x);
  const ix1 = permute(Pi1x);
  const ixy = [
    permute(ix0 + Pi0y),
    permute(ix1 + Pi0y),
    permute(ix0 + Pi1y),
    permute(ix1 + Pi1y),
  ];
  for (let k = 0; k < 4; k++) {
    gradientLane(permute(ixy[k] + Pi0z), gx0s, gy0s, gz0s, k);
    gradientLane(permute(ixy[k] + Pi1z), gx1s, gy1s, gz1s, k);
  }

  const n000 = gx0s[0] * Pf0x + gy0s[0] * Pf0y + gz0s[0] * Pf0z;
  const n100 = gx0s[1] * Pf1x + gy0s[1] * Pf0y + gz0s[1] * Pf0z;
  const n010 = gx0s[2] * Pf0x + gy0s[2] * Pf1y + gz0s[2] * Pf0z;
  const n110 = gx0s[3] * Pf1x + gy0s[3] * Pf1y + gz0s[3] * Pf0z;
  const n001 = gx1s[0] * Pf0x + gy1s[0] * Pf0y + gz1s[0] * Pf1z;
  const n101 = gx1s[1] * Pf1x + gy1s[1] * Pf0y + gz1s[1] * Pf1z;
  const n011 = gx1s[2] * Pf0x + gy1s[2] * Pf1y + gz1s[2] * Pf1z;
  const n111 = gx1s[3] * Pf1x + gy1s[3] * Pf1y + gz1s[3] * Pf1z;

  const fx = fade(Pf0x);
  const fy = fade(Pf0y);
  const fz = fade(Pf0z);
  const nz0 = lerp(n000, n001, fz);
  const nz1 = lerp(n100, n101, fz);
  const nz2 = lerp(n010, n011, fz);
  const nz3 = lerp(n110, n111, fz);
  const ny0 = lerp(nz0, nz2, fy);
  const ny1 = lerp(nz1, nz3, fy);
  return 2.2 * lerp(ny0, ny1, fx);
};

/** The field's noise: simplex, or classic Perlin scaled to match it. */
const fieldNoise = (
  perlin: boolean,
  x: number,
  y: number,
  z: number
): number => (perlin ? cnoise3(x, y, z) * PERLIN_GAIN : snoise3(x, y, z));

/**
 * The curl-noise flow velocity at a world point, written into `out`.
 *
 * `frequency` is the spatial scale and `time` the animation clock in seconds,
 * combined exactly as the kernel does: p = pos · frequency + time · drift,
 * the drift defaulting to (0.15, 0.11, 0.13) and (0, 0, 0) being a still
 * field. `perlin` swaps the simplex base for classic Perlin. The result is a
 * velocity in field units per second; the caller scales it by strength,
 * amount, influence and delta, as the kernel does.
 */
export const curlNoise = (
  out: { x: number; y: number; z: number },
  x: number,
  y: number,
  z: number,
  frequency: number,
  time: number,
  driftX: number = DEFAULT_DRIFT.x,
  driftY: number = DEFAULT_DRIFT.y,
  driftZ: number = DEFAULT_DRIFT.z,
  perlin = false
): { x: number; y: number; z: number } => {
  const px = x * frequency + time * driftX;
  const py = y * frequency + time * driftY;
  const pz = z * frequency + time * driftZ;
  const e = CURL_EPS;
  const n = (a: number, b: number, c: number): number =>
    fieldNoise(perlin, a, b, c);

  const dpzDy =
    n(px + OZ[0], py + e + OZ[1], pz + OZ[2]) -
    n(px + OZ[0], py - e + OZ[1], pz + OZ[2]);
  const dpyDz =
    n(px + OY[0], py + OY[1], pz + e + OY[2]) -
    n(px + OY[0], py + OY[1], pz - e + OY[2]);
  const dpxDz = n(px, py, pz + e) - n(px, py, pz - e);
  const dpzDx =
    n(px + e + OZ[0], py + OZ[1], pz + OZ[2]) -
    n(px - e + OZ[0], py + OZ[1], pz + OZ[2]);
  const dpyDx =
    n(px + e + OY[0], py + OY[1], pz + OY[2]) -
    n(px - e + OY[0], py + OY[1], pz + OY[2]);
  const dpxDy = n(px, py + e, pz) - n(px, py - e, pz);

  const inv = 1 / (2 * e);
  out.x = (dpzDy - dpyDz) * inv;
  out.y = (dpxDz - dpzDx) * inv;
  out.z = (dpyDx - dpxDy) * inv;
  return out;
};
