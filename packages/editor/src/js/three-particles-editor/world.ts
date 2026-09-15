import * as THREE from 'three';
import { WebGPURenderer, PostProcessing, QuadMesh, MeshBasicNodeMaterial } from 'three/webgpu';
import {
  pass,
  mrt,
  output,
  normalView,
  metalness,
  roughness,
  blendColor,
  directionToColor,
  colorToDirection,
  sample,
  screenUV,
  vec2,
  vec3,
  vec4,
  mix,
  uniform,
  convertToTexture,
} from 'three/tsl';
import { ssr } from 'three/examples/jsm/tsl/display/SSRNode.js';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { denoise } from 'three/examples/jsm/tsl/display/DenoiseNode.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LightProbeGenerator } from 'three/examples/jsm/lights/LightProbeGenerator.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { TextureId } from './texture-config';
import { getTexture } from './assets';
import { markAsEditorOnly } from './editor-layers';
import { isPlayer } from './runtime-mode';
import {
  applyParallax,
  updateParallax,
  installParallax,
  feedOrientation,
  feedPointer,
  getParallaxState,
  resetParallaxState,
  recenterParallax,
  setParallaxSettings,
} from './parallax';

let scene: THREE.Scene;
let renderer: WebGPURenderer;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let stats: Stats;
let mesh: THREE.Mesh;
let lightProbe: THREE.LightProbe | null = null;
let depthRenderTarget: THREE.RenderTarget | null = null;
/**
 * The camera the artwork is framed for, owned by scene-objects.ts and pushed in
 * here. Pushed rather than imported because scene-objects.ts already depends on
 * this module, and a cycle between them would be fragile.
 */
let outputCamera: THREE.PerspectiveCamera | null = null;
let previewVisible = true;

// ─── Environment ─────────────────────────────────────────────────────────────

export type EnvironmentFormat = 'ldr' | 'hdr' | 'exr';

export type EnvironmentSettings = {
  /** Data URL of the equirectangular panorama, or null for none. */
  source: string | null;
  format: EnvironmentFormat;
  /** How brightly the panorama lights the scene and shows in reflections. */
  intensity: number;
  /** Turns the panorama around the vertical axis, in degrees. */
  rotation: number;
  /** Softens the visible backdrop without affecting the lighting. */
  blur: number;
  /** Show the panorama behind the scene in the editor viewport. */
  showInViewport: boolean;
  /** Show it behind the scene in the output camera. */
  showInCamera: boolean;
};

export const defaultEnvironmentSettings = (): EnvironmentSettings => ({
  source: null,
  format: 'ldr',
  intensity: 1,
  rotation: 0,
  blur: 0,
  showInViewport: true,
  showInCamera: true,
});

let environmentSettings: EnvironmentSettings = defaultEnvironmentSettings();
/** The prefiltered map handed to the scene, and the source it was built from. */
let environmentTexture: THREE.Texture | null = null;
let environmentKey = '';
let pmrem: THREE.PMREMGenerator | null = null;
let defaultBackground: THREE.Color;
let onEnvironmentLoaded: ((error?: string) => void) | null = null;

export const setOnEnvironmentLoaded = (fn: ((error?: string) => void) | null): void => {
  onEnvironmentLoaded = fn;
};

/**
 * Decodes a panorama. The three formats need three different readers, and the
 * browser cannot decode EXR or Radiance on its own, which is why this is not
 * simply a TextureLoader call.
 */
