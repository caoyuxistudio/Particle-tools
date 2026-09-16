/**
 * The sampler runs in a browser; here the browser is a handful of stubs. What
 * is under test is the policy — when a readback happens, into what size grid,
 * and what stops it — not the canvas.
 */
import {
  DEFAULT_LIVE_SAMPLE_SIZE,
  READBACK_STATS_KEY,
  createColorInstanceData,
  disposeColorInstanceData,
  ensureColorInstancePixels,
  refreshColorInstanceData,
} from '../color-instance-sampler';

type Draw = { width: number; height: number };

let draws: Draw[] = [];
let contextAvailable = true;

class FakeContext {
  constructor(private canvas: { width: number; height: number }) {}
  drawImage(): void {
    draws.push({ width: this.canvas.width, height: this.canvas.height });
  }
  getImageData(_x: number, _y: number, w: number, h: number) {
    return { data: new Uint8ClampedArray(w * h * 4).fill(200) };
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  getContext(): FakeContext | null {
    return contextAvailable ? new FakeContext(this) : null;
  }
}

class FakeVideo {
  videoWidth = 2048;
  videoHeight = 1024;
  readyState = 2;
  paused = false;
  callbacks = new Map<number, () => void>();
  cancelled: number[] = [];
  private nextId = 1;
  requestVideoFrameCallback(cb: () => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, cb);
    return id;
  }
  cancelVideoFrameCallback(id: number): void {
    this.cancelled.push(id);
    this.callbacks.delete(id);
  }
  /** The browser presenting one frame: every pending callback fires once. */
  presentFrame(): void {
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    pending.forEach((cb) => cb());
  }
}

const texture = (image: unknown) => ({
  image,
  userData: {} as Record<string, any>,
});

beforeAll(() => {
  (globalThis as any).document = { createElement: () => new FakeCanvas() };
  (globalThis as any).HTMLVideoElement = FakeVideo;
});

afterAll(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).HTMLVideoElement;
});

beforeEach(() => {
  draws = [];
  contextAvailable = true;
});

describe('still images', () => {
  it('reads once, at native size, and never again', () => {
    const ci = createColorInstanceData({
      isActive: true,
      map: texture({ naturalWidth: 300, naturalHeight: 200 }) as any,
    });
    expect(ensureColorInstancePixels(ci)).toBe(true);
    expect(ensureColorInstancePixels(ci)).toBe(true);
    expect(draws).toEqual([{ width: 300, height: 200 }]);
    expect(ci.width).toBe(300);
    expect(ci.live).toBeFalsy();
  });

  it('waits for an image that has not decoded yet', () => {
    const ci = createColorInstanceData({
      isActive: true,
      map: texture({ width: 0 }) as any,
    });
    expect(ensureColorInstancePixels(ci)).toBe(false);
    expect(draws).toHaveLength(0);
  });

  it('gives up for good when no context can be had', () => {
    contextAvailable = false;
    const ci = createColorInstanceData({
      isActive: true,
      map: texture({ width: 8, height: 8 }) as any,
    });
    expect(ensureColorInstancePixels(ci)).toBe(false);
    contextAvailable = true;
    expect(ensureColorInstancePixels(ci)).toBe(false);
    expect(ci.failed).toBe(true);
  });
});

