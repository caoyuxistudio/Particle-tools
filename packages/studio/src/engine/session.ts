// The studio's one seam to the engine (V2-ARCHITECTURE.md §3): boots the world
// into a container, owns the running particle system, applies document changes
// at the cost the schema names, and runs the frame loop. Modelled on player.ts
// (the engine's other UI-free consumer) rather than on V1's glue.
//
// Only modules inside the engine boundary are imported here
// (packages/editor/engine-boundary.json).

import * as THREE from 'three';
import { updateParticleSystems } from '@newkrok/three-particles';
import { prepareParticleBackend } from '@particle-tools/engine/gpu-support';
import {
  createWorld,
  compileWorld,
  updateWorld,
  renderPlayer,
  isPresenting,
  getScene,
  getRenderer,
  getRendererDomElement,
  getDepthTexture,
  getOutputCamera,
  resetCamera,
  getRenderScale,
  setRenderScale,
  getDrawingBufferSize,
  getSsrSettings,
  setSsrSettings,
  getAoSettings,
  setAoSettings,
  setStatsContainer,
  setViewportInsets,
  setSteppedFrameDelta,
  type ViewportInsetsProvider,
} from '@particle-tools/engine/world';
import { createTimeline, defaultTimelineSettings, sanitizeTimelineSettings, timecode, type TimelineSettings } from '@particle-tools/engine/timeline';
import { installPerfHud, type PerfHud } from '@particle-tools/engine/perf-hud';
import { installGyroHud, type GyroHud } from '@particle-tools/engine/gyro-hud';
import { installPresentationControls, togglePresentation } from '@particle-tools/engine/presentation';
import { installTouchInput } from '@particle-tools/engine/touch-input';
import { getParallaxSettings, setParallaxSettings, recenterParallax, resetGyroscope, describeParallax } from '@particle-tools/engine/parallax';
import { getOutputCameraId, updateSceneObject, getSceneObjects } from '@particle-tools/engine/scene-objects';
import { getTexture } from '@particle-tools/engine/assets';
import { initAssets, loadCustomAssets } from '@particle-tools/engine/assets';
import { loadVideoTextures } from '@particle-tools/engine/video-textures';
import { initSceneObjects, tintFrameEdges } from '@particle-tools/engine/scene-objects';
import { loadParticleSystem, serializeConfig } from '@particle-tools/engine/save-and-load';
import { buildParticleSystem } from '@particle-tools/engine/particle-factory';
import { applySimulation, resetSimulation } from '@particle-tools/engine/simulation';
import { setNotifier, type Notifier } from '@particle-tools/engine/notify';
import { schema, fieldAt, documentDefaults, type ChangeLevel, type Doc } from '@particle-tools/engine/schema';
import { installFurniture, syncFurniture, syncFurnitureFrame } from './furniture';

export type CycleData = { pauseStartTime: number; totalPauseTime: number; now: number; delta: number; elapsed: number };

const cycleData: CycleData = { pauseStartTime: 0, totalPauseTime: 0, now: 0, delta: 0, elapsed: 0 };

// ─── time ────────────────────────────────────────────────────────────────────
//
// The piece's clock is the timeline's (engine/timeline.ts), not the wall's:
// each drawn frame the timeline says how far to step, and `elapsed` — what the
// noise field, the emitter's own motion and the library's `now` are read from —
// is the timeline's position in seconds. Pausing is simply not stepping.
// `now` keeps the magnitude of Date.now() (the library stores creation times
// in it), counted from the moment the page opened.
const EPOCH_MS = Date.now();
const timeline = createTimeline();
/**
 * The simulation's own seconds: the steps added up. Not the timeline's
 * position — a loop that lets the particles carry on sends the position back
 * to the start, and a noise field read from it would jump with it.
 */
let simSeconds = 0;
const clockNow = (): number => EPOCH_MS + simSeconds * 1000;

