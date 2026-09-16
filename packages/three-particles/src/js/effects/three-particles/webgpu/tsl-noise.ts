/**
 * 3D Simplex Noise implemented in TSL (Three Shading Language).
 *
 * Adapted from the classic Ashima Arts / Stefan Gustavson simplex noise
 * implementation (MIT licence) for use in Three.js GPU compute shaders.
 *
 * References:
 *   - Stefan Gustavson, "Simplex noise demystified", 2005
 *   - https://github.com/ashima/webgl-noise
 *
 * @module
 */
import {
  Fn,
  vec2,
  vec3,
  vec4,
  float,
  floor,
  fract,
  mix,
  dot,
  step,
  abs,
  min,
  max,
  mod,
  type ShaderNodeObject,
  type Node,
} from 'three/tsl';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Hash / permutation helper.
 *
 * Equivalent to the classic `mod289` + multiply-and-fold scheme:
 *   permute(x) = mod(((x * 34.0) + 10.0) * x, 289.0)
 *
 * The extra `10.0` (vs the original `1.0`) avoids degenerate runs near zero
 * and is widely used in TSL/WGSL ports of the Ashima implementation.
 */
const permute = Fn(({ x }: Record<string, ShaderNodeObject<Node>>) => {
  // ((x * 34.0 + 10.0) * x) mod 289.0
  return mod(x.mul(34.0).add(10.0).mul(x), float(289.0));
});

/**
 * Fast inverse square-root approximation.
 *
 * taylorInvSqrt(r) = 1.79284291400159 - 0.85373472095314 * r
 *
 * Used to normalise gradient vectors without a true sqrt.
 */
const taylorInvSqrt = Fn(({ r }: Record<string, ShaderNodeObject<Node>>) => {
  return float(1.79284291400159).sub(float(0.85373472095314).mul(r));
});

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * 3D simplex noise implemented in TSL.
 *
 * Algorithm overview:
 *   1. Skew the input point into the simplex (tetrahedral) grid.
 *   2. Determine which of the six tetrahedra the skewed point occupies.
 *   3. Un-skew the four integer lattice corners back to real space.
 *   4. Compute pseudo-random gradient vectors at each corner via two rounds of
 *      `permute` (one for the iy/iz hash, one for ix), yielding per-corner
 *      gradient (gx, gy, gz) extracted using the "ns" mapping.
 *   5. Weight each corner's contribution by a radially-symmetric falloff
 *      `max(0, 0.5 - |x|²)⁴` and accumulate.
 *   6. Scale the result so the output lies in approximately [-1, 1].
 *
 * @param v - Input position (vec3).
 * @returns Noise value in approximately [-1, 1] (float).
 */
