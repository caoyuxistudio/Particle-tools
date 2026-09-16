import { ObjectUtils } from '@newkrok/three-utils';
import * as THREE from 'three';
import { FBM } from 'three-noise/build/three-noise.module.js';
import { spawnToUv, uvToPixelOffset } from './color-instance-mapping';
import {
  createColorInstanceData,
  disposeColorInstanceData,
  ensureColorInstancePixels,
  refreshColorInstanceData,
} from './color-instance-sampler';
import { applyColorTweak, remapLuminance } from './color-tweak';

/** Scratch for the tweaked colour of the pixel being spawned. */
const tweakedColor: [number, number, number] = [0, 0, 0];
/** Reused per spawn: the source coordinate the position maps to. */
const colorInstanceUv: [number, number] = [0, 0];

/**
 * A copy of a config block in which every plain nested object is its own —
 * class instances (a texture, a vector) stay by reference. deepMerge keeps a
 * reference to the default config's nested object wherever a config left one
 * out, and updateConfig merges in place; without this, a live tweak would be
 * written into the library's defaults and leak into every system created
 * after it.
 */
const detachPlainObjects = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(detachPlainObjects) as T;
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = detachPlainObjects(v);
    return out as T;
  }
  return value;
};

type ColorInstanceSample = {
  /**
   * Whether there is something under the position: on the source and on a
   * texel with alpha. False is nothing — black, alpha 0, motion untouched.
   */
  hit: boolean;
  /** Linear start colour. */
  r: number;
  g: number;
  b: number;
  /** The texel's alpha, 0..1. */
  alpha: number;
  /** The curl-noise multiplier the texel's luminance gives, 1 = untouched. */
  noiseMul: number;
};
const colorInstanceSample: ColorInstanceSample = {
  hit: false,
  r: 0,
  g: 0,
  b: 0,
  alpha: 1,
  noiseMul: 1,
};

/** How many times a birth is drawn again to land on the source. */
const SPAWN_ON_SOURCE_TRIES = 32;

/**
 * What the colour source gives a particle at a spawn position: the texel
 * under it through the mapping (plane, area, scale, wrap, offset), the
 * source's own look applied in display space, then linear; its alpha; and
 * the curl-noise multiplier from its luminance and the luminosity noise map.
 * Off the source (wrap ZERO) is a black, transparent texel. The sampler's
 * pixels must be present (ensureColorInstancePixels). Used at birth and by
 * the live recolour, so the two can never disagree.
 */
const sampleColorInstance = (
  ci: ColorInstanceData,
  x: number,
  y: number,
  z: number,
  rectWidth: number,
  rectHeight: number,
  out: ColorInstanceSample
): void => {
  let r8 = 0;
  let g8 = 0;
  let b8 = 0;
  let a8 = 0;
  if (spawnToUv(ci, x, y, z, rectWidth, rectHeight, colorInstanceUv)) {
    const o = uvToPixelOffset(
      colorInstanceUv[0],
      colorInstanceUv[1],
      ci.width!,
      ci.height!
    );
    const pixels = ci.pixels!;
    r8 = pixels[o];
    g8 = pixels[o + 1];
    b8 = pixels[o + 2];
    a8 = pixels[o + 3];
  }
  if (a8 === 0) {
    // Nothing here — off the source, or a texel with no alpha. Not a black
    // pixel: no look is applied (contrast below 1 would lift it to grey),
    // no luminance read (it would stop the particle), and it is invisible.
    out.hit = false;
    out.r = 0;
    out.g = 0;
    out.b = 0;
    out.alpha = 0;
    out.noiseMul = 1;
    return;
  }
  out.hit = true;
  // The source's own look, before the pixel becomes a start colour: hue,
  // saturation and contrast in display (sRGB) space, the way an image
  // editor applies them.
  let sr = r8 / 255;
  let sg = g8 / 255;
  let sb = b8 / 255;
  if (ci.colorTweak) {
    applyColorTweak(ci.colorTweak, sr, sg, sb, tweakedColor);
    sr = tweakedColor[0];
    sg = tweakedColor[1];
    sb = tweakedColor[2];
  }
  out.r = sRGBToLinear(sr);
  out.g = sRGBToLinear(sg);
  out.b = sRGBToLinear(sb);
  out.alpha = a8 / 255;
  out.noiseMul = 1;
  if (ci.useLuminanceForNoise) {
    // Rec.709 luma of the sRGB pixel as sampled — perceived brightness,
    // which is what "grayscale value" means to the eye — before any colour
    // tweak, so the look and the motion stay separate levers. Then the
    // luminosity noise map: black point to 0, white point to 1.
    const luma = remapLuminance(
      (0.2126 * r8 + 0.7152 * g8 + 0.0722 * b8) / 255,
      ci.luminanceBlack ?? 0,
      ci.luminanceWhite ?? 1
    );
    const amount = ci.luminanceNoiseAmount;
    // Positive amount drives motion with brightness, negative inverts it.
    // At |amount| = 1 the damped end reaches a full stop.
    const t = amount >= 0 ? luma : 1 - luma;
    out.noiseMul = 1 - Math.abs(amount) * (1 - t);
  }
};
import { rgbSRGBToLinear, sRGBToLinear } from './color-utils.js';
import { DEFAULT_DRIFT } from './curl-noise';
import InstancedParticleFragmentShader from './shaders/instanced-particle-fragment-shader.glsl.js';
import InstancedParticleVertexShader from './shaders/instanced-particle-vertex-shader.glsl.js';
import MeshParticleFragmentShader from './shaders/mesh-particle-fragment-shader.glsl.js';
import MeshParticleVertexShader from './shaders/mesh-particle-vertex-shader.glsl.js';
import ParticleSystemFragmentShader from './shaders/particle-system-fragment-shader.glsl.js';
import ParticleSystemVertexShader from './shaders/particle-system-vertex-shader.glsl.js';
import TrailFragmentShader from './shaders/trail-fragment-shader.glsl.js';
import TrailVertexShader from './shaders/trail-vertex-shader.glsl.js';
import { removeBezierCurveFunction } from './three-particles-bezier.js';
import { applyCollisionPlanes } from './three-particles-collision.js';
import {
  SCALAR_STRIDE,
  S_IS_ACTIVE,
  S_LIFETIME,
  S_START_LIFETIME,
  S_START_FRAME,
  S_SIZE,
  S_ROTATION,
  S_COLOR_R,
  S_COLOR_G,
  S_COLOR_B,
  S_COLOR_A,
} from './three-particles-constants.js';
import {
  CollisionPlaneMode,
  EmitFrom,
  ForceFieldFalloff,
  ForceFieldType,
  LifeTimeCurve,
  RendererType,
  Shape,
  SimulationBackend,
  SimulationSpace,
  SubEmitterTrigger,
  TimeMode,
  ColorInstancePlane,
  ColorInstanceWrap,
  NoiseType,
} from './three-particles-enums';
import { applyForceFields } from './three-particles-forces.js';
import { applyModifiers } from './three-particles-modifiers.js';
import { isComputeCapableRenderer } from './three-particles-renderer-detect.js';
import {
  calculateRandomPositionAndVelocityOnBox,
  calculateRandomPositionAndVelocityOnCircle,
  calculateRandomPositionAndVelocityOnCone,
  calculateRandomPositionAndVelocityOnRectangle,
  calculateRandomPositionAndVelocityOnSphere,
  calculateValue,
  getCurveFunctionFromConfig,
  isLifeTimeCurve,
  createDefaultMeshTexture,
  createDefaultParticleTexture,
} from './three-particles-utils.js';
import {
  TouchWakeState,
  applyTouchWakeCPU,
  defaultTouchWakeParams,
} from './touch-wake';

import {
  CollisionPlaneConfig,
  Constant,
  CurveFunction,
  CycleData,
  ForceFieldConfig,
  GeneralData,
  LifetimeCurve,
  MappedAttributes,
  NormalizedCollisionPlaneConfig,
  NormalizedForceFieldConfig,
  NormalizedParticleSystemConfig,
  ParticleSystem,
  ParticleSystemConfig,
  ParticleSystemInstance,
  Point3D,
  RandomBetweenTwoConstants,
  ShapeConfig,
  SubEmitterConfig,
  MeshConfig,
  TrailConfig,
} from './types.js';

export * from './types.js';

const normalizeTrailCurve = (
  curve: LifetimeCurve | undefined,
  defaultCurve: LifetimeCurve
): LifetimeCurve => {
  if (!curve) return defaultCurve;
  const raw = curve as Record<string, unknown>;
  if (!raw.type && Array.isArray(raw.bezierPoints)) {
    return { type: LifeTimeCurve.BEZIER, ...raw } as LifetimeCurve;
  }
  return curve;
};

// Re-export so downstream consumers can access stride constants from the main module.
export {
  SCALAR_STRIDE,
  S_IS_ACTIVE,
  S_LIFETIME,
  S_START_LIFETIME,
  S_START_FRAME,
  S_SIZE,
  S_ROTATION,
  S_COLOR_R,
  S_COLOR_G,
  S_COLOR_B,
  S_COLOR_A,
} from './three-particles-constants.js';

let _particleSystemId = 0;
let createdParticleSystems: Array<ParticleSystemInstance> = [];

// ─── GPU Compute Uniform Helpers ────────────────────────────────────────────
// Centralise the `as unknown as` casts for setting TSL uniform values.
// The TSL uniform nodes expose `.value` at runtime but their TypeScript
// type (`ShaderNodeObject<Node>`) does not declare it.

/** Sets a TSL float uniform's value. */
const setUniformFloat = (u: unknown, v: number): void => {
  (u as { value: number }).value = v;
};

/** Sets a TSL vec3 uniform's value. */
const setUniformVec3 = (u: unknown, x: number, y: number, z: number): void => {
  (
    u as { value: { set: (x: number, y: number, z: number) => void } }
  ).value.set(x, y, z);
};

// ─── WebGPU TSL Material Support (opt-in via registerTSLMaterialFactory) ─────

type TSLMaterialFactory = {
  createTSLParticleMaterial: (
    rendererType: RendererType,
    sharedUniforms: Record<string, { value: unknown }>,
    rendererConfig: {
      transparent: boolean;
      blending: THREE.Blending;
      depthTest: boolean;
      depthWrite: boolean;
    },
    gpuCompute?: boolean,
    alignToVelocity?: boolean,
    lit?: boolean,
    emissive?: number,
    roughness?: number,
    metalness?: number,
    velocityStretch?: number,
    meshExtentZ?: number
  ) => THREE.Material;
  createTSLTrailMaterial: (
    trailUniforms: Record<string, { value: unknown }>,
    rendererConfig: {
      transparent: boolean;
      blending: THREE.Blending;
      depthTest: boolean;
      depthWrite: boolean;
    }
  ) => THREE.Material;
  /** The trail ribbon built on the GPU from the compute pipeline's history ring. */
  createTSLGpuTrailMaterial?: (...args: any[]) => any;
  // GPU compute functions — use opaque types to avoid pulling WebGPU/TSL
  // types into the DTS output.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createComputePipeline?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeParticleToModifierBuffers?: (...args: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deactivateParticleInModifierBuffers?: (...args: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  flushEmitQueue?: (...args: any[]) => number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerCurveDataLength?: (...args: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encodeForceFieldsForGPU?: (...args: any[]) => Float32Array;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encodeCollisionPlanesForGPU?: (...args: any[]) => Float32Array;
};

let _tslMaterialFactory: TSLMaterialFactory | null = null;

/**
 * Registers the TSL (Three Shading Language) material factory for WebGPU support.
 *
 * Call this **once** before creating any particle systems that use WebGPU rendering.
 * The factory functions are imported from the `@newkrok/three-particles/webgpu` sub-module.
 *
 * When registered, all particle systems will use TSL-based `NodeMaterial` (compiles to WGSL)
 * instead of GLSL `ShaderMaterial`. If the factory also includes the GPU compute functions
 * (`createComputePipeline`, `writeParticleToModifierBuffers`, etc.), particle systems with
 * `simulationBackend: 'AUTO'` or `'GPU'` will run physics and modifiers on the GPU.
 *
 * @param factory - Object containing TSL material creators and optional GPU compute helpers.
 *
 * @example
 * ```typescript
 * import { registerTSLMaterialFactory } from '@newkrok/three-particles';
 * import {
 *   createTSLParticleMaterial,
 *   createTSLTrailMaterial,
 *   createComputePipeline,
 *   writeParticleToModifierBuffers,
 *   deactivateParticleInModifierBuffers,
 *   flushEmitQueue,
 *   registerCurveDataLength,
 *   encodeForceFieldsForGPU,
 * } from '@newkrok/three-particles/webgpu';
 *
 * registerTSLMaterialFactory({
 *   createTSLParticleMaterial,
 *   createTSLTrailMaterial,
 *   createComputePipeline,
 *   writeParticleToModifierBuffers,
 *   deactivateParticleInModifierBuffers,
 *   flushEmitQueue,
 *   registerCurveDataLength,
 *   encodeForceFieldsForGPU,
 * });
 * ```
 */
export const registerTSLMaterialFactory = (
  factory: TSLMaterialFactory,
  options?: { renderer?: unknown }
): boolean => {
  // When a renderer is provided, verify it can actually run TSL materials +
  // compute dispatches. Registering the factory alongside a plain
  // WebGLRenderer would produce NodeMaterials and a compute pipeline that
  // can never be dispatched.
  if (
    options &&
    'renderer' in options &&
    !isComputeCapableRenderer(options.renderer)
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'three-particles: registerTSLMaterialFactory skipped — the provided ' +
        'renderer does not support compute dispatches (expected ' +
        'THREE.WebGPURenderer). Particle systems will use the CPU/GLSL path.'
    );
    return false;
  }
  _tslMaterialFactory = factory;
  return true;
};

// Pre-allocated objects for updateParticleSystemInstance to avoid GC pressure
const _subEmitterPosition = new THREE.Vector3();
const _subLocalPosition = new THREE.Vector3();
const _shadowOrbitalEuler = new THREE.Euler(0, 0, 0, 'XYZ');
const _lastWorldPositionSnapshot = new THREE.Vector3();
// Force field local-space conversion helpers (reused across frames)
const _localForceFieldPos = new THREE.Vector3();
const _localForceFieldDir = new THREE.Vector3();
const _inverseQuat = new THREE.Quaternion();

/**
 * Compares two typed-array slices for value equality.
 * Used to gate GPU buffer `needsUpdate` flagging so we only re-upload when
 * the encoded data actually changed. See the force-field / collision-plane
 * upload block in `updateParticleSystemInstance` for the reasoning.
 */
const arraySlicesEqual = (
  a: Float32Array,
  aOffset: number,
  b: Float32Array,
  bOffset: number,
  length: number
): boolean => {
  for (let i = 0; i < length; i++) {
    if (a[aOffset + i] !== b[bOffset + i]) return false;
  }
  return true;
};
let _localForceFields: Array<NormalizedForceFieldConfig> = [];
// Collision plane local-space conversion helpers (reused across frames)
const _localCollisionPlanePos = new THREE.Vector3();
const _localCollisionPlaneNormal = new THREE.Vector3();
let _localCollisionPlanes: Array<NormalizedCollisionPlaneConfig> = [];
/**
 * Samples a 0..1 curve into a table and returns a function that reads it
 * with linear interpolation. The trail evaluates its width and opacity
 * curves once per ribbon vertex per frame, which at a few thousand ribbons
 * of eighty samples is hundreds of thousands of bezier evaluations; a lookup
 * is a multiply, an index and a lerp.
 */
const CURVE_TABLE_SIZE = 256;
const tabulateCurve = (fn: CurveFunction): CurveFunction => {
  const table = new Float32Array(CURVE_TABLE_SIZE + 1);
  for (let i = 0; i <= CURVE_TABLE_SIZE; i++)
    table[i] = fn(i / CURVE_TABLE_SIZE);
  return (t: number): number => {
    if (t <= 0) return table[0];
    if (t >= 1) return table[CURVE_TABLE_SIZE];
    const x = t * CURVE_TABLE_SIZE;
    const i = x | 0;
    return table[i] + (table[i + 1] - table[i]) * (x - i);
  };
};

/**
 * How many points a ribbon is drawn with. The ring holds `length` raw
 * samples; with smoothing on, the Catmull-Rom spline through them is drawn
 * with `subdivisions` points per raw segment, so the curve shows between the
 * samples instead of being cut back to them.
 */
const trailSlotCount = (cfg: {
  length: number;
  smoothing: boolean;
  smoothingSubdivisions: number;
}): number =>
  cfg.smoothing
    ? (cfg.length - 1) * Math.max(1, Math.floor(cfg.smoothingSubdivisions)) + 1
    : cfg.length;

// Trail ribbon helpers (reused across frames to avoid allocations)
const _trailDir = new THREE.Vector3();
const _trailPerp = new THREE.Vector3();
const _trailToCam = new THREE.Vector3();
const _distanceStep = { x: 0, y: 0, z: 0 };
const _tempPosition = { x: 0, y: 0, z: 0 };
// Aggregated needsUpdate flags filled by applyModifiers — the attribute
// version counter is bumped once per frame instead of once per particle.
const _modifierUpdateFlags = { position: false, quat: false };
const _modifierParams = {
  delta: 0,
  generalData: null as unknown as GeneralData,
  normalizedConfig: null as unknown as NormalizedParticleSystemConfig,
  attributes: null as unknown as MappedAttributes,
  scalarArray: null as unknown as Float32Array,
  particleLifetimePercentage: 0,
  particleIndex: 0,
  updateFlags: _modifierUpdateFlags,
  elapsed: 0,
};
// Reusable parameter objects for the per-particle force-field / collision
// hot loops (avoids one or two object allocations per particle per frame).
const _forceFieldParams = {
  particleSystemId: 0,
  forceFields: null as unknown as Array<NormalizedForceFieldConfig>,
  velocity: null as unknown as THREE.Vector3,
  positionArr: null as unknown as THREE.TypedArray,
  positionIndex: 0,
  delta: 0,
  systemLifetimePercentage: 0,
};
const _collisionParams = {
  collisionPlanes: null as unknown as Array<NormalizedCollisionPlaneConfig>,
  velocity: null as unknown as THREE.Vector3,
  positionArr: null as unknown as THREE.TypedArray,
  positionIndex: 0,
  scalarArr: null as unknown as Float32Array,
  scalarBase: 0,
  deactivateParticle: null as unknown as (particleIndex: number) => void,
  particleIndex: 0,
};
// Scratch vector for onBeforeRender viewport queries (avoids a Vector2
// allocation every rendered frame).
const _viewportSize = new THREE.Vector2();
// Timestamp of the frame currently being processed by
// updateParticleSystemInstance — read by the per-system killParticle
// callbacks so they don't need a per-frame closure.
let _frameNow = 0;

/**
 * Converts a plain {x, y, z} object to a THREE.Vector3, using the fallback if undefined.
 */
const toVector3 = (
  v: { x?: number; y?: number; z?: number } | undefined,
  fallback: THREE.Vector3
): THREE.Vector3 =>
  v ? new THREE.Vector3(v.x ?? 0, v.y ?? 0, v.z ?? 0) : fallback.clone();

/**
 * Normalizes raw force field configs into the internal representation with THREE.Vector3 fields.
 */
const normalizeForceFields = (
  rawForceFields: Array<ForceFieldConfig> | undefined
): Array<NormalizedForceFieldConfig> =>
  (rawForceFields ?? []).map((ff: ForceFieldConfig) => ({
    isActive: ff.isActive ?? true,
    type: ff.type ?? ForceFieldType.POINT,
    position: toVector3(ff.position, new THREE.Vector3(0, 0, 0)),
    direction: toVector3(ff.direction, new THREE.Vector3(0, 1, 0)).normalize(),
    strength: ff.strength ?? 1,
    range: Math.max(0, ff.range ?? Infinity),
    falloff: ff.falloff ?? ForceFieldFalloff.LINEAR,
  }));

/**
 * Normalizes raw collision plane configs into the internal representation with THREE.Vector3 fields.
 */
const normalizeCollisionPlanes = (
  rawPlanes: Array<CollisionPlaneConfig> | undefined
): Array<NormalizedCollisionPlaneConfig> =>
  (rawPlanes ?? []).map((cp: CollisionPlaneConfig) => ({
    isActive: cp.isActive ?? true,
    position: toVector3(cp.position, new THREE.Vector3(0, 0, 0)),
    normal: toVector3(cp.normal, new THREE.Vector3(0, 1, 0)).normalize(),
    mode: cp.mode ?? CollisionPlaneMode.KILL,
    dampen: Math.max(0, Math.min(1, cp.dampen ?? 0.5)),
    lifetimeLoss: Math.max(0, Math.min(1, cp.lifetimeLoss ?? 0)),
    recover: Math.max(0, cp.recover ?? 0),
  }));

/**
 * Mapping of blending mode string identifiers to Three.js blending constants.
 *
 * Used for converting serialized particle system configurations (e.g., from JSON)
 * to actual Three.js blending mode constants.
 *
 * @example
 * ```typescript
 * import { blendingMap } from '@newkrok/three-particles';
 *
 * // Convert string to Three.js constant
 * const blending = blendingMap['THREE.AdditiveBlending'];
 * // blending === THREE.AdditiveBlending
 * ```
 */
export const blendingMap = {
  'THREE.NoBlending': THREE.NoBlending,
  'THREE.NormalBlending': THREE.NormalBlending,
  'THREE.AdditiveBlending': THREE.AdditiveBlending,
  'THREE.SubtractiveBlending': THREE.SubtractiveBlending,
  'THREE.MultiplyBlending': THREE.MultiplyBlending,
};

/**
 * Returns a deep copy of the default particle system configuration.
 *
 * This is useful when you want to start with default settings and modify specific properties
 * without affecting the internal default configuration object.
 *
 * @returns A new object containing all default particle system settings
 *
 * @example
 * ```typescript
 * import { getDefaultParticleSystemConfig, createParticleSystem } from '@newkrok/three-particles';
 *
 * // Get default config and modify it
 * const config = getDefaultParticleSystemConfig();
 * config.emission.rateOverTime = 100;
 * config.startColor.min = { r: 1, g: 0, b: 0 };
 *
 * const { instance } = createParticleSystem(config);
 * scene.add(instance);
 * ```
 */
export const getDefaultParticleSystemConfig = () =>
  JSON.parse(JSON.stringify(DEFAULT_PARTICLE_SYSTEM_CONFIG));

