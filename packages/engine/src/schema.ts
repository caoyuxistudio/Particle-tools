// The parameter table (V2-ARCHITECTURE.md §2.2): every field of the document
// as data — path, kind, range, options, label, where it sits, when it shows,
// and what changing it costs the engine. V1's lil-gui panel is the reference
// this was transcribed from (2026-09-17); the harness's schemaReport checks
// every controller of that panel against this table, and the jest test checks
// that the library's default config is covered. The inspector of a studio is
// a renderer of this table and nothing else.
//
// Engine side: it describes what the engine eats, so it lives inside the
// engine boundary and the UI only reads it.

import { getDefaultParticleSystemConfig } from '@newkrok/three-particles';

/**
 * What applying a change costs (V2-ARCHITECTURE.md §2.2):
 * - `live`: `particleSystem.updateConfig(partial)` takes it, nothing is rebuilt.
 * - `rebuild`: the particle system is disposed and created again (V1's
 *   `recreateParticleSystem`); buffers, curves and materials are remade.
 * - `structural`: baked into the GPU kernel or material at creation — a
 *   rebuild that also recompiles shaders (feature on/off flags, the noise
 *   choices, the renderer type, particle counts).
 * V1 treats the last two the same (both are a full recreate); the distinction
 * is kept so a studio can tell the user, and so a future engine can skip the
 * recompile when only a rebuild is due.
 */
export type ChangeLevel = 'live' | 'rebuild' | 'structural';

export type FieldKind =
  | 'number'
  | 'int'
  | 'bool'
  | 'enum'
  | 'color'
  | 'vec2'
  | 'vec3'
  /** Constant | { min, max } (| LifetimeCurve when `allowCurve`) — V1 shows min/max. */
  | 'value'
  /** { min: color, max: color } */
  | 'minmaxColor'
  /** A LifetimeCurve edited in the curve editor; `scale` is its one slider. */
  | 'curve'
  /** Three LifetimeCurves (r, g, b) edited together in the gradient editor. */
  | 'gradient'
  /** A texture id from the registry, chosen in the texture selector. */
  | 'texture'
  /** An array of items; `item` describes one. */
  | 'list'
  /** In the document but not on a panel (owned by another UI, or derived). */
  | 'hidden';

export type Doc = Record<string, any>;

export type Option = { value: string | number; label: string };

export type Field = {
  /** Dotted path from the document root, e.g. `emission.rateOverTime`. */
  path: string;
  kind: FieldKind;
  label: string;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Option[];
  /** Shown only while this holds; hidden fields are also exempt from coverage. */
  when?: (doc: Doc) => boolean;
  change: ChangeLevel;
  /** kind === 'list': the fields of one item, paths relative to the item. */
  item?: Group;
  /** kind === 'value': a LifetimeCurve is accepted too. */
  allowCurve?: boolean;
  /** The panel shows value × this (trail width is stored in world units, shown ×100). */
  displayScale?: number;
  /** Lives under `_editorData` or otherwise never reaches the particle system. */
  editorOnly?: boolean;
};

export type Group = {
  id: string;
  label: string;
  fields: Field[];
  groups?: Group[];
  when?: (doc: Doc) => boolean;
};

// ─── small builders ──────────────────────────────────────────────────────────

const num = (
  path: string,
  label: string,
  min: number,
  max: number,
  step: number,
  change: ChangeLevel,
  extra: Partial<Field> = {}
): Field => ({ path, kind: 'number', label, min, max, step, change, ...extra });
const int = (
  path: string,
  label: string,
  min: number,
  max: number,
  change: ChangeLevel,
  extra: Partial<Field> = {}
): Field => ({ path, kind: 'int', label, min, max, step: 1, change, ...extra });
const bool = (
  path: string,
  label: string,
  change: ChangeLevel,
  extra: Partial<Field> = {}
): Field => ({ path, kind: 'bool', label, change, ...extra });
const opts = (values: (string | number)[], labels?: string[]): Option[] =>
  values.map((value, i) => ({ value, label: labels?.[i] ?? String(value) }));
const enumF = (
  path: string,
  label: string,
  options: Option[],
  change: ChangeLevel,
  extra: Partial<Field> = {}
): Field => ({ path, kind: 'enum', label, options, change, ...extra });
const value = (
  path: string,
  label: string,
  min: number,
  max: number,
  step: number,
  change: ChangeLevel,
  extra: Partial<Field> = {}
): Field => ({ path, kind: 'value', label, min, max, step, change, ...extra });
const vec3 = (
  path: string,
  label: string,
  min: number,
  max: number,
  step: number,
  change: ChangeLevel,
  extra: Partial<Field> = {}
): Field => ({ path, kind: 'vec3', label, min, max, step, change, ...extra });
const vec2 = (
  path: string,
  label: string,
  min: number,
  max: number,
  step: number,
  change: ChangeLevel,
  extra: Partial<Field> = {}
): Field => ({ path, kind: 'vec2', label, min, max, step, change, ...extra });
const hidden = (path: string, label: string, extra: Partial<Field> = {}): Field => ({
  path,
  kind: 'hidden',
  label,
  change: 'rebuild',
  ...extra,
});

