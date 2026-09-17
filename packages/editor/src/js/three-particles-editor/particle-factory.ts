/**
 * Turns a config into a live particle system.
 *
 * This used to live inside the editor's recreate path. It moved out when the
 * player window arrived: the player has to interpret a config *exactly* the way
 * the editor does — the same texture and geometry restoration, the same legacy
 * conversion, the same WebGPU renderer-type substitution — or the two windows
 * drift apart and the display shows something the editor never previewed.
 *
 * The editor keeps its own bookkeeping around this (dirty flags, live-update
 * throttling, the structural snapshot that decides when a hot update is safe).
 * Only the part that both front ends must agree on lives here.
 */
import { createParticleSystem } from '@newkrok/three-particles';

import { convertToNewFormat } from './config-converter';
import { getTexture } from './assets';
import { createGeometry } from './mesh-geometry';

/**
 * Sub-emitter configs store a texture *name*; the THREE.Texture itself is not
 * serialisable, so it is looked up again on every build.
 */
export const resolveSubEmitterTextures = (config: any): void => {
  if (!config.subEmitters) return;
  config.subEmitters.forEach((subEmitter: any) => {
    const subConfig = subEmitter.config;
    if (subConfig?._editorData?.textureId) {
      const texture = getTexture(subConfig._editorData.textureId);
      if (texture) {
        subConfig.map = texture.map;
      }
    }
    // Recursively resolve nested sub-emitters
    if (subConfig) resolveSubEmitterTextures(subConfig);
  });
};

/** Same story as the textures: only the geometry *type* survives a save. */
export const resolveMeshGeometry = (config: any): void => {
  if (config.renderer?.rendererType === 'MESH') {
    if (!config.renderer.mesh) config.renderer.mesh = {};
    if (!config.renderer.mesh.geometryType) config.renderer.mesh.geometryType = 'BOX';
    config.renderer.mesh.geometry = createGeometry(config.renderer.mesh.geometryType);
  }
  // Recursively resolve for sub-emitters
  if (config.subEmitters) {
    config.subEmitters.forEach((subEmitter: any) => {
      if (subEmitter.config) resolveMeshGeometry(subEmitter.config);
    });
  }
};

export type BuildOptions = {
  /** WebGPU changes which renderer types are available; see below. */
  webGPUAvailable: boolean;
  /** The scene depth buffer soft particles read, when the config asks for them. */
  depthTexture?: unknown | null;
};

/**
 * Builds the system. `activeConfig` is read and lightly annotated (resolved
 * textures and geometries are written back onto it, as the editor's panel binds
 * to those references) but its shape is never changed.
 */
export const buildParticleSystem = (activeConfig: any, options: BuildOptions): any => {
  const { webGPUAvailable, depthTexture = null } = options;

  // Resolve textures for sub-emitters (map is not serialized, only textureId is)
  resolveSubEmitterTextures(activeConfig);

  // Resolve mesh geometries (geometry is not serialized, only geometryType is)
  resolveMeshGeometry(activeConfig);

  // Mesh particles use the engine's built-in default texture, not sprite textures
  if (activeConfig.renderer?.rendererType === 'MESH') {
    delete activeConfig.map;
  }

  // Inject depth texture for soft particles
  if (activeConfig.renderer?.softParticles?.enabled && depthTexture) {
    activeConfig.renderer.softParticles.depthTexture = depthTexture;
  }

  // Convert old configuration format to new format before creating particle system
  // convertToNewFormat deep-clones so it won't mutate activeConfig (preserves lil-gui refs)
  const convertedConfig = convertToNewFormat(activeConfig);

  // Restore non-serializable THREE.js objects lost during deep clone
  if (activeConfig.map) convertedConfig.map = activeConfig.map;
  if (activeConfig.particleColorInstance?.map && convertedConfig.particleColorInstance)
    convertedConfig.particleColorInstance.map = activeConfig.particleColorInstance.map;
  if (activeConfig.renderer?.softParticles?.depthTexture)
    convertedConfig.renderer.softParticles.depthTexture =
      activeConfig.renderer.softParticles.depthTexture;
  if (activeConfig.renderer?.mesh?.geometry)
    convertedConfig.renderer.mesh.geometry = activeConfig.renderer.mesh.geometry;
  // Restore sub-emitter maps and geometries
  if (activeConfig.subEmitters) {
    const restoreSubEmitterRefs = (source: any[], target: any[]) => {
      source.forEach((sub: any, i: number) => {
        if (target[i]?.config && sub.config) {
          if (sub.config.map) target[i].config.map = sub.config.map;
          if (sub.config.renderer?.mesh?.geometry)
            target[i].config.renderer.mesh.geometry = sub.config.renderer.mesh.geometry;
          if (sub.config.subEmitters && target[i].config.subEmitters)
            restoreSubEmitterRefs(sub.config.subEmitters, target[i].config.subEmitters);
        }
      });
    };
    if (convertedConfig.subEmitters)
      restoreSubEmitterRefs(activeConfig.subEmitters, convertedConfig.subEmitters);
  }

  // WebGPU: POINTS rendererType uses gl_PointCoord which is not available in WGSL.
  // Force INSTANCED when WebGPU is active (same approach as the three-particles demos).
  // Applied to the converted copy so the editor config stays unchanged for serialization.
  if (webGPUAvailable) {
    const rt = convertedConfig.renderer?.rendererType;
    if (!rt || rt === 'POINTS') {
      if (!convertedConfig.renderer) convertedConfig.renderer = {};
      convertedConfig.renderer.rendererType = 'INSTANCED';
    }
  }

  const particleSystem = createParticleSystem(convertedConfig);

  // Only the MESH material is wired into the shadow pass (castShadowPositionNode
  // and receivedShadowPositionNode in the library). The other materials drive
  // the vertex stage through vertexNode, which the depth pass cannot run, and
  // letting them in would draw every instance at the origin of each shadow
  // map. Lighting applies to all of them; only shadows are gated.
  const shadows = convertedConfig.renderer?.rendererType === 'MESH';
  particleSystem.instance.castShadow = shadows;
  particleSystem.instance.receiveShadow = shadows;

  return particleSystem;
};
