/**
 * The editor's half of the display window.
 *
 * Conceptually a Window node: the piece keeps being edited here, and a second
 * window shows nothing but what the output camera sees, at the frame's own
 * aspect, with no furniture. It is a separate window rather than a tab on
 * purpose — a hidden tab has its animation frames suspended by the browser, so
 * a tab would freeze the moment you looked at it.
 *
 * The two windows are independent instances: separate renderers, separate GPU
 * devices, separate copies of every texture. That costs frame rate on both
 * sides and is the accepted price of seeing the output full size while still
 * holding the sliders.
 */
import {
  PLAYER_CHANNEL,
  playerUrl,
  writePlayerSnapshot,
  PLAYER_WINDOW_NAME,
  KEEP_EXISTING,
  forWire,
  throttleTrailing,
  type PlayerMessage,
  LINK_TIMEOUT_MS,
  LINKED_PLAYER_URL,
} from '@particle-tools/engine/player-link';
import { showInfoSnackbar, showSuccessSnackbar } from '../stores/snackbar-store';
import { togglePresentation } from '@particle-tools/engine/presentation';
import {
  getOutputCamera,
  isPreviewVisible,
  canvasBounds,
  previewRect,
  freeViewportBounds,
  getCanvas,
  isPresenting,
} from '@particle-tools/engine/world';
import { getSceneObjects, watchScene } from '@particle-tools/engine/scene-objects';

/** How long a burst of edits is collapsed before the display is told. */
const PUSH_THROTTLE_MS = 120;

let channel: BroadcastChannel | null = null;
let playerWindow: Window | null = null;
/**
 * A display is listening.
 *
 * Not the same question as "did this editor open a window": the player page can
 * be opened by hand, reloaded, or moved to another screen, and it announces
 * itself either way. Pushes follow this flag, the button follows both.
 */
let linked = false;
/** When the display last said anything; a link goes stale after LINK_TIMEOUT_MS. */
let lastHeardAt = 0;

/**
 * True while a display is known to be there. A display this editor opened is
 * watched through its window handle elsewhere; one opened by hand, or one that
 * died without a `bye`, is known only by its voice — and silence for long
 * enough means it is gone.
 */
const isLinked = (): boolean => {
  if (linked && Date.now() - lastHeardAt > LINK_TIMEOUT_MS) {
    linked = false;
    unwatchScene?.();
    unwatchScene = null;
  }
  return linked;
};
let button: HTMLButtonElement | null = null;
let presentButton: HTMLButtonElement | null = null;
let snapshotSource: (() => { config: any; elapsed: number }) | null = null;
let unwatchScene: (() => void) | null = null;

/**
 * How the link reads the piece, and the clock the emitter's motion runs on.
 * Registered by the editor rather than imported, because both live in the
 * module that imports this one.
 */
export const setSnapshotSource = (fn: () => { config: any; elapsed: number }): void => {
  snapshotSource = fn;
};

export const isPlayerWindowOpen = (): boolean => !!playerWindow && !playerWindow.closed;

const post = (message: PlayerMessage): void => {
  channel?.postMessage(message);
};

/** The whole piece: emitter, scene, camera, reflections. */
const pushSnapshot = (): void => {
  const source = snapshotSource?.();
  if (!source) return;
  const { config, elapsed } = source;
  // A display that just came up has nothing to keep, so the snapshot always
  // carries the panoramas in full — and reseeds what the sentinel refers to.
  sentPanoramas.clear();
  getSceneObjects().forEach((object: any) => {
    if (object.environment?.source) sentPanoramas.set(object.id, object.environment.source);
  });
  post({ type: 'snapshot', config: forWire(config, { withScene: true }), elapsed });
};

const pushParticles = throttleTrailing((): void => {
  if (!isLinked()) return;
  const config = snapshotSource?.().config;
  if (!config) return;
  post({ type: 'particles', config: forWire(config, { withScene: false }) });
}, PUSH_THROTTLE_MS);

/**
 * Whether or not a display is listening: the stored copy is for the one that
 * is not — frozen in a background tab, or not opened yet.
 */
const storeSnapshot = throttleTrailing((): void => {
  const source = snapshotSource?.();
  if (source) writePlayerSnapshot(source.config, source.elapsed);
}, PUSH_THROTTLE_MS);

/** The panorama each object was last seen carrying, keyed by object id. */
const sentPanoramas = new Map<string, string>();