const loadEquirectangular = async (
  source: string,
  format: EnvironmentFormat
): Promise<THREE.Texture> => {
  if (format === 'exr') return new EXRLoader().loadAsync(source);
  if (format === 'hdr') return new HDRLoader().loadAsync(source);

  const texture = await new THREE.TextureLoader().loadAsync(source);
  // Ordinary images are authored for display, so they arrive gamma-encoded.
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

/**
 * Applies the environment, reloading the panorama only when it actually changes.
 *
 * Prefiltering is the expensive part — it renders the panorama into a mip chain
 * so that a rough surface can sample a blurrier version of it — so the result is
 * cached against the source and reused while only the sliders move.
 */
export const setEnvironment = async (next: Partial<EnvironmentSettings>): Promise<void> => {
  environmentSettings = { ...environmentSettings, ...next };
  const { source, format } = environmentSettings;
  const key = source ? `${format}:${source.length}:${source.slice(-64)}` : '';

  if (key !== environmentKey) {
    environmentKey = key;
    environmentTexture?.dispose();
    environmentTexture = null;

    if (source) {
      try {
        const equirect = await loadEquirectangular(source, format);
        // A late arrival for a panorama that has since been replaced.
        if (key !== environmentKey) {
          equirect.dispose();
          return;
        }
        equirect.mapping = THREE.EquirectangularReflectionMapping;
        pmrem = pmrem ?? new THREE.PMREMGenerator(renderer as unknown as THREE.WebGLRenderer);
        environmentTexture = pmrem.fromEquirectangular(equirect).texture;
        equirect.dispose();
        onEnvironmentLoaded?.();
      } catch (error) {
        environmentKey = '';
        onEnvironmentLoaded?.((error as Error)?.message || 'could not be decoded');
      }
    }
  }

  applyEnvironment();
};

/** Pushes the current settings onto the scene, without touching the source. */
const applyEnvironment = (): void => {
  if (!scene) return;
  scene.environment = environmentTexture;
  scene.environmentIntensity = environmentSettings.intensity;
  scene.backgroundIntensity = environmentSettings.intensity;
  scene.backgroundBlurriness = environmentSettings.blur;

  const radians = THREE.MathUtils.degToRad(environmentSettings.rotation);
  scene.environmentRotation.set(0, radians, 0);
  scene.backgroundRotation.set(0, radians, 0);
};

/**
 * What a given view should have behind it.
 *
 * Kept separate from applying it because scene.background holds only one value
 * at a time: after a frame it reads as whatever the last pass wanted, so asking
 * the scene is not a way to find out what a view is configured to show.
 */
export const backdropFor = (view: 'viewport' | 'camera'): THREE.Texture | THREE.Color => {
  const wanted =
    view === 'viewport' ? environmentSettings.showInViewport : environmentSettings.showInCamera;
  return wanted && environmentTexture ? environmentTexture : defaultBackground;
};

/**
 * The backdrop is one scene property but two answers: it can show in the
 * viewport while staying out of the camera, or the reverse. Swapping it around
 * each render is what lets the same panorama light the scene invisibly.
 */
const setBackdropFor = (view: 'viewport' | 'camera'): void => {
  scene.background = backdropFor(view);
};

export const getEnvironmentSettings = (): EnvironmentSettings => environmentSettings;
export const hasEnvironmentTexture = (): boolean => !!environmentTexture;

// ─── Screen space reflections ────────────────────────────────────────────────
//
// Post processing runs on the output camera alone: the viewport has to stay
// legible while you work, and reflections of a drag handle would be nonsense.

export type SsrSettings = {
  enabled: boolean;
  /** Ray march step count, 0..1. */
  quality: number;
  /** Box blur kernel applied to the reflection buffer. Samples go as (n*2+1)^2. */
  blurQuality: number;
  /**
   * Fraction of full resolution the reflections are traced at.
   *
   * Doubles as the softening control that roughness cannot provide: roughness
   * caps at 1 and already selects the blurriest prefiltered mip there, so when
   * a surface still reflects too sharply, tracing coarser and letting the
   * upscale smear it is the lever that remains — and it costs less, not more.
   */
  resolutionScale: number;
  /** How far a ray travels before giving up, in world units. */
  maxDistance: number;
  /** Depth tolerance when deciding a ray hit something. */
  thickness: number;
  opacity: number;
  /**
   * Which stage of the pipeline to show. SSR is fed by several buffers and a
   * wrong one is invisible in the composite, so being able to look at each in
   * isolation is the difference between tuning and guessing.
   */
  debug:
    | 'off'
    | 'color'
    | 'normal'
    | 'metalrough'
    | 'metalness'
    | 'roughness'
    | 'depth'
    | 'ao'
    | 'reflection';
};

let postProcessing: PostProcessing | null = null;
/**
 * Post processing cannot be scissored into a corner. Its internal scene pass
 * obeys whatever scissor is active — three saves and restores the scissor flag
 * around the pass but never clears it — so clipping the output also clips the
 * pass that feeds it, and the whole canvas renders black. The framed view is
 * therefore produced in its own target and blitted into the corner afterwards.
 */
let previewTarget: THREE.RenderTarget | null = null;
let previewBlit: QuadMesh | null = null;
let ssrPass: any = null;
/** The camera the current pipeline was compiled for; rebuilt when it changes. */
let pipelineCamera: THREE.PerspectiveCamera | null = null;

/**
 * Starting values for a new camera.
 *
 * Not the library's own defaults: its maxDistance of 1 is calibrated for a
 * scene a metre across and finds nothing in a room, which reads as "SSR is
 * broken" rather than "the ray gives up too early". These are the values that
 * measurably produce reflections on the test scene.
 */
export const defaultSsrSettings = (): SsrSettings => ({
  enabled: false,
  quality: 1,
  blurQuality: 2,
  resolutionScale: 1,
  maxDistance: 20,
  thickness: 0.15,
  opacity: 1,
  debug: 'off',
});

let ssrSettings: SsrSettings = defaultSsrSettings();

/**
 * Screen-space ambient occlusion for the output camera: the darkening in
 * corners and between grains.
 *
 * A property of the camera like SSR, and composed before it: the reflections
 * trace an already-occluded picture, so a mirror shows a dark corner dark, and
 * the reflection term is dimmed once more by the receiver's own occlusion. The
 * occlusion multiplies the whole beauty pass, direct light included. three's
 * own route, builtinAOContext, only touches indirect light — which a scene lit
 * by one sun does not have — and needs a second scene pass in front of the
 * beauty pass. This is the contact-shade look; `intensity` is how much of it.
 */
export type AoSettings = {
  enabled: boolean;
  /** How much of the occlusion reaches the picture, 0..1. A uniform: free to move. */
  intensity: number;
  /** How far, in world units, a surface looks for what covers it. */
  radius: number;
  /** Horizon samples per pixel, and the cost: three slice directions below 30. */
  samples: number;
  /** How far in front of a pixel a sample may sit and still count as cover. */
  thickness: number;
  /** Contrast: the occlusion raised to this power. */
  scale: number;
  /** Fraction of full resolution the occlusion is computed at. */
  resolutionScale: number;
  /** Radius, in pixels, of the depth- and normal-aware blur over the raw pass. */
  denoise: number;
};

export const defaultAoSettings = (): AoSettings => ({
  enabled: false,
  intensity: 0.7,
  // Grain-sized: a radius of one grain or two shades the contacts between
  // them. A frame-sized radius came out fainter on the test scene, not
  // stronger — the horizons saturate and the cavity is deeper than the reach.
  radius: 0.3,
  samples: 8,
  thickness: 0.5,
  scale: 1.5,
  resolutionScale: 0.5,
  denoise: 4,
});

let aoSettings: AoSettings = defaultAoSettings();
/** A uniform, so the strength slider does not recompile the pipeline. */
const aoIntensity = uniform(0.7);
let aoPass: any = null;
let denoisePass: any = null;
/** Which stages the current pipeline was compiled with; rebuilt when that changes. */
let pipelineKey = '';
const currentPipelineKey = (): string =>
  `${ssrSettings.enabled ? 'ssr' : ''}|${aoSettings.enabled ? 'ao' : ''}`;
const pipelineStale = (camera: THREE.PerspectiveCamera): boolean =>
  pipelineCamera !== camera || pipelineKey !== currentPipelineKey();
/** Whether the output camera goes through the post pipeline at all. */
const postEnabled = (): boolean => ssrSettings.enabled || aoSettings.enabled;

/**
 * Compiles the SSR pipeline for a camera.
 *
 * SSR needs more than a colour buffer: it marches rays against depth and needs
 * a surface's normal and metalness to know what reflects and how sharply. Those
 * come out of a multi-render-target scene pass, which is why this cannot simply
 * wrap the existing render call.
 */
const buildSsrPipeline = (camera: THREE.PerspectiveCamera): void => {
  const scenePass = pass(scene, camera);
  scenePass.setMRT(
    mrt({
      output,
      // Normals are signed but the buffer is not, so they travel encoded.
      normal: directionToColor(normalView),
      metalrough: vec2(metalness, roughness),
    })
  );

  const colorNode = scenePass.getTextureNode('output');
  const depthNode = scenePass.getTextureNode('depth');
  const metalRough = scenePass.getTextureNode('metalrough');
  // Sampled at the screen coordinate rather than handed over as a bare channel.
  // SSR reads metalness with float(), which evaluates a texture node at its
  // default UV — meaningless on the full-screen quad the effect runs on, so the
  // gate `metalness == 0 -> discard` rejected every pixel and the reflection
  // buffer came back empty with every input looking correct.
  const metalnessNode = metalRough.sample(screenUV).r;
  const roughnessNode = metalRough.sample(screenUV).g;

  // The ray march samples neighbouring normals as it walks, so this has to stay
  // something with a `sample(uv)` on it. Decoding the buffer directly with
  // colorToDirection() yields a plain computed node instead, and every step of
  // the loop then throws — which TSL swallows, leaving reflections silently
  // black with correct-looking inputs. `sample()` keeps the decode lazy so the
  // node stays samplable.
  const normalTexture = scenePass.getTextureNode('normal');
  const normalNode = sample((uv) => colorToDirection(normalTexture.sample(uv)));

  // Occlusion first. The raw GTAO pass is noisy by design — a fixed noise
  // tile and no temporal filtering, so nothing shimmers from frame to frame —
  // and a depth- and normal-aware blur takes the noise out. Both the blurred
  // map and the occluded picture are rendered to textures: SSR samples its
  // colour input while it marches and a computed node has no sample(), and the
  // composite reads the map a second time, so the blur should run once.
  let occluded: any = colorNode;
  let aoNode: any = null;
  aoPass = null;
  denoisePass = null;
  if (aoSettings.enabled) {
    aoPass = ao(depthNode, normalNode, camera);
    denoisePass = denoise(aoPass.getTextureNode(), depthNode, normalNode, camera);
    aoNode = convertToTexture(vec4(vec3(denoisePass.r), 1)).r;
    occluded = convertToTexture(vec4(colorNode.rgb.mul(mix(1, aoNode, aoIntensity)), colorNode.a));
  }

  // Reflections trace the occluded picture, and are dimmed once more by the
  // receiver's own occlusion: a reflection in a crevice is as covered as the
  // light that would have reached it.
  ssrPass = null;
  let composite: any = occluded;
  if (ssrSettings.enabled) {
    ssrPass = ssr(occluded, depthNode, normalNode, metalnessNode, roughnessNode, camera);
    const reflection = aoNode ? ssrPass.mul(vec4(vec3(mix(1, aoNode, aoIntensity)), 1)) : ssrPass;
    composite = blendColor(occluded, reflection);
  }

  debugNodes = {
    off: composite,
    color: colorNode,
    normal: scenePass.getTextureNode('normal'),
    metalrough: metalRough,
    // The two halves of metalrough separately: a combined view is dominated by
    // roughness, which is near 1 almost everywhere and hides whether metalness
    // — the channel SSR actually gates on — made it into the buffer at all.
    metalness: vec3(metalRough.r),
    roughness: vec3(metalRough.g),
    depth: vec3(depthNode),
    reflection: ssrPass ?? vec4(0, 0, 0, 1),
    ao: aoNode ? vec4(vec3(aoNode), 1) : vec4(1),
  };

  postProcessing = new PostProcessing(renderer);
  postProcessing.outputNode = debugNodes[ssrSettings.debug];
  // PostProcessing bakes the renderer's output transform (tone mapping and the
  // linear-to-sRGB encode) into its quad, whatever it is rendering into. The
  // player draws straight to the canvas, so that is right there. The editor
  // renders it into the preview target and blits that texture to the canvas
  // afterwards — a second encode on already-encoded values, which lifted every
  // mid-tone (a mean of 44 became 114) and bled the saturation out: the "grey
  // particles" that only ever appeared with reflections on. So here the quad
  // writes linear light and the blit's own output stage does the one encode.
  // Tone mapping would be skipped with it; the project runs none.
  postProcessing.outputColorTransform = isPlayer() || presenting;
  pipelineCamera = camera;
  pipelineKey = currentPipelineKey();
  applySsrUniforms();
  applyAoUniforms();
};

/** Compiles the pipeline for the output camera if it is missing or stale. */
export const ensurePostPipeline = (): void => {
  if (outputCamera && postEnabled() && pipelineStale(outputCamera)) buildSsrPipeline(outputCamera);
};

/** Output nodes for each debug view, rebuilt with the pipeline. */
let debugNodes: Record<string, any> = {};

/** Sizes the offscreen target to the preview box, in device pixels. */
const ensurePreviewTarget = (w: number, h: number): THREE.RenderTarget => {
  const ratio = renderer.getPixelRatio();
  const tw = Math.max(1, Math.round(w * ratio));
  const th = Math.max(1, Math.round(h * ratio));

  if (!previewTarget) {
    previewTarget = new THREE.RenderTarget(tw, th, {
      // Linear light lives here (see buildSsrPipeline); 8 bits of linear would
      // band in the darks the way an image with no gamma does.
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(tw, th),
    });
  } else if (previewTarget.width !== tw || previewTarget.height !== th) {
    previewTarget.setSize(tw, th);
  }

  if (!previewBlit) {
    const material = new MeshBasicNodeMaterial({ map: previewTarget.texture });
    material.depthTest = false;
    material.depthWrite = false;
    previewBlit = new QuadMesh(material);
  }

  return previewTarget;
};

const applySsrUniforms = (): void => {
  if (!ssrPass) return;
  ssrPass.quality.value = ssrSettings.quality;
  ssrPass.blurQuality.value = ssrSettings.blurQuality;
  // A plain property rather than a uniform: the node reads it when it sizes its
  // buffers, which happens every frame in updateBefore.
  ssrPass.resolutionScale = ssrSettings.resolutionScale;
  ssrPass.maxDistance.value = ssrSettings.maxDistance;
  ssrPass.thickness.value = ssrSettings.thickness;
  ssrPass.opacity.value = ssrSettings.opacity;
};

const applyAoUniforms = (): void => {
  aoIntensity.value = aoSettings.intensity;
  if (aoPass) {
    aoPass.radius.value = aoSettings.radius;
    aoPass.samples.value = aoSettings.samples;
    aoPass.thickness.value = aoSettings.thickness;
    aoPass.scale.value = aoSettings.scale;
    // A plain property, like SSR's: read when the node sizes its buffer.
    aoPass.resolutionScale = aoSettings.resolutionScale;
  }
  if (denoisePass) denoisePass.radius.value = Math.max(1, aoSettings.denoise);
};

/**
 * Everything but `enabled` is a uniform and lands on the next frame. Turning
 * the stage on or off changes the graph; the next render sees a stale
 * pipeline key and recompiles.
 */
export const setAoSettings = (patch: Partial<AoSettings>): void => {
  aoSettings = { ...aoSettings, ...patch };
  applyAoUniforms();
};

export const getAoSettings = (): AoSettings => aoSettings;

export const setSsrSettings = (patch: Partial<SsrSettings>): void => {
  const previousDebug = ssrSettings.debug;
  ssrSettings = { ...ssrSettings, ...patch };
  applySsrUniforms();

  if (postProcessing && ssrSettings.debug !== previousDebug && debugNodes[ssrSettings.debug]) {
    postProcessing.outputNode = debugNodes[ssrSettings.debug];
    postProcessing.needsUpdate = true;
  }
};

export const getSsrSettings = (): SsrSettings => ssrSettings;

export const setOutputCamera = (cam: THREE.PerspectiveCamera | null): void => {
  outputCamera = cam;
};

export const getOutputCamera = (): THREE.PerspectiveCamera | null => outputCamera;

export const setPreviewVisible = (visible: boolean): void => {
  previewVisible = visible;
};

export const isPreviewVisible = (): boolean => previewVisible;

/**
 * The frame counter, in whichever window is asking.
 *
 * The editor hangs it in the slot the header already reserves. The display
 * window has no chrome to hang anything on, so it gets a pinned layer of its
 * own — at the window's top-left rather than the canvas's, which puts it on the
 * letterbox bar instead of over the piece.
 *
 * It is there because two windows drawing the same piece cost more than one,
 * and the only honest way to see what that costs is to read it in the window
 * that matters. `S` hides it: a display on a wall should not be wearing a
 * frame counter.
 */
const installStats = (): void => {
  stats = new Stats();

  if (!isPlayer()) {
    const statsContainer = document.querySelector('.stats');
    if (!statsContainer) {
      throw new Error('Stats container not found');
    }
    statsContainer.appendChild(stats.dom);
    return;
  }

  stats.dom.style.position = 'fixed';
  stats.dom.style.left = '0';
  stats.dom.style.top = '0';
  stats.dom.style.zIndex = '10';
  document.body.appendChild(stats.dom);
};

export const isStatsVisible = (): boolean => !!stats && stats.dom.style.display !== 'none';

/** Shows or hides the frame counter; returns whether it ended up visible. */
export const toggleStats = (): boolean => {
  const showing = stats.dom.style.display !== 'none';
  stats.dom.style.display = showing ? 'none' : '';
  return !showing;
};

export const createWorld = async (targetQuery: string): Promise<THREE.Scene> => {
  const container = document.querySelector(targetQuery);
  if (!container) {
    throw new Error(`Container not found: ${targetQuery}`);
  }

  scene = new THREE.Scene();
  installParallax();
  defaultBackground = new THREE.Color(0x000000);
  scene.background = defaultBackground;

  // The ground grid is a working aid, not part of the piece, so the player does
  // not build one at all — layer masking would hide it, but there is no reason
  // to pay for a 50x50 plane in a window that can never show it.
  if (!isPlayer()) {
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(50, 50, 50, 50));
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    markAsEditorOnly(mesh);
    scene.add(mesh);
    setTerrain();
  }

  // No lights are created here on purpose. Everything that lights the scene is
  // added from the Scene panel, so an empty scene really is unlit — otherwise a
  // hidden lamp shows up in renders with no control to turn it off.

  // A half-float canvas removes the 8-bit quantisation that bands smooth
  // gradients, such as a point light's falloff across a wall.
  // material.dithering is not implemented on the WebGPU backend, so output
  // precision is the only lever available. Tone mapping already lands in
  // [0,1], so the extended-range canvas changes precision, not brightness.
  renderer = new WebGPURenderer({
    antialias: true,
    outputType: THREE.HalfFloatType,
    // GPU frame timing, opt-in with ?gputime: a timestamp query per pass is
    // not free. Read renderer.info.render.timestamp (and .compute.timestamp)
    // after renderer.resolveTimestampsAsync(); it is the one frame-cost number
    // that does not depend on rAF cadence, so it survives a hidden panel.
    trackTimestamp: new URLSearchParams(window.location.search).has('gputime'),
  });
  // Shadow maps are opt-in on the renderer; without this every castShadow flag
  // in the scene is inert. Only directional lights cast (scene-objects), so a
  // scene without one pays nothing for it.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Phones report a pixel ratio of 3, and a 3× canvas with reflections is the
  // difference between 20 fps and a usable frame rate on one. Two is where the
  // eye stops telling, so that is the ceiling on a touch device; a desktop
  // keeps whatever it has. The HUD can move it either way at run time.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderScaleCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = 0;
  renderer.toneMappingExposure = 1;
  await renderer.init();
  container.appendChild(renderer.domElement);

  // Create depth render target for soft particles
  depthRenderTarget = new THREE.RenderTarget(window.innerWidth, window.innerHeight, {
    depthTexture: new THREE.DepthTexture(window.innerWidth, window.innerHeight),
  });

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 100);
  camera.position.set(0, 0, 6);
  // The viewport is the only view that shows the editor's furniture; the output
  // camera keeps its default mask and so sees the artwork layer alone.
  camera.layers.enableAll();

  // Nothing in the player is interactive: no orbiting and no preview box to
  // drag — it *is* the preview.
  if (!isPlayer()) {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.target.set(0, 0, 0);
    controls.update();

    installPreviewResize(renderer.domElement);
  }

  installStats();

  window.addEventListener('resize', onWindowResize);

  // TEMP DEBUG
  (window as any).__world = {
    scene,
    camera,
    controls,
    renderer,
    THREE,
    updateLightProbe,
    getLightProbe,
    removeLightProbe,
    getOutputCamera,
    isPreviewVisible,
    freeViewportBounds,
    getPreviewScale,
    setPreviewScale,
    previewRect,
    overPreviewHandle,
    canvasBounds,
    setEnvironment,
    getEnvironmentSettings,
    hasEnvironmentTexture,
    backdropFor,
    setSsrSettings,
    getAoSettings,
    setAoSettings,
    ensurePostPipeline,
    setRenderScale,
    getRenderScale,
    getDrawingBufferSize,
    getSsrSettings,
    // The parallax seam: the harness feeds it samples and checks the geometry.
    parallax: {
      feedOrientation,
      feedPointer,
      update: updateParallax,
      apply: applyParallax,
      state: getParallaxState,
      reset: resetParallaxState,
      recenter: recenterParallax,
      setSettings: setParallaxSettings,
    },
    _ssr: () => ({ postProcessing, ssrPass, aoPass, denoisePass, previewTarget, previewBlit, pipelineCamera, pipelineKey }),
  };

  return scene;
};