const DEFAULT_PARTICLE_SYSTEM_CONFIG: ParticleSystemConfig = {
  transform: {
    position: new THREE.Vector3(),
    rotation: new THREE.Vector3(),
    scale: new THREE.Vector3(1, 1, 1),
  },
  duration: 5.0,
  looping: true,
  startDelay: 0,
  startLifetime: 5.0,
  startSpeed: 1.0,
  startSize: 1.0,
  startOpacity: 1.0,
  startRotation: 0.0,
  startColor: {
    min: { r: 1.0, g: 1.0, b: 1.0 },
    max: { r: 1.0, g: 1.0, b: 1.0 },
  },
  gravity: 0.0,
  simulationSpace: SimulationSpace.LOCAL,
  simulationBackend: SimulationBackend.AUTO,
  maxParticles: 100.0,
  emission: {
    rateOverTime: 10.0,
    rateOverDistance: 0.0,
    bursts: [],
  },
  shape: {
    shape: Shape.SPHERE,
    sphere: {
      radius: 1.0,
      radiusThickness: 1.0,
      arc: 360.0,
    },
    cone: {
      angle: 25.0,
      radius: 1.0,
      radiusThickness: 1.0,
      arc: 360.0,
    },
    circle: {
      radius: 1.0,
      radiusThickness: 1.0,
      arc: 360.0,
    },
    rectangle: {
      rotation: { x: 0.0, y: 0.0, z: 0.0 },
      scale: { x: 1.0, y: 1.0 },
    },
    box: {
      scale: { x: 1.0, y: 1.0, z: 1.0 },
      emitFrom: EmitFrom.VOLUME,
    },
  },
  map: undefined,
  renderer: {
    blending: THREE.NormalBlending,
    discardBackgroundColor: false,
    backgroundColorTolerance: 1.0,
    backgroundColor: { r: 1.0, g: 1.0, b: 1.0 },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    softParticles: {
      enabled: false,
      intensity: 1.0,
    },
  },
  velocityOverLifetime: {
    isActive: false,
    linear: {
      x: 0,
      y: 0,
      z: 0,
    },
    orbital: {
      x: 0,
      y: 0,
      z: 0,
    },
  },
  sizeOverLifetime: {
    isActive: false,
    lifetimeCurve: {
      type: LifeTimeCurve.BEZIER,
      scale: 1,
      bezierPoints: [
        { x: 0, y: 0, percentage: 0 },
        { x: 1, y: 1, percentage: 1 },
      ],
    },
  },
  colorOverLifetime: {
    isActive: false,
    r: {
      type: LifeTimeCurve.BEZIER,
      scale: 1,
      bezierPoints: [
        { x: 0, y: 1, percentage: 0 },
        { x: 1, y: 1, percentage: 1 },
      ],
    },
    g: {
      type: LifeTimeCurve.BEZIER,
      scale: 1,
      bezierPoints: [
        { x: 0, y: 1, percentage: 0 },
        { x: 1, y: 1, percentage: 1 },
      ],
    },
    b: {
      type: LifeTimeCurve.BEZIER,
      scale: 1,
      bezierPoints: [
        { x: 0, y: 1, percentage: 0 },
        { x: 1, y: 1, percentage: 1 },
      ],
    },
  },
  opacityOverLifetime: {
    isActive: false,
    lifetimeCurve: {
      type: LifeTimeCurve.BEZIER,
      scale: 1,
      bezierPoints: [
        { x: 0, y: 0, percentage: 0 },
        { x: 1, y: 1, percentage: 1 },
      ],
    },
  },
  rotationOverLifetime: {
    isActive: false,
    min: 0.0,
    max: 0.0,
  },
  noise: {
    isActive: false,
    useRandomOffset: false,
    strength: 1.0,
    frequency: 0.5,
    octaves: 1,
    positionAmount: 1.0,
    rotationAmount: 0.0,
    sizeAmount: 0.0,
    curl: false,
    influence: { x: 1.0, y: 1.0, z: 1.0 },
    type: NoiseType.SIMPLEX,
    drift: { x: 0.15, y: 0.11, z: 0.13 },
  },
  particleColorInstance: {
    isActive: false,
    plane: ColorInstancePlane.XZ,
    area: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1 },
    wrap: ColorInstanceWrap.ZERO,
    offset: { x: 0, y: 0, z: 0 },
    spawnOnSource: true,
    useAlphaForOpacity: false,
    useLuminanceForNoise: false,
    luminanceNoiseAmount: 0,
    colorTweak: { saturation: 1, contrast: 1, hue: 0 },
    luminanceMap: { black: 0, white: 1 },
  },
  textureSheetAnimation: {
    tiles: new THREE.Vector2(1.0, 1.0),
    timeMode: TimeMode.LIFETIME,
    fps: 30.0,
    startFrame: 0,
  },
  forceFields: [],
  collisionPlanes: [],
  touch: {
    isActive: false,
    strength: 1,
    wake: 0.4,
    swirl: 0.3,
    normal: { x: 0, y: 1, z: 0 },
    radius: 0.12,
    maxSpeed: 8,
  },
};

const calculatePositionAndVelocity = (
  generalData: GeneralData,
  { shape, sphere, cone, circle, rectangle, box }: ShapeConfig,
  startSpeed: Constant | RandomBetweenTwoConstants | LifetimeCurve,
  position: THREE.Vector3,
  velocity: THREE.Vector3
) => {
  const calculatedStartSpeed = calculateValue(
    generalData.particleSystemId,
    startSpeed,
    generalData.normalizedLifetimePercentage
  );

  switch (shape) {
    case Shape.SPHERE:
      calculateRandomPositionAndVelocityOnSphere(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        sphere as Required<NonNullable<ShapeConfig['sphere']>>
      );
      break;

    case Shape.CONE:
      calculateRandomPositionAndVelocityOnCone(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        cone as Required<NonNullable<ShapeConfig['cone']>>
      );
      break;

    case Shape.CIRCLE:
      calculateRandomPositionAndVelocityOnCircle(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        circle as Required<NonNullable<ShapeConfig['circle']>>
      );
      break;

    case Shape.RECTANGLE:
      calculateRandomPositionAndVelocityOnRectangle(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        rectangle as Required<NonNullable<ShapeConfig['rectangle']>>
      );
      break;

    case Shape.BOX:
      calculateRandomPositionAndVelocityOnBox(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        box as Required<NonNullable<ShapeConfig['box']>>
      );
      break;
  }
};

const destroyParticleSystem = (particleSystem: THREE.Points | THREE.Mesh) => {
  createdParticleSystems = createdParticleSystems.filter(
    ({ particleSystem: savedParticleSystem, trailMesh, generalData }) => {
      if (savedParticleSystem !== particleSystem) {
        return true;
      }

      removeBezierCurveFunction(generalData.particleSystemId);

      // Stops a video source's frame watcher; a no-op for a still image.
      disposeColorInstanceData(generalData.colorInstance);

      // Dispose trail mesh if present
      if (trailMesh) {
        trailMesh.geometry.dispose();
        if (Array.isArray(trailMesh.material))
          trailMesh.material.forEach((m) => m.dispose());
        else trailMesh.material.dispose();
        if (trailMesh.parent) trailMesh.parent.remove(trailMesh);
      }

      savedParticleSystem.geometry.dispose();
      if (Array.isArray(savedParticleSystem.material))
        savedParticleSystem.material.forEach((material) => material.dispose());
      else savedParticleSystem.material.dispose();

      if (savedParticleSystem.parent)
        savedParticleSystem.parent.remove(savedParticleSystem);
      return false;
    }
  );
};

/**
 * Creates a new particle system with the specified configuration.
 *
 * This is the primary function for instantiating particle effects. It handles the complete
 * setup of a particle system including geometry creation, material configuration, shader setup,
 * and initialization of all particle properties.
 *
 * @param config - Configuration object for the particle system. If not provided, uses default settings.
 *                 See {@link ParticleSystemConfig} for all available options.
 * @param externalNow - Optional custom timestamp in milliseconds. If not provided, uses `Date.now()`.
 *                      Useful for synchronized particle systems or testing.
 *
 * @returns A {@link ParticleSystem} object containing:
 *   - `instance`: The THREE.Object3D that should be added to your scene
 *   - `resumeEmitter()`: Function to resume particle emission
 *   - `pauseEmitter()`: Function to pause particle emission
 *   - `dispose()`: Function to clean up resources and remove the particle system
 *
 * @example
 * ```typescript
 * import { createParticleSystem, updateParticleSystems } from '@newkrok/three-particles';
 *
 * // Create a basic particle system with default settings
 * const { instance, dispose } = createParticleSystem();
 * scene.add(instance);
 *
 * // Create a custom fire effect
 * const fireEffect = createParticleSystem({
 *   duration: 2.0,
 *   looping: true,
 *   startLifetime: { min: 0.5, max: 1.5 },
 *   startSpeed: { min: 2, max: 4 },
 *   startSize: { min: 0.5, max: 1.5 },
 *   startColor: {
 *     min: { r: 1.0, g: 0.3, b: 0.0 },
 *     max: { r: 1.0, g: 0.8, b: 0.0 }
 *   },
 *   emission: { rateOverTime: 50 },
 *   shape: {
 *     shape: Shape.CONE,
 *     cone: { angle: 10, radius: 0.2 }
 *   }
 * });
 * scene.add(fireEffect.instance);
 *
 * // In your animation loop
 * function animate(time) {
 *   updateParticleSystems({ now: time, delta: deltaTime, elapsed: elapsedTime });
 *   renderer.render(scene, camera);
 * }
 *
 * // Clean up when done
 * fireEffect.dispose();
 * ```
 *
 * @see {@link updateParticleSystems} - Required function to call in your animation loop
 * @see {@link ParticleSystemConfig} - Complete configuration options
 */
