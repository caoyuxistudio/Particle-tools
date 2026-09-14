/**
 * The player: a page that shows a piece and does nothing else.
 *
 * It is the editor's module graph with everything editorial left out — no
 * panels, no grid, no gizmos, no preview box, no Svelte, no lil-gui. One
 * renderer, one scene, the output camera, straight to the canvas. Two ways
 * to get a piece into it:
 *
 * - **Standalone** (the default, `/player/`): paste the JSON the editor's
 *   COPY button produces. Nothing is read from or written to storage, nothing
 *   is listened for; the piece lives in memory until the next paste. This is
 *   the page a phone opens, and the one an app shell wraps.
 * - **Linked** (`/player/?link`, what the editor's display button opens): the
 *   editor pushes every change over a BroadcastChannel, and the last piece is
 *   read from the storage the two share when no editor is awake.
 *
 * Both routes load through the same function the editor's own LOAD uses, so
 * a piece that works in one cannot silently differ in the other.
 */
import * as THREE from 'three';

import { setPlayerSource, setRuntimeMode } from './js/three-particles-editor/runtime-mode';

// Before anything reads it. Everything downstream checks the mode lazily, at
// call time, so this only has to happen before the first call — but putting it
// at the very top removes the question.
setRuntimeMode('player');
const linked = new URLSearchParams(window.location.search).has('link');
setPlayerSource(linked ? 'linked' : 'standalone');

import { updateParticleSystems } from '@newkrok/three-particles';
import { prepareParticleBackend } from './js/three-particles-editor/gpu-support';

import {
  createWorld,
  fitPlayerCanvas,
  getDepthTexture,
  getOutputCamera,
  getScene,
  renderPlayer,
  toggleStats,
  isStatsVisible,
  getDrawingBufferSize,
  getRenderScale,
  getSsrSettings,
  setRenderScale,
  setSsrSettings,
  getAoSettings,
  setAoSettings,
  getRendererDomElement,
} from './js/three-particles-editor/world';
import {
  ensureTexturesLoaded,
  getTexture,
  initAssets,
  loadCustomAssets,
} from './js/three-particles-editor/assets';
import { installPerfHud } from './js/three-particles-editor/perf-hud';
import { installGyroHud } from './js/three-particles-editor/gyro-hud';
import { installTouchInput } from './js/three-particles-editor/touch-input';
import {
  requestParallaxPermission,
  describeParallax,
  getParallaxSettings,
  setParallaxSettings,
  recenterParallax,
  resetGyroscope,
} from './js/three-particles-editor/parallax';
import { ensureVideoTexture, loadVideoTextures } from './js/three-particles-editor/video-textures';
import { buildParticleSystem } from './js/three-particles-editor/particle-factory';
import { loadParticleSystem, serializeConfig } from './js/three-particles-editor/save-and-load';
import {
  getSceneObjects,
  readStoredSceneObjects,
  replaceSceneObjects,
  updateSceneObject,
} from './js/three-particles-editor/scene-objects';
import { applySimulation, resetSimulation } from './js/three-particles-editor/simulation';
import { TextureId } from './js/three-particles-editor/texture-config';
import {
  KEEP_EXISTING,
  PING_INTERVAL_MS,
  PLAYER_CHANNEL,
  readPlayerSnapshot,
  type PlayerMessage,
} from './js/three-particles-editor/player-link';

type CycleData = {
  pauseStartTime: number;
  totalPauseTime: number;
  now: number;
  delta: number;
  elapsed: number;
};

const cycleData: CycleData = { pauseStartTime: 0, totalPauseTime: 0, now: 0, delta: 0, elapsed: 0 };

/**
 * Only `_editorData.textureId` has to be here: the loader keeps whatever
 * `_editorData` it finds and merges the incoming config's over it, so the
 * editor's defaults arrive with the first piece.
 */
const particleSystemConfig: any = {
  _editorData: { textureId: TextureId.POINT },
};

