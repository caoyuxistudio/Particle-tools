import { Vector3 } from 'three';
import { CollisionPlaneMode } from '../js/effects/three-particles/three-particles-enums.js';
import { getDefaultParticleSystemConfig } from '../js/effects/three-particles/three-particles.js';
import { encodeCollisionPlanesForGPU } from '../js/effects/three-particles/webgpu/compute-collision-planes.js';
import { createComputePipeline } from '../js/effects/three-particles/webgpu/tsl-materials.js';
import type { NormalizedParticleSystemConfig } from '../js/effects/three-particles/types.js';

/**
 * Collision planes on the GPU: each plane's bounce settings — recover time,
 * the cap on a finger's push, the ceiling on the leaving speed — travel in
 * the encoded plane, and the pipeline builds with them. The response itself
 * runs in WGSL and is checked in the browser harness.
 */
describe('collision planes on the GPU', () => {
  it('encodes the bounce settings in slots 10, 11 and 12', () => {
    const data = encodeCollisionPlanesForGPU([
      {
        isActive: true,
        position: new Vector3(1, 2, 3),
        normal: new Vector3(0, 1, 0),
        mode: CollisionPlaneMode.BOUNCE,
        dampen: 0.4,
        lifetimeLoss: 0.1,
        recover: 1.5,
        touchCap: 2,
        maxSpeed: 3,
      },
    ]);
    expect(data[1]).toBe(2);
    expect(data[8]).toBeCloseTo(0.4, 6);
    expect(data[9]).toBeCloseTo(0.1, 6);
    expect(data[10]).toBeCloseTo(1.5, 6);
    expect(data[11]).toBe(2);
    expect(data[12]).toBe(3);
  });

  it('a plane with no touchCap follows the touch module: −1 in slot 11', () => {
    const data = encodeCollisionPlanesForGPU([
      {
        isActive: true,
        position: new Vector3(),
        normal: new Vector3(0, 1, 0),
        mode: CollisionPlaneMode.BOUNCE,
        dampen: 0.5,
        lifetimeLoss: 0,
        recover: 0,
        touchCap: -1,
        maxSpeed: 0,
      },
    ]);
    expect(data[11]).toBe(-1);
    expect(data[12]).toBe(0);
  });

  it('builds with planes and carries no system-wide recover: each plane fades its own bounces', () => {
    const cfg =
      getDefaultParticleSystemConfig() as NormalizedParticleSystemConfig;
    const pipeline = createComputePipeline(50, false, cfg, 1, 0, 2);
    expect(pipeline.collisionPlaneInfo).not.toBeNull();
    expect(pipeline.collisionPlaneInfo!.countUniform).toBeDefined();
    expect(
      (pipeline.collisionPlaneInfo as unknown as Record<string, unknown>)
        .recoverUniform
    ).toBeUndefined();
    const none = createComputePipeline(50, false, cfg, 1, 0, 0);
    expect(none.collisionPlaneInfo).toBeNull();
  });
});