export const createParticleSystem = (
  config: ParticleSystemConfig = DEFAULT_PARTICLE_SYSTEM_CONFIG,
  externalNow?: number
): ParticleSystem => {
  const now = externalNow || Date.now();
  const generalData: GeneralData = {
    particleSystemId: _particleSystemId++,
    normalizedLifetimePercentage: 0,
    distanceFromLastEmitByDistance: 0,
    lastWorldPosition: new THREE.Vector3(-99999),
    currentWorldPosition: new THREE.Vector3(-99999),
    worldPositionChange: new THREE.Vector3(),
    sourceWorldMatrix: new THREE.Matrix4(),
    worldQuaternion: new THREE.Quaternion(),
    wrapperQuaternion: new THREE.Quaternion(),
    worldScale: new THREE.Vector3(1, 1, 1),
    worldEuler: new THREE.Euler(),
    gravityVelocity: new THREE.Vector3(0, 0, 0),
    startValues: {},
    linearVelocityData: undefined,
    orbitalVelocityData: undefined,
    lifetimeValues: {},
    creationTimes: [],
    cpuDirtyParticleWatermark: -1,
    noise: {
      isActive: false,
      strength: 0,
      noisePower: 0,
      frequency: 0.5,
      positionAmount: 0,
      rotationAmount: 0,
      sizeAmount: 0,
      curl: false,
      influence: { x: 1, y: 1, z: 1 },
      fbmMax: 1,
    },
    isEnabled: true,
  };
  const normalizedConfig = ObjectUtils.deepMerge(
    DEFAULT_PARTICLE_SYSTEM_CONFIG as NormalizedParticleSystemConfig,
    config,
    { applyToFirstObject: false, skippedProperties: [] }
  ) as NormalizedParticleSystemConfig;
  let particleMap: THREE.Texture | null =
    normalizedConfig.map ||
    (normalizedConfig.renderer.rendererType === RendererType.MESH
      ? createDefaultMeshTexture()
      : createDefaultParticleTexture());

  // Ensure ClampToEdgeWrapping for particle textures to prevent bleeding
  // at sprite-sheet tile boundaries (especially visible with WebGPU).
  if (particleMap) {
    particleMap.wrapS = THREE.ClampToEdgeWrapping;
    particleMap.wrapT = THREE.ClampToEdgeWrapping;
  }

  const {
    transform,
    duration,
    looping,
    startDelay,
    startLifetime,
    startSpeed,
    startSize,
    startRotation,
    startColor,
    startOpacity,
    gravity,
    simulationSpace,
    maxParticles,
    emission,
    shape,
    renderer,
    noise,
    velocityOverLifetime,
    onUpdate,
    onComplete,
    textureSheetAnimation,
    subEmitters,
    forceFields: rawForceFields,
  } = normalizedConfig;

  const normalizedForceFields: Array<NormalizedForceFieldConfig> =
    normalizeForceFields(rawForceFields);

  const normalizedCollisionPlanes: Array<NormalizedCollisionPlaneConfig> =
    normalizeCollisionPlanes(normalizedConfig.collisionPlanes);

  if (typeof renderer?.blending === 'string')
    renderer.blending = blendingMap[renderer.blending];

  // Pre-resolve lifetime-curve functions once. applyModifiers evaluates
  // size/opacity/color multipliers per particle per frame — resolving the
  // curve function there (bezier cache scan + closure allocations) dominated
  // the CPU-path modifier cost. Non-curve values (constants, random ranges)
  // stay undefined and fall back to calculateValue in applyModifiers.
  const resolveModifierCurve = (
    value: Constant | RandomBetweenTwoConstants | LifetimeCurve | undefined
  ): CurveFunction | undefined => {
    if (value === undefined || typeof value === 'number') return undefined;
    if (!isLifeTimeCurve(value)) return undefined;
    const fn = getCurveFunctionFromConfig(generalData.particleSystemId, value);
    const scale = value.scale ?? 1;
    return scale === 1 ? fn : (time: number) => fn(time) * scale;
  };

  const resolveModifierCurves = () => {
    const cfg = normalizedConfig;
    generalData.modifierCurves = {
      size: cfg.sizeOverLifetime.isActive
        ? resolveModifierCurve(cfg.sizeOverLifetime.lifetimeCurve)
        : undefined,
      opacity: cfg.opacityOverLifetime.isActive
        ? resolveModifierCurve(cfg.opacityOverLifetime.lifetimeCurve)
        : undefined,
      colorR: cfg.colorOverLifetime.isActive
        ? resolveModifierCurve(cfg.colorOverLifetime.r)
        : undefined,
      colorG: cfg.colorOverLifetime.isActive
        ? resolveModifierCurve(cfg.colorOverLifetime.g)
        : undefined,
      colorB: cfg.colorOverLifetime.isActive
        ? resolveModifierCurve(cfg.colorOverLifetime.b)
        : undefined,
    };
  };
  resolveModifierCurves();

  // Every slot's start position and velocity. The CPU path fills them all up
  // front (its position attribute starts from them); the GPU path only ever
  // touches a slot when it activates, so its vectors are made on first use —
  // at 200k particles that is 400k objects and 200k shape samples not made
  // at creation, which is what a slider drag pays for.
  const startPositions: THREE.Vector3[] = new Array(maxParticles);
  const velocities: THREE.Vector3[] = new Array(maxParticles);
  const ensureSlotVectors = (i: number): void => {
    if (!startPositions[i]) {
      startPositions[i] = new THREE.Vector3();
      velocities[i] = new THREE.Vector3();
    }
  };

  generalData.creationTimes = new Array(maxParticles).fill(0);

  // Free list for O(1) inactive particle lookup (stack, top = end of array)
  const freeList: Array<number> = Array.from(
    { length: maxParticles },
    (_, i) => maxParticles - 1 - i
  );

  // Extracted so updateConfig can re-run it when velocityOverLifetime
  // changes (previously the data arrays only existed when isActive was true
  // at creation, making live activation a silent no-op).
  const initVelocityLifetimeData = () => {
    const velocityOverLifetime = normalizedConfig.velocityOverLifetime;
    if (!velocityOverLifetime.isActive) {
      generalData.linearVelocityData = undefined;
      generalData.orbitalVelocityData = undefined;
      return;
    }
    generalData.linearVelocityData = Array.from(
      { length: maxParticles },
      () => ({
        speed: new THREE.Vector3(
          velocityOverLifetime.linear.x
            ? calculateValue(
                generalData.particleSystemId,
                velocityOverLifetime.linear.x,
                0
              )
            : 0,
          velocityOverLifetime.linear.y
            ? calculateValue(
                generalData.particleSystemId,
                velocityOverLifetime.linear.y,
                0
              )
            : 0,
          velocityOverLifetime.linear.z
            ? calculateValue(
                generalData.particleSystemId,
                velocityOverLifetime.linear.z,
                0
              )
            : 0
        ),
        valueModifiers: {
          x: isLifeTimeCurve(velocityOverLifetime.linear.x || 0)
            ? getCurveFunctionFromConfig(
                generalData.particleSystemId,
                velocityOverLifetime.linear.x as LifetimeCurve
              )
            : undefined,
          y: isLifeTimeCurve(velocityOverLifetime.linear.y || 0)
            ? getCurveFunctionFromConfig(
                generalData.particleSystemId,
                velocityOverLifetime.linear.y as LifetimeCurve
              )
            : undefined,
          z: isLifeTimeCurve(velocityOverLifetime.linear.z || 0)
            ? getCurveFunctionFromConfig(
                generalData.particleSystemId,
                velocityOverLifetime.linear.z as LifetimeCurve
              )
            : undefined,
        },
      })
    );

    generalData.orbitalVelocityData = Array.from(
      { length: maxParticles },
      () => ({
        speed: new THREE.Vector3(
          velocityOverLifetime.orbital.x
            ? calculateValue(
                generalData.particleSystemId,
                velocityOverLifetime.orbital.x,
                0
              )
            : 0,
          velocityOverLifetime.orbital.y
            ? calculateValue(
                generalData.particleSystemId,
                velocityOverLifetime.orbital.y,
                0
              )
            : 0,
          velocityOverLifetime.orbital.z
            ? calculateValue(
                generalData.particleSystemId,
                velocityOverLifetime.orbital.z,
                0
              )
            : 0
        ),
        valueModifiers: {
          x: isLifeTimeCurve(velocityOverLifetime.orbital.x || 0)
            ? getCurveFunctionFromConfig(
                generalData.particleSystemId,
                velocityOverLifetime.orbital.x as LifetimeCurve
              )
            : undefined,
          y: isLifeTimeCurve(velocityOverLifetime.orbital.y || 0)
            ? getCurveFunctionFromConfig(
                generalData.particleSystemId,
                velocityOverLifetime.orbital.y as LifetimeCurve
              )
            : undefined,
          z: isLifeTimeCurve(velocityOverLifetime.orbital.z || 0)
            ? getCurveFunctionFromConfig(
                generalData.particleSystemId,
                velocityOverLifetime.orbital.z as LifetimeCurve
              )
            : undefined,
        },
        positionOffset: new THREE.Vector3(),
      })
    );
  };
  initVelocityLifetimeData();

  const startValueKeys: Array<keyof NormalizedParticleSystemConfig> = [
    'startSize',
    'startOpacity',
  ];
  // Activation writes a slot's start values before anything reads them, so
  // the arrays only need to exist — not 200k calculateValue calls up front.
  startValueKeys.forEach((key) => {
    generalData.startValues[key] = new Array(maxParticles).fill(0);
  });

  generalData.startValues.startColorR = Array.from(
    { length: maxParticles },
    () => 0
  );
  generalData.startValues.startColorG = Array.from(
    { length: maxParticles },
    () => 0
  );
  generalData.startValues.startColorB = Array.from(
    { length: maxParticles },
    () => 0
  );
  // The start opacity as drawn, before the colour source's alpha (or its
  // absence) is folded in — what a live recolour restores from.
  generalData.startValues.baseOpacity = Array.from(
    { length: maxParticles },
    () => 1
  );

  // Extracted so updateConfig can re-run it when rotationOverLifetime changes.
  const initRotationLifetimeValues = () => {
    const value = normalizedConfig.rotationOverLifetime as {
      isActive: boolean;
    } & RandomBetweenTwoConstants;
    if (value.isActive) {
      generalData.lifetimeValues.rotationOverLifetime = Array.from(
        { length: maxParticles },
        () => THREE.MathUtils.randFloat(value.min!, value.max!)
      );
    } else {
      delete generalData.lifetimeValues.rotationOverLifetime;
    }
  };
  initRotationLifetimeValues();

  // Pre-compute FBM normalisation divisor once (avoids recalculating every frame).
  // fbmMax = 1 + 0.5 + 0.25 + ... = 2 - 2^(-octaves)
  const fbmMax = 2 - Math.pow(2, -noise.octaves);

  generalData.noise = {
    isActive: noise.isActive,
    strength: noise.strength,
    noisePower: 0.15 * noise.strength,
    frequency: noise.frequency,
    positionAmount: noise.positionAmount,
    rotationAmount: noise.rotationAmount,
    sizeAmount: noise.sizeAmount,
    curl: !!noise.curl,
    influence: {
      x: noise.influence?.x ?? 1,
      y: noise.influence?.y ?? 1,
      z: noise.influence?.z ?? 1,
    },
    type: noise.type ?? NoiseType.SIMPLEX,
    drift: {
      x: noise.drift?.x ?? DEFAULT_DRIFT.x,
      y: noise.drift?.y ?? DEFAULT_DRIFT.y,
      z: noise.drift?.z ?? DEFAULT_DRIFT.z,
    },
    fbmMax,
    sampler: noise.isActive
      ? new FBM({
          seed: Math.random(),
          scale: noise.frequency,
          octaves: noise.octaves,
        })
      : undefined,
    // Drawn afresh at every activation; the array only has to exist.
    offsets: noise.useRandomOffset
      ? new Array(maxParticles).fill(0)
      : undefined,
  };

  const colorInstanceConfig = normalizedConfig.particleColorInstance;
  generalData.colorInstance = colorInstanceConfig?.isActive
    ? createColorInstanceData(colorInstanceConfig)
    : undefined;

  // Initialize burst states if bursts are configured
  if (emission.bursts && emission.bursts.length > 0) {
    generalData.burstStates = emission.bursts.map(() => ({
      cyclesExecuted: 0,
      lastCycleTime: 0,
      probabilityPassed: false,
    }));
  }

  const useTrail = renderer.rendererType === RendererType.TRAIL;
  const useMesh = renderer.rendererType === RendererType.MESH;
  const useInstancing =
    !useTrail && !useMesh && renderer.rendererType === RendererType.INSTANCED;
  // TSL materials whenever the factory is registered (a WebGPURenderer wants
  // NodeMaterials even for the CPU simulation); GPU compute when the factory
  // can also drive it and the config does not ask for the CPU.
  const useTSL = _tslMaterialFactory !== null;
  const gpuComputeAvailable =
    useTSL &&
    normalizedConfig.simulationBackend !== SimulationBackend.CPU &&
    !!_tslMaterialFactory?.createComputePipeline &&
    !!_tslMaterialFactory.writeParticleToModifierBuffers &&
    !!_tslMaterialFactory.deactivateParticleInModifierBuffers &&
    !!_tslMaterialFactory.flushEmitQueue;
  // A trail rides the GPU only when the factory can build its ribbon there:
  // the kernel records the history ring and the ribbon's vertex stage reads
  // it. Otherwise the trail keeps the CPU simulation and the CPU-built ribbon.
  const useGPUTrail =
    useTrail &&
    gpuComputeAvailable &&
    !!_tslMaterialFactory?.createTSLGpuTrailMaterial;
  const useGPUCompute = gpuComputeAvailable && (!useTrail || useGPUTrail);
  const useInstancedAttributes = useInstancing || useMesh || useGPUTrail;

  // Trail config defaults
  const defaultTrailCurve: LifetimeCurve = {
    type: LifeTimeCurve.BEZIER,
    scale: 1,
    bezierPoints: [
      { x: 0, y: 1, percentage: 0 },
      { x: 1, y: 0, percentage: 1 },
    ],
  };
  const trailConfig = useTrail
    ? {
        length: renderer.trail?.length ?? 20,
        width: renderer.trail?.width ?? 1.0,
        widthOverTrail: normalizeTrailCurve(
          renderer.trail?.widthOverTrail,
          defaultTrailCurve
        ),
        opacityOverTrail: normalizeTrailCurve(
          renderer.trail?.opacityOverTrail,
          defaultTrailCurve
        ),
        colorOverTrail: renderer.trail?.colorOverTrail,
        minVertexDistance: renderer.trail?.minVertexDistance ?? 0,
        maxTime: renderer.trail?.maxTime ?? 0,
        smoothing: renderer.trail?.smoothing ?? false,
        smoothingSubdivisions: renderer.trail?.smoothingSubdivisions ?? 3,
        twistPrevention: renderer.trail?.twistPrevention ?? false,
        ribbonId: renderer.trail?.ribbonId,
      }
    : undefined;

  // Initialize trail position history buffers
  if (useTrail && trailConfig && !useGPUTrail) {
    const trailLength = trailConfig.length;
    generalData.trailLength = trailLength;
    generalData.trailSlotCount = trailSlotCount(trailConfig);
    generalData.positionHistory = new Float32Array(
      maxParticles * trailLength * 3
    );
    generalData.positionHistoryIndex = new Uint16Array(maxParticles);
    generalData.positionHistoryCount = new Uint16Array(maxParticles);
    // Tracks how many vertex slots were filled last frame per particle so the
    // trail rebuild only clears slots that actually held data.
    generalData.trailPrevFilledCount = new Uint16Array(maxParticles);

    // Adaptive sampling: track last sampled position per particle
    if (trailConfig.minVertexDistance > 0) {
      generalData.trailLastSampledPosition = new Float32Array(maxParticles * 3);
    }

    // Max time: track timestamp of each history sample
    if (trailConfig.maxTime > 0) {
      generalData.trailSampleTimes = new Float64Array(
        maxParticles * trailLength
      );
    }

    // Twist prevention: store previous ribbon normal per particle
    if (trailConfig.twistPrevention) {
      generalData.trailPrevNormal = new Float32Array(maxParticles * 3);
    }
  }

  // Attribute name prefix: instanced/mesh renderers use 'instance'-prefixed names
  // to avoid collision with the base geometry's own 'position' attribute.
  const attr = (name: string) =>
    useInstancedAttributes
      ? `instance${name.charAt(0).toUpperCase()}${name.slice(1)}`
      : name;

  // Position attribute is special: Points uses 'position', instanced/mesh uses 'instanceOffset'
  const posAttr = useInstancedAttributes ? 'instanceOffset' : 'position';

  const softParticlesEnabled = !!(
    renderer.softParticles?.enabled && renderer.softParticles?.depthTexture
  );

  const sharedUniforms: Record<string, { value: unknown }> = {
    elapsed: { value: 0.0 },
    map: { value: particleMap },
    tiles: {
      value: new THREE.Vector2(
        textureSheetAnimation.tiles?.x ?? 1,
        textureSheetAnimation.tiles?.y ?? 1
      ),
    },
    fps: { value: textureSheetAnimation.fps },
    useFPSForFrameIndex: {
      value: textureSheetAnimation.timeMode === TimeMode.FPS,
    },
    // backgroundColor is authored in sRGB; convert to linear so the
    // fragment comparison against the (now linear) texture sample is valid.
    backgroundColor: { value: rgbSRGBToLinear(renderer.backgroundColor) },
    discardBackgroundColor: { value: renderer.discardBackgroundColor },
    backgroundColorTolerance: { value: renderer.backgroundColorTolerance },
    ...(useInstancing ? { viewportHeight: { value: 1.0 } } : {}),
    softParticlesEnabled: { value: softParticlesEnabled },
    softParticlesIntensity: {
      value: Math.max(renderer.softParticles?.intensity ?? 1.0, 0.001),
    },
    sceneDepthTexture: {
      value: renderer.softParticles?.depthTexture ?? null,
    },
    cameraNearFar: { value: new THREE.Vector2(0.1, 1000.0) },
    // Per-axis mesh scale (MESH renderer only); ignored by the other renderers.
    meshScale: {
      value: new THREE.Vector3(
        renderer.mesh?.scale?.x ?? 1,
        renderer.mesh?.scale?.y ?? 1,
        renderer.mesh?.scale?.z ?? 1
      ),
    },
  };

  const getVertexShader = () => {
    if (useMesh) return MeshParticleVertexShader;
    if (useInstancing) return InstancedParticleVertexShader;
    return ParticleSystemVertexShader;
  };

  const getFragmentShader = () => {
    if (useMesh) return MeshParticleFragmentShader;
    if (useInstancing) return InstancedParticleFragmentShader;
    return ParticleSystemFragmentShader;
  };

  // Create GPU compute pipeline when active
  type GPUComputePipeline =
    import('./webgpu/compute-modifiers.js').ModifierComputePipeline;
  let gpuPipeline: GPUComputePipeline | null = null;

  // The finger trail, when fingers are allowed to move the particles.
  const touchWake = normalizedConfig.touch?.isActive
    ? new TouchWakeState()
    : null;

  if (useGPUCompute) {
    const pipelineArgs = [
      maxParticles,
      useInstancedAttributes,
      normalizedConfig,
      generalData.particleSystemId,
      normalizedForceFields.length,
      normalizedCollisionPlanes.length,
      !!touchWake,
    ] as const;
    gpuPipeline =
      useGPUTrail && trailConfig
        ? _tslMaterialFactory!.createComputePipeline!(...pipelineArgs, {
            length: trailConfig.length,
            minVertexDistance: trailConfig.minVertexDistance,
          })
        : _tslMaterialFactory!.createComputePipeline!(...pipelineArgs);
    // The ring may have been shortened to fit the storage binding limit.
    if (useGPUTrail && trailConfig && gpuPipeline?.trailHistoryInfo) {
      trailConfig.length = gpuPipeline.trailHistoryInfo.length;
    }
    // Register the curveDataLength so the init data helpers know the offset.
    if (gpuPipeline && _tslMaterialFactory!.registerCurveDataLength) {
      _tslMaterialFactory!.registerCurveDataLength(
        gpuPipeline.buffers,
        gpuPipeline.curveDataLength
      );
    }
  }

  const rendererConfig = {
    transparent: renderer.transparent,
    blending: renderer.blending,
    depthTest: renderer.depthTest,
    depthWrite: renderer.depthWrite,
  };

  // The mesh's own depth along its local +Z: the velocity stretch adds a
  // streak in world units, so the shader has to know how long the shape
  // already is before it can lengthen it by exactly that much.
  let meshExtentZ = 1;
  if (useMesh && renderer.mesh?.geometry) {
    const meshGeometry = renderer.mesh.geometry;
    if (!meshGeometry.boundingBox) meshGeometry.computeBoundingBox();
    if (meshGeometry.boundingBox) {
      meshExtentZ = Math.max(
        meshGeometry.boundingBox.max.z - meshGeometry.boundingBox.min.z,
        1e-4
      );
    }
  }

  // The GPU-built ribbon's uniforms (the CPU-built one makes its own below).
  const gpuTrailUniformValues = useGPUTrail
    ? {
        map: { value: particleMap },
        useMap: { value: !!particleMap },
        discardBackgroundColor: { value: renderer.discardBackgroundColor },
        backgroundColor: { value: rgbSRGBToLinear(renderer.backgroundColor) },
        backgroundColorTolerance: { value: renderer.backgroundColorTolerance },
        softParticlesEnabled: { value: softParticlesEnabled },
        softParticlesIntensity: {
          value: Math.max(renderer.softParticles?.intensity ?? 1.0, 0.001),
        },
        sceneDepthTexture: {
          value: renderer.softParticles?.depthTexture ?? null,
        },
        cameraNearFar: { value: new THREE.Vector2(0.1, 1000.0) },
      }
    : null;

  const material: THREE.Material =
    useGPUTrail &&
    gpuTrailUniformValues &&
    trailConfig &&
    gpuPipeline?.trailHistoryInfo
      ? _tslMaterialFactory!.createTSLGpuTrailMaterial!(
          gpuTrailUniformValues,
          rendererConfig,
          {
            curveData: gpuPipeline.buffers.curveData,
            historyOffset: gpuPipeline.trailHistoryInfo.offset,
            length: gpuPipeline.trailHistoryInfo.length,
            curveMap: gpuPipeline.curveMap,
            width: trailConfig.width,
            maxTime: trailConfig.maxTime,
            smoothing: trailConfig.smoothing,
            smoothingSubdivisions: trailConfig.smoothingSubdivisions,
          }
        )
      : useTSL
        ? _tslMaterialFactory!.createTSLParticleMaterial(
            renderer.rendererType ?? RendererType.POINTS,
            sharedUniforms,
            rendererConfig,
            useGPUCompute,
            !!renderer.mesh?.alignToVelocity,
            !!renderer.mesh?.lit,
            renderer.mesh?.emissive ?? 0,
            renderer.mesh?.roughness,
            renderer.mesh?.metalness,
            renderer.mesh?.velocityStretch ?? 0,
            meshExtentZ
          )
        : new THREE.ShaderMaterial({
            uniforms: sharedUniforms,
            vertexShader: getVertexShader(),
            fragmentShader: getFragmentShader(),
            ...rendererConfig,
          });

  let geometry: THREE.BufferGeometry | THREE.InstancedBufferGeometry;

  if (useMesh) {
    const meshConfig = renderer.mesh;
    if (!meshConfig?.geometry) {
      throw new Error(
        'RendererType.MESH requires a mesh configuration with a geometry. ' +
          'Set renderer.mesh.geometry to a THREE.BufferGeometry instance.'
      );
    }
    const instancedGeometry = new THREE.InstancedBufferGeometry();
    // Copy base mesh geometry attributes (position, normal, uv, index)
    const sourceGeom = meshConfig.geometry;
    const srcPos = sourceGeom.getAttribute('position');
    if (srcPos) instancedGeometry.setAttribute('position', srcPos);
    const srcNormal = sourceGeom.getAttribute('normal');
    if (srcNormal) instancedGeometry.setAttribute('normal', srcNormal);
    const srcUv = sourceGeom.getAttribute('uv');
    if (srcUv) instancedGeometry.setAttribute('uv', srcUv);
    const srcIndex = sourceGeom.getIndex();
    if (srcIndex) instancedGeometry.setIndex(srcIndex);
    instancedGeometry.instanceCount = maxParticles;
    geometry = instancedGeometry;
  } else if (useGPUTrail && trailConfig) {
    // The strip the GPU expands into a ribbon: `length` slots × two sides,
    // position = (slot, side, 0). Everything else the vertex stage reads from
    // the particle's history ring in the compute pipeline's storage buffer.
    const instancedGeometry = new THREE.InstancedBufferGeometry();
    const slots = trailSlotCount(trailConfig);
    const stripPositions = new Float32Array(slots * 2 * 3);
    for (let sIdx = 0; sIdx < slots; sIdx++) {
      stripPositions[sIdx * 6] = sIdx;
      stripPositions[sIdx * 6 + 1] = -1;
      stripPositions[sIdx * 6 + 3] = sIdx;
      stripPositions[sIdx * 6 + 4] = 1;
    }
    const stripIndices = new Uint32Array((slots - 1) * 6);
    for (let sIdx = 0; sIdx < slots - 1; sIdx++) {
      const i = sIdx * 6;
      const v = sIdx * 2;
      stripIndices[i] = v;
      stripIndices[i + 1] = v + 1;
      stripIndices[i + 2] = v + 2;
      stripIndices[i + 3] = v + 1;
      stripIndices[i + 4] = v + 3;
      stripIndices[i + 5] = v + 2;
    }
    instancedGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(stripPositions, 3)
    );
    instancedGeometry.setIndex(new THREE.BufferAttribute(stripIndices, 1));
    instancedGeometry.instanceCount = maxParticles;
    geometry = instancedGeometry;
  } else if (useInstancing) {
    const instancedGeometry = new THREE.InstancedBufferGeometry();
    // Base quad: 1x1 plane centred at origin (vertices from -0.5 to 0.5)
    const quadPositions = new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]);
    const quadIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    instancedGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(quadPositions, 3)
    );
    instancedGeometry.setIndex(new THREE.BufferAttribute(quadIndices, 1));
    instancedGeometry.instanceCount = maxParticles;
    geometry = instancedGeometry;
  } else {
    geometry = new THREE.BufferGeometry();
  }

  // The CPU path starts every slot on the shape (its position attribute is
  // filled from these below); the GPU path samples the shape at activation.
  if (!useGPUCompute) {
    for (let i = 0; i < maxParticles; i++) {
      ensureSlotVectors(i);
      calculatePositionAndVelocity(
        generalData,
        shape,
        startSpeed,
        startPositions[i],
        velocities[i]
      );
    }
  }

  // Create interleaved buffer for all scalar per-particle attributes.
  // In GPU compute mode this is kept for CPU death detection reads only
  // (not set as geometry attributes — storage buffers are used instead).
  const scalarArray = new Float32Array(maxParticles * SCALAR_STRIDE);

  // Pre-fill initial values
  for (let i = 0; i < maxParticles; i++) {
    const base = i * SCALAR_STRIDE;
    scalarArray[base + S_IS_ACTIVE] = 0;
    scalarArray[base + S_LIFETIME] = 0;
    scalarArray[base + S_START_LIFETIME] =
      calculateValue(generalData.particleSystemId, startLifetime, 0) * 1000;
    scalarArray[base + S_START_FRAME] = textureSheetAnimation.startFrame
      ? calculateValue(
          generalData.particleSystemId,
          textureSheetAnimation.startFrame,
          0
        )
      : 0;
    scalarArray[base + S_SIZE] = generalData.startValues.startSize[i];
    scalarArray[base + S_ROTATION] = 0;
    // User color inputs are sRGB; the buffer stores linear so that shader
    // math, texture modulation, and the renderer's linear→sRGB output pass
    // all agree. See docs/color-pipeline-standardization-plan.md.
    const colorRandomRatio = Math.random();
    scalarArray[base + S_COLOR_R] = sRGBToLinear(
      startColor.min!.r! +
        colorRandomRatio * (startColor.max!.r! - startColor.min!.r!)
    );
    scalarArray[base + S_COLOR_G] = sRGBToLinear(
      startColor.min!.g! +
        colorRandomRatio * (startColor.max!.g! - startColor.min!.g!)
    );
    scalarArray[base + S_COLOR_B] = sRGBToLinear(
      startColor.min!.b! +
        colorRandomRatio * (startColor.max!.b! - startColor.min!.b!)
    );
    scalarArray[base + S_COLOR_A] = 0;
  }

  // Always create the interleaved buffer (needed for CPU death detection
  // and the CPU rendering path)
  const scalarInterleavedBuffer = useInstancedAttributes
    ? new THREE.InstancedInterleavedBuffer(scalarArray, SCALAR_STRIDE)
    : new THREE.InterleavedBuffer(scalarArray, SCALAR_STRIDE);
  // The scalar buffer is rewritten every frame on the CPU path — tell the
  // driver so it allocates the GL buffer accordingly.
  scalarInterleavedBuffer.setUsage(THREE.DynamicDrawUsage);

  if (useGPUCompute && gpuPipeline) {
    // ── GPU Compute Path: use storage buffers as geometry attributes ──
    // StorageBufferAttribute extends BufferAttribute, so these work as
    // geometry attributes read by the TSL material.
    // GPU path: 5 geometry attributes total (under 8 vertex buffer limit)
    //   1. base quad position (for instanced/mesh)
    //   2. particle position (vec3)
    //   3. color (vec4: R,G,B,A)
    //   4. particleState (vec4: lifetime, size, rotation, startFrame)
    //   5. startValues (vec4: startLifetime, startSize, startOpacity, startColorR)
    const gpuBuf = gpuPipeline.buffers;
    geometry.setAttribute(posAttr, gpuBuf.position);
    geometry.setAttribute(attr('color'), gpuBuf.color);
    geometry.setAttribute(attr('particleState'), gpuBuf.particleState);
    geometry.setAttribute(attr('startValues'), gpuBuf.startValues);
    // Velocity is only needed by the vertex stage for velocity-aligned meshes;
    // binding it unconditionally would spend a vertex buffer slot for nothing.
    if (
      useGPUTrail ||
      (useMesh &&
        (renderer.mesh?.alignToVelocity ||
          (renderer.mesh?.velocityStretch ?? 0) > 0))
    ) {
      geometry.setAttribute(attr('velocity'), gpuBuf.velocity);
    }
  } else {
    // ── CPU Path: position + interleaved scalar attributes ──
    const positionArray = new Float32Array(maxParticles * 3);
    for (let i = 0; i < maxParticles; i++) {
      positionArray[i * 3] = startPositions[i].x;
      positionArray[i * 3 + 1] = startPositions[i].y;
      positionArray[i * 3 + 2] = startPositions[i].z;
    }
    const positionAttribute = useInstancedAttributes
      ? new THREE.InstancedBufferAttribute(positionArray, 3)
      : new THREE.BufferAttribute(positionArray, 3);
    // Positions are integrated every frame — dynamic usage hint for the driver.
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(posAttr, positionAttribute);

    geometry.setAttribute(
      attr('isActive'),
      new THREE.InterleavedBufferAttribute(
        scalarInterleavedBuffer,
        1,
        S_IS_ACTIVE
      )
    );
    geometry.setAttribute(
      attr('lifetime'),
      new THREE.InterleavedBufferAttribute(
        scalarInterleavedBuffer,
        1,
        S_LIFETIME
      )
    );
    geometry.setAttribute(
      attr('startLifetime'),
      new THREE.InterleavedBufferAttribute(
        scalarInterleavedBuffer,
        1,
        S_START_LIFETIME
      )
    );
    geometry.setAttribute(
      attr('startFrame'),
      new THREE.InterleavedBufferAttribute(
        scalarInterleavedBuffer,
        1,
        S_START_FRAME
      )
    );
    geometry.setAttribute(
      attr('size'),
      new THREE.InterleavedBufferAttribute(scalarInterleavedBuffer, 1, S_SIZE)
    );
    geometry.setAttribute(
      attr('rotation'),
      new THREE.InterleavedBufferAttribute(
        scalarInterleavedBuffer,
        1,
        S_ROTATION
      )
    );
    // Packed RGBA color as single vec4 (R/G/B/A are contiguous in the
    // interleaved buffer at offsets 6,7,8,9 — read as a vec4 from offset 6)
    geometry.setAttribute(
      attr('color'),
      new THREE.InterleavedBufferAttribute(
        scalarInterleavedBuffer,
        4,
        S_COLOR_R
      )
    );
  }

  // Packed quaternion vec4 attribute for 3D mesh rotation (only for MESH renderer,
  // CPU path only — GPU compute derives quaternion from particleState.z in the shader)
  if (useMesh && !useGPUCompute) {
    const quatArray = new Float32Array(maxParticles * 4);
    // Initialize to identity quaternion (0, 0, 0, 1)
    for (let i = 0; i < maxParticles; i++) {
      quatArray[i * 4 + 3] = 1; // w = 1
    }
    geometry.setAttribute(
      attr('quat'),
      new THREE.InstancedBufferAttribute(quatArray, 4)
    );
  }

  // Resolve per-particle attribute accessors (instanced/mesh uses prefixed names)
  const a = geometry.attributes;
  const aIsActive = a[attr('isActive')];
  const aColor = a[attr('color')];
  const aStartFrame = a[attr('startFrame')];
  const aStartLifetime = a[attr('startLifetime')];
  const aSize = a[attr('size')];
  const aRotation = a[attr('rotation')];
  const aLifetime = a[attr('lifetime')];
  const aPosition = a[posAttr];
  const aQuat = useMesh && !useGPUCompute ? a[attr('quat')] : undefined;

  const deactivateParticle = (particleIndex: number) => {
    const base = particleIndex * SCALAR_STRIDE;
    scalarArray[base + S_IS_ACTIVE] = 0;
    scalarArray[base + S_COLOR_A] = 0;
    if (useGPUCompute && gpuPipeline) {
      _tslMaterialFactory!.deactivateParticleInModifierBuffers!(
        gpuPipeline.buffers,
        particleIndex
      );
    } else {
      if (particleIndex > generalData.cpuDirtyParticleWatermark)
        generalData.cpuDirtyParticleWatermark = particleIndex;
      scalarInterleavedBuffer.needsUpdate = true;
    }
    freeList.push(particleIndex);
  };

  const activateParticle = ({
    particleIndex,
    activationTime,
    position,
  }: {
    particleIndex: number;
    activationTime: number;
    position: Required<Point3D>;
  }) => {
    const base = particleIndex * SCALAR_STRIDE;
    scalarArray[base + S_IS_ACTIVE] = 1;
    generalData.creationTimes[particleIndex] = activationTime;

    // Reset trail history so a recycled particle doesn't inherit old trail
    if (generalData.positionHistoryCount) {
      generalData.positionHistoryCount[particleIndex] = 0;
      generalData.positionHistoryIndex![particleIndex] = 0;

      // Reset adaptive sampling last position
      if (generalData.trailLastSampledPosition) {
        const lsIdx = particleIndex * 3;
        generalData.trailLastSampledPosition[lsIdx] = 0;
        generalData.trailLastSampledPosition[lsIdx + 1] = 0;
        generalData.trailLastSampledPosition[lsIdx + 2] = 0;
      }

      // Reset twist prevention normal
      if (generalData.trailPrevNormal) {
        const nIdx = particleIndex * 3;
        generalData.trailPrevNormal[nIdx] = 0;
        generalData.trailPrevNormal[nIdx + 1] = 0;
        generalData.trailPrevNormal[nIdx + 2] = 0;
      }
    }

    if (generalData.noise.offsets)
      generalData.noise.offsets[particleIndex] = Math.random() * 100;

    // sRGB → linear on emit; buffer + startValues mirrors both store linear.
    // See docs/color-pipeline-standardization-plan.md.
    const colorRandomRatio = Math.random();
    const cfgStartColor = normalizedConfig.startColor;

    scalarArray[base + S_COLOR_R] = sRGBToLinear(
      cfgStartColor.min!.r! +
        colorRandomRatio * (cfgStartColor.max!.r! - cfgStartColor.min!.r!)
    );

    scalarArray[base + S_COLOR_G] = sRGBToLinear(
      cfgStartColor.min!.g! +
        colorRandomRatio * (cfgStartColor.max!.g! - cfgStartColor.min!.g!)
    );

    scalarArray[base + S_COLOR_B] = sRGBToLinear(
      cfgStartColor.min!.b! +
        colorRandomRatio * (cfgStartColor.max!.b! - cfgStartColor.min!.b!)
    );

    generalData.startValues.startColorR[particleIndex] =
      scalarArray[base + S_COLOR_R];
    generalData.startValues.startColorG[particleIndex] =
      scalarArray[base + S_COLOR_G];
    generalData.startValues.startColorB[particleIndex] =
      scalarArray[base + S_COLOR_B];

    scalarArray[base + S_START_FRAME] = normalizedConfig.textureSheetAnimation
      .startFrame
      ? calculateValue(
          generalData.particleSystemId,
          normalizedConfig.textureSheetAnimation.startFrame,
          0
        )
      : 0;

    scalarArray[base + S_START_LIFETIME] =
      calculateValue(
        generalData.particleSystemId,
        normalizedConfig.startLifetime,
        generalData.normalizedLifetimePercentage
      ) * 1000;

    generalData.startValues.startSize[particleIndex] = calculateValue(
      generalData.particleSystemId,
      normalizedConfig.startSize,
      generalData.normalizedLifetimePercentage
    );
    scalarArray[base + S_SIZE] =
      generalData.startValues.startSize[particleIndex];

    generalData.startValues.startOpacity[particleIndex] = calculateValue(
      generalData.particleSystemId,
      normalizedConfig.startOpacity,
      generalData.normalizedLifetimePercentage
    );
    scalarArray[base + S_COLOR_A] =
      generalData.startValues.startOpacity[particleIndex];
    generalData.startValues.baseOpacity[particleIndex] =
      generalData.startValues.startOpacity[particleIndex];

    scalarArray[base + S_ROTATION] = calculateValue(
      generalData.particleSystemId,
      normalizedConfig.startRotation,
      generalData.normalizedLifetimePercentage
    );

    // Initialize mesh particle quaternion from the Z-rotation startRotation
    if (aQuat) {
      const rotZ = scalarArray[base + S_ROTATION];
      const halfZ = rotZ * 0.5;
      const qi = particleIndex * 4;
      aQuat.array[qi] = 0;
      aQuat.array[qi + 1] = 0;
      aQuat.array[qi + 2] = Math.sin(halfZ);
      aQuat.array[qi + 3] = Math.cos(halfZ);
      aQuat.needsUpdate = true;
    }

    // Guard on the backing array, not just isActive. When rotationOverLifetime
    // is toggled live via updateConfig() the flag and its per-particle array
    // are updated together, but a particle can still activate in a window where
    // the array is absent (e.g. the flag lingers true from a merge while the
    // array was deleted). Mirrors the linear/orbital velocity-data guards below
    // and prevents "Cannot set properties of undefined".
    if (
      normalizedConfig.rotationOverLifetime.isActive &&
      generalData.lifetimeValues.rotationOverLifetime
    )
      generalData.lifetimeValues.rotationOverLifetime[particleIndex] =
        THREE.MathUtils.randFloat(
          normalizedConfig.rotationOverLifetime.min!,
          normalizedConfig.rotationOverLifetime.max!
        );

    ensureSlotVectors(particleIndex);
    calculatePositionAndVelocity(
      generalData,
      normalizedConfig.shape,
      normalizedConfig.startSpeed,
      startPositions[particleIndex],
      velocities[particleIndex]
    );

    // The colour source, sampled where this particle is born. Where the
    // source covers only part of the emitter (wrap ZERO) or has texels with
    // no alpha, a birth that lands on nothing is drawn again until it lands
    // on something — the emitter effectively shrinks to the source and the
    // whole budget goes to the picture. One that never lands is nothing:
    // black, invisible, free to move. The sample is used by the colour
    // block below; nothing samples in between.
    const ci = generalData.colorInstance;
    const ciReady = !!(ci?.isActive && ensureColorInstancePixels(ci));
    if (ciReady) {
      const rectScale = normalizedConfig.shape.rectangle?.scale;
      const rectWidth = rectScale?.x || 1;
      const rectHeight = rectScale?.y || 1;
      const spawn = startPositions[particleIndex];
      sampleColorInstance(
        ci!,
        spawn.x,
        spawn.y,
        spawn.z,
        rectWidth,
        rectHeight,
        colorInstanceSample
      );
      if (!colorInstanceSample.hit && ci!.spawnOnSource) {
        for (
          let attempt = 0;
          attempt < SPAWN_ON_SOURCE_TRIES && !colorInstanceSample.hit;
          attempt++
        ) {
          calculatePositionAndVelocity(
            generalData,
            normalizedConfig.shape,
            normalizedConfig.startSpeed,
            spawn,
            velocities[particleIndex]
          );
          sampleColorInstance(
            ci!,
            spawn.x,
            spawn.y,
            spawn.z,
            rectWidth,
            rectHeight,
            colorInstanceSample
          );
        }
      }
    }
    // GPU compute: position is set via the emit scatter in the compute shader
    // (writeParticleToModifierBuffers queues it). Do NOT set needsUpdate —
    // that triggers a full CPU→GPU upload that overwrites GPU-computed
    // positions for all particles.
    // However, we still write the CPU-side array so death sub-emitters can
    // read the particle's approximate position without GPU readback.
    {
      const positionIndex = particleIndex * 3;
      // WORLD simulation space: the buffer stores world coordinates. The
      // shape-emission offset (startPositions) is rotated by the emitter's
      // world rotation AND scaled by the emitter's world scale, matching
      // Unity's Shape module when Scaling Mode is Local/Hierarchy. The
      // emitter's world translation is then added so the particle starts
      // at the correct world-space location.
      //
      // LOCAL simulation space: the buffer is in the emitter's local
      // frame; the shape offset is added as-is (parent scale affects the
      // rendered size via particleSystem.matrixWorld at draw time).
      const isWorld =
        normalizedConfig.simulationSpace === SimulationSpace.WORLD;
      const ox = startPositions[particleIndex].x;
      const oy = startPositions[particleIndex].y;
      const oz = startPositions[particleIndex].z;
      if (isWorld) {
        const m = generalData.sourceWorldMatrix.elements;
        const s = generalData.worldScale;
        aPosition.array[positionIndex] = position.x + ox * s.x + m[12];
        aPosition.array[positionIndex + 1] = position.y + oy * s.y + m[13];
        aPosition.array[positionIndex + 2] = position.z + oz * s.z + m[14];
      } else {
        aPosition.array[positionIndex] = position.x + ox;
        aPosition.array[positionIndex + 1] = position.y + oy;
        aPosition.array[positionIndex + 2] = position.z + oz;
      }
      if (!useGPUCompute) {
        if (particleIndex > generalData.cpuDirtyParticleWatermark)
          generalData.cpuDirtyParticleWatermark = particleIndex;
        aPosition.needsUpdate = true;
      }
    }

    if (generalData.linearVelocityData) {
      generalData.linearVelocityData[particleIndex].speed.set(
        normalizedConfig.velocityOverLifetime.linear.x
          ? calculateValue(
              generalData.particleSystemId,
              normalizedConfig.velocityOverLifetime.linear.x,
              0
            )
          : 0,
        normalizedConfig.velocityOverLifetime.linear.y
          ? calculateValue(
              generalData.particleSystemId,
              normalizedConfig.velocityOverLifetime.linear.y,
              0
            )
          : 0,
        normalizedConfig.velocityOverLifetime.linear.z
          ? calculateValue(
              generalData.particleSystemId,
              normalizedConfig.velocityOverLifetime.linear.z,
              0
            )
          : 0
      );
    }

    if (generalData.orbitalVelocityData) {
      generalData.orbitalVelocityData[particleIndex].speed.set(
        normalizedConfig.velocityOverLifetime.orbital.x
          ? calculateValue(
              generalData.particleSystemId,
              normalizedConfig.velocityOverLifetime.orbital.x,
              0
            )
          : 0,
        normalizedConfig.velocityOverLifetime.orbital.y
          ? calculateValue(
              generalData.particleSystemId,
              normalizedConfig.velocityOverLifetime.orbital.y,
              0
            )
          : 0,
        normalizedConfig.velocityOverLifetime.orbital.z
          ? calculateValue(
              generalData.particleSystemId,
              normalizedConfig.velocityOverLifetime.orbital.z,
              0
            )
          : 0
      );
      generalData.orbitalVelocityData[particleIndex].positionOffset.set(
        startPositions[particleIndex].x,
        startPositions[particleIndex].y,
        startPositions[particleIndex].z
      );
    }

    scalarArray[base + S_LIFETIME] = 0;

    // Particle Color Instance: replace the start color with an image pixel
    // sampled by the spawn offset projected onto the configured plane
    // (world orientation), scaled and wrapped as color-instance-mapping says.
    // Runs after calculatePositionAndVelocity so startPositions is final, and
    // before the GPU emit write below so the override reaches both backends.
    // Per-particle curl-noise multiplier derived from the sampled pixel's
    // luminance. Stays 1 (no modulation) unless the feature is on and the
    // particle spawned inside the mapped area.
    let colorInstanceNoiseMul = 1;
    if (ciReady) {
      // colorInstanceSample still holds this birth's sample from the draw.
      const sample = colorInstanceSample;
      scalarArray[base + S_COLOR_R] = sample.r;
      scalarArray[base + S_COLOR_G] = sample.g;
      scalarArray[base + S_COLOR_B] = sample.b;
      generalData.startValues.startColorR[particleIndex] = sample.r;
      generalData.startValues.startColorG[particleIndex] = sample.g;
      generalData.startValues.startColorB[particleIndex] = sample.b;
      if (!sample.hit) {
        // Nothing under it: invisible, whatever the alpha toggle says.
        generalData.startValues.startOpacity[particleIndex] = 0;
        scalarArray[base + S_COLOR_A] = 0;
      } else if (ci!.useAlphaForOpacity) {
        generalData.startValues.startOpacity[particleIndex] *= sample.alpha;
        scalarArray[base + S_COLOR_A] =
          generalData.startValues.startOpacity[particleIndex];
      }
      colorInstanceNoiseMul = sample.noiseMul;
    }

    // In curl mode the noiseOffset slot is unused (the field is sampled from
    // position + time, not a per-particle offset), so it carries the luminance
    // multiplier instead — avoids a 9th storage binding on WebGPU.
    const useNoiseLuma = !!(
      generalData.noise.curl &&
      ci?.isActive &&
      ci.useLuminanceForNoise
    );

    if (useNoiseLuma && !useGPUCompute) {
      // The CPU curl path reads this per particle; the GPU packs the same
      // value into startColorsExt.w below.
      (generalData.noise.lumaMul ??= new Float32Array(maxParticles).fill(1))[
        particleIndex
      ] = colorInstanceNoiseMul;
    }

    if (useGPUCompute && gpuPipeline) {
      // Write all particle data to GPU storage buffers.
      //
      // WORLD simulation space: the GPU buffer stores world coordinates.
      // The shape offset (startPositions) is scaled by the emitter's
      // world scale (Unity Shape-module parity) and then offset by the
      // emitter's world translation. LOCAL space uses the shape offset
      // as-is since the buffer is in the emitter's local frame.
      const isWorld =
        normalizedConfig.simulationSpace === SimulationSpace.WORLD;
      const m = generalData.sourceWorldMatrix.elements;
      const s = generalData.worldScale;
      const ox = startPositions[particleIndex].x;
      const oy = startPositions[particleIndex].y;
      const oz = startPositions[particleIndex].z;
      _tslMaterialFactory!.writeParticleToModifierBuffers!(
        gpuPipeline.buffers,
        particleIndex,
        {
          position: {
            x: position.x + (isWorld ? ox * s.x + m[12] : ox),
            y: position.y + (isWorld ? oy * s.y + m[13] : oy),
            z: position.z + (isWorld ? oz * s.z + m[14] : oz),
          },
          velocity: {
            x: velocities[particleIndex].x,
            y: velocities[particleIndex].y,
            z: velocities[particleIndex].z,
          },
          startLifetime: scalarArray[base + S_START_LIFETIME],
          colorA: scalarArray[base + S_COLOR_A],
          size: scalarArray[base + S_SIZE],
          rotation: scalarArray[base + S_ROTATION],
          colorR: scalarArray[base + S_COLOR_R],
          colorG: scalarArray[base + S_COLOR_G],
          colorB: scalarArray[base + S_COLOR_B],
          startSize: generalData.startValues.startSize[particleIndex],
          startOpacity: generalData.startValues.startOpacity[particleIndex],
          startColorR: generalData.startValues.startColorR[particleIndex],
          startColorG: generalData.startValues.startColorG[particleIndex],
          startColorB: generalData.startValues.startColorB[particleIndex],
          rotationSpeed: generalData.lifetimeValues.rotationOverLifetime
            ? generalData.lifetimeValues.rotationOverLifetime[particleIndex]
            : 0,
          noiseOffset: useNoiseLuma
            ? colorInstanceNoiseMul
            : generalData.noise.offsets
              ? generalData.noise.offsets[particleIndex]
              : 0,
          startFrame: scalarArray[base + S_START_FRAME],
          orbitalOffset: {
            x: startPositions[particleIndex].x,
            y: startPositions[particleIndex].y,
            z: startPositions[particleIndex].z,
          },
        }
      );
      // Modifiers run on GPU — no CPU applyModifiers needed
    } else {
      if (particleIndex > generalData.cpuDirtyParticleWatermark)
        generalData.cpuDirtyParticleWatermark = particleIndex;
      scalarInterleavedBuffer.needsUpdate = true;

      applyModifiers({
        delta: 0,
        generalData,
        normalizedConfig,
        attributes: mappedAttributes,
        scalarArray,
        particleLifetimePercentage: 0,
        particleIndex,
      });
    }
  };

  // Sub-emitter setup
  const subEmitterArr: Array<SubEmitterConfig> = subEmitters ?? [];
  const deathSubEmitters = subEmitterArr.filter(
    (s) => (s.trigger ?? SubEmitterTrigger.DEATH) === SubEmitterTrigger.DEATH
  );
  const birthSubEmitters = subEmitterArr.filter(
    (s) => s.trigger === SubEmitterTrigger.BIRTH
  );
  // Track sub-emitter instances per config for per-config maxInstances enforcement
  const subEmitterInstancesMap = new Map<
    SubEmitterConfig,
    Array<ParticleSystem>
  >();
  for (const cfg of subEmitterArr) {
    subEmitterInstancesMap.set(cfg, []);
  }

  const cleanupCompletedInstances = (instances: Array<ParticleSystem>) => {
    for (let i = instances.length - 1; i >= 0; i--) {
      const sub = instances[i];
      let hasActive: boolean;
      if (sub.getActiveParticleCount) {
        // O(1) via the free list — avoids scanning every particle of every
        // instance each time the instance cap is hit.
        hasActive = sub.getActiveParticleCount() > 0;
      } else {
        const geomAttrs = sub.instance.geometry?.attributes;
        const isActiveAttr = geomAttrs
          ? (geomAttrs.isActive ?? geomAttrs.instanceIsActive)
          : undefined;
        if (!isActiveAttr) {
          sub.dispose();
          instances.splice(i, 1);
          continue;
        }
        hasActive = false;
        for (let j = 0; j < isActiveAttr.count; j++) {
          if (isActiveAttr.getX(j)) {
            hasActive = true;
            break;
          }
        }
      }
      if (!hasActive) {
        sub.dispose();
        instances.splice(i, 1);
      }
    }
  };

  const spawnSubEmitters = (
    configs: Array<SubEmitterConfig>,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    spawnNow: number
  ) => {
    // The death/birth callbacks pass `position` in world coordinates. The
    // sub-emitter becomes a child of particleSystem.parent, so its
    // transform.position must be expressed in that parent's local frame.
    const parentObj = particleSystem.parent;
    _subLocalPosition.copy(position);
    if (parentObj) {
      parentObj.updateMatrixWorld();
      parentObj.worldToLocal(_subLocalPosition);
    }

    for (const subConfig of configs) {
      const instances = subEmitterInstancesMap.get(subConfig)!;
      const maxInst = subConfig.maxInstances ?? 32;
      if (instances.length >= maxInst) {
        cleanupCompletedInstances(instances);
        if (instances.length >= maxInst) continue;
      }

      const inheritVelocity = subConfig.inheritVelocity ?? 0;
      const subSystem = createParticleSystem(
        {
          ...subConfig.config,
          looping: false,
          // Sub-emitters must always use CPU simulation because their compute
          // nodes cannot be dispatched independently by the parent system.
          simulationBackend: SimulationBackend.CPU,
          transform: {
            ...subConfig.config.transform,
            position: new THREE.Vector3(
              _subLocalPosition.x,
              _subLocalPosition.y,
              _subLocalPosition.z
            ),
          },
          renderer: {
            ...(subConfig.config.renderer ?? {}),
            ...(subConfig.config.renderer?.rendererType
              ? {}
              : renderer.rendererType === RendererType.MESH ||
                  renderer.rendererType === RendererType.TRAIL
                ? {}
                : { rendererType: renderer.rendererType }),
          } as typeof subConfig.config.renderer,
          ...(inheritVelocity > 0
            ? {
                startSpeed:
                  (typeof subConfig.config.startSpeed === 'number'
                    ? subConfig.config.startSpeed
                    : typeof subConfig.config.startSpeed === 'object' &&
                        subConfig.config.startSpeed !== null &&
                        'min' in subConfig.config.startSpeed
                      ? ((
                          subConfig.config
                            .startSpeed as RandomBetweenTwoConstants
                        ).min ?? 0)
                      : 0) +
                  velocity.length() * inheritVelocity,
              }
            : {}),
        },
        spawnNow
      );

      if (parentObj) parentObj.add(subSystem.instance);

      instances.push(subSystem);
    }
  };

  // Trail mesh setup: ribbon geometry + material (created only for TRAIL mode)
  let trailMesh: THREE.Mesh | undefined;
  let trailGeometry: THREE.BufferGeometry | undefined;
  let trailPositionAttr: THREE.BufferAttribute | undefined;
  let trailAlphaAttr: THREE.BufferAttribute | undefined;
  let trailColorAttr: THREE.BufferAttribute | undefined;
  let trailNextAttr: THREE.BufferAttribute | undefined;
  let trailHalfWidthAttr: THREE.BufferAttribute | undefined;
  let trailUVAttr: THREE.BufferAttribute | undefined;
  let trailIndexAttr: THREE.BufferAttribute | undefined;
  let trailWidthCurveFn: CurveFunction | undefined;
  let trailOpacityCurveFn: CurveFunction | undefined;
  let trailColorOverTrailFns:
    | { r: CurveFunction; g: CurveFunction; b: CurveFunction }
    | undefined;

  if (useTrail && trailConfig && !useGPUTrail) {
    const trailLength = trailConfig.length;
    const slotCount = trailSlotCount(trailConfig);
    // Each particle contributes (slotCount) points, drawn from `trailLength` raw samples (2 per segment joint: left+right)
    // Segments = slotCount - 1, so 2 * slotCount vertices per particle
    const verticesPerParticle = slotCount * 2;
    const totalVertices = maxParticles * verticesPerParticle;
    // Each segment (between 2 consecutive history points) = 2 triangles = 6 indices
    const indicesPerParticle = (slotCount - 1) * 6;
    const totalIndices = maxParticles * indicesPerParticle;

    trailGeometry = new THREE.BufferGeometry();
    const trailPositions = new Float32Array(totalVertices * 3);
    const trailNextPositions = new Float32Array(totalVertices * 3);
    const trailAlphas = new Float32Array(totalVertices);
    const trailColors = new Float32Array(totalVertices * 4);
    const trailOffsets = new Float32Array(totalVertices);
    const trailHalfWidths = new Float32Array(totalVertices);
    const trailUVs = new Float32Array(totalVertices * 2);
    const trailIndices = new Uint32Array(totalIndices);

    // Pre-build index buffer and static offset attribute (-1/+1 per side)
    for (let p = 0; p < maxParticles; p++) {
      const vertBase = p * verticesPerParticle;
      const idxBase = p * indicesPerParticle;
      for (let s = 0; s < slotCount; s++) {
        trailOffsets[vertBase + s * 2] = -1.0; // left
        trailOffsets[vertBase + s * 2 + 1] = 1.0; // right
      }
      for (let s = 0; s < slotCount - 1; s++) {
        const i = idxBase + s * 6;
        const v = vertBase + s * 2;
        trailIndices[i] = v;
        trailIndices[i + 1] = v + 1;
        trailIndices[i + 2] = v + 2;
        trailIndices[i + 3] = v + 1;
        trailIndices[i + 4] = v + 3;
        trailIndices[i + 5] = v + 2;
      }
    }

    trailPositionAttr = new THREE.BufferAttribute(trailPositions, 3);
    trailPositionAttr.setUsage(THREE.DynamicDrawUsage);
    trailNextAttr = new THREE.BufferAttribute(trailNextPositions, 3);
    trailNextAttr.setUsage(THREE.DynamicDrawUsage);
    trailAlphaAttr = new THREE.BufferAttribute(trailAlphas, 1);
    trailAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    trailColorAttr = new THREE.BufferAttribute(trailColors, 4);
    trailColorAttr.setUsage(THREE.DynamicDrawUsage);
    trailHalfWidthAttr = new THREE.BufferAttribute(trailHalfWidths, 1);
    trailHalfWidthAttr.setUsage(THREE.DynamicDrawUsage);
    trailUVAttr = new THREE.BufferAttribute(trailUVs, 2);
    trailUVAttr.setUsage(THREE.DynamicDrawUsage);
    trailIndexAttr = new THREE.BufferAttribute(trailIndices, 1);

    trailGeometry.setAttribute('position', trailPositionAttr);
    trailGeometry.setAttribute('trailNext', trailNextAttr);
    trailGeometry.setAttribute('trailAlpha', trailAlphaAttr);
    trailGeometry.setAttribute('trailColor', trailColorAttr);
    trailGeometry.setAttribute(
      'trailOffset',
      new THREE.BufferAttribute(trailOffsets, 1)
    );
    trailGeometry.setAttribute('trailHalfWidth', trailHalfWidthAttr);
    trailGeometry.setAttribute('trailUV', trailUVAttr);
    trailGeometry.setIndex(trailIndexAttr);

    const trailUniformValues = {
      map: { value: particleMap },
      useMap: { value: !!particleMap },
      discardBackgroundColor: { value: renderer.discardBackgroundColor },
      // sRGB → linear so the trail fragment comparison matches the
      // (now linear) texture sample and vertex color.
      backgroundColor: { value: rgbSRGBToLinear(renderer.backgroundColor) },
      backgroundColorTolerance: { value: renderer.backgroundColorTolerance },
      softParticlesEnabled: { value: softParticlesEnabled },
      softParticlesIntensity: {
        value: Math.max(renderer.softParticles?.intensity ?? 1.0, 0.001),
      },
      sceneDepthTexture: {
        value: renderer.softParticles?.depthTexture ?? null,
      },
      cameraNearFar: { value: new THREE.Vector2(0.1, 1000.0) },
    };

    const trailMaterial: THREE.Material = useTSL
      ? _tslMaterialFactory!.createTSLTrailMaterial(
          trailUniformValues,
          rendererConfig
        )
      : new THREE.ShaderMaterial({
          uniforms: trailUniformValues,
          vertexShader: TrailVertexShader,
          fragmentShader: TrailFragmentShader,
          ...rendererConfig,
          side: THREE.DoubleSide,
        });

    trailMesh = new THREE.Mesh(trailGeometry, trailMaterial);
    trailMesh.frustumCulled = false;

    // Capture camera world position each frame for billboard trail ribbons
    const trailCameraPos = new THREE.Vector3();
    trailMesh.onBeforeRender = (
      _renderer: THREE.WebGLRenderer,
      _scene: THREE.Scene,
      camera: THREE.Camera
    ) => {
      camera.getWorldPosition(trailCameraPos);
      if (
        softParticlesEnabled &&
        (camera as THREE.PerspectiveCamera).isPerspectiveCamera
      ) {
        const perspCam = camera as THREE.PerspectiveCamera;
        (trailUniformValues.cameraNearFar.value as THREE.Vector2).set(
          perspCam.near,
          perspCam.far
        );
      }
    };
    generalData.trailCameraPosition = trailCameraPos;

    // Pre-compute curve functions for trail width/opacity. Each is called
    // once per ribbon vertex per frame — hundreds of thousands of times — so
    // the bezier is sampled into a table once and the calls become a lookup.
    trailWidthCurveFn = tabulateCurve(
      getCurveFunctionFromConfig(
        generalData.particleSystemId,
        trailConfig.widthOverTrail
      )
    );
    trailOpacityCurveFn = tabulateCurve(
      getCurveFunctionFromConfig(
        generalData.particleSystemId,
        trailConfig.opacityOverTrail
      )
    );

    if (trailConfig.colorOverTrail?.isActive) {
      trailColorOverTrailFns = {
        r: tabulateCurve(
          getCurveFunctionFromConfig(
            generalData.particleSystemId,
            normalizeTrailCurve(trailConfig.colorOverTrail.r, defaultTrailCurve)
          )
        ),
        g: tabulateCurve(
          getCurveFunctionFromConfig(
            generalData.particleSystemId,
            normalizeTrailCurve(trailConfig.colorOverTrail.g, defaultTrailCurve)
          )
        ),
        b: tabulateCurve(
          getCurveFunctionFromConfig(
            generalData.particleSystemId,
            normalizeTrailCurve(trailConfig.colorOverTrail.b, defaultTrailCurve)
          )
        ),
      };
    }
  }

  let particleSystem: THREE.Points | THREE.Mesh =
    useInstancing || useMesh || useGPUTrail
      ? new THREE.Mesh(geometry, material)
      : new THREE.Points(geometry, material);

  // Late-bound ref so onBeforeRender can access instanceData (assigned later).
  const _instanceRef: { current: ParticleSystemInstance | null } = {
    current: null,
  };

  if (useInstancing || softParticlesEnabled || useGPUCompute) {
    particleSystem.onBeforeRender = (
      glRenderer: THREE.WebGLRenderer,
      _scene: THREE.Scene,
      camera: THREE.Camera
    ) => {
      if (useInstancing) {
        const size = glRenderer.getSize(_viewportSize);
        sharedUniforms.viewportHeight.value =
          size.y * glRenderer.getPixelRatio();
      }
      if (
        softParticlesEnabled &&
        (camera as THREE.PerspectiveCamera).isPerspectiveCamera
      ) {
        const perspCam = camera as THREE.PerspectiveCamera;
        (sharedUniforms.cameraNearFar.value as THREE.Vector2).set(
          perspCam.near,
          perspCam.far
        );
      }
      // Note: GPU compute dispatch is done by the caller via
      // renderer.compute(system.computeNode) before renderer.render().
    };
  }

  // In trail mode, hide the particle points (but keep the parent visible so
  // the trail mesh child can render) and attach the visible trail mesh
  if (useTrail && trailMesh) {
    material.visible = false;
    particleSystem.add(trailMesh);
  }

  if (useGPUTrail && gpuTrailUniformValues) {
    // The ribbons are wherever the history ring says; the strip's own bounds
    // say nothing about that.
    particleSystem.frustumCulled = false;
    const innerHook = particleSystem.onBeforeRender;
    particleSystem.onBeforeRender = function (
      this: THREE.Object3D,
      ...args: Parameters<THREE.Object3D['onBeforeRender']>
    ) {
      innerHook.apply(this, args);
      const camera = args[2] as THREE.PerspectiveCamera;
      if (softParticlesEnabled && camera.isPerspectiveCamera) {
        (gpuTrailUniformValues.cameraNearFar.value as THREE.Vector2).set(
          camera.near,
          camera.far
        );
      }
    };
  }

  particleSystem.position.copy(transform!.position!);
  particleSystem.rotation.x = THREE.MathUtils.degToRad(transform.rotation!.x);
  particleSystem.rotation.y = THREE.MathUtils.degToRad(transform.rotation!.y);
  particleSystem.rotation.z = THREE.MathUtils.degToRad(transform.rotation!.z);
  particleSystem.scale.copy(transform.scale!);

  // Create a mapped view of attributes so the update loop and modifiers can
  // use standard names regardless of the renderer type.
  const mappedAttributes = {
    position: aPosition,
    isActive: aIsActive,
    lifetime: aLifetime,
    startLifetime: aStartLifetime,
    startFrame: aStartFrame,
    size: aSize,
    rotation: aRotation,
    color: aColor,
    ...(useMesh ? { quat: aQuat } : {}),
  };

  const calculatedCreationTime =
    now + calculateValue(generalData.particleSystemId, startDelay) * 1000;

  // WORLD simulation space: decouple rendering transform from the emitter.
  // The particle buffer stores world-space coordinates, so matrixWorld is
  // forced to identity each frame. The emitter's actual world transform is
  // captured in generalData.sourceWorldMatrix for positioning new particles
  // and orienting the emission shape.
  if (normalizedConfig.simulationSpace === SimulationSpace.WORLD) {
    particleSystem.matrixWorldAutoUpdate = false;
    particleSystem.matrixWorld.identity();
  }

  const hasDeathSubEmitters = deathSubEmitters.length > 0;
  const hasBirthSubEmitters = birthSubEmitters.length > 0;

  const onParticleDeath = hasDeathSubEmitters
    ? (
        particleIndex: number,
        positionArr: THREE.TypedArray,
        velocity: THREE.Vector3,
        deathNow: number
      ) => {
        const posIdx = particleIndex * 3;
        _subEmitterPosition.set(
          positionArr[posIdx],
          positionArr[posIdx + 1],
          positionArr[posIdx + 2]
        );
        // Convert local particle position to world space so the sub-emitter
        // spawns at the correct scene position regardless of transform offset.
        // updateMatrixWorld() guarantees the transform is fresh — otherwise a
        // parent moved after the last scene traversal would place the spawn
        // at a stale position.
        if (simulationSpace === SimulationSpace.LOCAL) {
          particleSystem.updateMatrixWorld();
          particleSystem.localToWorld(_subEmitterPosition);
        }
        spawnSubEmitters(
          deathSubEmitters,
          _subEmitterPosition,
          velocity,
          deathNow
        );
      }
    : undefined;

  const onParticleBirth = hasBirthSubEmitters
    ? (
        particleIndex: number,
        positionArr: THREE.TypedArray,
        velocity: THREE.Vector3,
        birthNow: number
      ) => {
        const posIdx = particleIndex * 3;
        _subEmitterPosition.set(
          positionArr[posIdx],
          positionArr[posIdx + 1],
          positionArr[posIdx + 2]
        );
        // Convert local particle position to world space so the sub-emitter
        // spawns at the correct scene position regardless of transform offset.
        // updateMatrixWorld() guarantees the transform is fresh — otherwise a
        // parent moved after the last scene traversal would place the spawn
        // at a stale position.
        if (simulationSpace === SimulationSpace.LOCAL) {
          particleSystem.updateMatrixWorld();
          particleSystem.localToWorld(_subEmitterPosition);
        }
        spawnSubEmitters(
          birthSubEmitters,
          _subEmitterPosition,
          velocity,
          birthNow
        );
      }
    : undefined;

  // Stable kill callback for collision-plane KILL handling. Created once per
  // system so the update loop doesn't allocate a closure per particle per
  // frame; reads the frame timestamp from the module-level _frameNow.
  const killParticle = (particleIndex: number) => {
    if (onParticleDeath)
      onParticleDeath(
        particleIndex,
        mappedAttributes.position.array,
        velocities[particleIndex],
        _frameNow
      );
    deactivateParticle(particleIndex);
  };

  const instanceData: ParticleSystemInstance = {
    particleSystem,
    mappedAttributes,
    scalarArray,
    scalarInterleavedBuffer,
    elapsedUniform: sharedUniforms.elapsed as { value: number },
    generalData,
    onUpdate,
    onComplete,
    creationTime: calculatedCreationTime,
    lastEmissionTime: calculatedCreationTime,
    emissionAccumulator: 0,
    duration,
    looping,
    simulationSpace,
    gravity,
    normalizedForceFields,
    normalizedCollisionPlanes,
    emission,
    normalizedConfig,
    iterationCount: 0,
    velocities,
    freeList,
    deactivateParticle,
    killParticle,
    activateParticle,
    onParticleDeath,
    onParticleBirth,
    useGPUCompute: useGPUCompute && gpuPipeline !== null,
    computePipeline: gpuPipeline ?? undefined,
    trailGpuNow: useGPUTrail
      ? ((material as THREE.Material).userData?.trailNow as
          | { value: number }
          | undefined)
      : undefined,
    touchWake,
    computeDispatchReady: false,
    ...(useTrail
      ? {
          trailMesh,
          trailPositionAttr,
          trailAlphaAttr,
          trailColorAttr,
          trailNextAttr: trailNextAttr as THREE.BufferAttribute,
          trailHalfWidthAttr: trailHalfWidthAttr as THREE.BufferAttribute,
          trailUVAttr: trailUVAttr as THREE.BufferAttribute,
          trailWidthCurveFn,
          trailOpacityCurveFn,
          trailColorOverTrailFns,
          trailConfig: {
            length: trailConfig!.length,
            width: trailConfig!.width,
            minVertexDistance: trailConfig!.minVertexDistance,
            maxTime: trailConfig!.maxTime,
            smoothing: trailConfig!.smoothing,
            smoothingSubdivisions: trailConfig!.smoothingSubdivisions,
            twistPrevention: trailConfig!.twistPrevention,
            ribbonId: trailConfig!.ribbonId,
          },
        }
      : {}),
  };

  createdParticleSystems.push(instanceData);
  _instanceRef.current = instanceData;

  const resumeEmitter = () => (generalData.isEnabled = true);
  const pauseEmitter = () => (generalData.isEnabled = false);
  const dispose = () => {
    for (const instances of subEmitterInstancesMap.values()) {
      for (const sub of instances) sub.dispose();
      instances.length = 0;
    }
    destroyParticleSystem(particleSystem);
  };
  const update = (cycleData: CycleData) => {
    updateParticleSystemInstance(instanceData, cycleData);
    for (const instances of subEmitterInstancesMap.values()) {
      for (const sub of instances) sub.update(cycleData);
    }
  };

  /**
   * Gives every live particle the colour the source would give it now — the
   * mapping, the look and the luminance map as they stand — from the position
   * it was born at. What `updateConfig({ particleColorInstance })` does, so a
   * lever on the source shows on the particles already out and not only on
   * the next births. A pass over the slots on the CPU, once per change and
   * never per frame; on the GPU path only the two start-value buffers are
   * re-uploaded, and the kernel takes its colour and alpha from them every
   * frame. Opacity is rebuilt from the value drawn at birth (baseOpacity):
   * the texel's alpha folded in where the config says so, zero where there
   * is nothing under the particle now. Returns how many were recoloured.
   */
  const recolorLiveParticles = (): number => {
    const ci = generalData.colorInstance;
    if (!ci?.isActive || !ensureColorInstancePixels(ci)) return 0;
    const rectScale = normalizedConfig.shape.rectangle?.scale;
    const rectWidth = rectScale?.x || 1;
    const rectHeight = rectScale?.y || 1;
    const useLuma = !!(generalData.noise.curl && ci.useLuminanceForNoise);
    const sv = generalData.startValues;
    const gpuBuffers =
      useGPUCompute && gpuPipeline ? gpuPipeline.buffers : null;
    const svArr = gpuBuffers
      ? (gpuBuffers.startValues.array as Float32Array)
      : null;
    const sceArr = gpuBuffers
      ? (gpuBuffers.startColorsExt.array as Float32Array)
      : null;
    let count = 0;
    for (let i = 0; i < maxParticles; i++) {
      const base = i * SCALAR_STRIDE;
      if (!scalarArray[base + S_IS_ACTIVE]) continue;
      const spawn = startPositions[i];
      if (!spawn) continue;
      sampleColorInstance(
        ci,
        spawn.x,
        spawn.y,
        spawn.z,
        rectWidth,
        rectHeight,
        colorInstanceSample
      );
      const { r, g, b, alpha, hit, noiseMul } = colorInstanceSample;
      sv.startColorR[i] = r;
      sv.startColorG[i] = g;
      sv.startColorB[i] = b;
      scalarArray[base + S_COLOR_R] = r;
      scalarArray[base + S_COLOR_G] = g;
      scalarArray[base + S_COLOR_B] = b;
      // Visible where there is something, from the opacity drawn at birth;
      // hidden where there is nothing now — and back when there is again.
      const opacity = hit
        ? sv.baseOpacity[i] * (ci.useAlphaForOpacity ? alpha : 1)
        : 0;
      sv.startOpacity[i] = opacity;
      scalarArray[base + S_COLOR_A] = opacity;
      if (svArr && sceArr) {
        const i4 = i * 4;
        svArr[i4 + 2] = opacity;
        svArr[i4 + 3] = r;
        sceArr[i4] = g;
        sceArr[i4 + 1] = b;
        // .w carries the luminance multiplier only in curl mode; otherwise
        // it is the legacy noise offset and stays.
        if (useLuma) sceArr[i4 + 3] = noiseMul;
      } else if (useLuma && generalData.noise.lumaMul) {
        generalData.noise.lumaMul[i] = noiseMul;
      }
      count++;
    }
    if (count === 0) return 0;
    if (gpuBuffers) {
      // Whole-buffer uploads: the CPU mirrors are exact for every slot that
      // was ever born (writeParticleToModifierBuffers keeps them), and the
      // GPU never writes these two.
      gpuBuffers.startValues.needsUpdate = true;
      gpuBuffers.startColorsExt.needsUpdate = true;
    } else {
      generalData.cpuDirtyParticleWatermark = maxParticles - 1;
      scalarInterleavedBuffer.needsUpdate = true;
    }
    return count;
  };

  /**
   * The mean start colour of the particles out right now — the picture's
   * colour, as the source painted it — in linear light. Sampled at a stride
   * so a 200k system costs a fraction of a millisecond; only live, visible
   * particles count. Writes into `out` and returns how many were sampled;
   * 0 leaves `out` untouched.
   */
  const meanColorStride = Math.max(1, Math.floor(maxParticles / 16384));
  const getMeanColor = (out: { r: number; g: number; b: number }): number => {
    const sv = generalData.startValues;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < maxParticles; i += meanColorStride) {
      const base = i * SCALAR_STRIDE;
      if (!scalarArray[base + S_IS_ACTIVE]) continue;
      if (!(sv.startOpacity[i] > 0)) continue;
      r += sv.startColorR[i];
      g += sv.startColorG[i];
      b += sv.startColorB[i];
      n++;
    }
    if (n === 0) return 0;
    out.r = r / n;
    out.g = g / n;
    out.b = b / n;
    return n;
  };

  const updateConfig = (partialConfig: Partial<ParticleSystemConfig>) => {
    // The blocks about to be merged into must be this system's own, not the
    // defaults' (see detachPlainObjects).
    const live = instanceData.normalizedConfig as unknown as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(partialConfig)) {
      if (live[key] && typeof live[key] === 'object')
        live[key] = detachPlainObjects(live[key]);
    }
    // Deep-merge partial config into the live normalizedConfig
    ObjectUtils.deepMerge(instanceData.normalizedConfig, partialConfig, {
      applyToFirstObject: true,
      skippedProperties: [],
    });

    const cfg = instanceData.normalizedConfig;

    // Update instance-level cached scalars
    if (partialConfig.gravity !== undefined) {
      instanceData.gravity = cfg.gravity;
    }
    if (partialConfig.duration !== undefined)
      instanceData.duration = cfg.duration;
    if (partialConfig.looping !== undefined) instanceData.looping = cfg.looping;
    if (
      partialConfig.simulationSpace !== undefined &&
      instanceData.simulationSpace !== cfg.simulationSpace
    ) {
      // Switching simulation space live. The existing buffer of active
      // particles is in the _old_ frame — rather than walk the buffer and
      // convert every position (which still wouldn't reproduce the visual
      // continuity the old frame had), we deactivate the live particles
      // so the system re-emits from the new frame's origin cleanly. New
      // emissions use the right frame because `simulationSpace` is also
      // synced below.
      //
      // We also flip `matrixWorldAutoUpdate` + reset `lastWorldPosition`
      // to match the state createParticleSystem would have set. Without
      // this, particles rendered in the first few frames after the switch
      // inherit the wrong world matrix and appear to jump between origins.
      for (let i = 0; i < maxParticles; i++) {
        if (scalarArray[i * SCALAR_STRIDE + S_IS_ACTIVE]) {
          deactivateParticle(i);
        }
      }
      generalData.lastWorldPosition.set(-99999, -99999, -99999);
      if (cfg.simulationSpace === SimulationSpace.WORLD) {
        particleSystem.matrixWorldAutoUpdate = false;
        particleSystem.matrixWorld.identity();
      } else {
        particleSystem.matrixWorldAutoUpdate = true;
      }
      instanceData.simulationSpace = cfg.simulationSpace;
    }
    if (partialConfig.emission !== undefined)
      instanceData.emission = cfg.emission;

    // Re-normalize force fields when changed
    if (partialConfig.forceFields !== undefined) {
      instanceData.normalizedForceFields = normalizeForceFields(
        cfg.forceFields
      );
    }

    // Re-normalize collision planes when changed
    if (partialConfig.collisionPlanes !== undefined) {
      instanceData.normalizedCollisionPlanes = normalizeCollisionPlanes(
        cfg.collisionPlanes
      );
    }

    // Re-initialize noise when changed
    if (partialConfig.noise !== undefined) {
      const n = cfg.noise;
      generalData.noise = {
        isActive: n.isActive,
        strength: n.strength,
        noisePower: 0.15 * n.strength,
        frequency: n.frequency,
        positionAmount: n.positionAmount,
        rotationAmount: n.rotationAmount,
        sizeAmount: n.sizeAmount,
        curl: !!n.curl,
        influence: {
          x: n.influence?.x ?? 1,
          y: n.influence?.y ?? 1,
          z: n.influence?.z ?? 1,
        },
        type: n.type ?? NoiseType.SIMPLEX,
        drift: {
          x: n.drift?.x ?? DEFAULT_DRIFT.x,
          y: n.drift?.y ?? DEFAULT_DRIFT.y,
          z: n.drift?.z ?? DEFAULT_DRIFT.z,
        },
        fbmMax: 2 - Math.pow(2, -n.octaves),
        sampler: n.isActive
          ? new FBM({
              seed: Math.random(),
              scale: n.frequency,
              octaves: n.octaves,
            })
          : undefined,
        offsets: n.useRandomOffset
          ? (generalData.noise.offsets ??
            Array.from({ length: maxParticles }, () => Math.random() * 100))
          : undefined,
      };
    }

    // Re-initialize the color-instance sampler when changed
    if (partialConfig.particleColorInstance !== undefined) {
      // The same source keeps its pixels and its frame watcher; only the
      // settings move. Then the particles already out take the new colours.
      instanceData.generalData.colorInstance = refreshColorInstanceData(
        instanceData.generalData.colorInstance,
        cfg.particleColorInstance
      );
      recolorLiveParticles();
    }

    // Re-resolve pre-baked modifier curve functions — the CPU update loop
    // reads these instead of re-resolving curves per particle per frame.
    if (
      partialConfig.sizeOverLifetime !== undefined ||
      partialConfig.opacityOverLifetime !== undefined ||
      partialConfig.colorOverLifetime !== undefined
    ) {
      resolveModifierCurves();
    }

    // Re-initialize per-particle data arrays that only exist while their
    // module is active (previously live activation was a silent no-op).
    if (partialConfig.velocityOverLifetime !== undefined) {
      initVelocityLifetimeData();
    }
    if (partialConfig.rotationOverLifetime !== undefined) {
      initRotationLifetimeValues();
    }

    // GPU compute bakes modifier activation flags and lifetime curves into
    // the compute kernel at creation — these cannot change live.
    if (instanceData.useGPUCompute) {
      const gpuBakedKeys = [
        'sizeOverLifetime',
        'opacityOverLifetime',
        'colorOverLifetime',
        'rotationOverLifetime',
        'velocityOverLifetime',
      ] as const;
      for (const key of gpuBakedKeys) {
        if (partialConfig[key] !== undefined) {
          // eslint-disable-next-line no-console
          console.warn(
            `three-particles: updateConfig('${key}') has no effect on the ` +
              'GPU compute backend — modifier curves are baked into the ' +
              'compute kernel at creation. Recreate the system to change it.'
          );
        }
      }
      if (partialConfig.noise?.isActive !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(
          "three-particles: updateConfig('noise.isActive') has no effect on " +
            'the GPU compute backend — the noise toggle is baked into the ' +
            'compute kernel at creation. Recreate the system to change it.'
        );
      }
    }

    // Structural properties are pre-allocated at creation and cannot change.
    const structuralKeys = [
      'maxParticles',
      'renderer',
      'shape',
      'map',
      'simulationBackend',
    ] as const;
    for (const key of structuralKeys) {
      if (partialConfig[key] !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(
          `three-particles: updateConfig('${key}') is a structural property ` +
            'set at creation time and has no runtime effect. Recreate the ' +
            'particle system to change it.'
        );
      }
    }
  };

  return {
    instance: particleSystem,
    resumeEmitter,
    pauseEmitter,
    dispose,
    update,
    updateConfig,
    recolorParticles: recolorLiveParticles,
    getMeanColor,
    getActiveParticleCount: () => maxParticles - freeList.length,
    computeNode: gpuPipeline?.computeNode ?? null,
    feedTouch: (sample) => touchWake?.push(sample),
    clearTouches: () => touchWake?.clear(),
    getTouchCount: () => touchWake?.count ?? 0,
  };
};

