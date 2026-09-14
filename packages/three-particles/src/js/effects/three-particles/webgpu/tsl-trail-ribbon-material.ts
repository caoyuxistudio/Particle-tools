/**
 * TSL (Three Shading Language) material for the trail ribbon renderer.
 *
 * Replicates the behavior of trail-vertex-shader.glsl.ts and
 * trail-fragment-shader.glsl.ts using TSL node-based materials.
 *
 * Key characteristics:
 * - Custom geometry with trail-specific per-vertex attributes
 * - Billboard ribbon: perp axis = cross(tangent, viewDir), with edge-on fallback
 * - Soft edge fade along the ribbon width (vUv.x axis)
 * - Optional texture modulation using luminance (dot-product brightness)
 * - DoubleSide rendering — no backface culling for ribbons
 * - NO texture sheet animation
 * - Trail uniforms are completely separate from the main particle uniforms
 */
import { DoubleSide } from 'three';
import {
  Fn,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  vec2,
  vec3,
  vec4,
  float,
  modelViewMatrix,
  positionLocal,
  texture,
  normalize,
  cross,
  dot,
  abs,
  mix,
  smoothstep,
  sin,
  cos,
  screenUV,
  Discard,
  If,
  length,
  varyingProperty,
  uniform,
  storage,
  instanceIndex,
  select,
  mod,
  floor,
  clamp,
  min as tslMin,
  max as tslMax,
  uint,
  cameraProjectionMatrix,
  type ShaderNodeObject,
  type Node,
} from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { ALPHA_DISCARD_THRESHOLD } from '../three-particles-constants.js';
import { CURVE_RESOLUTION } from './curve-bake.js';
import { getDummyTexture, linearizeDepth } from './tsl-shared.js';
import type * as THREE from 'three';
import type { StorageBufferAttribute } from 'three/webgpu';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Uniforms consumed exclusively by the trail ribbon material.
 * These are managed separately from the main particle system's SharedUniforms.
 */
export type TrailUniforms = {
  /** Optional texture to modulate the ribbon color via luminance. */
  map: { value: THREE.Texture | null };
  /** Whether to apply texture modulation. */
  useMap: { value: boolean };
  /** Discard fragments whose color matches the background color. */
  discardBackgroundColor: { value: boolean };
  /** The background color to match for discard. */
  backgroundColor: { value: { r: number; g: number; b: number } };
  /** Tolerance radius in colour space for background discard. */
  backgroundColorTolerance: { value: number };
  /** Enable depth-difference soft-particle fading. */
  softParticlesEnabled: { value: boolean };
  /** Controls the fade distance for soft particles (view-space units). */
  softParticlesIntensity: { value: number };
  /** The pre-rendered scene depth texture, required for soft particles. */
  sceneDepthTexture: { value: THREE.Texture | null };
  /** Camera near/far planes packed as (near, far). */
  cameraNearFar: { value: THREE.Vector2 };
};

// ─── Internal uniform creators ───────────────────────────────────────────────

function createTrailUniforms(trailUniforms: TrailUniforms) {
  const dummy = getDummyTexture();
  // Trail color maps are treated as sRGB (standard three.js convention);
  // the renderer's output pass handles the final linear→sRGB conversion.
  const map = (trailUniforms.map.value ?? dummy) as THREE.Texture;

  return {
    uMap: map,
    uUseMap: uniform(float(trailUniforms.useMap.value ? 1 : 0)),
    uDiscardBg: uniform(
      float(trailUniforms.discardBackgroundColor.value ? 1 : 0)
    ),
    uBgColor: uniform(
      new (trailUniforms.cameraNearFar.value.constructor as new (
        x: number,
        y: number,
        z: number
      ) => THREE.Vector3)(
        trailUniforms.backgroundColor.value.r,
        trailUniforms.backgroundColor.value.g,
        trailUniforms.backgroundColor.value.b
      )
    ),
    uBgTolerance: uniform(float(trailUniforms.backgroundColorTolerance.value)),
    uSoftEnabled: uniform(
      float(trailUniforms.softParticlesEnabled.value ? 1 : 0)
    ),
    uSoftIntensity: uniform(float(trailUniforms.softParticlesIntensity.value)),
    uSceneDepthTex: trailUniforms.sceneDepthTexture.value ?? dummy,
    uCameraNearFar: uniform(trailUniforms.cameraNearFar.value),
  };
}

