// Opening V1's three canvas editors from the studio (V2-ARCHITECTURE.md §3
// `editors/`): a thin wrapper each, the editors themselves untouched. They
// mutate the document in place and call back; the store is told through
// touched(path) so the change is applied at its cost and the revision moves.

import { openBezierEditorModal } from '@engine/curve-editor/curve-editor';
import { createGradientEditor, setGradientStops, setOnChangeCallback } from '@engine/gradient-editor/gradient-editor';
import type { GradientStop } from '@engine/gradient-editor/gradient-to-bezier';
import { gradientToBezierCurves, getDefaultGradientStops } from '@engine/gradient-editor/gradient-to-bezier';
import { openTextureSelectorModal } from '@engine/texture-selector/texture-selector';
import { getTexture } from '@engine/assets';
import { get, patch, touched, document as doc } from '../store/document.svelte';

/** A LifetimeCurve at `path` (e.g. sizeOverLifetime.lifetimeCurve). */
export const openCurve = (path: string): void => {
  let target = get(path);
  if (!target || typeof target !== 'object') {
    target = { type: 'BEZIER', scale: 1, bezierPoints: [{ x: 0, y: 0, percentage: 0 }, { x: 1, y: 1, percentage: 1 }] };
    patch(path, target);
    target = get(path);
  }
  openBezierEditorModal(target, () => touched(path));
};

let gradientReady = false;

const applyStops = (stops: GradientStop[]): void => {
  doc._editorData.gradientStops = stops;
  const curves = gradientToBezierCurves(stops);
  doc.colorOverLifetime = { ...(doc.colorOverLifetime ?? {}), isActive: true, r: curves.r, g: curves.g, b: curves.b };
  touched('colorOverLifetime');
};

/** colorOverLifetime's r/g/b as one gradient, like V1's Color over lifetime (Gradient). */
export const openGradient = (): void => {
  const modal = window.document.querySelector<HTMLElement>('.gradient-editor-modal');
  if (!modal) return;
  if (!doc._editorData.gradientStops) doc._editorData.gradientStops = getDefaultGradientStops();
  modal.style.display = 'block';
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