/**
 * Updates all active particle systems created with {@link createParticleSystem}.
 *
 * This function must be called once per frame in your animation loop to animate all particles.
 * It handles particle emission, movement, lifetime tracking, modifier application, and cleanup
 * of expired particle systems.
 *
 * @param cycleData - Object containing timing information for the current frame:
 *   - `now`: Current timestamp in milliseconds (typically from `performance.now()` or `Date.now()`)
 *   - `delta`: Time elapsed since the last frame in seconds
 *   - `elapsed`: Total time elapsed since the animation started in seconds
 *
 * @example
 * ```typescript
 * import { createParticleSystem, updateParticleSystems } from '@newkrok/three-particles';
 *
 * const { instance } = createParticleSystem({
 *   // your config
 * });
 * scene.add(instance);
 *
 * // Animation loop
 * let lastTime = 0;
 * let elapsedTime = 0;
 *
 * function animate(currentTime) {
 *   requestAnimationFrame(animate);
 *
 *   const delta = (currentTime - lastTime) / 1000; // Convert to seconds
 *   elapsedTime += delta;
 *   lastTime = currentTime;
 *
 *   // Update all particle systems
 *   updateParticleSystems({
 *     now: currentTime,
 *     delta: delta,
 *     elapsed: elapsedTime
 *   });
 *
 *   renderer.render(scene, camera);
 * }
 *
 * animate(0);
 * ```
 *
 * @example
 * ```typescript
 * // Using Three.js Clock for timing
 * import * as THREE from 'three';
 * import { updateParticleSystems } from '@newkrok/three-particles';
 *
 * const clock = new THREE.Clock();
 *
 * function animate() {
 *   requestAnimationFrame(animate);
 *
 *   const delta = clock.getDelta();
 *   const elapsed = clock.getElapsedTime();
 *
 *   updateParticleSystems({
 *     now: performance.now(),
 *     delta: delta,
 *     elapsed: elapsed
 *   });
 *
 *   renderer.render(scene, camera);
 * }
 * ```
 *
 * @see {@link createParticleSystem} - Creates particle systems to be updated
 * @see {@link CycleData} - Timing data structure
 */