/** The document: the particle config plus `_editorData`. One object for the session, as the loader expects. */
export const doc: Doc = { ...documentDefaults(), _editorData: { ...documentDefaults()._editorData } };

let clock: THREE.Clock;
let particleSystem: any = null;
let container: THREE.Object3D;
let webGPUAvailable = false;
let framesDrawn = 0;
let paused = false;
const meanColor = { r: 0, g: 0, b: 0 };

const marks: Record<string, number> = {};
const mark = (name: string): void => {
  marks[name] = Math.round(performance.now());
  performance.mark(`boot:${name}`);
  bootListener?.(name, 1);
};
/** The shell's loading bar: told of each boot mark, and of progress inside the long ones. */
let bootListener: ((phase: string, fraction: number) => void) | null = null;
export const bootTimeline = (): Record<string, number> => ({ ...marks });

// ─── rebuilding ──────────────────────────────────────────────────────────────

/** V1's recreate: dispose and build again from the document. */
export const rebuild = (): void => {
  if (particleSystem) {
    particleSystem.dispose();
    particleSystem = null;
    cycleData.totalPauseTime = 0;
  }
  particleSystem = buildParticleSystem(doc, { webGPUAvailable, depthTexture: getDepthTexture(), now: clockNow() });
  container.add(particleSystem.instance);
  rebuilds += 1;
  // The shape helper lives inside the instance and went with the old one.
  syncFurniture();
};
let rebuilds = 0;
export const rebuildCount = (): number => rebuilds;

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let liveTimer: ReturnType<typeof setTimeout> | null = null;
let livePending = new Set<string>();
const THROTTLE_MS = 100;

const applyLive = (keys: Iterable<string>): void => {
  if (!particleSystem) return;
  const partial: Record<string, unknown> = {};
  for (const k of keys) if (doc[k] !== undefined) partial[k] = doc[k];
  if (Object.keys(partial).length) particleSystem.updateConfig(partial);
};

/**
 * Applies a change at `path` to the running system at the cost its field
 * names: `live` goes through updateConfig (leading edge now, trailing edge
 * after the throttle), `rebuild` and `structural` rebuild the system (once per
 * throttle window). Editor-only fields touch nothing here.
 */
export const applyChange = (path: string): ChangeLevel | 'none' => {
  const field = fieldAt(path);
  if (!field) return 'none';
  // Editor-only fields cost the engine nothing unless the table says they
  // rebuild (the texture ids under _editorData do: they change the map).
  if (field.editorOnly && field.change === 'live') return 'none';
  if (field.change === 'live') {
    const top = path.split('.')[0];
    if (liveTimer) {
      livePending.add(top);
    } else {
      applyLive([top]);
      liveTimer = setTimeout(() => {
        liveTimer = null;
        if (livePending.size) {
          const keys = [...livePending];
          livePending = new Set();
          applyLive(keys);
        }
      }, THROTTLE_MS);
    }
    return 'live';
  }
  if (!rebuildTimer) {
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      rebuild();
    }, THROTTLE_MS);
  }
  return field.change;
};

// ─── loading ─────────────────────────────────────────────────────────────────

/** The one load path, shared with V1's LOAD and the player's paste. */
export const load = (config: Doc): void => {
  resetSimulation(container);
  // A piece without a timeline of its own gets the default one, not the last piece's.
  if (!config?._editorData?.timeline && doc._editorData) delete doc._editorData.timeline;
  timeline.configure(config?._editorData?.timeline);
  timeline.rewind();
  simSeconds = timeline.seconds();
  loadParticleSystem({ config, particleSystemConfig: doc, recreateParticleSystem: () => rebuild() });
  syncFurniture();
};

export const serialize = (): string => JSON.stringify(serializeConfig(doc));

export const getParticleSystem = (): any => particleSystem;
export const getFrames = (): number => framesDrawn;
export const isPaused = (): boolean => paused;