/**
 * Ceiling on the pixel ratio the canvas renders at. Infinity means the device's
 * own; touch devices start at 2 (see createWorld). The performance HUD moves it.
 */
let renderScaleCap = navigator.maxTouchPoints > 0 ? 2 : Infinity;

export const setRenderScale = (cap: number): void => {
  renderScaleCap = cap;
  if (!renderer) return;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
  onWindowResize();
};

export const getRenderScale = (): number => renderer?.getPixelRatio() ?? 1;

export const getDrawingBufferSize = (): { width: number; height: number } => {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  return { width: size.x, height: size.y };
};

/**
 * Presentation mode (see presentation.ts): the editor's canvas takes the
 * player's shape and the player's render path for a while.
 */
let presenting = false;

export const isPresenting = (): boolean => presenting;

export const setPresenting = (on: boolean): void => {
  presenting = on;
  if (!on) restoreOutputCameraPreset();
  if (postProcessing) {
    // Straight to the canvas now, so the output transform belongs in the quad
    // again — the same rule buildSsrPipeline applies for the player.
    postProcessing.outputColorTransform = isPlayer() || on;
    postProcessing.needsUpdate = true;
  }
  onWindowResize();
};

const onWindowResize = (): void => {
  if (isPlayer() || presenting) {
    fitPlayerCanvas();
    return;
  }
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (depthRenderTarget) {
    depthRenderTarget.setSize(window.innerWidth, window.innerHeight);
  }
};

