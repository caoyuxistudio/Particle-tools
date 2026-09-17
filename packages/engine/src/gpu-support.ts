/**
 * Which GPU path the particles get, decided once at start-up.
 *
 * The world always renders through THREE.WebGPURenderer. Where WebGPU is
 * really there (an adapter answers), the library gets its full factory:
 * TSL materials and the compute pipeline, 200k particles simulated on the
 * GPU. Where it is not — three falls back to its WebGL2 backend, which is
 * what the iOS Simulator does, and what an older browser would do — the
 * library used to be left with nothing registered and built a GLSL
 * ShaderMaterial, which that backend refuses ("Material ShaderMaterial is not
 * compatible"): no error on screen, no particles either. Now it gets the TSL
 * materials alone: they compile to GLSL on the WebGL2 backend, and without a
 * compute pipeline the library simulates on the CPU. Slower, but the piece
 * shows.
 */
import { registerTSLMaterialFactory } from '@newkrok/three-particles';
import {
  enableWebGPU,
  createTSLParticleMaterial,
  createTSLTrailMaterial,
} from '@newkrok/three-particles/webgpu';

export type ParticleBackend = 'webgpu' | 'webgl';

let backend: ParticleBackend = 'webgl';

/** Asks for a WebGPU adapter and registers the matching factory. */
export const prepareParticleBackend = async (): Promise<ParticleBackend> => {
  try {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    if (adapter) {
      enableWebGPU();
      backend = 'webgpu';
      return backend;
    }
  } catch {
    // No WebGPU: fall through to the render-only factory.
  }
  // Render-only: TSL materials for the WebGL2 backend, simulation on the CPU.
  // Registered without a renderer so the capability check does not refuse it —
  // there is no compute pipeline in this factory for it to protect against.
  registerTSLMaterialFactory({
    createTSLParticleMaterial: createTSLParticleMaterial as any,
    createTSLTrailMaterial: createTSLTrailMaterial as any,
  });
  backend = 'webgl';
  return backend;
};

export const getParticleBackend = (): ParticleBackend => backend;
