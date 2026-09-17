import * as THREE from 'three';

import { TextureId } from '@particle-tools/engine/texture-config';
import { setTerrain } from '@particle-tools/engine/world';
import type { ParticleSystem, ParticleSystemConfig } from '@newkrok/three-particles';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { updateShapeHelper } from '@particle-tools/engine/shape-helper';
import { updateForceFieldHelperVisibility } from './force-field-entries';
import { updateCollisionPlaneHelperVisibility } from './collision-plane-entries';
import { markAsEditorOnly } from '@particle-tools/engine/editor-layers';
import {
  MovementSimulations,
  RotationSimulations,
  applySimulation,
  clearMovementTrail,
  resetSimulation,
  seedRandomMovement,
} from '@particle-tools/engine/simulation';
import type { MovementSimulationType } from '@particle-tools/engine/simulation';

const worldAxesHelper = new THREE.AxesHelper(5);
const localAxesHelper = new THREE.AxesHelper(1);

type HelperEntriesParams = {
  parentFolder: GUI;
  particleSystemConfig: ParticleSystemConfig;
  scene: THREE.Scene;
  particleSystemContainer: THREE.Object3D;
  onBigNumbersToggle?: (enabled: boolean) => void;
};

type HelperEntriesResult = {
  onParticleSystemChange: (particleSystem: ParticleSystem) => void;
  onUpdate: (params: { elapsed: number }) => void;
  onReset: () => void;
};

let currentParticleSystem: ParticleSystem | null = null;