export const snoise3D: ReturnType<typeof Fn> = Fn(
  ({ v }: Record<string, ShaderNodeObject<Node>>) => {
    // ── Step 1: Skew input space ──────────────────────────────────────────────
    // F3 = 1/3. Skew the input space to determine which simplex cell we're in.
    const ONE_THIRD = float(1.0 / 3.0);
    const ONE_SIXTH = float(1.0 / 6.0);

    // i = floor(v + dot(v, vec3(1/3)))
    const i = floor(
      v.add(dot(v, vec3(ONE_THIRD, ONE_THIRD, ONE_THIRD)))
    ).toVar();

    // ── Step 2: Un-skew back to (x0,y0,z0) ──────────────────────────────────
    // x0 = v - i + dot(i, vec3(1/6))
    const x0 = v
      .sub(i)
      .add(dot(i, vec3(ONE_SIXTH, ONE_SIXTH, ONE_SIXTH)))
      .toVar();

    // ── Step 3: Determine simplex (tetrahedron) ───────────────────────────────
    // Which of the six tetrahedra is point x0 in?
    // Compare x0 components pairwise to rank them and identify the two
    // intermediate simplex corners (i1, i2).
    //
    // g = step(x0.yzx, x0.xyz): 1 where x0[i] >= x0[i-1 mod 3]
    // l = 1 - g.zxy             (complement for the other direction)
    const g = step(x0.yzx, x0.xyz).toVar();
    const l = float(1.0).sub(g).toVar();

    // i1: first offset (one unit step toward the dominant axis)
    // i2: second offset (two unit steps)
    const i1 = min(g.xyz, l.zxy).toVar();
    const i2 = max(g.xyz, l.zxy).toVar();

    // Un-skew the three corner displacements from x0:
    //   x1 = x0 - i1 + G3
    //   x2 = x0 - i2 + 2*G3
    //   x3 = x0 - 1  + 3*G3
    const x1 = x0.sub(i1).add(ONE_SIXTH).toVar();
    const x2 = x0.sub(i2).add(ONE_SIXTH.mul(2.0)).toVar();
    const x3 = x0.sub(float(1.0)).add(ONE_SIXTH.mul(3.0)).toVar();

    // ── Step 4: Permutation hashes → gradient directions ─────────────────────
    // Wrap i into [0, 289) so the hash stays well-behaved.
    const iw = mod(i, float(289.0)).toVar();

    // Hash yz layers first, then mix in x.
    // For each of the 4 corners, hash iz then iy:
    //   p_yz_c = permute(permute(iz_c) + iy_c)
    // Then hash ix:
    //   p_c    = permute(p_yz_c + ix_c)
    // Each final p_c is a scalar hash that encodes the full gradient direction.

    // Corner z-components: iz, iz+i1.z, iz+i2.z, iz+1
    const p0_yz = permute({
      x: permute({
        x: vec4(
          vec2(iw.z, iw.z.add(i1.z)),
          vec2(iw.z.add(i2.z), iw.z.add(1.0))
        ),
      }).add(
        vec4(vec2(iw.y, iw.y.add(i1.y)), vec2(iw.y.add(i2.y), iw.y.add(1.0)))
      ),
    });

    // Final hash: mix in x-components
    const p = permute({
      x: p0_yz.add(
        vec4(vec2(iw.x, iw.x.add(i1.x)), vec2(iw.x.add(i2.x), iw.x.add(1.0)))
      ),
    });

    // ── Step 5: Convert hash to gradient directions ───────────────────────────
    // Standard Ashima/Gustavson gradient extraction via octahedral mapping.
    //
    // The hash values `p` are in [0, 289). We reduce them to a 7×7 grid
    // (49 entries) to extract two gradient components (gx, gy), then derive
    // gz via octahedral projection: gz = 1 - |gx| - |gy|.
    //
    // When gz < 0 the gradient lies outside the octahedron's upper hemisphere;
    // a fold-back correction shifts gx/gy inward so the gradient stays on
    // the octahedron surface, giving 12 well-distributed directions that
    // closely approximate the original simplex gradient set.
    //
    // Constants (from Ashima `vec3 ns = n_ * D.wyz - D.xzx`):
    //   ns.x =  2/7  ≈  0.285714   (grid step size)
    //   ns.y = -13/14 ≈ -0.928571   (grid offset: 1/14 - 1)
    //   ns.z =  1/7  ≈  0.142857   (used for p mod 49)

    const n_ = float(0.142857142857142); // 1/7

    // j = p mod 49  — reduces hash to [0, 48]
    //   p * ns.z * ns.z = p * (1/7)^2 = p / 49
    const j = p.sub(float(49.0).mul(floor(p.mul(n_).mul(n_)))).toVar();

    // x_ = floor(j / 7)  ∈ [0, 6]
    const x_ = floor(j.mul(n_)).toVar();
    // y_ = floor(j - 7 * x_)  ∈ [0, 6]
    const y_ = floor(j.sub(float(7.0).mul(x_))).toVar();

    // Map grid indices to gradient components in approximately [-1, 1]:
    //   gx = x_ * (2/7) + (-13/14)  ∈ [-0.929, 0.786]
    //   gy = y_ * (2/7) + (-13/14)  ∈ [-0.929, 0.786]
    const NS_X = float(0.285714285714286); // 2/7
    const NS_Y = float(-0.928571428571429); // 1/14 - 1

    const gx = x_.mul(NS_X).add(NS_Y);
    const gy = y_.mul(NS_X).add(NS_Y);

    // gz = octahedral budget: 1 - |gx| - |gy|
    const gz = float(1.0).sub(abs(gx)).sub(abs(gy)).toVar();

    // Octahedral fold-back: when gz < 0, shift gx/gy toward the origin
    //   step(gz, 0) → 1 when gz <= 0, 0 when gz > 0
    //   correction = (floor(component) + 0.5) when gz <= 0, else 0
    //   gx -= correction_x, gy -= correction_y
    const gz_neg = step(gz, vec4(0.0)); // 1 where gz <= 0
    const ox = gz_neg.mul(floor(gx).add(0.5));
    const oy = gz_neg.mul(floor(gy).add(0.5));
    const gx_final = gx.sub(ox);
    const gy_final = gy.sub(oy);

    // Build the four un-normalised gradient vectors
    const g0 = vec3(gx_final.x, gy_final.x, gz.x).toVar();
    const g1 = vec3(gx_final.y, gy_final.y, gz.y).toVar();
    const g2 = vec3(gx_final.z, gy_final.z, gz.z).toVar();
    const g3 = vec3(gx_final.w, gy_final.w, gz.w).toVar();

    // Normalise gradients using the Taylor inverse-sqrt approximation
    const norm = taylorInvSqrt({
      r: vec4(vec2(dot(g0, g0), dot(g1, g1)), vec2(dot(g2, g2), dot(g3, g3))),
    });
    g0.assign(g0.mul(norm.x));
    g1.assign(g1.mul(norm.y));
    g2.assign(g2.mul(norm.z));
    g3.assign(g3.mul(norm.w));

    // ── Step 6: Compute corner contributions ─────────────────────────────────
    // Falloff: m = max(0, 0.5 - |x|²)⁴  (C² continuity)
    const m = max(
      vec4(
        vec2(float(0.5).sub(dot(x0, x0)), float(0.5).sub(dot(x1, x1))),
        vec2(float(0.5).sub(dot(x2, x2)), float(0.5).sub(dot(x3, x3)))
      ),
      float(0.0)
    ).toVar();

    const m2 = m.mul(m).toVar();
    const m4 = m2.mul(m2).toVar();

    // Dot the gradients with the un-skewed displacement vectors
    const gdot = vec4(
      vec2(dot(g0, x0), dot(g1, x1)),
      vec2(dot(g2, x2), dot(g3, x3))
    );

    // Accumulate: sum(m4 * gdot), then scale to [-1, 1]
    // The scale factor 42.0 is the classical Gustavson normalisation constant
    // for 3D simplex noise with this gradient set.
    return float(42.0).mul(dot(m4, gdot));
  }
);

