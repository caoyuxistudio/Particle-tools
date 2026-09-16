import * as THREE from 'three';

import { createHelperEntries } from './three-particles-editor/entries/helper-entries';
import { MovementSimulations, RotationSimulations } from './three-particles-editor/simulation';
import {
  copyToClipboard,
  getObjectDiff,
  loadFromClipboard,
  loadParticleSystem,
  serializeConfig,
} from './three-particles-editor/save-and-load';
import {
  installPlayerControls,
  isEditorSuspended,
  notifyParticleConfigChanged,
  setFocusOverride,
  setSnapshotSource,
  shouldSuspendEditor,
  syncPlayerControls,
} from './three-particles-editor/player-window';
import { installPresentationControls } from './three-particles-editor/presentation';
import { installPerfHud } from './three-particles-editor/perf-hud';
import { installGyroHud } from './three-particles-editor/gyro-hud';
import { DEFAULT_EXAMPLE } from '../examples-config';
import { toUrlFriendlyString } from './utils/name-utils';
import {
  describeParallax,
  getParallaxSettings,
  setParallaxSettings,
  recenterParallax,
  resetGyroscope,
} from './three-particles-editor/parallax';
import { getDefaultParticleSystemConfig, updateParticleSystems } from '@newkrok/three-particles';
import { prepareParticleBackend } from './three-particles-editor/gpu-support';
import { buildParticleSystem } from './three-particles-editor/particle-factory';
import {
  createWorld,
  compileWorld,
  resetCamera,
  setTerrain,
  updateWorld,
  captureScreenshot,
  getDepthTexture,
  isPresenting,
  renderPlayer,
  getRenderScale,
  setRenderScale,
  getDrawingBufferSize,
  getSsrSettings,
  setSsrSettings,
  getAoSettings,
  setAoSettings,
  getRendererDomElement,
  getOutputCamera,
  getRenderer,
} from './three-particles-editor/world';
import { getTexture, initAssets, loadCustomAssets } from './three-particles-editor/assets';
import {
  addVideoFile,
  addVideoUrl,
  loadVideoTextures,
  readVideoEntries,
  removeVideo,
  setVideoSourcesPaused,
} from './three-particles-editor/video-textures';
import {
  initSceneObjects,
  getSceneObjects,
  getOutputCameraId,
  updateSceneObject,
  tintFrameEdges,
} from './three-particles-editor/scene-objects';

import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { Object3D } from 'three';
import { TextureId } from './three-particles-editor/texture-config';
import { createCurveEditor } from './three-particles-editor/curve-editor/curve-editor';
import { createGradientEditorEntries } from './three-particles-editor/entries/gradient-editor-entries';
import {
  createEmissionEntries,
  updateAllBurstCountMax,
} from './three-particles-editor/entries/emission-entries';
import { createGeneralEntries } from './three-particles-editor/entries/general-entries';
import { createNoiseEntries } from './three-particles-editor/entries/noise-entries';
import { createParticleColorInstanceEntries } from './three-particles-editor/entries/particle-color-instance-entries';
import { createSourceImageTweakEntries } from './three-particles-editor/entries/source-image-tweak-entries';
import { createTouchEntries } from './three-particles-editor/entries/touch-entries';
import { installTouchInput } from './three-particles-editor/touch-input';
import { createRendererEntries } from './three-particles-editor/entries/renderer-entries';
import { createRotationOverLifeTimeEntries } from './three-particles-editor/entries/rotation-over-lifetime-entries';
import { createShapeEntries } from './three-particles-editor/entries/shape-entries';
import { createSizeOverLifeTimeEntries } from './three-particles-editor/entries/size-over-lifetime-entries';
import { createOpacityOverLifeTimeEntries } from './three-particles-editor/entries/opacity-over-lifetime-entries';
import { createTextureSheetAnimationEntries } from './three-particles-editor/entries/texture-sheet-animation-entries';
import { createTransformEntries } from './three-particles-editor/entries/transform-entries';
import { createVelocityOverLifeTimeEntries } from './three-particles-editor/entries/velocity-over-lifetime-entries';
import { createSubEmitterEntries } from './three-particles-editor/entries/sub-emitter-entries';
import { createForceFieldEntries } from './three-particles-editor/entries/force-field-entries';
import { createCollisionPlaneEntries } from './three-particles-editor/entries/collision-plane-entries';
import { createTrailEntries } from './three-particles-editor/entries/trail-entries';
import { createMeshEntries } from './three-particles-editor/entries/mesh-entries';
import { generateDefaultName } from './utils/name-utils';

type ConfigMetadata = {
  name: string;
  createdAt: number;
  modifiedAt: number;
  editorVersion: string;
};

type GradientStop = {
  position: number;
  color: {
    r: number;
    g: number;
    b: number;
    a: number;
  };
};

type EditorData = {
  textureId: string;
  simulation: {
    movements: string;
    movementSpeed: number;
    rotation: string;
    rotationSpeed: number;
  };
  showLocalAxes: boolean;
  showWorldAxes: boolean;
  showShape: boolean;
  showForceFields: boolean;
  showCollisionPlanes: boolean;
  showColorSourceDebug: boolean;
  frustumCulled: boolean;
  useIndividualUpdate: boolean;
  useLiveUpdate: boolean;
  enableBigNumbers: boolean;
  terrain: {
    textureId: string;
    movements?: string;
    movementSpeed?: number;
    rotation?: string;
    rotationSpeed?: number;
  };
  gradientStops?: GradientStop[];
  metadata?: ConfigMetadata;
  /**
   * Source image for `particleColorInstance`. Defaults to the bundled
   * shan-shui photograph so switching the section on shows something
   * immediately instead of an unpainted cloud.
   */
  colorInstanceTextureId?: string;
};

type CycleData = {
  pauseStartTime: number;
  totalPauseTime: number;
  now: number;
  delta: number;
  elapsed: number;
};

// Type for particle system
type ParticleSystem = {
  instance: THREE.Object3D;
  dispose: () => void;
  update: (cycleData: CycleData) => void;
  updateConfig: (config: Partial<Record<string, unknown>>) => void;
};

type ConfigEntry = {
  onReset?: () => void;

  onParticleSystemChange?: (particleSystem: ParticleSystem) => void;
  onAssetUpdate?: () => void;

  onUpdate?: (cycleData: CycleData) => void;
};

