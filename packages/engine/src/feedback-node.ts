// The output camera's feedback: the particles' afterimage, as a post stage.
//
// The recursion a feedback loop is: last frame's trail layer, faded, combined
// with this frame. One half-float target and one full-screen pass whatever the
// particle count — 200k particles each drawn thirty more times is the other
// way to get the same picture.
//
// The trail layer holds particles only. The scene pass writes a mask (1 from a
// particle material, 0 from everything else — see `markAsTrailSource`), and
// only masked pixels enter the history: a frame, a wall or the backdrop never
// accumulates, stays exactly as drawn, and does not smear when the parallax
// camera moves. The picture is put back together as
//   out = (this frame − its particles) + the trail layer
// and the modes differ in how the layer is carried forward, with P this
// frame's particles, M their mask, T the layer so far and d the fade:
//   lighter  T' = max(P, d·T)         the brighter of now and the fading past
//   mix      T' = mix(P, T, d)        a running average: soft, heads dim a little
//   over     T' = P + (1 − M)·d·T     now on top, the past beneath it, each
//                                     layer fainter; an opaque particle hides
//                                     what is under it, so nothing stacks up
// d = exp(−dt / persistence): a time constant, so 60 and 120 fps trail alike.

import * as THREE from 'three';
import { RenderTarget, Vector2, QuadMesh, NodeMaterial, RendererUtils, TempNode, NodeUpdateType } from 'three/webgpu';
import { Fn, float, uv, texture, passTexture, max, mix, uniform, vec4, nodeObject, convertToTexture, mrt } from 'three/tsl';

export type FeedbackMode = 'lighter' | 'mix' | 'over';

export type FeedbackSettings = {
  enabled: boolean;
  mode: FeedbackMode;
  /** Seconds for a trail to fade to about a third (the fade's time constant). */
  persistence: number;
  /** How much of the trail reaches the picture, 0..1. */
  amount: number;
};

export const defaultFeedbackSettings = (): FeedbackSettings => ({
  enabled: false,
  mode: 'lighter',
  persistence: 0.5,
  amount: 1,
});

const MODE_INDEX: Record<FeedbackMode, number> = { lighter: 0, mix: 1, over: 2 };

/** The MRT attachment the mask travels in. */
export const TRAIL_MASK = 'trail';

/**
 * Marks a material as one whose pixels leave a trail: inside the feedback
 * pipeline's scene pass it writes 1 into the mask attachment, where every
 * other material writes the pass's default 0.
 *
 * The override is only *worn* during that pass (`withTrailSources`). A
 * material that carries an mrtNode all the time draws nothing but that node
 * into any other render target — three takes the material's MRT as the whole
 * output when the target has none of its own — and the particles vanished
 * from every target but the pipeline's.
 */
export const markAsTrailSource = (material: THREE.Material | THREE.Material[] | null | undefined): void => {
  const list = Array.isArray(material) ? material : material ? [material] : [];
  for (const m of list) {
    if (!(m as any).isNodeMaterial) continue;
    m.userData.trailMrt = mrt({ [TRAIL_MASK]: vec4(1, 1, 1, 1) });
  }
};

const trailMaterials = (scene: THREE.Object3D): any[] => {
  const found: any[] = [];
  scene.traverse((o: any) => {
    const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of list) if (m.userData?.trailMrt) found.push(m);
  });
  return found;
};

/**
 * Runs `fn` — the feedback pipeline's render — with the trail sources wearing
 * their mask. Programs are compiled per render context, inside the render that
 * first needs them, so the pipeline's programs get the mask and nobody else's do.
 */
export const withTrailSources = <T>(scene: THREE.Object3D, fn: () => T): T => {
  const materials = trailMaterials(scene);
  for (const m of materials) m.mrtNode = m.userData.trailMrt;
  try {
    return fn();
  } finally {
    for (const m of materials) m.mrtNode = null;
  }
};

const _size = new Vector2();
const _quad = new QuadMesh();
let _rendererState: any;

class FeedbackNode extends (TempNode as any) {
  static get type(): string {
    return 'ParticleFeedbackNode';
  }

  /** Per-frame fade, written from `persistence` and the frame's own dt. */
  readonly decay = uniform(0.9);
  readonly amount = uniform(1);
  readonly mode = uniform(0);
  persistence = 0.5;

  private _layerRT: RenderTarget;
  private _oldRT: RenderTarget;
  private _layerNode: any;
  private _oldNode: any;
  private _outputRT: RenderTarget;
  private _outputNode: any;
  private _layerMaterial: NodeMaterial | null = null;
  private _outputMaterial: NodeMaterial | null = null;
  private _last = 0;