/** What the footer reads twice a second: the running system, in numbers. */
export type LiveStats = {
  /** Particle slots in use right now, and how many there are. */
  live: number;
  max: number;
  /** The emission rate the piece asks for, particles a second. */
  rate: number;
  /** Seconds on the simulation clock. */
  elapsed: number;
  paused: boolean;
  /** Where the simulation runs. */
  backend: 'GPU' | 'CPU';
  renderer: string;
};
export const getLiveStats = (): LiveStats => ({
  live: particleSystem?.getActiveParticleCount?.() ?? 0,
  max: Number(doc.maxParticles) || 0,
  rate: Number(doc.emission?.rateOverTime) || 0,
  elapsed: simSeconds,
  paused,
  backend: particleSystem?.computeNode ? 'GPU' : 'CPU',
  renderer: String(doc.renderer?.rendererType ?? 'POINTS'),
});
export const setPaused = (next: boolean): void => {
  if (next) timeline.pause();
  else timeline.play();
  paused = !timeline.isPlaying();
};

// ─── the transport ───────────────────────────────────────────────────────────

/** Starts the simulation over at the timeline's position: nothing alive, the emitter where it began. */
const restartSimulation = (): void => {
  simSeconds = timeline.seconds();
  resetSimulation(container);
  rebuild();
};

export const play = (): void => setPaused(false);
export const pause = (): void => setPaused(true);
/** Back to the start of the range, paused, the simulation cleared. */
export const stop = (): void => {
  timeline.stop();
  paused = true;
  restartSimulation();
};

// ─── the playhead in hand ────────────────────────────────────────────────────
//
// Dragging the playhead moves time, and only time: the position goes where the
// hand puts it and playback carries on from there. The simulation is not
// rewound or re-run — the particles are wherever they have got to, as they are
// when a loop comes round without a restart. (Bringing the simulation itself
// to a frame is a different thing, and wants snapshots — BACKLOG.md.)

/** The frame the hand holds the playhead on, while it does. */
let heldFrame: number | null = null;

/** Takes hold of the playhead (a frame) or lets go of it (null): time stays under the hand, then runs on from there. */
export const holdPlayhead = (frame: number | null): void => {
  heldFrame = frame === null ? null : Math.round(frame);
  if (heldFrame !== null) timeline.setPosition(heldFrame);
};

/** The timeline's settings: the piece's own, or the defaults until it has some. */
export const getTimelineSettings = (): TimelineSettings =>
  sanitizeTimelineSettings(doc._editorData?.timeline ?? defaultTimelineSettings());

/** What the timeline bar reads: where the piece is in its time. */
export type TimelineState = TimelineSettings & {
  playing: boolean;
  frame: number;
  seconds: number;
  timecode: string;
  /** Frames in the range, both ends included. */
  total: number;
};
export const getTimelineState = (): TimelineState => {
  const t = timeline.settings();
  return {
    ...t,
    playing: timeline.isPlaying(),
    frame: timeline.frame(),
    seconds: timeline.seconds(),
    timecode: timecode(timeline.frame(), t.fps),
    total: t.end - t.start + 1,
  };
};

// ─── the loop ────────────────────────────────────────────────────────────────

