import { AdditiveBlending, Vector2 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { RendererType } from '../js/effects/three-particles/three-particles-enums.js';
import { getDefaultParticleSystemConfig } from '../js/effects/three-particles/three-particles.js';
import { INIT_STRIDE } from '../js/effects/three-particles/webgpu/compute-modifiers.js';
import { bakeParticleSystemCurves } from '../js/effects/three-particles/webgpu/curve-bake.js';
import {
  createComputePipeline,
  createTSLGpuTrailMaterial,
  type RendererConfig,
} from '../js/effects/three-particles/webgpu/tsl-materials.js';
import type { NormalizedParticleSystemConfig } from '../js/effects/three-particles/types.js';
import type { TrailUniforms } from '../js/effects/three-particles/webgpu/tsl-trail-ribbon-material.js';

/**
 * The trail on the GPU: the kernel records a history ring at the tail of
 * curveData and the ribbon material reads it back in its vertex stage. What
 * a node test can check is the plumbing — the ring's place and size, the
 * baked along-ribbon curves, and that the material builds.
 */
const trailConfig = (length: number): NormalizedParticleSystemConfig => {
  const cfg =
    getDefaultParticleSystemConfig() as NormalizedParticleSystemConfig;
  cfg.renderer.rendererType = RendererType.TRAIL;
  cfg.renderer.trail = {
    length,
    width: 0.1,
    colorOverTrail: {
      isActive: true,
      r: {
        type: 'BEZIER',
        scale: 1,
        bezierPoints: [
          { x: 0, y: 1, percentage: 0 },
          { x: 1, y: 0.5, percentage: 1 },
        ],
      },
      g: {
        type: 'BEZIER',
        scale: 1,
        bezierPoints: [
          { x: 0, y: 1, percentage: 0 },
          { x: 1, y: 1, percentage: 1 },
        ],
      },
      b: {
        type: 'BEZIER',
        scale: 1,
        bezierPoints: [
          { x: 0, y: 1, percentage: 0 },
          { x: 1, y: 1, percentage: 1 },
        ],
      },
    },
  } as any;
  return cfg;
};

const rendererConfig: RendererConfig = {
  transparent: true,
  blending: AdditiveBlending,
  depthTest: true,
  depthWrite: false,
};

const trailUniforms = (): TrailUniforms => ({
  map: { value: null },
  useMap: { value: false },
  discardBackgroundColor: { value: false },
  backgroundColor: { value: { r: 0, g: 0, b: 0 } },
  backgroundColorTolerance: { value: 0.01 },
  softParticlesEnabled: { value: false },
  softParticlesIntensity: { value: 1 },
  sceneDepthTexture: { value: null },
  cameraNearFar: { value: new Vector2(0.1, 1000) },
});

describe('the trail on the GPU', () => {
  it('bakes the along-ribbon curves next to the lifetime curves', () => {
    const map = bakeParticleSystemCurves(trailConfig(8), 1);
    expect(map.trailWidth).toBeGreaterThanOrEqual(0);
    expect(map.trailOpacity).toBeGreaterThanOrEqual(0);
    expect(map.trailColorR).toBeGreaterThanOrEqual(0);
    expect(map.trailColorB).toBeGreaterThanOrEqual(0);
    // The default width curve: full at the head, nothing at the tail.
    const w = map.trailWidth * 256;
    expect(map.data[w]).toBeCloseTo(1, 5);
    expect(map.data[w + 255]).toBeCloseTo(0, 5);
    const noTrail = bakeParticleSystemCurves(
      getDefaultParticleSystemConfig() as NormalizedParticleSystemConfig,
      1
    );
    expect(noTrail.trailWidth).toBe(-1);
  });

  it('gives each particle a ring of length × 4 floats at the tail of curveData', () => {
    const cfg = trailConfig(8);
    const pipeline = createComputePipeline(100, true, cfg, 1, 0, 0, false, {
      length: 8,
      minVertexDistance: 0.05,
    });
    const info = pipeline.trailHistoryInfo!;
    expect(info).not.toBeNull();
    expect(info.length).toBe(8);
    const curveLen = Math.max(pipeline.curveDataLength, 1);
    expect(info.offset).toBe(curveLen + 100 * INIT_STRIDE);
    expect(pipeline.buffers.curveData.array.length).toBe(
      info.offset + 100 * 8 * 4
    );
    expect(
      (info.minVertexDistanceUniform as unknown as { value: number }).value
    ).toBeCloseTo(0.05, 6);
    expect(pipeline.curveMap.trailWidth).toBeGreaterThanOrEqual(0);
  });

  it('has no ring without a trail', () => {
    const pipeline = createComputePipeline(
      50,
      true,
      getDefaultParticleSystemConfig() as NormalizedParticleSystemConfig,
      1,
      0,
      0,
      false
    );
    expect(pipeline.trailHistoryInfo).toBeNull();
  });

  it('shortens a ring that would not fit the storage binding', () => {
    const cfg = trailConfig(4000);
    const pipeline = createComputePipeline(200000, true, cfg, 1, 0, 0, false, {
      length: 4000,
      minVertexDistance: 0,
    });
    expect(pipeline.trailHistoryInfo!.length).toBeLessThan(4000);
    expect(pipeline.buffers.curveData.array.length * 4).toBeLessThanOrEqual(
      128 * 1024 * 1024
    );
  });

  it('builds the ribbon material from the pipeline', () => {
    const cfg = trailConfig(8);
    const pipeline = createComputePipeline(20, true, cfg, 1, 0, 0, false, {
      length: 8,
      minVertexDistance: 0,
    });
    const material = createTSLGpuTrailMaterial(
      trailUniforms(),
      rendererConfig,
      {
        curveData: pipeline.buffers.curveData,
        historyOffset: pipeline.trailHistoryInfo!.offset,
        length: 8,
        curveMap: pipeline.curveMap,
        width: 0.1,
        maxTime: 1,
        smoothing: true,
        smoothingSubdivisions: 3,
      }
    );
    expect(material).toBeInstanceOf(MeshBasicNodeMaterial);
    expect(material.userData.gpuTrail).toBe(true);
    expect(material.userData.trailNow).toBeDefined();
  });
});
