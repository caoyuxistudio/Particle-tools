/**
 * GPU collision plane computation for particle systems.
 *
 * Encodes collision plane configurations into a flat Float32Array that can be
 * written into the shared curveData storage buffer (avoiding an extra
 * storage buffer binding that would exceed the WebGPU per-stage limit of 8).
 *
 * Provides a TSL helper function that iterates over the encoded planes
 * and applies collision responses (kill, clamp, bounce) to particles.
 *
 * Collision plane modes:
 *   - KILL (0): deactivate the particle immediately
 *   - CLAMP (1): project position onto plane, zero velocity along normal
 *   - BOUNCE (2): mirror the position across the plane and reflect the
 *     frame's actual motion (velocity, forces, curl noise, fingers — all of
 *     it) with damping. The damped reflection becomes the particle's
 *     velocity and its bounce weight (a float in the particle's init slot,
 *     see compute-modifiers.ts) goes to 1; from then on the kernel moves it
 *     by vel + (1 − bounce) × flow, both fading with the plane's `recover`,
 *     so a particle the field carried into a wall leaves it at the damped
 *     speed and is handed back to the flow over that many seconds — never
 *     faster than the reflection or the flow. A finger's shove is taken as
 *     if the finger had pushed at no more than its speed cap (`touch.
 *     maxSpeed`): that much of it is mirrored and reflected like the rest of
 *     the motion, the excess is set on the wall — so a finger sweeping
 *     particles into a wall bounces them back at its own pace, not at the
 *     many times that its overlapping samples add up to.
 *
 * The planes are applied at the end of the frame, after every modifier that
 * moves a particle, so what they see is where the particle really ended up.
 *
 * @module
 */
import {
  clamp,
  Continue,
  dot,
  exp,
  float,
  Fn,
  If,
  Loop,
  type Node,
  type ShaderNodeObject,
  uniform,
  vec3,
  vec4,
  length,
  min as tslMin,
  max as tslMax,
} from 'three/tsl';

import { CollisionPlaneMode } from '../three-particles-enums.js';
import type { NormalizedCollisionPlaneConfig } from '../types.js';

// ─── Encoding Layout ─────────────────────────────────────────────────────────

/**
 * Per-plane stride in the packed Float32Array.
 *
 * Layout per collision plane (12 floats):
 *   [0]    isActive (0 or 1)
 *   [1]    mode (0 = KILL, 1 = CLAMP, 2 = BOUNCE)
 *   [2-4]  position (x, y, z)
 *   [5-7]  normal (x, y, z) — normalized
 *   [8]    dampen (0–1)
 *   [9]    lifetimeLoss (0–1)
 *   [10]   recover (seconds; BOUNCE only)
 *   [11]   padding (reserved)
 */
const PLANE_STRIDE = 12;

/** Maximum collision planes supported per particle system. */
export const MAX_COLLISION_PLANES = 16;

/** Total floats reserved for collision plane data in the curveData buffer. */
export const COLLISION_PLANE_DATA_SIZE = MAX_COLLISION_PLANES * PLANE_STRIDE;

/** Pre-allocated encoding buffer, reused every frame to avoid GC pressure. */
let _encodeBuf: Float32Array | null = null;

// ─── CPU-side Encoding ───────────────────────────────────────────────────────

/**
 * Packs an array of collision plane configs into a flat Float32Array for GPU upload.
 *
 * @param planes - Normalized collision plane configs from the particle system.
 * @returns A Float32Array of `MAX_COLLISION_PLANES * PLANE_STRIDE` floats.
 */
export function encodeCollisionPlanesForGPU(
  planes: ReadonlyArray<NormalizedCollisionPlaneConfig>
): Float32Array {
  if (!_encodeBuf || _encodeBuf.length !== COLLISION_PLANE_DATA_SIZE) {
    _encodeBuf = new Float32Array(COLLISION_PLANE_DATA_SIZE);
  }
  const data = _encodeBuf;
  data.fill(0);

  const count = Math.min(planes.length, MAX_COLLISION_PLANES);
  for (let i = 0; i < count; i++) {
    const cp = planes[i];
    const base = i * PLANE_STRIDE;

    data[base] = cp.isActive ? 1 : 0;

    let modeCode = 0;
    if (cp.mode === CollisionPlaneMode.CLAMP) modeCode = 1;
    else if (cp.mode === CollisionPlaneMode.BOUNCE) modeCode = 2;
    data[base + 1] = modeCode;

    data[base + 2] = cp.position.x;
    data[base + 3] = cp.position.y;
    data[base + 4] = cp.position.z;
    data[base + 5] = cp.normal.x;
    data[base + 6] = cp.normal.y;
    data[base + 7] = cp.normal.z;
    data[base + 8] = cp.dampen;
    data[base + 9] = cp.lifetimeLoss;
    data[base + 10] = cp.recover ?? 0;
    data[base + 11] = 0; // padding
  }

  return data;
}

