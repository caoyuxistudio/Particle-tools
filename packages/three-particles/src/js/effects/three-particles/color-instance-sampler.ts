/**
 * The colour-instance sampler: turns the `particleColorInstance` map into a
 * grid of sRGB pixels that emission can read with one array lookup.
 *
 * Two kinds of source share this code. A still image is read once, at its
 * native size, on the first emission after it has decoded. A video is a *live*
 * source: it is read again every time the element presents a new frame, into a
 * grid no larger than `sampleSize` on its longest edge. That bound is what
 * keeps a video affordable — the decode itself is the browser's hardware path
 * and costs the main thread nothing, so the whole price of a moving source is
 * this readback, and a 512-pixel grid is already finer than a particle cloud
 * can resolve.
 *
 * Readbacks happen lazily, from inside emission: a system that is not spawning
 * never pays for a frame it would not have sampled.
 *
 * Where the reading happens matters as much as how much is read. A 2D canvas
 * readback is a synchronous wait for the GPU, and on a page that is already
 * rendering a heavy frame that wait is the render's own queue: measured at
 * ~6 ms per video frame beside the editor's WebGPU scene, whatever the grid
 * size. So after the first frame the reading moves to a worker: the main
 * thread wraps the presented frame in a `VideoFrame` — a handle, not a copy —
 * and hands it over; the worker scales it onto an `OffscreenCanvas`, reads the
 * grid, and posts the bytes back with their buffer transferred. The wait still
 * exists, but on a thread that has nothing else to do, and the render loop
 * never sees it. The canvas path stays as the fallback, and for the first
 * frame, so a video is never colourless while the worker warms up.
 */
import { buildColorTweak } from './color-tweak';
import { ColorInstancePlane, ColorInstanceWrap } from './three-particles-enums';
import type { ColorInstanceData, ParticleColorInstanceConfig } from './types';
import type * as THREE from 'three';

/** Longest edge of the grid a live source is read back into, unless configured. */
export const DEFAULT_LIVE_SAMPLE_SIZE = 512;

/** Reads at most this often when the browser cannot tell us about new frames. */
const FALLBACK_FRAME_INTERVAL_MS = 1000 / 30;

/** Where the readback cost is published for whoever wants to look at it. */
export const READBACK_STATS_KEY = 'colorInstanceReadback';

export type ReadbackStats = {
  /** Number of grids read so far. Grows with the video's frame rate, not ours. */
  count: number;
  /**
   * Main-thread time of the last readback, in milliseconds: the whole canvas
   * readback in `canvas` mode, only the hand-over in `worker` mode.
   */
  lastMs: number;
  /** Time the worker spent on the last grid; 0 in `canvas` mode. */
  workerMs: number;
  width: number;
  height: number;
  /** True while frames are being watched — i.e. this is a video, and it is wired. */
  live: boolean;
  /** Where a live source is being read: off the main thread, or on it. */
  mode: 'idle' | 'canvas' | 'worker';
};

type VideoLike = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

const isVideoElement = (image: unknown): image is VideoLike =>
  typeof HTMLVideoElement !== 'undefined' && image instanceof HTMLVideoElement;

// ─── The worker ──────────────────────────────────────────────────────────────

/**
 * Plain script, not a module: it is loaded from a blob URL so the library
 * needs no build step or asset path for it. One per page, shared by every
 * live source; replies are routed by the id each sampler registers.
 */
const WORKER_SOURCE = `
let canvas = null, context = null;
self.onmessage = (event) => {
  const { frame, width, height, id } = event.data;
  const started = performance.now();
  try {
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = new OffscreenCanvas(width, height);
      context = canvas.getContext('2d', { willReadFrequently: false });
    }
    context.drawImage(frame, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    self.postMessage({ id, pixels: data.buffer, width, height, ms: performance.now() - started }, [data.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  } finally {
    frame.close();
  }
};
`;

type WorkerReply =
  | {
      id: number;
      pixels: ArrayBuffer;
      width: number;
      height: number;
      ms: number;
    }
  | { id: number; error: string };

let sharedWorker: Worker | null = null;
/** Set once a worker failed to start or died; there is no second attempt. */
let workerBroken = false;
let nextReaderId = 1;
const readers = new Map<number, (reply: WorkerReply) => void>();

/** Everything the worker path needs, or null — and null is a normal answer. */
const getWorker = (): Worker | null => {
  if (sharedWorker) return sharedWorker;
  if (workerBroken) return null;
  if (
    typeof Worker === 'undefined' ||
    typeof VideoFrame === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  )
    return null;
  try {
    const url = URL.createObjectURL(
      new Blob([WORKER_SOURCE], { type: 'text/javascript' })
    );
    const worker = new Worker(url);
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      readers.get(event.data.id)?.(event.data);
    };
    worker.onerror = () => {
      // Every sampler falls back to the canvas path; a broken worker is not
      // retried, and nothing waits on a reply that will not come.
      workerBroken = true;
      sharedWorker = null;
      readers.forEach((deliver, id) => deliver({ id, error: 'worker failed' }));
    };
    sharedWorker = worker;
  } catch {
    workerBroken = true;
    sharedWorker = null;
  }
  return sharedWorker;
};

