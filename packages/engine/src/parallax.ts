import * as THREE from 'three';

/**
 * Parallax: the screen as a window.
 *
 * TheParallaxView (algomystic, 2018) tracks the viewer's eye with the iPhone's
 * TrueDepth camera and renders with an off-axis projection, so the screen
 * behaves like a pane of glass: the plane of the screen stays put and what
 * lies behind it shifts with the eye. There is no eye to track here. The
 * phone's own tilt stands in for it: tilting moves a virtual eye across the
 * camera's plane, the output camera moves with it, and its frustum is shifted
 * back so the frame's plane keeps its place in the picture. Only what is
 * deeper or shallower than that plane moves, which is the depth cue.
 *
 * Sources, in order: the gyroscope (deviceorientation; iOS opens it behind a
 * tap-gated prompt) while it is delivering, else the mouse over the window —
 * the desktop stand-in, and what the harness drives.
 */
export type ParallaxSettings = {
  enabled: boolean;
  /** Eye travel in world units per degree of tilt. */
  amount: number;
  /** Cap on the eye's travel from centre, world units. */
  maxOffset: number;
  /** 0..1: the share of the remaining distance the eye covers per 60 Hz frame. */
  smoothing: number;
  /**
   * Seconds over which the resting tilt is re-learnt, so a new holding angle
   * becomes the centre and the piece never sits pushed to one side; 0 keeps
   * the pose from the moment the effect was switched on.
   */
  recenter: number;
  /** Distance from the camera to the plane held still; 0 = the first visible frame's plane. */
  planeDistance: number;
  invertX: boolean;
  invertY: boolean;
};

export const defaultParallaxSettings = (): ParallaxSettings => ({
  enabled: false,
  amount: 0.25,
  maxOffset: 4,
  smoothing: 0.12,
  recenter: 8,
  planeDistance: 0,
  invertX: false,
  invertY: false,
});

type Vec2 = { x: number; y: number };

export type ParallaxSource = 'gyro' | 'mouse' | 'none';
export type ParallaxPermission = 'not-needed' | 'unknown' | 'granted' | 'denied';

let settings: ParallaxSettings = defaultParallaxSettings();
/** The frame's plane, as scene-objects last measured it along the camera's view (0 = none). */
let autoPlane = 0;

// Gyroscope: tilt in degrees on screen axes, and the resting tilt it is measured from.
let tilt: Vec2 | null = null;
let rest: Vec2 | null = null;
let gyroAt = -Infinity;
// Mouse: -1..1 across the window.
let pointer: Vec2 = { x: 0, y: 0 };
let pointerAt = -Infinity;

let offset: Vec2 = { x: 0, y: 0 };
let lastUpdate = -Infinity;
let permission: ParallaxPermission = 'unknown';

/** A gyroscope that has said nothing for this long has stopped, and the mouse takes over. */
const GYRO_FRESH_MS = 1500;
/** The full height handed to setViewOffset; only ratios of it matter. */
const VIEW_FULL = 1000;

/** iOS 13+ gates orientation events behind a prompt that only a tap may open. */
const permissionGate = (): (() => Promise<string>) | null => {
  const ctor = (window as any).DeviceOrientationEvent;
  return ctor && typeof ctor.requestPermission === 'function'
    ? ctor.requestPermission.bind(ctor)
    : null;
};

/** Call from a user gesture: entering presentation, a tap on the player. */
export const requestParallaxPermission = async (): Promise<ParallaxPermission> => {
  const gate = permissionGate();
  if (!gate) {
    permission = 'not-needed';
    return permission;
  }
  if (permission === 'granted') return permission;
  try {
    permission = (await gate()) === 'granted' ? 'granted' : 'denied';
  } catch {
    permission = 'denied';
  }
  return permission;
};

/**
 * Orientation on screen axes, degrees: x is the left/right tilt, y the
 * forward/back one, whichever way the screen is turned. The device frame has
 * gamma about the long axis and beta about the short one, so a rotated screen
 * swaps them.
 */
