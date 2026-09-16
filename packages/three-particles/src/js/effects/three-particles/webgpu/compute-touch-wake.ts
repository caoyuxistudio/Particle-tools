/**
 * GPU side of the touch wake (see `../touch-wake.ts` for what it is).
 *
 * The samples sit in the tail of the shared curveData storage buffer, after
 * the force fields and collision planes, so they cost no storage binding of
 * their own; a count uniform says how many are live. The kernel is a
 * transcription of `wakeDisplacement`: for each sample, a gaussian of the
 * distance times an exponential of the age, and the particle takes on that
 * much of the finger's motion — plus an optional turn about the finger's
 * path. It moves the position directly, the way curl noise does.
 *
 * @module
 */
import { Vector3 } from 'three';
import {
  Fn,
  float,
  vec3,
  uniform,
  If,
  Loop,
  Continue,
  exp,
  dot,
  cross,
  length,
  type ShaderNodeObject,
  type Node,
} from 'three/tsl';

import { TOUCH_SAMPLE_STRIDE } from '../touch-wake.js';

/** Contributions below this weight are skipped, matching the CPU path. */
const MIN_WEIGHT = 0.0001;

export function createTouchWakeTSL(
  sCurveData: ShaderNodeObject<Node>,
  touchOffset: number
) {
  const uCount = uniform(float(0));
  const uNow = uniform(float(0));
  const uStrength = uniform(float(1));
  const uWake = uniform(float(0.4));
  const uSwirl = uniform(float(0));
  const uNormal = uniform(new Vector3(0, 1, 0));
  // The finger's speed cap, in world units a second: what a wall may give
  // back of a finger's push (see compute-collision-planes.ts).
  const uMaxSpeed = uniform(float(8));

  const applyTouchWakeTSL = Fn(
    ({
      pos,
      delta,
    }: {
      pos: ShaderNodeObject<Node>;
      delta: ShaderNodeObject<Node>;
    }) => {
      Loop(uCount, ({ i }: { i: ShaderNodeObject<Node> }) => {
        const base = i.mul(TOUCH_SAMPLE_STRIDE).add(touchOffset);
        const samplePos = vec3(
          sCurveData.element(base),
          sCurveData.element(base.add(1)),
          sCurveData.element(base.add(2))
        );
        const radius = sCurveData.element(base.add(3));
        const sampleVel = vec3(
          sCurveData.element(base.add(4)),
          sCurveData.element(base.add(5)),
          sCurveData.element(base.add(6))
        );
        const time = sCurveData.element(base.add(7));

        If(radius.lessThanEqual(0.0), () => {
          Continue();
        });

        const toParticle = pos.sub(samplePos);
        const d2 = dot(toParticle, toParticle);
        const w = exp(d2.negate().div(radius.mul(radius)))
          .mul(exp(uNow.sub(time).negate().div(uWake)))
          .toVar();

        If(w.lessThan(MIN_WEIGHT), () => {
          Continue();
        });

        // Drag: the particle takes on the finger's motion.
        pos.assign(pos.add(sampleVel.mul(w).mul(uStrength).mul(delta)));

        // Swirl: a turn about the finger's path, in the plane of the normal.
        const speed = length(sampleVel);
        const tangent = cross(vec3(uNormal), toParticle);
        const tangentLength = length(tangent);
        If(
          tangentLength.greaterThan(0.000001).and(speed.greaterThan(0.0)),
          () => {
            pos.assign(
              pos.add(
                tangent
                  .div(tangentLength)
                  .mul(speed)
                  .mul(w)
                  .mul(uSwirl)
                  .mul(delta)
              )
            );
          }
        );
      });
    },
    'void'
  );

  return {
    countUniform: uCount,
    nowUniform: uNow,
    strengthUniform: uStrength,
    wakeUniform: uWake,
    swirlUniform: uSwirl,
    normalUniform: uNormal,
    maxSpeedUniform: uMaxSpeed,
    /** TSL function to call in the compute kernel: apply({ pos, delta }) */
    apply: applyTouchWakeTSL,
  };
}