describe('videos', () => {
  it('reads into a bounded grid and only re-reads when a frame arrives', () => {
    const video = new FakeVideo();
    const map = texture(video);
    const ci = createColorInstanceData({ isActive: true, map: map as any });

    expect(ensureColorInstancePixels(ci)).toBe(true);
    expect(draws).toEqual([
      { width: DEFAULT_LIVE_SAMPLE_SIZE, height: DEFAULT_LIVE_SAMPLE_SIZE / 2 },
    ]);
    expect(ci.live).toBe(true);

    // A thousand spawns in the same tick share one readback.
    for (let i = 0; i < 1000; i++) ensureColorInstancePixels(ci);
    expect(draws).toHaveLength(1);

    video.presentFrame();
    expect(ensureColorInstancePixels(ci)).toBe(true);
    expect(draws).toHaveLength(2);
    expect(video.callbacks.size).toBe(1); // re-armed for the next frame

    const stats = map.userData[READBACK_STATS_KEY];
    expect(stats).toMatchObject({
      count: 2,
      width: 512,
      height: 256,
      live: true,
    });
  });

  it('honours sampleSize', () => {
    const ci = createColorInstanceData({
      isActive: true,
      map: texture(new FakeVideo()) as any,
      sampleSize: 128,
    });
    ensureColorInstancePixels(ci);
    expect(draws).toEqual([{ width: 128, height: 64 }]);
  });

  it('keeps the last frame while the element has nothing new to show', () => {
    const video = new FakeVideo();
    const ci = createColorInstanceData({
      isActive: true,
      map: texture(video) as any,
    });
    video.readyState = 1;
    expect(ensureColorInstancePixels(ci)).toBe(false);
    video.readyState = 2;
    expect(ensureColorInstancePixels(ci)).toBe(true);
    video.presentFrame();
    video.readyState = 1; // e.g. a seek in flight
    expect(ensureColorInstancePixels(ci)).toBe(true);
    expect(draws).toHaveLength(1);
  });

  it('stops watching frames on dispose and marks its record idle', () => {
    const video = new FakeVideo();
    const map = texture(video);
    const ci = createColorInstanceData({ isActive: true, map: map as any });
    ensureColorInstancePixels(ci);
    const stats = map.userData[READBACK_STATS_KEY];
    disposeColorInstanceData(ci);
    expect(video.cancelled).toHaveLength(1);
    expect(video.callbacks.size).toBe(0);
    expect(stats.live).toBe(false);
    expect(ci.pixels).toBeUndefined();
    // Disposing twice, or disposing nothing, is fine.
    disposeColorInstanceData(ci);
    disposeColorInstanceData(undefined);
  });

  it('does not touch a record a newer sampler already replaced', () => {
    const map = texture(new FakeVideo());
    const older = createColorInstanceData({ isActive: true, map: map as any });
    ensureColorInstancePixels(older);
    const newer = createColorInstanceData({ isActive: true, map: map as any });
    ensureColorInstancePixels(newer);
    disposeColorInstanceData(older);
    expect(map.userData[READBACK_STATS_KEY].live).toBe(true);
  });
});

