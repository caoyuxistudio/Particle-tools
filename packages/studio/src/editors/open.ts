// Opening V1's three canvas editors from the studio (V2-ARCHITECTURE.md §3
// `editors/`): a thin wrapper each, the editors themselves untouched. They
// mutate the document in place and call back; the store is told through
// touched(path) so the change is applied at its cost and the revision moves.

import { openBezierEditorModal, setPresetPrompts as setCurvePresetPrompts } from '@particle-tools/engine/curve-editor/curve-editor';
import { createGradientEditor, setGradientStops, setOnChangeCallback, setPresetPrompts as setGradientPresetPrompts } from '@particle-tools/engine/gradient-editor/gradient-editor';
import type { GradientStop } from '@particle-tools/engine/gradient-editor/gradient-to-bezier';
import { gradientToBezierCurves, getDefaultGradientStops } from '@particle-tools/engine/gradient-editor/gradient-to-bezier';
import { openTextureSelectorModal } from '@particle-tools/engine/texture-selector/texture-selector';
import { getTexture } from '@particle-tools/engine/assets';
import { get, patch, touched, document as doc } from '../store/document.svelte';

// ─── applying on demand ──────────────────────────────────────────────────────
//
// A curve or a gradient is baked into the particle system at creation, so
// applying one rebuilds it and the particles start over. The editors call
// back on every drag; here that only marks the change, and the footer's Apply
// (or closing the editor) applies it once.

type Pending = { path: string; dirty: boolean };
const pending: Record<'bezier' | 'gradient', Pending> = {
  bezier: { path: '', dirty: false },
  gradient: { path: 'colorOverLifetime', dirty: false },
};

const footer = (kind: 'bezier' | 'gradient') => ({
  apply: window.document.querySelector<HTMLButtonElement>(`.${kind}-editor-apply`),
  note: window.document.querySelector<HTMLElement>(`.${kind}-editor-footer__note`),
});

const showPending = (kind: 'bezier' | 'gradient'): void => {
  const { apply, note } = footer(kind);
  const p = pending[kind];
  if (apply) {
    apply.disabled = !p.dirty;
    apply.classList.toggle('is-dirty', p.dirty);
  }
  if (note) note.textContent = p.dirty ? 'changed — the particles still run the old one' : 'applied';
};

const markDirty = (kind: 'bezier' | 'gradient'): void => {
  pending[kind].dirty = true;
  showPending(kind);
};

export const applyPending = (kind: 'bezier' | 'gradient'): boolean => {
  const p = pending[kind];
  if (!p.dirty || !p.path) return false;
  touched(p.path);
  p.dirty = false;
  showPending(kind);
  return true;
};

const installed = new Set<string>();
const installFooter = (kind: 'bezier' | 'gradient'): void => {
  if (installed.has(kind)) return;
  const { apply } = footer(kind);
  const close = window.document.querySelector<HTMLElement>(`.${kind}-editor-modal__close`);
  if (!apply || !close) return;
  installed.add(kind);
  apply.addEventListener('click', () => applyPending(kind));
  // Closing applies too: the document already holds the edit, the particles should not lag it.
  close.addEventListener('click', () => applyPending(kind));
};

// ─── naming a preset without window.prompt ───────────────────────────────────

const askName = (kind: 'bezier' | 'gradient') => (message: string): Promise<string | null> =>
  new Promise((resolve) => {
    const body = window.document.querySelector<HTMLElement>(`.${kind}-editor-modal__body`);
    if (!body) return resolve(null);
    const row = window.document.createElement('div');
    row.className = 'editor-namer';
    row.innerHTML = `<span class="editor-footer__note">${message}</span><input type="text" placeholder="name" /><button type="button" class="editor-namer__save">save</button><button type="button" class="editor-namer__cancel">cancel</button>`;
    body.appendChild(row);
    const input = row.querySelector('input')!;
    const done = (value: string | null) => {
      row.remove();
      resolve(value);
    };
    row.querySelector('.editor-namer__save')!.addEventListener('click', () => done(input.value));
    row.querySelector('.editor-namer__cancel')!.addEventListener('click', () => done(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    });
    input.focus();
  });

setCurvePresetPrompts({ askName: askName('bezier'), confirmOverwrite: async () => true });
setGradientPresetPrompts({ askName: askName('gradient'), confirmOverwrite: async () => true });

/** A LifetimeCurve at `path` (e.g. sizeOverLifetime.lifetimeCurve). */
export const openCurve = (path: string): void => {
  let target = get(path);
  if (!target || typeof target !== 'object') {
    target = { type: 'BEZIER', scale: 1, bezierPoints: [{ x: 0, y: 0, percentage: 0 }, { x: 1, y: 1, percentage: 1 }] };
    patch(path, target);
    target = get(path);
  }
  applyPending('bezier');
  pending.bezier = { path, dirty: false };
  installFooter('bezier');
  showPending('bezier');
  openBezierEditorModal(target, () => markDirty('bezier'));
};

let gradientReady = false;

const applyStops = (stops: GradientStop[]): void => {
  doc._editorData.gradientStops = stops;
  const curves = gradientToBezierCurves(stops);
  doc.colorOverLifetime = { ...(doc.colorOverLifetime ?? {}), isActive: true, r: curves.r, g: curves.g, b: curves.b };
  markDirty('gradient');
};

/** colorOverLifetime's r/g/b as one gradient, like V1's Color over lifetime (Gradient). */
export const openGradient = (): void => {
  const modal = window.document.querySelector<HTMLElement>('.gradient-editor-modal');
  if (!modal) return;
  if (!doc._editorData.gradientStops) doc._editorData.gradientStops = getDefaultGradientStops();
  modal.style.display = 'block';
  installFooter('gradient');
  showPending('gradient');
  if (!gradientReady) {
    createGradientEditor(doc._editorData.gradientStops, applyStops);
    gradientReady = true;
  } else {
    setOnChangeCallback(applyStops);
    setGradientStops(doc._editorData.gradientStops);
  }
};

export const resetGradient = (): void => {
  const stops = getDefaultGradientStops();
  if (gradientReady) setGradientStops(stops);
  applyStops(stops);
  applyPending('gradient');
};

/** The sprite texture (map + sheet tiles) or the colour source, from the registry. */
export const openTexture = (which: 'sprite' | 'source'): void => {
  const key = which === 'sprite' ? '_editorData.textureId' : '_editorData.colorInstanceTextureId';
  openTextureSelectorModal({
    currentTextureId: get(key),
    onSelect: (id: string) => {
      const texture: any = getTexture(id);
      if (which === 'sprite') {
        doc._editorData.textureId = id;
        doc.map = texture?.map;
        if (texture?.tiles) {
          doc.textureSheetAnimation.tiles.x = texture.tiles.x || doc.textureSheetAnimation.tiles.x;
          doc.textureSheetAnimation.tiles.y = texture.tiles.y || doc.textureSheetAnimation.tiles.y;
        }
      } else {
        doc._editorData.colorInstanceTextureId = id;
        if (doc.particleColorInstance) doc.particleColorInstance.map = texture?.map;
      }
      touched(key);
    },
  });
};

/** The colour source by registry name (an image, a video, a built-in), or none. */
export const useColourSource = (id: string | undefined): void => {
  const texture: any = id ? getTexture(id) : null;
  doc._editorData.colorInstanceTextureId = id;
  if (doc.particleColorInstance) doc.particleColorInstance.map = texture?.map;
  touched('_editorData.colorInstanceTextureId');
};
