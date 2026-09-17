import { getDefaultParticleSystemConfig } from '@newkrok/three-particles';
import { isConfigV2 } from './config-util';
import { convertToNewFormat } from './config-converter';
import { ObjectUtils } from '@newkrok/three-utils';
import { setTerrain } from './world';
import { getTexture, loadCustomAssets } from './assets';
import { textureConfigs } from './texture-config';
import { isStandalone } from './runtime-mode';
import { getSceneObjects, replaceSceneObjects } from './scene-objects';
import { findVideoEntry, importVideoEntry } from './video-textures';

const { deepMerge } = ObjectUtils;
import { notify } from './notify';

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Diffs a live config against the defaults, keeping only what differs.
 *
 * Walks the union of both objects' keys. Iterating only the defaults used to
 * mean anything the editor adds at runtime — `renderer.rendererType` and the
 * whole `renderer.mesh` block (geometry type, scale, alignToVelocity) — was
 * never even looked at, so it silently vanished from every save and copy.
 */
export const getObjectDiff = (objectA, objectB, config = { skippedProperties: [] }) => {
  const result = {};
  const keys = new Set([...Object.keys(objectA || {}), ...Object.keys(objectB || {})]);

  keys.forEach((key) => {
    if (config.skippedProperties && config.skippedProperties.includes(key)) return;

    const a = objectA ? objectA[key] : undefined;
    const b = objectB ? objectB[key] : undefined;

    // Recurse whenever the live value is a plain object, including keys the
    // defaults never had — otherwise a new branch would be copied wholesale and
    // carry non-serialisable THREE objects (mesh.geometry) straight into JSON.
    if (isPlainObject(b) && (isPlainObject(a) || a === undefined)) {
      const objectDiff = getObjectDiff(a || {}, b, config);
      if (Object.keys(objectDiff).length > 0) result[key] = objectDiff;
    } else {
      const mergedValue = b ?? a;
      if (mergedValue !== a) result[key] = mergedValue;
    }
  });

  return result;
};

const serializeSubEmitters = (subEmitters: any[] | undefined): any[] | undefined => {
  if (!subEmitters || subEmitters.length === 0) return undefined;

  const defaultConfig = getDefaultParticleSystemConfig();

  return subEmitters.map((subEmitter) => {
    const serialized: any = {
      ...getObjectDiff(defaultConfig, subEmitter.config, {
        skippedProperties: ['map', 'geometry', 'depthTexture'],
      }),
    };

    // Preserve sub-emitter _editorData if present
    if (subEmitter.config._editorData) {
      serialized._editorData = { ...subEmitter.config._editorData };
    }

    // Recursively serialize nested sub-emitters
    if (subEmitter.config.subEmitters && subEmitter.config.subEmitters.length > 0) {
      serialized.subEmitters = serializeSubEmitters(subEmitter.config.subEmitters);
    }

    const result: any = { config: serialized };

    // Only include non-default values
    if (subEmitter.trigger !== undefined && subEmitter.trigger !== 'DEATH') {
      result.trigger = subEmitter.trigger;
    }
    if (subEmitter.inheritVelocity !== undefined && subEmitter.inheritVelocity !== 0) {
      result.inheritVelocity = subEmitter.inheritVelocity;
    }
    if (subEmitter.maxInstances !== undefined && subEmitter.maxInstances !== 32) {
      result.maxInstances = subEmitter.maxInstances;
    }

    return result;
  });
};

const CUSTOM_TEXTURE_KEYS = [
  'particle-system-editor/library',
  'particle-system-editor/image-textures',
];

const readCustomTextures = () => {
  const all: Record<string, string> = {};
  // A standalone player has no library in storage; what a piece brought with
  // it is registered in memory, and that is what it can hand back.
  if (isStandalone()) {
    textureConfigs.forEach((config: any) => {
      if (typeof config.url === 'string' && config.url.startsWith('data:'))
        all[config.id] = config.url;
    });
    return all;
  }
  CUSTOM_TEXTURE_KEYS.forEach((key) => {
    try {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      if (Array.isArray(list)) list.forEach(({ name, url }) => (all[name] = url));
    } catch {
      /* ignore an unreadable list */
    }
  });
  return all;
};

/**
 * Embeds the data URLs of any *uploaded* textures the config refers to.
 *
 * A config only stores texture *names*; the pixels live in the browser's
 * localStorage, so a config moved to another browser — or to a display client —
 * silently loses its imagery. Built-in textures ship with the app and are left
 * as plain names.
 */