type EditorContextStackEntry = {
  subEmitterIndex: number;
  parentConfig: any;
  expandedConfig: any;
};

type EditorContext = {
  type: 'root' | 'subEmitter';
  subEmitterIndex: number | null;
  parentConfig: any | null;
};

// Current editor version - replaced during build process
const EDITOR_VERSION = '__APP_VERSION__';

// Using the generateDefaultName utility function from name-utils.ts

const defaultEditorData: EditorData = {
  textureId: TextureId.POINT,
  simulation: {
    movements: MovementSimulations.DISABLED,
    movementSpeed: 1,
    rotation: RotationSimulations.DISABLED,
    rotationSpeed: 1,
  },
  showLocalAxes: false,
  showWorldAxes: false,
  showShape: false,
  showForceFields: false,
  showCollisionPlanes: false,
  showColorSourceDebug: false,
  frustumCulled: true,
  useIndividualUpdate: false,
  useLiveUpdate: false,
  enableBigNumbers: false,
  terrain: {
    textureId: TextureId.WIREFRAME,
  },
  colorInstanceTextureId: TextureId.SHANSHUI,
  gradientStops: [
    { position: 0, color: { r: 255, g: 255, b: 255, a: 255 } },
    { position: 1, color: { r: 255, g: 255, b: 255, a: 0 } },
  ],
  metadata: {
    name: 'Untitled-1', // Default name, will be updated in createNew()
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    editorVersion: EDITOR_VERSION,
  },
};

/**
 * What a new system starts from. The library's defaults are a game effect's
 * (100 particles, 10 a second); a piece here runs in the thousands, so a fresh
 * system starts there. Only creation reads this — loading merges over the
 * library's own defaults, so a saved config that omits either key keeps meaning
 * what it meant when it was written.
 */
export const NEW_SYSTEM_MAX_PARTICLES = 10000;
export const NEW_SYSTEM_RATE_OVER_TIME = 1000;
const editorDefaultConfig = (): any => {
  const config = getDefaultParticleSystemConfig();
  config.maxParticles = NEW_SYSTEM_MAX_PARTICLES;
  config.emission.rateOverTime = NEW_SYSTEM_RATE_OVER_TIME;
  return config;
};

const particleSystemConfig = {
  ...editorDefaultConfig(),
  _editorData: {
    ...defaultEditorData,
    terrain: { ...defaultEditorData.terrain, ...defaultEditorData.simulation },
    simulation: { ...defaultEditorData.simulation },
  },
};
const cycleData: CycleData = { pauseStartTime: 0, totalPauseTime: 0, now: 0, delta: 0, elapsed: 0 };

let scene: THREE.Scene;
let particleSystemContainer: Object3D;
let particleSystem: ParticleSystem | null = null;
let clock: THREE.Clock;
let isPaused = false;
let configDirty = false;
let isInitializing = false;
let webGPUAvailable = false;
let backendBadge: HTMLElement | null = null;

// Snapshot of structural feature state captured at particle system creation time.
// Used to detect when a live-update cannot be applied (e.g. on WebGPU the shader is
// compiled once and cannot add/remove feature branches at runtime).
type CreationSnapshot = {
  forceFieldCount: number;
  collisionPlaneCount: number;
  colorOverLifetimeActive: boolean;
  opacityOverLifetimeActive: boolean;
  sizeOverLifetimeActive: boolean;
  rotationOverLifetimeActive: boolean;
  noiseActive: boolean;
};
let creationSnapshot: CreationSnapshot | null = null;
const configEntries: ConfigEntry[] = [];

// Throttle timer for full recreate when live update is enabled.
// Avoids excessive dispose+create cycles while dragging sliders/color pickers.
let liveRecreateTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Keys that go live whatever the Helper's toggle says: they reach only the
 * CPU-side colour sampler and the particles' start colours
 * (recolorLiveParticles in the library), never the kernel or a material, so
 * there is nothing to rebuild. The recolour walks every live slot, so while a
 * slider drags it is applied at most ten times a second — the first change at
 * once, the rest trailing.
 */
const ALWAYS_LIVE_KEYS = ['particleColorInstance'];
let liveUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let liveUpdatePending = false;

const applyLiveUpdate = (activeConfig: any, keys: string[]): void => {
  if (!particleSystem) return;
  const partial: Record<string, unknown> = {};
  for (const key of keys) {
    if (activeConfig[key] !== undefined) partial[key] = activeConfig[key];
  }
  particleSystem.updateConfig(partial);
};
const LIVE_RECREATE_THROTTLE_MS = 100;

let currentPanel: GUI | null = null;
let editorContext: EditorContext = {
  type: 'root',
  subEmitterIndex: null,
  parentConfig: null,
};
const editorContextStack: EditorContextStackEntry[] = [];

const resetToRoot = (): void => {
  if (editorContext.type === 'subEmitter') {
    // Collapse all levels back — walk the stack from top to bottom
    while (editorContextStack.length > 0) {
      const entry = editorContextStack[editorContextStack.length - 1];
      if (expandedSubEmitterConfig) {
        entry.parentConfig.subEmitters[entry.subEmitterIndex].config =
          collapseSubEmitterConfig(expandedSubEmitterConfig);
      }
      expandedSubEmitterConfig = entry.expandedConfig;
      editorContextStack.pop();
    }
    expandedSubEmitterConfig = null;
    editorContext = { type: 'root', subEmitterIndex: null, parentConfig: null };
    destroyPanel();
    configEntries.length = 0;
  }
};

export const createNew = (): void => {
  // Switch back to root context if editing a sub-emitter
  resetToRoot();

  // Create new metadata with current timestamp and generated name
  const newMetadata = {
    name: generateDefaultName(),
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    editorVersion: EDITOR_VERSION,
  };

  const defaultConfig = editorDefaultConfig();

  // Clear all existing properties from particleSystemConfig (except _editorData)
  // This is necessary because patchObject doesn't handle type changes properly
  // (e.g., when startLifetime changes from {min, max} object to a number)
  Object.keys(particleSystemConfig).forEach((key) => {
    if (key !== '_editorData') {
      delete particleSystemConfig[key];
    }
  });

  // Deep clone the default config and assign to particleSystemConfig
  Object.keys(defaultConfig).forEach((key) => {
    if (key !== '_editorData') {
      particleSystemConfig[key] = JSON.parse(JSON.stringify(defaultConfig[key]));
    }
  });

  // Reset _editorData to defaults
  const editorDataKeys = Object.keys(defaultEditorData);
  editorDataKeys.forEach((key) => {
    if (key === 'metadata') return; // Handle metadata separately
    particleSystemConfig._editorData[key] = JSON.parse(JSON.stringify(defaultEditorData[key]));
  });

  // Update metadata
  particleSystemConfig._editorData.metadata = newMetadata;

  setTerrain();
  isInitializing = true;
  // Rebuild the panel so controllers bind to the new config object references
  destroyPanel();
  configEntries.length = 0;
  createPanel();
  configEntries.forEach(({ onReset }) => onReset && onReset());
  isInitializing = false;
  configDirty = false;
};

