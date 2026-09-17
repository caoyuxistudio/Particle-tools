// The studio's one seam to the engine (V2-ARCHITECTURE.md §3): boots the world
// into a container, owns the running particle system, applies document changes
// at the cost the schema names, and runs the frame loop. Modelled on player.ts
// (the engine's other UI-free consumer) rather than on V1's glue.
//
// Only modules inside the engine boundary are imported here
// (packages/editor/engine-boundary.json).

import * as THREE from 'three';
import { updateParticleSystems } from '@newkrok/three-particles';
import { prepareParticleBackend } from '@engine/gpu-support';
import {
  createWorld,
  compileWorld,
  updateWorld,
  getScene,
  getRenderer,
  getDepthTexture,
  getOutputCamera,
  setStatsContainer,
  setViewportInsets,
  type ViewportInsetsProvider,
} from '@engine/world';
import { initAssets, loadCustomAssets } from '@engine/assets';
import { loadVideoTextures } from '@engine/video-textures';
import { initSceneObjects, tintFrameEdges } from '@engine/scene-objects';
import { loadParticleSystem, serializeConfig } from '@engine/save-and-load';
import { buildParticleSystem } from '@engine/particle-factory';
import { applySimulation, resetSimulation } from '@engine/simulation';
import { setNotifier, type Notifier } from '@engine/notify';
import { schema, fieldAt, documentDefaults, type ChangeLevel, type Doc } from '@engine/schema';
import { installFurniture, syncFurniture, syncFurnitureFrame } from './furniture';

export type CycleData = { pauseStartTime: number; totalPauseTime: number; now: number; delta: number; elapsed: number };

const cycleData: CycleData = { pauseStartTime: 0, totalPauseTime: 0, now: 0, delta: 0, elapsed: 0 };

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
};
export const bootTimeline = (): Record<string, number> => ({ ...marks });

// ─── rebuilding ──────────────────────────────────────────────────────────────

/** V1's recreate: dispose and build again from the document. */
export const rebuild = (): void => {
  if (particleSystem) {
    particleSystem.dispose();
    particleSystem = null;
    cycleData.totalPauseTime = 0;
  }
  particleSystem = buildParticleSystem(doc, { webGPUAvailable, depthTexture: getDepthTexture() });
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
  if (!field || field.editorOnly) return 'none';
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
  loadParticleSystem({ config, particleSystemConfig: doc, recreateParticleSystem: () => rebuild() });
  syncFurniture();
};

export const serialize = (): string => JSON.stringify(serializeConfig(doc));

export const getParticleSystem = (): any => particleSystem;
export const getFrames = (): number => framesDrawn;
export const isPaused = (): boolean => paused;
export const setPaused = (next: boolean): void => {
  if (next === paused) return;
  paused = next;
  if (next) cycleData.pauseStartTime = Date.now();
  else cycleData.totalPauseTime += Date.now() - cycleData.pauseStartTime;
};

// ─── the loop ────────────────────────────────────────────────────────────────

const animate = (): void => {
  framesDrawn += 1;
  if (!paused) {
    const rawDelta = clock.getDelta();
    cycleData.now = Date.now() - cycleData.totalPauseTime;
    cycleData.delta = rawDelta > 0.1 ? 0.1 : rawDelta;
    cycleData.elapsed = clock.getElapsedTime();
    const simulation = doc._editorData?.simulation;
    if (simulation) applySimulation(container, simulation, cycleData.elapsed);
    updateParticleSystems(cycleData);
  }
  tintFrameEdges(particleSystem?.getMeanColor?.(meanColor) ? meanColor : null);
  syncFurnitureFrame();
  updateWorld(!!doc.renderer?.softParticles?.enabled, container, particleSystem?.computeNode ?? null);
  if (framesDrawn === 1) mark('first-frame');
  requestAnimationFrame(animate);
};

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
};

let booted = false;

export const boot = async (options: BootOptions): Promise<void> => {
  if (booted) return;
  booted = true;
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

  await new Promise<void>((resolve) => initAssets(resolve));
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

export { schema, getOutputCamera, syncFurniture };

// TEMP DEBUG — the studio's seam for its harness, like V1's window.editor.
(window as any).__studio = {
  doc,
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