export const feedOrientation = (beta: number | null, gamma: number | null): void => {
  if (beta === null || gamma === null) return;
  const angle = Number(screen.orientation?.angle ?? (window as any).orientation ?? 0);
  let x = gamma;
  let y = beta;
  if (angle === 90) {
    x = beta;
    y = -gamma;
  } else if (angle === -90 || angle === 270) {
    x = -beta;
    y = gamma;
  } else if (angle === 180) {
    x = -gamma;
    y = -beta;
  }
  tilt = { x, y };
  if (!rest) rest = { x, y };
  gyroAt = performance.now();
};

/** The mouse, as -1..1 across the window; a still mouse keeps its view. */
export const feedPointer = (nx: number, ny: number): void => {
  pointer = { x: nx, y: ny };
  pointerAt = performance.now();
};

/** Makes the current tilt the centre. Entering presentation does this. */
export const recenterParallax = (): void => {
  rest = tilt ? { ...tilt } : null;
};

/**
 * Forgets every sample and asks the sensor again — for a gyroscope that went
 * quiet, or a prompt that was refused. The next sample becomes the centre.
 */
export const resetGyroscope = (): void => {
  tilt = null;
  rest = null;
  gyroAt = -Infinity;
  if (permission !== 'granted') permission = 'unknown';
  void requestParallaxPermission();
};

export const setParallaxSettings = (next: ParallaxSettings): void => {
  const wasEnabled = settings.enabled;
  settings = next;
  if (settings.enabled && !wasEnabled) recenterParallax();
  if (!settings.enabled) offset = { x: 0, y: 0 };
};

export const getParallaxSettings = (): ParallaxSettings => settings;

export const setParallaxPlane = (distance: number): void => {
  autoPlane = distance;
};

/** Forgets every sample and the eye's position. For the harness. */
export const resetParallaxState = (): void => {
  tilt = null;
  rest = null;
  gyroAt = -Infinity;
  pointer = { x: 0, y: 0 };
  pointerAt = -Infinity;
  offset = { x: 0, y: 0 };
  lastUpdate = -Infinity;
};

const planeDistance = (): number =>
  settings.planeDistance > 0 ? settings.planeDistance : autoPlane > 0 ? autoPlane : 10;

const currentSource = (now: number): ParallaxSource => {
  if (tilt && now - gyroAt < GYRO_FRESH_MS) return 'gyro';
  if (pointerAt > -Infinity) return 'mouse';
  return 'none';
};

const clampLength = (v: Vec2, max: number): Vec2 => {
  const len = Math.hypot(v.x, v.y);
  return len > max && len > 0 ? { x: (v.x / len) * max, y: (v.y / len) * max } : v;
};

/**
 * Advances the eye toward where the current source puts it. `dt` in seconds;
 * left out, it is measured from the previous call, and calls under a
 * millisecond apart count as the same frame (the preview and a display can
 * both render in one).
 *
 * Signs, for the gyroscope: gamma grows as the phone's right edge turns away
 * from the viewer, which leaves the viewer's eye on the left of the screen's
 * normal — eye -x. Beta grows as the top edge comes toward the viewer, which
 * puts the eye above the normal — eye +y.
 */
export const updateParallax = (dt?: number): void => {
  const now = performance.now();
  let step = dt;
  if (step === undefined) {
    if (now - lastUpdate < 1) return;
    step = lastUpdate === -Infinity ? 1 / 60 : Math.min(0.1, (now - lastUpdate) / 1000);
  }
  lastUpdate = now;
  if (!settings.enabled) return;

  const sx = settings.invertX ? -1 : 1;
  const sy = settings.invertY ? -1 : 1;
  let target: Vec2 = { x: 0, y: 0 };
  const source = currentSource(now);
  if (source === 'gyro' && tilt) {
    if (!rest) rest = { ...tilt };
    else if (settings.recenter > 0) {
      const k = 1 - Math.exp(-step / settings.recenter);
      rest = { x: rest.x + (tilt.x - rest.x) * k, y: rest.y + (tilt.y - rest.y) * k };
    }
    target = clampLength(
      {
        x: -(tilt.x - rest.x) * settings.amount * sx,
        y: (tilt.y - rest.y) * settings.amount * sy,
      },
      settings.maxOffset
    );
  } else if (source === 'mouse') {
    target = clampLength(
      { x: pointer.x * settings.maxOffset * sx, y: pointer.y * settings.maxOffset * sy },
      settings.maxOffset
    );
  }
  const share = Math.min(1, Math.max(0.001, settings.smoothing));
  const k = 1 - Math.pow(1 - share, step * 60);
  offset = { x: offset.x + (target.x - offset.x) * k, y: offset.y + (target.y - offset.y) * k };
};

