/**
 * Video as a colour source.
 *
 * The particle library samples `particleColorInstance.map` on the CPU when a
 * particle is born, so a video source never has to become a GPU texture at
 * all: the browser decodes it in hardware, the library reads a small grid of
 * pixels back whenever a new frame lands, and that is the whole cost. What
 * this module owns is everything around that — where the file lives, how it
 * becomes a playing element, and how both windows find it by name.
 *
 * Storage is split the way the sizes demand. Metadata (name, duration, a
 * thumbnail) goes to localStorage beside the image list, so the Textures panel,
 * the selector and the player all read it the same way. The bytes go to
 * IndexedDB: a minute of H.264 is tens of megabytes, which no data URL in
 * localStorage could hold, and IndexedDB is shared by the same origin, so the
 * player window opens the same blob without anything crossing the wire.
 *
 * A source can also be a URL. Nothing is stored then but the address, which is
 * what a config carries when it travels — the day the player is a standalone
 * page, a pasted config with a video URL in it just plays.
 */
import * as THREE from 'three';

import { textureConfigs } from './texture-config';
import { isStandalone } from './runtime-mode';

export const VIDEO_TEXTURES_KEY = 'particle-system-editor/video-textures';

const DB_NAME = 'three-particles-editor';
const DB_STORE = 'videos';

export type VideoTextureEntry = {
  id: number;
  name: string;
  /** Where the bytes are: our own IndexedDB, or somewhere on the network. */
  source: 'local' | 'url';
  url?: string;
  /** A small WebP of the first frame, for lists and pickers. */
  thumbnail?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  addedAt: number;
};

/** What `getTexture(name)` hands back for a video, on top of the shared shape. */
export type RegisteredVideo = {
  id: string;
  url: string;
  kind: 'video';
  map: THREE.VideoTexture;
  video: HTMLVideoElement;
  entry: VideoTextureEntry;
};

// ─── The list ────────────────────────────────────────────────────────────────

/**
 * A standalone player's list lives here instead of in localStorage: the
 * loader registers the URL videos a pasted piece names exactly as it would
 * in the editor, and nothing reaches the origin's storage.
 */
let memoryEntries: VideoTextureEntry[] = [];