export const updateWorld = (
  softParticlesEnabled = false,
  particleContainer?: THREE.Object3D,
  computeNode?: unknown
): void => {
  // Dispatch GPU compute for WebGPU particle simulation
  if (computeNode) {
    (renderer as any).compute(computeNode);
  }

  if (softParticlesEnabled && depthRenderTarget) {
    // Hide particle system during depth pass to avoid feedback loop
    // (the particle shader reads the depth texture that would be written to)
    if (particleContainer) particleContainer.visible = false;
    setBackdropFor('viewport');
    renderer.setRenderTarget(depthRenderTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    if (particleContainer) particleContainer.visible = true;
  }
  setBackdropFor('viewport');
  renderer.render(scene, camera);

  // The preview may want the panorama hidden while the viewport shows it, so
  // the backdrop is chosen again rather than left over from the pass above.
  setBackdropFor('camera');
  renderPreview();
  stats.update();
};

/**
 * The output camera's aspect, honouring "fit window" (aspect 0 on the scene
 * object, flagged on the camera): then it is whatever the window is right now,
 * and the camera's projection is kept in step here, since this is read every
 * time something is sized to it.
 */
const outputAspect = (): number => {
  if (!outputCamera) return 16 / 9;
  if (outputCamera.userData.fitWindow) {
    const aspect = window.innerWidth / window.innerHeight;
    if (outputCamera.aspect !== aspect) {
      outputCamera.aspect = aspect;
      outputCamera.updateProjectionMatrix();
    }
    return aspect;
  }
  // The composed frame, whatever the camera is aimed at right now.
  return outputCamera.userData.presetAspect || outputCamera.aspect || 16 / 9;
};

const isStandalone = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const safeAreaTop = (): number =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0;

/** The "large viewport" — 100lvh — measured, since only CSS knows it. */
const largeViewportHeight = (): number => {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:100lvh;visibility:hidden;pointer-events:none;';
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h || window.innerHeight;
};

export type ViewportMetrics = {
  /** How tall the display is drawn. */
  height: number;
  /** Extra above the layout viewport, if the page sits below the status bar. */
  top: number;
  /** Extra below it, if the page sits under the status bar and stops short. */
  bottom: number;
};

/**
 * How tall the display really is: the window, and nothing more.
 *
 * On an iPhone opened from the Home Screen, iOS 27 beta gives the page a web view
 * the screen minus the status bar (measured: 894 of 956) even though CSS's
 * large viewport says the whole screen. A translucent status bar moves that
 * view up under the bar and leaves a strip at the bottom; an opaque one
 * leaves the view below the bar. Drawing past the view was tried both ways:
 * the strip stays black and the piece loses an edge instead. So the display
 * is the view, edge to edge, and the strip is the platform's. The large
 * viewport and the insets are still measured for the HUD.
 */
/**
 * The layout viewport, not the visual one. On iOS `window.innerWidth/Height`
 * shrink to whatever a pinch — or the zoom Safari applies when a small text
 * field takes focus — leaves on screen, and a canvas sized to that ends up as
 * a magnified corner of the page. The document's client size is the page.
 */
const layoutViewport = (): { width: number; height: number } => ({
  width: Math.max(1, document.documentElement.clientWidth || window.innerWidth),
  height: Math.max(1, document.documentElement.clientHeight || window.innerHeight),
});

export const viewportMetrics = (): ViewportMetrics => {
  const h = layoutViewport().height;
  void isStandalone;
  void largeViewportHeight;
  void safeAreaTop;
  return { height: h, top: 0, bottom: 0 };
};

export const viewportHeight = (): number => viewportMetrics().height;

/** What the display adds below the layout viewport; the bars sit above it. */
export const viewportGap = (): number => viewportMetrics().bottom;

/**
 * A display that is held: a phone or a tablet, where the window is the whole
 * screen and a bar would be a strip of the piece missing. The same test the
 * pixel-ratio cap uses.
 */
const isHandheldDisplay = (): boolean => navigator.maxTouchPoints > 0;

/**
 * Points the output camera at the window so that the composed frame *covers*
 * it: the window's aspect, and a field of view that keeps the composition's
 * height when the window is narrower than the frame, or its width when the
 * window is wider — cropping the rest rather than leaving bars.
 */
const coverOutputCamera = (windowAspect: number): void => {
  if (!outputCamera) return;
  const presetAspect: number = outputCamera.userData.presetAspect || windowAspect;
  const presetFov: number = outputCamera.userData.presetFov ?? outputCamera.fov;
  outputCamera.aspect = windowAspect;
  if (windowAspect < presetAspect) {
    outputCamera.fov = presetFov;
  } else {
    const halfHeight =
      Math.tan(THREE.MathUtils.degToRad(presetFov / 2)) * (presetAspect / windowAspect);
    outputCamera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfHeight));
  }
  outputCamera.updateProjectionMatrix();
};