const isMesh = (doc: Doc): boolean => doc.renderer?.rendererType === 'MESH';
const isTrail = (doc: Doc): boolean => doc.renderer?.rendererType === 'TRAIL';

// ─── the table ───────────────────────────────────────────────────────────────

/** Top-level groups in V1's panel order. */
export const schema: Group[] = [
  {
    id: 'helper',
    label: 'Helper',
    fields: [
      enumF(
        '_editorData.simulation.movements',
        'Simulate movements',
        opts([
          'DISABLED',
          'PROJECTILE_STRAIGHT',
          'PROJECTILE_ARC',
          'CIRCLE',
          'CIRCLE_WITH_WAVE',
          'INFINITE_SYMBOL',
          'RANDOM_MOVEMENT',
        ]),
        'live',
        { editorOnly: true }
      ),
      num('_editorData.simulation.movementSpeed', 'Movement speed', 0.1, 10, 0.1, 'live', {
        editorOnly: true,
      }),
      enumF(
        '_editorData.simulation.rotation',
        'Simulate rotation',
        opts(['DISABLED', 'FOLLOW_THE_MOVEMENT', 'X', 'Y', 'Z', 'MIXED']),
        'live',
        { editorOnly: true }
      ),
      num('_editorData.simulation.rotationSpeed', 'Rotation speed', -10, 10, 0.1, 'live', {
        editorOnly: true,
      }),
      bool('_editorData.showLocalAxes', 'Show local axes', 'live', { editorOnly: true }),
      bool('_editorData.showWorldAxes', 'Show world axes', 'live', { editorOnly: true }),
      bool('_editorData.showShape', 'Show shape', 'live', { editorOnly: true }),
      bool('_editorData.showForceFields', 'Show force fields', 'live', { editorOnly: true }),
      bool('_editorData.showCollisionPlanes', 'Show collision planes', 'live', {
        editorOnly: true,
      }),
      bool('_editorData.useIndividualUpdate', 'Individual update method', 'live', {
        editorOnly: true,
      }),
      bool('_editorData.useLiveUpdate', 'Live config update', 'live', {
        editorOnly: true,
        hint: "V1 only: whether sliders go through updateConfig or rebuild. A studio reads each field's change level instead.",
      }),
      enumF(
        '_editorData.terrain.textureId',
        'Terrain',
        opts(['WIREFRAME', 'TERRAIN_CHESS_BOARD', 'TERRAIN_CHESS_BOARD_COLORFUL', 'TERRAIN_DIRT']),
        'live',
        { editorOnly: true }
      ),
      bool('_editorData.enableBigNumbers', 'Enable big numbers', 'live', {
        editorOnly: true,
        hint: 'V1 only: widens rateOverDistance and burst counts.',
      }),
      bool('_editorData.frustumCulled', 'Frustum culled', 'rebuild', { editorOnly: true }),
      hidden('_editorData.gradientStops', 'Gradient stops', {
        editorOnly: true,
        hint: "The gradient editor's own stops; colorOverLifetime is baked from them.",
      }),
      hidden('_editorData.trailGradientStops', 'Trail gradient stops', {
        editorOnly: true,
        hint: "The trail gradient editor's stops; appears once it has been opened.",
      }),
      hidden('_editorData.metadata', 'Metadata', { editorOnly: true }),
      hidden('_editorData.sceneObjects', 'Scene objects', {
        editorOnly: true,
        hint: 'The Scene panel edits these (scene-objects.ts).',
      }),
      hidden('_editorData.embeddedTextures', 'Embedded textures', { editorOnly: true }),
      hidden('_editorData.embeddedVideos', 'Embedded videos', { editorOnly: true }),
    ],
  },
  {
    id: 'subEmitters',
    label: 'Sub-Emitters',
    fields: [
      {
        path: 'subEmitters',
        kind: 'list',
        label: 'Sub-emitters',
        change: 'rebuild',
        item: {
          id: 'subEmitter',
          label: 'Sub-Emitter',
          fields: [
            enumF('trigger', 'Trigger', opts(['BIRTH', 'DEATH']), 'rebuild'),
            num('inheritVelocity', 'Inherit Velocity', 0, 1, 0.01, 'rebuild'),
            int('maxInstances', 'Max Instances', 1, 128, 'rebuild'),
            hidden('config', 'Config', {
              hint: 'A whole document of its own; edited by switching the inspector into it.',
            }),
          ],
        },
      },
    ],
  },
  {
    id: 'transform',
    label: 'Transform',
    fields: [
      vec3('transform.position', 'position', -10, 10, 0.001, 'rebuild'),
      vec3('transform.rotation', 'rotation', -360, 360, 0.001, 'rebuild'),
      vec3('transform.scale', 'scale', 0.001, 10, 0.001, 'rebuild'),
    ],
  },
  {
    id: 'general',
    label: 'General',
    fields: [
      num('duration', 'duration', 0, 30, 0.01, 'live'),
      bool('looping', 'looping', 'live'),
      value('startDelay', 'startDelay', 0, 30, 0.01, 'live'),
      value('startLifetime', 'startLifetime', 0.01, 30, 0.01, 'live'),
      value('startSpeed', 'startSpeed', 0, 30, 0.01, 'live'),
      value('startSize', 'startSize', 0, 100, 0.01, 'live'),
      value('startRotation', 'startRotation', -360, 360, 0.001, 'live'),
      { path: 'startColor', kind: 'minmaxColor', label: 'startColor', change: 'live' },
      value('startOpacity', 'startOpacity', 0, 1, 0.001, 'live'),
      num('gravity', 'gravity', -1, 1, 0.01, 'live'),
      enumF('simulationSpace', 'simulationSpace', opts(['LOCAL', 'WORLD']), 'live'),
      int('maxParticles', 'maxParticles', 1000, 500000, 'structural', {
        hint: 'Sizes every GPU buffer.',
      }),
    ],
  },
  {
    id: 'emission',
    label: 'Emission',
    fields: [
      int('emission.rateOverTime', 'rateOverTime', 1000, 100000, 'live'),
      int('emission.rateOverDistance', 'rateOverDistance', 0, 100000, 'live', {
        hint: 'V1 caps this at 500 unless Enable big numbers is on.',
      }),
      {
        path: 'emission.bursts',
        kind: 'list',
        label: 'Bursts',
        change: 'rebuild',
        item: {
          id: 'burst',
          label: 'Burst',
          fields: [
            num('time', 'Time', 0, 30, 0.01, 'rebuild'),
            value('count', 'Count', 1, 100000, 1, 'rebuild', {
              hint: 'V1 caps this at 1000 unless Enable big numbers is on.',
            }),
            int('cycles', 'Cycles', 1, 100, 'rebuild'),
            num('interval', 'Interval', 0, 10, 0.01, 'rebuild'),
            num('probability', 'Probability', 0, 1, 0.01, 'rebuild'),
          ],
        },
      },
    ],
  },
  {
    id: 'shape',
    label: 'Shape',
    fields: [
      enumF(
        'shape.shape',
        'shape',
        opts(['SPHERE', 'CONE', 'BOX', 'CIRCLE', 'RECTANGLE']),
        'structural'
      ),
    ],
    groups: [
      {
        id: 'shape.sphere',
        label: 'Sphere',
        when: (d) => d.shape?.shape === 'SPHERE',
        fields: [
          num('shape.sphere.radius', 'radius', 0.0001, 10, 0.0001, 'structural'),
          num('shape.sphere.radiusThickness', 'radiusThickness', 0, 1, 0.01, 'structural'),
          num('shape.sphere.arc', 'arc', -360, 360, 0.001, 'structural'),
        ],
      },
      {
        id: 'shape.cone',
        label: 'Cone',
        when: (d) => d.shape?.shape === 'CONE',
        fields: [
          num('shape.cone.angle', 'angle', 0, 90, 0.0001, 'structural'),
          num('shape.cone.radius', 'radius', 0.0001, 10, 0.0001, 'structural'),
          num('shape.cone.radiusThickness', 'radiusThickness', 0, 1, 0.01, 'structural'),
          num('shape.cone.arc', 'arc', -360, 360, 0.001, 'structural'),
        ],
      },
      {
        id: 'shape.box',
        label: 'Box',
        when: (d) => d.shape?.shape === 'BOX',
        fields: [
          enumF('shape.box.emitFrom', 'emitFrom', opts(['VOLUME', 'SHELL', 'EDGE']), 'structural'),
          vec3('shape.box.scale', 'scale', 0.001, 10, 0.001, 'structural'),
        ],
      },
      {
        id: 'shape.circle',
        label: 'Circle',
        when: (d) => d.shape?.shape === 'CIRCLE',
        fields: [
          num('shape.circle.radius', 'radius', 0.0001, 10, 0.0001, 'structural'),
          num('shape.circle.radiusThickness', 'radiusThickness', 0, 1, 0.01, 'structural'),
          num('shape.circle.arc', 'arc', -360, 360, 0.001, 'structural'),
        ],
      },
      {
        id: 'shape.rectangle',
        label: 'Rectangle',
        when: (d) => d.shape?.shape === 'RECTANGLE',
        fields: [
          vec3('shape.rectangle.rotation', 'rotation', -360, 360, 0.001, 'structural', {
            hint: 'V1 shows x and y only; the library stores z too.',
          }),
          vec2('shape.rectangle.scale', 'scale', 0.001, 10, 0.001, 'structural'),
        ],
      },
    ],
  },
  {
    id: 'velocityOverLifetime',
    label: 'Velocity over lifetime',
    fields: [bool('velocityOverLifetime.isActive', 'isActive', 'rebuild')],
    groups: [
      {
        id: 'velocityOverLifetime.linear',
        label: 'Linear velocity',
        fields: [
          value('velocityOverLifetime.linear.x', 'x', -30, 30, 0.001, 'rebuild'),
          value('velocityOverLifetime.linear.y', 'y', -30, 30, 0.001, 'rebuild'),
          value('velocityOverLifetime.linear.z', 'z', -30, 30, 0.001, 'rebuild'),
        ],
      },
      {
        id: 'velocityOverLifetime.orbital',
        label: 'Orbital velocity',
        fields: [
          value('velocityOverLifetime.orbital.x', 'x', -45, 45, 0.01, 'rebuild'),
          value('velocityOverLifetime.orbital.y', 'y', -45, 45, 0.01, 'rebuild'),
          value('velocityOverLifetime.orbital.z', 'z', -45, 45, 0.01, 'rebuild'),
        ],
      },
    ],
  },
  {
    id: 'colorOverLifetime',
    label: 'Color over lifetime (Gradient)',
    fields: [
      bool('colorOverLifetime.isActive', 'Enable', 'structural'),
      {
        path: 'colorOverLifetime',
        kind: 'gradient',
        label: 'Gradient',
        change: 'rebuild',
        hint: 'r, g, b curves baked from the gradient stops; alpha lives in Opacity over lifetime.',
      },
    ],
  },
  {
    id: 'sizeOverLifetime',
    label: 'Size over lifetime',
    fields: [
      bool('sizeOverLifetime.isActive', 'isActive', 'structural'),
      {
        path: 'sizeOverLifetime.lifetimeCurve',
        kind: 'curve',
        label: 'lifetimeCurve',
        min: 0,
        max: 10,
        step: 0.1,
        change: 'rebuild',
      },
    ],
  },
  {
    id: 'opacityOverLifetime',
    label: 'Opacity over lifetime',
    fields: [
      bool('opacityOverLifetime.isActive', 'isActive', 'structural'),
      {
        path: 'opacityOverLifetime.lifetimeCurve',
        kind: 'curve',
        label: 'lifetimeCurve',
        min: 0,
        max: 10,
        step: 0.1,
        change: 'rebuild',
      },
    ],
  },
  {
    id: 'rotationOverLifetime',
    label: 'Rotation over lifetime',
    fields: [
      bool('rotationOverLifetime.isActive', 'isActive', 'structural'),
      value('rotationOverLifetime', 'Angular velocity', -500, 500, 0.1, 'rebuild', {
        allowCurve: true,
      }),
    ],
  },
  {
    id: 'noise',
    label: 'Noise',
    fields: [
      bool('noise.isActive', 'isActive', 'structural'),
      bool('noise.useRandomOffset', 'useRandomOffset', 'live'),
      bool('noise.curl', 'curl', 'structural'),
      enumF(
        'noise.type',
        'type (curl)',
        opts(['SIMPLEX', 'PERLIN'], ['simplex', 'perlin']),
        'structural'
      ),
      num('noise.strength', 'strength', 0, 2, 0.01, 'live'),
      num('noise.frequency', 'frequency', 0.0001, 3, 0.001, 'live'),
      int('noise.octaves', 'octaves', 1, 4, 'structural'),
      num('noise.positionAmount', 'positionAmount', -5, 5, 0.001, 'live'),
      num('noise.rotationAmount', 'rotationAmount', -5, 5, 0.001, 'live'),
      num('noise.sizeAmount', 'sizeAmount', -5, 5, 0.001, 'live'),
      vec3('noise.drift', 'drift (field motion per axis)', -3, 3, 0.01, 'live'),
      vec3('noise.influence', 'influence', 0, 1, 0.01, 'live'),
      enumF('noise.direction.x', 'direction x', opts(['BOTH', 'POSITIVE', 'NEGATIVE']), 'live', {
        hint: 'Which way the curl field may push along this world axis. One way folds the push onto that side: every particle goes that way, faster or slower, never back.',
        when: (d) => !!d.noise?.curl,
      }),
      enumF('noise.direction.y', 'direction y', opts(['BOTH', 'POSITIVE', 'NEGATIVE']), 'live', {
        hint: 'Which way the curl field may push along this world axis. One way folds the push onto that side: every particle goes that way, faster or slower, never back.',
        when: (d) => !!d.noise?.curl,
      }),
      enumF('noise.direction.z', 'direction z', opts(['BOTH', 'POSITIVE', 'NEGATIVE']), 'live', {
        hint: 'Which way the curl field may push along this world axis. One way folds the push onto that side: every particle goes that way, faster or slower, never back.',
        when: (d) => !!d.noise?.curl,
      }),
    ],
  },
  {
    id: 'particleColorInstance',
    label: 'Particle Color Instance',
    fields: [
      bool('particleColorInstance.isActive', 'isActive', 'structural'),
      {
        path: '_editorData.colorInstanceTextureId',
        kind: 'texture',
        label: 'Source',
        change: 'rebuild',
        editorOnly: true,
        hint: 'Image or video; the registry resolves the id.',
      },
      enumF(
        'particleColorInstance.plane',
        'plane',
        opts(['XZ', 'XY', 'YZ'], ['XZ (top-down)', 'XY (facing +Z)', 'YZ (facing +X)']),
        'live'
      ),
      enumF(
        'particleColorInstance.wrap',
        'outside the source',
        opts(
          ['ZERO', 'REPEAT', 'MIRROR', 'STRETCH'],
          ['zero (black)', 'repeat', 'mirror', 'stretch (edge)']
        ),
        'live'
      ),
      bool('particleColorInstance.spawnOnSource', 'spawn only on the source', 'live'),
      bool('_editorData.showColorSourceDebug', 'show source (debug)', 'live', {
        editorOnly: true,
        hint: 'Lays the source over the emitter in the viewport; the editor only.',
      }),
      bool('particleColorInstance.useAlphaForOpacity', 'useAlphaForOpacity', 'live'),
      bool('particleColorInstance.useLuminanceForNoise', 'luminance -> curl noise', 'structural'),
      num('particleColorInstance.luminanceNoiseAmount', 'luminance amount', -1, 1, 0.01, 'live'),
      int('particleColorInstance.sampleSize', 'video sample size (0 = 512)', 0, 1024, 'live', {
        step: 64,
      }),
      hidden('particleColorInstance.map', 'map', {
        hint: 'The source THREE.Texture resolved from _editorData.colorInstanceTextureId; never serialised.',
      }),
      vec3('particleColorInstance.area', 'area (0 = auto from shape)', 0, 100, 0.1, 'live'),
      vec2('particleColorInstance.scale', 'scale (1 = fit area)', 0.01, 4, 0.01, 'live'),
      vec3(
        'particleColorInstance.offset',
        'offset (source centre from emitter)',
        -50,
        50,
        0.01,
        'live'
      ),
    ],
  },
  {
    id: 'sourceImageTweak',
    label: 'Emitter Source Image Tweak',
    fields: [],
    groups: [
      {
        id: 'colorTweak',
        label: 'Color source',
        fields: [
          num('particleColorInstance.colorTweak.saturation', 'saturation', 0, 5, 0.01, 'live'),
          num('particleColorInstance.colorTweak.contrast', 'level (contrast)', 0, 2, 0.01, 'live'),
          num('particleColorInstance.colorTweak.blackPoint', 'black point', 0, 0.9, 0.005, 'live', {
            hint: 'The value that becomes black: the darks are pressed down, white stays where it is.',
          }),
          num('particleColorInstance.colorTweak.gamma', 'gamma', 0.2, 3, 0.01, 'live', {
            hint: 'The mid-tones: above 1 lifts them, below 1 sinks them; black and white stay.',
          }),
          num('particleColorInstance.colorTweak.brightness', 'brightness', 0, 3, 0.01, 'live', {
            hint: 'A plain multiplier on every channel.',
          }),
          num('particleColorInstance.colorTweak.hue', 'hue (deg)', -180, 180, 1, 'live'),
        ],
      },
      {
        id: 'luminanceMap',
        label: 'Luminosity noise map',
        fields: [
          num(
            'particleColorInstance.luminanceMap.black',
            'darkest (black point)',
            0,
            1,
            0.01,
            'live'
          ),
          num(
            'particleColorInstance.luminanceMap.white',
            'brightest (white point)',
            0,
            1,
            0.01,
            'live'
          ),
        ],
      },
    ],
  },
  {
    id: 'touch',
    label: 'Touch',
    fields: [
      bool('touch.isActive', 'isActive', 'structural'),
      num('touch.radius', 'radius (share of width)', 0.02, 0.5, 0.005, 'rebuild'),
      num('touch.strength', 'strength', 0, 3, 0.01, 'rebuild'),
      num('touch.wake', 'wake (s)', 0.05, 2, 0.01, 'rebuild'),
      num('touch.swirl', 'swirl', 0, 2, 0.01, 'rebuild'),
      num('touch.maxSpeed', 'max finger speed', 1, 30, 0.5, 'rebuild'),
      vec3('touch.normal', 'normal', -1, 1, 0.01, 'rebuild', {
        hint: 'Not on the V1 panel; the swirl plane.',
      }),
    ],
  },
  {
    id: 'forceFields',
    label: 'Force Fields',
    fields: [
      {
        path: 'forceFields',
        kind: 'list',
        label: 'Force fields',
        change: 'structural',
        hint: 'Adding the first or removing the last one recompiles; editing an item is live.',
        item: {
          id: 'forceField',
          label: 'Force Field',
          fields: [
            bool('isActive', 'Active', 'live'),
            enumF('type', 'Type', opts(['POINT', 'DIRECTIONAL']), 'live'),
            vec3('position', 'Position', -100, 100, 0.1, 'live', {
              when: (ff) => ff.type === 'POINT',
            }),
            num('range', 'Range', 0.1, 100, 0.1, 'live', { when: (ff) => ff.type === 'POINT' }),
            enumF('falloff', 'Falloff', opts(['NONE', 'LINEAR', 'QUADRATIC']), 'live', {
              when: (ff) => ff.type === 'POINT',
            }),
            vec3('direction', 'Direction', -1, 1, 0.01, 'live', {
              when: (ff) => ff.type === 'DIRECTIONAL',
            }),
            value('strength', 'Strength', -100, 100, 0.1, 'live', { allowCurve: true }),
          ],
        },
      },
    ],
  },
  {
    id: 'collisionPlanes',
    label: 'Collision Planes',
    fields: [
      {
        path: 'collisionPlanes',
        kind: 'list',
        label: 'Collision planes',
        change: 'structural',
        hint: 'Adding the first or removing the last one recompiles; editing an item is live.',
        item: {
          id: 'collisionPlane',
          label: 'Collision Plane',
          fields: [
            bool('isActive', 'Active', 'live'),
            enumF('mode', 'Mode', opts(['KILL', 'CLAMP', 'BOUNCE']), 'live'),
            num('dampen', 'Dampen', 0, 1, 0.01, 'live'),
            num('maxSpeed', 'Max speed (u/s, bounce, 0 = off)', 0, 20, 0.1, 'live'),
            num('touchCap', 'Touch cap (u/s, bounce)', 0, 20, 0.1, 'live'),
            num('recover', 'Recover (s, bounce)', 0, 5, 0.05, 'live'),
            num('lifetimeLoss', 'Lifetime Loss', 0, 1, 0.01, 'live'),
            vec3('position', 'Position', -20, 20, 0.1, 'live'),
            vec3('normal', 'Normal', -1, 1, 0.01, 'live'),
          ],
        },
      },
    ],
  },
  {
    id: 'textureSheetAnimation',
    label: 'Texture sheet animation',
    fields: [
      enumF('textureSheetAnimation.timeMode', 'timeMode', opts(['LIFETIME', 'FPS']), 'rebuild'),
      int('textureSheetAnimation.fps', 'fps', 0, 60, 'rebuild', {
        when: (d) => d.textureSheetAnimation?.timeMode === 'FPS',
      }),
      vec2('textureSheetAnimation.tiles', 'tiles', 1, 10, 1, 'rebuild'),
      value('textureSheetAnimation.startFrame', 'startFrame', 0, 100, 1, 'rebuild'),
    ],
  },
  {
    id: 'renderer',
    label: 'Renderer',
    fields: [
      enumF(
        'renderer.rendererType',
        'rendererType',
        opts(['POINTS', 'INSTANCED', 'TRAIL', 'MESH']),
        'structural'
      ),
      {
        path: '_editorData.textureId',
        kind: 'texture',
        label: 'Texture',
        change: 'structural',
        editorOnly: true,
        when: (d) => !isMesh(d),
        hint: 'Sprite; sets `map` and the sheet tiles.',
      },
      hidden('map', 'map', {
        hint: 'The THREE.Texture resolved from _editorData.textureId; never serialised.',
      }),
      enumF('simulationBackend', 'simulationBackend', opts(['AUTO', 'CPU', 'GPU']), 'structural'),
      bool('renderer.discardBackgroundColor', 'discardBackgroundColor', 'rebuild'),
      num('renderer.backgroundColorTolerance', 'backgroundColorTolerance', 0, 2, 0.001, 'rebuild'),
      {
        path: 'renderer.backgroundColor',
        kind: 'color',
        label: 'backgroundColor',
        change: 'rebuild',
      },
      enumF(
        'renderer.blending',
        'blending',
        opts([
          'THREE.NoBlending',
          'THREE.NormalBlending',
          'THREE.AdditiveBlending',
          'THREE.SubtractiveBlending',
          'THREE.MultiplyBlending',
        ]),
        'rebuild',
        {
          hint: 'Documents carry the name; the library also accepts the numeric THREE constant (its default is 1).',
        }
      ),
      bool('renderer.transparent', 'transparent', 'rebuild'),
      bool('renderer.depthTest', 'depthTest', 'rebuild'),
      bool('renderer.depthWrite', 'depthWrite', 'rebuild'),
      bool('renderer.softParticles.enabled', 'Soft Particles', 'rebuild'),
      num('renderer.softParticles.intensity', 'Soft Particles Intensity', 0.01, 5, 0.01, 'rebuild'),
    ],
  },
  {
    id: 'trail',
    label: 'Trail',
    when: isTrail,
    fields: [
      int('renderer.trail.length', 'length (samples)', 2, 60, 'rebuild'),
      num('renderer.trail.width', 'width (×0.01)', 0.1, 10, 0.05, 'rebuild', {
        displayScale: 100,
        hint: 'Stored in world units; the panel shows it ×100.',
      }),
      num('renderer.trail.minVertexDistance', 'Min Vertex Distance', 0, 2, 0.01, 'rebuild'),
      num('renderer.trail.maxTime', 'Max Time (s)', 0, 10, 0.1, 'rebuild'),
      bool('renderer.trail.smoothing', 'Smoothing', 'rebuild'),
      int('renderer.trail.smoothingSubdivisions', 'Smoothing Subdivisions', 1, 10, 'rebuild'),
      bool('renderer.trail.twistPrevention', 'Twist Prevention', 'rebuild', {
        hint: 'CPU ribbon only.',
      }),
      {
        path: 'renderer.trail.widthOverTrail',
        kind: 'curve',
        label: 'Width Over Trail',
        min: 0,
        max: 10,
        step: 0.1,
        change: 'rebuild',
      },
      {
        path: 'renderer.trail.opacityOverTrail',
        kind: 'curve',
        label: 'Opacity Over Trail',
        min: 0,
        max: 10,
        step: 0.1,
        change: 'rebuild',
        hint: 'Not on the V1 panel.',
      },
      bool('renderer.trail.colorOverTrail.isActive', 'Color Over Trail', 'rebuild'),
      {
        path: 'renderer.trail.colorOverTrail',
        kind: 'gradient',
        label: 'Color Over Trail',
        change: 'rebuild',
      },
    ],
  },
  {
    id: 'points',
    label: 'Points',
    when: (d) => ['POINTS', 'INSTANCED'].includes(d.renderer?.rendererType ?? 'POINTS'),
    fields: [
      num('renderer.points.velocityStretch', 'velocity stretch (s of travel)', 0, 1, 0.005, 'rebuild', {
        hint: 'Each sprite becomes a streak along its travel, as long as the distance it covers in this many seconds; the head stays on the particle. GPU only. While on, POINTS draws as instanced quads (same size) and sprite-sheet animation is off.',
      }),
    ],
  },
  {
    id: 'mesh',
    label: 'Mesh',
    when: isMesh,
    fields: [
      enumF(
        'renderer.mesh.geometryType',
        'Geometry',
        opts([
          'BOX',
          'SPHERE',
          'ICOSAHEDRON',
          'TORUS',
          'TORUS_KNOT',
          'CYLINDER',
          'CONE',
          'DODECAHEDRON',
          'OCTAHEDRON',
          'TETRAHEDRON',
        ]),
        'rebuild'
      ),
      hidden('renderer.mesh.geometry', 'geometry', {
        hint: 'Built from geometryType by particle-factory; never serialised.',
      }),
      vec3('renderer.mesh.scale', 'scale', 0.01, 5, 0.01, 'rebuild', {
        hint: "V1 also offers 'Size (all axes)', a convenience that writes all three.",
      }),
      bool('renderer.mesh.alignToVelocity', 'align to velocity (+Z = heading)', 'rebuild'),
      num(
        'renderer.mesh.velocityStretch',
        'velocity stretch (s of travel)',
        0,
        1,
        0.005,
        'rebuild'
      ),
      bool('renderer.mesh.lit', 'lit (use scene lights)', 'rebuild'),
      num('renderer.mesh.emissive', 'emissive (needs lit)', 0, 4, 0.01, 'rebuild'),
      num('renderer.mesh.roughness', 'roughness (needs lit)', 0, 1, 0.01, 'rebuild'),
      num('renderer.mesh.metalness', 'metalness (needs lit)', 0, 1, 0.01, 'rebuild'),
    ],
  },
];

