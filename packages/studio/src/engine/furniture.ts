// The editor's furniture (V2-ARCHITECTURE.md §1.1): the helpers and gizmos
// that show force fields, collision planes, the emitter's shape, the axes and
// the colour-source plane. V1's lil-gui entries built these as a side effect
// of their controls; here they follow the document — call sync() after any
// change that could affect them, and every frame for the debug plane.

import * as THREE from 'three';
import { getScene } from '@engine/world';
import { createCollisionPlaneHelpers, disposeCollisionPlaneHelpers } from '@engine/collision-plane-helper';
import { initCollisionPlaneInteraction, disposeCollisionPlaneInteraction, deselectCollisionPlane } from '@engine/collision-plane-interaction';
import { createForceFieldHelpers, disposeForceFieldHelpers } from '@engine/force-field-helper';
import { initForceFieldInteraction, disposeForceFieldInteraction, deselectForceField } from '@engine/force-field-interaction';
import { updateShapeHelper } from '@engine/shape-helper';
import { markAsEditorOnly } from '@engine/editor-layers';
import { showColorSourceDebug, hideColorSourceDebug, syncColorSourceDebug, isColorSourceDebugShown, type ColorSourceDebugState } from '@engine/color-source-debug';
import type { Doc } from '@engine/schema';

export type FurnitureHost = {
  doc: Doc;
  container: () => THREE.Object3D;
  particleSystem: () => any;
  /** Writes a path the gizmos changed and applies it at its cost. */
  changed: (path: string) => void;
};

let host: FurnitureHost | null = null;
const worldAxes = new THREE.AxesHelper(5);
const localAxes = new THREE.AxesHelper(1);
let planesShown = false;
let fieldsShown = false;
const emitterWorld = new THREE.Vector3();

const round = (v: number) => Math.round(v * 100) / 100;

const onPlaneDrag = (index: number, position: THREE.Vector3): void => {
  if (!host) return;
  const planes = host.doc.collisionPlanes;
  if (!planes || index >= planes.length) return;
  planes[index].position = { x: round(position.x), y: round(position.y), z: round(position.z) };
  host.changed(`collisionPlanes.${index}.position`);
};

const onFieldDrag = (index: number, position: THREE.Vector3): void => {
  if (!host) return;
  const fields = host.doc.forceFields;
  if (!fields || index >= fields.length) return;
  fields[index].position = { x: round(position.x), y: round(position.y), z: round(position.z) };
  host.changed(`forceFields.${index}.position`);
};

const onSourceDrag = (worldCenter: THREE.Vector3): void => {
  if (!host) return;
  const ci = host.doc.particleColorInstance;
  if (!ci) return;
  host.container().getWorldPosition(emitterWorld);
  ci.offset = { x: round(worldCenter.x - emitterWorld.x), y: round(worldCenter.y - emitterWorld.y), z: round(worldCenter.z - emitterWorld.z) };
  host.changed('particleColorInstance.offset');
};

export const installFurniture = (next: FurnitureHost): void => {
  host = next;
  markAsEditorOnly(worldAxes);
  markAsEditorOnly(localAxes);
};

/** Rebuilds the helpers from the document. Cheap enough to call on any related change. */
export const syncFurniture = (): void => {
  if (!host) return;
  const scene = getScene();
  const ed = host.doc._editorData ?? {};

  if (ed.showCollisionPlanes) {
    createCollisionPlaneHelpers(scene, host.doc.collisionPlanes ?? []);
    initCollisionPlaneInteraction(scene, onPlaneDrag);
    planesShown = true;
  } else if (planesShown) {
    deselectCollisionPlane();
    disposeCollisionPlaneInteraction();
    disposeCollisionPlaneHelpers(scene);
    planesShown = false;
  }

  if (ed.showForceFields) {
    createForceFieldHelpers(scene, host.doc.forceFields ?? []);
    initForceFieldInteraction(scene, onFieldDrag);
    fieldsShown = true;
  } else if (fieldsShown) {
    deselectForceField();
    disposeForceFieldInteraction();
    disposeForceFieldHelpers(scene);
    fieldsShown = false;
  }

  const ps = host.particleSystem();
  if (ps?.instance) updateShapeHelper(ps.instance, host.doc.shape, !!ed.showShape);

  if (ed.showWorldAxes) scene.add(worldAxes);
  else scene.remove(worldAxes);
  if (ed.showLocalAxes) host.container().add(localAxes);
  else host.container().remove(localAxes);
};

const debugState = (): ColorSourceDebugState => {
  const doc = host!.doc;
  const ci = doc.particleColorInstance ?? {};
  const plane = ci.plane || 'XZ';
  const rect = doc.shape?.rectangle?.scale;
  const rectW = rect?.x || 1;
  const rectH = rect?.y || 1;
  const area = ci.area || {};
  host!.container().getWorldPosition(emitterWorld);
  const offset = ci.offset || {};
  return {
    plane,
    areaAcross: plane === 'YZ' ? area.z || rectW : area.x || rectW,
    areaDown: plane === 'XZ' ? area.z || rectH : area.y || rectH,
    scaleX: ci.scale?.x ?? 1,
    scaleY: ci.scale?.y ?? 1,
    wrap: ci.wrap || 'ZERO',
    center: emitterWorld.clone().add(new THREE.Vector3(offset.x || 0, offset.y || 0, offset.z || 0)),
    map: ci.map,
  };
};

/** Every frame, like V1's onUpdate: the debug plane follows the mapping. */
export const syncFurnitureFrame = (): void => {
  if (!host) return;
  if (host.doc._editorData?.showColorSourceDebug) {
    showColorSourceDebug(getScene(), onSourceDrag);
    syncColorSourceDebug(debugState());
  } else if (isColorSourceDebugShown()) {
    hideColorSourceDebug();
  }
};

/** Paths whose change moves furniture. */
export const FURNITURE_PATHS = /^(collisionPlanes|forceFields|shape|_editorData\.(showCollisionPlanes|showForceFields|showShape|showWorldAxes|showLocalAxes))(\.|$)/;
