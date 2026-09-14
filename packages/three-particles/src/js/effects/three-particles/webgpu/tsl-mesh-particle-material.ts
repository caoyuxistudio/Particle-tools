/**
 * TSL (Three Shading Language) material for the MESH particle renderer.
 *
 * Replicates the behavior of mesh-particle-vertex-shader.glsl.ts and
 * mesh-particle-fragment-shader.glsl.ts using TSL node-based materials.
 *
 * Key differences from the POINTS / INSTANCED TSL materials:
 *  - Uses `instanceQuat` (vec4) for full 3D quaternion rotation of mesh vertices.
 *  - Transforms normals by the same quaternion for per-fragment directional lighting.
 *  - Uses real mesh UVs (`uv`) rather than a derived point-coord or billboard UV.
 *  - No circle discard — mesh geometry defines the particle shape.
 *  - Texture sheet animation is only applied when tiles > 1×1.
 *  - Simple directional lighting: `0.5 + 0.5 * max(dot(vNormal, vec3(0,0,1)), 0.0)`.
 */
import {
  Fn,
  attribute,
  vec2,
  vec3,
  vec4,
  float,
  cameraProjectionMatrix,
  modelViewMatrix,
  modelWorldMatrix,
  positionLocal,
  normalLocal,
  texture,
  cos,
  sin,
  Discard,
  If,
  max,
  uniform,
  abs,
  cross,
  dot,
  normalize,
  varyingProperty,
  uv,
  type ShaderNodeObject,
  type Node,
} from 'three/tsl';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';

import { ALPHA_DISCARD_THRESHOLD } from '../three-particles-constants.js';
import {
  type SharedUniforms,
  createParticleUniforms,
  computeFrameIndex,
  computeSpriteSheetUV,
  computeSoftParticleFade,
  applyBackgroundDiscard,
} from './tsl-shared.js';

import type * as THREE from 'three';

// ─── Quaternion helper ────────────────────────────────────────────────────────

/**
 * Applies a unit quaternion `q` to vector `v`.
 *
 * Replicates the GLSL helper:
 * ```glsl
 * vec3 applyQuaternion(vec3 v, vec4 q) {
 *   vec3 t = 2.0 * cross(q.xyz, v);
 *   return v + q.w * t + cross(q.xyz, t);
 * }
 * ```
 */
const applyQuaternion = Fn(
  ({ v, q }: Record<string, ShaderNodeObject<Node>>) => {
    const t = cross(q.xyz, v).mul(2.0);
    return v.add(t.mul(q.w)).add(cross(q.xyz, t));
  }
);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a TSL-based {@link MeshBasicNodeMaterial} that replicates the GLSL
 * mesh particle shaders. Works with both WebGPURenderer (WGSL output) and
 * WebGLRenderer (GLSL output) when using the node material system.
 *
 * @param sharedUniforms - Live uniform values shared with the particle system.
 * @param rendererConfig - Blending / depth / transparency settings.
 * @returns A configured {@link MeshBasicNodeMaterial}.
 */