// ─── TSL Collision Plane Application ─────────────────────────────────────────

/**
 * Creates the TSL uniform and helper function for applying collision planes
 * in a GPU compute shader.
 *
 * Collision plane data is read from the shared curveData storage buffer at a
 * fixed offset, avoiding an additional storage buffer binding.
 *
 * @param sCurveData - The shared curveData storage node.
 * @param collisionPlaneOffset - Float offset into curveData where collision plane data starts.
 * @param collisionPlaneCount - Number of active collision planes (0 to MAX_COLLISION_PLANES).
 * @returns Object with the count uniform and the TSL apply function.
 */
export function createCollisionPlaneTSL(
  sCurveData: ShaderNodeObject<Node>,
  collisionPlaneOffset: number,
  collisionPlaneCount: number
) {
  const count = Math.min(collisionPlaneCount, MAX_COLLISION_PLANES);
  const uCollisionPlaneCount = uniform(float(count));
  const cpBase = collisionPlaneOffset;
  /**
   * The longest `recover` among the bounce planes, seconds. While it is
   * above zero, the stored velocity — which after a bounce is the particle's
   * motion relative to the flow — decays toward zero at that time constant,
   * so a bounced particle settles back into the field.
   */
  const uBounceRecover = uniform(float(0));

  const applyBounceRecovery = Fn(
    ({
      vel,
      delta,
      bounce,
    }: {
      vel: ShaderNodeObject<Node>;
      delta: ShaderNodeObject<Node>;
      bounce: ShaderNodeObject<Node>;
    }) => {
      // The bounce velocity and its weight fade together, so a bounced
      // particle's motion is vel + (1 − bounce) × flow: a blend from the
      // reflection back to the field, never faster than either.
      If(uBounceRecover.greaterThan(0.0), () => {
        const keep = exp(delta.negate().div(uBounceRecover));
        vel.assign(vel.mul(keep));
        bounce.assign(bounce.mul(keep));
      });
    },
    'void'
  );

  /**
   * TSL function that applies all collision planes to a particle.
   *
   * @param pos - Current particle position (vec3, modified in place)
   * @param vel - Current particle velocity (vec3, modified in place)
   * @param effVel - The frame's own motion as a velocity: (pos − pos at
   *   frame start − shove) / dt, which includes what the field did but not a
   *   finger's push
   * @param shove - What a finger's push moved the particle this frame (vec3,
   *   world units). The wall answers it as if the finger had pushed at no
   *   more than `shoveCap`: that much of it is mirrored and reflected, the
   *   rest is set on the wall
   * @param shoveCap - The finger's speed cap (world units a second): the most
   *   a wall gives back of a push
   * @param delta - The frame's dt in seconds
   * @param bounce - The particle's bounce weight (float, modified in place):
   *   1 the frame it bounces, decaying with `recover`; the kernel takes the
   *   flow only as far as it has faded
   * @param oiaVec - orbitalIsActive vec4 (w = isActive, modified for KILL)
   * @param sColor - Color storage node (modified for KILL)
   * @param ps - particleState vec4 (x = lifetime, modified for lifetime loss)
   * @param startLife - Start lifetime scalar (for lifetime loss)
   * @param i - Particle index (for storage buffer element access)
   * @param sOrbitalIsActive - orbitalIsActive storage node (for KILL)
   */
  const applyCollisionPlanesTSL = Fn(
    ({
      pos,
      vel,
      effVel,
      shove,
      shoveCap,
      delta,
      bounce,
      oiaVec,
      sColorNode,
      ps,
      startLife,
      particleIdx,
      sOrbitalIsActiveNode,
    }: {
      pos: ShaderNodeObject<Node>;
      vel: ShaderNodeObject<Node>;
      effVel: ShaderNodeObject<Node>;
      shove: ShaderNodeObject<Node>;
      shoveCap: ShaderNodeObject<Node>;
      delta: ShaderNodeObject<Node>;
      bounce: ShaderNodeObject<Node>;
      oiaVec: ShaderNodeObject<Node>;
      sColorNode: ShaderNodeObject<Node>;
      ps: ShaderNodeObject<Node>;
      startLife: ShaderNodeObject<Node>;
      particleIdx: ShaderNodeObject<Node>;
      sOrbitalIsActiveNode: ShaderNodeObject<Node>;
    }) => {
      Loop(uCollisionPlaneCount, ({ i }: { i: ShaderNodeObject<Node> }) => {
        const base = i.mul(PLANE_STRIDE).add(cpBase);

        const isActive = sCurveData.element(base);
        If(isActive.lessThan(0.5), () => {
          Continue();
        });

        const mode = sCurveData.element(base.add(1));
        const planePos = vec3(
          sCurveData.element(base.add(2)),
          sCurveData.element(base.add(3)),
          sCurveData.element(base.add(4))
        );
        const planeNormal = vec3(
          sCurveData.element(base.add(5)),
          sCurveData.element(base.add(6)),
          sCurveData.element(base.add(7))
        );
        const dampen = sCurveData.element(base.add(8));
        const lifetimeLoss = sCurveData.element(base.add(9));

        // Signed distance from particle to plane
        const toParticle = pos.sub(planePos);
        const signedDist = dot(toParticle, planeNormal);

        // Only respond when particle is on the wrong side (signedDist < 0).
        // Mode dispatch uses If/ElseIf so only one branch writes to shared
        // state (pos/vel/ps.x) in the generated WGSL — equivalent nested
        // `If()` blocks on the same variables have been observed to emit
        // WGSL that TSL cannot lower cleanly under some driver/runtime
        // combinations, producing intermittent writes.
        If(signedDist.lessThan(0.0), () => {
          // KILL mode (0). Set lifetime far past startLifetime so the
          // death check at the end of the kernel deactivates the
          // particle and zeroes color AFTER all modifiers have run
          // (modifiers would otherwise overwrite our color).
          If(mode.lessThan(0.5), () => {
            ps.x.assign(startLife.add(float(1.0)));
          })
            // CLAMP mode (1)
            .ElseIf(mode.lessThan(1.5), () => {
              // Project position onto the plane surface
              pos.assign(pos.sub(planeNormal.mul(signedDist)));

              // Remove velocity component along the normal only when moving
              // into the plane.
              const velDotN = dot(vel, planeNormal);
              If(velDotN.lessThan(0.0), () => {
                vel.assign(vel.sub(planeNormal.mul(velDotN)));
              });
            })
            // BOUNCE mode (2)
            .Else(() => {
              // A finger's push, as the wall answers it: capped at the finger's
              // own speed. Its overlapping samples add up to many times that
              // under a sweeping finger, and a wall that mirrored and
              // reflected all of it threw the particles back at hundreds of
              // units a second; a wall that pinned it held them dead against
              // it. In between: the particle comes back off the wall the way
              // a thing pushed there at the finger's pace would.
              const shoveLen = length(shove);
              const shoveKept = shove.mul(
                tslMin(float(1.0), shoveCap.mul(delta).div(tslMax(shoveLen, float(1e-6))))
              );
              // Mirror the position across the plane: the particle went
              // |signedDist| through, so it comes out that far in front —
              // except for the part of the push beyond the cap, which is
              // set on the wall.
              const shoveIn = clamp(
                dot(shove, planeNormal).negate(),
                float(0.0),
                signedDist.negate()
              );
              const keptIn = clamp(
                dot(shoveKept, planeNormal).negate(),
                float(0.0),
                shoveIn
              );
              const mirror = signedDist.negate().sub(shoveIn).add(keptIn);
              pos.assign(
                pos.sub(planeNormal.mul(signedDist)).add(planeNormal.mul(mirror))
              );

              // Reflect the frame's actual motion, not just `vel`: in a piece
              // driven by curl noise `vel` is zero and the field did all the
              // moving. The reflection becomes the particle's velocity and
              // the bounce weight goes to 1: from here the kernel moves it by
              // vel + (1 − bounce) × flow, both fading with `recover`, so the
              // particle leaves at the damped speed and is handed back to the
              // field — never faster than either. (An earlier version stored
              // the reflection *relative to the flow at the wall* and let the
              // field add its push again; where the field differed a step
              // away, the stale part showed as a burst of speed off the wall.)
              // A pure-velocity particle has no flow and gets the classic
              // reflection.
              const arriving = effVel
                .add(shoveKept.div(tslMax(delta, float(1e-6))))
                .toVar();
              const eDotN = dot(arriving, planeNormal);
              vel.assign(
                arriving.sub(planeNormal.mul(eDotN.mul(2.0))).mul(dampen)
              );
              bounce.assign(1.0);

              // Apply lifetime loss
              If(lifetimeLoss.greaterThan(0.0), () => {
                ps.x.assign(ps.x.add(lifetimeLoss.mul(startLife).mul(1000.0)));
              });
            });
        });
      });
    },
    'void'
  );

  return {
    /** Uniform for the active collision plane count. */
    countUniform: uCollisionPlaneCount,
    /** Uniform: the longest bounce `recover` time among the planes, seconds (0 = none). */
    recoverUniform: uBounceRecover,
    /** TSL function to call in the compute kernel: apply({ pos, vel, effVel, shove, bounce, ... }) */
    apply: applyCollisionPlanesTSL,
    /** TSL function to call once per frame after the velocity step: recover({ vel, delta, bounce }) */
    recover: applyBounceRecovery,
  };
}