const collectEmbeddedTextures = (editorData) => {
  const custom = readCustomTextures();
  const embedded: Record<string, string> = {};
  [editorData?.textureId, editorData?.colorInstanceTextureId].forEach((id) => {
    if (id && custom[id]) embedded[id] = custom[id];
  });
  return Object.keys(embedded).length > 0 ? embedded : undefined;
};

/**
 * Turns the live config into a clean, saveable object: only what differs from
 * the defaults, with the non-serialisable THREE objects (textures, geometry,
 * depth texture) left out and force fields / collision planes / sub-emitters
 * reduced to plain data.
 *
 * Saving and copying both go through this so what the save dialog shows is
 * exactly what gets stored.
 */
/**
 * A video cannot ride along the way an image does — a minute of H.264 is tens
 * of megabytes — but one that came from a URL can be named by it, and that is
 * enough for the config to play anywhere the address resolves. A locally
 * uploaded video travels as its name only, like a built-in texture would.
 */
const collectEmbeddedVideos = (editorData) => {
  const id = editorData?.colorInstanceTextureId;
  const entry = id ? findVideoEntry(id) : undefined;
  if (!entry || entry.source !== 'url' || !entry.url) return undefined;
  return {
    [entry.name]: {
      url: entry.url,
      width: entry.width,
      height: entry.height,
      duration: entry.duration,
    },
  };
};

export const serializeConfig = (particleSystemConfig) => {
  const editorData = { ...particleSystemConfig._editorData };
  const embeddedTextures = collectEmbeddedTextures(editorData);
  if (embeddedTextures) editorData.embeddedTextures = embeddedTextures;
  else delete editorData.embeddedTextures;
  const embeddedVideos = collectEmbeddedVideos(editorData);
  if (embeddedVideos) editorData.embeddedVideos = embeddedVideos;
  else delete editorData.embeddedVideos;

  // The scene the emitter sits in — its lights, boxes and probes. It lives in
  // scene-objects.ts rather than on the config, so it is read from there at
  // save time instead of trusting whatever a previous load left behind.
  //
  // Written even when empty: an empty scene is a scene, and the loader treats a
  // missing key as "this file predates scenes, leave mine alone".
  editorData.sceneObjects = structuredClone(getSceneObjects());

  const serialized: any = {
    ...getObjectDiff(getDefaultParticleSystemConfig(), particleSystemConfig, {
      skippedProperties: ['map', 'geometry', 'depthTexture'],
    }),
    _editorData: editorData,
  };

  // Include force fields if present
  if (particleSystemConfig.forceFields && particleSystemConfig.forceFields.length > 0) {
    serialized.forceFields = particleSystemConfig.forceFields.map((ff: any) => {
      const result: any = {};
      if (ff.isActive !== undefined && ff.isActive !== true) result.isActive = ff.isActive;
      if (ff.type) result.type = ff.type;
      if (ff.position) result.position = { x: ff.position.x, y: ff.position.y, z: ff.position.z };
      if (ff.direction)
        result.direction = { x: ff.direction.x, y: ff.direction.y, z: ff.direction.z };
      if (ff.strength !== undefined) result.strength = ff.strength;
      if (ff.range !== undefined) result.range = ff.range;
      if (ff.falloff) result.falloff = ff.falloff;
      return result;
    });
  }

  // Include collision planes if present
  if (particleSystemConfig.collisionPlanes && particleSystemConfig.collisionPlanes.length > 0) {
    serialized.collisionPlanes = particleSystemConfig.collisionPlanes.map((cp: any) => {
      const result: any = {};
      if (cp.isActive !== undefined) result.isActive = cp.isActive;
      if (cp.mode) result.mode = cp.mode;
      if (cp.position) result.position = { x: cp.position.x, y: cp.position.y, z: cp.position.z };
      if (cp.normal) result.normal = { x: cp.normal.x, y: cp.normal.y, z: cp.normal.z };
      if (cp.dampen !== undefined) result.dampen = cp.dampen;
      if (cp.lifetimeLoss !== undefined) result.lifetimeLoss = cp.lifetimeLoss;
      if (cp.recover !== undefined) result.recover = cp.recover;
      return result;
    });
  }

  // Include sub-emitters if present
  const subEmitters = serializeSubEmitters(particleSystemConfig.subEmitters);
  if (subEmitters) {
    serialized.subEmitters = subEmitters;
  }

  return serialized;
};

export const copyToClipboard = (particleSystemConfig) => {
  const blob = new Blob([JSON.stringify(serializeConfig(particleSystemConfig))], {
    type: 'text/plain',
  });
  navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
};

