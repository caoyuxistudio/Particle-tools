/**
 * The performance HUD: the numbers that explain a frame rate, and the levers
 * that change it, on the device that is actually rendering.
 *
 * A phone cannot be profiled from here — there is no emulator whose GPU
 * behaves like the real one, and the desktop numbers say nothing about it. So
 * the instrument goes to the phone instead: this overlay reads frame rate,
 * resolution, particle count, reflections, the video readback path, and
 * writes the whole thing to the clipboard as text, to be pasted back. The
 * buttons change one thing at a time so the cost of each can be read off the
 * same counter: resolution (the pixel-ratio cap), reflections, and the
 * particle budget. None of it is saved; the piece is untouched.
 */
import type { SsrSettings, AoSettings } from './world';

export type PerfActions = {
  /** Where this page renders: 'webgpu' or 'webgl'. */
  backend: string;
  getRenderScale: () => number;
  setRenderScale: (cap: number) => void;
  getDrawingBufferSize: () => { width: number; height: number };
  getSsr: () => SsrSettings;
  setSsr: (patch: Partial<SsrSettings>) => void;
  getAo: () => AoSettings;
  setAo: (patch: Partial<AoSettings>) => void;
  /** Parallax from the gyroscope, on or off — runtime only, like the SSR lever. */
  getParallax: () => boolean;
  setParallax: (enabled: boolean) => void;
  getParticles: () => { maxParticles: number; rateOverTime: number; budget: number };
  /** Multiplies the particle budget (max and rate) and rebuilds. 1 = the piece's own. */
  setParticleBudget: (factor: number) => void;
  getVideoReadback: () => {
    mode: string;
    lastMs: number;
    workerMs: number;
    width: number;
    height: number;
  } | null;
  getPieceName: () => string;
  /** Page-specific facts, appended to the report. */
  extra?: () => Array<[string, string]>;
};

const STYLE_ID = 'perf-hud-style';
const CSS = `
.perf-hud {
  position: fixed; right: calc(12px + env(safe-area-inset-right)); top: calc(12px + env(safe-area-inset-top)); z-index: 1003;
  min-width: 240px; max-width: 92vw;
  padding: 10px 12px; border-radius: 8px;
  background: rgba(0, 0, 0, 0.72); color: #e8e8e8;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  pointer-events: auto; user-select: text; -webkit-user-select: text;
}
.perf-hud[hidden] { display: none; }
.perf-hud__big { font-size: 26px; font-weight: 600; line-height: 1.1; margin-bottom: 4px; }
.perf-hud__row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
.perf-hud__label { opacity: 0.7; min-width: 64px; }
.perf-hud button {
  padding: 8px 10px; border: 1px solid rgba(255,255,255,0.35); border-radius: 6px;
  background: rgba(255,255,255,0.08); color: #fff; font: 600 12px/1 inherit; cursor: pointer;
}
.perf-hud button.is-on { background: #b34a2c; border-color: #b34a2c; }
.perf-hud__copy { margin-top: 10px; width: 100%; }
`;

const ensureStyle = (): void => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
};

export type PerfHud = {
  toggle: () => void;
  show: () => void;
  hide: () => void;
  isShown: () => boolean;
  /** The text the Copy button copies. */
  report: () => string;
};