/**
 * Scene objects, with any unchanged panorama replaced by a sentinel.
 *
 * Everything else on a scene object is a number, a string or a short array, so
 * only the environment source is worth this treatment — and it is worth it: it
 * alone can be larger than the rest of the piece put together.
 */
const sceneForWire = (): any[] =>
  getSceneObjects().map((object) => {
    const copy: any = structuredClone(object);
    const source = copy.environment?.source;
    if (!source) return copy;

    if (sentPanoramas.get(copy.id) === source) copy.environment.source = KEEP_EXISTING;
    else sentPanoramas.set(copy.id, source);
    return copy;
  });

const pushScene = throttleTrailing((): void => {
  if (!isLinked()) return;
  post({ type: 'scene', objects: sceneForWire() });
}, PUSH_THROTTLE_MS);

/**
 * Announces an emitter change. Called from the editor's recreate path, which is
 * the one funnel every parameter change already goes through.
 */
export const notifyParticleConfigChanged = (): void => {
  pushParticles();
  storeSnapshot();
};

/**
 * Opened at editor start-up, not when the button is pressed.
 *
 * The display announces itself whenever it comes up — including a reload, or
 * someone opening player.html directly — and an editor that only starts
 * listening when it opened the window itself would miss all of those.
 */
const ensureChannel = (): void => {
  if (channel) return;
  channel = new BroadcastChannel(PLAYER_CHANNEL);
  channel.onmessage = (event: MessageEvent<PlayerMessage>) => {
    const message = event.data;
    if (message?.type === 'ping') {
      lastHeardAt = Date.now();
      // A display that pinged before it said hello (the editor reloaded under
      // it) is still a display.
      if (!linked) {
        linked = true;
        unwatchScene = unwatchScene ?? watchScene(() => pushScene());
      }
    } else if (message?.type === 'hello') {
      linked = true;
      lastHeardAt = Date.now();
      // Anything that touches the scene — a dragged light, a resized frame, an
      // SSR slider — lands in persist(), so one subscription covers the lot.
      unwatchScene = unwatchScene ?? watchScene(() => pushScene());
      pushSnapshot();
    } else if (message?.type === 'bye') {
      linked = false;
    }
  };
};

/**
 * Puts the display's address on the clipboard and says so. Opening the window
 * is the moment someone is most likely to want the link somewhere else — a
 * phone, a second machine — and the clipboard call is only allowed inside the
 * click anyway.
 */
const copyPlayerLink = (): void => {
  const url = playerUrl();
  const say = (copied: boolean) =>
    copied
      ? showSuccessSnackbar(`Player link copied: ${url}`, 5000)
      : showInfoSnackbar(`Player link: ${url}`, 8000);
  if (!navigator.clipboard?.writeText) {
    say(false);
    return;
  }
  navigator.clipboard.writeText(url).then(
    () => say(true),
    () => say(false)
  );
};

export const openPlayerWindow = (): void => {
  ensureChannel();
  copyPlayerLink();
  // Before the window exists: a display that cannot reach a live editor (a
  // phone freezes the tab it came from) reads this instead.
  const source = snapshotSource?.();
  if (source) writePlayerSnapshot(source.config, source.elapsed);

  const aspect = getOutputCamera()?.aspect || 16 / 9;
  const width = Math.min(1280, Math.round(window.screen.availWidth * 0.6));
  const height = Math.round(width / aspect);
  const features = [
    'popup=yes',
    `width=${width}`,
    `height=${height}`,
    `left=${Math.max(0, Math.round((window.screen.availWidth - width) / 2))}`,
    `top=${Math.max(0, Math.round((window.screen.availHeight - height) / 2))}`,
  ].join(',');

  playerWindow = window.open(LINKED_PLAYER_URL, PLAYER_WINDOW_NAME, features);

  // A blocked popup comes back as null and would otherwise look like a dead
  // button. Say so once, where the click happened.
  if (!playerWindow) {
    // eslint-disable-next-line no-alert
    window.alert(
      'The display window was blocked by the browser.\n\n' +
        'Allow pop-ups for this site, or open ' +
        new URL(LINKED_PLAYER_URL, window.location.href).href +
        ' in a second window yourself — it connects on its own.'
    );
    return;
  }

  playerWindow.focus();
};

