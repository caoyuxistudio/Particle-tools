/**
 * TSL material factory for all particle renderer types.
 *
 * Selects and creates the appropriate TSL NodeMaterial based on the
 * renderer type (POINTS, INSTANCED, MESH, TRAIL).
 *
 * @module
 */
import { RendererType } from '../three-particles-enums.js';
import {
  isLifeTimeCurve,
  travelStretchSeconds,
} from '../three-particles-utils.js';
import { TOUCH_WAKE_DATA_SIZE } from '../touch-wake.js';
import { COLLISION_PLANE_DATA_SIZE } from './compute-collision-planes.js';
import { FORCE_FIELD_DATA_SIZE } from './compute-force-fields.js';
import {
  createModifierStorageBuffers,
  createModifierComputeUpdate,
  type ModifierComputePipeline,
  type ModifierFlags,
  INIT_STRIDE,
} from './compute-modifiers.js';

// Re-export emit queue helpers so callers can register them via the factory.
export {
  writeParticleToModifierBuffers,
  deactivateParticleInModifierBuffers,
  flushEmitQueue,
  registerCurveDataLength,
} from './compute-modifiers.js';
import { bakeParticleSystemCurves } from './curve-bake.js';
import { createInstancedBillboardTSLMaterial } from './tsl-instanced-billboard-material.js';
import { createMeshParticleTSLMaterial } from './tsl-mesh-particle-material.js';
import { createPointSpriteTSLMaterial } from './tsl-point-sprite-material.js';
import {
  createGpuTrailRibbonTSLMaterial,
  type GpuTrailParams,
} from './tsl-trail-ribbon-material.js';
import {
  createTrailRibbonTSLMaterial,
  type TrailUniforms,
} from './tsl-trail-ribbon-material.js';
import type { SharedUniforms } from './tsl-shared.js';
import type { NormalizedParticleSystemConfig } from '../types.js';
import type * as THREE from 'three';

export type { TrailUniforms };

export type RendererConfig = {
  transparent: boolean;
  blending: THREE.Blending;
  depthTest: boolean;
  depthWrite: boolean;
};

/**
 * Creates a TSL NodeMaterial for the main particle system (non-trail).
 *
 * @param rendererType - The particle renderer type.
 * @param sharedUniforms - Shared uniform values managed by the particle system.
 * @param rendererConfig - Material rendering properties (transparency, blending, etc.).
 * @returns A NodeMaterial instance configured for the specified renderer type.
 */
export function createTSLParticleMaterial(
  rendererType: RendererType,
  sharedUniforms: SharedUniforms,
  rendererConfig: RendererConfig,
  gpuCompute = false,
  alignToVelocity = false,
  lit = false,
  emissive = 0,
  roughness?: number,
  metalness?: number,
  velocityStretch = 0,
  meshExtentZ = 1
): THREE.Material {
  switch (rendererType) {
    case RendererType.INSTANCED:
      return createInstancedBillboardTSLMaterial(
        sharedUniforms,
        rendererConfig,
        gpuCompute,
        gpuCompute ? velocityStretch : 0
      );
    case RendererType.MESH:
      return createMeshParticleTSLMaterial(
        sharedUniforms,
        rendererConfig,
        gpuCompute,
        alignToVelocity,
        lit,
        emissive,
        roughness,
        metalness,
        velocityStretch,
        meshExtentZ
      );
    case RendererType.POINTS:
    default:
      return createPointSpriteTSLMaterial(
        sharedUniforms,
        rendererConfig,
        gpuCompute
      );
  }
}

/**
 * Creates a TSL NodeMaterial for the trail ribbon renderer.
 *
 * @param trailUniforms - Trail-specific uniform values.
 * @param rendererConfig - Material rendering properties.
 * @returns A NodeMaterial instance configured for trail ribbon rendering.
 */
export function createTSLTrailMaterial(
  trailUniforms: TrailUniforms,
  rendererConfig: RendererConfig
): THREE.Material {
  return createTrailRibbonTSLMaterial(trailUniforms, rendererConfig);
}

/**
 * Creates the GPU compute pipeline for particle simulation.
 *
 * Bakes all lifetime curves, determines which modifiers are active,
 * creates GPU storage buffers, and returns the complete compute pipeline.
 * All `three/webgpu` imports are contained here — the caller does not
 * need to import any WebGPU-specific modules.
 *
 * @param maxParticles - Maximum particle count.
 * @param instanced - Whether to use InstancedBufferAttribute.
 * @param normalizedConfig - Fully normalized particle system config.
 * @param particleSystemId - Numeric ID for Bezier caching.
 * @param forceFieldCount - Number of active force fields.
 * @returns The complete modifier compute pipeline.
 */
/**
 * The trail ribbon built on the GPU — see `createGpuTrailRibbonTSLMaterial`.
 */
export function createTSLGpuTrailMaterial(
  trailUniforms: TrailUniforms,
  rendererConfig: RendererConfig,
  gpu: GpuTrailParams
): THREE.Material {
  return createGpuTrailRibbonTSLMaterial(trailUniforms, rendererConfig, gpu);
}

