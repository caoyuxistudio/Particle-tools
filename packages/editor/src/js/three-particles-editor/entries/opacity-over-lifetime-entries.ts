import { openBezierEditorModal } from '@particle-tools/engine/curve-editor/curve-editor';
import { createLifetimeCurveFolderEntry } from './entry-helpers-v2';
import type { ParticleSystemConfig } from '@newkrok/three-particles';
// LifeTimeCurve is a const enum, using string literals directly
// Use direct import instead of @types
import type { GUI } from 'three/examples/jsm/libs/lil-gui.module.min';

type OpacityOverLifeTimeEntriesParams = {
  parentFolder: GUI;
  particleSystemConfig: ParticleSystemConfig;
  recreateParticleSystem: () => void;
};

/**
 * "Opacity over lifetime" — the alpha twin of Size over lifetime, with the same
 * curve editor. This section owns `opacityOverLifetime`; the gradient editor
 * next to it is colour only.
 *
 * What a curve does on screen depends on the renderer: with
 * `renderer.transparent` off the alpha is not blended, and the only visible
 * effect is the hard cut where it drops below the discard threshold — the
 * popping this section exists to remove. For a fade, turn `transparent` on
 * (and, for a dense cloud, consider `depthWrite` off).
 */
export const createOpacityOverLifeTimeEntries = ({
  parentFolder,
  particleSystemConfig,
  recreateParticleSystem,
}: OpacityOverLifeTimeEntriesParams): Record<string, unknown> => {
  const folder = parentFolder.addFolder('Opacity over lifetime');
  folder.close();

  // Ensure the opacityOverLifetime object exists and has the correct structure for v2.0.2
  if (!particleSystemConfig.opacityOverLifetime) {
    particleSystemConfig.opacityOverLifetime = {
      isActive: false,
      lifetimeCurve: {
        type: 'BEZIER',
        bezierPoints: [
          { x: 0, y: 0, percentage: 0 },
          { x: 1, y: 1, percentage: 1 },
        ],
      } as any,
    };
  }

  folder
    .add(particleSystemConfig.opacityOverLifetime, 'isActive')
    .onChange(recreateParticleSystem)
    .listen();

  // Use the createLifetimeCurveFolderEntry helper to create UI for the lifetimeCurve
  createLifetimeCurveFolderEntry({
    particleSystemConfig,
    recreateParticleSystem,
    parentFolder: folder,
    rootPropertyName: 'opacityOverLifetime',
    propertyName: 'lifetimeCurve',
  });

  folder
    .add(
      {
        editCurve: (): void => {
          const lifetimeCurve = particleSystemConfig.opacityOverLifetime.lifetimeCurve;
          openBezierEditorModal(lifetimeCurve, () => {
            recreateParticleSystem();
          });
        },
      },
      'editCurve'
    )
    .name('Edit Curve');

  return {};
};