const resumeTime = (): void => {
  if (isPaused) {
    isPaused = false;
    cycleData.totalPauseTime += Date.now() - cycleData.pauseStartTime;
  }
};

const pauseTime = (): void => {
  if (!isPaused) {
    isPaused = true;
    cycleData.pauseStartTime = Date.now();
  }
};

/** Boot guard, and the counters the HUD reports so a double boot can be seen from a phone. */
let booted = false;
const bootStats = {
  attempts: 0,
  chains: 0,
  loops: 0,
  defaultExample: 'pending',
  /** Milliseconds since navigation at each boot phase, in order. */
  marks: {} as Record<string, number>,
};
/** One frame later, so the browser can paint what is already there. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Stamps a boot phase: on the HUD's boot line and as a performance mark. */
const bootMark = (name: string): void => {
  bootStats.marks[name] = Math.round(performance.now());
  performance.mark(`boot:${name}`);
};

/**
 * The piece the editor opens on. Fetched the moment boot starts, so by the
 * time the scene is ready it is usually already here; a failed fetch (offline,
 * a moved file) leaves the default emitter rather than a blank screen, and
 * says so on the HUD's boot line.
 */
const fetchDefaultExample = async (): Promise<ParticleSystemConfig | null> => {
  try {
    const response = await fetch(`./examples/${toUrlFriendlyString(DEFAULT_EXAMPLE)}/config.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as ParticleSystemConfig;
  } catch (error) {
    bootStats.defaultExample = `${DEFAULT_EXAMPLE} failed (${(error as Error).message})`;
    return null;
  }
};

export const createParticleSystemEditor = async (targetQuery: string): Promise<void> => {
  bootStats.attempts += 1;
  if (booted) {
    // eslint-disable-next-line no-console
    console.warn('createParticleSystemEditor called again; ignoring');
    return;
  }
  booted = true;
  bootMark('start');
  const defaultExample = fetchDefaultExample();
  clock = new THREE.Clock();

  // WebGPU where it exists; TSL materials over WebGL2 with CPU simulation
  // where it does not (the iOS Simulator, older browsers).
  webGPUAvailable = (await prepareParticleBackend()) === 'webgpu';
  bootMark('backend');

  // Debug: log WGSL shader compilation errors with source code
  if (typeof GPUDevice !== 'undefined') {
    const origCreateShaderModule = GPUDevice.prototype.createShaderModule;

    GPUDevice.prototype.createShaderModule = function (descriptor: any) {
      const module = origCreateShaderModule.call(this, descriptor);
      module.getCompilationInfo().then((info: any) => {
        const errors = info.messages.filter((m: any) => m.type === 'error');
        if (errors.length > 0) {
          // eslint-disable-next-line no-console
          console.group('%c[WGSL Shader Error]', 'color:red;font-weight:bold');

          errors.forEach((e: any) =>
            console.error(`Line ${e.lineNum}:${e.linePos} — ${e.message}`)
          );
          // eslint-disable-next-line no-console
          console.log(descriptor.code);
          // eslint-disable-next-line no-console
          console.groupEnd();
        }
      });
      return module;
    };
  }

  scene = await createWorld(targetQuery);
  bootMark('world');

  particleSystemContainer = new Object3D();
  scene.add(particleSystemContainer);

  // The display window reads the piece through the same serialiser that saving
  // and copying use, so what it shows is what a save would produce.
  setSnapshotSource(() => ({
    config: serializeConfig(particleSystemConfig),
    elapsed: clock.getElapsedTime(),
  }));
  installPlayerControls();

  // The performance HUD: what a frame costs on *this* device, with the levers
  // that change it. Toggled from the presentation bar or with P.
  let particleBudget = 1;
  const baseBudget = (): { maxParticles: number; rateOverTime: number } => ({
    maxParticles: Math.round(particleSystemConfig.maxParticles / particleBudget),
    rateOverTime: particleSystemConfig.emission.rateOverTime / particleBudget,
  });
  const hud = installPerfHud({
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
    getParticles: () => ({
      maxParticles: particleSystemConfig.maxParticles,
      rateOverTime: particleSystemConfig.emission.rateOverTime,
      budget: particleBudget,
    }),
    setParticleBudget: (factor) => {
      const base = baseBudget();
      particleBudget = factor;
      particleSystemConfig.maxParticles = Math.round(base.maxParticles * factor);
      particleSystemConfig.emission.rateOverTime = base.rateOverTime * factor;
      recreateParticleSystem(false);
    },
    getVideoReadback: () => {
      const id = particleSystemConfig._editorData?.colorInstanceTextureId;
      const texture: any = id ? getTexture(id) : null;
      return texture?.map?.userData?.colorInstanceReadback ?? null;
    },
    getPieceName: () => particleSystemConfig._editorData?.metadata?.name ?? 'Untitled',
    // What a phone cannot otherwise tell us: whether the editor booted once.
    extra: () => {
      const scene = (window as any).__world?.scene;
      const meshes = scene ? scene.children.filter((o: any) => o.isMesh || o.isLight).length : 0;
      return [
        [
          'boot',
          `attempts ${bootStats.attempts}, chains ${bootStats.chains}, loops ${bootStats.loops}, ` +
            `canvases ${document.querySelectorAll('#three-particles-editor canvas').length}, ` +
            `panels ${document.querySelectorAll('.lil-gui.root').length}, ` +
            `scene meshes+lights ${meshes} for ${getSceneObjects().length} objects, ` +
            `default ${bootStats.defaultExample}, ` +
            `timeline ${Object.entries(bootStats.marks)
              .map(([name, ms]) => `${name} ${ms}`)
              .join(' → ')}`,
        ],
        ['parallax', describeParallax()],
        [
          'touch',
          (() => {
            const t = (window as any).__touch?.state?.();
            return t
              ? `${t.enabled ? 'on' : 'off'}, fingers ${t.fingers}, fed ${t.fed}, samples ${particleSystem?.getTouchCount?.() ?? 0}, speed ${t.lastSpeed.toFixed(2)}`
              : 'none';
          })(),
        ],
      ];
    },
  });
  (window as any).__perfHud = hud;

  // The gyro panel writes to the camera object, so a lever moved on the phone
  // is in the config the next COPY carries; a page without an output camera
  // keeps the change for the session.
  const gyroHud = installGyroHud({
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
  (window as any).__gyroHud = gyroHud;
  installPresentationControls(hud, gyroHud);

  // Fingers on the picture while presenting: samples for the touch wake.
  const touchInput = installTouchInput(getRendererDomElement(), {
    getSystem: () => particleSystem,
    getConfig: () => particleSystemConfig,
    isEnabled: isPresenting,
    getCamera: getOutputCamera,
  });
  // TEMP DEBUG — the harness feeds fingers through here.
  (window as any).__touch = {
    ...touchInput,
    feed: (sample: Parameters<NonNullable<ParticleSystem['feedTouch']>>[0]) =>
      particleSystem?.feedTouch?.(sample),
    count: () => particleSystem?.getTouchCount?.() ?? 0,
    clear: () => particleSystem?.clearTouches?.(),
  };

  // TEMP DEBUG — the same kind of seam as window.__world. The harness lives in
  // a page that cannot lose focus for real, so it drives that input from here.
  (window as any).__playerLink = {
    shouldSuspendEditor,
    setFocusOverride,
    isEditorSuspended,
    isSuspended: () => suspendedByPlayer,
    frames: () => framesDrawn,
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseTime();
    else if (!isPaused) resumeTime();
  });

  // Screenshot hotkey: Shift + S
  document.addEventListener('keydown', (event) => {
    if (event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      captureScreenshot();
    }
  });

  // Create backend indicator badge (top-right, same row as FPS stats)
  backendBadge = document.createElement('div');
  backendBadge.style.cssText =
    'position:absolute;top:48px;right:315px;padding:2px 8px;border-radius:3px;' +
    'font-size:10px;font-weight:700;font-family:Roboto,sans-serif;letter-spacing:0.5px;' +
    'color:#fff;background:#555;z-index:10;pointer-events:none;line-height:15px;';
  backendBadge.textContent = '...';
  const wrapper = document.querySelector('.wrapper');
  if (wrapper) wrapper.appendChild(backendBadge);

  initAssets(() => {
    const customTextures =
      JSON.parse(localStorage.getItem('particle-system-editor/library') || '[]') || [];
    const imageTextures =
      JSON.parse(localStorage.getItem('particle-system-editor/image-textures') || '[]') || [];
    loadCustomAssets({
      textures: [...customTextures, ...imageTextures].map(
        ({ name, url }: { name: string; url: string }) => ({
          id: name,
          url,
        })
      ),
      onComplete: () => {
        // Videos a config may name as its colour source. Waited for like the
        // images are, so the first build already finds them by name.
        void loadVideoTextures().then(async () => {
          // Once. A texture chain that fired twice would otherwise mount the
          // scene twice — leaving copies no panel entry can delete — build two
          // panels, and run two frame loops.
          bootStats.chains += 1;
          if (bootStats.chains > 1) {
            // eslint-disable-next-line no-console
            console.warn('editor boot chain ran again; ignoring');
            return;
          }
          // Boxes, lights and probes saved from a previous session.
          initSceneObjects();
          bootMark('scene');
          createCurveEditor();
          bootMark('curve-editor');
          // Let the panels paint before the heavy work: the piece load and
          // the first frame's shader compilation are one long block, and
          // without a frame in between the page sits blank through it.
          await nextFrame();
          bootMark('painted');
          // The piece itself rather than the default emitter — the same load
          // an Examples click does, except that the panel is built one frame
          // after the first picture instead of before it. The default emitter
          // and its panel are only built when there is no piece to show.
          const example = await defaultExample;
          let loadedPiece = false;
          if (example) {
            try {
              resetToRoot();
              isInitializing = true;
              loadParticleSystem({
                config: example,
                particleSystemConfig,
                recreateParticleSystem,
                onLoad: () => {
                  destroyPanel();
                  configEntries.length = 0;
                },
              });
              isInitializing = false;
              configDirty = false;
              bootMark('example');
              bootStats.defaultExample = `${DEFAULT_EXAMPLE} loaded`;
              loadedPiece = true;
            } catch (error) {
              bootStats.defaultExample = `${DEFAULT_EXAMPLE} failed (${(error as Error).message})`;
            }
          }
          if (!loadedPiece) {
            isInitializing = true;
            createPanel();
            recreateParticleSystem(false);
            isInitializing = false;
            bootMark('panel');
          }
          // Shader, pipeline and compute-kernel compilation for what the
          // viewport will draw, done ahead and off the main thread instead of
          // inside the first frame.
          await compileWorld();
          if (particleSystem?.computeNode) {
            try {
              await (getRenderer() as any).computeAsync(particleSystem.computeNode);
            } catch {
              /* the first frame compiles it */
            }
          }
          bootMark('compiled');
          bootStats.loops += 1;
          animate();
          if (loadedPiece) {
            // The panel, once the picture is up: 170 controls take a frame's
            // worth of time to build, and nothing needs them before then.
            await nextFrame();
            isInitializing = true;
            createPanel();
            configEntries.forEach(({ onReset }) => onReset && onReset());
            isInitializing = false;
            bootMark('panel');
          }
        });
      },
    });
  });

  // The harness has no file dialog; this is how it gets a video in.
  (window as any).__videoTextures = {
    addFile: addVideoFile,
    addUrl: addVideoUrl,
    // Mirrors what the Textures panel does on delete: a removed video must not
    // stay bound as the colour source, whichever door it left through.
    remove: async (id: number) => {
      const entry = await removeVideo(id);
      if (entry && particleSystemConfig._editorData.colorInstanceTextureId === entry.name)
        window.editor.setColorInstanceTexture(undefined);
      return entry;
    },
    entries: readVideoEntries,
    get: (name: string) => getTexture(name),
  };
};

/**
 * Mirrors a suspension into the simulation clock.
 *
 * Not drawing is only half of it. If the clock kept running, `cycleData.now`
 * would jump the whole length of the suspension on the frame the editor comes
 * back, and the emitter would spend all of it at once. Pausing is what the
 * PAUSE button already does, so this reuses it — and remembers whether the
 * button had it paused first, so coming back does not silently start a piece
 * the user had deliberately stopped.
 */
let suspendedByPlayer = false;
let pausedBeforeSuspension = false;
let framesDrawn = 0;

const applyPlayerSuspension = (): boolean => {
  const suspend = isEditorSuspended();
  if (suspend !== suspendedByPlayer) {
    suspendedByPlayer = suspend;
    // A suspended editor spawns nothing, so nothing samples its videos; their
    // decoding is the one cost still running, and it stops here too.
    setVideoSourcesPaused(suspend);
    if (suspend) {
      pausedBeforeSuspension = isPaused;
      pauseTime();
    } else if (!pausedBeforeSuspension) {
      resumeTime();
    }
  }
  return suspend;
};

/** Scratch for the particles' mean colour, read once a frame. */
const meanColor = { r: 0, g: 0, b: 0 };

const animate = (): void => {
  // Ahead of the gate: the overlay is how a suspended editor explains itself,
  // and the button is how the display gets closed from one.
  syncPlayerControls();

  if (applyPlayerSuspension()) {
    requestAnimationFrame(animate);
    return;
  }

  framesDrawn += 1;

  if (!isPaused) {
    const rawDelta = clock.getDelta();
    cycleData.now = Date.now() - cycleData.totalPauseTime;
    cycleData.delta = rawDelta > 0.1 ? 0.1 : rawDelta;
    cycleData.elapsed = clock.getElapsedTime();

    configEntries.forEach(({ onUpdate }) => onUpdate && onUpdate(cycleData));
    if (particleSystemConfig._editorData.useIndividualUpdate && particleSystem) {
      particleSystem.update(cycleData);
    } else {
      updateParticleSystems(cycleData);
    }
  }
  const activeConfig = getActiveConfig();
  const softParticlesEnabled = !!activeConfig?.renderer?.softParticles?.enabled;
  const computeNode = particleSystem?.computeNode ?? null;
  // The frames' inner edges take the picture's colour, if they are set to.
  tintFrameEdges(particleSystem?.getMeanColor?.(meanColor) ? meanColor : null);
  // Presenting: the player's frame — output camera straight to the canvas —
  // and none of the editor's (no viewport, no corner preview, no depth pass
  // for either).
  if (isPresenting()) renderPlayer(softParticlesEnabled, particleSystemContainer, computeNode);
  else updateWorld(softParticlesEnabled, particleSystemContainer, computeNode);
  // The first frame carries the shader and pipeline compilation.
  if (framesDrawn === 1) bootMark('first-frame');
  requestAnimationFrame(animate);
};

const getActiveConfig = (): any => {
  if (editorContext.type === 'subEmitter' && expandedSubEmitterConfig) {
    return expandedSubEmitterConfig;
  }
  return particleSystemConfig;
};

/**
 * Recreates the particle system from scratch, or — when live update is enabled and
 * liveUpdateKeys are provided — applies a partial config update via the engine's
 * updateConfig API without disposing the system.
 *
 * @param markAsDirty  When false the config-dirty flag is not set (used during init/load).
 * @param liveUpdateKeys  Top-level config keys that are safe to hot-update.
 *   When useLiveUpdate is ON and these keys are provided, only those properties are
 *   sent to updateConfig(). When useLiveUpdate is OFF (or keys are not provided),
 *   a full dispose + recreate happens.
 */
const recreateParticleSystem = (markAsDirty = true, liveUpdateKeys?: string[]): void => {
  const activeConfig = getActiveConfig();

  // Throttled, and a no-op while no display window is open.
  notifyParticleConfigChanged();

  // Live-update path — applies a partial config update via the engine's updateConfig API.
  // Falls through to full recreate when:
  //  1. A structural feature toggle changed (e.g. colorOverLifetime became active when it
  //     was inactive at creation, or force field count went from 0 → >0). The GPU shader
  //     is compiled once and cannot add/remove feature branches at runtime.
  //  2. The update touches curve-based keys whose data is baked into a GPU texture at
  //     creation time (colorOverLifetime, opacityOverLifetime, sizeOverLifetime,
  //     rotationOverLifetime). The engine's updateConfig does not re-bake these.
  const alwaysLive = !!liveUpdateKeys && liveUpdateKeys.every((k) => ALWAYS_LIVE_KEYS.includes(k));
  if (
    markAsDirty &&
    liveUpdateKeys &&
    particleSystem &&
    (activeConfig._editorData?.useLiveUpdate || alwaysLive)
  ) {
    // Keys whose bezier/curve data is baked into a GPU texture at creation time.
    // Changing their data (not just isActive) requires a full recreate on GPU.
    const GPU_BAKED_CURVE_KEYS = [
      'colorOverLifetime',
      'opacityOverLifetime',
      'sizeOverLifetime',
      'rotationOverLifetime',
    ];

    const touchesBakedCurves =
      webGPUAvailable && liveUpdateKeys.some((k) => GPU_BAKED_CURVE_KEYS.includes(k));

    let structuralChange = false;
    if (creationSnapshot != null) {
      const hasFF = (activeConfig.forceFields?.length ?? 0) > 0;
      const hasCP = (activeConfig.collisionPlanes?.length ?? 0) > 0;
      structuralChange =
        hasFF !== creationSnapshot.forceFieldCount > 0 ||
        hasCP !== creationSnapshot.collisionPlaneCount > 0 ||
        !!activeConfig.colorOverLifetime?.isActive !== creationSnapshot.colorOverLifetimeActive ||
        !!activeConfig.opacityOverLifetime?.isActive !==
          creationSnapshot.opacityOverLifetimeActive ||
        !!activeConfig.sizeOverLifetime?.isActive !== creationSnapshot.sizeOverLifetimeActive ||
        !!activeConfig.rotationOverLifetime?.isActive !==
          creationSnapshot.rotationOverLifetimeActive ||
        !!activeConfig.noise?.isActive !== creationSnapshot.noiseActive;
    }

    if (!structuralChange && !touchesBakedCurves) {
      if (alwaysLive && !isInitializing) {
        // Leading edge now, trailing edge after the throttle if anything
        // moved meanwhile — the last value of a drag always lands.
        if (liveUpdateTimer) {
          liveUpdatePending = true;
        } else {
          applyLiveUpdate(activeConfig, liveUpdateKeys);
          const keys = liveUpdateKeys;
          liveUpdateTimer = setTimeout(() => {
            liveUpdateTimer = null;
            if (liveUpdatePending) {
              liveUpdatePending = false;
              applyLiveUpdate(getActiveConfig(), keys);
            }
          }, LIVE_RECREATE_THROTTLE_MS);
        }
      } else {
        applyLiveUpdate(activeConfig, liveUpdateKeys);
      }
      if (!isInitializing) {
        configDirty = true;
      }
      return;
    }
    // Structural change or baked-curve update detected — fall through to full recreate
  }

  // Throttle full recreate for continuous interactions (slider / color picker drag).
  // Keys that come from one-shot actions (add/remove force field, toggle checkbox) call
  // recreateParticleSystem without liveUpdateKeys, so they bypass this throttle.
  if (liveUpdateKeys && !isInitializing) {
    if (markAsDirty) configDirty = true;
    if (liveRecreateTimer) return;
    liveRecreateTimer = setTimeout(() => {
      liveRecreateTimer = null;
      doFullRecreate(getActiveConfig(), markAsDirty);
    }, LIVE_RECREATE_THROTTLE_MS);
    return;
  }

  doFullRecreate(activeConfig, markAsDirty);
};

const doFullRecreate = (activeConfig: any, markAsDirty: boolean): void => {
  // Full recreate path
  resumeTime();
  if (particleSystem) {
    particleSystem.dispose();
    particleSystem = null;
    cycleData.totalPauseTime = 0;
  }

  // Shared with the player window so both interpret a config identically.
  particleSystem = buildParticleSystem(activeConfig, {
    webGPUAvailable,
    depthTexture: getDepthTexture(),
  });

  // Capture structural state at creation time so the live-update path can detect
  // when a full recreate is needed (e.g. WebGPU shader recompilation).
  creationSnapshot = {
    forceFieldCount: activeConfig.forceFields?.length ?? 0,
    collisionPlaneCount: activeConfig.collisionPlanes?.length ?? 0,
    colorOverLifetimeActive: !!activeConfig.colorOverLifetime?.isActive,
    opacityOverLifetimeActive: !!activeConfig.opacityOverLifetime?.isActive,
    sizeOverLifetimeActive: !!activeConfig.sizeOverLifetime?.isActive,
    rotationOverLifetimeActive: !!activeConfig.rotationOverLifetime?.isActive,
    noiseActive: !!activeConfig.noise?.isActive,
  };

  // Update backend indicator badge
  if (backendBadge) {
    const isGPU = !!particleSystem.computeNode;
    backendBadge.textContent = isGPU ? 'GPU' : 'CPU';
    backendBadge.style.background = isGPU ? '#2e7d32' : '#555';
  }

  particleSystemContainer.add(particleSystem.instance);
  configEntries.forEach(
    ({ onParticleSystemChange }) => onParticleSystemChange && onParticleSystemChange(particleSystem)
  );

  // Only mark as dirty if not initializing and markAsDirty is true
  if (markAsDirty && !isInitializing) {
    configDirty = true;
  }
};

// Expanded sub-emitter config used while editing (full config for the panel)
let expandedSubEmitterConfig: any = null;

const subEditorDefaults = {
  textureId: TextureId.POINT,
  simulation: {
    movements: MovementSimulations.DISABLED,
    movementSpeed: 1,
    rotation: RotationSimulations.DISABLED,
    rotationSpeed: 1,
  },
  showLocalAxes: false,
  showWorldAxes: false,
  showShape: false,
  showForceFields: false,
  showCollisionPlanes: false,
  showColorSourceDebug: false,
  frustumCulled: true,
  useIndividualUpdate: false,
  useLiveUpdate: false,
  enableBigNumbers: false,
  terrain: { textureId: TextureId.WIREFRAME },
  gradientStops: [
    { position: 0, color: { r: 255, g: 255, b: 255, a: 255 } },
    { position: 1, color: { r: 255, g: 255, b: 255, a: 0 } },
  ],
};

const deepMerge = (target: any, source: any): any => {
  Object.keys(source).forEach((key) => {
    if (
      typeof source[key] === 'object' &&
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  });
  return target;
};

const expandSubEmitterConfig = (minimalConfig: any): any => {
  // Start with a full default config (JSON clone — no THREE objects)
  const fullConfig = JSON.parse(JSON.stringify(getDefaultParticleSystemConfig()));
  // Deep merge the minimal (diff) config on top
  Object.keys(minimalConfig).forEach((key) => {
    if (key === '_editorData') return; // handled separately
    if (
      typeof minimalConfig[key] === 'object' &&
      minimalConfig[key] !== null &&
      !Array.isArray(minimalConfig[key]) &&
      typeof fullConfig[key] === 'object' &&
      fullConfig[key] !== null
    ) {
      deepMerge(fullConfig[key], minimalConfig[key]);
    } else {
      fullConfig[key] = minimalConfig[key];
    }
  });
  // Ensure _editorData
  const editorData = { ...subEditorDefaults };
  if (minimalConfig._editorData) {
    Object.keys(minimalConfig._editorData).forEach((key) => {
      if (minimalConfig._editorData[key] !== undefined) {
        editorData[key] = minimalConfig._editorData[key];
      }
    });
  }
  fullConfig._editorData = editorData;
  return fullConfig;
};

const collapseSubEmitterConfig = (fullConfig: any): any => {
  // Convert expanded config back to minimal diff form
  const defaultConfig = JSON.parse(JSON.stringify(getDefaultParticleSystemConfig()));
  const diff = getObjectDiff(defaultConfig, fullConfig, {
    skippedProperties: ['map', 'geometry', 'depthTexture'],
  });
  // Always keep _editorData
  if (fullConfig._editorData) {
    diff._editorData = { ...fullConfig._editorData };
  }
  return diff;
};

const switchToSubEmitter = (index: number): void => {
  const activeConfig = getActiveConfig();
  if (!activeConfig.subEmitters || !activeConfig.subEmitters[index]) return;

  // Push current level onto the stack (save the live config object for this level)
  editorContextStack.push({
    subEmitterIndex: index,
    parentConfig: activeConfig,
    expandedConfig: activeConfig,
  });

  editorContext = {
    type: 'subEmitter',
    subEmitterIndex: index,
    parentConfig: activeConfig,
  };

  // Expand the minimal sub-emitter config to a full config for the editor panel
  const minimalConfig = activeConfig.subEmitters[index].config;
  expandedSubEmitterConfig = expandSubEmitterConfig(minimalConfig);

  // Rebuild the panel with expanded sub-emitter config
  destroyPanel();
  configEntries.length = 0;
  createPanel(expandedSubEmitterConfig);
  recreateParticleSystem(false);
};

const switchToParent = (): void => {
  if (editorContext.type === 'root' || editorContextStack.length === 0) return;

  // Collapse the expanded config back to minimal diff and save it on the parent
  const currentEntry = editorContextStack[editorContextStack.length - 1];
  if (expandedSubEmitterConfig && currentEntry) {
    currentEntry.parentConfig.subEmitters[currentEntry.subEmitterIndex].config =
      collapseSubEmitterConfig(expandedSubEmitterConfig);
  }

  // Pop from stack and restore previous level
  const poppedEntry = editorContextStack.pop()!;

  if (editorContextStack.length === 0) {
    // Back at root
    expandedSubEmitterConfig = null;
    editorContext = {
      type: 'root',
      subEmitterIndex: null,
      parentConfig: null,
    };
  } else {
    // Back to a parent sub-emitter level — restore the saved expanded config
    const parentEntry = editorContextStack[editorContextStack.length - 1];
    expandedSubEmitterConfig = poppedEntry.expandedConfig;
    editorContext = {
      type: 'subEmitter',
      subEmitterIndex: parentEntry.subEmitterIndex,
      parentConfig: parentEntry.parentConfig,
    };
  }

  // Rebuild the panel with the restored config
  destroyPanel();
  configEntries.length = 0;
  const configToShow =
    editorContextStack.length === 0 ? particleSystemConfig : expandedSubEmitterConfig;

  createPanel(configToShow);
  recreateParticleSystem(false);
};

const destroyPanel = (): void => {
  if (currentPanel) {
    currentPanel.destroy();
    currentPanel = null;
  }
};

const createPanel = (config: any = particleSystemConfig): void => {
  const isSubEmitter = editorContext.type === 'subEmitter';
  const depth = editorContextStack.length;
  const panelTitle = isSubEmitter
    ? `Sub-Emitter ${(editorContext.subEmitterIndex ?? 0) + 1}${depth > 1 ? ` (Level ${depth})` : ''}`
    : 'Particle System Editor';

  const panel = new GUI({
    width: 310,
    title: panelTitle,
    container: document.querySelector('.right-panel'),
  });
  currentPanel = panel;

  // Add "Back to Parent" button when editing a sub-emitter
  if (isSubEmitter) {
    const navObj = { backToParent: switchToParent };
    panel.add(navObj, 'backToParent').name('<< Back to Parent');
  }

  // Mutable controller references for big numbers toggle. Max particles and
  // rate over time are no longer gated by it: a piece here runs in the
  // hundreds of thousands, so those two sliders are always that wide.
  let rateOverDistanceCtrl: any = null;

  const handleBigNumbersToggle = (enabled: boolean): void => {
    const rateMax = enabled ? 100000 : 500;
    const burstMax = enabled ? 100000 : 1000;

    if (rateOverDistanceCtrl) rateOverDistanceCtrl.max(rateMax);
    updateAllBurstCountMax(burstMax);
  };

  configEntries.push(
    createHelperEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      scene,
      particleSystemContainer,
      onBigNumbersToggle: handleBigNumbersToggle,
    })
  );

  // Sub-Emitters section (available at all levels for nested sub-emitters)
  configEntries.push(
    createSubEmitterEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem,
      onEditSubEmitter: switchToSubEmitter,
    })
  );

  configEntries.push(
    createTransformEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem: () => {
        // Transform change not requires a real re creation
        particleSystem.instance.position.copy(config.transform.position);
        particleSystem.instance.rotation.x = THREE.MathUtils.degToRad(config.transform.rotation.x);
        particleSystem.instance.rotation.y = THREE.MathUtils.degToRad(config.transform.rotation.y);
        particleSystem.instance.rotation.z = THREE.MathUtils.degToRad(config.transform.rotation.z);
        particleSystem.instance.scale.copy(config.transform.scale);
      },
    })
  );

  // Live-updatable entries pass liveUpdateKeys so that when useLiveUpdate is enabled,
  // only those top-level config keys are sent to engine.updateConfig().
  // Non-updatable entries (shape, renderer, texture sheet, trail, mesh, sub-emitter)
  // call recreateParticleSystem() without liveUpdateKeys → always full recreate.

  const generalKeys = [
    'duration',
    'looping',
    'startDelay',
    'startLifetime',
    'startSpeed',
    'startSize',
    'startRotation',
    'startColor',
    'startOpacity',
    'gravity',
    'simulationSpace',
  ];
  const generalResult = createGeneralEntries({
    parentFolder: panel,
    particleSystemConfig: config,
    recreateParticleSystem: () => recreateParticleSystem(true, generalKeys),
    forceRecreateParticleSystem: recreateParticleSystem,
  });
  configEntries.push(generalResult);

  const emissionResult = createEmissionEntries({
    parentFolder: panel,
    particleSystemConfig: config,
    recreateParticleSystem: () => recreateParticleSystem(true, ['emission']),
  });
  configEntries.push(emissionResult);
  rateOverDistanceCtrl = emissionResult.rateOverDistanceController;

  // Apply initial big numbers state if loading a config that had it enabled
  if (config._editorData?.enableBigNumbers) {
    handleBigNumbersToggle(true);
  }
  configEntries.push(
    createShapeEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem,
    })
  );
  configEntries.push(
    createVelocityOverLifeTimeEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem,
    })
  );
  configEntries.push(
    createGradientEditorEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem: () =>
        recreateParticleSystem(true, ['colorOverLifetime', 'opacityOverLifetime']),
    })
  );
  configEntries.push(
    createSizeOverLifeTimeEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem: () => recreateParticleSystem(true, ['sizeOverLifetime']),
    })
  );
  configEntries.push(
    createOpacityOverLifeTimeEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem: () => recreateParticleSystem(true, ['sizeOverLifetime']),
    })
  );
  configEntries.push(
    createRotationOverLifeTimeEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem: () => recreateParticleSystem(true, ['rotationOverLifetime']),
    })
  );
  configEntries.push(
    createNoiseEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem: () => recreateParticleSystem(true, ['noise']),
    })
  );
  configEntries.push(
    createParticleColorInstanceEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      // The source's levers are live: the sampler takes them and the
      // particles already out are recoloured, no rebuild. Only the two
      // toggles baked into the kernel (isActive, luminance → noise) rebuild.
      recreateParticleSystem: () => recreateParticleSystem(true, ['particleColorInstance']),
      forceRecreateParticleSystem: recreateParticleSystem,
      scene,
      particleSystemContainer,
    })
  );
  configEntries.push(
    createSourceImageTweakEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem: () => recreateParticleSystem(true, ['particleColorInstance']),
    })
  );
  configEntries.push(
    createTouchEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem,
    })
  );
  configEntries.push(
    createForceFieldEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem: () => recreateParticleSystem(true, ['forceFields']),
      forceRecreateParticleSystem: recreateParticleSystem,
      scene,
    })
  );
  configEntries.push(
    createCollisionPlaneEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem: () => recreateParticleSystem(true, ['collisionPlanes']),
      forceRecreateParticleSystem: recreateParticleSystem,
      scene,
    })
  );
  configEntries.push(
    createTextureSheetAnimationEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem,
    })
  );
  configEntries.push(
    createRendererEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem,
    })
  );
  configEntries.push(
    createTrailEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem,
    })
  );
  configEntries.push(
    createMeshEntries({
      parentFolder: panel,
      particleSystemConfig: config,
      recreateParticleSystem,
    })
  );

  recreateParticleSystem(false);
};

// Type for particle system configuration
type ParticleSystemConfig = Record<string, unknown> & {
  _editorData: EditorData;
};

interface EditorInterface {
  createNew: () => void;
  load: (config: ParticleSystemConfig) => void;
  loadFromClipboard: () => void;
  copyToClipboard: () => void;
  /** The piece as COPY would put it on the clipboard: what a player pastes. */
  serialize: () => string;
  resetCamera: () => void;
  reset: () => void;
  play: () => void;
  pause: () => void;
  updateAssets: () => void;
  setColorInstanceTexture: (textureId?: string) => void;
  getCurrentParticleSystemConfig: () => ParticleSystemConfig;
  updateConfigMetadata: (name?: string) => ConfigMetadata;
  getConfigMetadata: () => ConfigMetadata;
  captureScreenshot: () => void;
  isDirty: () => boolean;
  markDirty: () => void;
  switchToSubEmitter: (index: number) => void;
  switchToParent: () => void;
  getEditorContext: () => EditorContext;
}

declare global {
  interface Window {
    editor: EditorInterface;
  }
}

window.editor = {
  createNew,
  load: (config: ParticleSystemConfig) => {
    // Switch back to root context if editing a sub-emitter
    resetToRoot();
    isInitializing = true;
    loadParticleSystem({
      config,
      particleSystemConfig,
      recreateParticleSystem,
      onLoad: () => {
        // Rebuild the panel so controllers bind to the new config object references
        destroyPanel();
        configEntries.length = 0;
        createPanel();
        configEntries.forEach(({ onReset }) => onReset && onReset());
      },
    });
    isInitializing = false;
    configDirty = false;
  },
  loadFromClipboard: () => {
    // Switch back to root context if editing a sub-emitter
    resetToRoot();
    isInitializing = true;
    loadFromClipboard({
      particleSystemConfig,
      recreateParticleSystem,
      onLoad: () => {
        // Rebuild the panel so controllers bind to the new config object references
        destroyPanel();
        configEntries.length = 0;
        createPanel();
        configEntries.forEach(({ onReset }) => onReset && onReset());
        isInitializing = false;
        configDirty = false;
      },
    });
  },
  copyToClipboard: () => copyToClipboard(particleSystemConfig),
  serialize: () => JSON.stringify(serializeConfig(particleSystemConfig)),
  reset: () => recreateParticleSystem(false),
  resetCamera,
  play: resumeTime,
  pause: pauseTime,
  updateAssets: () =>
    configEntries.forEach(({ onAssetUpdate }) => onAssetUpdate && onAssetUpdate()),
  setColorInstanceTexture: (textureId?: string) => {
    particleSystemConfig._editorData.colorInstanceTextureId = textureId;
    if (!particleSystemConfig.particleColorInstance) {
      particleSystemConfig.particleColorInstance = {
        isActive: false,
        area: { x: 0, z: 0 },
        useAlphaForOpacity: false,
      };
    }
    const texture = textureId ? getTexture(textureId) : null;
    particleSystemConfig.particleColorInstance.map = texture ? (texture as any).map : undefined;
    if (texture) particleSystemConfig.particleColorInstance.isActive = true;
    recreateParticleSystem();
    configEntries.forEach(({ onAssetUpdate }) => onAssetUpdate && onAssetUpdate());
  },
  getCurrentParticleSystemConfig: () => particleSystemConfig,
  updateConfigMetadata: (name?: string) => {
    // Ensure metadata exists
    if (!particleSystemConfig._editorData.metadata) {
      particleSystemConfig._editorData.metadata = {
        name: generateDefaultName(),
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        editorVersion: EDITOR_VERSION,
      };
    }

    // Update modification time and name if provided
    particleSystemConfig._editorData.metadata.modifiedAt = Date.now();
    if (name) {
      particleSystemConfig._editorData.metadata.name = name;
    }

    return particleSystemConfig._editorData.metadata;
  },
  getConfigMetadata: () => {
    // Ensure metadata exists
    if (!particleSystemConfig._editorData.metadata) {
      particleSystemConfig._editorData.metadata = {
        name: 'Untitled',
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        editorVersion: EDITOR_VERSION,
      };
    }

    return particleSystemConfig._editorData.metadata;
  },
  captureScreenshot,
  isDirty: () => configDirty,
  markDirty: () => {
    configDirty = true;
  },
  switchToSubEmitter,
  switchToParent,
  getEditorContext: () => ({ ...editorContext }),
};