/**
 * The ribbon fragment, shared by the CPU-built and the GPU-built ribbons:
 * soft edge fade across the width, optional luminance texture, soft-particle
 * depth fade, background discard.
 */
const buildTrailFragment = (
  u: ReturnType<typeof createTrailUniforms>,
  v: {
    vAlpha: ShaderNodeObject<Node>;
    vColor: ShaderNodeObject<Node>;
    vUv: ShaderNodeObject<Node>;
    vViewZ: ShaderNodeObject<Node>;
  }
): ShaderNodeObject<Node> => {
  const { vAlpha, vColor, vUv, vViewZ } = v;
  return Fn((): ShaderNodeObject<Node> => {
    const outColor = vColor.toVar();

    // Soft edge fade: vUv.x runs [0, 1] across the ribbon width.
    // edgeDist = 1 − |2·x − 1| peaks at 0.5 (centre) and is 0 at edges.
    const edgeDist = float(1.0).sub(abs(vUv.x.mul(2.0).sub(1.0)));
    const edgeFade = smoothstep(float(0.0), float(0.4), edgeDist);

    // Optional texture: modulate colour by luminance (perceptual weighting)
    // and multiply alpha by texture alpha — matching the GLSL shader.
    If(u.uUseMap.greaterThan(0.5), () => {
      const texColor = texture(u.uMap, vUv);
      const texBrightness = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
      outColor.rgb.assign(
        outColor.rgb.mul(float(0.5).add(texBrightness.mul(0.5)))
      );
      outColor.a.assign(outColor.a.mul(texColor.a));
    });

    // Combine alpha: particle alpha × ribbon edge fade
    outColor.a.assign(outColor.a.mul(vAlpha).mul(edgeFade));

    // Early discard for fully transparent fragments
    Discard(outColor.a.lessThan(ALPHA_DISCARD_THRESHOLD));

    // Soft particles — depth-difference fade
    If(u.uSoftEnabled.greaterThan(0.5), () => {
      const depthSample = texture(u.uSceneDepthTex, screenUV).x;
      const sceneDepthLinear = linearizeDepth({
        depthSample,
        near: u.uCameraNearFar.x,
        far: u.uCameraNearFar.y,
      });
      const depthDiff = sceneDepthLinear.sub(vViewZ);
      const softFade = smoothstep(float(0.0), u.uSoftIntensity, depthDiff);
      outColor.a.assign(outColor.a.mul(softFade));
    });
    Discard(outColor.a.lessThan(ALPHA_DISCARD_THRESHOLD));

    // Background color discard
    const diff = vec3(
      outColor.r.sub(u.uBgColor.x),
      outColor.g.sub(u.uBgColor.y),
      outColor.b.sub(u.uBgColor.z)
    );
    Discard(
      u.uDiscardBg
        .greaterThan(0.5)
        .and(abs(length(diff)).lessThan(u.uBgTolerance))
    );

    return outColor;
  })();
};

// ─── Material factory ─────────────────────────────────────────────────────────

/**
 * Creates a TSL-based MeshBasicNodeMaterial that replicates the GLSL trail
 * ribbon shaders. Works with both WebGPURenderer (WGSL output) and
 * WebGLRenderer (GLSL output) when using the node material system.
 *
 * The returned material expects geometry with these custom attributes:
 * - `trailAlpha`     — per-vertex opacity along the trail
 * - `trailColor`     — per-vertex RGBA colour
 * - `trailOffset`    — ribbon edge side: −0.5 (left) or +0.5 (right)
 * - `trailHalfWidth` — half-width of the ribbon at this vertex
 * - `trailNext`      — world-space position of the next trail sample
 * - `trailUV`        — x: roll about the tangent in radians (the particle's
 *                      rotation), y: place along the trail 0..1; the
 *                      across-ribbon coordinate comes from `trailOffset`
 *
 * @param trailUniforms  - Per-trail uniform values (map, soft particles, bg discard, …).
 * @param rendererConfig - Blending / depth state forwarded to the material.
 * @returns Configured MeshBasicNodeMaterial ready for use with a trail mesh.
 */
