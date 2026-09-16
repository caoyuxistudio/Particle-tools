/**
 * The colour source, shown where it maps.
 *
 * A debug plane for Particle Color Instance: the source image (or the video's
 * current frame) laid on the plane the spawn positions are projected onto, at
 * the mapped area's size and position, with the same scale and wrap the
 * library applies at birth — so what the plane shows is what a particle born
 * under a point of it is coloured. Drawn over everything (no depth test) at
 * 20% opacity, inside a green frame with a label, and only in the editor: the
 * whole group sits on the furniture layer, so the output camera, the preview
 * and the player never see it.
 *
 * It is also the handle for the source's `offset`: click the plane and a
 * translate gizmo appears, restricted to the plane's own two axes; dragging
 * reports the plane's new centre and the entries turn that into the config's
 * offset. Same pattern as collision-plane-interaction.ts.
 */
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { clamp, float, floor, fract, select, texture, uniform, uv, vec2 } from 'three/tsl';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

import { getCamera, getOrbitControls, getRendererDomElement } from './world';
import { getCollisionPlaneCenterMeshes } from './collision-plane-helper';
import { EDITOR_LAYER, markAsEditorOnly } from './editor-layers';

export type ColorSourcePlane = 'XZ' | 'XY' | 'YZ';
export type ColorSourceWrap = 'ZERO' | 'REPEAT' | 'MIRROR' | 'STRETCH';

/** Everything the plane needs to show the mapping, resolved by the entries. */
export type ColorSourceDebugState = {
  plane: ColorSourcePlane;
  /** The mapped area: across the source and down it, in world units. */
  areaAcross: number;
  areaDown: number;
  scaleX: number;
  scaleY: number;
  wrap: ColorSourceWrap;
  /** The source's centre in world space: the emitter plus the offset. */
  center: THREE.Vector3;
  map: THREE.Texture | undefined;
};

export const COLOR_SOURCE_DEBUG_NAME = 'color-source-debug';
export const COLOR_SOURCE_DEBUG_OPACITY = 0.2;
export const COLOR_SOURCE_DEBUG_COLOR = 0x33ff88;
const LABEL = 'COLOR SOURCE · debug';

const WRAP_INDEX: Record<ColorSourceWrap, number> = { ZERO: 0, REPEAT: 1, MIRROR: 2, STRETCH: 3 };

let group: THREE.Group | null = null;
let box: THREE.Group | null = null;
let planeMesh: THREE.Mesh | null = null;
let label: THREE.Sprite | null = null;
let placeholder: THREE.DataTexture | null = null;
let textureNode: ReturnType<typeof texture> | null = null;
let currentMap: THREE.Texture | undefined;
const uScaleX = uniform(1);
const uScaleY = uniform(1);
const uWrap = uniform(0);
const uFlipY = uniform(0);
const uShow = uniform(0);

let transformControls: TransformControls | null = null;
let scene: THREE.Scene | null = null;
let onDragCallback: ((worldCenter: THREE.Vector3) => void) | null = null;
let selected = false;
let dragging = false;
let listening = false;
let currentPlane: ColorSourcePlane = 'XZ';

const raycaster = new THREE.Raycaster();
raycaster.layers.enable(EDITOR_LAYER);
const mouse = new THREE.Vector2();

// ─── Building ────────────────────────────────────────────────────────────────

/**
 * The plane's material: the source sampled through the library's own
 * mapping. The plane's uv runs 0..1 across and, with v = 1 at the top, up;
 * the source's rows run down, so `down = 1 − v`. Scale is about the centre,
 * wrap is the same four cases as spawnToUv, and under ZERO the part of the
 * area off the source is left fully transparent. The textures here are
 * uploaded with flipY off (row 0 at v = 0), so the sampled v is the row
 * coordinate itself; a texture that flips is flipped back.
 */
