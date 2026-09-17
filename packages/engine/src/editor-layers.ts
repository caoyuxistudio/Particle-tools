/**
 * Keeps the editor's own furniture out of the output camera's view.
 *
 * The split is deliberately one-sided: everything stays on the default layer
 * and only furniture is moved off it. Marking the artwork instead would mean
 * every future object type has to remember to opt in, and forgetting would make
 * it silently vanish from the render. This way a forgotten helper merely shows
 * up in the preview, which is immediately obvious.
 */
import * as THREE from 'three';

/** Grids, axes, drag handles, force-field and collision gizmos live here. */
export const EDITOR_LAYER = 1;

/**
 * Moves an object and everything under it onto the editor layer.
 *
 * Layers are per-object rather than inherited, so the whole subtree has to be
 * walked — a gizmo is a tree of handles, and marking only its root would leave
 * the handles visible.
 */
export const markAsEditorOnly = (object: THREE.Object3D): void => {
  object.traverse((child) => child.layers.set(EDITOR_LAYER));
};