export function createTrailRibbonTSLMaterial(
  trailUniforms: TrailUniforms,
  rendererConfig: {
    transparent: boolean;
    blending: THREE.Blending;
    depthTest: boolean;
    depthWrite: boolean;
  }
): MeshBasicNodeMaterial {
  const u = createTrailUniforms(trailUniforms);

  // ── Per-vertex attributes ────────────────────────────────────────────────

  const aTrailAlpha = attribute('trailAlpha');
  const aTrailColor = attribute('trailColor', 'vec4');
  const aTrailOffset = attribute('trailOffset');
  const aTrailHalfWidth = attribute('trailHalfWidth');
  const aTrailNext = attribute('trailNext', 'vec3');
  const aTrailUV = attribute('trailUV', 'vec2');

  // ── Varyings ─────────────────────────────────────────────────────────────

  const vAlpha = varyingProperty('float', 'vAlpha');
  const vColor = varyingProperty('vec4', 'vColor');
  const vUv = varyingProperty('vec2', 'vUv');
  const vViewZ = varyingProperty('float', 'vViewZ');

  // ── Vertex stage ──────────────────────────────────────────────────────────
  //
  // Replicates trail-vertex-shader.glsl — billboard ribbon expansion:
  //
  //   1. Compute tangent from current → next position (with degenerate guard).
  //   2. Derive the camera-right fallback from viewMatrix column 0.
  //   3. Compute perp = cross(tangent, viewDir); blend toward fallback when
  //      the cross product is near-zero (edge-on view).
  //   4. Offset position along perp by trailOffset * trailHalfWidth.
  //   5. Project and emit vViewZ for soft-particle depth test.

  const positionNode = Fn((): ShaderNodeObject<Node> => {
    // Pass varyings to fragment stage
    vAlpha.assign(aTrailAlpha);
    vColor.assign(aTrailColor);
    // Across the ribbon from the edge side, along it from the attribute.
    vUv.assign(vec2(aTrailOffset.mul(0.5).add(0.5), aTrailUV.y));

    const current = vec3(positionLocal);
    const next = vec3(aTrailNext);

    // Tangent: direction from current to next sample
    const rawTangent = next.sub(current);
    const tangentLen = length(rawTangent);
    // Degenerate guard: fall back to +Y when consecutive samples coincide
    const tangent = normalize(
      tangentLen.lessThan(0.0001).select(vec3(0.0, 1.0, 0.0), rawTangent)
    );

    // View-space position for depth (vViewZ)
    const mvCurrent = modelViewMatrix.mul(vec4(current, 1.0));

    // View direction in local/world space (tangent is in the same space)
    const viewDir = normalize(cameraPosition.sub(current));

    // Primary billboard perpendicular
    const rawPerp = cross(tangent, viewDir);
    const perpLen = length(rawPerp);

    // Camera right vector extracted from the view matrix (column 0)
    // Using cameraViewMatrix (view-only, no model transform)
    const camRight = vec3(
      cameraViewMatrix.element(0).element(0),
      cameraViewMatrix.element(1).element(0),
      cameraViewMatrix.element(2).element(0)
    );

    // Fallback perpendicular: project camRight onto the plane perpendicular to tangent
    const camRightDotTangent = dot(camRight, tangent);
    const fallbackPerp = normalize(
      camRight.sub(tangent.mul(camRightDotTangent))
    );

    // When perpLen is near zero the ribbon is edge-on; use fallback.
    // Otherwise blend smoothly toward fallback over a wide range (0 → 0.7)
    // to prevent abrupt flipping, matching the GLSL shader exactly.
    const perp = normalize(
      perpLen
        .lessThan(0.0001)
        .select(
          fallbackPerp,
          normalize(
            mix(
              fallbackPerp,
              normalize(rawPerp),
              smoothstep(float(0.0), float(0.7), perpLen)
            )
          )
        )
    );

    // Roll the ribbon about its tangent by the particle's rotation: face-on
    // it shows its full width, edge-on it thins to a line.
    const roll = aTrailUV.x;
    const rolled = normalize(
      perp.mul(cos(roll)).add(cross(tangent, perp).mul(sin(roll)))
    );

    // Expand ribbon vertex by offset side and half-width
    const offsetPos = current.add(
      rolled.mul(aTrailOffset).mul(aTrailHalfWidth)
    );

    // Emit view-space depth for soft particles
    const mvOffset = modelViewMatrix.mul(vec4(offsetPos, 1.0));
    vViewZ.assign(mvOffset.z.negate());

    // Return the offset position in local space; TSL's positionNode feeds this
    // through the standard MVP transform automatically, so returning offsetPos
    // is sufficient — the engine reconstructs the clip-space position.
    return offsetPos;
  })();

  // ── Fragment stage ────────────────────────────────────────────────────────
  //
  // Replicates trail-fragment-shader.glsl:
  //   1. Soft edge fade along the ribbon width using vUv.x.
  //   2. Optional luminance-weighted texture modulation.
  //   3. Alpha = vColor.a * vAlpha * edgeFade (plus optional soft-particle fade).
  //   4. Background color discard.

  const colorNode = buildTrailFragment(u, { vAlpha, vColor, vUv, vViewZ });

  // ── Material assembly ─────────────────────────────────────────────────────

  const material = new MeshBasicNodeMaterial();
  material.transparent = rendererConfig.transparent;
  material.blending = rendererConfig.blending;
  material.depthTest = rendererConfig.depthTest;
  material.depthWrite = rendererConfig.depthWrite;
  material.toneMapped = false;
  material.fog = false;
  material.side = DoubleSide;

  // positionNode replaces the default local-space position fed into MVP
  material.positionNode = positionNode;
  material.colorNode = colorNode;

  return material;
}