const animate = (): void => {
  framesDrawn += 1;
  // The timeline decides the step: the wall clock's while real time is on,
  // exactly one frame while it is off, nothing while paused; a wrap at the end
  // of the range starts the simulation over if the piece asks for that.
  timeline.configure(doc._editorData?.timeline);
  const step = timeline.advance(clock.getDelta());
  // In the hand, the playhead stays under it; the simulation steps as usual.
  if (heldFrame !== null) timeline.setPosition(heldFrame);
  paused = !timeline.isPlaying();
  setSteppedFrameDelta(timeline.settings().realtime ? null : step.delta);
  if (step.wrapped && heldFrame === null && timeline.settings().restartOnLoop) restartSimulation();
  if (step.delta > 0) {
    simSeconds += step.delta;
    cycleData.now = clockNow();
    cycleData.delta = step.delta;
    cycleData.elapsed = simSeconds;
    const simulation = doc._editorData?.simulation;
    if (simulation) applySimulation(container, simulation, cycleData.elapsed);
    updateParticleSystems(cycleData);
  }
  tintFrameEdges(particleSystem?.getMeanColor?.(meanColor) ? meanColor : null);
  syncFurnitureFrame();
  const soft = !!doc.renderer?.softParticles?.enabled;
  // A frame that did not step (paused) gets no compute pass: the kernel would
  // move the particles again by the last step's delta, and pause would not
  // hold them.
  const computeNode = step.delta === 0 ? null : (particleSystem?.computeNode ?? null);
  // Presenting: the player's frame, output camera straight to the canvas.
  if (isPresenting()) renderPlayer(soft, container, computeNode);
  else updateWorld(soft, container, computeNode);
  if (framesDrawn === 1) mark('first-frame');
  requestAnimationFrame(animate);
};

// ─── instruments: Perf HUD, Gyro panel, presentation mode, touch ─────────────

let perfHud: PerfHud | null = null;
let gyroHud: GyroHud | null = null;
let particleBudget = 1;

const installInstruments = (): void => {
  const baseBudget = () => ({
    maxParticles: Math.round(doc.maxParticles / particleBudget),
    rateOverTime: doc.emission.rateOverTime / particleBudget,
  });
  perfHud = installPerfHud({
    backend: webGPUAvailable ? 'webgpu' : 'webgl',
    getRenderScale,
    setRenderScale,
    getDrawingBufferSize,
    getSsr: getSsrSettings,
    setSsr: setSsrSettings,
    getAo: getAoSettings,
    setAo: setAoSettings,
    getParallax: () => getParallaxSettings().enabled,
    setParallax: (enabled) => setParallaxSettings({ ...getParallaxSettings(), enabled }),
    getParticles: () => ({ maxParticles: doc.maxParticles, rateOverTime: doc.emission.rateOverTime, budget: particleBudget }),
    setParticleBudget: (factor) => {
      const base = baseBudget();
      particleBudget = factor;
      doc.maxParticles = Math.round(base.maxParticles * factor);
      doc.emission.rateOverTime = base.rateOverTime * factor;
      rebuild();
    },
    getVideoReadback: () => {
      const id = doc._editorData?.colorInstanceTextureId;
      const texture: any = id ? getTexture(id) : null;
      return texture?.map?.userData?.colorInstanceReadback ?? null;
    },
    getPieceName: () => doc._editorData?.metadata?.name ?? 'Untitled',
    extra: () => [
      ['boot', Object.entries(marks).map(([k, v]) => `${k} ${v}`).join(' → ')],
      ['parallax', describeParallax()],
      ['scene', `${getSceneObjects().length} objects`],
    ],
  });
  gyroHud = installGyroHud({
    getSettings: getParallaxSettings,
    setSettings: (patch) => {
      const next = { ...getParallaxSettings(), ...patch };
      const cameraId = getOutputCameraId();
      if (cameraId) updateSceneObject(cameraId, { parallax: next });
      else setParallaxSettings(next);
    },
    resetCamera: recenterParallax,
    resetGyroscope,
  });
  installPresentationControls(perfHud, gyroHud);
  // Fingers on the picture while presenting: samples for the touch wake.
  const touch = installTouchInput(getRendererDomElement(), {
    getSystem: () => particleSystem,
    getConfig: () => doc,
    isEnabled: isPresenting,
    getCamera: getOutputCamera,
  });
  (window as any).__touch = {
    ...touch,
    feed: (sample: any) => particleSystem?.feedTouch?.(sample),
    count: () => particleSystem?.getTouchCount?.() ?? 0,
    clear: () => particleSystem?.clearTouches?.(),
  };
  (window as any).__perfHud = perfHud;
  (window as any).__gyroHud = gyroHud;
  // A floating panel must be closable from itself: once it covers the button
  // that opened it, there is no other way. The HUDs build their DOM on first
  // show, so the close is added whenever one appears.
  const closes = () => {
    addClose('.perf-hud', () => perfHud?.hide());
    addClose('.gyro-hud', () => gyroHud?.hide());
  };
  closes();
  new MutationObserver(closes).observe(document.body, { childList: true });
};

