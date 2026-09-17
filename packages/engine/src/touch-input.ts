/**
 * Fingers on the picture, turned into samples for the particles' touch wake.
 *
 * The library wants each finger in the particles' own space: where it is on
 * the emitter's plane, how big it is there, how fast it is moving. This is
 * the bit that knows about screens: a pointer event is cast from the output
 * camera — the parallax-shifted one, so the finger lands where the eye sees
 * the particles — onto the emitter's plane; the radius, given as a share of
 * the view's width, is scaled to world units at that depth; the speed comes
 * from the previous sample of the same finger, smoothed a little and capped.
 *
 * Pointer events carry an id per finger, so several fingers are several
 * trails. A finger that lands and does not move sends nothing: a still finger
 * is meant to do nothing, and a sample without motion would only cost a loop
 * iteration on the GPU.
 */
import * as THREE from 'three';
import type { ParticleSystem } from '@newkrok/three-particles';
import { applyParallax } from './parallax';

export type TouchInputActions = {
  /** The live particle system, or null between builds. */
  getSystem: () => ParticleSystem | null;
  /** The editor's config: `touch` for the levers, `transform` for the plane. */
  getConfig: () => {
    touch?: {
      isActive?: boolean;
      radius?: number;
      maxSpeed?: number;
    };
    transform?: {
      position?: { x?: number; y?: number; z?: number };
      rotation?: { x?: number; y?: number; z?: number };
    };
  };
  /** Whether fingers should reach the particles right now (presenting, or the player). */
  isEnabled: () => boolean;
  getCamera: () => THREE.PerspectiveCamera | null;
};

export type TouchInput = {
  /** A screen point (-1..1 NDC) on the emitter's plane, in world units, or null when it misses. */
  screenToWorld: (nx: number, ny: number) => THREE.Vector3 | null;
  /** The finger's world radius at a plane point, from the config's share of the view width. */
  radiusAt: (point: THREE.Vector3) => number;
  /** What the harness and the HUD read. */
  state: () => { enabled: boolean; fingers: number; fed: number; lastSpeed: number };
};

/** How much of the new velocity estimate replaces the old, per sample. */
const SPEED_SMOOTHING = 0.5;

type Finger = { point: THREE.Vector3; time: number; velocity: THREE.Vector3 };

export const installTouchInput = (canvas: HTMLElement, actions: TouchInputActions): TouchInput => {
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane();
  const ndc = new THREE.Vector2();
  const fingers = new Map<number, Finger>();
  let fed = 0;
  let lastSpeed = 0;

  /** The emitter's plane: through its position, facing its local +z (the rectangle shape's normal). */
  const emitterPlane = (): THREE.Plane => {
    const transform = actions.getConfig().transform ?? {};
    const p = transform.position ?? {};
    const r = transform.rotation ?? {};
    const normal = new THREE.Vector3(0, 0, 1).applyEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(r.x ?? 0),
        THREE.MathUtils.degToRad(r.y ?? 0),
        THREE.MathUtils.degToRad(r.z ?? 0)
      )
    );
    return plane.setFromNormalAndCoplanarPoint(
      normal,
      new THREE.Vector3(p.x ?? 0, p.y ?? 0, p.z ?? 0)
    );
  };

  const screenToWorld = (nx: number, ny: number): THREE.Vector3 | null => {
    const camera = actions.getCamera();
    if (!camera) return null;
    // Cast from the camera as it renders: the parallax eye, undone right after.
    const restore = applyParallax(camera);
    ndc.set(nx, ny);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.ray.intersectPlane(emitterPlane(), new THREE.Vector3());
    restore();
    return hit;
  };

  const radiusAt = (point: THREE.Vector3): number => {
    const camera = actions.getCamera();
    if (!camera) return 0;
    const share = actions.getConfig().touch?.radius ?? 0.12;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const depth = Math.max(0.01, point.clone().sub(camera.position).dot(forward));
    const viewWidth =
      2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect;
    return share * viewWidth;
  };

  const toNdc = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    ];
  };

  const active = (): boolean =>
    actions.isEnabled() &&
    !!actions.getConfig().touch?.isActive &&
    !!actions.getSystem()?.feedTouch;

  const onDown = (event: PointerEvent): void => {
    if (!active()) return;
    const [nx, ny] = toNdc(event);
    const point = screenToWorld(nx, ny);
    if (!point) return;
    fingers.set(event.pointerId, {
      point,
      time: event.timeStamp,
      velocity: new THREE.Vector3(),
    });
  };

  const onMove = (event: PointerEvent): void => {
    const finger = fingers.get(event.pointerId);
    if (!finger || !active()) return;
    const [nx, ny] = toNdc(event);
    const point = screenToWorld(nx, ny);
    if (!point) return;
    const dt = Math.max(1, event.timeStamp - finger.time) / 1000;
    const estimate = point.clone().sub(finger.point).divideScalar(dt);
    finger.velocity.lerp(estimate, SPEED_SMOOTHING);
    const maxSpeed = actions.getConfig().touch?.maxSpeed ?? 8;
    if (finger.velocity.length() > maxSpeed) finger.velocity.setLength(maxSpeed);
    finger.point = point;
    finger.time = event.timeStamp;
    lastSpeed = finger.velocity.length();
    if (lastSpeed > 0) {
      actions.getSystem()?.feedTouch?.({
        x: point.x,
        y: point.y,
        z: point.z,
        radius: radiusAt(point),
        vx: finger.velocity.x,
        vy: finger.velocity.y,
        vz: finger.velocity.z,
      });
      fed += 1;
    }
  };

  const onUp = (event: PointerEvent): void => {
    fingers.delete(event.pointerId);
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onUp);

  return {
    screenToWorld,
    radiusAt,
    state: () => ({ enabled: active(), fingers: fingers.size, fed, lastSpeed }),
  };
};
