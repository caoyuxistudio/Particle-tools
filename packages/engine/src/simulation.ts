/**
 * The emitter's canned motion — the Helper panel's "simulation" settings.
 *
 * It lived inside the Helper entries, wired straight into the lil-gui folder
 * that exposes it. The display window needs the same motion and must not pull
 * a GUI in behind it, so the movement itself moved out here and the panel keeps
 * only the controls.
 *
 * This is emitter motion, not scene motion: it moves the particle system's own
 * container, which is why it belongs to the config rather than to the scene
 * objects, and why it travels to the display inside `_editorData`.
 */
import * as THREE from 'three';

export const MovementSimulations = {
  DISABLED: 'DISABLED',
  PROJECTILE_STRAIGHT: 'PROJECTILE_STRAIGHT',
  PROJECTILE_ARC: 'PROJECTILE_ARC',
  CIRCLE: 'CIRCLE',
  CIRCLE_WITH_WAVE: 'CIRCLE_WITH_WAVE',
  INFINITE_SYMBOL: 'INFINITE_SYMBOL',
  RANDOM_MOVEMENT: 'RANDOM_MOVEMENT',
} as const;

export type MovementSimulationType = (typeof MovementSimulations)[keyof typeof MovementSimulations];

export const RotationSimulations = {
  DISABLED: 'DISABLED',
  FOLLOW_THE_MOVEMENT: 'FOLLOW_THE_MOVEMENT',
  X: 'X',
  Y: 'Y',
  Z: 'Z',
  MIXED: 'MIXED',
} as const;

export type RotationSimulationType = (typeof RotationSimulations)[keyof typeof RotationSimulations];

export type SimulationSettings = {
  movements: MovementSimulationType;
  movementSpeed: number;
  rotation: RotationSimulationType;
  rotationSpeed: number;
};

/**
 * The random walk's current leg. Module state, like the rest of the world here:
 * the editor and the display are separate pages, so each gets its own.
 */
let randomMovement: { delay?: number; speedX: number; speedZ: number; time?: number } = {
  delay: 0,
  speedX: 0,
  speedZ: 0,
  time: 0,
};

const currentPosition = new THREE.Vector3();
const movementVector = new THREE.Vector3();

/** Picks a fresh leg for the random walk, starting from where the emitter is. */
export const seedRandomMovement = (container: THREE.Object3D, movementSpeed: number): void => {
  const endPoint = { x: Math.random() * 2 - 1, z: Math.random() * 2 - 1 };
  randomMovement = {
    speedX: (endPoint.x - container.position.x) / 200,
    speedZ: (endPoint.z - container.position.z) / 200,
    time: 100 * (1 / movementSpeed),
  };
};

/**
 * Forgets which way the emitter was last heading.
 *
 * FOLLOW_THE_MOVEMENT aims the emitter along that heading, so switching modes
 * without clearing it would snap the emitter to a direction it is no longer
 * travelling in.
 */
export const clearMovementTrail = (): void => {
  movementVector.set(0, 0, 0);
};

/** Puts the emitter back at the origin, unrotated. */
export const resetSimulation = (container: THREE.Object3D): void => {
  container.position.set(0, 0, 0);
  container.rotation.set(0, 0, 0);
};

/** One frame of it. `elapsed` is the clock, in seconds. */
export const applySimulation = (
  container: THREE.Object3D,
  simulation: SimulationSettings,
  elapsed: number
): void => {
  const speed = 2;
  const percentage = (elapsed - Math.floor(elapsed / speed) * speed) / speed;
  currentPosition.copy(container.position);
  const movementMultiplier = simulation.movementSpeed;
  switch (simulation.movements) {
    case MovementSimulations.PROJECTILE_STRAIGHT:
      container.position.x = percentage * 5 * movementMultiplier;
      container.position.y = 1;
      container.position.z = 0;
      break;

    case MovementSimulations.PROJECTILE_ARC:
      container.position.x = percentage * 5 * movementMultiplier;
      container.position.y = 1 + Math.sin(percentage * Math.PI);
      container.position.z = 0;
      break;

    case MovementSimulations.CIRCLE:
      container.position.x = Math.cos(elapsed * 0.5 * movementMultiplier) * 2;
      container.position.y = 0;
      container.position.z = Math.sin(elapsed * 0.5 * movementMultiplier) * 2;
      break;

    case MovementSimulations.CIRCLE_WITH_WAVE:
      container.position.x = Math.cos(elapsed * 0.5 * movementMultiplier) * 2;
      container.position.y =
        Math.cos(elapsed * movementMultiplier) * Math.sin(elapsed * movementMultiplier) * 0.5;
      container.position.z = Math.sin(elapsed * 0.5 * movementMultiplier) * 2;
      break;

    case MovementSimulations.INFINITE_SYMBOL:
      container.position.x = Math.cos(elapsed * 0.5 * movementMultiplier) * 4;
      container.position.y = 0;
      container.position.z = Math.sin(elapsed * 1 * movementMultiplier) * 2;
      break;

    case MovementSimulations.RANDOM_MOVEMENT:
      if (randomMovement.time && randomMovement.time-- <= 0) {
        const endPoint = {
          x: container.position.x + Math.random() * 2 - 1,
          z: container.position.z + Math.random() * 2 - 1,
        };
        randomMovement = {
          speedX: (endPoint.x - container.position.x) / 200,
          speedZ: (endPoint.z - container.position.z) / 200,
          time: 300 + Math.random() * 200 * (1 / simulation.movementSpeed),
        };
      }

      container.position.x += randomMovement.speedX * movementMultiplier;
      container.position.y = 0;
      container.position.z += randomMovement.speedZ * movementMultiplier;
      break;

    default:
      break;
  }
  movementVector.copy(currentPosition).sub(container.position);
  const rotationMultiplier = simulation.rotationSpeed;
  switch (simulation.rotation) {
    case RotationSimulations.FOLLOW_THE_MOVEMENT:
      container.rotation.y = Math.PI * 2 - Math.atan2(movementVector.z, movementVector.x);
      break;
    case RotationSimulations.X:
      container.rotation.x = rotationMultiplier * elapsed;
      break;
    case RotationSimulations.Y:
      container.rotation.y = rotationMultiplier * elapsed;
      break;
    case RotationSimulations.Z:
      container.rotation.z = rotationMultiplier * elapsed;
      break;
    case RotationSimulations.MIXED:
      container.rotation.x = rotationMultiplier * Math.cos(elapsed);
      container.rotation.y = rotationMultiplier * Math.sin(elapsed);
      container.rotation.z = rotationMultiplier * Math.sin(elapsed) * Math.sin(elapsed);
      break;
  }
};