/** WebGPU's default maxStorageBufferBindingSize, in floats (128 MiB). */
const STORAGE_BINDING_FLOATS = (128 * 1024 * 1024) / 4;

export function createComputePipeline(
  maxParticles: number,
  instanced: boolean,
  normalizedConfig: NormalizedParticleSystemConfig,
  particleSystemId: number,
  forceFieldCount: number,
  collisionPlaneCount = 0,
  touchWake = false,
  trail?: { length: number; minVertexDistance: number }
): ModifierComputePipeline {
  const bakedCurves = bakeParticleSystemCurves(
    normalizedConfig,
    particleSystemId
  );

  const { velocityOverLifetime } = normalizedConfig;

  const flags: ModifierFlags = {
    sizeOverLifetime: normalizedConfig.sizeOverLifetime.isActive,
    opacityOverLifetime: normalizedConfig.opacityOverLifetime.isActive,
    colorOverLifetime: normalizedConfig.colorOverLifetime.isActive,
    rotationOverLifetime: normalizedConfig.rotationOverLifetime.isActive,
    linearVelocity:
      velocityOverLifetime.isActive &&
      (isLifeTimeCurve(velocityOverLifetime.linear.x ?? 0) ||
        isLifeTimeCurve(velocityOverLifetime.linear.y ?? 0) ||
        isLifeTimeCurve(velocityOverLifetime.linear.z ?? 0) ||
        velocityOverLifetime.linear.x !== 0 ||
        velocityOverLifetime.linear.y !== 0 ||
        velocityOverLifetime.linear.z !== 0),
    orbitalVelocity:
      velocityOverLifetime.isActive &&
      (isLifeTimeCurve(velocityOverLifetime.orbital.x ?? 0) ||
        isLifeTimeCurve(velocityOverLifetime.orbital.y ?? 0) ||
        isLifeTimeCurve(velocityOverLifetime.orbital.z ?? 0) ||
        velocityOverLifetime.orbital.x !== 0 ||
        velocityOverLifetime.orbital.y !== 0 ||
        velocityOverLifetime.orbital.z !== 0),
    noise: normalizedConfig.noise.isActive,
    noiseCurl: normalizedConfig.noise.isActive && !!normalizedConfig.noise.curl,
    noisePerlin: normalizedConfig.noise.type === 'PERLIN',
    noiseLuminance:
      normalizedConfig.noise.isActive &&
      !!normalizedConfig.noise.curl &&
      !!normalizedConfig.particleColorInstance?.isActive &&
      !!normalizedConfig.particleColorInstance?.useLuminanceForNoise,
    trackTravelDirection:
      (normalizedConfig.renderer.rendererType === RendererType.MESH &&
        !!normalizedConfig.renderer.mesh?.alignToVelocity) ||
      travelStretchSeconds(normalizedConfig.renderer) > 0,
    trackTravelSpeed: travelStretchSeconds(normalizedConfig.renderer) > 0,
    forceFields: forceFieldCount > 0,
    collisionPlanes: collisionPlaneCount > 0,
    touchWake,
    trailHistory: !!trail && trail.length >= 2,
  };

  // The history rings live in curveData, one storage binding; keep the whole
  // buffer under the default binding limit by shortening the trail if needed.
  let trailLength = flags.trailHistory ? Math.floor(trail!.length) : 0;
  if (trailLength > 0) {
    const fixed =
      Math.max(bakedCurves.data.length, 1) +
      maxParticles * INIT_STRIDE +
      (flags.forceFields ? FORCE_FIELD_DATA_SIZE : 0) +
      (flags.collisionPlanes ? COLLISION_PLANE_DATA_SIZE : 0) +
      (flags.touchWake ? TOUCH_WAKE_DATA_SIZE : 0);
    const maxLength = Math.floor(
      (STORAGE_BINDING_FLOATS - fixed) / (maxParticles * 4)
    );
    if (trailLength > maxLength) {
      console.warn(
        `[three-particles] trail length ${trailLength} × ${maxParticles} particles exceeds the storage binding limit; clamped to ${maxLength}.`
      );
      trailLength = Math.max(2, maxLength);
    }
  }

  const buffers = createModifierStorageBuffers(
    maxParticles,
    instanced,
    bakedCurves.data,
    flags.forceFields,
    flags.collisionPlanes,
    flags.touchWake,
    trailLength
  );

  const pipeline = createModifierComputeUpdate(
    buffers,
    maxParticles,
    bakedCurves,
    flags,
    forceFieldCount,
    collisionPlaneCount,
    trailLength
  );
  if (pipeline.trailHistoryInfo && trail) {
    (
      pipeline.trailHistoryInfo.minVertexDistanceUniform as unknown as {
        value: number;
      }
    ).value = Math.max(0, trail.minVertexDistance);
  }
  return pipeline;
}