const updateParticleSystemInstance = (
  props: ParticleSystemInstance,
  { now, delta, elapsed }: CycleData
) => {
  const {
    onUpdate,
    generalData,
    onComplete,
    particleSystem,
    elapsedUniform,
    creationTime,
    lastEmissionTime,
    duration,
    looping,
    emission,
    normalizedConfig,
    iterationCount,
    velocities,
    freeList,
    deactivateParticle,
    killParticle,
    activateParticle,
    simulationSpace,
    gravity,
    normalizedForceFields,
    normalizedCollisionPlanes,
    onParticleDeath,
    onParticleBirth,
    mappedAttributes: ma,
    useGPUCompute,
    computePipeline,
    touchWake,
  } = props;

  _frameNow = now;

  const hasForceFields = normalizedForceFields.length > 0;
  const hasCollisionPlanes = normalizedCollisionPlanes.length > 0;

  const lifetime = now - creationTime;
  const normalizedLifetime = lifetime % (duration * 1000);

  generalData.normalizedLifetimePercentage = Math.max(
    Math.min(normalizedLifetime / (duration * 1000), 1),
    0
  );

  const {
    lastWorldPosition,
    currentWorldPosition,
    worldPositionChange,
    worldQuaternion,
    worldEuler,
    gravityVelocity,
    sourceWorldMatrix,
    isEnabled,
  } = generalData;

  _lastWorldPositionSnapshot.copy(lastWorldPosition);

  elapsedUniform.value = elapsed;

  // Emitter pose for this frame.
  //
  // WORLD: build sourceWorldMatrix explicitly (parent.matrixWorld × local).
  //   The particle buffer stores world coordinates, so particleSystem's own
  //   matrixWorld is held at identity (see matrixWorldAutoUpdate=false in
  //   createParticleSystem). sourceWorldMatrix is used to place new
  //   particles and orient the emission shape.
  //
  // LOCAL: standard Three.js — matrixWorld is fully parent-composed at
  //   render time, particles live in the local frame, and emissions use
  //   the identity quaternion (no rotation of the shape offset).
  if (simulationSpace === SimulationSpace.WORLD) {
    particleSystem.updateMatrix();
    if (particleSystem.parent) {
      particleSystem.parent.updateMatrixWorld();
      sourceWorldMatrix.multiplyMatrices(
        particleSystem.parent.matrixWorld,
        particleSystem.matrix
      );
    } else {
      sourceWorldMatrix.copy(particleSystem.matrix);
    }
    sourceWorldMatrix.decompose(
      currentWorldPosition,
      worldQuaternion,
      generalData.worldScale
    );
    generalData.wrapperQuaternion.copy(worldQuaternion);
    particleSystem.matrixWorld.identity();
  } else {
    particleSystem.updateMatrixWorld();
    particleSystem.getWorldPosition(currentWorldPosition);
    particleSystem.getWorldQuaternion(worldQuaternion);
    particleSystem.getWorldScale(generalData.worldScale);
    generalData.wrapperQuaternion.identity();
  }

  if (lastWorldPosition.x !== -99999) {
    worldPositionChange.set(
      currentWorldPosition.x - lastWorldPosition.x,
      currentWorldPosition.y - lastWorldPosition.y,
      currentWorldPosition.z - lastWorldPosition.z
    );
  } else {
    worldPositionChange.set(0, 0, 0);
  }
  if (isEnabled) {
    generalData.distanceFromLastEmitByDistance += worldPositionChange.length();
  }
  lastWorldPosition.copy(currentWorldPosition);
  worldEuler.setFromQuaternion(worldQuaternion);

  // Gravity is always -Y in world space (Unity semantics). In WORLD
  // simulation the buffer is world-space, so gravity is used directly.
  //
  // In LOCAL simulation the buffer is in the emitter's local frame, so
  // gravity is rotated by the inverse of the emitter's world rotation AND
  // divided by the emitter's world scale — this way the rendered fall
  // matches -g m/s² in world units, independent of how the emitter is
  // rotated or scaled by its parent chain.
  if (simulationSpace === SimulationSpace.WORLD) {
    gravityVelocity.set(0, gravity, 0);
  } else {
    gravityVelocity.set(0, gravity, 0);
    _inverseQuat.copy(worldQuaternion).invert();
    gravityVelocity.applyQuaternion(_inverseQuat);
    const sx = generalData.worldScale.x || 1;
    const sy = generalData.worldScale.y || 1;
    const sz = generalData.worldScale.z || 1;
    gravityVelocity.x /= sx;
    gravityVelocity.y /= sy;
    gravityVelocity.z /= sz;
  }

  // Force field positions/directions are user-authored in world space.
  //
  // WORLD simulation: buffer is already in world space — copy through.
  // LOCAL simulation: transform into the emitter's local frame so field
  //   positions and directions match the particle buffer's frame.
  if (hasForceFields) {
    if (simulationSpace === SimulationSpace.LOCAL) {
      _inverseQuat.copy(worldQuaternion).invert();
    }

    _localForceFields.length = normalizedForceFields.length;

    for (let i = 0; i < normalizedForceFields.length; i++) {
      const src = normalizedForceFields[i];
      let dst = _localForceFields[i];
      if (!dst) {
        dst = {
          isActive: true,
          type: ForceFieldType.POINT,
          position: new THREE.Vector3(),
          direction: new THREE.Vector3(),
          strength: 0,
          range: 0,
          falloff: ForceFieldFalloff.LINEAR,
        };
        _localForceFields[i] = dst;
      }
      dst.isActive = src.isActive;
      dst.type = src.type;
      dst.strength = src.strength;
      dst.range = src.range;
      dst.falloff = src.falloff;

      if (simulationSpace === SimulationSpace.WORLD) {
        dst.position.copy(src.position);
        dst.direction.copy(src.direction);
      } else {
        _localForceFieldPos.copy(src.position);
        particleSystem.worldToLocal(_localForceFieldPos);
        dst.position.copy(_localForceFieldPos);

        _localForceFieldDir.copy(src.direction);
        _localForceFieldDir.applyQuaternion(_inverseQuat);
        dst.direction.copy(_localForceFieldDir);
      }
    }
  }

  // Collision plane positions/normals — same policy as force fields.
  if (hasCollisionPlanes) {
    if (simulationSpace === SimulationSpace.LOCAL && !hasForceFields) {
      _inverseQuat.copy(worldQuaternion).invert();
    }

    _localCollisionPlanes.length = normalizedCollisionPlanes.length;

    for (let i = 0; i < normalizedCollisionPlanes.length; i++) {
      const src = normalizedCollisionPlanes[i];
      let dst = _localCollisionPlanes[i];
      if (!dst) {
        dst = {
          isActive: true,
          position: new THREE.Vector3(),
          normal: new THREE.Vector3(),
          mode: CollisionPlaneMode.KILL,
          dampen: 0.5,
          lifetimeLoss: 0,
          recover: 0,
        };
        _localCollisionPlanes[i] = dst;
      }
      dst.isActive = src.isActive;
      dst.mode = src.mode;
      dst.dampen = src.dampen;
      dst.lifetimeLoss = src.lifetimeLoss;
      dst.recover = src.recover;

      if (simulationSpace === SimulationSpace.WORLD) {
        dst.position.copy(src.position);
        dst.normal.copy(src.normal);
      } else {
        _localCollisionPlanePos.copy(src.position);
        particleSystem.worldToLocal(_localCollisionPlanePos);
        dst.position.copy(_localCollisionPlanePos);

        _localCollisionPlaneNormal.copy(src.normal);
        _localCollisionPlaneNormal.applyQuaternion(_inverseQuat);
        dst.normal.copy(_localCollisionPlaneNormal);
      }
    }
  }

  const creationTimes = generalData.creationTimes;
  const scalarArr = props.scalarArray;
  const positionArr = ma.position.array;
  const creationTimesLength = creationTimes.length;

  // ── GPU Compute Path ──────────────────────────────────────────────────
  // When GPU compute is active, all per-particle physics AND modifiers
  // (gravity, velocity, position, lifetime, size/opacity/color/rotation
  // over lifetime, noise, orbital velocity, force fields) run on the GPU
  // in a single compute dispatch. CPU still handles:
  //   - Death detection for sub-emitter callbacks + freeList management
  //   - Emission (particle activation, writing initial data to GPU buffers)
  if (useGPUCompute && computePipeline) {
    type ModifierComputePipeline =
      import('./webgpu/compute-modifiers.js').ModifierComputePipeline;
    const cp = computePipeline as ModifierComputePipeline;

    // Core physics uniforms
    setUniformFloat(cp.uniforms.delta, delta);
    setUniformFloat(cp.uniforms.deltaMs, delta * 1000);
    setUniformVec3(
      cp.uniforms.gravityVelocity,
      gravityVelocity.x,
      gravityVelocity.y,
      gravityVelocity.z
    );

    // Noise uniforms
    // GPU simplex noise output is not normalised by FBM's octave accumulator,
    // so we scale noisePower by the pre-computed divisor (fbmMax).
    const noiseData = generalData.noise;
    setUniformFloat(cp.uniforms.noiseStrength, noiseData.strength);
    setUniformFloat(
      cp.uniforms.noisePower,
      noiseData.noisePower / noiseData.fbmMax
    );
    setUniformFloat(cp.uniforms.noiseFrequency, noiseData.frequency);
    setUniformFloat(cp.uniforms.noisePositionAmount, noiseData.positionAmount);
    setUniformFloat(cp.uniforms.noiseRotationAmount, noiseData.rotationAmount);
    setUniformFloat(cp.uniforms.noiseSizeAmount, noiseData.sizeAmount);
    setUniformFloat(cp.uniforms.noiseTime, elapsed);
    // A pipeline from an older factory (or a test's mock) may not carry it.
    if (cp.uniforms.noiseDrift)
      setUniformVec3(
        cp.uniforms.noiseDrift,
        noiseData.drift?.x ?? DEFAULT_DRIFT.x,
        noiseData.drift?.y ?? DEFAULT_DRIFT.y,
        noiseData.drift?.z ?? DEFAULT_DRIFT.z
      );
    if (cp.trailHistoryInfo) {
      // The kernel stamps this on every sample; the ribbon fades by it.
      setUniformFloat(cp.trailHistoryInfo.nowUniform, elapsed);
      if (props.trailGpuNow) props.trailGpuNow.value = elapsed;
    }
    setUniformVec3(
      cp.uniforms.noiseInfluence,
      noiseData.influence.x,
      noiseData.influence.y,
      noiseData.influence.z
    );

    // Force-field and collision-plane uploads share the `curveData` storage
    // buffer with the per-particle init slots. A blanket `needsUpdate = true`
    // re-uploads the whole Float32Array, which stomps on init flags the
    // compute shader already cleared on the GPU side but are still `1` in
    // the CPU mirror (the `flushEmitQueue` logic only clears them a frame
    // later). We therefore use `addUpdateRange()` so the WebGPU backend
    // uploads just the force-field / collision-plane tail region, leaving
    // the init-slot region intact on the GPU. `flushEmitQueue` does the
    // same for its own region below.
    if (
      cp.forceFieldInfo &&
      hasForceFields &&
      _tslMaterialFactory?.encodeForceFieldsForGPU
    ) {
      const encodedFF = _tslMaterialFactory.encodeForceFieldsForGPU(
        _localForceFields,
        generalData.particleSystemId,
        generalData.normalizedLifetimePercentage
      );
      const curveArr = cp.buffers.curveData.array as Float32Array;
      const offset = cp.forceFieldInfo.offset;
      // Only re-upload when the encoded data actually changed — static
      // force fields would otherwise be uploaded every frame.
      if (!arraySlicesEqual(curveArr, offset, encodedFF, 0, encodedFF.length)) {
        curveArr.set(encodedFF, offset);
        cp.buffers.curveData.addUpdateRange(offset, encodedFF.length);
        cp.buffers.curveData.needsUpdate = true;
      }
      setUniformFloat(
        cp.forceFieldInfo.countUniform,
        normalizedForceFields.length
      );
    }

    if (
      cp.collisionPlaneInfo &&
      hasCollisionPlanes &&
      _tslMaterialFactory?.encodeCollisionPlanesForGPU
    ) {
      const encodedCP = _tslMaterialFactory.encodeCollisionPlanesForGPU(
        _localCollisionPlanes
      );
      const curveArr = cp.buffers.curveData.array as Float32Array;
      const offset = cp.collisionPlaneInfo.offset;
      // Only re-upload when the encoded data actually changed.
      if (!arraySlicesEqual(curveArr, offset, encodedCP, 0, encodedCP.length)) {
        curveArr.set(encodedCP, offset);
        cp.buffers.curveData.addUpdateRange(offset, encodedCP.length);
        cp.buffers.curveData.needsUpdate = true;
      }
      setUniformFloat(
        cp.collisionPlaneInfo.countUniform,
        normalizedCollisionPlanes.length
      );
      // The bounce recovery is one decay for the whole system: the longest
      // recover time among the active bounce planes.
      let recover = 0;
      for (let k = 0; k < normalizedCollisionPlanes.length; k++) {
        const plane = normalizedCollisionPlanes[k];
        if (plane.isActive && plane.mode === CollisionPlaneMode.BOUNCE)
          recover = Math.max(recover, plane.recover);
      }
      setUniformFloat(cp.collisionPlaneInfo.recoverUniform, recover);
    }

    // The finger trail: samples to the curveData tail (its own range, like
    // the force fields), the clock and the levers to uniforms.
    if (cp.touchWakeInfo && touchWake) {
      const touchParams = defaultTouchWakeParams(normalizedConfig.touch);
      const touchNow = touchWake.now();
      touchWake.prune(touchNow, touchParams.wake);
      const encodedTouch = touchWake.encode();
      const curveArr = cp.buffers.curveData.array as Float32Array;
      const offset = cp.touchWakeInfo.offset;
      if (
        !arraySlicesEqual(
          curveArr,
          offset,
          encodedTouch,
          0,
          encodedTouch.length
        )
      ) {
        curveArr.set(encodedTouch, offset);
        cp.buffers.curveData.addUpdateRange(offset, encodedTouch.length);
        cp.buffers.curveData.needsUpdate = true;
      }
      setUniformFloat(cp.touchWakeInfo.countUniform, touchWake.count);
      setUniformFloat(cp.touchWakeInfo.nowUniform, touchNow);
      setUniformFloat(cp.touchWakeInfo.strengthUniform, touchParams.strength);
      setUniformFloat(cp.touchWakeInfo.wakeUniform, touchParams.wake);
      setUniformFloat(cp.touchWakeInfo.swirlUniform, touchParams.swirl);
      (
        cp.touchWakeInfo.normalUniform as unknown as { value: THREE.Vector3 }
      ).value.set(
        touchParams.normal.x,
        touchParams.normal.y,
        touchParams.normal.z
      );
    }

    // Flush emit queue — uploads queued particle data to GPU and sets the
    // emit count uniform so the compute shader's scatter pass can initialise
    // newly emitted particles without overwriting existing GPU state.
    if (_tslMaterialFactory?.flushEmitQueue) {
      _tslMaterialFactory.flushEmitQueue(cp.buffers);
    }

    // Signal onBeforeRender to dispatch compute
    props.computeDispatchReady = true;

    // CPU-side death detection (for sub-emitter callbacks + freeList).
    // When death sub-emitters exist we also run a lightweight CPU shadow
    // simulation (velocity integration, gravity, orbital velocity, force
    // fields) so that positionArr contains an approximate current position
    // instead of the stale emission-time value — the GPU buffer is not
    // readable from the CPU without an async readback.
    if (hasForceFields) {
      _forceFieldParams.particleSystemId = generalData.particleSystemId;
      _forceFieldParams.forceFields = _localForceFields;
      _forceFieldParams.positionArr = positionArr;
      _forceFieldParams.delta = delta;
      _forceFieldParams.systemLifetimePercentage =
        generalData.normalizedLifetimePercentage;
    }
    if (hasCollisionPlanes) {
      _collisionParams.collisionPlanes = _localCollisionPlanes;
      _collisionParams.positionArr = positionArr;
      _collisionParams.scalarArr = scalarArr;
      _collisionParams.deactivateParticle = killParticle;
    }
    for (let index = 0; index < creationTimesLength; index++) {
      const base = index * SCALAR_STRIDE;
      if (scalarArr[base + S_IS_ACTIVE]) {
        const particleLifetime = now - creationTimes[index];
        if (particleLifetime > scalarArr[base + S_START_LIFETIME]) {
          if (onParticleDeath)
            onParticleDeath(index, positionArr, velocities[index], now);
          deactivateParticle(index);
        } else if (onParticleDeath) {
          // Shadow simulation: keep CPU-side position in sync for sub-emitters.
          // We intentionally avoid calling applyModifiers() here because it
          // sets attributes.position.needsUpdate = true, which triggers a full
          // CPU→GPU upload that overwrites GPU-computed positions for ALL
          // particles.  Instead we do the minimal physics inline without
          // touching needsUpdate.
          const velocity = velocities[index];
          velocity.x -= gravityVelocity.x * delta;
          velocity.y -= gravityVelocity.y * delta;
          velocity.z -= gravityVelocity.z * delta;

          if (hasForceFields) {
            _forceFieldParams.velocity = velocity;
            _forceFieldParams.positionIndex = index * 3;
            applyForceFields(_forceFieldParams);
          }

          const positionIndex = index * 3;
          positionArr[positionIndex] += velocity.x * delta;
          positionArr[positionIndex + 1] += velocity.y * delta;
          positionArr[positionIndex + 2] += velocity.z * delta;

          // Orbital velocity (mirrors CPU applyModifiers orbital logic)
          if (generalData.orbitalVelocityData) {
            const orbData = generalData.orbitalVelocityData[index];
            const { speed, positionOffset, valueModifiers } = orbData;
            const pctLife =
              particleLifetime / scalarArr[base + S_START_LIFETIME];

            positionArr[positionIndex] -= positionOffset.x;
            positionArr[positionIndex + 1] -= positionOffset.y;
            positionArr[positionIndex + 2] -= positionOffset.z;

            const sx = valueModifiers.x ? valueModifiers.x(pctLife) : speed.x;
            const sy = valueModifiers.y ? valueModifiers.y(pctLife) : speed.y;
            const sz = valueModifiers.z ? valueModifiers.z(pctLife) : speed.z;

            _shadowOrbitalEuler.set(sx * delta, sz * delta, sy * delta);
            positionOffset.applyEuler(_shadowOrbitalEuler);

            positionArr[positionIndex] += positionOffset.x;
            positionArr[positionIndex + 1] += positionOffset.y;
            positionArr[positionIndex + 2] += positionOffset.z;
          }

          // Collision planes (shadow sim — for KILL death detection only)
          if (hasCollisionPlanes) {
            _collisionParams.velocity = velocity;
            _collisionParams.positionIndex = positionIndex;
            _collisionParams.scalarBase = base;
            _collisionParams.particleIndex = index;
            applyCollisionPlanes(_collisionParams);
          }
        }
      }
    }
  } else {
    // ── CPU Path ────────────────────────────────────────────────────────

    let positionNeedsUpdate = false;
    let scalarNeedsUpdate = false;
    // Highest particle index written this frame — merged into the monotonic
    // generalData.cpuDirtyParticleWatermark used by the partial-upload flush.
    let maxTouchedIndex = -1;

    _modifierUpdateFlags.position = false;
    _modifierUpdateFlags.quat = false;
    _modifierParams.delta = delta;
    _modifierParams.elapsed = elapsed;
    _modifierParams.generalData = generalData;
    _modifierParams.normalizedConfig = normalizedConfig;
    _modifierParams.attributes = ma;
    _modifierParams.scalarArray = scalarArr;

    if (hasForceFields) {
      _forceFieldParams.particleSystemId = generalData.particleSystemId;
      _forceFieldParams.forceFields = _localForceFields;
      _forceFieldParams.positionArr = positionArr;
      _forceFieldParams.delta = delta;
      _forceFieldParams.systemLifetimePercentage =
        generalData.normalizedLifetimePercentage;
    }
    // The finger trail on the CPU backend: same sum as the GPU kernel.
    const touchParams = touchWake
      ? defaultTouchWakeParams(normalizedConfig.touch)
      : null;
    const touchNow = touchWake ? touchWake.now() : 0;
    if (touchWake && touchParams) touchWake.prune(touchNow, touchParams.wake);
    const touchLive = !!touchWake && touchWake.count > 0;
    if (hasCollisionPlanes) {
      _collisionParams.collisionPlanes = _localCollisionPlanes;
      _collisionParams.positionArr = positionArr;
      _collisionParams.scalarArr = scalarArr;
      _collisionParams.deactivateParticle = killParticle;
    }

    for (let index = 0; index < creationTimesLength; index++) {
      const base = index * SCALAR_STRIDE;
      if (scalarArr[base + S_IS_ACTIVE]) {
        maxTouchedIndex = index;
        const particleLifetime = now - creationTimes[index];
        if (particleLifetime > scalarArr[base + S_START_LIFETIME]) {
          if (onParticleDeath)
            onParticleDeath(index, positionArr, velocities[index], now);
          deactivateParticle(index);
        } else {
          const velocity = velocities[index];
          velocity.x -= gravityVelocity.x * delta;
          velocity.y -= gravityVelocity.y * delta;
          velocity.z -= gravityVelocity.z * delta;

          if (hasForceFields) {
            _forceFieldParams.velocity = velocity;
            _forceFieldParams.positionIndex = index * 3;
            applyForceFields(_forceFieldParams);
          }

          if (
            touchLive &&
            touchWake &&
            touchParams &&
            applyTouchWakeCPU(
              positionArr,
              index * 3,
              touchWake.list,
              touchWake.count,
              touchNow,
              delta,
              touchParams
            )
          ) {
            positionNeedsUpdate = true;
          }

          if (
            gravity !== 0 ||
            velocity.x !== 0 ||
            velocity.y !== 0 ||
            velocity.z !== 0
          ) {
            const positionIndex = index * 3;

            positionArr[positionIndex] += velocity.x * delta;
            positionArr[positionIndex + 1] += velocity.y * delta;
            positionArr[positionIndex + 2] += velocity.z * delta;
            positionNeedsUpdate = true;
          }

          // Collision planes — after position update, before modifiers
          if (hasCollisionPlanes) {
            _collisionParams.velocity = velocity;
            _collisionParams.positionIndex = index * 3;
            _collisionParams.scalarBase = base;
            _collisionParams.particleIndex = index;
            const killed = applyCollisionPlanes(_collisionParams);
            if (killed) {
              positionNeedsUpdate = true;
              continue;
            }
          }

          scalarArr[base + S_LIFETIME] = particleLifetime;
          scalarNeedsUpdate = true;

          _modifierParams.particleLifetimePercentage =
            particleLifetime / scalarArr[base + S_START_LIFETIME];
          _modifierParams.particleIndex = index;
          applyModifiers(_modifierParams);
        }
      }
    }

    if (_modifierUpdateFlags.position) positionNeedsUpdate = true;
    if (_modifierUpdateFlags.quat && ma.quat) ma.quat.needsUpdate = true;

    if (maxTouchedIndex > generalData.cpuDirtyParticleWatermark)
      generalData.cpuDirtyParticleWatermark = maxTouchedIndex;
    if (positionNeedsUpdate) ma.position.needsUpdate = true;
    if (scalarNeedsUpdate) props.scalarInterleavedBuffer.needsUpdate = true;
  } // end of CPU/GPU compute branch

  if (isEnabled && (looping || lifetime < duration * 1000)) {
    // lastEmissionTime starts at creationTime (which includes startDelay and
    // may be in the future) — a non-positive delta means emission hasn't
    // started yet, so leave lastEmissionTime untouched until it has.
    const emissionDelta = now - lastEmissionTime;
    let neededParticlesByTime = 0;
    if (emissionDelta > 0) {
      props.lastEmissionTime = now;

      // Time-based emission uses a fractional accumulator: flooring the
      // per-frame amount would systematically drop the remainder (e.g. a
      // rate of 100/s at 60 FPS is ~1.66 particles per frame — flooring
      // emits only 60/s). The fraction below 1 carries over. The integer
      // part is consumed immediately even when the pool is exhausted, so
      // overflow emissions are dropped (Unity semantics) and a saturated
      // system refills freed slots at rate speed instead of instantly.
      // Note: pauseEmitter/resumeEmitter can still produce one pool-bounded
      // burst on resume because lastEmissionTime goes stale while disabled
      // (pre-existing behavior).
      if (emission.rateOverTime) {
        props.emissionAccumulator +=
          calculateValue(
            generalData.particleSystemId,
            emission.rateOverTime,
            generalData.normalizedLifetimePercentage
          ) *
          (emissionDelta / 1000);
      }
      neededParticlesByTime = Math.floor(props.emissionAccumulator);
      if (neededParticlesByTime > 0)
        props.emissionAccumulator -= neededParticlesByTime;
    }

    const rateOverDistance = emission.rateOverDistance
      ? calculateValue(
          generalData.particleSystemId,
          emission.rateOverDistance,
          generalData.normalizedLifetimePercentage
        )
      : 0;
    const neededParticlesByDistance =
      rateOverDistance > 0 && generalData.distanceFromLastEmitByDistance > 0
        ? Math.floor(
            generalData.distanceFromLastEmitByDistance / (1 / rateOverDistance!)
          )
        : 0;
    const useDistanceStep = neededParticlesByDistance > 0;
    if (useDistanceStep) {
      _distanceStep.x =
        (currentWorldPosition.x - _lastWorldPositionSnapshot.x) /
        neededParticlesByDistance;
      _distanceStep.y =
        (currentWorldPosition.y - _lastWorldPositionSnapshot.y) /
        neededParticlesByDistance;
      _distanceStep.z =
        (currentWorldPosition.z - _lastWorldPositionSnapshot.z) /
        neededParticlesByDistance;
    }
    let neededParticles = neededParticlesByTime + neededParticlesByDistance;

    if (rateOverDistance > 0 && neededParticlesByDistance >= 1) {
      // Keep the fractional remainder instead of resetting to zero so slow,
      // steady movement doesn't systematically under-emit.
      generalData.distanceFromLastEmitByDistance = Math.max(
        generalData.distanceFromLastEmitByDistance -
          neededParticlesByDistance / rateOverDistance,
        0
      );
    }

    // Process burst emissions
    if (emission.bursts && generalData.burstStates) {
      const bursts = emission.bursts;
      const burstStates = generalData.burstStates;
      const currentIterationTime = normalizedLifetime;

      for (let i = 0; i < bursts.length; i++) {
        const burst = bursts[i];
        const state = burstStates[i];
        const burstTimeMs = burst.time * 1000;
        const cycles = burst.cycles ?? 1;
        const intervalMs = (burst.interval ?? 0) * 1000;
        const probability = burst.probability ?? 1;

        // Check if we've looped and need to reset burst states
        if (
          looping &&
          currentIterationTime < burstTimeMs &&
          state.cyclesExecuted > 0
        ) {
          state.cyclesExecuted = 0;
          state.lastCycleTime = 0;
          state.probabilityPassed = false;
        }

        // Check if all cycles for this burst have been executed
        if (state.cyclesExecuted >= cycles) continue;

        // Calculate the time for the next cycle
        const nextCycleTime = burstTimeMs + state.cyclesExecuted * intervalMs;

        // Check if it's time for the next cycle
        if (currentIterationTime >= nextCycleTime) {
          // On first cycle, determine if probability check passes
          if (state.cyclesExecuted === 0) {
            state.probabilityPassed = Math.random() < probability;
          }

          // Only emit if probability check passed
          if (state.probabilityPassed) {
            const burstCount = Math.floor(
              calculateValue(
                generalData.particleSystemId,
                burst.count,
                generalData.normalizedLifetimePercentage
              )
            );
            neededParticles += burstCount;
          }

          state.cyclesExecuted++;
          state.lastCycleTime = currentIterationTime;
        }
      }
    }

    if (neededParticles > 0) {
      let generatedParticlesByDistanceNeeds = 0;

      for (let i = 0; i < neededParticles; i++) {
        if (freeList.length === 0) break;
        const particleIndex = freeList.pop()!;

        _tempPosition.x = 0;
        _tempPosition.y = 0;
        _tempPosition.z = 0;
        if (
          useDistanceStep &&
          generatedParticlesByDistanceNeeds < neededParticlesByDistance
        ) {
          _tempPosition.x = _distanceStep.x * generatedParticlesByDistanceNeeds;
          _tempPosition.y = _distanceStep.y * generatedParticlesByDistanceNeeds;
          _tempPosition.z = _distanceStep.z * generatedParticlesByDistanceNeeds;
          generatedParticlesByDistanceNeeds++;
        }
        activateParticle({
          particleIndex,
          activationTime: now,
          position: _tempPosition,
        });
        if (onParticleBirth)
          onParticleBirth(
            particleIndex,
            ma.position.array,
            velocities[particleIndex],
            now
          );
      }
    }

    if (onUpdate)
      onUpdate({
        particleSystem,
        delta,
        elapsed,
        lifetime,
        normalizedLifetime,
        iterationCount: iterationCount + 1,
      });
  } else if (onComplete)
    onComplete({
      particleSystem,
    });

  // Partial-upload hint (CPU path): replace any pending ranges with a single
  // range covering [0, watermark]. The watermark is the monotonic maximum of
  // every particle index ever written, so this one range is a covering
  // superset of all writes since the last GPU upload no matter when the
  // renderer actually consumes it — and clearing first keeps the pending
  // range list at a constant size even when the system is updated while
  // hidden or frustum-culled (never rendered → three.js never clears it).
  if (!useGPUCompute) {
    const watermark = generalData.cpuDirtyParticleWatermark;
    if (watermark >= 0) {
      const posAttr = ma.position as THREE.BufferAttribute;
      posAttr.clearUpdateRanges();
      posAttr.addUpdateRange(0, (watermark + 1) * 3);
      props.scalarInterleavedBuffer.clearUpdateRanges();
      props.scalarInterleavedBuffer.addUpdateRange(
        0,
        (watermark + 1) * SCALAR_STRIDE
      );
    }
  }

  // Trail geometry update: record position history and rebuild ribbon
  if (props.trailMesh) {
    updateTrailGeometry(props, now);
  }
};