export const loadFromClipboard = ({
  particleSystemConfig,
  recreateParticleSystem,
  onLoad,
}: {
  particleSystemConfig: any;
  recreateParticleSystem: (markAsDirty?: boolean) => void;
  onLoad?: () => void;
}) => {
  navigator.clipboard
    .readText()
    .then((text) => {
      loadParticleSystem({
        config: JSON.parse(text),
        particleSystemConfig,
        recreateParticleSystem,
        onLoad,
      });
    })
    .catch(() => {
      // Handle clipboard read error silently
      // In a production app, we might want to show a notification to the user
    });
};

/**
 * Imports textures embedded in a loaded config into the user's own library, so
 * a config brought in from elsewhere arrives complete instead of referring to
 * images this browser has never seen. Names already present win — the local
 * copy is left alone.
 *
 * @returns true when something new was registered and its GPU texture is still
 *   loading, so the caller knows to refresh once it lands.
 */
/**
 * Imports the textures a config carries with it into the local library.
 *
 * Names can collide: uploads are named `ImageTexture-<n>`, so a config from
 * another browser can name an image that already exists here as something
 * else entirely. Yielding to the local one silently swaps in the wrong picture,
 * so a colliding name is imported under a fresh one instead and the config's
 * references are rewritten — returned in `renamed`.
 */
const importEmbeddedTextures = (
  embedded,
  onReady: () => void
): { pending: boolean; renamed: Record<string, string> } => {
  const renamed: Record<string, string> = {};
  if (!embedded || typeof embedded !== 'object') return { pending: false, renamed };

  const KEY = 'particle-system-editor/image-textures';
  let stored: any[] = [];
  // Standalone: the images register for the session and nothing is stored.
  const persist = !isStandalone();
  if (persist) {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (Array.isArray(parsed)) stored = parsed;
    } catch {
      /* start from an empty list if it is unreadable */
    }
  }

  const urlOf = (name: string): string | undefined =>
    (getTexture(name) as any)?.url ?? stored.find((e) => e.name === name)?.url;

  const taken = (name: string): boolean =>
    !!getTexture(name) || stored.some((e) => e.name === name);

  const freshName = (base: string): string => {
    let candidate: string;
    do {
      candidate = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    } while (taken(candidate) || candidate in renamed);
    return candidate;
  };

  const added: Array<[string, string]> = [];
  Object.entries(embedded).forEach(([name, url]) => {
    const existing = urlOf(name);
    // Already here, pixel for pixel — nothing to do.
    if (existing === url) return;
    if (existing === undefined && !taken(name)) {
      added.push([name, url as string]);
      return;
    }
    // Same name, different image: keep both.
    const fresh = freshName(name);
    renamed[name] = fresh;
    added.push([fresh, url as string]);
  });

  if (added.length === 0) return { pending: false, renamed };

  added.forEach(([name, url]) =>
    stored.unshift({ id: Math.floor(Math.random() * 100000000), name, url })
  );

  if (persist) {
    try {
      localStorage.setItem(KEY, JSON.stringify(stored));
    } catch {
      // Out of quota — the textures still register for this session below.
      notify.success('Textures imported for this session only (storage full)');
    }
  }

  loadCustomAssets({
    textures: added.map(([name, url]) => ({ id: name, url })),
    onComplete: onReady,
  });
  return { pending: true, renamed };
};

/**
 * Registers the URL videos a config names that this browser has not seen.
 * Same collision rule as the images: a name already taken by a *different*
 * address is imported under a fresh one and the reference rewritten.
 */
const importEmbeddedVideos = (
  embedded,
  onReady: () => void
): { renamed: Record<string, string> } => {
  const renamed: Record<string, string> = {};
  if (!embedded || typeof embedded !== 'object') return { renamed };

  const pending: Promise<unknown>[] = [];
  Object.entries(embedded).forEach(([name, info]: [string, any]) => {
    const url = info?.url;
    if (typeof url !== 'string' || !url) return;
    const existing = findVideoEntry(name);
    if (existing && (existing.source !== 'url' || existing.url === url)) return;
    let target = name;
    if (existing) {
      do {
        target = `${name}-${Math.random().toString(36).slice(2, 8)}`;
      } while (findVideoEntry(target));
      renamed[name] = target;
    }
    pending.push(importVideoEntry(target, info));
  });

  if (pending.length > 0) void Promise.all(pending).then(onReady);
  return { renamed };
};