  constructor(
    private readonly colorNode: any,
    private readonly maskNode: any
  ) {
    super('vec4');
    const options = { depthBuffer: false, type: THREE.HalfFloatType };
    this._layerRT = new RenderTarget(1, 1, options);
    this._layerRT.texture.name = 'Feedback.layer';
    this._oldRT = new RenderTarget(1, 1, options);
    this._oldRT.texture.name = 'Feedback.old';
    this._outputRT = new RenderTarget(1, 1, options);
    this._outputRT.texture.name = 'Feedback.output';
    this._layerNode = texture(this._layerRT.texture);
    this._oldNode = texture(this._oldRT.texture);
    this._outputNode = passTexture(this as any, this._outputRT.texture);
    (this as any).updateBeforeType = NodeUpdateType.FRAME;
  }

  /** The trail layer alone, for a debug view. */
  getLayerNode(): any {
    return this._layerNode;
  }

  updateBefore(frame: any): void {
    const renderer = frame.renderer;
    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState);

    renderer.getDrawingBufferSize(_size);
    for (const rt of [this._layerRT, this._oldRT, this._outputRT]) rt.setSize(_size.x, _size.y);

    // The fade for this frame's dt. A long gap (a hidden tab, a suspended
    // editor) would otherwise be one enormous step; it is simply a cleared trail.
    const now = performance.now();
    const dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 1 / 60;
    this._last = now;
    this.decay.value = this.persistence > 1e-4 ? Math.exp(-dt / this.persistence) : 0;

    // The layer, carried forward: reads the old target, writes the new one.
    this._oldNode.value = this._oldRT.texture;
    _quad.material = this._layerMaterial!;
    renderer.setRenderTarget(this._layerRT);
    _quad.render(renderer);

    // The picture: this frame without its particles, plus the layer.
    this._layerNode.value = this._layerRT.texture;
    _quad.material = this._outputMaterial!;
    renderer.setRenderTarget(this._outputRT);
    _quad.render(renderer);

    const swap = this._oldRT;
    this._oldRT = this._layerRT;
    this._layerRT = swap;

    RendererUtils.restoreRendererState(renderer, _rendererState);
  }

  setup(): any {
    const color = this.colorNode;
    const mask = this.maskNode;
    const old = this._oldNode;
    const layer = this._layerNode;
    old.uvNode = color.uvNode || uv();
    layer.uvNode = color.uvNode || uv();

    const carry = Fn(() => {
      const c = color.sample().toVar();
      const m = mask.sample().r.clamp(0, 1).toVar();
      const p = c.rgb.mul(m).toVar();
      const t = old.sample().rgb.toVar();
      const d = this.decay;
      const lighter = max(p, t.mul(d));
      const mixed = mix(p, t, d);
      const over = p.add(t.mul(d).mul(float(1).sub(m)));
      const out = this.mode.lessThan(0.5).select(lighter, this.mode.lessThan(1.5).select(mixed, over));
      return vec4(out, 1);
    });

    const compose = Fn(() => {
      const c = color.sample().toVar();
      const m = mask.sample().r.clamp(0, 1);
      const p = c.rgb.mul(m);
      const t = layer.sample().rgb;
      // amount 1: the particles are the layer's; amount 0: the frame as drawn.
      return vec4(c.rgb.add(t.sub(p).mul(this.amount)), c.a);
    });

    this._layerMaterial = this._layerMaterial ?? new NodeMaterial();
    this._layerMaterial.name = 'Feedback.layer';
    this._layerMaterial.fragmentNode = carry();
    this._outputMaterial = this._outputMaterial ?? new NodeMaterial();
    this._outputMaterial.name = 'Feedback.output';
    this._outputMaterial.fragmentNode = compose();

    return this._outputNode;
  }

  apply(settings: FeedbackSettings): void {
    this.persistence = Math.max(0, settings.persistence);
    this.amount.value = Math.min(1, Math.max(0, settings.amount));
    this.mode.value = MODE_INDEX[settings.mode] ?? 0;
  }

  dispose(): void {
    this._layerRT.dispose();
    this._oldRT.dispose();
    this._outputRT.dispose();
  }
}

export type ParticleFeedback = {
  node: any;
  apply: (settings: FeedbackSettings) => void;
  layer: () => any;
  dispose: () => void;
};

/** A feedback stage over `color`, fed by the scene pass's trail mask. */
export const particleFeedback = (color: any, mask: any): ParticleFeedback => {
  const node = new FeedbackNode(convertToTexture(color), mask);
  return {
    node: nodeObject(node as any),
    apply: (settings) => node.apply(settings),
    layer: () => node.getLayerNode(),
    dispose: () => node.dispose(),
  };
};