export const readVideoEntries = (): VideoTextureEntry[] => {
  if (isStandalone()) return [...memoryEntries];
  try {
    const parsed = JSON.parse(localStorage.getItem(VIDEO_TEXTURES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** Fired on `window` whenever the list changes, so panels can re-read it. */
export const VIDEO_TEXTURES_CHANGED = 'video-textures-changed';

export const writeVideoEntries = (entries: VideoTextureEntry[]): void => {
  if (isStandalone()) {
    memoryEntries = [...entries];
    return;
  }
  localStorage.setItem(VIDEO_TEXTURES_KEY, JSON.stringify(entries));
  // The Textures panel keeps its own copy of this list. Writes come from the
  // panel itself, from a config load, from the harness — the panel cannot know
  // which, so it is told every time rather than left showing a card for a
  // video that is already gone.
  window.dispatchEvent(new CustomEvent(VIDEO_TEXTURES_CHANGED));
};

export const findVideoEntry = (name: string): VideoTextureEntry | undefined =>
  readVideoEntries().find((entry) => entry.name === name);

// ─── The bytes ───────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE))
          request.result.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
};

const withStore = async <T>(
  mode: 'readonly' | 'readwrite',
  run: (objectStore: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const request = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const putVideoBlob = (name: string, blob: Blob): Promise<unknown> =>
  withStore('readwrite', (store) => store.put(blob, name));

export const getVideoBlob = (name: string): Promise<Blob | undefined> =>
  withStore<Blob | undefined>('readonly', (store) => store.get(name));

export const deleteVideoBlob = (name: string): Promise<undefined> =>
  withStore('readwrite', (store) => store.delete(name));

// ─── The element ─────────────────────────────────────────────────────────────

const registered = new Map<string, RegisteredVideo>();
const objectUrls = new Map<string, string>();
/** Mirrors the editor's suspension, so a video registered meanwhile starts paused too. */
let sourcesPaused = false;

/**
 * Where the video elements live. Kept in the document, and kept *renderable*:
 * a video removed from the document is paused by the browser, and a video that
 * is `display:none` never presents a frame, so `requestVideoFrameCallback` —
 * which is how the library learns a new frame exists — never fires for it.
 * Two pixels behind everything else is invisible in every way that matters.
 */
const holder = (): HTMLElement => {
  let element = document.querySelector<HTMLElement>('.video-sources');
  if (!element) {
    element = document.createElement('div');
    element.className = 'video-sources';
    element.style.cssText =
      'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;' +
      'opacity:0.01;pointer-events:none;z-index:-1;';
    document.body.appendChild(element);
  }
  return element;
};

const createElement = (src: string, crossOrigin: boolean): HTMLVideoElement => {
  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.disableRemotePlayback = true;
  video.style.cssText = 'width:2px;height:2px;';
  // The readback draws the element onto a canvas; a cross-origin source that
  // does not opt in would taint it and the library would give up on the video.
  if (crossOrigin) video.crossOrigin = 'anonymous';
  video.src = src;
  return video;
};

const waitForMetadata = (video: HTMLVideoElement): Promise<void> =>
  new Promise((resolve, reject) => {
    if (video.readyState >= 1) return resolve();
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(video.error ?? new Error('video failed')), {
      once: true,
    });
  });

const waitForFrame = (video: HTMLVideoElement): Promise<void> =>
  new Promise((resolve) => {
    if (video.readyState >= 2) return resolve();
    video.addEventListener('loadeddata', () => resolve(), { once: true });
  });

/**
 * A muted video is allowed to start on its own; if a browser still refuses,
 * the first click anywhere is the gesture it wants.
 */
const startPlayback = (video: HTMLVideoElement): void => {
  video.play().catch(() => {
    const retry = () => {
      video.play().catch(() => undefined);
    };
    document.addEventListener('pointerdown', retry, { once: true });
    document.addEventListener('keydown', retry, { once: true });
  });
};

const resolveSrc = async (entry: VideoTextureEntry): Promise<string | null> => {
  if (entry.source === 'url') return entry.url ?? null;
  const known = objectUrls.get(entry.name);
  if (known) return known;
  const blob = await getVideoBlob(entry.name);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  objectUrls.set(entry.name, url);
  return url;
};

/**
 * Makes an entry playable and known to `getTexture`. Resolves once the
 * element has its first frame — the moment the library can read from it.
 */
export const registerVideoTexture = async (
  entry: VideoTextureEntry
): Promise<RegisteredVideo | null> => {
  const existing = registered.get(entry.name);
  if (existing) return existing;

  const src = await resolveSrc(entry);
  if (!src) return null;

  const video = createElement(src, entry.source === 'url');
  holder().appendChild(video);
  try {
    await waitForMetadata(video);
  } catch {
    video.remove();
    return null;
  }
  // The first frame decodes without playing (preload=auto), which is all the
  // thumbnail and the library's first readback need.
  if (!sourcesPaused) startPlayback(video);
  await waitForFrame(video);

  const map = new THREE.VideoTexture(video);
  map.colorSpace = THREE.SRGBColorSpace;
  map.flipY = false;

  const record: RegisteredVideo = {
    id: entry.name,
    url: entry.thumbnail ?? '',
    kind: 'video',
    map,
    video,
    entry,
  };
  registered.set(entry.name, record);
  textureConfigs.push(record as any);
  return record;
};

const unregisterVideoTexture = (name: string): void => {
  const record = registered.get(name);
  if (!record) return;
  registered.delete(name);
  const index = textureConfigs.findIndex((config) => config.id === name);
  if (index >= 0) textureConfigs.splice(index, 1);
  record.map.dispose();
  record.video.pause();
  record.video.removeAttribute('src');
  record.video.load();
  record.video.remove();
  const objectUrl = objectUrls.get(name);
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrls.delete(name);
  }
};

/** Every stored video, made playable. Failures are skipped, not fatal. */
export const loadVideoTextures = async (): Promise<void> => {
  await Promise.all(
    readVideoEntries().map((entry) =>
      registerVideoTexture(entry).catch((error) => {
        console.warn(`Failed to load video "${entry.name}" - skipping it.`, error);
        return null;
      })
    )
  );
};

/**
 * Finds a video the current window has not registered yet — the player, when
 * the editor starts using a video that was uploaded after the player opened.
 */
export const ensureVideoTexture = async (name: string): Promise<RegisteredVideo | null> => {
  const known = registered.get(name);
  if (known) return known;
  const entry = findVideoEntry(name);
  return entry ? registerVideoTexture(entry) : null;
};

/**
 * Decoding a video nobody is sampling is the one cost a suspended editor
 * could still be paying; this is how it stops.
 */
export const setVideoSourcesPaused = (paused: boolean): void => {
  sourcesPaused = paused;
  registered.forEach(({ video }) => {
    if (paused) video.pause();
    else if (video.paused) startPlayback(video);
  });
};

// ─── Adding and removing ─────────────────────────────────────────────────────

const THUMBNAIL_EDGE = 192;

const captureThumbnail = (video: HTMLVideoElement): string | undefined => {
  try {
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const encoded = canvas.toDataURL('image/webp', 0.8);
    return encoded.startsWith('data:image/webp') ? encoded : undefined;
  } catch {
    return undefined;
  }
};

const freshName = (): string =>
  `VideoTexture-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const persistEntry = (entry: VideoTextureEntry): boolean => {
  const entries = readVideoEntries();
  entries.unshift(entry);
  try {
    writeVideoEntries(entries);
    return true;
  } catch {
    return false;
  }
};

/** Fills in what only a decoded element knows, then persists the entry. */
const finishEntry = (entry: VideoTextureEntry, record: RegisteredVideo): void => {
  entry.width = record.video.videoWidth;
  entry.height = record.video.videoHeight;
  entry.duration = record.video.duration;
  entry.thumbnail = captureThumbnail(record.video);
  record.url = entry.thumbnail ?? '';
  const entries = readVideoEntries();
  const index = entries.findIndex((e) => e.id === entry.id);
  if (index >= 0) entries[index] = entry;
  else entries.unshift(entry);
  try {
    writeVideoEntries(entries);
  } catch {
    /* the bytes are safe in IndexedDB; only the thumbnail is lost */
  }
};

/**
 * Stores an uploaded file and makes it playable. Throws when the bytes cannot
 * be stored or the file is not a video the browser can decode.
 */
export const addVideoFile = async (file: Blob): Promise<VideoTextureEntry> => {
  const entry: VideoTextureEntry = {
    id: Math.floor(Math.random() * 100000000),
    name: freshName(),
    source: 'local',
    size: file.size,
    addedAt: Date.now(),
  };
  await putVideoBlob(entry.name, file);
  if (!persistEntry(entry)) {
    await deleteVideoBlob(entry.name);
    throw new Error('Not enough browser storage left for the video list.');
  }
  const record = await registerVideoTexture(entry);
  if (!record) {
    await removeVideo(entry.id);
    throw new Error('The browser could not decode this video.');
  }
  finishEntry(entry, record);
  return entry;
};

/** Registers a video by address. Nothing is stored but the entry itself. */
export const addVideoUrl = async (url: string): Promise<VideoTextureEntry> => {
  const entry: VideoTextureEntry = {
    id: Math.floor(Math.random() * 100000000),
    name: freshName(),
    source: 'url',
    url,
    addedAt: Date.now(),
  };
  if (!persistEntry(entry)) throw new Error('Not enough browser storage left for the video list.');
  const record = await registerVideoTexture(entry);
  if (!record) {
    await removeVideo(entry.id);
    throw new Error('The video at that address could not be loaded.');
  }
  finishEntry(entry, record);
  return entry;
};

/**
 * A URL video named by a loaded config, under the name the config uses so its
 * reference resolves. What the config knew about it is kept until the element
 * can say for itself.
 */
export const importVideoEntry = async (
  name: string,
  info: { url: string; width?: number; height?: number; duration?: number }
): Promise<RegisteredVideo | null> => {
  const entry: VideoTextureEntry = {
    id: Math.floor(Math.random() * 100000000),
    name,
    source: 'url',
    url: info.url,
    width: info.width,
    height: info.height,
    duration: info.duration,
    addedAt: Date.now(),
  };
  if (!persistEntry(entry)) return null;
  const record = await registerVideoTexture(entry).catch(() => null);
  if (!record) {
    writeVideoEntries(readVideoEntries().filter((e) => e.id !== entry.id));
    return null;
  }
  finishEntry(entry, record);
  return record;
};

export const removeVideo = async (id: number): Promise<VideoTextureEntry | undefined> => {
  const entries = readVideoEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return undefined;
  unregisterVideoTexture(entry.name);
  writeVideoEntries(entries.filter((e) => e.id !== id));
  if (entry.source === 'local') await deleteVideoBlob(entry.name).catch(() => undefined);
  return entry;
};

/** Renames in the list, the registry and IndexedDB, so the name stays the key everywhere. */
export const renameVideo = async (id: number, name: string): Promise<void> => {
  const entries = readVideoEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.name === name || !name) return;
  const oldName = entry.name;

  if (entry.source === 'local') {
    const blob = await getVideoBlob(oldName);
    if (blob) {
      await putVideoBlob(name, blob);
      await deleteVideoBlob(oldName);
    }
  }
  const objectUrl = objectUrls.get(oldName);
  if (objectUrl) {
    objectUrls.delete(oldName);
    objectUrls.set(name, objectUrl);
  }
  const record = registered.get(oldName);
  if (record) {
    registered.delete(oldName);
    record.id = name;
    record.entry = entry;
    registered.set(name, record);
  }
  entry.name = name;
  writeVideoEntries(entries);
};