export const closePlayerWindow = (): void => {
  // A display this editor did not open cannot be closed from here, so it is
  // asked to close itself as well.
  post({ type: 'shutdown' });
  playerWindow?.close();
  playerWindow = null;
  linked = false;
  unwatchScene?.();
  unwatchScene = null;
};

export const togglePlayerWindow = (): void => {
  if (isPlayerWindowOpen() || isLinked()) closePlayerWindow();
  else openPlayerWindow();
};

// ─── The button ──────────────────────────────────────────────────────────────
//
// It sits just outside the preview's left edge, where the preview's own resize
// grip already taught the eye to look for controls. The preview is drawn by the
// renderer into a scissor rectangle rather than being a DOM element, so the
// button is positioned against that rectangle each frame instead of being laid
// out next to it.

const BUTTON_SIZE = 26;
const BUTTON_GAP = 6;

export const installPlayerControls = (): void => {
  if (button) return;

  button = document.createElement('button');
  button.className = 'player-window-toggle material-icons';
  button.title = 'Toggle Full Screen Mode — opens the output camera in its own window';
  button.textContent = 'open_in_new';
  button.style.cssText = [
    'position:fixed',
    'z-index:9',
    `width:${BUTTON_SIZE}px`,
    `height:${BUTTON_SIZE}px`,
    'padding:0',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'border:1px solid #555',
    'border-radius:3px',
    'background:#2b2b2b',
    'color:#ddd',
    'font-size:15px',
    'line-height:1',
    'cursor:pointer',
  ].join(';');

  ensureChannel();

  button.addEventListener('click', (event) => {
    event.preventDefault();
    togglePlayerWindow();
    // Closing the display un-suspends the editor, so the overlay has to be told
    // in the same breath as the button rather than a frame later.
    syncPlayerControls();
  });

  document.body.appendChild(button);

  // Below it: the same picture in *this* window. On a phone that is the only
  // way to get it — a second tab freezes the first — and on a desk it is the
  // quick look without the second device.
  presentButton = document.createElement('button');
  presentButton.className = 'presentation-toggle material-icons';
  presentButton.title =
    'Full screen here — this window becomes the display. Esc or tap to come back.';
  presentButton.textContent = 'fullscreen';
  presentButton.style.cssText = button.style.cssText;
  presentButton.addEventListener('click', (event) => {
    event.preventDefault();
    togglePresentation();
  });
  document.body.appendChild(presentButton);
  installOverlay();
};

/**
 * Keeps the button pinned to the preview and showing the right state.
 *
 * Called once a frame: the preview moves whenever a panel collapses or the
 * output frame changes shape, and the window can be closed from its own title
 * bar without telling anyone.
 */
const syncButton = (): void => {
  if (!button) return;
  // Both live at the preview's edge, and there is no preview while presenting.
  if (isPresenting()) {
    button.style.display = 'none';
    if (presentButton) presentButton.style.display = 'none';
    return;
  }

  const visible = !!getOutputCamera() && isPreviewVisible();
  if (!visible) {
    button.style.display = 'none';
    if (presentButton) presentButton.style.display = 'none';
    return;
  }

  const canvas = canvasBounds();
  const { x, y } = previewRect();
  button.style.display = 'flex';
  button.style.left = `${Math.round(canvas.left + x - BUTTON_SIZE - BUTTON_GAP)}px`;
  button.style.top = `${Math.round(canvas.top + y)}px`;
  if (presentButton) {
    presentButton.style.display = 'flex';
    presentButton.style.left = button.style.left;
    presentButton.style.top = `${Math.round(canvas.top + y + BUTTON_SIZE + BUTTON_GAP)}px`;
  }

  const open = isPlayerWindowOpen() || isLinked();
  button.textContent = open ? 'close_fullscreen' : 'open_in_new';
  button.style.background = open ? '#b34a2c' : '#2b2b2b';
  button.style.color = open ? '#fff' : '#ddd';
  button.style.borderColor = open ? '#b34a2c' : '#555';

  // A window this editor opened can be closed from its own title bar without
  // saying anything, so its absence is noticed here rather than announced.
  //
  // `linked` goes with it. Its `bye` fires on pagehide and normally arrives
  // first, but if it does not, a stale flag would have the editor suspending
  // itself for a display that is no longer there. Only a window this editor
  // owns lands here — one opened by hand leaves `playerWindow` null, so its
  // link is not cleared behind its back.
  if (playerWindow?.closed) {
    playerWindow = null;
    linked = false;
    unwatchScene?.();
    unwatchScene = null;
  }
};

