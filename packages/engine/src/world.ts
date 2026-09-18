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
  texture as textureNode,
  uv,
  floor,
} from 'three/tsl';
import {
  particleFeedback,
  defaultFeedbackSettings,
  TRAIL_MASK,
  withTrailSources,
  setFeedbackFrameDelta,
  type FeedbackSettings,
  type ParticleFeedback,
} from './feedback-node';
import {
  postGrade,
  defaultPostEffectSettings,
  type PostEffectSettings,
  type PostGrade,
} from './post-grade';
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
    | 'reflection'
    | 'trail';
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
/**
 * The preview's magnifier (the mouse wheel over the preview window): 1 shows
 * the whole picture, up to PREVIEW_ZOOM_MAX shows that fraction of it, pixel
 * for pixel — nothing is rendered finer, the pixels just get bigger, which is
 * the point: what this render size actually resolves. The centre is in the
 * picture's uv (origin bottom-left).
 */
const PREVIEW_ZOOM_MAX = 5;
let previewZoom = 1;
const previewZoomUniform = uniform(1);
const previewZoomCentre = uniform(new THREE.Vector2(0.5, 0.5));
const previewTexelSize = uniform(new THREE.Vector2(1, 1));

/** Sets the magnifier, keeping the window inside the picture. */
export const setPreviewZoom = (zoom: number, centre?: { u: number; v: number }): void => {
  previewZoom = THREE.MathUtils.clamp(zoom, 1, PREVIEW_ZOOM_MAX);
  const half = 0.5 / previewZoom;
  const c = centre ?? { u: previewZoomCentre.value.x, v: previewZoomCentre.value.y };
  previewZoomCentre.value.set(
    THREE.MathUtils.clamp(c.u, half, 1 - half),
    THREE.MathUtils.clamp(c.v, half, 1 - half)
  );
  previewZoomUniform.value = previewZoom;
};
export const getPreviewZoom = (): { zoom: number; u: number; v: number } => ({
  zoom: previewZoom,
  u: previewZoomCentre.value.x,
  v: previewZoomCentre.value.y,
});
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
/**
 * The particles' afterimage (feedback-node.ts): a property of the camera like
 * the two above, and the last stage — it trails the finished picture,
 * reflections and occlusion included. Everything but `enabled` is a uniform.
 */
let feedbackSettings: FeedbackSettings = defaultFeedbackSettings();
let feedbackStage: ParticleFeedback | null = null;
/**
 * The post effect (post-grade.ts): the finished picture graded — saturation,
 * brightness, contrast, hue, levels. The very last stage, after the feedback,
 * so the trails are graded with everything else.
 */
let postEffectSettings: PostEffectSettings = defaultPostEffectSettings();
let gradeStage: PostGrade | null = null;
/** Which stages the current pipeline was compiled with; rebuilt when that changes. */
let pipelineKey = '';
const currentPipelineKey = (): string =>
  `${ssrSettings.enabled ? 'ssr' : ''}|${aoSettings.enabled ? 'ao' : ''}|${feedbackSettings.enabled ? 'fb' : ''}|${postEffectSettings.enabled ? 'pe' : ''}`;
const pipelineStale = (camera: THREE.PerspectiveCamera): boolean =>
  pipelineCamera !== camera || pipelineKey !== currentPipelineKey();
/** Whether the output camera goes through the post pipeline at all. */
const postEnabled = (): boolean =>
  ssrSettings.enabled ||
  aoSettings.enabled ||
  feedbackSettings.enabled ||
  postEffectSettings.enabled;
/** The pipeline's render; with feedback on, the particles wear their trail mask for it. */
const renderPost = (): void => {
  if (feedbackSettings.enabled) withTrailSources(scene, () => postProcessing!.render());
  else postProcessing!.render();
};

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
      // 1 where a particle material drew (it overrides this through its own
      // mrtNode), 0 everywhere else: what the feedback stage lets into its trail.
      ...(feedbackSettings.enabled ? { [TRAIL_MASK]: vec4(0, 0, 0, 0) } : {}),
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

  feedbackStage?.dispose();
  feedbackStage = null;
  if (feedbackSettings.enabled) {
    feedbackStage = particleFeedback(composite, scenePass.getTextureNode(TRAIL_MASK));
    composite = feedbackStage.node;
  }

  gradeStage = null;
  if (postEffectSettings.enabled) {
    gradeStage = postGrade(composite);
    composite = gradeStage.node;
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
    trail: feedbackStage ? vec4(feedbackStage.layer().rgb, 1) : vec4(0, 0, 0, 1),
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
  feedbackStage?.apply(feedbackSettings);
  gradeStage?.apply(postEffectSettings);
};