// ─── walking it ──────────────────────────────────────────────────────────────

/** Every field of a group tree, depth first, in panel order. List items are not descended. */
export const fieldsOf = (groups: Group[] = schema): Field[] =>
  groups.flatMap((g) => [...g.fields, ...fieldsOf(g.groups ?? [])]);

/** Every top-level field plus every list item's fields with `<list>.*.<field>` paths. */
export const allFieldPaths = (): string[] =>
  fieldsOf().flatMap((f) =>
    f.kind === 'list' && f.item
      ? [f.path, ...fieldsOf([f.item]).map((i) => `${f.path}.*.${i.path}`)]
      : [f.path]
  );

/**
 * The field for a concrete document path, e.g. `forceFields.2.position` → the
 * item field `position` of the `forceFields` list. Null when the table has
 * nothing at that path.
 */
/** The primitives one field spans, relative to its path — what `coversLeaf` walks. */
const SHAPE: Partial<Record<FieldKind, string[]>> = {
  vec2: ['x', 'y'],
  vec3: ['x', 'y', 'z'],
  color: ['r', 'g', 'b'],
  value: ['min', 'max', 'type', 'scale', 'bezierPoints'],
  minmaxColor: ['min', 'max'],
  curve: ['type', 'scale', 'bezierPoints', 'curveFunction'],
  gradient: ['r', 'g', 'b', 'isActive'],
};