/** The camera on its preset lens, at the shape the canvas was cut to. */
const fitOutputCamera = (canvasAspect: number): void => {
  if (!outputCamera) return;
  outputCamera.aspect = canvasAspect;
  outputCamera.fov = outputCamera.userData.presetFov ?? outputCamera.fov;
  outputCamera.updateProjectionMatrix();
};

/** The camera back to its composed frame, after presenting. */
const restoreOutputCameraPreset = (): void => {
  if (!outputCamera) return;
  const presetAspect: number = outputCamera.userData.presetAspect || 0;
  outputCamera.aspect = presetAspect || window.innerWidth / window.innerHeight;
  if (outputCamera.userData.presetFov !== undefined)
    outputCamera.fov = outputCamera.userData.presetFov;
  outputCamera.updateProjectionMatrix();
};

/**
 * Sizes the canvas for the display and aims the output camera at it. The
 * player and presentation mode both come through here.
 *
 * Two displays, two rules. A phone is the piece's own screen: the canvas is
 * the whole window and the camera covers it — a display of another shape
 * shows the composition cropped at the edges, never a bar. A desktop is a
 * window onto the piece: the whole composed frame is shown, the canvas shrunk
 * to the frame's shape and centred, the page's black showing at the sides of
 * a portrait piece on a wide screen (or above and below a wide piece on a
 * tall window). The camera keeps its preset lens there, so what is on screen
 * is exactly the editor's preview, only larger. "Fit window" frames have no
 * shape of their own and fill either display.
 *
 * Letterboxing by shrinking the canvas rather than scissoring inside a
 * full-window one is not a shortcut: post processing cannot be scissored —
 * its internal scene pass obeys the same rectangle and the whole thing comes
 * back black — and a canvas that is already the shape of the frame needs no
 * rectangle at all.
 */
