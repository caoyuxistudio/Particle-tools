/**
 * Gradient Editor Entries
 *
 * Colour over lifetime, edited as a visual gradient. Opacity used to ride along
 * on the stops' alpha; it now has its own section with its own curve (Opacity
 * over lifetime, under Size), so this editor writes colour only. Two editors
 * writing one field meant whichever was touched last silently won.
 */

import type { ParticleSystemConfig } from '@newkrok/three-particles';
import type { GUI } from 'three/examples/jsm/libs/lil-gui.module.min';
import {
  createGradientEditor,
  setGradientStops,
  setOnChangeCallback,
} from '@particle-tools/engine/gradient-editor/gradient-editor';
import {
  gradientToBezierCurves,
  bezierCurvesToGradient,
  getDefaultGradientStops,
  type GradientStop,
  type BezierCurve,
} from '@particle-tools/engine/gradient-editor/gradient-to-bezier';

type GradientEditorEntriesParams = {
  parentFolder: GUI;
  particleSystemConfig: ParticleSystemConfig;
  recreateParticleSystem: () => void;
};

let isInitialized = false;

/** A flat alpha of 1, for seeding gradient stops now that alpha is not edited here. */
const OPAQUE_CURVE: BezierCurve = {
  type: 'BEZIER',
  scale: 1,
  bezierPoints: [
    { x: 0, y: 1, percentage: 0 },
    { x: 1, y: 1, percentage: 1 },
  ],
} as BezierCurve;

/**
 * Initializes gradient editor data in _editorData if not present
 */
const ensureGradientDataExists = (config: ParticleSystemConfig): void => {
  if (!config._editorData) {
    (config as any)._editorData = {};
  }

  const editorData = (config as any)._editorData;

  if (!editorData.gradientStops) {
    // Try to convert existing bezier curves to gradient stops
    if (
      config.colorOverLifetime?.r &&
      config.colorOverLifetime?.g &&
      config.colorOverLifetime?.b &&
      config.opacityOverLifetime?.lifetimeCurve
    ) {
      // Convert existing colour curves to gradient stops. Alpha is not this
      // editor's to show any more, so the stops are seeded fully opaque.
      editorData.gradientStops = bezierCurvesToGradient(
        config.colorOverLifetime.r as BezierCurve,
        config.colorOverLifetime.g as BezierCurve,
        config.colorOverLifetime.b as BezierCurve,
        OPAQUE_CURVE,
        5 // Sample 5 stops
      );
    } else {
      // Use default gradient
      editorData.gradientStops = getDefaultGradientStops();
    }
  }
};

/**
 * Ensures colorOverLifetime and opacityOverLifetime structures exist
 */
const ensureConfigStructures = (config: ParticleSystemConfig): void => {
  // Ensure colorOverLifetime exists
  if (!config.colorOverLifetime) {
    (config as any).colorOverLifetime = {
      isActive: false,
      r: { type: 'BEZIER', scale: 1, bezierPoints: [] },
      g: { type: 'BEZIER', scale: 1, bezierPoints: [] },
      b: { type: 'BEZIER', scale: 1, bezierPoints: [] },
    };
  }

  // Ensure opacityOverLifetime exists
  if (!config.opacityOverLifetime) {
    (config as any).opacityOverLifetime = {
      isActive: false,
      lifetimeCurve: { type: 'BEZIER', scale: 1, bezierPoints: [] },
    };
  }
};

/**
 * Updates the colour curves from gradient stops. Opacity is left alone — it
 * belongs to the Opacity over lifetime section.
 */
const updateBeziersFromGradient = (config: ParticleSystemConfig, stops: GradientStop[]): void => {
  const curves = gradientToBezierCurves(stops);

  if (config.colorOverLifetime) {
    config.colorOverLifetime.r = curves.r;
    config.colorOverLifetime.g = curves.g;
    config.colorOverLifetime.b = curves.b;
  }
};

/**
 * Creates the gradient editor UI
 */
export const createGradientEditorEntries = ({
  parentFolder,
  particleSystemConfig,
  recreateParticleSystem,
}: GradientEditorEntriesParams): Record<string, unknown> => {
  const folder = parentFolder.addFolder('Color over lifetime (Gradient)');
  folder.close();

  ensureConfigStructures(particleSystemConfig);
  ensureGradientDataExists(particleSystemConfig);

  const editorData = (particleSystemConfig as any)._editorData;

  const uiState = {
    enabled: particleSystemConfig.colorOverLifetime?.isActive || false,
  };

  folder
    .add(uiState, 'enabled')
    .name('Enable')
    .onChange((value: boolean) => {
      if (particleSystemConfig.colorOverLifetime) {
        particleSystemConfig.colorOverLifetime.isActive = value;
      }
      recreateParticleSystem();
    })
    .listen();

  // Button to open gradient editor
  folder
    .add(
      {
        openEditor: (): void => {
          // Show the gradient editor modal/panel
          const modal = document.querySelector('.gradient-editor-modal') as HTMLElement;
          if (modal) {
            modal.style.display = 'block';

            const onChange = (stops: GradientStop[]) => {
              // Save stops to editor data
              editorData.gradientStops = stops;

              // Update bezier curves
              updateBeziersFromGradient(particleSystemConfig, stops);

              // Auto-enable colour when the gradient is edited
              if (particleSystemConfig.colorOverLifetime) {
                particleSystemConfig.colorOverLifetime.isActive = true;
              }
              uiState.enabled = true;

              // Recreate particle system
              recreateParticleSystem();
            };

            // Initialize editor if not done yet
            if (!isInitialized) {
              createGradientEditor(editorData.gradientStops, onChange);
              isInitialized = true;
            } else {
              // Update existing editor with current config's stops and callback
              setOnChangeCallback(onChange);
              setGradientStops(editorData.gradientStops);
            }
          }
        },
      },
      'openEditor'
    )
    .name('Edit Gradient');

  // Reset to default gradient
  folder
    .add(
      {
        reset: (): void => {
          const defaultStops = getDefaultGradientStops();
          editorData.gradientStops = defaultStops;
          setGradientStops(defaultStops);
          updateBeziersFromGradient(particleSystemConfig, defaultStops);
          recreateParticleSystem();
        },
      },
      'reset'
    )
    .name('Reset to Default');

  return {
    onReset: () => {
      // Sync UI state from the current config (which may have been loaded/reset)
      uiState.enabled = particleSystemConfig.colorOverLifetime?.isActive || false;
      isInitialized = false;
    },
  };
};
