/**
 * The loading bar the page shows until the first picture.
 *
 * The markup and its style are inline in index.html, so the bar is on screen
 * before the bundle has even downloaded; while it waits for the script it
 * creeps on a CSS animation. From there the boot's own marks drive it: each
 * phase has a share of the bar, and the bar only ever moves forward. It is
 * scaled with a transform so the compositor keeps it moving through the long
 * main-thread blocks (piece load, shader compilation) it exists to explain.
 */

/** Where the bar stands once a boot phase is done, and what comes next. */
const PHASES: Record<string, { at: number; next: string }> = {
  start: { at: 0.3, next: 'Starting the renderer' },
  backend: { at: 0.36, next: 'Building the world' },
  world: { at: 0.45, next: 'Loading textures' },
  scene: { at: 0.62, next: 'Loading the piece' },
  painted: { at: 0.64, next: 'Loading the piece' },
  piece: { at: 0.78, next: 'Compiling shaders' },
  compiled: { at: 0.95, next: 'First frame' },
};

const FADE_MS = 350;

let reached = 0;
let finished = false;

const loader = (): HTMLElement | null => document.getElementById('boot-loader');

/** The bar's scale as it is drawn right now, the CSS creep included. */
const currentScale = (bar: HTMLElement): number => {
  const matrix = getComputedStyle(bar).transform.match(/matrix\(([^,]+),/);
  return matrix ? parseFloat(matrix[1]) || 0 : 0;
};

const setBar = (value: number): void => {
  const bar = loader()?.querySelector<HTMLElement>('.boot-loader__bar');
  if (!bar) return;
  reached = Math.max(reached, currentScale(bar), value);
  bar.style.animation = 'none';
  bar.style.transform = `scaleX(${reached})`;
};

/** A boot phase is done: the bar moves to its share. */
export const bootProgress = (phase: string): void => {
  if (finished) return;
  if (phase === 'first-frame') {
    finishBootProgress();
    return;
  }
  const entry = PHASES[phase];
  if (!entry) return;
  setBar(entry.at);
  const label = loader()?.querySelector<HTMLElement>('.boot-loader__label');
  if (label) label.textContent = entry.next;
};

/** Part of the way through a phase: `fraction` of the stretch from one share to the next. */
export const bootProgressWithin = (from: string, to: string, fraction: number): void => {
  if (finished || !PHASES[from] || !PHASES[to]) return;
  const start = PHASES[from].at;
  setBar(start + (PHASES[to].at - start) * Math.min(1, Math.max(0, fraction)));
};

/** The picture is up: fill the bar, fade the overlay, take it out. */
export const finishBootProgress = (): void => {
  if (finished) return;
  finished = true;
  const element = loader();
  if (!element) return;
  setBar(1);
  element.classList.add('boot-loader--done');
  window.setTimeout(() => element.remove(), FADE_MS + 50);
};

/** A boot that threw never reaches its first frame; say so instead of hanging. */
const reportFailure = (): void => {
  if (finished) return;
  const label = loader()?.querySelector<HTMLElement>('.boot-loader__label');
  if (label) label.textContent = 'Something failed while starting — see the console';
};
window.addEventListener('error', reportFailure);
window.addEventListener('unhandledrejection', reportFailure);

export const bootProgressState = (): { reached: number; finished: boolean; present: boolean } => ({
  reached,
  finished,
  present: !!loader(),
});