export const fitPlayerCanvas = (): void => {
  if (!renderer) return;
  const windowWidth = layoutViewport().width;
  const { height: windowHeight, top, bottom } = viewportMetrics();
  const root = document.documentElement.style;
  root.setProperty('--viewport-gap', `${bottom}px`);
  root.setProperty('--viewport-top-gap', `${top}px`);

  const presetAspect: number = outputCamera?.userData.presetAspect || 0;
  const contain = presetAspect > 0 && !isHandheldDisplay();
  let w = windowWidth;
  let h = windowHeight;
  if (contain) {
    if (windowWidth / windowHeight > presetAspect) w = Math.round(windowHeight * presetAspect);
    else h = Math.round(windowWidth / presetAspect);
  }
  renderer.setSize(w, h);
  depthRenderTarget?.setSize(w, h);
  if (contain) fitOutputCamera(w / h);
  else coverOutputCamera(w / h);
};

/**
 * One frame of the display window: the output camera, full canvas, nothing else.
 *
 * The editor's equivalent draws the viewport first and squeezes this view into
 * a corner afterwards. Here it is the only pass, which is why the reflections
 * can go straight to the canvas instead of through an offscreen target.
 */
// ─── Edge tint ───────────────────────────────────────────────────────────────
//
// The bars a phone keeps for itself — Safari's, or the status bar of a Home
// Screen app — take the page's theme colour. Kept at the colour of the
// piece's own top edge, the bar reads as the picture continuing under it
// rather than a black strip; it is what makes a page look edge to edge on an
// iPhone when it is not. A 32×32 render of the output camera twice a second
// is all it costs.

const TINT_INTERVAL_MS = 500;
let tintTarget: THREE.RenderTarget | null = null;
let tintPending = false;
let lastTintAt = 0;
let lastTint = '';

const encodeSrgb = (v: number): number =>
  Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));

const setThemeColor = (hex: string): void => {
  if (hex === lastTint) return;
  lastTint = hex;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = hex;
  document.documentElement.style.setProperty('--edge-tint', hex);
};

const sampleEdgeTint = (): void => {
  if (!outputCamera || tintPending) return;
  const now = performance.now();
  if (now - lastTintAt < TINT_INTERVAL_MS) return;
  lastTintAt = now;

  const size = 32;
  if (!tintTarget)
    tintTarget = new THREE.RenderTarget(size, size, { type: THREE.UnsignedByteType });
  renderer.setRenderTarget(tintTarget);
  renderer.render(scene, outputCamera);
  renderer.setRenderTarget(null);

  tintPending = true;
  void renderer
    .readRenderTargetPixelsAsync(tintTarget, 0, 0, size, size)
    .then((raw: ArrayLike<number>) => {
      // WebGPU pads rows to 256 bytes: 32 texels × 4 bytes = 128 → 64 texels per row.
      const rowTexels = Math.max(size, Math.ceil((size * 4) / 256) * (256 / 4));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * rowTexels + x) * 4;
          r += raw[i];
          g += raw[i + 1];
          b += raw[i + 2];
          n++;
        }
      }
      const hex =
        '#' +
        [r, g, b]
          .map((c) =>
            encodeSrgb(c / n / 255)
              .toString(16)
              .padStart(2, '0')
          )
          .join('');
      setThemeColor(hex);
    })
    .catch(() => undefined)
    .then(() => {
      tintPending = false;
    });
};

export const renderPlayer = (
  softParticlesEnabled = false,
  particleContainer?: THREE.Object3D,
  computeNode?: unknown
): void => {
  // Counted before the early return: a display waiting for a camera is still
  // spinning the loop, and a reading frozen at the last real frame would hide
  // that rather than show it.
  stats.update();

  if (computeNode) {
    (renderer as any).compute(computeNode);
  }
  if (!outputCamera) return;

  // The screen as a window: the eye moves with the phone's tilt, the frame's
  // plane stays put. Undone right after the frame, so nothing else sees it.
  updateParallax();
  const restoreParallax = applyParallax(outputCamera);

  setBackdropFor('camera');

  if (softParticlesEnabled && depthRenderTarget) {
    // Same feedback loop as the viewport: the particle shader reads the depth
    // texture the pass would be writing.
    if (particleContainer) particleContainer.visible = false;
    renderer.setRenderTarget(depthRenderTarget);
    renderer.render(scene, outputCamera);
    renderer.setRenderTarget(null);
    if (particleContainer) particleContainer.visible = true;
    setBackdropFor('camera');
  }

  if (postEnabled()) {
    if (pipelineStale(outputCamera)) buildSsrPipeline(outputCamera);
    postProcessing!.render();
  } else {
    renderer.render(scene, outputCamera);
  }

  sampleEdgeTint();
  restoreParallax();
};

const PREVIEW_MARGIN = 16;
const PREVIEW_BORDER = 2;
/** Side of the square grab area in the preview's bottom-left corner. */
const PREVIEW_HANDLE = 20;
const PREVIEW_MIN_RATIO = 0.15;
/**
 * Lets the preview fill the free area edge to edge. That clears half the screen
 * with both panels open, and collapsing the left one takes it well past that.
 */
const PREVIEW_MAX_RATIO = 1;
const PREVIEW_SCALE_KEY = 'particle-system-editor/preview-scale';

/** Fraction of the free viewport width the preview occupies; drag to change. */
let previewWidthRatio = (() => {
  const stored = Number(localStorage.getItem(PREVIEW_SCALE_KEY));
  return stored >= PREVIEW_MIN_RATIO && stored <= PREVIEW_MAX_RATIO ? stored : 0.3;
})();

export const getPreviewScale = (): number => previewWidthRatio;

export const setPreviewScale = (ratio: number): void => {
  previewWidthRatio = Math.min(PREVIEW_MAX_RATIO, Math.max(PREVIEW_MIN_RATIO, ratio));
  try {
    localStorage.setItem(PREVIEW_SCALE_KEY, String(previewWidthRatio));
  } catch {
    /* quota — the size still applies for this session */
  }
};
/**
 * The canvas spans the whole window and the side panels float on top of it, so
 * the preview has to dodge them or it renders underneath. Their widths change
 * when a panel collapses, hence measuring rather than hard-coding — but reading
 * layout every frame would thrash, so the answer is cached briefly.
 */
const PREVIEW_BOUNDS_TTL_MS = 250;
let previewBounds: { left: number; right: number; top: number } = { left: 0, right: 0, top: 0 };
let previewBoundsAt = 0;

/**
 * The canvas does not start at the window's top left — a toolbar sits above it.
 * Viewport and scissor rectangles are relative to the canvas, so everything the
 * preview computes has to be too, or the drawn box and the area that reacts to
 * the mouse end up offset by the height of that toolbar.
 */