const buildMaterial = (): MeshBasicNodeMaterial => {
  placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  placeholder.needsUpdate = true;

  const across = uv().x;
  const down = float(1).sub(uv().y);
  const u = across.sub(0.5).div(uScaleX).add(0.5);
  const v = down.sub(0.5).div(uScaleY).add(0.5);
  const wrapT = (t: ReturnType<typeof float>) => {
    const m = t.sub(floor(t.div(2)).mul(2));
    const mirrored = select(m.greaterThan(1), float(2).sub(m), m);
    return select(
      uWrap.equal(1),
      fract(t),
      select(uWrap.equal(2), mirrored, select(uWrap.equal(3), clamp(t, 0, 1), t))
    );
  };
  const uu = wrapT(u);
  const vv = wrapT(v);
  const off = u.lessThan(0).or(u.greaterThan(1)).or(v.lessThan(0)).or(v.greaterThan(1));
  const texV = select(uFlipY.equal(1), float(1).sub(vv), vv);
  textureNode = texture(placeholder, vec2(uu, texV));

  const material = new MeshBasicNodeMaterial();
  material.colorNode = textureNode.rgb;
  material.opacityNode = select(
    uShow.equal(0).or(uWrap.equal(0).and(off)),
    float(0),
    float(COLOR_SOURCE_DEBUG_OPACITY)
  );
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  return material;
};

const buildLabel = (): THREE.Sprite => {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#33ff88';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
  ctx.fillStyle = '#33ff88';
  ctx.font = 'bold 44px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(LABEL, canvas.width / 2, canvas.height / 2 + 2);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = 'color-source-debug-label';
  sprite.scale.set(2.4, 0.45, 1);
  sprite.renderOrder = 10000;
  return sprite;
};

const build = (targetScene: THREE.Scene): void => {
  group = new THREE.Group();
  group.name = COLOR_SOURCE_DEBUG_NAME;
  group.userData.colorSourceDebug = true;
  group.userData.selected = false;

  // The box is the mapped area: a unit square scaled to it, so the plane and
  // the frame resize together.
  box = new THREE.Group();
  box.name = 'color-source-debug-box';

  planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), buildMaterial());
  planeMesh.name = 'color-source-debug-plane';
  planeMesh.renderOrder = 9998;
  box.add(planeMesh);

  const corners = [
    new THREE.Vector3(-0.5, -0.5, 0),
    new THREE.Vector3(0.5, -0.5, 0),
    new THREE.Vector3(0.5, 0.5, 0),
    new THREE.Vector3(-0.5, 0.5, 0),
  ];
  const frame = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(corners),
    new THREE.LineBasicMaterial({
      color: COLOR_SOURCE_DEBUG_COLOR,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
  );
  frame.name = 'color-source-debug-frame';
  frame.renderOrder = 9999;
  box.add(frame);
  group.add(box);

  label = buildLabel();
  group.add(label);

  markAsEditorOnly(group);
  targetScene.add(group);
};

// ─── The handle ──────────────────────────────────────────────────────────────

const hitsGizmo = (event: PointerEvent): boolean => {
  if (!transformControls || !selected) return false;
  const rect = getRendererDomElement().getBoundingClientRect();
  const point = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  const picker = new THREE.Raycaster();
  picker.layers.enable(EDITOR_LAYER);
  picker.setFromCamera(point, getCamera());
  return picker.intersectObjects(transformControls.getHelper().children, true).length > 0;
};

const select_ = (): void => {
  if (!transformControls || !scene || !group || selected) return;
  selected = true;
  group.userData.selected = true;
  transformControls.attach(group);
  applyAxes();
  const gizmo = transformControls.getHelper();
  markAsEditorOnly(gizmo);
  scene.add(gizmo);
};

const deselect = (): void => {
  if (!transformControls || !selected) return;
  selected = false;
  if (group) group.userData.selected = false;
  transformControls.detach();
  scene?.remove(transformControls.getHelper());
};

/** Only the plane's own two axes move the source; the normal is meaningless. */
const applyAxes = (): void => {
  if (!transformControls) return;
  transformControls.showX = currentPlane !== 'YZ';
  transformControls.showY = currentPlane !== 'XZ';
  transformControls.showZ = currentPlane !== 'XY';
};