let clock: THREE.Clock;
let particleSystem: any = null;
let particleSystemContainer: THREE.Object3D;
let webGPUAvailable = false;
let lastAspect = 0;
let hasContent = false;
/**
 * Wall-clock instant the editor's clock read zero, derived from the snapshot.
 *
 * The emitter's canned motion is a pure function of elapsed time, so sharing
 * the origin once puts both windows at the same point of the same circle. Null
 * until a snapshot arrives, and then it is never renegotiated — both clocks run
 * off wall time, so they do not drift apart. A pasted piece starts from zero.
 */
let simulationOrigin: number | null = null;
/**
 * When the piece on screen was last replaced, by either route. The stored
 * snapshot is applied only when it is newer than this, so a live push is not
 * applied a second time from storage on the next resume.
 */
let lastAppliedAt = 0;
/** True once a live editor has spoken; retries of the hello stop then. */
let heardEditor = false;

/**
 * Standalone means nothing touches storage. This counts every attempt in
 * this window so the claim can be checked rather than believed.
 */
let storageWrites = 0;
if (!linked) {
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function countingSetItem(key: string, value: string) {
    storageWrites += 1;
    return originalSetItem.call(this, key, value);
  };
}

const status = (): HTMLElement | null => document.querySelector('.player-status');

const showStatus = (text: string): void => {
  const element = status();
  if (!element) return;
  element.textContent = text;
  element.style.display = text ? 'block' : 'none';
};

const pasteButton = (): HTMLElement | null => document.querySelector('.player-paste');
const setPasteVisible = (visible: boolean): void => {
  const button = pasteButton();
  if (button) button.hidden = !visible;
};

// ─── Rebuilding ──────────────────────────────────────────────────────────────

/**
 * The player's whole recreate path.
 *
 * No live-update branch and no throttle: the editor already decided what a
 * change means, and by the time it reaches the wire it has been collapsed into
 * one message. Rebuilding outright is also what keeps this short enough to stay
 * obviously equivalent to the editor's version.
 */
const recreateParticleSystem = (): void => {
  if (particleSystem) {
    particleSystem.dispose();
    particleSystem = null;
    cycleData.totalPauseTime = 0;
  }

  particleSystem = buildParticleSystem(particleSystemConfig, {
    webGPUAvailable,
    depthTexture: getDepthTexture(),
  });
  particleSystemContainer.add(particleSystem.instance);
};

/**
 * Applies a scene without tearing it down when it has not structurally changed.
 *
 * `replaceSceneObjects` unmounts and rebuilds everything, which re-extrudes
 * frame geometry and re-prefilters the panorama — a visible hitch on every
 * dragged slider. Matching ids mean the existing objects can simply be updated,
 * and both the frame's geometry cache and the environment's prefilter cache
 * then do their job.
 */
const applyScene = (incoming: any[]): void => {
  const current = getSceneObjects();

  // An unchanged panorama travels as a sentinel rather than as megabytes of
  // data URL; put back the one already in hand before anything compares them.
  const next = incoming.map((object: any) => {
    if (object.environment?.source !== KEEP_EXISTING) return object;
    const existing: any = current.find((o) => o.id === object.id);
    return {
      ...object,
      environment: { ...object.environment, source: existing?.environment?.source ?? '' },
    };
  });
  const sameShape =
    current.length === next.length &&
    current.every((obj, i) => obj.id === next[i].id && obj.type === next[i].type);

  if (!sameShape) {
    replaceSceneObjects(next);
    return;
  }

  next.forEach((obj) => {
    const before = current.find((o) => o.id === obj.id);
    if (JSON.stringify(before) !== JSON.stringify(obj)) updateSceneObject(obj.id, obj);
  });
};

const noCameraStatus = (): string =>
  getOutputCamera() ? '' : 'This piece has no visible output camera.';