export const installPerfHud = (actions: PerfActions): PerfHud => {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'perf-hud';
  root.hidden = true;

  const big = document.createElement('div');
  big.className = 'perf-hud__big';
  big.textContent = '– fps';
  const lines = document.createElement('div');
  root.append(big, lines);

  // ── Frame timing: a rolling two-second window, sampled while shown ──────────
  const stamps: number[] = [];
  let rafId = 0;
  const onFrame = (now: number): void => {
    stamps.push(now);
    while (stamps.length && now - stamps[0] > 2000) stamps.shift();
    rafId = requestAnimationFrame(onFrame);
  };
  const timing = (): { fps: number; min: number; ms: number } => {
    if (stamps.length < 2) return { fps: 0, min: 0, ms: 0 };
    const span = stamps[stamps.length - 1] - stamps[0];
    const fps = ((stamps.length - 1) * 1000) / span;
    let worst = 0;
    for (let i = 1; i < stamps.length; i++) worst = Math.max(worst, stamps[i] - stamps[i - 1]);
    return { fps, min: 1000 / worst, ms: span / (stamps.length - 1) };
  };

  // ── Levers ──────────────────────────────────────────────────────────────────
  const rows: Array<{ el: HTMLElement; refresh: () => void }> = [];
  const row = <T>(
    label: string,
    options: Array<{ text: string; value: T }>,
    current: () => T,
    apply: (value: T) => void
  ): void => {
    const el = document.createElement('div');
    el.className = 'perf-hud__row';
    const name = document.createElement('span');
    name.className = 'perf-hud__label';
    name.textContent = label;
    el.appendChild(name);
    const buttons = options.map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.text;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        apply(option.value);
        refreshAll();
      });
      el.appendChild(button);
      return { button, option };
    });
    const refresh = (): void => {
      const value = current();
      buttons.forEach(({ button, option }) =>
        button.classList.toggle('is-on', Object.is(option.value, value))
      );
    };
    rows.push({ el, refresh });
    root.appendChild(el);
  };

  const dpr = window.devicePixelRatio || 1;
  row<number>(
    'scale',
    [
      { text: '0.75', value: 0.75 },
      { text: '1', value: 1 },
      { text: '1.5', value: 1.5 },
      { text: '2', value: 2 },
      { text: `max (${dpr})`, value: Infinity },
    ],
    () => {
      const scale = actions.getRenderScale();
      return scale >= dpr - 1e-3 ? Infinity : scale;
    },
    (cap) => actions.setRenderScale(cap)
  );
  row<boolean>(
    'SSR',
    [
      { text: 'off', value: false },
      { text: 'on', value: true },
    ],
    () => actions.getSsr().enabled,
    (enabled) => actions.setSsr({ enabled })
  );
  row<boolean>(
    'AO',
    [
      { text: 'off', value: false },
      { text: 'on', value: true },
    ],
    () => actions.getAo().enabled,
    (enabled) => actions.setAo({ enabled })
  );
  row<boolean>(
    'gyro',
    [
      { text: 'off', value: false },
      { text: 'on', value: true },
    ],
    () => actions.getParallax(),
    (enabled) => actions.setParallax(enabled)
  );
  row<number>(
    'SSR res',
    [
      { text: '0.25', value: 0.25 },
      { text: '0.5', value: 0.5 },
      { text: '1', value: 1 },
    ],
    () => actions.getSsr().resolutionScale,
    (resolutionScale) => actions.setSsr({ resolutionScale })
  );
  row<number>(
    'particles',
    [
      { text: '25%', value: 0.25 },
      { text: '50%', value: 0.5 },
      { text: '100%', value: 1 },
    ],
    () => actions.getParticles().budget,
    (factor) => actions.setParticleBudget(factor)
  );

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'perf-hud__copy';
  copy.textContent = 'Copy report';
  copy.addEventListener('click', (event) => {
    event.stopPropagation();
    const text = report();
    const done = (ok: boolean) => {
      copy.textContent = ok
        ? 'Copied — paste it to the chat'
        : 'Could not copy; long-press the text';
      setTimeout(() => (copy.textContent = 'Copy report'), 2500);
    };
    if (navigator.clipboard?.writeText)
      navigator.clipboard.writeText(text).then(
        () => done(true),
        () => done(false)
      );
    else done(false);
  });
  root.appendChild(copy);

  // ── The readout ─────────────────────────────────────────────────────────────
  const facts = (): Array<[string, string]> => {
    const t = timing();
    const buffer = actions.getDrawingBufferSize();
    const ssr = actions.getSsr();
    const aoSet = actions.getAo();
    const particles = actions.getParticles();
    const video = actions.getVideoReadback();
    const nav = navigator as Navigator & { deviceMemory?: number };
    return [
      ['fps', `${t.fps.toFixed(1)} (worst ${t.min.toFixed(1)}), ${t.ms.toFixed(1)} ms/frame`],
      ['piece', actions.getPieceName()],
      ['backend', actions.backend],
      [
        'pixels',
        `${buffer.width}×${buffer.height} @ scale ${actions.getRenderScale().toFixed(2)} (device ${dpr})`,
      ],
      ['window', `${window.innerWidth}×${window.innerHeight}`],
      // The whole viewport story, for a phone: what the page was given, what
      // the screen is, and what the OS keeps for itself around the edges.
      ['viewport', viewportFacts()],
      [
        'particles',
        `${particles.maxParticles} max, ${particles.rateOverTime}/s, budget ${Math.round(particles.budget * 100)}%`,
      ],
      [
        'SSR',
        ssr.enabled
          ? `on, res ${ssr.resolutionScale}, quality ${ssr.quality}, blur ${ssr.blurQuality}`
          : 'off',
      ],
      [
        'AO',
        aoSet.enabled
          ? `on, strength ${aoSet.intensity}, radius ${aoSet.radius}, ${aoSet.samples} samples, res ${aoSet.resolutionScale}, denoise ${aoSet.denoise}`
          : 'off',
      ],
      [
        'video',
        video
          ? `${video.mode}, main ${video.lastMs.toFixed(2)} ms, worker ${video.workerMs.toFixed(1)} ms, grid ${video.width}×${video.height}`
          : 'none',
      ],
      [
        'device',
        `${nav.hardwareConcurrency ?? '?'} cores, ${nav.deviceMemory ?? '?'} GB, touch ${navigator.maxTouchPoints}`,
      ],
      ...(actions.extra?.() ?? []),
      ['ua', navigator.userAgent],
    ];
  };

  const viewportFacts = (): string => {
    const style = getComputedStyle(document.documentElement);
    const inset = (name: string) => style.getPropertyValue(name).trim() || '0px';
    const vv = window.visualViewport;
    // How tall the page thinks "the viewport" is in each unit family.
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(probe);
    const unit = (u: string) => {
      probe.style.height = `100${u}`;
      return Math.round(probe.getBoundingClientRect().height);
    };
    const units = `vh${unit('vh')} dvh${unit('dvh')} lvh${unit('lvh')} svh${unit('svh')}`;
    probe.remove();
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return [
      `doc ${document.documentElement.clientWidth}×${document.documentElement.clientHeight}`,
      vv
        ? `visual ${Math.round(vv.width)}×${Math.round(vv.height)} @${Math.round(vv.offsetTop)} zoom x${vv.scale.toFixed(2)}`
        : 'no visualViewport',
      `screen ${screen.width}×${screen.height}`,
      units,
      `safe t${inset('--safe-top')} r${inset('--safe-right')} b${inset('--safe-bottom')} l${inset('--safe-left')}`,
      standalone ? 'standalone' : 'browser',
      `gap top ${getComputedStyle(document.documentElement).getPropertyValue('--viewport-top-gap').trim() || '0px'} bottom ${getComputedStyle(document.documentElement).getPropertyValue('--viewport-gap').trim() || '0px'}`,
      `canvas ${document.querySelector('canvas')?.clientWidth ?? 0}×${document.querySelector('canvas')?.clientHeight ?? 0}`,
    ].join(', ');
  };

  const report = (): string =>
    facts()
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

  const refreshAll = (): void => {
    const t = timing();
    big.textContent = `${t.fps.toFixed(0)} fps`;
    lines.innerHTML = '';
    facts()
      .slice(1, -1) // the fps line is the big number; the UA is for the report
      .forEach(([k, v]) => {
        const line = document.createElement('div');
        line.textContent = `${k}: ${v}`;
        lines.appendChild(line);
      });
    rows.forEach((r) => r.refresh());
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  const show = (): void => {
    if (!root.isConnected) document.body.appendChild(root);
    root.hidden = false;
    stamps.length = 0;
    if (!rafId) rafId = requestAnimationFrame(onFrame);
    if (!timer) timer = setInterval(refreshAll, 500);
    refreshAll();
  };
  const hide = (): void => {
    root.hidden = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (timer) clearInterval(timer);
    timer = null;
  };
  const isShown = (): boolean => !root.hidden;
  const toggle = (): void => (isShown() ? hide() : show());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'p' || event.key === 'P') toggle();
  });

  return { toggle, show, hide, isShown, report };
};