/**
 * Evaluates noise at three different input configurations matching
 * the CPU noise modifier pattern from `three-particles-modifiers.ts`:
 *
 * ```
 *   noiseX = snoise3D(pos, 0, 0)       // pos = (t, 0, 0)
 *   noiseY = snoise3D(pos, pos, 0)     // pos = (t, t, 0)
 *   noiseZ = snoise3D(pos, pos, pos)   // pos = (t, t, t)
 * ```
 *
 * where `t` is the scalar noise position (e.g. `lifePercent * strength * 10`).
 *
 * This matches the three calls in the CPU path:
 * ```typescript
 * noiseInput.set(noisePosition, 0,             0            );  // → posX
 * noiseInput.set(noisePosition, noisePosition, 0            );  // → posY
 * noiseInput.set(noisePosition, noisePosition, noisePosition);  // → posZ
 * ```
 *
 * @param t - Scalar noise position (float). Typically `lifePercent * strength * 10`.
 * @returns vec3(noiseX, noiseY, noiseZ) — each component in approximately [-1, 1].
 */
export const particleNoise3: ReturnType<typeof Fn> = Fn(
  ({ t }: Record<string, ShaderNodeObject<Node>>) => {
    const noiseX = snoise3D({ v: vec3(t, float(0.0), float(0.0)) });
    const noiseY = snoise3D({ v: vec3(t, t, float(0.0)) });
    const noiseZ = snoise3D({ v: vec3(t, t, t) });
    return vec3(noiseX, noiseY, noiseZ);
  }
);

// Re-export TSL types for callers that need them
/**
 * Classic Perlin noise in 3D — Stefan Gustavson's `cnoise` (webgl-noise,
 * MIT) in TSL, with this file's permute, so it agrees with the CPU port
 * `cnoise3` to float precision. Zero at every lattice point; the 2.2 scale
 * of the original, so roughly ±1.
 */