export const canvasBounds = (): DOMRect => renderer.domElement.getBoundingClientRect();

/** The drawing surface itself, for the one caller that needs to style it. */
export const getCanvas = (): HTMLCanvasElement => renderer.domElement as HTMLCanvasElement;

/** A pointer event in canvas coordinates. */
const toCanvasSpace = (event: PointerEvent): { x: number; y: number } => {
  const rect = canvasBounds();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
};

/** Below this much room between the panels, the layout is a phone's. */
const NARROW_FREE_WIDTH = 220;

export const freeViewportBounds = (): { left: number; right: number; top: number } => {
  const now = performance.now();
  if (now - previewBoundsAt < PREVIEW_BOUNDS_TTL_MS) return previewBounds;
  previewBoundsAt = now;

  const canvas = canvasBounds();
  const rightPanel = document.querySelector('.right-panel');
  const leftPanel = document.querySelector('.panel-content');
  const left = leftPanel ? leftPanel.getBoundingClientRect().right - canvas.left : 0;
  let right = rightPanel ? rightPanel.getBoundingClientRect().left - canvas.left : canvas.width;
  let top = 0;

  // A phone in portrait: the control panel's column spans the full height and
  // leaves no room beside it, so the preview would land under a panel and its
  // buttons with it — which is how presentation mode became unreachable
  // without turning the phone sideways. There the preview takes the canvas's
  // full width and sits below the panel's (collapsed) title bar instead.
  if (right - left < NARROW_FREE_WIDTH) {
    right = canvas.width;
    const gui = document.querySelector('.right-panel .lil-gui.root');
    if (gui) {
      const rect = gui.getBoundingClientRect();
      if (rect.height < 200) top = Math.max(0, rect.bottom - canvas.top);
    }
  }

  previewBounds = { left, right, top };
  return previewBounds;
};

/**
 * Where the preview sits, in CSS pixels with the origin at the top left.
 *
 * Rendering and hit-testing both read this, so a dragged handle cannot drift
 * away from the box it is supposed to be attached to.
 */
export const previewRect = (): { x: number; y: number; w: number; h: number } => {
  const free = freeViewportBounds();
  const aspect = outputAspect();
  const available = free.right - free.left - PREVIEW_MARGIN * 2;

  let w = Math.round(Math.max(160, available * previewWidthRatio));
  let h = Math.round(w / aspect);

  // A tall output frame would otherwise run off the bottom of the canvas.
  const maxH = canvasBounds().height - free.top - PREVIEW_MARGIN * 2;
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * aspect);
  }

  return { x: Math.round(free.right - w - PREVIEW_MARGIN), y: PREVIEW_MARGIN + free.top, w, h };
};

/** True when a point in canvas coordinates is inside the resize grip. */
const overPreviewHandle = (px: number, py: number): boolean => {
  if (!outputCamera || !previewVisible) return false;
  const { x, y, h } = previewRect();
  return (
    px >= x - PREVIEW_BORDER &&
    px <= x + PREVIEW_HANDLE &&
    py >= y + h - PREVIEW_HANDLE &&
    py <= y + h + PREVIEW_BORDER
  );
};

/**
 * Lets the preview be dragged to any size from a corner thumbnail up to most of
 * the viewport, because judging reflections in a 200px box is guesswork.
 *
 * The grip is at the bottom-left because the box is pinned to the top-right:
 * dragging away from the anchor grows it, which is the direction that reads as
 * "bigger". Orbit controls are suspended for the duration so the scene does not
 * spin while resizing.
 */
const installPreviewResize = (canvas: HTMLCanvasElement): void => {
  let dragging = false;
  let startX = 0;
  let startRatio = 0;

  canvas.addEventListener(
    'pointerdown',
    (event) => {
      const point = toCanvasSpace(event);
      if (!overPreviewHandle(point.x, point.y)) return;
      dragging = true;
      startX = point.x;
      startRatio = previewWidthRatio;
      controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      event.stopPropagation();
      event.preventDefault();
    },
    true
  );

  canvas.addEventListener('pointermove', (event) => {
    const point = toCanvasSpace(event);
    if (!dragging) {
      canvas.style.cursor = overPreviewHandle(point.x, point.y) ? 'nesw-resize' : '';
      return;
    }
    const free = freeViewportBounds();
    const available = free.right - free.left - PREVIEW_MARGIN * 2;
    // Dragging left is away from the top-right anchor, so it enlarges.
    setPreviewScale(startRatio + (startX - point.x) / available);
    event.stopPropagation();
  });

  const end = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    controls.enabled = true;
    canvas.releasePointerCapture?.(event.pointerId);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
};

/**
 * Draws the output camera's view into the top-right of the free viewport area.
 *
 * Scissoring is what makes this affordable to bolt onto the existing frame: the
 * second render clears and draws only inside the corner rectangle, so the main
 * viewport underneath survives untouched.
 *
 * Coordinates are CSS pixels with the origin at the TOP left — WebGPU's
 * convention, and the opposite of WebGL's.
 */
const renderPreview = (): void => {
  if (!outputCamera || !previewVisible) return;

  updateParallax();
  const restoreParallax = applyParallax(outputCamera);

  const size = renderer.getSize(new THREE.Vector2());
  const { x, y, w, h } = previewRect();

  const previousClear = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();

  // Reflections and occlusion are resolved offscreen first, with no scissor in force.
  if (postEnabled()) {
    if (pipelineStale(outputCamera)) buildSsrPipeline(outputCamera);
    const target = ensurePreviewTarget(w, h);
    renderer.setScissorTest(false);
    renderer.setRenderTarget(target);
    postProcessing!.render();
    renderer.setRenderTarget(null);
  }

  renderer.setScissorTest(true);

  // A one-pass border: clear a slightly larger rectangle, then draw inside it.
  const b = PREVIEW_BORDER;
  renderer.setScissor(x - b, y - b, w + b * 2, h + b * 2);
  renderer.setViewport(x - b, y - b, w + b * 2, h + b * 2);
  renderer.setClearColor(0x555555, 1);
  renderer.clear(true, false, false);

  renderer.setScissor(x, y, w, h);
  renderer.setViewport(x, y, w, h);
  renderer.setClearColor(0x000000, 1);
  if (postEnabled() && previewBlit) {
    previewBlit.render(renderer);
  } else {
    renderer.render(scene, outputCamera);
  }

  // The grip, drawn last so it sits on top of the rendered frame.
  renderer.setScissor(
    x - PREVIEW_BORDER,
    y + h - PREVIEW_HANDLE,
    PREVIEW_HANDLE,
    PREVIEW_HANDLE + PREVIEW_BORDER
  );
  renderer.setViewport(
    x - PREVIEW_BORDER,
    y + h - PREVIEW_HANDLE,
    PREVIEW_HANDLE,
    PREVIEW_HANDLE + PREVIEW_BORDER
  );
  renderer.setClearColor(0xb34a2c, 1);
  renderer.clear(true, false, false);

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.setScissor(0, 0, size.x, size.y);
  renderer.setClearColor(previousClear, previousAlpha);
  restoreParallax();
};