export const loadParticleSystem = ({
  config,
  particleSystemConfig,
  recreateParticleSystem,
  onLoad,
}: {
  config: any;
  particleSystemConfig: any;
  recreateParticleSystem: (markAsDirty?: boolean) => void;
  onLoad?: () => void;
}) => {
  // Check if the loaded configuration is from version 2.0.0 or newer
  const isV2Config = isConfigV2(config);

  if (!isV2Config) {
    // Show the legacy config modal to notify the user
    notify.legacyConfig();

    // Convert the old configuration to the new format
    const convertedConfig = convertToNewFormat(config);

    // Use the converted config instead of the original
    config = convertedConfig;
  }

  // Expand sub-emitter configs from diff form to full configs before merging
  if (config.subEmitters && Array.isArray(config.subEmitters)) {
    config.subEmitters = config.subEmitters.map((subEmitter: any) => {
      const fullSubConfig = { ...getDefaultParticleSystemConfig() };
      // Remove map (THREE.Texture) to avoid circular references during deepMerge
      delete fullSubConfig.map;
      deepMerge(fullSubConfig, subEmitter.config || {}, {
        skippedProperties: ['map', 'geometry', 'depthTexture'],
        applyToFirstObject: true,
      });
      return {
        ...subEmitter,
        config: fullSubConfig,
      };
    });
  }

  // Reset particleSystemConfig to defaults by deleting all keys and deep-cloning
  // defaults back. patchObject alone doesn't remove extra keys (e.g. rendererType,
  // trail, mesh, softParticles) that were added by previous configs or entry modules.
  const defaultConfig = getDefaultParticleSystemConfig();
  const savedEditorData = particleSystemConfig._editorData;

  Object.keys(particleSystemConfig).forEach((key) => {
    delete particleSystemConfig[key];
  });

  Object.keys(defaultConfig).forEach((key) => {
    if (key !== '_editorData') {
      particleSystemConfig[key] = JSON.parse(
        JSON.stringify(defaultConfig[key], (k, v) =>
          k === 'map' || k === 'geometry' || k === 'depthTexture' ? undefined : v
        )
      );
    }
  });

  // Restore _editorData so deepMerge can overlay the loaded config's _editorData on top
  particleSystemConfig._editorData = savedEditorData;

  performance.mark('load:start');
  deepMerge(particleSystemConfig, config, {
    skippedProperties: ['map', 'geometry', 'depthTexture'],
    applyToFirstObject: true,
  });
  // Textures the config carries with it are imported into the local library
  // first, so the name-based restore below can find them like any other upload.
  const applyTextures = () => {
    if (particleSystemConfig._editorData?.textureId) {
      const texture = getTexture(particleSystemConfig._editorData.textureId);
      if (texture) {
        particleSystemConfig.map = texture.map;
      }
    }
    if (particleSystemConfig._editorData?.colorInstanceTextureId) {
      const texture = getTexture(particleSystemConfig._editorData.colorInstanceTextureId);
      if (texture && particleSystemConfig.particleColorInstance) {
        particleSystemConfig.particleColorInstance.map = texture.map;
      }
    }
  };

  const { pending: stillDecoding, renamed } = importEmbeddedTextures(
    particleSystemConfig._editorData?.embeddedTextures,
    () => {
      // Re-apply once the imported images have become GPU textures.
      applyTextures();
      recreateParticleSystem(false);
    }
  );

  const { renamed: renamedVideos } = importEmbeddedVideos(
    particleSystemConfig._editorData?.embeddedVideos,
    () => {
      applyTextures();
      recreateParticleSystem(false);
    }
  );

  // Point the config at the names the images actually landed under.
  const editorData = particleSystemConfig._editorData;
  (['textureId', 'colorInstanceTextureId'] as const).forEach((key) => {
    const id = editorData?.[key];
    if (id && renamed[id]) editorData[key] = renamed[id];
    if (id && renamedVideos[id]) editorData[key] = renamedVideos[id];
  });

  applyTextures();
  performance.mark('load:textures');

  // The scene travels inside _editorData but is owned by scene-objects.ts, so
  // hand it over there and drop the copy — leaving one on the live config would
  // let a stale scene be re-saved later.
  //
  // Read from the incoming config rather than the merged one: a config written
  // before scenes were saved has no sceneObjects key at all, and that has to
  // mean "leave the current scene alone", not "clear it".
  const loadedScene = config?._editorData?.sceneObjects;
  if (Array.isArray(loadedScene)) replaceSceneObjects(loadedScene);
  delete particleSystemConfig._editorData.sceneObjects;
  performance.mark('load:scene');

  setTerrain(particleSystemConfig._editorData.terrain?.textureId);
  recreateParticleSystem(false);
  performance.mark('load:system');
  void stillDecoding;

  // Call onLoad callback to notify entries about the loaded config
  if (onLoad) {
    onLoad();
  }
  performance.mark('load:panel');

  // Show success notification
  notify.success('Particle system successfully loaded');
};