/** The field written at exactly `path`: a top-level one, or one of a list item's. */
const fieldExactlyAt = (path: string): Field | null => {
  const flat = fieldsOf();
  const exact = flat.find((f) => f.path === path);
  if (exact) return exact;
  for (const list of flat) {
    if (list.kind !== 'list' || !list.item) continue;
    const m = path.match(new RegExp(`^${list.path.replace(/\./g, '\\.')}\\.(\\d+)\\.(.+)$`));
    if (!m) continue;
    const inner = fieldsOf([list.item]).find((f) => f.path === m[2]);
    if (inner) return inner;
  }
  return null;
};

/**
 * The field a path belongs to. A component of a compound field — `position.x`
 * of a vec3, `.min` of a value — answers with the field itself: the inspector
 * patches compounds one component at a time, and a path that named no field
 * meant a change the engine never heard of (a collision plane's position only
 * took once the whole list was re-sent by toggling the plane).
 */
export const fieldAt = (path: string): Field | null => {
  const direct = fieldExactlyAt(path);
  if (direct) return direct;
  const segs = path.split('.');
  for (let i = segs.length - 1; i > 0; i--) {
    const field = fieldExactlyAt(segs.slice(0, i).join('.'));
    if (field) return SHAPE[field.kind]?.includes(segs[i]) ? field : null;
  }
  return null;
};