/** The one load path, shared with the editor's LOAD and the paste below. */
const applyConfig = (config: any): void => {
  // The editor's Helper panel does this on load too: a new piece starts from
  // the origin rather than wherever the previous one's motion left the emitter.
  resetSimulation(particleSystemContainer);

  loadParticleSystem({
    config,
    particleSystemConfig,
    recreateParticleSystem,
  });
  hasContent = true;
  showStatus(noCameraStatus());

  // Linked only: a video uploaded after this window opened is on disk but not
  // yet in hand — fetch it by name and build again once it plays. A pasted
  // piece names its video by URL and the loader has already registered it.
  const source = particleSystemConfig._editorData?.colorInstanceTextureId;
  if (linked && source && !getTexture(source)) {
    void ensureVideoTexture(source).then((video) => {
      if (!video || particleSystemConfig._editorData?.colorInstanceTextureId !== source) return;
      if (particleSystemConfig.particleColorInstance)
        particleSystemConfig.particleColorInstance.map = video.map;
      recreateParticleSystem();
    });
  }
};

// ─── Standalone: the paste ───────────────────────────────────────────────────

const looksLikeAPiece = (value: unknown): boolean =>
  !!value &&
  typeof value === 'object' &&
  ('_editorData' in (value as object) ||
    'emission' in (value as object) ||
    'renderer' in (value as object));

/** Waits for the colour source (an embedded image, a URL video) to be in hand. */
const waitForColourSource = async (id: string | undefined, ms = 10000): Promise<boolean> => {
  if (!id) return true;
  const start = performance.now();
  while (performance.now() - start < ms) {
    if ((getTexture(id) as any)?.map) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

/**
 * Takes what was pasted — the text from COPY, or the parsed object — and shows
 * it. Built-in textures the piece names are fetched first (the standalone
 * player loads none up front), embedded ones are registered in memory by the
 * loader, a URL video plays when it can. Resolves to whether a piece arrived.
 */
const importPiece = async (input: string | object): Promise<boolean> => {
  let config: any;
  try {
    config = typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    showStatus('That was not a config. Use COPY in the editor, then paste here.');
    return false;
  }
  if (!looksLikeAPiece(config)) {
    showStatus('That was not a config. Use COPY in the editor, then paste here.');
    return false;
  }

  showStatus('Loading…');
  setPasteVisible(false);
  const editorData = config._editorData ?? {};
  await new Promise<void>((resolve) =>
    ensureTexturesLoaded([editorData.textureId, editorData.colorInstanceTextureId], resolve)
  );
  simulationOrigin = null;
  lastAppliedAt = Date.now();
  applyConfig(config);
  const sourceReady = await waitForColourSource(
    particleSystemConfig._editorData?.colorInstanceTextureId
  );
  showStatus(
    !sourceReady ? 'The colour source did not load; the piece plays without it.' : noCameraStatus()
  );
  if (!sourceReady) setTimeout(() => showStatus(noCameraStatus()), 4000);
  return true;
};

/**
 * The ways a piece gets in: ⌘V / Ctrl+V anywhere, the Paste button (the one
 * gesture iOS allows a clipboard read in), a dropped .json, or `?config=url`
 * for a page that is opened by a machine rather than a person.
 */
const installPasteInputs = (): void => {
  document.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    void importPiece(text);
  });

  const sheet = document.querySelector<HTMLElement>('.player-paste-sheet');
  const textarea = sheet?.querySelector('textarea') ?? null;
  const closeSheet = (): void => {
    if (sheet) sheet.hidden = true;
    if (textarea) textarea.value = '';
  };
  sheet?.querySelector('[data-act="load"]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const text = textarea?.value.trim() ?? '';
    closeSheet();
    if (text) void importPiece(text);
  });
  sheet?.querySelector('[data-act="cancel"]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    closeSheet();
  });

  const readClipboard = (): void => {
    const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
    if (!read) {
      if (sheet) sheet.hidden = false;
      textarea?.focus();
      return;
    }
    read().then(
      (text) => {
        if (text && text.trim()) void importPiece(text);
        else showStatus('The clipboard is empty. Use COPY in the editor first.');
      },
      () => {
        // Refused, or unavailable: a box to paste into does the same job.
        if (sheet) sheet.hidden = false;
        textarea?.focus();
      }
    );
  };
  document.querySelectorAll<HTMLElement>('.player-paste, .player-pastebtn').forEach((button) =>
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      readClipboard();
    })
  );

  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      void file.text().then((text) => importPiece(text));
      return;
    }
    const text = event.dataTransfer?.getData('text/plain');
    if (text) void importPiece(text);
  });

  const url = new URLSearchParams(window.location.search).get('config');
  if (url) {
    showStatus('Loading…');
    fetch(url)
      .then((response) => response.json())
      .then((config) => importPiece(config))
      .catch(() => showStatus('The config at that address could not be loaded.'));
  }
};