/**
 * Moves the camera to the eye and shifts its frustum back so the plane at
 * `planeDistance` keeps its place in the picture. Returns the undo, to run as
 * soon as the frame is rendered: nothing else sees the camera moved — not the
 * editor's viewport, not the frustum helper, not the config.
 *
 * The frustum shift is the off-axis projection: with the eye moved by e in
 * the camera's plane, a point on the held plane sits at -e in the new camera
 * frame, and it projects where it did if the near window's centre moves to
 * -e * near / distance. setViewOffset is three's own way to move that window.
 */
export const applyParallax = (camera: THREE.PerspectiveCamera): (() => void) => {
  if (!settings.enabled || (offset.x === 0 && offset.y === 0)) return () => undefined;
  const distance = planeDistance();
  const position = camera.position.clone();
  const eye = new THREE.Vector3(offset.x, offset.y, 0).applyQuaternion(camera.quaternion);
  camera.position.add(eye);
  camera.updateMatrixWorld(true);
  // The near window's extent, the units setViewOffset shifts in; offsetY runs down.
  const aspect = camera.aspect;
  const nearHeight = 2 * camera.near * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const nearWidth = nearHeight * aspect;
  // setViewOffset takes the aspect from the full size it is given, so the full
  // size has to carry the camera's own — and the undo puts it back exactly.
  const fullWidth = VIEW_FULL * aspect;
  const fullHeight = VIEW_FULL;
  camera.setViewOffset(
    fullWidth,
    fullHeight,
    ((-offset.x * camera.near) / distance / nearWidth) * fullWidth,
    ((offset.y * camera.near) / distance / nearHeight) * fullHeight,
    fullWidth,
    fullHeight
  );
  return () => {
    camera.aspect = aspect;
    camera.clearViewOffset();
    camera.position.copy(position);
    camera.updateMatrixWorld(true);
  };
};

export const getParallaxState = (): {
  enabled: boolean;
  source: ParallaxSource;
  permission: ParallaxPermission;
  offset: Vec2;
  tilt: Vec2 | null;
  rest: Vec2 | null;
  plane: number;
} => ({
  enabled: settings.enabled,
  source: currentSource(performance.now()),
  permission,
  offset: { ...offset },
  tilt: tilt ? { ...tilt } : null,
  rest: rest ? { ...rest } : null,
  plane: planeDistance(),
});

/** One line for the performance HUD: what drives the eye and where it is. */
export const describeParallax = (): string => {
  const s = getParallaxState();
  if (!s.enabled) return 'off';
  const v = (p: Vec2 | null) => (p ? `${p.x.toFixed(2)}/${p.y.toFixed(2)}` : '-');
  return (
    `${s.source}, permission ${s.permission}, eye ${v(s.offset)}, ` +
    `tilt ${v(s.tilt)} from ${v(s.rest)}, plane ${s.plane.toFixed(1)}`
  );
};

/** Listens for the sensors, once per page. */
export const installParallax = (): void => {
  if (!permissionGate()) permission = 'not-needed';
  window.addEventListener('deviceorientation', (event) => {
    feedOrientation(event.beta, event.gamma);
  });
  window.addEventListener('pointermove', (event) => {
    // A finger dragging a panel is not a viewer moving their head.
    if (event.pointerType !== 'mouse') return;
    feedPointer(
      (event.clientX / window.innerWidth) * 2 - 1,
      -((event.clientY / window.innerHeight) * 2 - 1)
    );
  });
};