/** Whether a primitive path of a document falls under some field of the table. */
export const coversLeaf = (leafPath: string): boolean => {
  const segs = leafPath.split('.');
  for (let i = segs.length; i > 0; i--) {
    const field = fieldAt(segs.slice(0, i).join('.'));
    if (!field) continue;
    if (i === segs.length) return true;
    if (field.kind === 'hidden' || field.kind === 'list' || field.kind === 'gradient') return true;
    const inner = SHAPE[field.kind];
    if (inner && inner.includes(segs[i])) return true;
  }
  return false;
};

// ─── the document's defaults ─────────────────────────────────────────────────

const BEZIER = (y0: number, y1: number) => ({
  type: 'BEZIER' as const,
  scale: 1,
  bezierPoints: [
    { x: 0, y: y0, percentage: 0 },
    { x: 1, y: y1, percentage: 1 },
  ],
});

/**
 * What the editor adds on top of the library's defaults (the ensure* helpers
 * of V1's entries and `defaultEditorData`), so a document can be built in node
 * without a panel. `_editorData.metadata` and the texture ids are left to the
 * caller: they are per document, not defaults.
 */
export const editorAdditions = (): Doc => ({
  renderer: {
    rendererType: 'POINTS',
    // V1 writes the name; the library's default is the numeric constant 1.
    blending: 'THREE.NormalBlending',
    points: { velocityStretch: 0 },
    mesh: {
      geometryType: 'BOX',
      scale: { x: 1, y: 1, z: 1 },
      alignToVelocity: false,
      velocityStretch: 0,
      lit: false,
      emissive: 0,
      roughness: 0.65,
      metalness: 0,
    },
    trail: {
      length: 20,
      width: 0.01,
      minVertexDistance: 0,
      maxTime: 0,
      smoothing: false,
      smoothingSubdivisions: 3,
      twistPrevention: false,
      widthOverTrail: BEZIER(1, 0),
      opacityOverTrail: BEZIER(1, 0),
      colorOverTrail: { isActive: false, r: BEZIER(1, 1), g: BEZIER(1, 1), b: BEZIER(1, 1) },
    },
  },
  particleColorInstance: { sampleSize: 0 },
  subEmitters: [],
  _editorData: {
    simulation: { movements: 'DISABLED', movementSpeed: 1, rotation: 'DISABLED', rotationSpeed: 1 },
    showLocalAxes: false,
    showWorldAxes: false,
    showShape: false,
    showForceFields: false,
    showCollisionPlanes: false,
    showColorSourceDebug: false,
    frustumCulled: true,
    useIndividualUpdate: false,
    useLiveUpdate: false,
    enableBigNumbers: false,
    terrain: { textureId: 'WIREFRAME' },
    gradientStops: [
      { position: 0, color: { r: 255, g: 255, b: 255, a: 255 } },
      { position: 1, color: { r: 255, g: 255, b: 255, a: 0 } },
    ],
  },
});

const isPlain = (v: unknown): v is Doc => !!v && typeof v === 'object' && !Array.isArray(v);
const merge = (base: Doc, extra: Doc): Doc => {
  const out: Doc = { ...base };
  for (const [k, v] of Object.entries(extra))
    out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v) : v;
  return out;
};

/** The library's defaults plus the editor's additions: a complete document minus its identity. */
export const documentDefaults = (): Doc =>
  merge(getDefaultParticleSystemConfig() as Doc, editorAdditions());

/** Every primitive path of a document (arrays are leaves, as is a THREE object). */
export const leafPaths = (doc: Doc, prefix = ''): string[] =>
  Object.entries(doc).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return isPlain(v) && !(v as Doc).isTexture && !(v as Doc).isBufferGeometry
      ? leafPaths(v as Doc, path)
      : [path];
  });
