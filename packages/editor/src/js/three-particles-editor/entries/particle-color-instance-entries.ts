import * as THREE from 'three';

import { getTexture } from '@particle-tools/engine/assets';
import { openTextureSelectorModal } from '@particle-tools/engine/texture-selector/texture-selector';
import {
  hideColorSourceDebug,
  isColorSourceDebugShown,
  showColorSourceDebug,
  syncColorSourceDebug,
  type ColorSourceDebugState,
} from '@particle-tools/engine/color-source-debug';

type ParticleColorInstanceEntriesParams = {
  parentFolder: any;
  particleSystemConfig: any;
  /** The live path: the sampler takes the change, live particles are recoloured. */
  recreateParticleSystem: () => void;
  /** A real rebuild, for the two toggles the kernel bakes in. */
  forceRecreateParticleSystem: () => void;
  scene: THREE.Scene;
  particleSystemContainer: THREE.Object3D;
};

type ParticleColorInstanceEntriesResult = {
  onReset: () => void;
  onAssetUpdate: () => void;
  onUpdate: () => void;
};

/**
 * "Particle Color Instance" — maps an image or a video onto one of the axis
 * planes through the emitter (XZ, XY or YZ) so every particle samples its
 * start color from the pixel under its spawn position; the source can be
 * scaled about its centre, and tiled, mirrored, stretched or cut where it
 * runs out. The source id is persisted in
 * _editorData.colorInstanceTextureId (the THREE.Texture itself is not
 * serializable); a video keeps playing on a loop and the library re-reads it
 * as frames arrive.
 */