// ─── Suspending the editor ───────────────────────────────────────────────────
//
// Two windows means two WebGPU devices drawing the same piece at once, and the
// editor's frame is the more expensive of the two: a depth pass, the viewport,
// then the preview — which runs the whole reflection pipeline a second time
// into its own target. None of that is worth drawing while you are looking at
// the display, so the editor stops drawing whenever it is not the focused
// window.
//
// It stops *drawing*, not working. The panels are DOM and stay live above the
// overlay, and a parameter change reaches the display through persist() rather
// than through the frame loop — so a suspended editor is still a control
// surface, which is the shape this is meant to take: sliders here, picture
// there.

/**
 * The rule, as a function of its two inputs.
 *
 * Split out because a headless page can never lose focus for real, so the only
 * way to assert the rule is to hand it its inputs.
 */
export const shouldSuspendEditor = (playerOpen: boolean, editorFocused: boolean): boolean =>
  playerOpen && !editorFocused;

/** Debug seam: lets the harness drive the focus input. Null means ask the DOM. */
let focusOverride: boolean | null = null;

export const setFocusOverride = (value: boolean | null): void => {
  focusOverride = value;
};

export const isEditorSuspended = (): boolean =>
  // A presenting editor *is* the display; there is nothing to yield to.
  !isPresenting() &&
  shouldSuspendEditor(isPlayerWindowOpen() || isLinked(), focusOverride ?? document.hasFocus());

/**
 * Above the canvas, under every panel.
 *
 * The panels are the reason there is no full-window scrim: a suspended editor
 * is still a control surface, and dimming lil-gui along with the picture would
 * be dimming the half that still works. The canvas is dimmed directly instead,
 * which reaches exactly the thing that stopped moving and leaves every panel,
 * the header and the example list at full strength — no stacking to get right,
 * because nothing is covering them.
 */
const CARD_Z = 5;
const DIMMED = 'brightness(0.32) saturate(0.55)';

let card: HTMLButtonElement | null = null;
let editorStats: HTMLElement | null = null;

const installOverlay = (): void => {
  card = document.createElement('button');
  card.className = 'player-suspend-card';
  card.style.cssText = [
    'position:fixed',
    `z-index:${CARD_Z}`,
    'display:none',
    'transform:translate(-50%,-50%)',
    'flex-direction:column',
    'align-items:center',
    'gap:5px',
    'padding:18px 26px',
    'border:1px solid #555',
    'border-radius:4px',
    'background:#1c1c1e',
    'color:#eee',
    'font:400 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'cursor:pointer',
  ].join(';');

  const title = document.createElement('span');
  title.style.cssText = 'font-size:14px;font-weight:600;letter-spacing:0.2px';
  title.textContent = 'Move to Player View';

  const hint = document.createElement('span');
  hint.style.cssText = 'color:#8a8a8e;font-size:11px;text-align:center';
  hint.textContent = 'Rendering paused — the GPU is going to the display window.';

  const back = document.createElement('span');
  back.style.cssText = 'color:#8a8a8e;font-size:11px;text-align:center';
  back.textContent = 'Panels still work. Click the viewport to resume drawing.';

  card.append(title, hint, back);
  card.addEventListener('click', () => {
    playerWindow?.focus();
  });

  document.body.appendChild(card);
};

const syncOverlay = (): void => {
  if (!card) return;

  editorStats = editorStats ?? document.querySelector('.stats');

  if (!isEditorSuspended()) {
    card.style.display = 'none';
    getCanvas().style.filter = '';
    if (editorStats) editorStats.style.opacity = '';
    return;
  }

  card.style.display = 'flex';
  getCanvas().style.filter = DIMMED;
  // The editor's own counter freezes with the frame loop. Left at full
  // strength it reads as a live number that happens to say 60.
  if (editorStats) editorStats.style.opacity = '0.25';

  const canvas = canvasBounds();
  const free = freeViewportBounds();
  card.style.left = `${Math.round(canvas.left + (free.left + free.right) / 2)}px`;
  card.style.top = `${Math.round(canvas.top + canvas.height / 2)}px`;
};

/** Both controls, once a frame — before the loop decides whether to draw. */
export const syncPlayerControls = (): void => {
  syncButton();
  syncOverlay();
};