/**
 * Puts the viewport back on the scene from a three-quarter view.
 *
 * Framing is measured rather than fixed: a scene can be a one-metre prop or a
 * twelve-metre room, and a hard-coded distance would land inside one and miles
 * from the other. Only the artwork layer counts, so the 50m terrain grid does
 * not drag the framing out to nothing.
 */
export const resetCamera = (): void => {
  const artworkOnly = new THREE.Layers();
  artworkOnly.set(0);

  const bounds = new THREE.Box3();
  scene.children.forEach((child) => {
    if (child.visible && child.layers.test(artworkOnly)) bounds.expandByObject(child);
  });

  const target = new THREE.Vector3();
  let radius = 6;
  if (!bounds.isEmpty()) {
    bounds.getCenter(target);
    // GPU-simulated particles move in the shader, so their reported bounds can
    // be anything; clamping keeps one odd object from throwing away the framing.
    radius = THREE.MathUtils.clamp(bounds.getSize(new THREE.Vector3()).length() / 2, 2, 40);
  }

  // 45 degrees around and 45 degrees up — the angle that shows three sides of a
  // box at once, and the one every 3D package calls "home".
  const diagonal = Math.SQRT1_2;
  const direction = new THREE.Vector3(diagonal * diagonal, diagonal, diagonal * diagonal);
  const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15;

  camera.position.copy(target).addScaledVector(direction, distance);
  // Grow the far plane if the scene outruns it, but never shrink it: the depth
  // range is shared with soft particles and shadows.
  if (distance * 3 > camera.far) {
    camera.far = distance * 3;
    camera.updateProjectionMatrix();
  }

  controls.target.copy(target);
  controls.update();
};

export const setTerrain = (textureId?: string): void => {
  // Loading a config calls this; in the player there is no plane to apply it to.
  if (!mesh) return;

  if (!textureId || textureId === TextureId.WIREFRAME) {
    const material = new THREE.MeshBasicMaterial({
      wireframe: true,
      depthWrite: false,
      color: 0x111111,
    });
    mesh.material = material;
    mesh.receiveShadow = false; // a wireframe grid cannot show a shadow
  } else {
    const { map } = getTexture(textureId);
    map.wrapS = THREE.MirroredRepeatWrapping;
    map.wrapT = THREE.MirroredRepeatWrapping;
    map.repeat.x = 50;
    map.repeat.y = 50;
    map.colorSpace = THREE.SRGBColorSpace;
    // Standard material so the ground actually receives the shadow.
    mesh.material = new THREE.MeshStandardMaterial({
      map,
      roughness: 0.9,
      metalness: 0,
    });
    mesh.receiveShadow = true;
  }
};

/**
 * Captures the scene into a cube map and fits a light probe to it, so surfaces
 * pick up indirect light from their surroundings — the bounce off the white
 * room walls rather than only the direct hit from each lamp.
 *
 * The particle container is hidden during the capture: particles are the thing
 * being lit, and including them would feed their own brightness back into the
 * probe.
 */
export const updateLightProbe = async (
  intensity = 1,
  hideDuringCapture?: THREE.Object3D,
  capturePosition?: THREE.Vector3
): Promise<THREE.LightProbe> => {
  const cubeTarget = new THREE.WebGLCubeRenderTarget(128, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    generateMipmaps: false,
  });
  const cubeCamera = new THREE.CubeCamera(0.1, 100, cubeTarget);
  // Where the probe is sampled matters: a flat emissive sheet contributes
  // almost nothing to a capture taken level with it, because it covers hardly
  // any solid angle from there.
  cubeCamera.position.copy(capturePosition ?? controls.target);

  const wasVisible = hideDuringCapture?.visible;
  if (hideDuringCapture) hideDuringCapture.visible = false;
  if (lightProbe) lightProbe.visible = false;

  cubeCamera.update(renderer as unknown as THREE.WebGLRenderer, scene);

  if (hideDuringCapture && wasVisible !== undefined) {
    hideDuringCapture.visible = wasVisible;
  }

  const probe = await LightProbeGenerator.fromCubeRenderTarget(
    renderer as unknown as THREE.WebGLRenderer,
    cubeTarget
  );

  if (lightProbe) scene.remove(lightProbe);
  lightProbe = probe;
  lightProbe.intensity = intensity;
  scene.add(lightProbe);

  cubeTarget.dispose();
  return lightProbe;
};

export const getLightProbe = (): THREE.LightProbe | null => lightProbe;

export const removeLightProbe = (): void => {
  if (lightProbe) {
    scene.remove(lightProbe);
    lightProbe = null;
  }
};

/**
 * Compiles the materials the viewport and the output camera will draw, ahead
 * of the first frame and off the main thread where the platform allows
 * (createRenderPipelineAsync). The first frame otherwise carries every
 * shader compilation in one synchronous block.
 */
export const compileWorld = async (): Promise<void> => {
  const compile = (renderer as unknown as {
    compileAsync?: (scene: THREE.Scene, camera: THREE.Camera) => Promise<void>;
  }).compileAsync;
  if (!compile) return;
  try {
    await compile.call(renderer, scene, camera);
    if (outputCamera) await compile.call(renderer, scene, outputCamera);
  } catch {
    /* the first frame compiles the rest */
  }
};

export const getScene = (): THREE.Scene => scene;
export const getRenderer = () => renderer;
export const getCamera = (): THREE.PerspectiveCamera => camera;
export const getRendererDomElement = (): HTMLCanvasElement => renderer.domElement;
export const getOrbitControls = (): OrbitControls => controls;
export const getDepthTexture = (): THREE.DepthTexture | null =>
  depthRenderTarget?.depthTexture ?? null;

export const captureScreenshot = (): void => {
  // Render the current frame
  renderer.render(scene, camera);

  // Create a temporary canvas with 640x480 resolution
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const context = canvas.getContext('2d');

  if (!context) {
    console.error('Failed to get 2D context for screenshot');
    return;
  }

  // Draw the renderer's canvas to our temporary canvas (this will resize it)
  context.drawImage(renderer.domElement, 0, 0, 640, 480);

  // Convert to WebP and download
  canvas.toBlob(
    (blob) => {
      if (!blob) {
        console.error('Failed to create screenshot blob');
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      link.download = `particle-effect-${timestamp}.webp`;
      link.href = url;
      link.click();

      // Clean up
      URL.revokeObjectURL(url);
    },
    'image/webp',
    0.95
  );
};