/**
 * Evaluates a Catmull-Rom spline at parameter `t` (0..1) between points p1 and p2,
 * using p0 and p3 as control points. Writes result into `out`.
 */
const catmullRom = (
  out: Float32Array,
  outIdx: number,
  p0x: number,
  p0y: number,
  p0z: number,
  p1x: number,
  p1y: number,
  p1z: number,
  p2x: number,
  p2y: number,
  p2z: number,
  p3x: number,
  p3y: number,
  p3z: number,
  t: number
) => {
  const t2 = t * t;
  const t3 = t2 * t;
  out[outIdx] =
    0.5 *
    (2 * p1x +
      (-p0x + p2x) * t +
      (2 * p0x - 5 * p1x + 4 * p2x - p3x) * t2 +
      (-p0x + 3 * p1x - 3 * p2x + p3x) * t3);
  out[outIdx + 1] =
    0.5 *
    (2 * p1y +
      (-p0y + p2y) * t +
      (2 * p0y - 5 * p1y + 4 * p2y - p3y) * t2 +
      (-p0y + 3 * p1y - 3 * p2y + p3y) * t3);
  out[outIdx + 2] =
    0.5 *
    (2 * p1z +
      (-p0z + p2z) * t +
      (2 * p0z - 5 * p1z + 4 * p2z - p3z) * t2 +
      (-p0z + 3 * p1z - 3 * p2z + p3z) * t3);
};