/**
 * Hands the frame the video just presented to the worker. Returns false when
 * the worker path is unavailable and the caller should read on the main
 * thread instead. Never queues: a frame that arrives while the previous one is
 * still being read is skipped, so a slow reader falls behind rather than
 * piling up frames it will never catch up on.
 */
const offloadFrame = (ci: ColorInstanceData, video: VideoLike): boolean => {
  if (ci.workerFailed) return false;
  const worker = getWorker();
  if (!worker) return false;
  if (ci.workerBusy) return true;

  const source = sourceSize(video);
  if (!source.width || !source.height) return true;
  const grid = gridSize(ci, true, source.width, source.height);

  if (!ci.readerId) {
    ci.readerId = nextReaderId++;
    readers.set(ci.readerId, (reply) => {
      ci.workerBusy = false;
      if ('error' in reply) {
        ci.workerFailed = true;
        ci.frameDirty = true;
        return;
      }
      ci.pixels = new Uint8ClampedArray(reply.pixels);
      ci.width = reply.width;
      ci.height = reply.height;
      ci.lastWorkerMs = reply.ms;
      ci.readbackCount = (ci.readbackCount ?? 0) + 1;
      ci.mode = 'worker';
      publishStats(ci);
    });
  }

  const started = performance.now();
  try {
    const frame = new VideoFrame(video);
    worker.postMessage(
      { frame, width: grid.width, height: grid.height, id: ci.readerId },
      [frame as unknown as Transferable]
    );
  } catch {
    ci.workerFailed = true;
    return false;
  }
  ci.workerBusy = true;
  ci.lastReadbackMs = performance.now() - started;
  ci.lastReadbackAt = started;
  return true;
};

export const createColorInstanceData = (
  config: ParticleColorInstanceConfig
): ColorInstanceData => ({
  isActive: true,
  map: config.map,
  plane: config.plane ?? ColorInstancePlane.XZ,
  areaX: config.area?.x ?? 0,
  areaY: config.area?.y ?? 0,
  areaZ: config.area?.z ?? 0,
  scaleX: config.scale?.x ?? 1,
  scaleY: config.scale?.y ?? 1,
  wrap: config.wrap ?? ColorInstanceWrap.ZERO,
  useAlphaForOpacity: !!config.useAlphaForOpacity,
  useLuminanceForNoise: !!config.useLuminanceForNoise,
  luminanceNoiseAmount: config.luminanceNoiseAmount ?? 0,
  sampleSize: config.sampleSize ?? 0,
  colorTweak: buildColorTweak(config.colorTweak),
  luminanceBlack: config.luminanceMap?.black ?? 0,
  luminanceWhite: config.luminanceMap?.white ?? 1,
});

/** Stops watching a video's frames. Safe to call on a still image, or twice. */
export const disposeColorInstanceData = (
  ci: ColorInstanceData | undefined
): void => {
  if (!ci) return;
  if (ci.cancelFrameWatch) {
    ci.cancelFrameWatch();
    ci.cancelFrameWatch = undefined;
  }
  if (ci.readerId) {
    readers.delete(ci.readerId);
    ci.readerId = undefined;
  }
  ci.pixels = undefined;
  ci.canvas = undefined;
  ci.context = undefined;
  ci.live = false;
  ci.mode = 'idle';
  // Only this sampler's own record is marked idle: a replacement sampler on
  // the same texture may already have published one of its own.
  const texture = ci.map as THREE.Texture | undefined;
  if (ci.stats && texture?.userData?.[READBACK_STATS_KEY] === ci.stats) {
    ci.stats.live = false;
    ci.stats.mode = 'idle';
  }
};

/**
 * Publishes the readback cost on the texture's `userData`, where anything
 * holding the texture can read it without an API for it — the editor's
 * harness does, and so can a stats overlay.
 */
const publishStats = (ci: ColorInstanceData): void => {
  const texture = ci.map as THREE.Texture | undefined;
  if (!texture?.userData) return;
  if (!ci.stats || texture.userData[READBACK_STATS_KEY] !== ci.stats) {
    ci.stats = {
      count: 0,
      lastMs: 0,
      workerMs: 0,
      width: 0,
      height: 0,
      live: false,
      mode: 'idle',
    };
    texture.userData[READBACK_STATS_KEY] = ci.stats;
  }
  ci.stats.count = ci.readbackCount ?? 0;
  ci.stats.lastMs = ci.lastReadbackMs ?? 0;
  ci.stats.workerMs = ci.lastWorkerMs ?? 0;
  ci.stats.width = ci.width ?? 0;
  ci.stats.height = ci.height ?? 0;
  ci.stats.live = !!ci.live;
  ci.stats.mode = ci.mode ?? 'idle';
};