export function createMeshParticleTSLMaterial(
  sharedUniforms: SharedUniforms,
  rendererConfig: {
    transparent: boolean;
    blending: THREE.Blending;
    depthTest: boolean;
    depthWrite: boolean;
  },
  gpuCompute = false,
  alignToVelocity = false,
  lit = false,
  emissive = 0,
  roughness = 0.65,
  metalness = 0,
  velocityStretch = 0,
  meshExtentZ = 1
): MeshBasicNodeMaterial | MeshStandardNodeMaterial {
  const u = createParticleUniforms(sharedUniforms);
  // The motion-blur streak needs the compute backend's travel speed.
  const useStretch = velocityStretch > 0 && gpuCompute;
  // Velocity alignment needs the compute backend's packed travel direction;
  // a streak has to point along the heading, so it brings alignment with it.
  const useVelocityAlign = (alignToVelocity || useStretch) && gpuCompute;
  /** Seconds of travel the streak spans. */
  const uVelocityStretch = uniform(float(velocityStretch));
  /** The mesh's own depth along local +Z, before any scale. */
  const uMeshExtentZ = uniform(float(Math.max(meshExtentZ, 1e-4)));

  // ── Per-instance attributes ────────────────────────────────────────────────

  /** Particle world-space position (vec3). */
  const aInstanceOffset = attribute('instanceOffset');
  /** Packed RGBA color (vec4). */
  const aColor = attribute('instanceColor');

  // GPU compute uses packed vec4 buffers; CPU uses individual attributes
  const aParticleState = gpuCompute ? attribute('instanceParticleState') : null;
  /** (vx, vy, vz, travel-direction azimuth). Bound only for velocity alignment. */
  const aVelocity = useVelocityAlign ? attribute('instanceVelocity') : null;
  const aStartValues = gpuCompute ? attribute('instanceStartValues') : null;
  /** Particle orientation as a unit quaternion (vec4: x, y, z, w). CPU path only. */
  const aInstanceQuat = gpuCompute ? null : attribute('instanceQuat');
  const aSize = gpuCompute ? null : attribute('instanceSize');
  const aLifetime = gpuCompute ? null : attribute('instanceLifetime');
  const aStartLifetime = gpuCompute ? null : attribute('instanceStartLifetime');
  const aRotation = gpuCompute ? null : attribute('instanceRotation');
  const aStartFrame = gpuCompute ? null : attribute('instanceStartFrame');

  // ── Varyings ───────────────────────────────────────────────────────────────

  const vColor = varyingProperty('vec4', 'vColor');
  const vLifetime = varyingProperty('float', 'vLifetime');
  const vStartLifetime = varyingProperty('float', 'vStartLifetime');
  const vStartFrame = varyingProperty('float', 'vStartFrame');
  const vRotation = varyingProperty('float', 'vRotation');
  /** View-space normal, transformed by the instance quaternion. */
  const vNormal = varyingProperty('vec3', 'vNormal');
  /** View-space depth (positive distance from camera). */
  const vViewZ = varyingProperty('float', 'vViewZ');
  /** World-space position, for the shadow lookup of a received shadow. */
  const vShadowPos = varyingProperty('vec3', 'vShadowPos');

  // ── Vertex stage ───────────────────────────────────────────────────────────

  /**
   * Per-instance vertex math, shared by the camera pass and the shadow pass:
   *   1. Rotate the mesh vertex by the instance quaternion (or travel basis).
   *   2. Scale by instanceSize.
   *   3. Translate by instanceOffset.
   * Populates the fragment varyings and returns the vertex position and normal
   * in the particle system's own space, which is what `modelViewMatrix`
   * expects. Call it inside an `If` guarded by `aColor.w > 0`.
   */
  const instanceVertex = () => {
    // Populate varyings
    vColor.assign(aColor.toVar());
    if (gpuCompute) {
      vLifetime.assign(aParticleState!.x);
      vStartLifetime.assign(aStartValues!.x);
      // While stretching, particleState.w carries the travel speed instead.
      vStartFrame.assign(useStretch ? float(0) : aParticleState!.w);
      vRotation.assign(aParticleState!.z);
    } else {
      vLifetime.assign(aLifetime!);
      vStartLifetime.assign(aStartLifetime!);
      vStartFrame.assign(aStartFrame!);
      vRotation.assign(aRotation!);
    }

    // Build quaternion: GPU compute derives it from particleState.z (rotation
    // angle around Z); CPU path reads the pre-computed instanceQuat attribute.
    let quat: ShaderNodeObject<Node>;
    if (gpuCompute) {
      const halfZ = aParticleState!.z.mul(0.5);
      quat = vec4(0.0, 0.0, sin(halfZ), cos(halfZ));
    } else {
      quat = aInstanceQuat!;
    }

    // 0. Per-axis scale in the mesh's local frame, BEFORE the rotation, so a
    // non-uniform scale stretches the shape itself rather than shearing it
    // along world axes as the particle spins.
    const localPos = positionLocal.mul(u.uMeshScale).toVar();

    // The streak: the distance the particle covered in `velocityStretch`
    // seconds, in world units. The mesh is lengthened along its local +Z (the
    // heading, once aligned) by that much and, further down, slid back by
    // half of it — so its front stays on the particle and the whole extra
    // length trails behind. Scaling happens here in local units, which the
    // per-particle size multiplies later, hence the divide by the size.
    let streak: ShaderNodeObject<Node> | null = null;
    let stretchFactor: ShaderNodeObject<Node> | null = null;
    if (useStretch) {
      streak = aParticleState!.w.mul(uVelocityStretch).toVar();
      const extentWorld = uMeshExtentZ
        .mul(u.uMeshScale.z)
        .mul(aParticleState!.y);
      stretchFactor = float(1.0)
        .add(streak.div(max(extentWorld, float(1e-4))))
        .toVar();
      localPos.z.assign(localPos.z.mul(stretchFactor));
    }

    // Velocity alignment builds an orthonormal frame from the direction of
    // travel: local +Z maps to the heading, +X/+Y span the perpendicular
    // plane, and the particle's rotation value becomes roll about the
    // heading. Direction arrives as two spherical angles packed into the
    // position (.w = polar) and velocity (.w = azimuth) buffers.
    const buildTravelBasis = () => {
      const theta = aInstanceOffset.w;
      const phi = aVelocity!.w;
      const sinT = sin(theta);
      const forward = vec3(
        sinT.mul(cos(phi)),
        cos(theta),
        sinT.mul(sin(phi))
      ).toVar();

      // Pick a reference that is never parallel to the heading, otherwise the
      // cross product collapses and the frame flips.
      const upRef = vec3(0, 1, 0).toVar();
      If(abs(dot(forward, upRef)).greaterThan(0.999), () => {
        upRef.assign(vec3(0, 0, 1));
      });

      const right = normalize(cross(upRef, forward)).toVar();
      const upv = cross(forward, right).toVar();

      // Roll about the heading, driven by the same rotation value the
      // Z-spin path uses (rotationOverLifetime + noise rotationAmount).
      const roll = gpuCompute ? aParticleState!.z : aRotation!;
      const cr = cos(roll);
      const sr = sin(roll);
      const rolledRight = right.mul(cr).add(upv.mul(sr));
      const rolledUp = upv.mul(cr).sub(right.mul(sr));

      return { right: rolledRight, up: rolledUp, forward };
    };

    // 1. Orient the mesh vertex — either along the travel direction or by
    // the instance quaternion (flat Z-spin).
    let rotatedPos: ShaderNodeObject<Node>;
    let basis: ReturnType<typeof buildTravelBasis> | null = null;
    if (useVelocityAlign) {
      basis = buildTravelBasis();
      rotatedPos = basis.right
        .mul(localPos.x)
        .add(basis.up.mul(localPos.y))
        .add(basis.forward.mul(localPos.z));
    } else {
      rotatedPos = applyQuaternion({
        v: localPos,
        q: quat,
      });
    }

    // 2. Scale by particle size
    const scaledPos = rotatedPos.mul(gpuCompute ? aParticleState!.y : aSize!);

    // 3. Translate to particle world position
    // Use .xyz to handle vec3→vec4 padding by WebGPU storage buffer alignment
    const worldPos = scaledPos.add(aInstanceOffset.xyz).toVar();
    if (useStretch) {
      worldPos.assign(worldPos.sub(basis!.forward.mul(streak!.mul(0.5))));
    }

    // Transform normal: normals scale by the inverse-transpose, which for a
    // diagonal scale is a component-wise divide, then rotate into view space.
    const normalScale = stretchFactor
      ? u.uMeshScale.mul(vec3(1.0, 1.0, stretchFactor))
      : u.uMeshScale;
    const scaledNormal = normalLocal
      .div(max(normalScale, vec3(0.0001)))
      .normalize();
    const rotatedNormal = basis
      ? basis.right
          .mul(scaledNormal.x)
          .add(basis.up.mul(scaledNormal.y))
          .add(basis.forward.mul(scaledNormal.z))
      : applyQuaternion({
          v: scaledNormal,
          q: quat,
        });
    return { position: worldPos, normal: rotatedNormal };
  };

  const vertexSetup = Fn(() => {
    // Early-out for dead particles: push the vertex behind the camera
    // (negative w) so it is clipped before rasterisation. A degenerate
    // (0,0,0,0) position causes a NaN after perspective divide, which some
    // WebGPU drivers rasterise at an indeterminate location instead of
    // discarding cleanly.
    const clipPos = vec4(0.0, 0.0, 0.0, -1.0).toVar();

    If(aColor.w.greaterThan(0.0), () => {
      const { position, normal } = instanceVertex();

      // Compute model-view position for depth and normal
      const mvPos = modelViewMatrix.mul(vec4(position, 1.0));
      vViewZ.assign(mvPos.z.negate());
      // The built-in positionWorld comes from positionLocal and knows nothing
      // about the per-instance transform; the shadow lookup needs this one.
      vShadowPos.assign(modelWorldMatrix.mul(vec4(position, 1.0)).xyz);

      const mvNormal = modelViewMatrix.mul(vec4(normal, 0.0)).xyz;
      vNormal.assign(mvNormal.normalize());

      clipPos.assign(cameraProjectionMatrix.mul(mvPos));
    });

    // Return clip-space position (manual MVP to avoid double-transform)
    return clipPos;
  })();

  /**
   * Vertex position for the shadow pass. The renderer's depth material cannot
   * run vertexNode; it takes a local-space position through
   * castShadowPositionNode and applies the shadow camera's own MVP to it. A
   * dead particle cannot be culled by a negative w here, so it is parked far
   * outside any shadow frustum instead. The fragment varyings are assigned as
   * well: the depth material still evaluates colorNode for its alpha, and an
   * unassigned vColor would discard every fragment.
   */
  const shadowPositionSetup = Fn(() => {
    const position = vec3(1e6).toVar();

    If(aColor.w.greaterThan(0.0), () => {
      const inst = instanceVertex();
      position.assign(inst.position);
      vViewZ.assign(modelViewMatrix.mul(vec4(inst.position, 1.0)).z.negate());
      vShadowPos.assign(inst.position);
      vNormal.assign(inst.normal);
    });

    return position;
  })();

  // ── Fragment stage ─────────────────────────────────────────────────────────

  const fragmentColor = Fn(() => {
    const outColor = vColor.toVar();

    // Use mesh UVs as the base for texture sampling
    const uvPoint = vec2(uv()).toVar();

    // Texture sheet animation — only applied when tiles > 1×1
    If(u.uTiles.x.greaterThan(1.0).or(u.uTiles.y.greaterThan(1.0)), () => {
      const frameIndex = computeFrameIndex({
        vLifetime,
        vStartLifetime,
        vStartFrame,
        uFps: u.uFps,
        uUseFPSForFrameIndex: u.uUseFPSForFrameIndex,
        uTiles: u.uTiles,
      });

      // Remap mesh UV into the selected tile
      uvPoint.assign(
        computeSpriteSheetUV({
          baseUV: uv(),
          frameIndex,
          uTiles: u.uTiles,
        })
      );
    });

    // Sample texture using the (possibly remapped) UV
    const texColor = texture(u.uMap, uvPoint);
    outColor.assign(outColor.mul(texColor));

    // Background color discard
    applyBackgroundDiscard({
      texColor,
      uDiscardBg: u.uDiscardBg,
      uBgColor: u.uBgColor,
      uBgTolerance: u.uBgTolerance,
    });

    // Unlit mode fakes a headlight so particles are not flat. In lit mode the
    // real lighting model shades them instead, so applying this too would
    // double up.
    if (!lit) {
      // lightIntensity = 0.5 + 0.5 * max(dot(vNormal, vec3(0,0,1)), 0.0)
      const lightIntensity = float(0.5).add(
        float(0.5).mul(max(dot(vNormal, vec3(0.0, 0.0, 1.0)), float(0.0)))
      );
      outColor.assign(vec4(outColor.xyz.mul(lightIntensity), outColor.w));
    }

    // Soft particles — fade out fragments that are close to opaque scene geometry
    const softFade = computeSoftParticleFade({
      viewZ: vViewZ,
      uSoftEnabled: u.uSoftEnabled,
      uSoftIntensity: u.uSoftIntensity,
      uSceneDepthTex: u.uSceneDepthTex,
      uCameraNearFar: u.uCameraNearFar,
    });
    outColor.assign(vec4(outColor.xyz, outColor.w.mul(softFade)));
    Discard(outColor.w.lessThan(ALPHA_DISCARD_THRESHOLD));

    return outColor;
  })();

  // ── Material assembly ──────────────────────────────────────────────────────

  // Standard material takes part in the scene's lights, environment and light
  // probes; Basic ignores them entirely.
  const material = lit
    ? new MeshStandardNodeMaterial()
    : new MeshBasicNodeMaterial();
  material.transparent = rendererConfig.transparent;
  material.blending = rendererConfig.blending;
  material.depthTest = rendererConfig.depthTest;
  material.depthWrite = rendererConfig.depthWrite;
  material.toneMapped = false;
  material.fog = false;

  // vertexNode receives a clip-space vec4 (manual MVP to avoid double-transform)
  material.vertexNode = vertexSetup;
  material.colorNode = fragmentColor;

  // Shadow exchange. Casting: the depth pass applies its own MVP to this
  // local-space position instead of running vertexNode. Receiving: the shadow
  // lookup reads the world position computed alongside it, since the built-in
  // positionWorld ignores the per-instance transform. Whether the particles
  // actually take part is the object's castShadow / receiveShadow flags.
  material.castShadowPositionNode = shadowPositionSetup;
  material.receivedShadowPositionNode = vShadowPos;

  if (lit) {
    // The built-in normal pipeline derives from normalLocal and the normal
    // matrix, which knows nothing about the per-instance rotation applied in
    // vertexNode. Feed it the view-space normal already computed there, which
    // is the space `normalNode` expects.
    (material as MeshStandardNodeMaterial).normalNode = vNormal;
    // Undefined means "the default", so a config that never set these keeps
    // the look it was saved with.
    (material as MeshStandardNodeMaterial).roughness = roughness ?? 0.65;
    (material as MeshStandardNodeMaterial).metalness = metalness ?? 0;

    if (emissive > 0) {
      // Each particle glows in its own colour — including the colour sampled
      // from a Particle Color Instance image — so the cloud reads as a light
      // source. An environment capture taken with the particles visible then
      // carries that colour out to the surrounding surfaces.
      (material as MeshStandardNodeMaterial).emissiveNode = vColor.xyz.mul(
        float(emissive)
      );
    }
  }

  // Readable by whoever holds the material, so a harness can tell a stretched
  // build from a plain one without decompiling the shader.
  material.userData.velocityStretch = useStretch ? velocityStretch : 0;

  return material;
}