/** Zeroes out a single trail vertex (both left+right sides). */
const clearTrailVertex = (
  vIdx: number,
  cIdx: number,
  aIdx: number,
  uvIdx: number,
  trailPosArr: Float32Array,
  trailNextArr: Float32Array,
  trailHalfWidthArr: Float32Array,
  trailUVArr: Float32Array,
  trailAlphaArr: Float32Array,
  trailColorArr: Float32Array,
  fallbackX: number,
  fallbackY: number,
  fallbackZ: number
) => {
  trailPosArr[vIdx] = fallbackX;
  trailPosArr[vIdx + 1] = fallbackY;
  trailPosArr[vIdx + 2] = fallbackZ;
  trailPosArr[vIdx + 3] = fallbackX;
  trailPosArr[vIdx + 4] = fallbackY;
  trailPosArr[vIdx + 5] = fallbackZ;
  trailNextArr[vIdx] = fallbackX;
  trailNextArr[vIdx + 1] = fallbackY;
  trailNextArr[vIdx + 2] = fallbackZ;
  trailNextArr[vIdx + 3] = fallbackX;
  trailNextArr[vIdx + 4] = fallbackY;
  trailNextArr[vIdx + 5] = fallbackZ;
  trailHalfWidthArr[aIdx] = 0;
  trailHalfWidthArr[aIdx + 1] = 0;
  trailUVArr[uvIdx] = 0;
  trailUVArr[uvIdx + 1] = 0;
  trailUVArr[uvIdx + 2] = 0;
  trailUVArr[uvIdx + 3] = 0;
  trailAlphaArr[aIdx] = 0;
  trailAlphaArr[aIdx + 1] = 0;
  trailColorArr[cIdx] = 0;
  trailColorArr[cIdx + 1] = 0;
  trailColorArr[cIdx + 2] = 0;
  trailColorArr[cIdx + 3] = 0;
  trailColorArr[cIdx + 4] = 0;
  trailColorArr[cIdx + 5] = 0;
  trailColorArr[cIdx + 6] = 0;
  trailColorArr[cIdx + 7] = 0;
};

/**
 * Writes a single trail ribbon vertex pair (left+right) into the typed arrays.
 */
const writeTrailVertex = (
  vIdx: number,
  cIdx: number,
  aIdx: number,
  uvIdx: number,
  hx: number,
  hy: number,
  hz: number,
  nx: number,
  ny: number,
  nz: number,
  halfWidth: number,
  t: number,
  roll: number,
  alpha: number,
  fr: number,
  fg: number,
  fb: number,
  ca: number,
  trailPosArr: Float32Array,
  trailNextArr: Float32Array,
  trailHalfWidthArr: Float32Array,
  trailUVArr: Float32Array,
  trailAlphaArr: Float32Array,
  trailColorArr: Float32Array
) => {
  trailPosArr[vIdx] = hx;
  trailPosArr[vIdx + 1] = hy;
  trailPosArr[vIdx + 2] = hz;
  trailPosArr[vIdx + 3] = hx;
  trailPosArr[vIdx + 4] = hy;
  trailPosArr[vIdx + 5] = hz;
  trailNextArr[vIdx] = nx;
  trailNextArr[vIdx + 1] = ny;
  trailNextArr[vIdx + 2] = nz;
  trailNextArr[vIdx + 3] = nx;
  trailNextArr[vIdx + 4] = ny;
  trailNextArr[vIdx + 5] = nz;
  trailHalfWidthArr[aIdx] = halfWidth;
  trailHalfWidthArr[aIdx + 1] = halfWidth;
  // uv.x carries the roll about the tangent (the shader derives the
  // across-ribbon coordinate from trailOffset); uv.y is the place along it.
  trailUVArr[uvIdx] = roll;
  trailUVArr[uvIdx + 1] = t;
  trailUVArr[uvIdx + 2] = roll;
  trailUVArr[uvIdx + 3] = t;
  trailAlphaArr[aIdx] = alpha;
  trailAlphaArr[aIdx + 1] = alpha;
  trailColorArr[cIdx] = fr;
  trailColorArr[cIdx + 1] = fg;
  trailColorArr[cIdx + 2] = fb;
  trailColorArr[cIdx + 3] = ca;
  trailColorArr[cIdx + 4] = fr;
  trailColorArr[cIdx + 5] = fg;
  trailColorArr[cIdx + 6] = fb;
  trailColorArr[cIdx + 7] = ca;
};

// Scratch buffers reused each frame to avoid per-particle allocations
let _rawPoints: Float32Array | null = null;
let _rawPointsSize = 0;
let _smoothedPoints: Float32Array | null = null;
let _smoothedPointsSize = 0;
// Scratch buffer for connected ribbon particle indices (reused each frame).
// Uint32 so systems with more than 65535 particles don't silently wrap.
let _ribbonIndices: Uint32Array | null = null;
let _ribbonIndicesSize = 0;
let _ribbonCount = 0;

/**
 * Records current particle positions into the history ring buffer,
 * then rebuilds the triangle-strip ribbon geometry for all active particles.
 *
 * Supports:
 * - Adaptive sampling (minVertexDistance): frame-rate independent trail density
 * - Max time (maxTime): time-based trail expiry
 * - Catmull-Rom smoothing: eliminates sharp kinks between samples
 * - Twist prevention: consistent ribbon orientation during rapid direction changes
 * - Connected ribbons (ribbonId): multiple particles forming a single ribbon
 */