/**
 * Starts watching a video for new frames. `requestVideoFrameCallback` fires
 * once per *presented* frame — the video's rate, not the display's — which is
 * exactly the cadence a readback should follow. Without it, a time-based
 * throttle stands in.
 */
const watchFrames = (ci: ColorInstanceData, video: VideoLike): void => {
  if (ci.live) return;
  ci.live = true;

  if (typeof video.requestVideoFrameCallback === 'function') {
    let handle = 0;
    const onFrame = (): void => {
      // Off the main thread when it can be; otherwise the next emission reads.
      if (!offloadFrame(ci, video)) ci.frameDirty = true;
      handle = video.requestVideoFrameCallback!(onFrame);
    };
    handle = video.requestVideoFrameCallback(onFrame);
    ci.cancelFrameWatch = () => video.cancelVideoFrameCallback?.(handle);
  } else {
    ci.usesFallbackClock = true;
    ci.cancelFrameWatch = () => undefined;
  }
};

const sourceSize = (image: unknown): { width: number; height: number } => {
  if (isVideoElement(image))
    return { width: image.videoWidth, height: image.videoHeight };
  const img = image as {
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
  };
  return {
    width: img.naturalWidth || img.width || 0,
    height: img.naturalHeight || img.height || 0,
  };
};

const gridSize = (
  ci: ColorInstanceData,
  live: boolean,
  width: number,
  height: number
): { width: number; height: number } => {
  if (!live) return { width, height };
  const max = ci.sampleSize > 0 ? ci.sampleSize : DEFAULT_LIVE_SAMPLE_SIZE;
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

/**
 * Makes sure `ci.pixels` holds the source's current pixels. Returns true when
 * there is something to sample.
 *
 * Retries on every call until the source has content; gives up permanently
 * only when readback throws (a cross-origin source taints the canvas). For a
 * video, "current" means the last presented frame: the grid is re-read when a
 * new one has arrived, and only then — an emission tick that spawns a thousand
 * particles reads it once.
 */
export const ensureColorInstancePixels = (ci: ColorInstanceData): boolean => {
  if (ci.failed) return false;

  const image = ci.map?.image as unknown;
  if (!image) return false;
  const video = isVideoElement(image) ? image : null;

  if (ci.pixels) {
    if (!video) return true;
    if (ci.usesFallbackClock) {
      const now = performance.now();
      if (
        now - (ci.lastReadbackAt ?? 0) >= FALLBACK_FRAME_INTERVAL_MS &&
        !video.paused
      )
        ci.frameDirty = true;
    }
    if (!ci.frameDirty) return true;
  }

  // A video with no decoded frame yet: keep whatever was read last, if anything.
  if (video && video.readyState < 2 /* HAVE_CURRENT_DATA */) return !!ci.pixels;

  const source = sourceSize(image);
  if (!source.width || !source.height) return !!ci.pixels;
  const grid = gridSize(ci, !!video, source.width, source.height);

  try {
    if (
      !ci.canvas ||
      ci.canvas.width !== grid.width ||
      ci.canvas.height !== grid.height
    ) {
      const canvas = document.createElement('canvas');
      canvas.width = grid.width;
      canvas.height = grid.height;
      // Explicitly *not* a read-frequently canvas, and explicitly so. Left
      // unspecified, Chrome moves a canvas that is read back repeatedly onto
      // the CPU — and then drawing a hardware-decoded frame means converting
      // the whole frame on the CPU first: measured at ~7 ms per frame for a
      // 2048² video, whatever the grid size. Kept on the GPU, the scale-down
      // is a blit and only the small grid is read back: ~2 ms at 512², ~1 ms
      // at 256², steady over hundreds of frames.
      const context = canvas.getContext('2d', { willReadFrequently: false });
      if (!context) {
        ci.failed = true;
        return false;
      }
      ci.canvas = canvas;
      ci.context = context;
    }

    const started = performance.now();
    ci.context!.drawImage(
      image as CanvasImageSource,
      0,
      0,
      grid.width,
      grid.height
    );
    ci.pixels = ci.context!.getImageData(0, 0, grid.width, grid.height).data;
    ci.width = grid.width;
    ci.height = grid.height;
    ci.frameDirty = false;
    ci.lastReadbackAt = started;
    ci.lastReadbackMs = performance.now() - started;
    ci.readbackCount = (ci.readbackCount ?? 0) + 1;
    if (video) ci.mode = 'canvas';

    if (video) watchFrames(ci, video);
    publishStats(ci);
    return true;
  } catch {
    ci.failed = true;
    return false;
  }
};