export const createParticleColorInstanceEntries = ({
  parentFolder,
  particleSystemConfig,
  recreateParticleSystem,
  forceRecreateParticleSystem,
  scene,
  particleSystemContainer,
}: ParticleColorInstanceEntriesParams): ParticleColorInstanceEntriesResult => {
  const folder = parentFolder.addFolder('Particle Color Instance');
  folder.close();

  if (!particleSystemConfig.particleColorInstance) {
    particleSystemConfig.particleColorInstance = {
      isActive: false,
      area: { x: 0, z: 0 },
      useAlphaForOpacity: false,
    };
  }
  const config = particleSystemConfig.particleColorInstance;
  if (!config.area) config.area = { x: 0, z: 0 };
  if (config.area.y === undefined) config.area.y = 0;
  if (!config.plane) config.plane = 'XZ';
  if (!config.scale) config.scale = { x: 1, y: 1 };
  if (config.scale.x === undefined) config.scale.x = 1;
  if (config.scale.y === undefined) config.scale.y = 1;
  if (!config.wrap) config.wrap = 'ZERO';
  if (config.spawnOnSource === undefined) config.spawnOnSource = true;
  if (!config.offset) config.offset = { x: 0, y: 0, z: 0 };
  (['x', 'y', 'z'] as const).forEach((axis) => {
    if (config.offset[axis] === undefined) config.offset[axis] = 0;
  });
  if (particleSystemConfig._editorData.showColorSourceDebug === undefined) {
    particleSystemConfig._editorData.showColorSourceDebug = false;
  }
  if (config.useLuminanceForNoise === undefined) config.useLuminanceForNoise = false;
  if (config.luminanceNoiseAmount === undefined) config.luminanceNoiseAmount = 0;
  if (config.sampleSize === undefined) config.sampleSize = 0;

  const applyTexture = (textureId: string | undefined): void => {
    const texture = textureId ? getTexture(textureId) : null;
    config.map = texture ? texture.map : undefined;
  };

  const displayConfig = {
    selectedTexture: particleSystemConfig._editorData.colorInstanceTextureId || 'None',
  };

  // Baked into the compute kernel (with luminance → curl noise below): a real rebuild.
  folder.add(config, 'isActive').onChange(forceRecreateParticleSystem).listen();

  folder.add(displayConfig, 'selectedTexture').name('Selected Source').listen().disable();

  folder
    .add(
      {
        selectImage: () => {
          openTextureSelectorModal({
            currentTextureId: particleSystemConfig._editorData.colorInstanceTextureId,
            onSelect: (textureId: string) => {
              particleSystemConfig._editorData.colorInstanceTextureId = textureId;
              displayConfig.selectedTexture = textureId;
              applyTexture(textureId);
              recreateParticleSystem();
            },
          });
        },
      },
      'selectImage'
    )
    .name('Choose Image / Video...');

  // Which two of the spawn position's axes address the source, and which
  // way is up on it. XZ is the top-down piece (−Z up); XY a wall facing +Z;
  // YZ a wall facing +X.
  folder
    .add(config, 'plane', { 'XZ (top-down)': 'XZ', 'XY (facing +Z)': 'XY', 'YZ (facing +X)': 'YZ' })
    .name('plane')
    .onChange(recreateParticleSystem)
    .listen();

  // Only the plane's two axes are read; 0 fits the rectangle shape.
  const areaFolder = folder.addFolder('area (0 = auto from shape)');
  areaFolder.add(config.area, 'x', 0, 100, 0.1).onChange(recreateParticleSystem).listen();
  areaFolder.add(config.area, 'y', 0, 100, 0.1).onChange(recreateParticleSystem).listen();
  areaFolder.add(config.area, 'z', 0, 100, 0.1).onChange(recreateParticleSystem).listen();

  // The source enlarged about its centre: 1 fits the area, 2 shows the
  // middle half, below 1 it stops covering the area and wrap takes over.
  const scaleFolder = folder.addFolder('scale (1 = fit area)');
  scaleFolder
    .add(config.scale, 'x', 0.01, 4, 0.01)
    .name('x (across)')
    .onChange(recreateParticleSystem)
    .listen();
  scaleFolder
    .add(config.scale, 'y', 0.01, 4, 0.01)
    .name('y (down)')
    .onChange(recreateParticleSystem)
    .listen();

  folder
    .add(config, 'wrap', {
      'zero (black)': 'ZERO',
      repeat: 'REPEAT',
      mirror: 'MIRROR',
      'stretch (edge)': 'STRETCH',
    })
    .name('outside the source')
    .onChange(recreateParticleSystem)
    .listen();

  // Births are drawn again until they land on the source (off it under ZERO,
  // or on a texel with no alpha), so the whole budget goes to the picture.
  // Off, such a birth is nothing: black, invisible, free to move.
  folder
    .add(config, 'spawnOnSource')
    .name('spawn only on the source')
    .onChange(recreateParticleSystem)
    .listen();

  // Where the source's centre sits, from the emitter along the world axes.
  // Typed here or dragged in the viewport with the debug plane's handle.
  const offsetFolder = folder.addFolder('offset (source centre from emitter)');
  (['x', 'y', 'z'] as const).forEach((axis) => {
    offsetFolder.add(config.offset, axis, -50, 50, 0.01).onChange(recreateParticleSystem).listen();
  });

  // The mapping made visible (color-source-debug.ts): the source laid on its
  // plane over everything, 20% opaque, in a green frame with a label — and
  // the handle that moves it. The same flag is on the Helper section.
  folder
    .add(particleSystemConfig._editorData, 'showColorSourceDebug')
    .name('show source (debug)')
    .listen();

  // The state the debug plane draws from, resolved the way the library does
  // it: the plane's two axes, the area falling back to the rectangle, the
  // centre at the emitter plus the offset.
  const emitterWorld = new THREE.Vector3();
  const debugState = (): ColorSourceDebugState => {
    const plane = config.plane || 'XZ';
    const rect = particleSystemConfig.shape?.rectangle?.scale;
    const rectW = rect?.x || 1;
    const rectH = rect?.y || 1;
    const area = config.area || {};
    const areaAcross = plane === 'YZ' ? area.z || rectW : area.x || rectW;
    const areaDown = plane === 'XZ' ? area.z || rectH : area.y || rectH;
    particleSystemContainer.getWorldPosition(emitterWorld);
    const center = emitterWorld
      .clone()
      .add(new THREE.Vector3(config.offset.x || 0, config.offset.y || 0, config.offset.z || 0));
    return {
      plane,
      areaAcross,
      areaDown,
      scaleX: config.scale?.x ?? 1,
      scaleY: config.scale?.y ?? 1,
      wrap: config.wrap || 'ZERO',
      center,
      map: config.map,
    };
  };

  // A drag reports the plane's new centre; the offset is what is left after
  // the emitter. Rebuilt at most ten times a second while dragging, the same
  // throttle the collision planes use.
  let recreateTimer: ReturnType<typeof setTimeout> | null = null;
  const onDrag = (worldCenter: THREE.Vector3): void => {
    particleSystemContainer.getWorldPosition(emitterWorld);
    config.offset.x = Math.round((worldCenter.x - emitterWorld.x) * 100) / 100;
    config.offset.y = Math.round((worldCenter.y - emitterWorld.y) * 100) / 100;
    config.offset.z = Math.round((worldCenter.z - emitterWorld.z) * 100) / 100;
    if (!recreateTimer) {
      recreateTimer = setTimeout(() => {
        recreateTimer = null;
        recreateParticleSystem();
      }, 100);
    }
  };

  const onUpdate = (): void => {
    if (particleSystemConfig._editorData.showColorSourceDebug) {
      showColorSourceDebug(scene, onDrag);
      syncColorSourceDebug(debugState());
    } else if (isColorSourceDebugShown()) {
      hideColorSourceDebug();
    }
  };

  folder.add(config, 'useAlphaForOpacity').onChange(recreateParticleSystem).listen();

  // Drives curl-noise strength from the sampled pixel's brightness.
  folder
    .add(config, 'useLuminanceForNoise')
    .name('luminance -> curl noise')
    .onChange(forceRecreateParticleSystem)
    .listen();

  folder
    .add(config, 'luminanceNoiseAmount', -1, 1, 0.01)
    .name('luminance amount')
    .onChange(recreateParticleSystem)
    .listen();

  // Only a video pays per frame, and this is the lever on what it pays: the
  // grid every new frame is read back into. 0 leaves the library's default.
  folder
    .add(config, 'sampleSize', 0, 1024, 64)
    .name('video sample size (0 = 512)')
    .onChange(recreateParticleSystem)
    .listen();

  // Re-inject the non-serializable texture after a config load/reset. The
  // particle system was already (re)created from the raw JSON by then — without
  // the map — so when the section is active, recreate it with the map applied.
  const onReset = (): void => {
    const textureId = particleSystemConfig._editorData.colorInstanceTextureId;
    displayConfig.selectedTexture = textureId || 'None';
    applyTexture(textureId);
    if (config.isActive && config.map) {
      recreateParticleSystem();
    }
  };
  onReset();

  // Sync the display when the texture is changed from outside this panel
  // (e.g. the Texture tab's "Use" button) — the map is already applied there.
  const onAssetUpdate = (): void => {
    displayConfig.selectedTexture =
      particleSystemConfig._editorData.colorInstanceTextureId || 'None';
  };

  return { onReset, onAssetUpdate, onUpdate };
};