// ─── The ribbon built on the GPU ─────────────────────────────────────────────

/** What the GPU-built ribbon needs from the compute pipeline and the trail config. */
export type GpuTrailParams = {
  /** The pipeline's curveData buffer: baked curves at the front, the history rings at `historyOffset`. */
  curveData: StorageBufferAttribute;
  /** Float offset of particle 0's ring; each ring is `length` × 4 floats (x, y, z, time). */
  historyOffset: number;
  /** Samples per particle. */
  length: number;
  /** Baked curve indices (-1 = not baked → 1). */
  curveMap: {
    trailWidth: number;
    trailOpacity: number;
    trailColorR: number;
    trailColorG: number;
    trailColorB: number;
  };
  width: number;
  maxTime: number;
  smoothing: boolean;
  smoothingSubdivisions: number;
};

/**
 * The trail ribbon built entirely on the GPU.
 *
 * One instance per particle; the base geometry is a strip of `length` slots
 * with two vertices each (position = (slot, side, 0)). The vertex stage reads
 * the particle's history ring straight out of the compute pipeline's storage
 * buffer — newest sample first — and does what the CPU rebuild did: Catmull-
 * Rom resampling when smoothing is on, the age fade, the width and opacity
 * curves (baked into the same buffer), the camera-facing expansion, the roll
 * by the particle's rotation. Nothing crosses the bus per frame but the new
 * samples the kernel writes.
 *
 * Per-instance attributes: `instanceOffset` (xyz, ring head in .w),
 * `instanceVelocity` (xyz, sample count in .w), `instanceColor` (RGBA) and
 * `instanceParticleState` (lifetime, size, rotation, startFrame).
 *
 * `material.userData.trailNow` is the clock uniform the age fade compares
 * against; the caller sets its `.value` each frame in seconds, the same clock
 * the kernel stamps the samples with.
 */