const addClose = (selector: string, close: () => void): void => {
  const root = document.querySelector<HTMLElement>(selector);
  if (!root || root.querySelector('.hud-close')) return;
  root.style.position = 'fixed';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hud-close';
  button.title = 'Close';
  button.textContent = '×';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    close();
  });
  root.prepend(button);
};

export const present = (): void => togglePresentation();
export const togglePerfHud = (): void => perfHud?.toggle();
export const toggleGyroHud = (): void => gyroHud?.toggle();

// ─── boot ────────────────────────────────────────────────────────────────────

export type BootOptions = {
  /** The element the canvas is mounted into (a query, as createWorld takes). */
  stage: string;
  statsContainer: HTMLElement | null;
  viewportInsets: ViewportInsetsProvider;
  notifier: Notifier;
  /** The piece to open, already fetched. */
  piece: Doc | null;
  /** A gizmo wrote the document (path); the store bumps its revision. */
  onEngineChange?: (path: string) => void;
  /** Each boot mark as it lands (fraction 1), and the way through a long phase (fraction < 1, named by the mark it leads to). */
  onBootPhase?: (phase: string, fraction: number) => void;
};

let booted = false;

export const boot = async (options: BootOptions): Promise<void> => {
  if (booted) return;
  booted = true;
  bootListener = options.onBootPhase ?? null;
  mark('start');
  clock = new THREE.Clock();
  setNotifier(options.notifier);
  setViewportInsets(options.viewportInsets);
  setStatsContainer(options.statsContainer);

  webGPUAvailable = (await prepareParticleBackend()) === 'webgpu';
  mark('backend');

  await createWorld(options.stage);
  mark('world');
  container = new THREE.Object3D();
  getScene().add(container);
  installFurniture({ doc, container: () => container, particleSystem: () => particleSystem, changed: (path) => { applyChange(path); options.onEngineChange?.(path); } });
  installInstruments();

  // The built-ins load one after another — on a cold cache the long stretch of the boot.
  await new Promise<void>((resolve) => initAssets(resolve, (done, total) => done < total && bootListener?.('scene', done / total)));
  await new Promise<void>((resolve) => loadCustomAssets({ textures: [], onComplete: resolve }));
  await loadVideoTextures();
  initSceneObjects();
  mark('scene');
  // Let the shell paint before the heavy work — but a hidden tab never
  // gets a frame, and the boot must not hang on one.
  await Promise.race([new Promise((r) => requestAnimationFrame(() => r(null))), new Promise((r) => setTimeout(r, 120))]);
  mark('painted');

  if (options.piece) load(options.piece);
  else rebuild();
  mark('piece');
  // The home view: 45° around and 45° up, framing the installation.
  resetCamera();

  await compileWorld();
  if (particleSystem?.computeNode) {
    try {
      await (getRenderer() as any).computeAsync(particleSystem.computeNode);
    } catch {
      /* the first frame compiles it */
    }
  }
  mark('compiled');
  animate();
};

export { schema, getOutputCamera, syncFurniture, isPresenting, resetCamera };

// TEMP DEBUG — the studio's seam for its harness, like V1's window.editor.
(window as any).__studio = {
  doc,
  play,
  pause,
  stop,
  holdPlayhead,
  getTimelineState,
  bootTimeline,
  serialize,
  load,
  rebuild,
  applyChange,
  getParticleSystem,
  getFrames,
  rebuildCount,
  schema,
  fieldAt,
};
