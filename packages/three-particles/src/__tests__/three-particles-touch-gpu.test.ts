import { getDefaultParticleSystemConfig } from '../js/effects/three-particles/three-particles.js';
import { RendererType } from '../js/effects/three-particles/three-particles-enums.js';
import { createComputePipeline } from '../js/effects/three-particles/webgpu/tsl-materials.js';
import type { NormalizedParticleSystemConfig } from '../js/effects/three-particles/types.js';

/**
 * The finger trail on the GPU. A finger's push moves a particle but is not
 * travel: the kernel measures the shove and takes it back out of the heading
 * and speed the mesh reads for its orientation and velocity stretch. That
 * subtraction only exists when both are compiled in, so the graph has to
 * build in every combination; the response itself is checked in the browser
 * harness (stretchReport).
 */
describe('the finger trail on the GPU', () => {
  const meshConfig = (mesh: Record<string, unknown>) => {
    const cfg = getDefaultParticleSystemConfig() as NormalizedParticleSystemConfig;
    cfg.renderer = {
      ...cfg.renderer,
      rendererType: RendererType.MESH,
      mesh: { ...(cfg.renderer.mesh ?? {}), ...mesh },
    } as NormalizedParticleSystemConfig['renderer'];
    return cfg;
  };

  it('builds with the trail alongside heading and stretch tracking', () => {
    const cfg = meshConfig({ alignToVelocity: true, velocityStretch: 0.1 });
    const pipeline = createComputePipeline(50, true, cfg, 1, 0, 0, true);
    expect(pipeline.touchWakeInfo).not.toBeNull();
    expect(pipeline.touchWakeInfo!.strengthUniform).toBeDefined();
  });

  it('builds with the trail and no heading to correct', () => {
    const cfg = meshConfig({ alignToVelocity: false, velocityStretch: 0 });
    const pipeline = createComputePipeline(50, true, cfg, 1, 0, 0, true);
    expect(pipeline.touchWakeInfo).not.toBeNull();
  });

  it('builds with heading and stretch tracking and no trail', () => {
    const cfg = meshConfig({ alignToVelocity: true, velocityStretch: 0.1 });
    const pipeline = createComputePipeline(50, true, cfg, 1, 0, 0, false);
    expect(pipeline.touchWakeInfo).toBeNull();
  });
});