describe('the worker path', () => {
  /** A worker that answers every frame with a grid of the requested size. */
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: { data: any }) => void) | null = null;
    onerror: (() => void) | null = null;
    posted: any[] = [];
    constructor(public url: string) {
      FakeWorker.instances.push(this);
    }
    postMessage(message: any): void {
      this.posted.push(message);
    }
    reply(): void {
      const { id, width, height } = this.posted[this.posted.length - 1];
      this.onmessage?.({
        data: {
          id,
          pixels: new ArrayBuffer(width * height * 4),
          width,
          height,
          ms: 1.5,
        },
      });
    }
    fail(): void {
      const { id } = this.posted[this.posted.length - 1];
      this.onmessage?.({ data: { id, error: 'nope' } });
    }
  }
  class FakeVideoFrame {
    closed = false;
    constructor(public source: unknown) {}
    close(): void {
      this.closed = true;
    }
  }

  beforeAll(() => {
    (globalThis as any).Worker = FakeWorker;
    (globalThis as any).VideoFrame = FakeVideoFrame;
    (globalThis as any).OffscreenCanvas = class {};
    (globalThis as any).Blob = class {
      constructor(public parts: unknown[]) {}
    };
    (globalThis as any).URL = { createObjectURL: () => 'blob:fake' };
  });

  afterAll(() => {
    delete (globalThis as any).Worker;
    delete (globalThis as any).VideoFrame;
    delete (globalThis as any).OffscreenCanvas;
    delete (globalThis as any).Blob;
    delete (globalThis as any).URL;
  });

  it('reads the first frame itself, then hands frames to the worker', () => {
    const video = new FakeVideo();
    const map = texture(video);
    const ci = createColorInstanceData({ isActive: true, map: map as any });

    expect(ensureColorInstancePixels(ci)).toBe(true);
    expect(draws).toHaveLength(1);
    expect(map.userData[READBACK_STATS_KEY].mode).toBe('canvas');

    // The worker is started by the first frame that needs it, not before.
    video.presentFrame();
    const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ width: 512, height: 256 });
    expect(worker.posted[0].frame).toBeInstanceOf(FakeVideoFrame);

    // Nothing is read on the main thread while the worker has the frame…
    expect(ensureColorInstancePixels(ci)).toBe(true);
    expect(draws).toHaveLength(1);
    // …and a frame presented meanwhile is skipped, not queued.
    video.presentFrame();
    expect(worker.posted).toHaveLength(1);

    worker.reply();
    const stats = map.userData[READBACK_STATS_KEY];
    expect(stats).toMatchObject({
      count: 2,
      mode: 'worker',
      workerMs: 1.5,
      width: 512,
      height: 256,
    });
    expect(ci.pixels).toHaveLength(512 * 256 * 4);

    video.presentFrame();
    expect(worker.posted).toHaveLength(2);
    disposeColorInstanceData(ci);
  });

  it('falls back to the main thread when the worker cannot read a frame', () => {
    const video = new FakeVideo();
    const ci = createColorInstanceData({
      isActive: true,
      map: texture(video) as any,
    });
    ensureColorInstancePixels(ci);
    video.presentFrame();
    const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
    worker.fail();
    expect(ci.workerFailed).toBe(true);
    // The frame it could not read is read here instead, and later ones too.
    expect(ensureColorInstancePixels(ci)).toBe(true);
    expect(draws).toHaveLength(2);
    const before = worker.posted.length;
    video.presentFrame();
    expect(worker.posted).toHaveLength(before);
    expect(ensureColorInstancePixels(ci)).toBe(true);
    expect(draws).toHaveLength(3);
    disposeColorInstanceData(ci);
  });
});

describe('refreshing a sampler for a changed config', () => {
  it('the same source keeps its pixels: settings move, no readback', () => {
    const map = texture({ naturalWidth: 8, naturalHeight: 4 });
    const ci = createColorInstanceData({ isActive: true, map: map as any });
    expect(ensureColorInstancePixels(ci)).toBe(true);
    expect(draws.length).toBe(1);
    const next = refreshColorInstanceData(ci, {
      isActive: true,
      map: map as any,
      scale: { x: 0.5, y: 2 },
      wrap: 'MIRROR' as any,
      offset: { x: 1, y: 0, z: -1 },
      colorTweak: { saturation: 2, contrast: 1, hue: 0 },
    });
    expect(next).toBe(ci);
    expect(ci.scaleX).toBe(0.5);
    expect(ci.scaleY).toBe(2);
    expect(ci.wrap).toBe('MIRROR');
    expect(ci.offsetX).toBe(1);
    expect(ci.offsetZ).toBe(-1);
    expect(ci.colorTweak).not.toBeNull();
    expect(ci.pixels).toBeDefined();
    expect(ensureColorInstancePixels(ci)).toBe(true);
    expect(draws.length).toBe(1);
  });

  it('a new source is a new sampler, and off is none', () => {
    const a = texture({ naturalWidth: 8, naturalHeight: 4 });
    const b = texture({ naturalWidth: 8, naturalHeight: 4 });
    const ci = createColorInstanceData({ isActive: true, map: a as any });
    const next = refreshColorInstanceData(ci, {
      isActive: true,
      map: b as any,
    });
    expect(next).not.toBe(ci);
    expect(next?.map).toBe(b);
    expect(refreshColorInstanceData(next, { isActive: false })).toBeUndefined();
  });
});