export const cnoise3D: ReturnType<typeof Fn> = Fn(
  ({ v }: Record<string, ShaderNodeObject<Node>>) => {
    const Pi0 = mod(floor(v), float(289.0)).toVar();
    const Pi1 = mod(Pi0.add(1.0), float(289.0)).toVar();
    const Pf0 = fract(v).toVar();
    const Pf1 = Pf0.sub(1.0).toVar();
    const ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
    const iy = vec4(Pi0.y, Pi0.y, Pi1.y, Pi1.y);
    const iz0 = vec4(Pi0.z);
    const iz1 = vec4(Pi1.z);

    const ixy = permute({ x: permute({ x: ix }).add(iy) });
    const ixy0 = permute({ x: ixy.add(iz0) });
    const ixy1 = permute({ x: ixy.add(iz1) });

    const gx0 = ixy0.div(7.0).toVar();
    const gy0 = fract(floor(gx0).div(7.0)).sub(0.5).toVar();
    gx0.assign(fract(gx0));
    const gz0 = vec4(0.5).sub(abs(gx0)).sub(abs(gy0)).toVar();
    const sz0 = step(gz0, vec4(0.0));
    gx0.assign(gx0.sub(sz0.mul(step(vec4(0.0), gx0).sub(0.5))));
    gy0.assign(gy0.sub(sz0.mul(step(vec4(0.0), gy0).sub(0.5))));

    const gx1 = ixy1.div(7.0).toVar();
    const gy1 = fract(floor(gx1).div(7.0)).sub(0.5).toVar();
    gx1.assign(fract(gx1));
    const gz1 = vec4(0.5).sub(abs(gx1)).sub(abs(gy1)).toVar();
    const sz1 = step(gz1, vec4(0.0));
    gx1.assign(gx1.sub(sz1.mul(step(vec4(0.0), gx1).sub(0.5))));
    gy1.assign(gy1.sub(sz1.mul(step(vec4(0.0), gy1).sub(0.5))));

    const g000 = vec3(gx0.x, gy0.x, gz0.x).toVar();
    const g100 = vec3(gx0.y, gy0.y, gz0.y).toVar();
    const g010 = vec3(gx0.z, gy0.z, gz0.z).toVar();
    const g110 = vec3(gx0.w, gy0.w, gz0.w).toVar();
    const g001 = vec3(gx1.x, gy1.x, gz1.x).toVar();
    const g101 = vec3(gx1.y, gy1.y, gz1.y).toVar();
    const g011 = vec3(gx1.z, gy1.z, gz1.z).toVar();
    const g111 = vec3(gx1.w, gy1.w, gz1.w).toVar();

    const norm0 = taylorInvSqrt({
      r: vec4(
        dot(g000, g000),
        dot(g010, g010),
        dot(g100, g100),
        dot(g110, g110)
      ),
    });
    g000.assign(g000.mul(norm0.x));
    g010.assign(g010.mul(norm0.y));
    g100.assign(g100.mul(norm0.z));
    g110.assign(g110.mul(norm0.w));
    const norm1 = taylorInvSqrt({
      r: vec4(
        dot(g001, g001),
        dot(g011, g011),
        dot(g101, g101),
        dot(g111, g111)
      ),
    });
    g001.assign(g001.mul(norm1.x));
    g011.assign(g011.mul(norm1.y));
    g101.assign(g101.mul(norm1.z));
    g111.assign(g111.mul(norm1.w));

    const n000 = dot(g000, Pf0);
    const n100 = dot(g100, vec3(Pf1.x, Pf0.y, Pf0.z));
    const n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
    const n110 = dot(g110, vec3(Pf1.x, Pf1.y, Pf0.z));
    const n001 = dot(g001, vec3(Pf0.x, Pf0.y, Pf1.z));
    const n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
    const n011 = dot(g011, vec3(Pf0.x, Pf1.y, Pf1.z));
    const n111 = dot(g111, Pf1);

    // fade(t) = t³ (t (6t − 15) + 10)
    const fadeXYZ = Pf0.mul(Pf0)
      .mul(Pf0)
      .mul(Pf0.mul(Pf0.mul(6.0).sub(15.0)).add(10.0));
    const nz = mix(
      vec4(n000, n100, n010, n110),
      vec4(n001, n101, n011, n111),
      fadeXYZ.z
    );
    const nyz = mix(nz.xy, nz.zw, fadeXYZ.y);
    const nxyz = mix(nyz.x, nyz.y, fadeXYZ.x);
    return nxyz.mul(2.2);
  }
);

export type { ShaderNodeObject, Node };
