import { MeshGeometryType, createGeometry, type MeshGeometryTypeValue } from '@particle-tools/engine/mesh-geometry';
import type { GUI } from 'three/examples/jsm/libs/lil-gui.module.min';

export { MeshGeometryType, createGeometry };

type MeshEntriesParams = {
  parentFolder: GUI;
  particleSystemConfig: any;
  recreateParticleSystem: () => void;
};

type MeshEntriesResult = {
  onReset: () => void;
  onParticleSystemChange: () => void;
  onUpdate: () => void;
};

const ensureMeshConfig = (particleSystemConfig: any): void => {
  if (!particleSystemConfig.renderer.mesh) {
    particleSystemConfig.renderer.mesh = {};
  }

  const mesh = particleSystemConfig.renderer.mesh;
  if (!mesh.geometryType) mesh.geometryType = MeshGeometryType.BOX;
  if (!mesh.scale) mesh.scale = { x: 1, y: 1, z: 1 };
  if (mesh.alignToVelocity === undefined) mesh.alignToVelocity = false;
  if (mesh.velocityStretch === undefined) mesh.velocityStretch = 0;
  if (mesh.lit === undefined) mesh.lit = false;
  if (mesh.emissive === undefined) mesh.emissive = 0;
  if (mesh.roughness === undefined) mesh.roughness = 0.65;
  if (mesh.metalness === undefined) mesh.metalness = 0;
  mesh.geometry = createGeometry(mesh.geometryType);
};

export const createMeshEntries = ({
  parentFolder,
  particleSystemConfig,
  recreateParticleSystem,
}: MeshEntriesParams): MeshEntriesResult => {
  const folder = parentFolder.addFolder('Mesh');
  folder.close();

  let controllers: any[] = [];

  const rebuild = (): void => {
    controllers.forEach((controller) => controller.destroy());
    controllers = [];

    const isMesh = particleSystemConfig.renderer.rendererType === 'MESH';

    if (!isMesh) {
      controllers.push(
        folder
          .add({ info: 'Set Renderer Type to MESH to configure' }, 'info')
          .name('Info')
          .disable()
      );
      return;
    }

    ensureMeshConfig(particleSystemConfig);
    const mesh = particleSystemConfig.renderer.mesh;

    controllers.push(
      folder
        .add(mesh, 'geometryType', Object.values(MeshGeometryType))
        .name('Geometry')
        .onChange((value: MeshGeometryTypeValue) => {
          mesh.geometry = createGeometry(value);
          recreateParticleSystem();
        })
        .listen()
    );

    // Master size: drives all three axes at once. Kept as editor-only state
    // (derived from scale.x) so the saved config stays a plain per-axis scale.
    const uniformScale = { size: mesh.scale.x };

    controllers.push(
      folder
        .add(uniformScale, 'size', 0.01, 5, 0.01)
        .name('Size (all axes)')
        .onChange((value: number) => {
          mesh.scale.x = value;
          mesh.scale.y = value;
          mesh.scale.z = value;
          recreateParticleSystem();
        })
    );

    controllers.push(
      folder
        .add(mesh, 'alignToVelocity')
        .name('align to velocity (+Z = heading)')
        .onChange(recreateParticleSystem)
        .listen()
    );

    // A motion-blur streak: the mesh is lengthened along its heading by the
    // distance the particle covers in this many seconds, trailing behind it.
    // Brings alignment with it.
    controllers.push(
      folder
        .add(mesh, 'velocityStretch', 0, 1, 0.005)
        .name('velocity stretch (s of travel)')
        .onChange(recreateParticleSystem)
        .listen()
    );

    // Off by default: an unlit particle carries a built-in fake headlight, so
    // turning this on in a scene with no lights renders the cloud black.
    controllers.push(
      folder
        .add(mesh, 'lit')
        .name('lit (use scene lights)')
        .onChange(recreateParticleSystem)
        .listen()
    );

    controllers.push(
      folder
        .add(mesh, 'emissive', 0, 4, 0.01)
        .name('emissive (needs lit)')
        .onChange(recreateParticleSystem)
        .listen()
    );

    // The surface itself. The particle's colour is its albedo already (start
    // colour, gradient, or the pixel a Color Instance sampled); these decide
    // how the lights sit on it. Matte and non-metal is the shipped look.
    controllers.push(
      folder
        .add(mesh, 'roughness', 0, 1, 0.01)
        .name('roughness (needs lit)')
        .onChange(recreateParticleSystem)
        .listen()
    );
    controllers.push(
      folder
        .add(mesh, 'metalness', 0, 1, 0.01)
        .name('metalness (needs lit)')
        .onChange(recreateParticleSystem)
        .listen()
    );

    const scaleFolder = folder.addFolder('scale');
    (['x', 'y', 'z'] as const).forEach((axis) => {
      controllers.push(
        scaleFolder
          .add(mesh.scale, axis, 0.01, 5, 0.01)
          .onChange(() => {
            uniformScale.size = mesh.scale.x;
            recreateParticleSystem();
          })
          .listen()
      );
    });
    controllers.push(scaleFolder);
  };

  rebuild();

  let lastRendererType = particleSystemConfig.renderer.rendererType || 'POINTS';

  return {
    onReset: rebuild,
    onParticleSystemChange: (): void => {
      const currentRendererType = particleSystemConfig.renderer.rendererType || 'POINTS';
      if (lastRendererType !== currentRendererType) {
        lastRendererType = currentRendererType;
        rebuild();
      }
    },
    onUpdate: (): void => {},
  };
};