/** Compiles the pipeline for the output camera if it is missing or stale. */
export const ensurePostPipeline = (): void => {
  if (outputCamera && postEnabled() && pipelineStale(outputCamera)) buildSsrPipeline(outputCamera);
};

/** Output nodes for each debug view, rebuilt with the pipeline. */
let debugNodes: Record<string, any> = {};

/**
 * Runs `fn` with the renderer reporting a display of w×h CSS pixels.
 *
 * three's screen-space passes — PassNode, SSRNode, GTAONode, and the
 * screen-size uniforms behind them — size their targets from the renderer's
 * drawing buffer, never from the render target they are drawing into. Left
 * alone, the preview's pipeline resolves every pass at the whole canvas and
 * then samples a corner of it: measured at 6016×3018 for a 1360×2954 preview
 * box, the editor at 19 fps against 60 with SSR off, and shrinking the preview
 * changed nothing. For the duration of the preview the renderer says the
 * display is the preview box; the pixel ratio stays the device's, so the
 * passes land at exactly the preview target's size. Own properties shadow
 * the prototype's methods and are deleted afterwards, so nothing else sees it.
 */
const withDisplaySize = <T>(w: number, h: number, fn: () => T): T => {
  const r = renderer as unknown as Record<string, unknown>;
  const ratio = renderer.getPixelRatio();
  r.getSize = (target: THREE.Vector2): THREE.Vector2 => target.set(w, h);
  r.getDrawingBufferSize = (target: THREE.Vector2): THREE.Vector2 =>
    target.set(Math.round(w * ratio), Math.round(h * ratio));
  try {
    return fn();
  } finally {
    delete r.getSize;
    delete r.getDrawingBufferSize;
  }
};

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

  previewTexelSize.value.set(tw, th);
  if (!previewBlit) {
    // The target's texture through a magnifier: the window shows 1/zoom of the
    // picture around a centre, each texel read at its own centre so a
    // magnified pixel is a flat square — the pixels as rendered, not a
    // resample of them. At zoom 1 that is the picture itself.
    const material = new MeshBasicNodeMaterial();
    const zoomed = uv().sub(0.5).div(previewZoomUniform).add(previewZoomCentre);
    const snapped = floor(zoomed.mul(previewTexelSize)).add(0.5).div(previewTexelSize);
    material.colorNode = textureNode(previewTarget.texture, snapped);
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

/** As for AO: `enabled` changes the graph (rebuilt on the next frame), the rest are uniforms. */
export const setFeedbackSettings = (patch: Partial<FeedbackSettings>): void => {
  feedbackSettings = { ...feedbackSettings, ...patch };
  feedbackStage?.apply(feedbackSettings);
};

export const getFeedbackSettings = (): FeedbackSettings => feedbackSettings;
/** Time stepped by the caller (a timeline off real time): stages that fade over time follow it. null = wall clock. */
export const setSteppedFrameDelta = (seconds: number | null): void => setFeedbackFrameDelta(seconds);

/** `enabled` changes the graph; every adjustment is a uniform. */
export const setPostEffectSettings = (patch: Partial<PostEffectSettings>): void => {
  postEffectSettings = { ...postEffectSettings, ...patch };
  gradeStage?.apply(postEffectSettings);
};

export const getPostEffectSettings = (): PostEffectSettings => postEffectSettings;
export { defaultPostEffectSettings, type PostEffectSettings };
export { defaultFeedbackSettings, type FeedbackSettings };

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
let statsContainer: HTMLElement | null = null;

/**
 * Where the editor's frame counter hangs (V2-ARCHITECTURE.md §1.2): the UI
 * hands the engine an element before `createWorld`, the engine never looks
 * for one. The player passes nothing and gets the pinned layer below.
 */
export const setStatsContainer = (el: HTMLElement | null): void => {
  statsContainer = el;
};

const installStats = (): void => {
  stats = new Stats();

  if (!isPlayer()) {
    if (!statsContainer) {
      throw new Error('Stats container not set — call setStatsContainer() before createWorld()');
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
    setViewportInsets,
    getPreviewScale,
    setPreviewScale,
    getPreviewOffset,
    setPreviewOffset,
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
    setFeedbackSettings,
    getFeedbackSettings,
    setPostEffectSettings,
    getPostEffectSettings,
    setPreviewZoom,
    getPreviewZoom,
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
    _ssr: () => ({ postProcessing, ssrPass, aoPass, denoisePass, feedbackStage, gradeStage, previewTarget, previewBlit, pipelineCamera, pipelineKey }),
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
    renderPost();
  } else {
    renderer.render(scene, outputCamera);
  }

  sampleEdgeTint();
  restoreParallax();
};

const PREVIEW_MARGIN = 16;
const PREVIEW_BORDER = 2;
/** How far either side of the border line still counts as grabbing an edge. */
const PREVIEW_GRAB = 8;
const PREVIEW_MIN_RATIO = 0.15;
const PREVIEW_OFFSET_KEY = 'particle-system-editor/preview-offset';

/**
 * Where the preview sits relative to its anchor, the top-right of the free
 * viewport: dragged anywhere, and remembered. (0, 0) is the corner.
 */
let previewOffset = ((): { dx: number; dy: number } => {
  try {
    const stored = JSON.parse(localStorage.getItem(PREVIEW_OFFSET_KEY) || 'null');
    if (stored && Number.isFinite(stored.dx) && Number.isFinite(stored.dy)) return stored;
  } catch {
    /* fresh */
  }
  return { dx: 0, dy: 0 };
})();

export const getPreviewOffset = (): { dx: number; dy: number } => ({ ...previewOffset });

export const setPreviewOffset = (dx: number, dy: number): void => {
  previewOffset = { dx, dy };
  try {
    localStorage.setItem(PREVIEW_OFFSET_KEY, JSON.stringify(previewOffset));
  } catch {
    /* quota — the position still applies for this session */
  }
};

/** Whether the pointer is on the preview (an edge or inside), for the cursor and the border. */
let previewHover: 'edge' | 'inside' | null = null;
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

/** How much of the canvas the UI's panels cover, in canvas CSS pixels. */
export type ViewportInsets = { left: number; right: number; top: number };

/**
 * Given the canvas's rect, where the free viewport is: `left` is the first
 * free x, `right` the last, `top` the first free y — all relative to the
 * canvas's top-left.
 */
export type ViewportInsetsProvider = (canvas: DOMRect) => ViewportInsets;

const fullCanvas: ViewportInsetsProvider = (canvas) => ({ left: 0, right: canvas.width, top: 0 });
let viewportInsets: ViewportInsetsProvider = fullCanvas;

/**
 * The UI tells the engine which part of the canvas is free (V2-ARCHITECTURE.md
 * §1.2 / §1.3b); the engine never reads the UI's DOM to find out. V1 injects
 * its panel geometry, a studio injects its grid cell, the player injects
 * nothing and has the whole canvas. Returns the previous provider so a caller
 * can put it back. `null` restores the full-canvas default.
 */
export const setViewportInsets = (
  provider: ViewportInsetsProvider | null
): ViewportInsetsProvider => {
  const previous = viewportInsets;
  viewportInsets = provider ?? fullCanvas;
  previewBoundsAt = 0;
  return previous;
};

export const freeViewportBounds = (): { left: number; right: number; top: number } => {
  const now = performance.now();
  if (now - previewBoundsAt < PREVIEW_BOUNDS_TTL_MS) return previewBounds;
  previewBoundsAt = now;

  const canvas = canvasBounds();
  const insets = viewportInsets(canvas);
  previewBounds = {
    left: Math.max(0, insets.left),
    right: Math.min(canvas.width, insets.right),
    top: Math.max(0, insets.top),
  };
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

  const canvasH = canvasBounds().height;
  // Anchored to the top-right corner, moved by the stored offset, and never
  // pushed out of the free area.
  const x = THREE.MathUtils.clamp(
    Math.round(free.right - w - PREVIEW_MARGIN + previewOffset.dx),
    free.left + PREVIEW_MARGIN,
    Math.max(free.left + PREVIEW_MARGIN, free.right - w - PREVIEW_MARGIN)
  );
  const y = THREE.MathUtils.clamp(
    Math.round(PREVIEW_MARGIN + free.top + previewOffset.dy),
    free.top + PREVIEW_MARGIN,
    Math.max(free.top + PREVIEW_MARGIN, canvasH - h - PREVIEW_MARGIN)
  );
  return { x, y, w, h };
};

/** True when a point in canvas coordinates is inside the resize grip. */
type PreviewHit = { edges: { l: boolean; r: boolean; t: boolean; b: boolean }; inside: boolean } | null;

/** What the pointer is over: an edge band (to resize), the inside (to move), or nothing. */
const hitPreview = (px: number, py: number): PreviewHit => {
  if (!outputCamera || !previewVisible) return null;
  const { x, y, w, h } = previewRect();
  const g = PREVIEW_GRAB;
  if (px < x - g || px > x + w + g || py < y - g || py > y + h + g) return null;
  const edges = { l: Math.abs(px - x) <= g, r: Math.abs(px - (x + w)) <= g, t: Math.abs(py - y) <= g, b: Math.abs(py - (y + h)) <= g };
  const onEdge = edges.l || edges.r || edges.t || edges.b;
  return { edges, inside: !onEdge };
};

const previewCursor = (hit: PreviewHit): string => {
  if (!hit) return '';
  if (hit.inside) return 'move';
  const { l, r, t: top, b } = hit.edges;
  if ((l && top) || (r && b)) return 'nwse-resize';
  if ((r && top) || (l && b)) return 'nesw-resize';
  if (l || r) return 'ew-resize';
  return 'ns-resize';
};

/** Kept for the harness and the old name: true on any edge. */
const overPreviewHandle = (px: number, py: number): boolean => {
  const hit = hitPreview(px, py);
  return !!hit && !hit.inside;
};

/**
 * The preview is a window you can take hold of: drag an edge and that edge
 * follows the pointer (the opposite edge stays; the frame keeps the camera's
 * aspect, so a top or bottom edge sizes it through its height); drag the
 * inside and the whole window moves. Orbit controls are suspended for the
 * duration so the scene does not spin under it.
 */
const installPreviewResize = (canvas: HTMLCanvasElement): void => {
  let drag: { hit: NonNullable<PreviewHit>; start: { x: number; y: number }; rect: { x: number; y: number; w: number; h: number }; offset: { dx: number; dy: number }; ratio: number } | null = null;
  /** The middle button inside the preview: drag pans the magnified picture, a click without a drag resets it. */
  let pan: { start: { x: number; y: number }; centre: { u: number; v: number }; moved: boolean } | null = null;

  // The wheel over the preview magnifies it about the pointer; anywhere else
  // it is the orbit controls'. Capture, so it is decided before they see it.
  canvas.addEventListener(
    'wheel',
    (event) => {
      const point = toCanvasSpace(event as unknown as PointerEvent);
      const hit = hitPreview(point.x, point.y);
      if (!hit) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const { x, y, w, h } = previewRect();
      // Where the pointer is in the window, and the picture point under it.
      const a = THREE.MathUtils.clamp((point.x - x) / w, 0, 1) - 0.5;
      const b = 0.5 - THREE.MathUtils.clamp((point.y - y) / h, 0, 1);
      const before = getPreviewZoom();
      const under = { u: before.u + a / before.zoom, v: before.v + b / before.zoom };
      const zoom = THREE.MathUtils.clamp(before.zoom * Math.exp(-event.deltaY * 0.002), 1, PREVIEW_ZOOM_MAX);
      // The same picture point stays under the pointer.
      setPreviewZoom(zoom, { u: under.u - a / zoom, v: under.v - b / zoom });
    },
    { capture: true, passive: false }
  );

  canvas.addEventListener(
    'pointerdown',
    (event) => {
      const point = toCanvasSpace(event);
      const hit = hitPreview(point.x, point.y);
      if (!hit) return;
      if (event.button === 1) {
        const z = getPreviewZoom();
        pan = { start: point, centre: { u: z.u, v: z.v }, moved: false };
        controls.enabled = false;
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          /* a synthetic pointer has nothing to capture */
        }
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      drag = { hit, start: point, rect: previewRect(), offset: { ...previewOffset }, ratio: previewWidthRatio };
      controls.enabled = false;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* a synthetic pointer has nothing to capture */
      }
      event.stopPropagation();
      event.preventDefault();
    },
    true
  );

  canvas.addEventListener('pointermove', (event) => {
    const point = toCanvasSpace(event);
    if (pan) {
      const { w, h } = previewRect();
      const dx = point.x - pan.start.x;
      const dy = point.y - pan.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) pan.moved = true;
      // The picture follows the hand: a drag to the right shows what is left of it.
      setPreviewZoom(previewZoom, { u: pan.centre.u - dx / w / previewZoom, v: pan.centre.v + dy / h / previewZoom });
      event.stopPropagation();
      return;
    }
    if (!drag) {
      const hit = hitPreview(point.x, point.y);
      previewHover = hit ? (hit.inside ? 'inside' : 'edge') : null;
      canvas.style.cursor = previewCursor(hit);
      return;
    }
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (drag.hit.inside) {
      setPreviewOffset(drag.offset.dx + dx, drag.offset.dy + dy);
    } else {
      const free = freeViewportBounds();
      const available = free.right - free.left - PREVIEW_MARGIN * 2;
      const aspect = outputAspect();
      const { l, r, t: top, b } = drag.hit.edges;
      // The new width the pointer asks for, whichever edge it holds.
      let w = drag.rect.w;
      if (l) w = drag.rect.w - dx;
      else if (r) w = drag.rect.w + dx;
      else if (top) w = (drag.rect.h - dy) * aspect;
      else if (b) w = (drag.rect.h + dy) * aspect;
      w = Math.max(160, w);
      const ratio = THREE.MathUtils.clamp(w / available, PREVIEW_MIN_RATIO, PREVIEW_MAX_RATIO);
      w = Math.round(available * ratio);
      const h = Math.round(w / aspect);
      // Keep the edge opposite the one being dragged where it was.
      const anchorRight = free.right - PREVIEW_MARGIN;
      const anchorTop = free.top + PREVIEW_MARGIN;
      const newX = l || (!r && !top && !b) ? drag.rect.x + drag.rect.w - w : drag.rect.x;
      const newY = top ? drag.rect.y + drag.rect.h - h : drag.rect.y;
      previewWidthRatio = ratio;
      setPreviewOffset(newX - (anchorRight - w), newY - anchorTop);
      setPreviewScale(ratio);
    }
    event.stopPropagation();
  });

  const end = (event: PointerEvent): void => {
    if (pan) {
      // A middle click that went nowhere: back to the whole picture.
      if (!pan.moved) setPreviewZoom(1, { u: 0.5, v: 0.5 });
      pan = null;
      controls.enabled = true;
      try {
        canvas.releasePointerCapture?.(event.pointerId);
      } catch {
        /* see above */
      }
      return;
    }
    if (!drag) return;
    drag = null;
    controls.enabled = true;
    try {
      canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      /* see above */
    }
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

  // Reflections and occlusion are resolved offscreen first, with no scissor in
  // force. A magnified preview goes the same way even with no post stage on:
  // magnifying is reading the rendered pixels back bigger, so they have to be
  // in a texture first.
  const offscreen = postEnabled() || previewZoom > 1;
  if (offscreen) {
    const target = ensurePreviewTarget(w, h);
    renderer.setScissorTest(false);
    renderer.setRenderTarget(target);
    if (postEnabled()) {
      if (pipelineStale(outputCamera)) buildSsrPipeline(outputCamera);
      withDisplaySize(w, h, renderPost);
    } else {
      renderer.render(scene, outputCamera);
    }
    renderer.setRenderTarget(null);
  }

  renderer.setScissorTest(true);

  // A one-pass border: clear a slightly larger rectangle, then draw inside it.
  const b = PREVIEW_BORDER;
  renderer.setScissor(x - b, y - b, w + b * 2, h + b * 2);
  renderer.setViewport(x - b, y - b, w + b * 2, h + b * 2);
  renderer.setClearColor(previewHover ? 0x9a9a9a : 0x555555, 1);
  renderer.clear(true, false, false);

  renderer.setScissor(x, y, w, h);
  renderer.setViewport(x, y, w, h);
  renderer.setClearColor(0x000000, 1);
  if (offscreen && previewBlit) {
    previewBlit.render(renderer);
  } else {
    renderer.render(scene, outputCamera);
  }

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
      color: 0x242424,
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