const updateTrailGeometry = (props: ParticleSystemInstance, now: number) => {
  const {
    generalData,
    trailPositionAttr,
    trailAlphaAttr,
    trailColorAttr,
    trailNextAttr: trailNextAttrCached,
    trailHalfWidthAttr: trailHalfWidthAttrCached,
    trailUVAttr: trailUVAttrCached,
    trailWidthCurveFn,
    trailOpacityCurveFn,
    trailColorOverTrailFns,
    trailConfig,
    mappedAttributes: ma,
  } = props;

  if (
    !trailPositionAttr ||
    !trailAlphaAttr ||
    !trailColorAttr ||
    !trailNextAttrCached ||
    !trailHalfWidthAttrCached ||
    !trailUVAttrCached ||
    !trailWidthCurveFn ||
    !trailOpacityCurveFn ||
    !trailConfig ||
    !generalData.positionHistory ||
    !generalData.positionHistoryIndex ||
    !generalData.positionHistoryCount
  )
    return;

  const trailLength = trailConfig.length;
  const slotCount = generalData.trailSlotCount ?? trailLength;
  const positionHistory = generalData.positionHistory;
  const historyIndex = generalData.positionHistoryIndex;
  const historyCount = generalData.positionHistoryCount;
  const sampleTimes = generalData.trailSampleTimes;
  const lastSampledPos = generalData.trailLastSampledPosition;
  const prevNormal = generalData.trailPrevNormal;
  const minVertexDist = trailConfig.minVertexDistance;
  const minVertexDistSq = minVertexDist * minVertexDist;
  const maxTime = trailConfig.maxTime;
  const maxTimeMs = maxTime * 1000;
  const useSmoothing = trailConfig.smoothing;
  const subdivisions = trailConfig.smoothingSubdivisions;
  const useTwistPrevention = trailConfig.twistPrevention;
  const ribbonId = trailConfig.ribbonId;

  const trailScalarArr = props.scalarArray;
  const positionArr = ma.position.array;
  // Vertex-buffer fill counts from the previous frame — cleared slots stay
  // cleared (zero alpha/half-width), so re-clearing them every frame is
  // redundant work proportional to maxParticles × trailLength.
  const prevFilled = generalData.trailPrevFilledCount;

  const trailPosArr = trailPositionAttr.array as Float32Array;
  const trailAlphaArr = trailAlphaAttr.array as Float32Array;
  const trailColorArr = trailColorAttr.array as Float32Array;
  const trailNextArr = trailNextAttrCached.array as Float32Array;
  const trailUVArr = trailUVAttrCached.array as Float32Array;
  const trailHalfWidthArr = trailHalfWidthAttrCached.array as Float32Array;
  const verticesPerParticle = slotCount * 2;
  const creationTimesLength = generalData.creationTimes.length;
  let hasUpdates = false;
  // The highest particle whose slots were written or cleared this frame.
  // Slots are handed out from index 0 and recycled last-in-first-out, so
  // the live ribbons sit at the bottom of the buffers and everything above
  // the high-water mark is cleared and unchanged — the upload stops there.
  let highestTouched = -1;

  // --- Connected Ribbons: collect particles sharing the same ribbonId ---
  const useRibbon = ribbonId !== undefined;
  let ribbonLeader = -1;
  if (useRibbon) {
    // Pre-allocate scratch buffer for ribbon indices
    if (!_ribbonIndices || _ribbonIndicesSize < creationTimesLength) {
      _ribbonIndices = new Uint32Array(creationTimesLength);
      _ribbonIndicesSize = creationTimesLength;
    }
    _ribbonCount = 0;
    for (let i = 0; i < creationTimesLength; i++) {
      if (trailScalarArr[i * SCALAR_STRIDE + S_IS_ACTIVE])
        _ribbonIndices[_ribbonCount++] = i;
    }
    // Insertion sort by creation time (typically nearly-sorted, O(n) best case)
    for (let i = 1; i < _ribbonCount; i++) {
      const key = _ribbonIndices[i];
      const keyTime = generalData.creationTimes[key];
      let j = i - 1;
      while (j >= 0 && generalData.creationTimes[_ribbonIndices[j]] > keyTime) {
        _ribbonIndices[j + 1] = _ribbonIndices[j];
        j--;
      }
      _ribbonIndices[j + 1] = key;
    }
    if (_ribbonCount > 0) ribbonLeader = _ribbonIndices[0];
  }

  for (let index = 0; index < creationTimesLength; index++) {
    const vertBase = index * verticesPerParticle;

    if (trailScalarArr[index * SCALAR_STRIDE + S_IS_ACTIVE]) {
      // Skip individual trail build for non-leader ribbon particles
      // (the leader's trail will be built by the connected ribbon section)
      if (useRibbon && _ribbonCount >= 2 && index !== ribbonLeader) {
        // Still record position history for this particle (needed for sampling)
        const posIdx = index * 3;
        const px = positionArr[posIdx];
        const py = positionArr[posIdx + 1];
        const pz = positionArr[posIdx + 2];
        const histBase = (index * trailLength + historyIndex[index]) * 3;
        positionHistory[histBase] = px;
        positionHistory[histBase + 1] = py;
        positionHistory[histBase + 2] = pz;
        if (sampleTimes) {
          sampleTimes[index * trailLength + historyIndex[index]] = now;
        }
        historyIndex[index] = (historyIndex[index] + 1) % trailLength;
        if (historyCount[index] < trailLength) historyCount[index]++;
        continue;
      }
      hasUpdates = true;
      highestTouched = index;
      const posIdx = index * 3;
      const px = positionArr[posIdx];
      const py = positionArr[posIdx + 1];
      const pz = positionArr[posIdx + 2];

      // --- Adaptive Sampling: only push a new sample if distance threshold met ---
      let shouldSample = true;
      if (minVertexDist > 0 && lastSampledPos && historyCount[index] > 0) {
        const lsIdx = index * 3;
        const dx = px - lastSampledPos[lsIdx];
        const dy = py - lastSampledPos[lsIdx + 1];
        const dz = pz - lastSampledPos[lsIdx + 2];
        if (dx * dx + dy * dy + dz * dz < minVertexDistSq) {
          shouldSample = false;
        }
      }

      if (shouldSample) {
        // Record the sample
        const histBase = (index * trailLength + historyIndex[index]) * 3;
        positionHistory[histBase] = px;
        positionHistory[histBase + 1] = py;
        positionHistory[histBase + 2] = pz;

        // Record timestamp for maxTime
        if (sampleTimes) {
          sampleTimes[index * trailLength + historyIndex[index]] = now;
        }

        historyIndex[index] = (historyIndex[index] + 1) % trailLength;
        if (historyCount[index] < trailLength) historyCount[index]++;

        // Update last sampled position
        if (lastSampledPos) {
          const lsIdx = index * 3;
          lastSampledPos[lsIdx] = px;
          lastSampledPos[lsIdx + 1] = py;
          lastSampledPos[lsIdx + 2] = pz;
        }
      }

      // --- MaxTime: determine effective count (expire old segments) ---
      let rawCount = historyCount[index];
      let effectiveCount = rawCount;
      if (maxTime > 0 && sampleTimes && rawCount > 0) {
        const sampleBase = index * trailLength;
        effectiveCount = 0;
        for (let s = 0; s < rawCount; s++) {
          const sampleSlot =
            (historyIndex[index] - 1 - s + trailLength * 2) % trailLength;
          const age = now - sampleTimes[sampleBase + sampleSlot];
          if (age <= maxTimeMs) {
            effectiveCount++;
          } else {
            break; // older samples are even older, stop
          }
        }
      }

      const count = effectiveCount;
      const ribbonWidth = trailConfig.width;

      // Get particle color from interleaved scalar buffer
      const trailBase = index * SCALAR_STRIDE;
      const cr = trailScalarArr[trailBase + S_COLOR_R];
      const cg = trailScalarArr[trailBase + S_COLOR_G];
      const cb = trailScalarArr[trailBase + S_COLOR_B];
      const ca = trailScalarArr[trailBase + S_COLOR_A];
      // The ribbon follows the particle: its width is in units of the
      // particle's current size (startSize, sizeOverLifetime, the noise's
      // size amount), and its rotation rolls the ribbon about its own
      // tangent — edge-on it is a line, face-on it is full width.
      const size = trailScalarArr[trailBase + S_SIZE];
      const roll = trailScalarArr[trailBase + S_ROTATION];

      const ringOff = index * trailLength * 3;

      // --- Collect raw history points for this particle ---
      // We need them for both smoothing and the ribbon build.
      // rawPts: flat array of [x, y, z, x, y, z, ...] for count entries
      // rawPts[0..2] = head (most recent), rawPts[(count-1)*3..(count-1)*3+2] = tail
      const rawPtsSize = count * 3;
      // Reuse a scratch float array for raw points
      if (!_rawPoints || _rawPointsSize < rawPtsSize) {
        _rawPoints = new Float32Array(rawPtsSize);
        _rawPointsSize = rawPtsSize;
      }
      const rawPts = _rawPoints;
      for (let s = 0; s < count; s++) {
        const histSlot =
          ((historyIndex[index] - 1 - s + trailLength * 2) % trailLength) * 3 +
          ringOff;
        rawPts[s * 3] = positionHistory[histSlot];
        rawPts[s * 3 + 1] = positionHistory[histSlot + 1];
        rawPts[s * 3 + 2] = positionHistory[histSlot + 2];
      }

      // --- Catmull-Rom Smoothing ---
      let finalPts: Float32Array;
      let finalCount: number;

      if (useSmoothing && count >= 3) {
        // Resample the Catmull-Rom spline through all `count` raw samples at
        // (count − 1) × subdivisions + 1 points, capped at the slot count, so
        // the smoothed trail always spans the whole raw trail. (Laying the
        // subdivisions down segment by segment from the head and cutting the
        // surplus, as before, showed only the first 1/subdivisions of it.)
        const segmentCount = count - 1;
        finalCount = Math.min(segmentCount * subdivisions + 1, slotCount);
        const neededSize = finalCount * 3;

        // Resize global scratch buffer if needed
        if (!_smoothedPoints || _smoothedPointsSize < neededSize) {
          _smoothedPoints = new Float32Array(neededSize);
          _smoothedPointsSize = neededSize;
        }
        finalPts = _smoothedPoints;

        const last = finalCount - 1;
        for (let k = 0; k < last; k++) {
          // Where along the raw chain this output point falls.
          const u = (k / last) * segmentCount;
          const seg = Math.min(Math.floor(u), segmentCount - 1);
          const t = u - seg;
          const i0 = Math.max(0, seg - 1);
          const i1 = seg;
          const i2 = Math.min(count - 1, seg + 1);
          const i3 = Math.min(count - 1, seg + 2);
          catmullRom(
            finalPts,
            k * 3,
            rawPts[i0 * 3],
            rawPts[i0 * 3 + 1],
            rawPts[i0 * 3 + 2],
            rawPts[i1 * 3],
            rawPts[i1 * 3 + 1],
            rawPts[i1 * 3 + 2],
            rawPts[i2 * 3],
            rawPts[i2 * 3 + 1],
            rawPts[i2 * 3 + 2],
            rawPts[i3 * 3],
            rawPts[i3 * 3 + 1],
            rawPts[i3 * 3 + 2],
            t
          );
        }
        // Last point = last raw point
        finalPts[last * 3] = rawPts[(count - 1) * 3];
        finalPts[last * 3 + 1] = rawPts[(count - 1) * 3 + 1];
        finalPts[last * 3 + 2] = rawPts[(count - 1) * 3 + 2];
      } else {
        finalPts = rawPts;
        finalCount = count;
      }

      // Limit final count to the number of slots we can fill
      if (finalCount > slotCount) finalCount = slotCount;

      // Collapse degenerate segments: when two consecutive smoothed points are
      // nearly identical the shader tangent becomes zero, producing distorted
      // "squished" ribbon quads. Shift such points to the next distinct neighbor.
      if (useSmoothing && finalCount >= 2) {
        const MIN_SEG_DIST_SQ = 0.0001 * 0.0001;
        for (let d = 1; d < finalCount; d++) {
          const pi = (d - 1) * 3;
          const ci = d * 3;
          const dx = finalPts[ci] - finalPts[pi];
          const dy = finalPts[ci + 1] - finalPts[pi + 1];
          const dz = finalPts[ci + 2] - finalPts[pi + 2];
          if (dx * dx + dy * dy + dz * dz < MIN_SEG_DIST_SQ) {
            // Snap to previous point — the shader will get a near-zero tangent
            // but the vertex pair collapses to the same position, hiding it
            finalPts[ci] = finalPts[pi];
            finalPts[ci + 1] = finalPts[pi + 1];
            finalPts[ci + 2] = finalPts[pi + 2];
          }
        }
      }

      // --- Build ribbon vertices ---
      const prevFilledSlots = prevFilled ? prevFilled[index] : slotCount;
      if (prevFilled) prevFilled[index] = finalCount;
      for (let s = 0; s < slotCount; s++) {
        const vIdx = (vertBase + s * 2) * 3;
        const cIdx = (vertBase + s * 2) * 4;
        const aIdx = vertBase + s * 2;
        const uvIdxBase = (vertBase + s * 2) * 2;

        if (s >= finalCount) {
          // The slot right after the last live sample closes the ribbon: the
          // index buffer always draws a segment from the last sample to it,
          // so it has to sit on the head, every frame. Left alone it holds
          // whatever it was last cleared to — the origin, after a death or on
          // a fresh buffer — and every newborn draws a sliver from itself to
          // the centre of the emitter until its second sample lands.
          // Slots beyond that one are only ever drawn against each other and
          // can stay as they are once cleared.
          if (s > finalCount && s >= prevFilledSlots) break;
          clearTrailVertex(
            vIdx,
            cIdx,
            aIdx,
            uvIdxBase,
            trailPosArr,
            trailNextArr,
            trailHalfWidthArr,
            trailUVArr,
            trailAlphaArr,
            trailColorArr,
            px,
            py,
            pz
          );
          continue;
        }

        const hx = finalPts[s * 3];
        const hy = finalPts[s * 3 + 1];
        const hz = finalPts[s * 3 + 2];

        // Compute an averaged tangent direction for the shader.
        // At interior points we average the forward and backward segment
        // directions so the billboard plane transitions smoothly through
        // bends instead of snapping per-segment.
        let nx: number, ny: number, nz: number;
        if (s > 0 && s < finalCount - 1) {
          // Interior: average of (prev→current) and (current→next)
          const px2 = finalPts[(s - 1) * 3];
          const py2 = finalPts[(s - 1) * 3 + 1];
          const pz2 = finalPts[(s - 1) * 3 + 2];
          const nx2 = finalPts[(s + 1) * 3];
          const ny2 = finalPts[(s + 1) * 3 + 1];
          const nz2 = finalPts[(s + 1) * 3 + 2];
          // Averaged tangent = (current - prev) + (next - current) = next - prev
          const atx = nx2 - px2;
          const aty = ny2 - py2;
          const atz = nz2 - pz2;
          const atLen = Math.sqrt(atx * atx + aty * aty + atz * atz);
          if (atLen > 0.0001) {
            // trailNext = current + normalized averaged tangent (shader computes tangent as trailNext - position)
            nx = hx + atx / atLen;
            ny = hy + aty / atLen;
            nz = hz + atz / atLen;
          } else {
            nx = finalPts[(s + 1) * 3];
            ny = finalPts[(s + 1) * 3 + 1];
            nz = finalPts[(s + 1) * 3 + 2];
          }
        } else if (s < finalCount - 1) {
          // Head: use forward direction
          nx = finalPts[(s + 1) * 3];
          ny = finalPts[(s + 1) * 3 + 1];
          nz = finalPts[(s + 1) * 3 + 2];
        } else if (finalCount >= 2) {
          // Tail: reuse the direction from the previous segment so the
          // ribbon end keeps the same orientation as the last real segment
          // instead of collapsing when the tangent aligns with the Y axis.
          const prevX = finalPts[(s - 1) * 3];
          const prevY = finalPts[(s - 1) * 3 + 1];
          const prevZ = finalPts[(s - 1) * 3 + 2];
          nx = hx + (hx - prevX);
          ny = hy + (hy - prevY);
          nz = hz + (hz - prevZ);
        } else {
          // Single point: nudge to avoid zero tangent
          nx = hx;
          ny = hy + 0.001;
          nz = hz;
        }

        // Trail percentage (0=head, 1=tail)
        const t = finalCount > 1 ? s / (finalCount - 1) : 0;

        // --- MaxTime: apply additional age-based fade ---
        let timeFade = 1.0;
        if (maxTime > 0 && sampleTimes && effectiveCount > 0) {
          // Map the current smoothed vertex back to the raw sample timeline.
          // When smoothing is active we interpolate between the two bracketing
          // raw samples' timestamps so the fade is smooth instead of stepping.
          const sampleBase = index * trailLength;
          if (useSmoothing && rawCount >= 2) {
            const rawF = (s / Math.max(finalCount - 1, 1)) * (rawCount - 1);
            const rawLo = Math.min(Math.floor(rawF), rawCount - 1);
            const rawHi = Math.min(rawLo + 1, rawCount - 1);
            const frac = rawF - rawLo;
            const slotLo =
              (historyIndex[index] - 1 - rawLo + trailLength * 2) % trailLength;
            const slotHi =
              (historyIndex[index] - 1 - rawHi + trailLength * 2) % trailLength;
            const ageLo = now - sampleTimes[sampleBase + slotLo];
            const ageHi = now - sampleTimes[sampleBase + slotHi];
            const age = ageLo + (ageHi - ageLo) * frac;
            timeFade = 1.0 - Math.min(age / maxTimeMs, 1.0);
          } else {
            const rawS = Math.min(s, rawCount - 1);
            const sampleSlot =
              (historyIndex[index] - 1 - rawS + trailLength * 2) % trailLength;
            const age = now - sampleTimes[sampleBase + sampleSlot];
            timeFade = 1.0 - Math.min(age / maxTimeMs, 1.0);
          }
        }

        const widthScale = trailWidthCurveFn(t);
        const opacityScale = trailOpacityCurveFn(t);
        const halfWidth = ribbonWidth * widthScale * size * 0.5;
        // The particle's own alpha (startOpacity, opacityOverLifetime) goes
        // in the colour; the fragment multiplies the two, so it must not be
        // in here as well or the ribbon fades by its square.
        const alpha = opacityScale * timeFade;

        const fr = trailColorOverTrailFns
          ? cr * trailColorOverTrailFns.r(t)
          : cr;
        const fg = trailColorOverTrailFns
          ? cg * trailColorOverTrailFns.g(t)
          : cg;
        const fb = trailColorOverTrailFns
          ? cb * trailColorOverTrailFns.b(t)
          : cb;

        writeTrailVertex(
          vIdx,
          cIdx,
          aIdx,
          uvIdxBase,
          hx,
          hy,
          hz,
          nx,
          ny,
          nz,
          halfWidth,
          t,
          roll,
          alpha,
          fr,
          fg,
          fb,
          ca,
          trailPosArr,
          trailNextArr,
          trailHalfWidthArr,
          trailUVArr,
          trailAlphaArr,
          trailColorArr
        );
      }

      // --- Twist Prevention ---
      // After building the ribbon, ensure ribbon normals are consistent.
      // We compare the implied normal direction of consecutive segments and
      // flip if the dot product with the previous frame's normal is negative.
      if (useTwistPrevention && prevNormal && finalCount >= 2) {
        const nIdx = index * 3;
        // Compute current head tangent
        const tx = finalPts[3] - finalPts[0];
        const ty = finalPts[4] - finalPts[1];
        const tz = finalPts[5] - finalPts[2];
        const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (tLen > 0.0001) {
          const ntx = tx / tLen;
          const nty = ty / tLen;
          const ntz = tz / tLen;
          // Use a consistent up vector to compute a reference normal
          let upx = 0,
            upy = 1,
            upz = 0;
          const dot = ntx * upx + nty * upy + ntz * upz;
          if (Math.abs(dot) > 0.999) {
            upx = 1;
            upy = 0;
            upz = 0;
          }
          // cross(tangent, up) = normal
          let cnx = nty * upz - ntz * upy;
          let cny = ntz * upx - ntx * upz;
          let cnz = ntx * upy - nty * upx;
          const cnLen = Math.sqrt(cnx * cnx + cny * cny + cnz * cnz);
          if (cnLen > 0.0001) {
            cnx /= cnLen;
            cny /= cnLen;
            cnz /= cnLen;
          }

          // Check dot product with previous normal — if negative, flip
          const prevNx = prevNormal[nIdx];
          const prevNy = prevNormal[nIdx + 1];
          const prevNz = prevNormal[nIdx + 2];
          const hasPrev = prevNx !== 0 || prevNy !== 0 || prevNz !== 0;
          if (hasPrev) {
            const normalDot = cnx * prevNx + cny * prevNy + cnz * prevNz;
            if (normalDot < 0) {
              // Flip all ribbon offsets for this particle by swapping left/right half-widths
              for (let s = 0; s < Math.min(finalCount, slotCount); s++) {
                const aIdx = vertBase + s * 2;
                const hw = trailHalfWidthArr[aIdx];
                trailHalfWidthArr[aIdx] = -hw;
                trailHalfWidthArr[aIdx + 1] = -hw;
              }
              // Also flip the stored normal for next frame
              cnx = -cnx;
              cny = -cny;
              cnz = -cnz;
            }
          }

          // Store current normal for next frame
          prevNormal[nIdx] = cnx;
          prevNormal[nIdx + 1] = cny;
          prevNormal[nIdx + 2] = cnz;
        }
      }
    } else if (
      historyCount[index] > 0 ||
      (prevFilled && prevFilled[index] > 0)
    ) {
      // Particle just became inactive — collapse ribbon and clear history once
      hasUpdates = true;
      highestTouched = index;
      historyCount[index] = 0;
      historyIndex[index] = 0;
      const clearSlots = prevFilled ? prevFilled[index] : slotCount;
      if (prevFilled) prevFilled[index] = 0;
      for (let s = 0; s < clearSlots; s++) {
        const vIdx = (vertBase + s * 2) * 3;
        const cIdx = (vertBase + s * 2) * 4;
        const aIdx = vertBase + s * 2;
        const uvIdxBase = (vertBase + s * 2) * 2;
        clearTrailVertex(
          vIdx,
          cIdx,
          aIdx,
          uvIdxBase,
          trailPosArr,
          trailNextArr,
          trailHalfWidthArr,
          trailUVArr,
          trailAlphaArr,
          trailColorArr,
          0,
          0,
          0
        );
      }
    }
  }

  // --- Connected Ribbons: chain particle positions with Catmull-Rom interpolation ---
  if (useRibbon && _ribbonCount >= 2 && _ribbonIndices) {
    hasUpdates = true;
    const leader = _ribbonIndices[0];
    if (leader > highestTouched) highestTouched = leader;
    const leaderVertBase = leader * verticesPerParticle;

    // The ribbon uses each particle's current position as a control point,
    // then fills `trailLength` vertices by Catmull-Rom interpolation between them.
    // This produces a smooth, continuous ribbon through all particle positions.
    const controlCount = _ribbonCount;
    const filledCount = Math.min(
      slotCount,
      Math.max(controlCount * 4, controlCount)
    );
    const chainSize = filledCount * 3;
    if (!_rawPoints || _rawPointsSize < chainSize) {
      _rawPoints = new Float32Array(chainSize);
      _rawPointsSize = chainSize;
    }

    if (controlCount === 2) {
      // Only 2 particles: linearly interpolate between them
      const p0Idx = _ribbonIndices[0] * 3;
      const p1Idx = _ribbonIndices[1] * 3;
      for (let i = 0; i < filledCount; i++) {
        const t = i / (filledCount - 1);
        _rawPoints[i * 3] =
          positionArr[p0Idx] + t * (positionArr[p1Idx] - positionArr[p0Idx]);
        _rawPoints[i * 3 + 1] =
          positionArr[p0Idx + 1] +
          t * (positionArr[p1Idx + 1] - positionArr[p0Idx + 1]);
        _rawPoints[i * 3 + 2] =
          positionArr[p0Idx + 2] +
          t * (positionArr[p1Idx + 2] - positionArr[p0Idx + 2]);
      }
    } else {
      // 3+ particles: Catmull-Rom interpolation through all control points
      const segments = controlCount - 1;
      const ptsPerSeg = Math.max(1, Math.floor((filledCount - 1) / segments));
      let wi = 0;
      for (let seg = 0; seg < segments && wi < filledCount; seg++) {
        const i0 = Math.max(0, seg - 1);
        const i1 = seg;
        const i2 = Math.min(controlCount - 1, seg + 1);
        const i3 = Math.min(controlCount - 1, seg + 2);
        const p0i = _ribbonIndices[i0] * 3;
        const p1i = _ribbonIndices[i1] * 3;
        const p2i = _ribbonIndices[i2] * 3;
        const p3i = _ribbonIndices[i3] * 3;
        const subCount = seg === segments - 1 ? filledCount - wi : ptsPerSeg;
        for (let sub = 0; sub < subCount && wi < filledCount; sub++) {
          const t = sub / subCount;
          catmullRom(
            _rawPoints,
            wi * 3,
            positionArr[p0i],
            positionArr[p0i + 1],
            positionArr[p0i + 2],
            positionArr[p1i],
            positionArr[p1i + 1],
            positionArr[p1i + 2],
            positionArr[p2i],
            positionArr[p2i + 1],
            positionArr[p2i + 2],
            positionArr[p3i],
            positionArr[p3i + 1],
            positionArr[p3i + 2],
            t
          );
          wi++;
        }
      }
      // Ensure last point is the last particle's position
      if (wi > 0) {
        const lastPIdx = _ribbonIndices[controlCount - 1] * 3;
        _rawPoints[(wi - 1) * 3] = positionArr[lastPIdx];
        _rawPoints[(wi - 1) * 3 + 1] = positionArr[lastPIdx + 1];
        _rawPoints[(wi - 1) * 3 + 2] = positionArr[lastPIdx + 2];
      }
    }

    const leaderBase = leader * SCALAR_STRIDE;
    const leaderCr = trailScalarArr[leaderBase + S_COLOR_R];
    const leaderCg = trailScalarArr[leaderBase + S_COLOR_G];
    const leaderCb = trailScalarArr[leaderBase + S_COLOR_B];
    const leaderCa = trailScalarArr[leaderBase + S_COLOR_A];
    const leaderSize = trailScalarArr[leaderBase + S_SIZE];
    const leaderRoll = trailScalarArr[leaderBase + S_ROTATION];

    const leaderPrevFilled = prevFilled ? prevFilled[leader] : slotCount;
    if (prevFilled) prevFilled[leader] = filledCount;
    for (let s = 0; s < slotCount; s++) {
      const vIdx = (leaderVertBase + s * 2) * 3;
      const cIdx = (leaderVertBase + s * 2) * 4;
      const aIdx = leaderVertBase + s * 2;
      const uvIdxBase = (leaderVertBase + s * 2) * 2;

      if (s >= filledCount) {
        // Slots at or beyond the previous fill count are already cleared.
        if (s >= leaderPrevFilled) break;
        clearTrailVertex(
          vIdx,
          cIdx,
          aIdx,
          uvIdxBase,
          trailPosArr,
          trailNextArr,
          trailHalfWidthArr,
          trailUVArr,
          trailAlphaArr,
          trailColorArr,
          0,
          0,
          0
        );
        continue;
      }

      const ptIdx = s * 3;
      const ptx = _rawPoints[ptIdx];
      const pty = _rawPoints[ptIdx + 1];
      const ptz = _rawPoints[ptIdx + 2];

      // Averaged tangent for interior points
      let nx: number, ny: number, nz: number;
      if (s > 0 && s < filledCount - 1) {
        const px2 = _rawPoints[(s - 1) * 3];
        const py2 = _rawPoints[(s - 1) * 3 + 1];
        const pz2 = _rawPoints[(s - 1) * 3 + 2];
        const nx2 = _rawPoints[(s + 1) * 3];
        const ny2 = _rawPoints[(s + 1) * 3 + 1];
        const nz2 = _rawPoints[(s + 1) * 3 + 2];
        const atx = nx2 - px2;
        const aty = ny2 - py2;
        const atz = nz2 - pz2;
        const atLen = Math.sqrt(atx * atx + aty * aty + atz * atz);
        if (atLen > 0.0001) {
          nx = ptx + atx / atLen;
          ny = pty + aty / atLen;
          nz = ptz + atz / atLen;
        } else {
          nx = _rawPoints[(s + 1) * 3];
          ny = _rawPoints[(s + 1) * 3 + 1];
          nz = _rawPoints[(s + 1) * 3 + 2];
        }
      } else if (s < filledCount - 1) {
        nx = _rawPoints[(s + 1) * 3];
        ny = _rawPoints[(s + 1) * 3 + 1];
        nz = _rawPoints[(s + 1) * 3 + 2];
      } else if (filledCount >= 2) {
        // Tail: reuse previous segment direction
        const prevX = _rawPoints[(s - 1) * 3];
        const prevY = _rawPoints[(s - 1) * 3 + 1];
        const prevZ = _rawPoints[(s - 1) * 3 + 2];
        nx = ptx + (ptx - prevX);
        ny = pty + (pty - prevY);
        nz = ptz + (ptz - prevZ);
      } else {
        nx = ptx;
        ny = pty + 0.001;
        nz = ptz;
      }

      const t = filledCount > 1 ? s / (filledCount - 1) : 0;

      // --- MaxTime: apply age-based fade to connected ribbon ---
      let ribbonTimeFade = 1.0;
      if (maxTime > 0 && controlCount >= 2) {
        // Map the vertex to the nearest control point(s) and use
        // their creation times to compute an interpolated age.
        const ctrlF = t * (controlCount - 1);
        const ctrlLo = Math.min(Math.floor(ctrlF), controlCount - 1);
        const ctrlHi = Math.min(ctrlLo + 1, controlCount - 1);
        const frac = ctrlF - ctrlLo;
        const ageLo = now - generalData.creationTimes[_ribbonIndices[ctrlLo]];
        const ageHi = now - generalData.creationTimes[_ribbonIndices[ctrlHi]];
        const age = ageLo + (ageHi - ageLo) * frac;
        ribbonTimeFade = 1.0 - Math.min(age / maxTimeMs, 1.0);
      }

      const widthScale = trailWidthCurveFn(t);
      const opacityScale = trailOpacityCurveFn(t);
      const halfWidth = trailConfig.width * widthScale * leaderSize * 0.5;
      const alpha = opacityScale * ribbonTimeFade;
      const fr = trailColorOverTrailFns
        ? leaderCr * trailColorOverTrailFns.r(t)
        : leaderCr;
      const fg = trailColorOverTrailFns
        ? leaderCg * trailColorOverTrailFns.g(t)
        : leaderCg;
      const fb = trailColorOverTrailFns
        ? leaderCb * trailColorOverTrailFns.b(t)
        : leaderCb;

      writeTrailVertex(
        vIdx,
        cIdx,
        aIdx,
        uvIdxBase,
        ptx,
        pty,
        ptz,
        nx,
        ny,
        nz,
        halfWidth,
        t,
        leaderRoll,
        alpha,
        fr,
        fg,
        fb,
        leaderCa,
        trailPosArr,
        trailNextArr,
        trailHalfWidthArr,
        trailUVArr,
        trailAlphaArr,
        trailColorArr
      );
    }

    // --- Twist Prevention for connected ribbon (applied to leader) ---
    if (useTwistPrevention && prevNormal && filledCount >= 2) {
      const nIdx = leader * 3;
      const tx = _rawPoints[3] - _rawPoints[0];
      const ty = _rawPoints[4] - _rawPoints[1];
      const tz = _rawPoints[5] - _rawPoints[2];
      const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tLen > 0.0001) {
        const ntx = tx / tLen;
        const nty = ty / tLen;
        const ntz = tz / tLen;
        let upx = 0,
          upy = 1,
          upz = 0;
        const dot = ntx * upx + nty * upy + ntz * upz;
        if (Math.abs(dot) > 0.999) {
          upx = 1;
          upy = 0;
          upz = 0;
        }
        let cnx = nty * upz - ntz * upy;
        let cny = ntz * upx - ntx * upz;
        let cnz = ntx * upy - nty * upx;
        const cnLen = Math.sqrt(cnx * cnx + cny * cny + cnz * cnz);
        if (cnLen > 0.0001) {
          cnx /= cnLen;
          cny /= cnLen;
          cnz /= cnLen;
        }
        const prevNx = prevNormal[nIdx];
        const prevNy = prevNormal[nIdx + 1];
        const prevNz = prevNormal[nIdx + 2];
        const hasPrev = prevNx !== 0 || prevNy !== 0 || prevNz !== 0;
        if (hasPrev) {
          const normalDot = cnx * prevNx + cny * prevNy + cnz * prevNz;
          if (normalDot < 0) {
            for (let s = 0; s < Math.min(filledCount, slotCount); s++) {
              const aIdx = leaderVertBase + s * 2;
              const hw = trailHalfWidthArr[aIdx];
              trailHalfWidthArr[aIdx] = -hw;
              trailHalfWidthArr[aIdx + 1] = -hw;
            }
            cnx = -cnx;
            cny = -cny;
            cnz = -cnz;
          }
        }
        prevNormal[nIdx] = cnx;
        prevNormal[nIdx + 1] = cny;
        prevNormal[nIdx + 2] = cnz;
      }
    }

    // Clear non-leader ribbon particles' trail vertices (only the slots that
    // were actually filled — already-cleared buffers are skipped entirely)
    for (let ri = 1; ri < _ribbonCount; ri++) {
      const pIdx = _ribbonIndices[ri];
      const pVertBase = pIdx * verticesPerParticle;
      const pClearSlots = prevFilled ? prevFilled[pIdx] : slotCount;
      if (prevFilled) prevFilled[pIdx] = 0;
      for (let s = 0; s < pClearSlots; s++) {
        const vIdx = (pVertBase + s * 2) * 3;
        const cIdx = (pVertBase + s * 2) * 4;
        const aIdx = pVertBase + s * 2;
        const uvIdxBase = (pVertBase + s * 2) * 2;
        clearTrailVertex(
          vIdx,
          cIdx,
          aIdx,
          uvIdxBase,
          trailPosArr,
          trailNextArr,
          trailHalfWidthArr,
          trailUVArr,
          trailAlphaArr,
          trailColorArr,
          0,
          0,
          0
        );
      }
    }
  }

  if (hasUpdates) {
    const vertexCount = (highestTouched + 1) * verticesPerParticle;
    const uploadUpTo = (attr: THREE.BufferAttribute) => {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, vertexCount * attr.itemSize);
      attr.needsUpdate = true;
    };
    uploadUpTo(trailPositionAttr);
    uploadUpTo(trailAlphaAttr);
    uploadUpTo(trailColorAttr);
    uploadUpTo(trailNextAttrCached);
    uploadUpTo(trailHalfWidthAttrCached);
    uploadUpTo(trailUVAttrCached);
  }
};

export const updateParticleSystems = (cycleData: CycleData) => {
  createdParticleSystems.forEach((props) =>
    updateParticleSystemInstance(props, cycleData)
  );
};
