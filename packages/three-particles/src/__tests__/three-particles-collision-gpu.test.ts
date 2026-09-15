import { Vector3 } from 'three';
import { CollisionPlaneMode } from '../js/effects/three-particles/three-particles-enums.js';
import { getDefaultParticleSystemConfig } from '../js/effects/three-particles/three-particles.js';
import { encodeCollisionPlanesForGPU } from '../js/effects/three-particles/webgpu/compute-collision-planes.js';
import { createComputePipeline } from '../js/effects/three-particles/webgpu/tsl-materials.js';
import type { NormalizedParticleSystemConfig } from '../js/effects/three-particles/types.js';

/**
 * Collision planes on the GPU: the bounce's recover time travels in the
 * encoded plane and the pipeline exposes the decay uniform. The response
 * itself runs in WGSL and is checked in the browser harness.
 */
describe('collision planes on the GPU', () => {
  it('encodes the recover time in slot 10', () => {
    const data = encodeCollisionPlanesForGPU([
      {
        isActive: true,
        position: new Vector3(1, 2, 3),
        normal: new Vector3(0, 1, 0),
        mode: CollisionPlaneMode.BOUNCE,
        dampen: 0.4,
        lifetimeLoss: 0.1,
        recover: 1.5,
      },
    ]);
    expect(data[1]).toBe(2);
    expect(data[8]).toBeCloseTo(0.4, 6);
    expect(data[9]).toBeCloseTo(0.1, 6);
    expect(data[10]).toBeCloseTo(1.5, 6);
  });

  it('exposes the recover uniform when planes are present', () => {
    const cfg =
      getDefaultParticleSystemConfig() as NormalizedParticleSystemConfig;
    const pipeline = createComputePipeline(50, false, cfg, 1, 0, 2);
    expect(pipeline.collisionPlaneInfo).not.toBeNull();
    expect(pipeline.collisionPlaneInfo!.recoverUniform).toBeDefined();
    const none = createComputePipeline(50, false, cfg, 1, 0, 0);
    expect(none.collisionPlaneInfo).toBeNull();
  });
});
