// The schema covers the document and describes only what exists
// (V2-ARCHITECTURE.md §2.2, "覆盖测试"): every key of the default config has a
// field, every field resolves in the defaults, and the table is well formed.
import { getDefaultParticleSystemConfig } from '@newkrok/three-particles';
import {
  schema,
  fieldsOf,
  allFieldPaths,
  fieldAt,
  coversLeaf,
  leafPaths,
  documentDefaults,
} from '../schema';

const resolve = (doc: any, path: string): unknown =>
  path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);

describe('schema coverage', () => {
  test('every leaf of the library default config is covered by a field', () => {
    const missing = leafPaths(getDefaultParticleSystemConfig() as any).filter(
      (p) => !coversLeaf(p)
    );
    expect(missing).toEqual([]);
  });

  test('every leaf of the full document defaults is covered by a field', () => {
    const missing = leafPaths(documentDefaults()).filter((p) => !coversLeaf(p));
    expect(missing).toEqual([]);
  });

  test('every field path resolves in the document defaults (texture ids and metadata excepted)', () => {
    const defaults = documentDefaults();
    const exempt = new Set([
      '_editorData.textureId',
      '_editorData.colorInstanceTextureId',
      '_editorData.metadata',
      '_editorData.sceneObjects',
      '_editorData.embeddedTextures',
      '_editorData.embeddedVideos',
      'map',
      'particleColorInstance.map',
      'renderer.mesh.geometry',
    ]);
    const dangling = fieldsOf()
      // Hidden fields are owned by other UIs and may be absent (trail gradient stops appear on first use).
      .filter((f) => !exempt.has(f.path) && f.kind !== 'hidden')
      .filter((f) => resolve(defaults, f.path) === undefined)
      .map((f) => f.path);
    expect(dangling).toEqual([]);
  });
});

describe('schema shape', () => {
  test('paths are unique', () => {
    const paths = allFieldPaths();
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('numeric fields have a range, enums have options, lists have items', () => {
    const bad: string[] = [];
    const walk = (fields: ReturnType<typeof fieldsOf>, prefix = '') => {
      for (const f of fields) {
        const p = prefix + f.path;
        if (['number', 'int', 'value', 'vec2', 'vec3'].includes(f.kind) && !(f.min! < f.max!))
          bad.push(`${p}: range`);
        if (f.kind === 'enum' && !(f.options && f.options.length > 1)) bad.push(`${p}: options`);
        if (f.kind === 'list') {
          if (!f.item || f.item.fields.length === 0) bad.push(`${p}: item`);
          else walk(fieldsOf([f.item]), `${p}.*.`);
        }
      }
    };
    walk(fieldsOf());
    expect(bad).toEqual([]);
  });

  test('a list item field is found through an index', () => {
    expect(fieldAt('forceFields.2.position')?.kind).toBe('vec3');
    expect(fieldAt('collisionPlanes.0.mode')?.options?.map((o) => o.value)).toEqual([
      'KILL',
      'CLAMP',
      'BOUNCE',
    ]);
    expect(coversLeaf('forceFields.0.position.x')).toBe(true);
    expect(coversLeaf('emission.bursts.3.count.min')).toBe(true);
    expect(fieldAt('nothing.here')).toBeNull();
  });

  it('answers a component of a compound field with the field itself', () => {
    // The inspector patches vec3s one axis at a time: a path that named no
    // field was a change the engine never heard of.
    expect(fieldAt('collisionPlanes.0.position.x')?.kind).toBe('vec3');
    expect(fieldAt('collisionPlanes.0.position.x')?.change).toBe('live');
    expect(fieldAt('collisionPlanes.3.normal.z')?.kind).toBe('vec3');
    expect(fieldAt('forceFields.1.position.y')?.kind).toBe('vec3');
    expect(fieldAt('noise.drift.x')?.path).toBe('noise.drift');
    expect(fieldAt('particleColorInstance.offset.z')?.path).toBe('particleColorInstance.offset');
    // Not a component of that kind, or of nothing at all.
    expect(fieldAt('noise.drift.w')).toBeNull();
    // Deeper paths stay with the field: a value's bezierPoints go several levels down.
    expect(fieldAt('startSize.bezierPoints.1.y')?.path).toBe('startSize');
    expect(fieldAt('collisionPlanes.0.bogus')).toBeNull();
    expect(coversLeaf('nothing.here')).toBe(false);
  });

  test('the three change levels are all in use and every field has one', () => {
    const levels = new Set(fieldsOf().map((f) => f.change));
    expect([...levels].sort()).toEqual(['live', 'rebuild', 'structural']);
  });

  test('groups keep V1 panel order', () => {
    expect(schema.map((g) => g.label).slice(0, 5)).toEqual([
      'Helper',
      'Sub-Emitters',
      'Transform',
      'General',
      'Emission',
    ]);
  });
});