// ─── Linked: the stored piece ────────────────────────────────────────────────

/**
 * Shows what the editor last left in storage, if it is newer than what is on
 * screen. This is how a linked display works without a live editor: one
 * opened from the editor on a phone, where the editor's tab froze the moment
 * this one came to the front; or this one waking up after being frozen itself
 * while the editor kept working. The standalone player never reads it.
 */
const applyStoredSnapshot = (): boolean => {
  if (!linked) return false;
  const stored = readPlayerSnapshot();
  if (!stored || stored.savedAt <= lastAppliedAt) return false;
  lastAppliedAt = stored.savedAt;
  // The editor's clock at the time of writing, so the emitter's canned motion
  // continues from where the editor had it rather than from zero.
  simulationOrigin = stored.savedAt - stored.elapsed * 1000;
  applyConfig(stored.config);
  // The scene is persisted separately, by scene-objects.ts, on every change.
  replaceSceneObjects(readStoredSceneObjects());
  showStatus(noCameraStatus());
  return true;
};

// ─── Linked: the wire ────────────────────────────────────────────────────────

const listen = (): void => {
  const channel = new BroadcastChannel(PLAYER_CHANNEL);
  channel.onmessage = (event: MessageEvent<PlayerMessage>) => {
    const message = event.data;
    if (!message) return;

    if (message.type === 'snapshot') {
      heardEditor = true;
      lastAppliedAt = Date.now();
      simulationOrigin = Date.now() - message.elapsed * 1000;
      applyConfig(message.config);
    } else if (message.type === 'particles') {
      heardEditor = true;
      lastAppliedAt = Date.now();
      // No sceneObjects key, so the loader leaves the scene alone — the whole
      // reason the emitter and the scene travel separately.
      applyConfig(message.config);
    } else if (message.type === 'scene') {
      applyScene(message.objects);
      if (hasContent) showStatus(noCameraStatus());
    } else if (message.type === 'closing') {
      showStatus('The editor closed.');
    } else if (message.type === 'shutdown') {
      // Only works for a window that was opened by script; one opened by hand
      // stays put and says so instead.
      window.close();
      showStatus('Disconnected. Close this window.');
    }
  };

  // The editor cannot know when this page is ready, so the page says so. This
  // is also what a reload does, which is why the editor listens from start-up
  // rather than only after it opened a window itself.
  const hello = () => channel.postMessage({ type: 'hello' } satisfies PlayerMessage);
  hello();
  // Alive, every couple of seconds, so an editor is never left waiting on a
  // display that is gone. Timers keep running in a hidden tab, if slower.
  setInterval(
    () => channel.postMessage({ type: 'ping' } satisfies PlayerMessage),
    PING_INTERVAL_MS
  );

  // No answer within a moment means no editor is awake to give one. Show the
  // stored piece, and keep asking now and then in case one wakes up.
  setTimeout(() => {
    if (!hasContent) applyStoredSnapshot();
  }, 1200);
  const retry = setInterval(() => {
    if (heardEditor) clearInterval(retry);
    else hello();
  }, 5000);

  // Coming back from the background: on a phone the editor kept working while
  // this tab was frozen, and its latest piece is in storage, not on the wire.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    applyStoredSnapshot();
    if (!heardEditor) hello();
  });

  // Stop the editor pushing into a window that is going away.
  window.addEventListener('pagehide', () => {
    channel.postMessage({ type: 'bye' } satisfies PlayerMessage);
  });
};

