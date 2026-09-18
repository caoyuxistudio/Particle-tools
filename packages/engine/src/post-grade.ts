// The output camera's post effect: the finished picture, graded.
//
// The same adjustments the emitter's source image takes (the library's
// color-tweak.ts) — saturation, contrast, hue, then brightness, a black point
// and a gamma — applied to the whole frame as the pipeline's last stage, in
// display (sRGB) space, the way an image editor applies them. The pipeline
// carries linear light, so the stage encodes, grades and decodes. The
// hue / saturation / contrast part is the library's own 3×3 matrix, prepared on
// the CPU when a setting changes; everything is a uniform, so a slider costs
// nothing but the upload.

import { buildColorTweak } from '@newkrok/three-particles';
import { Matrix3 } from 'three';
import { Fn, uniform, vec3, vec4, float, max, min, pow, sRGBTransferOETF, sRGBTransferEOTF } from 'three/tsl';

export type PostEffectSettings = {
  enabled: boolean;
  /** 1 leaves the picture alone; 0 is grey. */
  saturation: number;
  /** A plain multiplier, after the matrix. */
  brightness: number;
  /** About mid-grey; 1 leaves the picture alone. */
  contrast: number;
  /** Degrees. */
  hue: number;
  /** Levels: the value that becomes black… */
  blackPoint: number;
  /** …the value that becomes white… */
  whitePoint: number;
  /** …and the mid-tones between them (above 1 lifts). */
  gamma: number;
};

export const defaultPostEffectSettings = (): PostEffectSettings => ({
  enabled: false,
  saturation: 1,
  brightness: 1,
  contrast: 1,
  hue: 0,
  blackPoint: 0,
  whitePoint: 1,
  gamma: 1,
});

export type PostGrade = {
  node: any;
  apply: (settings: PostEffectSettings) => void;
};

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A grading stage over `color` (linear light in, linear light out). */
export const postGrade = (color: any): PostGrade => {
  const matrix = uniform(new Matrix3());
  const offset = uniform(0);
  const brightness = uniform(1);
  const black = uniform(0);
  const white = uniform(1);
  const gammaExponent = uniform(1);

  const node = Fn(() => {
    const c = vec4(color).toVar();
    const display = sRGBTransferOETF(max(c.rgb, vec3(0))).toVar();
    const graded = matrix.mul(display).add(offset).mul(brightness);
    // Levels: black → 0, white → 1, the gamma between them.
    const range = max(white.sub(black), float(1e-4));
    const levelled = min(max(graded.sub(black).div(range), vec3(0)), vec3(1));
    const toned = pow(levelled, vec3(gammaExponent));
    return vec4(sRGBTransferEOTF(toned), c.a);
  })();

  const apply = (settings: PostEffectSettings): void => {
    const tweak = buildColorTweak({
      saturation: settings.saturation,
      contrast: settings.contrast,
      hue: settings.hue,
    });
    const m = tweak ? Array.from(tweak.m) : IDENTITY;
    // Row-major in, and Matrix3.set takes its arguments row-major.
    (matrix.value as Matrix3).set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    offset.value = tweak ? tweak.offset : 0;
    brightness.value = Math.max(0, settings.brightness);
    black.value = settings.blackPoint;
    white.value = settings.whitePoint;
    gammaExponent.value = 1 / Math.max(0.01, settings.gamma);
  };

  return { node, apply };
};