export function createGpuTrailRibbonTSLMaterial(
  trailUniforms: TrailUniforms,
  rendererConfig: {
    transparent: boolean;
    blending: THREE.Blending;
    depthTest: boolean;
    depthWrite: boolean;
  },
  gpu: GpuTrailParams
): MeshBasicNodeMaterial {
  const u = createTrailUniforms(trailUniforms);
  const L = Math.max(2, Math.floor(gpu.length));
  const sHist = storage(
    gpu.curveData,
    'float',
    gpu.curveData.array.length
  ).toReadOnly();
  const uNow = uniform(float(0));

  const aColor = attribute('instanceColor', 'vec4');
  const aState = attribute('instanceParticleState', 'vec4');
  const aOffset = attribute('instanceOffset', 'vec4');
  const aVelocity = attribute('instanceVelocity', 'vec4');

  const vAlpha = varyingProperty('float', 'vAlpha');
  const vColor = varyingProperty('vec4', 'vColor');
  const vUv = varyingProperty('vec2', 'vUv');
  const vViewZ = varyingProperty('float', 'vViewZ');

  /** A baked curve at t (0..1), or 1 when the curve was not baked. */
  const curveAt = (
    index: number,
    t: ShaderNodeObject<Node>
  ): ShaderNodeObject<Node> => {
    if (index < 0) return float(1.0);
    const pos = clamp(t, float(0.0), float(1.0)).mul(CURVE_RESOLUTION - 1);
    const i0 = floor(pos);
    const f = pos.sub(i0);
    const base = float(index * CURVE_RESOLUTION);
    const v0 = sHist.element(uint(base.add(i0).add(0.5)));
    const v1 = sHist.element(
      uint(base.add(tslMin(i0.add(1.0), float(CURVE_RESOLUTION - 1))).add(0.5))
    );
    return mix(v0, v1, f);
  };

  const ringBase = uint(gpu.historyOffset).add(instanceIndex.mul(uint(L * 4)));

  /** Raw sample r (0 = newest) of this instance: (x, y, z, time). */
  const fetchSample = Fn(({ r }: Record<string, ShaderNodeObject<Node>>) => {
    const slot = mod(
      aOffset.w
        .sub(1.0)
        .sub(r)
        .add(float(2 * L)),
      float(L)
    );
    const base = ringBase.add(uint(slot.add(0.5)).mul(uint(4)));
    return vec4(
      sHist.element(base),
      sHist.element(base.add(uint(1))),
      sHist.element(base.add(uint(2))),
      sHist.element(base.add(uint(3)))
    );
  });

  const catmullRom = (
    p0: ShaderNodeObject<Node>,
    p1: ShaderNodeObject<Node>,
    p2: ShaderNodeObject<Node>,
    p3: ShaderNodeObject<Node>,
    t: ShaderNodeObject<Node>
  ): ShaderNodeObject<Node> => {
    const t2 = t.mul(t);
    const t3 = t2.mul(t);
    return p1
      .mul(2.0)
      .add(p2.sub(p0).mul(t))
      .add(p0.mul(2.0).sub(p1.mul(5.0)).add(p2.mul(4.0)).sub(p3).mul(t2))
      .add(p0.negate().add(p1.mul(3.0)).sub(p2.mul(3.0)).add(p3).mul(t3))
      .mul(0.5);
  };

  /**
   * Output point k of the ribbon (0 = head). With smoothing and at least
   * three raw samples, the Catmull-Rom spline through all of them resampled
   * uniformly; otherwise the raw sample itself.
   */
  const pointAt = Fn(
    ({ k, count, last }: Record<string, ShaderNodeObject<Node>>) => {
      const out = vec3(0.0).toVar();
      if (gpu.smoothing) {
        If(count.greaterThanEqual(3.0), () => {
          const segments = count.sub(1.0);
          const u = k.div(last).mul(segments);
          const seg = tslMin(floor(u), segments.sub(1.0));
          const t = u.sub(seg);
          const i0 = tslMax(seg.sub(1.0), float(0.0));
          const i2 = tslMin(seg.add(1.0), count.sub(1.0));
          const i3 = tslMin(seg.add(2.0), count.sub(1.0));
          out.assign(
            catmullRom(
              fetchSample({ r: i0 }).xyz,
              fetchSample({ r: seg }).xyz,
              fetchSample({ r: i2 }).xyz,
              fetchSample({ r: i3 }).xyz,
              t
            )
          );
        }).Else(() => {
          out.assign(fetchSample({ r: k }).xyz);
        });
      } else {
        out.assign(fetchSample({ r: k }).xyz);
      }
      return out;
    }
  );

  const vertexNode = Fn((): ShaderNodeObject<Node> => {
    // Dead, or not a single sample yet: behind the camera, clipped away.
    const clip = vec4(0.0, 0.0, 0.0, -1.0).toVar();
    const count = aVelocity.w;

    If(aColor.w.greaterThan(0.0).and(count.greaterThan(0.5)), () => {
      const slot = positionLocal.x;
      const side = positionLocal.y;
      const size = aState.y;
      const roll = aState.z;

      const finalCount = gpu.smoothing
        ? select(
            count.greaterThanEqual(3.0),
            tslMin(
              count.sub(1.0).mul(gpu.smoothingSubdivisions).add(1.0),
              float(L)
            ),
            count
          )
        : count;
      const last = tslMax(finalCount.sub(1.0), float(1.0));
      // Slots past the ribbon's end collapse onto its tail at zero width.
      const beyond = slot.greaterThan(finalCount.sub(0.5));
      const s = tslMin(slot, finalCount.sub(1.0));
      const visible = select(beyond, float(0.0), float(1.0));

      const p = pointAt({ k: s, count, last }).toVar();
      // Tangent toward the next point; at the tail, away from the previous.
      const tangent = vec3(0.0, 1.0, 0.0).toVar();
      If(s.greaterThanEqual(finalCount.sub(1.5)), () => {
        const q = pointAt({ k: tslMax(s.sub(1.0), float(0.0)), count, last });
        tangent.assign(p.sub(q));
      }).Else(() => {
        const q = pointAt({ k: s.add(1.0), count, last });
        tangent.assign(q.sub(p));
      });
      const tangentLen = length(tangent);
      const tn = normalize(
        select(tangentLen.lessThan(0.0001), vec3(0.0, 1.0, 0.0), tangent)
      );

      // Place along the ribbon, 0 head → 1 tail.
      const tt = select(finalCount.greaterThan(1.5), s.div(last), float(0.0));

      // Age fade against the clock stamped on the nearest raw sample.
      let timeFade: ShaderNodeObject<Node> = float(1.0);
      if (gpu.maxTime > 0) {
        const rawIdx = gpu.smoothing
          ? select(
              count.greaterThanEqual(3.0),
              floor(s.div(last).mul(count.sub(1.0)).add(0.5)),
              s
            )
          : s;
        const age = uNow.sub(fetchSample({ r: rawIdx }).w);
        timeFade = float(1.0).sub(tslMin(age.div(gpu.maxTime), float(1.0)));
      }

      const widthScale = curveAt(gpu.curveMap.trailWidth, tt);
      const opacityScale = curveAt(gpu.curveMap.trailOpacity, tt);
      const halfWidth = float(gpu.width)
        .mul(widthScale)
        .mul(size)
        .mul(0.5)
        .mul(visible);

      // Camera-facing expansion, as the CPU-built ribbon does it.
      const viewDir = normalize(cameraPosition.sub(p));
      const rawPerp = cross(tn, viewDir);
      const perpLen = length(rawPerp);
      const camRight = vec3(
        cameraViewMatrix.element(0).element(0),
        cameraViewMatrix.element(1).element(0),
        cameraViewMatrix.element(2).element(0)
      );
      const fallbackPerp = normalize(camRight.sub(tn.mul(dot(camRight, tn))));
      const perp = normalize(
        perpLen
          .lessThan(0.0001)
          .select(
            fallbackPerp,
            normalize(
              mix(
                fallbackPerp,
                normalize(rawPerp),
                smoothstep(float(0.0), float(0.7), perpLen)
              )
            )
          )
      );
      // Roll about the tangent by the particle's rotation.
      const rolled = normalize(
        perp.mul(cos(roll)).add(cross(tn, perp).mul(sin(roll)))
      );

      const offsetPos = p.add(rolled.mul(side).mul(halfWidth));

      vAlpha.assign(opacityScale.mul(timeFade).mul(visible));
      vColor.assign(
        vec4(
          aColor.x.mul(curveAt(gpu.curveMap.trailColorR, tt)),
          aColor.y.mul(curveAt(gpu.curveMap.trailColorG, tt)),
          aColor.z.mul(curveAt(gpu.curveMap.trailColorB, tt)),
          aColor.w
        )
      );
      vUv.assign(vec2(side.mul(0.5).add(0.5), tt));

      const mv = modelViewMatrix.mul(vec4(offsetPos, 1.0));
      vViewZ.assign(mv.z.negate());
      clip.assign(cameraProjectionMatrix.mul(mv));
    });

    return clip;
  })();

  const colorNode = buildTrailFragment(u, { vAlpha, vColor, vUv, vViewZ });

  const material = new MeshBasicNodeMaterial();
  material.transparent = rendererConfig.transparent;
  material.blending = rendererConfig.blending;
  material.depthTest = rendererConfig.depthTest;
  material.depthWrite = rendererConfig.depthWrite;
  material.toneMapped = false;
  material.fog = false;
  material.side = DoubleSide;
  material.vertexNode = vertexNode;
  material.colorNode = colorNode;
  material.userData.trailNow = uNow;
  material.userData.gpuTrail = true;

  return material;
}
