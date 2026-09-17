// What the editor draws on the scene's objects so their structure reads
// (V2-ARCHITECTURE.md §1.1, furniture): a wire over every mesh's edges, a
// camera body on a camera, a lamp on a light and an arrow along a
// directional light's aim. All on the furniture layer — the output camera,
// the preview and the player never see any of it. Kept in step every frame,
// which is cheap for a scene of a few objects.

import * as THREE from 'three';
import { getScene } from '@engine/world';
import { getSceneObjects, getLiveObject } from '@engine/scene-objects';
import { markAsEditorOnly } from '@engine/editor-layers';

/** The ground wireframe's brightness (world.ts setTerrain), as asked: one grey for all structure. */
const WIRE = 0x242424;
const WIRE_STRONG = 0x8a8a8a;
const LAMP = 0xffd27a;

const DECOR = 'studio-decor';
const wireMaterial = new THREE.LineBasicMaterial({ color: WIRE });
const strongMaterial = new THREE.LineBasicMaterial({ color: WIRE_STRONG });
const lampMaterial = new THREE.LineBasicMaterial({ color: LAMP });

const tag = (o: THREE.Object3D, kind: string): THREE.Object3D => {
  o.name = `${DECOR}:${kind}`;
  o.userData.decor = kind;
  markAsEditorOnly(o);
  return o;
};

const decorOf = (parent: THREE.Object3D, kind: string): THREE.Object3D | undefined =>
  parent.children.find((c) => c.userData.decor === kind);

// ─── a wire over a mesh's edges ──────────────────────────────────────────────

const ensureWire = (mesh: THREE.Mesh): void => {
  const existing = decorOf(mesh, 'wire');
  if (existing && existing.userData.geometryId === mesh.geometry.uuid) return;
  if (existing) {
    mesh.remove(existing);
    (existing as THREE.LineSegments).geometry.dispose();
  }
  const edges = new THREE.EdgesGeometry(mesh.geometry, 18);
  const wire = new THREE.LineSegments(edges, wireMaterial);
  wire.userData.geometryId = mesh.geometry.uuid;
  // A hair outside the surface, so coplanar lines are not eaten by the faces.
  wire.scale.setScalar(1.003);
  wire.renderOrder = 1;
  mesh.add(tag(wire, 'wire'));
};

const wireMeshes = (root: THREE.Object3D): void => {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.userData.decor && !(o.parent?.userData.decor)) ensureWire(o as THREE.Mesh);
  });
};

// ─── a camera body ───────────────────────────────────────────────────────────

const cameraBody = (): THREE.Object3D => {
  const group = new THREE.Group();
  const edges = (geometry: THREE.BufferGeometry, material = strongMaterial) =>
    new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), material);
  // The body, behind the lens; a camera looks down its −Z.
  const body = edges(new THREE.BoxGeometry(0.5, 0.34, 0.6));
  body.position.z = 0.3;
  group.add(body);
  const lens = edges(new THREE.CylinderGeometry(0.11, 0.14, 0.26, 16));
  lens.rotation.x = Math.PI / 2;
  lens.position.z = -0.13;
  group.add(lens);
  // Two reels on top: the silhouette everyone reads as "camera".
  for (const x of [-0.16, 0.16]) {
    const reel = edges(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 16));
    reel.rotation.z = Math.PI / 2;
    reel.position.set(x, 0.3, 0.32);
    group.add(reel);
  }
  return group;
};

// ─── lamps ───────────────────────────────────────────────────────────────────

const pointLamp = (): THREE.Object3D => {
  const group = new THREE.Group();
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.16, 0)), lampMaterial));
  const rays: THREE.Vector3[] = [];
  for (const d of [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [1, 1, 1], [-1, 1, 1], [1, -1, 1], [1, 1, -1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1],
  ]) {
    const v = new THREE.Vector3(...(d as [number, number, number])).normalize();
    rays.push(v.clone().multiplyScalar(0.24), v.clone().multiplyScalar(0.42));
  }
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rays), lampMaterial));
  return group;
};

const sunLamp = (): THREE.Object3D => {
  const group = new THREE.Group();
  const circle: THREE.Vector3[] = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    circle.push(new THREE.Vector3(Math.cos(a) * 0.22, Math.sin(a) * 0.22, 0));
  }
  const disc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(circle), lampMaterial);
  group.add(disc);
  const rays: THREE.Vector3[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const v = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    rays.push(v.clone().multiplyScalar(0.3), v.clone().multiplyScalar(0.44));
  }
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rays), lampMaterial));
  // The disc faces the light's aim (a child of the light, which THREE points at its target).
  return group;
};

/** World-space arrows along each directional light's aim, keyed by object id. */
const aims = new Map<string, THREE.ArrowHelper>();
const from = new THREE.Vector3();
const to = new THREE.Vector3();

// ─── the sync ────────────────────────────────────────────────────────────────

export const syncSceneDecor = (): void => {
  const scene = getScene();
  const seen = new Set<string>();
  for (const obj of getSceneObjects()) {
    seen.add(obj.id);
    const three = getLiveObject(obj.id);
    if (!three) continue;
    switch (obj.type) {
      case 'BOX':
      case 'SPHERE':
      case 'FRAME':
        wireMeshes(three);
        break;
      case 'CAMERA':
        if (!decorOf(three, 'camera')) three.add(tag(cameraBody(), 'camera'));
        break;
      case 'POINT_LIGHT':
        if (!decorOf(three, 'lamp')) three.add(tag(pointLamp(), 'lamp'));
        break;
      case 'DIRECTIONAL_LIGHT': {
        if (!decorOf(three, 'lamp')) three.add(tag(sunLamp(), 'lamp'));
        let arrow = aims.get(obj.id);
        if (!arrow) {
          arrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(), 1, LAMP, 0.3, 0.15);
          tag(arrow, 'aim');
          aims.set(obj.id, arrow);
          scene.add(arrow);
        }
        const light = three as THREE.DirectionalLight;
        light.getWorldPosition(from);
        light.target.getWorldPosition(to);
        const dir = to.clone().sub(from);
        const length = Math.min(Math.max(dir.length(), 0.5), 6);
        arrow.position.copy(from);
        arrow.setDirection(dir.normalize());
        arrow.setLength(length, Math.min(0.4, length * 0.25), Math.min(0.2, length * 0.12));
        arrow.visible = light.visible;
        // The sun's disc looks along the aim too.
        const lamp = decorOf(three, 'lamp');
        if (lamp) lamp.lookAt(to);
        break;
      }
      default:
        break;
    }
  }
  for (const [id, arrow] of aims) {
    if (!seen.has(id)) {
      scene.remove(arrow);
      arrow.dispose();
      aims.delete(id);
    }
  }
};