// ─── Presentation ────────────────────────────────────────────────────────────

/**
 * Fullscreen, the hidden controls, and a cursor that gets out of the way.
 *
 * The window is already chrome-free; fullscreen is for the moment it goes on
 * the actual wall. A tap (or a click) brings the controls up for a few
 * seconds: Full screen, Perf, Gyro, Paste.
 */
const installPresentationControls = (): void => {
  const root = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  const doc = document as Document & {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void> | void;
  };
  const canFullscreen = !!(root.requestFullscreen || root.webkitRequestFullscreen);
  // A Home Screen app already has the whole screen an iPhone will give a page.
  const isHomeScreenApp =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  const toggleFullscreen = (): void => {
    if (!canFullscreen) {
      // iPhone browsers have no element fullscreen; the way to lose the chrome
      // there is the Home Screen — and once there, this is as full as it gets.
      showStatus(
        isHomeScreenApp
          ? 'This is full screen: iOS keeps the status bar for itself.'
          : 'Full screen is not available here — add this page to the Home Screen.'
      );
      setTimeout(() => showStatus(hasContent ? noCameraStatus() : ''), 4000);
      return;
    }
    const active = document.fullscreenElement ?? doc.webkitFullscreenElement;
    if (active) void (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document);
    else void (root.requestFullscreen ?? root.webkitRequestFullscreen)?.call(root);
  };

  document.addEventListener('keydown', (event) => {
    if (event.key === 'f' || event.key === 'F') toggleFullscreen();
    // Linked: the counter is on by default because that window exists to be
    // measured against the editor's. Standalone: off, this is the wall.
    if (event.key === 's' || event.key === 'S') toggleStats();
  });
  // A double tap (or double click) toggles the gyro parallax and says so —
  // the one control worth having without opening a panel. Detected by hand
  // for touch: iOS is not reliable about dblclick, and a double tap that also
  // zoomed would be worse than none (the viewport forbids zoom regardless).
  const toggleGyro = (): void => {
    const next = !getParallaxSettings().enabled;
    setParallaxSettings({ ...getParallaxSettings(), enabled: next });
    if (next) {
      void requestParallaxPermission();
      recenterParallax();
    }
    showStatus(next ? 'Gyro on' : 'Gyro off');
    setTimeout(() => showStatus(hasContent ? noCameraStatus() : ''), 1800);
  };
  debugSurface.toggleGyro = toggleGyro;
  document.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement | null)?.closest('button, .gyro-hud, .perf-hud, textarea'))
      return;
    toggleGyro();
  });
  let lastTap = { at: 0, x: 0, y: 0 };
  const doubleTapped = (event: PointerEvent): boolean => {
    const now = performance.now();
    const isDouble =
      now - lastTap.at < 320 &&
      Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 40;
    lastTap = isDouble ? { at: 0, x: 0, y: 0 } : { at: now, x: event.clientX, y: event.clientY };
    return isDouble;
  };

  const makeButton = (className: string, text: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.className = `player-fullscreen ${className}`.trim();
    button.type = 'button';
    button.textContent = text;
    document.body.appendChild(button);
    return button;
  };
  // No Full screen button where it could do nothing: a Home Screen app on an
  // iPhone. The others move down a slot to fill the gap.
  // iPhone browsers have no element fullscreen (Safari and a Home Screen app
  // alike), so a button there could only apologise. F and a double-click
  // still work where they can.
  const offerFullscreen = canFullscreen;
  const fullscreenButton = offerFullscreen ? makeButton('', 'Full screen') : null;
  const perfButton = makeButton(offerFullscreen ? 'player-perf' : '', 'Perf');
  const gyroButton = makeButton(offerFullscreen ? 'player-gyro' : 'player-perf', 'Gyro');
  const pasteRowButton = linked
    ? null
    : makeButton(offerFullscreen ? 'player-pastebtn' : 'player-gyro', 'Paste');
  const controls = [fullscreenButton, perfButton, gyroButton, pasteRowButton].filter(
    (b): b is HTMLButtonElement => !!b
  );

  let buttonTimer: ReturnType<typeof setTimeout> | null = null;
  const showControls = (): void => {
    controls.forEach((b) => b.classList.add('is-visible'));
    if (buttonTimer) clearTimeout(buttonTimer);
    buttonTimer = setTimeout(() => controls.forEach((b) => b.classList.remove('is-visible')), 3000);
  };
  document.addEventListener('pointerup', (event) => {
    // A tap is the one moment iOS lets the gyroscope be asked for.
    if (event.pointerType === 'touch') void requestParallaxPermission();
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, .gyro-hud, .perf-hud, .player-paste-sheet, textarea')) return;
    if (event.pointerType === 'touch' && doubleTapped(event)) {
      toggleGyro();
      return;
    }
    showControls();
  });
  fullscreenButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFullscreen();
    fullscreenButton.classList.remove('is-visible');
  });

  // The performance HUD — the way a phone reports what a frame costs, and
  // tries the levers that change it.
  let particleBudget = 1;
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
      maxParticles: particleSystemConfig.maxParticles ?? 0,
      rateOverTime: particleSystemConfig.emission?.rateOverTime ?? 0,
      budget: particleBudget,
    }),
    setParticleBudget: (factor) => {
      if (!particleSystemConfig.emission) return;
      const baseMax = Math.round(particleSystemConfig.maxParticles / particleBudget);
      const baseRate = particleSystemConfig.emission.rateOverTime / particleBudget;
      particleBudget = factor;
      particleSystemConfig.maxParticles = Math.round(baseMax * factor);
      particleSystemConfig.emission.rateOverTime = baseRate * factor;
      recreateParticleSystem();
    },
    getVideoReadback: () => {
      const id = particleSystemConfig._editorData?.colorInstanceTextureId;
      const texture: any = id ? getTexture(id) : null;
      return texture?.map?.userData?.colorInstanceReadback ?? null;
    },
    getPieceName: () => particleSystemConfig._editorData?.metadata?.name ?? 'Untitled',
    extra: () => [
      ['mode', linked ? 'linked to the editor' : `standalone, storage writes ${storageWrites}`],
      ['parallax', describeParallax()],
    ],
  });
  (window as any).__perfHud = hud;
  perfButton.addEventListener('click', (event) => {
    event.stopPropagation();
    hud.toggle();
  });

  // The gyro panel: runtime only here — the player does not own the piece.
  const gyroHud = installGyroHud({
    getSettings: getParallaxSettings,
    setSettings: (patch) => setParallaxSettings({ ...getParallaxSettings(), ...patch }),
    resetCamera: recenterParallax,
    resetGyroscope,
  });
  (window as any).__gyroHud = gyroHud;
  gyroButton.addEventListener('click', (event) => {
    event.stopPropagation();
    gyroHud.toggle();
  });

  // Fingers on the picture: samples for the touch wake, whenever the piece allows it.
  const touchCanvas = getRendererDomElement();
  touchCanvas.style.touchAction = 'none';
  const touchInput = installTouchInput(touchCanvas, {
    getSystem: () => particleSystem,
    getConfig: () => particleSystemConfig,
    isEnabled: () => true,
    getCamera: getOutputCamera,
  });
  (window as any).__touch = {
    ...touchInput,
    feed: (sample: any) => particleSystem?.feedTouch?.(sample),
    count: () => particleSystem?.getTouchCount?.() ?? 0,
    clear: () => particleSystem?.clearTouches?.(),
  };

  let idle: ReturnType<typeof setTimeout> | null = null;
  const wake = (): void => {
    document.body.style.cursor = '';
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      document.body.style.cursor = 'none';
    }, 2000);
  };
  document.addEventListener('mousemove', wake);
  wake();
};