export const createHelperEntries = ({
  parentFolder,
  particleSystemConfig,
  scene,
  particleSystemContainer,
  onBigNumbersToggle,
}: HelperEntriesParams): HelperEntriesResult => {
  const folder = parentFolder.addFolder('Helper');
  folder.close();

  const calculateRandomMovement = (): void =>
    seedRandomMovement(
      particleSystemContainer,
      particleSystemConfig._editorData.simulation.movementSpeed
    );
  calculateRandomMovement();
  folder
    .add(particleSystemConfig._editorData.simulation, 'movements', [
      MovementSimulations.DISABLED,
      MovementSimulations.PROJECTILE_STRAIGHT,
      MovementSimulations.PROJECTILE_ARC,
      MovementSimulations.CIRCLE,
      MovementSimulations.CIRCLE_WITH_WAVE,
      MovementSimulations.INFINITE_SYMBOL,
      MovementSimulations.RANDOM_MOVEMENT,
    ])
    .listen()
    .name('Simulate movements')
    .onChange((v: MovementSimulationType) => {
      clearMovementTrail();
      if (v === MovementSimulations.DISABLED) {
        particleSystemContainer.position.x = 0;
        particleSystemContainer.position.y = 0;
        particleSystemContainer.position.z = 0;
      }
      if (v === MovementSimulations.RANDOM_MOVEMENT) {
        particleSystemContainer.position.x = 0;
        particleSystemContainer.position.y = 0;
        particleSystemContainer.position.z = 0;
        calculateRandomMovement();
      }
    });

  folder
    .add(particleSystemConfig._editorData.simulation, 'movementSpeed', 0.1, 10, 0.1)
    .name('Movement speed')
    .listen();

  folder
    .add(particleSystemConfig._editorData.simulation, 'rotation', [
      RotationSimulations.DISABLED,
      RotationSimulations.FOLLOW_THE_MOVEMENT,
      RotationSimulations.X,
      RotationSimulations.Y,
      RotationSimulations.Z,
      RotationSimulations.MIXED,
    ])
    .listen()
    .name('Simulate rotation')
    .onChange(() => {
      particleSystemContainer.rotation.x = 0;
      particleSystemContainer.rotation.y = 0;
      particleSystemContainer.rotation.z = 0;
    });

  folder
    .add(particleSystemConfig._editorData.simulation, 'rotationSpeed', -10, 10, 0.1)
    .name('Rotation speed')
    .listen();

  const updateLocalAxesHelper = (): void => {
    if (particleSystemContainer)
      if (particleSystemConfig._editorData.showLocalAxes) {
        markAsEditorOnly(localAxesHelper);
        particleSystemContainer.add(localAxesHelper);
      } else {
        particleSystemContainer.remove(localAxesHelper);
      }
  };
  folder
    .add(particleSystemConfig._editorData, 'showLocalAxes')
    .name('Show local axes')
    .onChange(updateLocalAxesHelper)
    .listen();

  const updateWorldAxesHelper = (): void => {
    if (particleSystemConfig._editorData.showWorldAxes) {
      markAsEditorOnly(worldAxesHelper);
      scene.add(worldAxesHelper);
    } else {
      scene.remove(worldAxesHelper);
    }
  };
  folder
    .add(particleSystemConfig._editorData, 'showWorldAxes')
    .name('Show world axes')
    .onChange(updateWorldAxesHelper)
    .listen();

  const updateShapeHelperVisibility = (): void => {
    if (currentParticleSystem) {
      updateShapeHelper(
        currentParticleSystem.instance,
        particleSystemConfig.shape,
        particleSystemConfig._editorData.showShape
      );
    }
  };
  folder
    .add(particleSystemConfig._editorData, 'showShape')
    .name('Show shape')
    .onChange(updateShapeHelperVisibility)
    .listen();

  const updateForceFieldHelpers = (): void => {
    updateForceFieldHelperVisibility(scene, particleSystemConfig);
  };
  folder
    .add(particleSystemConfig._editorData, 'showForceFields')
    .name('Show force fields')
    .onChange(updateForceFieldHelpers)
    .listen();

  if (particleSystemConfig._editorData.showCollisionPlanes === undefined) {
    particleSystemConfig._editorData.showCollisionPlanes = false;
  }
  const updateCollisionPlaneHelpers = (): void => {
    updateCollisionPlaneHelperVisibility(scene, particleSystemConfig);
  };
  folder
    .add(particleSystemConfig._editorData, 'showCollisionPlanes')
    .name('Show collision planes')
    .onChange(updateCollisionPlaneHelpers)
    .listen();

  // The colour source laid where it maps, with its handle; the Particle
  // Color Instance section watches this flag every frame and does the work.
  if (particleSystemConfig._editorData.showColorSourceDebug === undefined) {
    particleSystemConfig._editorData.showColorSourceDebug = false;
  }
  folder
    .add(particleSystemConfig._editorData, 'showColorSourceDebug')
    .name('Show colour source (debug)')
    .listen();

  folder
    .add(particleSystemConfig._editorData, 'useIndividualUpdate')
    .name('Individual update method')
    .listen();

  folder.add(particleSystemConfig._editorData, 'useLiveUpdate').name('Live config update').listen();

  folder
    .add(particleSystemConfig._editorData.terrain, 'textureId', [
      TextureId.WIREFRAME,
      TextureId.TERRAIN_CHESS_BOARD,
      TextureId.TERRAIN_CHESS_BOARD_COLORFUL,
      TextureId.TERRAIN_DIRT,
    ])
    .name('Terrain')
    .onChange((v: string) => {
      setTerrain(v);
    })
    .listen();

  if (particleSystemConfig._editorData.enableBigNumbers === undefined) {
    particleSystemConfig._editorData.enableBigNumbers = false;
  }

  folder
    .add(particleSystemConfig._editorData, 'enableBigNumbers')
    .name('Enable big numbers')
    .onChange((v: boolean) => {
      if (onBigNumbersToggle) onBigNumbersToggle(v);
    })
    .listen();

  updateLocalAxesHelper();
  updateWorldAxesHelper();
  // Note: updateShapeHelperVisibility() is called in onParticleSystemChange
  // because it needs the particle system instance to be created first

  return {
    onParticleSystemChange: (particleSystem: ParticleSystem): void => {
      currentParticleSystem = particleSystem;
      updateLocalAxesHelper();
      updateWorldAxesHelper();
      updateShapeHelperVisibility();
    },
    onUpdate: ({ elapsed }: { elapsed: number }): void => {
      applySimulation(
        particleSystemContainer,
        particleSystemConfig._editorData.simulation,
        elapsed
      );
    },
    onReset: (): void => {
      updateWorldAxesHelper();
      updateShapeHelperVisibility();
      resetSimulation(particleSystemContainer);
      if (onBigNumbersToggle) onBigNumbersToggle(particleSystemConfig._editorData.enableBigNumbers);
    },
  };
};
