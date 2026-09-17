// The MESH particle's geometry catalogue. Engine side (V2-ARCHITECTURE.md §1):
// particle-factory builds the geometry from config.renderer.mesh.geometryType,
// the lil-gui entries only list the names.
import * as THREE from 'three';

export const MeshGeometryType = {
  BOX: 'BOX',
  SPHERE: 'SPHERE',
  ICOSAHEDRON: 'ICOSAHEDRON',
  TORUS: 'TORUS',
  TORUS_KNOT: 'TORUS_KNOT',
  CYLINDER: 'CYLINDER',
  CONE: 'CONE',
  DODECAHEDRON: 'DODECAHEDRON',
  OCTAHEDRON: 'OCTAHEDRON',
  TETRAHEDRON: 'TETRAHEDRON',
} as const;

export type MeshGeometryTypeValue = (typeof MeshGeometryType)[keyof typeof MeshGeometryType];

export const createGeometry = (type: MeshGeometryTypeValue): THREE.BufferGeometry => {
  switch (type) {
    case MeshGeometryType.BOX:
      return new THREE.BoxGeometry(1, 1, 1);
    case MeshGeometryType.SPHERE:
      return new THREE.SphereGeometry(0.5, 16, 12);
    case MeshGeometryType.ICOSAHEDRON:
      return new THREE.IcosahedronGeometry(0.5, 0);
    case MeshGeometryType.TORUS:
      return new THREE.TorusGeometry(0.4, 0.15, 12, 24);
    case MeshGeometryType.TORUS_KNOT:
      return new THREE.TorusKnotGeometry(0.35, 0.1, 48, 8);
    case MeshGeometryType.CYLINDER:
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
    case MeshGeometryType.CONE:
      return new THREE.ConeGeometry(0.5, 1, 16);
    case MeshGeometryType.DODECAHEDRON:
      return new THREE.DodecahedronGeometry(0.5, 0);
    case MeshGeometryType.OCTAHEDRON:
      return new THREE.OctahedronGeometry(0.5, 0);
    case MeshGeometryType.TETRAHEDRON:
      return new THREE.TetrahedronGeometry(0.5, 0);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
};