// ─── Frame ───────────────────────────────────────────────────────────────────

const animate = (): void => {
  const rawDelta = clock.getDelta();
  cycleData.now = Date.now() - cycleData.totalPauseTime;
  cycleData.delta = rawDelta > 0.1 ? 0.1 : rawDelta;
  cycleData.elapsed = clock.getElapsedTime();

  // The emitter's own canned motion, before the particles are stepped — the
  // order the editor uses, and the one WORLD simulation space depends on, since
  // it decides where a particle is born.
  const simulation = particleSystemConfig._editorData?.simulation;
  if (simulation) {
    // The editor's clock, not this window's — only for the emitter's motion.
    // The particles below keep stepping on the local delta.
    const elapsed =
      simulationOrigin === null ? cycleData.elapsed : (Date.now() - simulationOrigin) / 1000;
    applySimulation(particleSystemContainer, simulation, elapsed);
  }

  updateParticleSystems(cycleData);

  // The frame's shape is the camera's, and the camera can be swapped or
  // re-lensed from the editor at any moment.
  const aspect = getOutputCamera()?.aspect ?? 0;
  if (aspect && aspect !== lastAspect) {
    lastAspect = aspect;
    fitPlayerCanvas();
  }

  const softParticlesEnabled = !!particleSystemConfig.renderer?.softParticles?.enabled;
  renderPlayer(softParticlesEnabled, particleSystemContainer, particleSystem?.computeNode ?? null);

  requestAnimationFrame(animate);
};

