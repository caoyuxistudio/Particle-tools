/**
 * Touch wake: a finger brushing through the particles.
 *
 * Not a force. A force field is a standing acceleration that knows only how
 * far a particle is from a point, so a finger driving one pushes everything
 * away the instant it lands and keeps pushing as long as it stays. A finger
 * moving through water does something else: it drags what it touches along
 * with it, the effect trails behind for a moment, and a finger held still
 * does nothing at all.
 *
 * So the finger is kept as a short trail of samples — where it was, how fast
 * it moved, when — and each sample is a soft splat of its own velocity: a
 * particle takes on the sample's motion faded by distance (a gaussian of the
 * finger's radius) and by age (an exponential with the wake's time constant).
 * The displacement goes straight onto the position, the same channel curl
 * noise uses, so the two simply add. No per-particle state, no damping to
 * tune: the wake fades because the samples do.
 *
 * Both backends evaluate the same sum — the CPU one here, the GPU one in
 * `webgpu/compute-touch-wake.ts`, reading the samples from the tail of the
 * shared curveData buffer the way force fields do.
 */

/** Samples kept per system; older ones fall off the end. */
export const MAX_TOUCH_SAMPLES = 16;
/** Floats per sample: x, y, z, radius, vx, vy, vz, time. */
export const TOUCH_SAMPLE_STRIDE = 8;
/** Floats reserved for touch samples in the curveData buffer. */
export const TOUCH_WAKE_DATA_SIZE = MAX_TOUCH_SAMPLES * TOUCH_SAMPLE_STRIDE;

export type TouchWakeConfig = {
  /** Whether fingers move the particles at all. @default false */
  isActive?: boolean;
  /** How much of the finger's motion a particle at its centre takes on; 1 = it moves with the finger. @default 1 */
  strength?: number;
  /** Seconds the wake lingers behind the finger (the age constant). @default 0.4 */
  wake?: number;
  /** Swirl around the finger's path, as a share of its speed; 0 = pure drag. @default 0.3 */
  swirl?: number;
  /** The normal of the plane the swirl turns in. @default (0, 1, 0) */
  normal?: { x: number; y: number; z: number };
  /**
   * The finger's radius as a share of the view's width at the particles'
   * plane — an input-side hint for whoever feeds the samples; the simulation
   * does not read it.
   */
  radius?: number;
  /**
   * The fastest finger speed taken, in world units per second. The input
   * side caps its samples at it, and a collision plane gives back no more
   * than this of a finger's push: the overlapping samples under a sweeping
   * finger add up to many times its speed, and a wall answers them as if
   * the finger had pushed at no more than this — unless the plane sets its
   * own `touchCap`. @default 8
   */
  maxSpeed?: number;
};

/** One finger position, in the particles' own space, with how fast it was moving. */
export type TouchSample = {
  x: number;
  y: number;
  z: number;
  /** The finger's radius in world units; 0 or less means the sample does nothing. */
  radius: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds, on the clock {@link TouchWakeState.now} reports. */
  time: number;
};

export type TouchWakeParams = {
  strength: number;
  wake: number;
  swirl: number;
  normal: { x: number; y: number; z: number };
  /** The finger's speed cap: also the most a collision plane without its own `touchCap` gives back of a push. */
  maxSpeed: number;
};

export const defaultTouchWakeParams = (
  config?: TouchWakeConfig | null
): TouchWakeParams => ({
  strength: config?.strength ?? 1,
  wake: Math.max(0.01, config?.wake ?? 0.4),
  swirl: config?.swirl ?? 0.3,
  normal: config?.normal ?? { x: 0, y: 1, z: 0 },
  maxSpeed: config?.maxSpeed ?? 8,
});

/** How many age constants a sample survives before it is dropped as too faint to matter. */
const PRUNE_AFTER = 4;

/**
 * The trail of recent finger samples for one particle system. Times are
 * seconds since the state was made, which keeps them small enough for the
 * float32 the GPU reads them as.
 */
export class TouchWakeState {
  private samples: TouchSample[] = [];
  private readonly encoded = new Float32Array(TOUCH_WAKE_DATA_SIZE);
  private readonly epoch: number;

  constructor(epochMs: number = TouchWakeState.clock()) {
    this.epoch = epochMs;
  }

