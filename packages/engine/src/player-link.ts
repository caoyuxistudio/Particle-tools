/**
 * The wire between the editor and the display window.
 *
 * Both windows are the same app on the same origin, so they can talk over a
 * BroadcastChannel — structured clone, no size ceiling worth worrying about,
 * and no dependency on the opener reference surviving.
 *
 * What travels is plain config data, never THREE objects. Textures are the one
 * thing deliberately left out: uploaded images live in localStorage, which the
 * player already shares, so re-sending the data URLs would double every message
 * for nothing. Videos go one step further — their bytes are in IndexedDB, also
 * shared — and only their name travels; the player fetches a name it does not
 * know by itself. The day the player becomes a standalone site on its own
 * origin, `embeddedTextures` goes back into the snapshot and nothing else
 * changes (a video would have to be a URL by then; see `embeddedVideos`).
 */
export const PLAYER_CHANNEL = 'three-particles-player';

/** Named so a second toggle re-focuses the window instead of opening another. */
export const PLAYER_WINDOW_NAME = 'three-particles-player';

/** The standalone player: opens empty and takes a pasted piece. */
export const PLAYER_URL = 'player/';
/** The same page linked to this editor over the channel (the display window). */
export const LINKED_PLAYER_URL = 'player/?link';

/** The standalone player's address, absolute, as a person would paste it elsewhere. */
export const playerUrl = (): string => new URL(PLAYER_URL, window.location.href).href;

/**
 * The editor's latest piece, kept where a display can find it without the
 * editor being awake.
 *
 * The channel needs both pages running at the same moment, and on a phone
 * that is exactly what does not happen: a tab in the background is frozen, so
 * a display opened from the editor comes up to an editor that can no longer
 * answer its hello. The editor therefore also leaves its latest emitter here
 * on every push — the scene is already persisted by scene-objects.ts — and a
 * display that hears nothing, or that wakes up again, reads it back. The same
 * thing makes a pasted link show the last piece even with the editor closed.
 */
export const SNAPSHOT_KEY = 'particle-system-editor/player-snapshot';

export type StoredSnapshot = {
  config: any;
  /** The editor's clock when this was written; see `snapshot.elapsed`. */
  elapsed: number;
  savedAt: number;
};

export const writePlayerSnapshot = (config: any, elapsed: number): void => {
  try {
    const stored: StoredSnapshot = {
      config: forWire(config, { withScene: false }),
      elapsed,
      savedAt: Date.now(),
    };
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(stored));
  } catch {
    /* quota — the live channel still works */
  }
};

export const readPlayerSnapshot = (): StoredSnapshot | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null');
    return parsed && typeof parsed === 'object' && parsed.config ? parsed : null;
  } catch {
    return null;
  }
};

export type PlayerMessage =
  /** Player → editor: I am up, send me everything. */
  | { type: 'hello' }
  /**
   * Editor → player: the whole piece — emitter, scene, camera.
   *
   * `elapsed` is the editor's clock at the moment of sending. The emitter's
   * canned motion is a pure function of it, so handing it over once lets the
   * display put the emitter at the same point of its circle rather than
   * somewhere else on the same circle. Only that motion is synchronised: the
   * particles themselves are simulated independently on each side and always
   * will be.
   */
  | { type: 'snapshot'; config: any; elapsed: number }
  /** Editor → player: the emitter changed; the scene is untouched. */
  | { type: 'particles'; config: any }
  /** Editor → player: the scene changed; the emitter is untouched. */
  | { type: 'scene'; objects: any[] }
  /** Editor → player: the editor is going away. */
  | { type: 'closing' }
  /** Editor → player: close yourself. */
  | { type: 'shutdown' }
  /** Player → editor: I am going away; stop pushing. */
  | { type: 'bye' }
  /**
   * Player → editor: still here. A display that vanishes without its `bye` —
   * a tab killed outright, a crashed page — would otherwise leave the editor
   * suspended for good; the editor drops a link that has gone quiet.
   */
  | { type: 'ping' };

/** How often a display says it is alive, and how long silence means it is not. */
export const PING_INTERVAL_MS = 2000;
export const LINK_TIMEOUT_MS = 6000;

/**
 * Stands in for a panorama the display already has.
 *
 * A scene message goes out on every committed change, and an environment's
 * source is a data URL that can run to several megabytes — re-cloning it
 * through the channel eight times a second while a slider moves is a cost with
 * no benefit, since the pixels cannot have changed without the source changing
 * with them.
 */
export const KEEP_EXISTING = '\u0000keep-existing';

/**
 * Strips what must not travel: the texture payloads (see above), anything that
 * is not plain data, and — for emitter-only pushes — the scene, which has its
 * own message and its own incremental apply on the far side.
 *
 * The JSON round trip is the point, not laziness. A live config carries
 * THREE objects and the entries' own recreate callbacks, none of which survive
 * a structured clone; going through JSON drops exactly what a save drops, so
 * what the display receives is what a saved file would have contained.
 */
export const forWire = (config: any, { withScene }: { withScene: boolean }): any => {
  const editorData = { ...(config._editorData ?? {}) };
  delete editorData.embeddedTextures;
  if (!withScene) delete editorData.sceneObjects;

  return JSON.parse(
    JSON.stringify({ ...config, _editorData: editorData }, (_key, value) => {
      if (typeof value === 'function') return undefined;
      if (value?.isTexture || value?.isBufferGeometry || value?.isMaterial) return undefined;
      return value;
    })
  );
};

/**
 * Trailing throttle.
 *
 * Every push is a full config, and a slider drag fires dozens per second. The
 * trailing edge is the one that matters — it carries the value the user landed
 * on — so intermediate pushes are dropped rather than queued.
 */
export const throttleTrailing = <T extends unknown[]>(
  fn: (...args: T) => void,
  ms: number
): ((...args: T) => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: T | null = null;

  return (...args: T) => {
    latest = args;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (latest) fn(...latest);
      latest = null;
    }, ms);
  };
};