const debugSurface: Record<string, any> = {
  ready: false,
  mode: () => (linked ? 'linked' : 'standalone'),
  paste: importPiece,
  serialize: () => serializeConfig(particleSystemConfig),
  getConfig: () => particleSystemConfig,
  getSceneObjects,
  getOutputCamera,
  hasContent: () => hasContent,
  heardEditor: () => heardEditor,
  applyStoredSnapshot,
  hasTexture: (id: string) => !!(getTexture(id) as any)?.map,
  storageWrites: () => storageWrites,
  statsVisible: () => isStatsVisible(),
  getParallax: getParallaxSettings,
  // The emitter's own transform, so the canned motion can be checked from
  // outside without reading pixels.
  getEmitterTransform: () => ({
    position: particleSystemContainer.position.toArray(),
    rotation: particleSystemContainer.rotation.toArray().slice(0, 3),
  }),
};
(window as any).__player = debugSurface;

const start = async (): Promise<void> => {
  clock = new THREE.Clock();

  // WebGPU where it exists; TSL materials over WebGL2 with CPU simulation
  // where it does not (the iOS Simulator, older browsers).
  webGPUAvailable = (await prepareParticleBackend()) === 'webgpu';

  await createWorld('#player-stage');
  fitPlayerCanvas();
  // This is the wall: no frame counter unless asked for (S).
  if (!linked && isStatsVisible()) toggleStats();

  particleSystemContainer = new THREE.Object3D();
  getScene().add(particleSystemContainer);

  installPresentationControls();

  if (linked) {
    // The uploaded textures a config refers to live in localStorage, which a
    // linked window shares with the editor — so they are read here the same
    // way, and the wire never has to carry image data.
    initAssets(() => {
      const customTextures =
        JSON.parse(localStorage.getItem('particle-system-editor/library') || '[]') || [];
      const imageTextures =
        JSON.parse(localStorage.getItem('particle-system-editor/image-textures') || '[]') || [];
      loadCustomAssets({
        textures: [...customTextures, ...imageTextures].map(
          ({ name, url }: { name: string; url: string }) => ({ id: name, url })
        ),
        onComplete: () => {
          void loadVideoTextures().then(() => {
            listen();
            animate();
            debugSurface.ready = true;
          });
        },
      });
    });
    return;
  }

  // Standalone: nothing is fetched until a piece names it, and nothing is
  // read from storage at all. The page is ready the moment the world is.
  installPasteInputs();
  setPasteVisible(true);
  animate();
  debugSurface.ready = true;
};

showStatus(
  linked ? 'Waiting for the editor…' : 'Copy the piece in the editor (COPY), then paste it here.'
);
void start();