const onPointerDown = (event: PointerEvent): void => {
  if (!group || !group.visible || !planeMesh) return;
  const rect = getRendererDomElement().getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, getCamera());

  // A collision plane's handle in front takes the click; two gizmos at once
  // would fight over the drag.
  const centers = getCollisionPlaneCenterMeshes();
  if (centers.length > 0 && raycaster.intersectObjects(centers, false).length > 0) return;

  if (raycaster.intersectObject(planeMesh, false).length > 0) {
    select_();
    event.stopPropagation();
  } else if (!hitsGizmo(event)) {
    deselect();
  }
};

const installInteraction = (): void => {
  if (listening) return;
  const domElement = getRendererDomElement();
  transformControls = new TransformControls(getCamera(), domElement);
  transformControls.getRaycaster().layers.enable(EDITOR_LAYER);
  transformControls.setMode('translate');
  transformControls.setSize(0.8);
  transformControls.addEventListener('dragging-changed', (event) => {
    dragging = !!event.value;
    getOrbitControls().enabled = !event.value;
  });
  transformControls.addEventListener('change', () => {
    if (!dragging || !selected || !group) return;
    onDragCallback?.(group.position);
  });
  domElement.addEventListener('pointerdown', onPointerDown);
  listening = true;
};

// ─── Public ──────────────────────────────────────────────────────────────────

/** Shows the plane (building it on first use) and takes the drag handler. */
export const showColorSourceDebug = (
  targetScene: THREE.Scene,
  onDrag: (worldCenter: THREE.Vector3) => void
): void => {
  scene = targetScene;
  onDragCallback = onDrag;
  if (!group) build(targetScene);
  else if (group.parent !== targetScene) targetScene.add(group);
  group!.visible = true;
  installInteraction();
};

export const hideColorSourceDebug = (): void => {
  deselect();
  if (group) group.visible = false;
};

export const isColorSourceDebugShown = (): boolean => !!group && group.visible;
export const isColorSourceDebugSelected = (): boolean => selected;
export const isColorSourceDebugDragging = (): boolean => dragging;

/**
 * Puts the plane where the mapping is, every frame: plane orientation, the
 * area's size, the centre (left alone mid-drag — the gizmo owns it then), the
 * source texture and the scale / wrap uniforms.
 */
export const syncColorSourceDebug = (state: ColorSourceDebugState): void => {
  if (!group || !box || !planeMesh || !label || !textureNode) return;

  currentPlane = state.plane;
  if (state.plane === 'XY') group.rotation.set(0, 0, 0);
  else if (state.plane === 'YZ') group.rotation.set(0, Math.PI / 2, 0);
  else group.rotation.set(-Math.PI / 2, 0, 0);
  if (selected) applyAxes();

  if (!dragging) group.position.copy(state.center);

  const across = Math.max(1e-3, state.areaAcross);
  const down = Math.max(1e-3, state.areaDown);
  box.scale.set(across, down, 1);
  // The label rides the top-left corner of the frame, just outside it.
  label.position.set(-across / 2 + label.scale.x / 2, down / 2 + label.scale.y * 0.7, 0);

  uScaleX.value = Math.max(1e-3, state.scaleX || 1);
  uScaleY.value = Math.max(1e-3, state.scaleY || 1);
  uWrap.value = WRAP_INDEX[state.wrap] ?? 0;

  if (state.map !== currentMap) {
    currentMap = state.map;
    textureNode.value = state.map ?? placeholder!;
  }
  uFlipY.value = state.map?.flipY ? 1 : 0;
  uShow.value = state.map ? 1 : 0;
};

export const disposeColorSourceDebug = (): void => {
  deselect();
  if (listening) {
    getRendererDomElement().removeEventListener('pointerdown', onPointerDown);
    transformControls?.dispose();
    transformControls = null;
    listening = false;
  }
  if (group) {
    scene?.remove(group);
    group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = (mesh as THREE.Mesh).material as THREE.Material | undefined;
      if (material?.dispose) material.dispose();
    });
    group = null;
    box = null;
    planeMesh = null;
    label = null;
    textureNode = null;
    currentMap = undefined;
  }
  scene = null;
  onDragCallback = null;
};