  private static clock(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** The clock the samples are stamped on: seconds since this state was made. */
  now(): number {
    return (TouchWakeState.clock() - this.epoch) / 1000;
  }

  /** Adds a sample; `time` left out is now. The oldest sample makes room. */
  push(sample: Omit<TouchSample, 'time'> & { time?: number }): void {
    this.samples.push({ ...sample, time: sample.time ?? this.now() });
    if (this.samples.length > MAX_TOUCH_SAMPLES) this.samples.shift();
  }

  clear(): void {
    this.samples.length = 0;
  }

  /** Drops samples older than a few wake constants — they would contribute nothing. */
  prune(now: number, wake: number): void {
    const limit = now - Math.max(0.01, wake) * PRUNE_AFTER;
    if (this.samples.length && this.samples[0].time < limit) {
      this.samples = this.samples.filter((s) => s.time >= limit);
    }
  }

  get count(): number {
    return this.samples.length;
  }

  get list(): ReadonlyArray<TouchSample> {
    return this.samples;
  }

  /** The samples packed for the GPU: {@link TOUCH_SAMPLE_STRIDE} floats each, zero beyond the count. */
  encode(): Float32Array {
    const data = this.encoded;
    data.fill(0);
    this.samples.forEach((s, i) => {
      const base = i * TOUCH_SAMPLE_STRIDE;
      data[base] = s.x;
      data[base + 1] = s.y;
      data[base + 2] = s.z;
      data[base + 3] = s.radius;
      data[base + 4] = s.vx;
      data[base + 5] = s.vy;
      data[base + 6] = s.vz;
      data[base + 7] = s.time;
    });
    return data;
  }
}

/** Contributions below this weight are skipped, on both backends. */
const MIN_WEIGHT = 1e-4;

/**
 * The displacement the wake gives a point over one frame, into `out`.
 * Pure: the CPU backend calls it per particle, the tests call it directly,
 * and the GPU kernel is a transcription of it.
 */
export const wakeDisplacement = (
  px: number,
  py: number,
  pz: number,
  samples: ReadonlyArray<TouchSample>,
  count: number,
  now: number,
  delta: number,
  params: TouchWakeParams,
  out: [number, number, number]
): [number, number, number] => {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  const tau = Math.max(0.01, params.wake);
  const n = params.normal;
  for (let i = 0; i < count; i += 1) {
    const s = samples[i];
    if (s.radius <= 0) continue;
    const dx = px - s.x;
    const dy = py - s.y;
    const dz = pz - s.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const w =
      Math.exp(-d2 / (s.radius * s.radius)) * Math.exp(-(now - s.time) / tau);
    if (w < MIN_WEIGHT) continue;
    // Drag: the particle takes on the finger's motion.
    const drag = w * params.strength * delta;
    out[0] += s.vx * drag;
    out[1] += s.vy * drag;
    out[2] += s.vz * drag;
    // Swirl: a turn about the finger's path, in the plane of the normal.
    if (params.swirl !== 0) {
      const speed = Math.hypot(s.vx, s.vy, s.vz);
      if (speed > 0) {
        const tx = n.y * dz - n.z * dy;
        const ty = n.z * dx - n.x * dz;
        const tz = n.x * dy - n.y * dx;
        const tl = Math.hypot(tx, ty, tz);
        if (tl > 1e-6) {
          const turn = (speed * w * params.swirl * delta) / tl;
          out[0] += tx * turn;
          out[1] += ty * turn;
          out[2] += tz * turn;
        }
      }
    }
  }
  return out;
};

const scratch: [number, number, number] = [0, 0, 0];

/** Applies the wake to one particle of a CPU position array. Returns whether it moved. */
export const applyTouchWakeCPU = (
  positionArr: { [index: number]: number },
  positionIndex: number,
  samples: ReadonlyArray<TouchSample>,
  count: number,
  now: number,
  delta: number,
  params: TouchWakeParams
): boolean => {
  wakeDisplacement(
    positionArr[positionIndex],
    positionArr[positionIndex + 1],
    positionArr[positionIndex + 2],
    samples,
    count,
    now,
    delta,
    params,
    scratch
  );
  if (scratch[0] === 0 && scratch[1] === 0 && scratch[2] === 0) return false;
  positionArr[positionIndex] += scratch[0];
  positionArr[positionIndex + 1] += scratch[1];
  positionArr[positionIndex + 2] += scratch[2];
  return true;
};
