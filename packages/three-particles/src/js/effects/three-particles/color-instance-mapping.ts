/**
 * Where on the colour source a particle is born: the spawn position projected
 * onto one of the three axis planes, scaled about the source's centre, and
 * wrapped or cut where the source runs out.
 *
 * Conventions, per plane, are "the source seen from the plane's positive
 * normal, upright":
 *
 * - `XZ` — seen from +Y looking down with −Z as up (the way the piece's
 *   top-down camera, rotated −90° about X, sees it): columns run along +X,
 *   rows along +Z.
 * - `XY` — seen from +Z (a camera looking down −Z with +Y up): columns along
 *   +X, rows along −Y.
 * - `YZ` — seen from +X (a camera looking down −X with +Y up): columns along
 *   −Z, rows along −Y.
 *
 * The mapped area along each of the two axes is the config's own size where
 * one is given, and the rectangle emitter's size otherwise — its first
 * dimension for the columns, its second for the rows, whichever way the
 * emitter is turned.
 *
 * `scale` enlarges the source about its centre (2 = only the middle half of
 * the source spans the area); below 1 the source no longer covers the area,
 * and `wrap` says what the rest sees.
 */
import { ColorInstancePlane, ColorInstanceWrap } from './three-particles-enums';

export type ColorInstanceMapping = {
  plane: ColorInstancePlane;
  /** Mapped size along X, Y and Z; 0 = the emitter rectangle's own size. */
  areaX: number;
  areaY: number;
  areaZ: number;
  /** Enlargement of the source about its centre, per source axis. */
  scaleX: number;
  scaleY: number;
  wrap: ColorInstanceWrap;
};

/** Below this a scale would put the whole area inside one texel. */
const MIN_SCALE = 1e-3;

const wrapCoordinate = (t: number, wrap: ColorInstanceWrap): number => {
  switch (wrap) {
    case ColorInstanceWrap.REPEAT:
      return t - Math.floor(t);
    case ColorInstanceWrap.MIRROR: {
      const m = t - 2 * Math.floor(t / 2);
      return m > 1 ? 2 - m : m;
    }
    case ColorInstanceWrap.STRETCH:
      return t < 0 ? 0 : t > 1 ? 1 : t;
    default:
      return t;
  }
};

/**
 * The source coordinate (u across the columns, v down the rows, both 0..1)
 * that a spawn position lands on. Returns false when the wrap is `ZERO` and
 * the position falls off the source: nothing to sample there.
 */
export const spawnToUv = (
  m: ColorInstanceMapping,
  x: number,
  y: number,
  z: number,
  rectWidth: number,
  rectHeight: number,
  out: [number, number]
): boolean => {
  let across: number;
  let down: number;
  let areaAcross: number;
  let areaDown: number;
  switch (m.plane) {
    case ColorInstancePlane.XY:
      across = x;
      down = -y;
      areaAcross = m.areaX || rectWidth;
      areaDown = m.areaY || rectHeight;
      break;
    case ColorInstancePlane.YZ:
      across = -z;
      down = -y;
      areaAcross = m.areaZ || rectWidth;
      areaDown = m.areaY || rectHeight;
      break;
    default:
      across = x;
      down = z;
      areaAcross = m.areaX || rectWidth;
      areaDown = m.areaZ || rectHeight;
  }
  const scaleX = Math.max(MIN_SCALE, m.scaleX || 1);
  const scaleY = Math.max(MIN_SCALE, m.scaleY || 1);
  // Centred on the emitter; the scale enlarges the source about that centre.
  const u = across / (areaAcross || 1) / scaleX + 0.5;
  const v = down / (areaDown || 1) / scaleY + 0.5;
  if (m.wrap === ColorInstanceWrap.ZERO || !m.wrap) {
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    out[0] = u;
    out[1] = v;
    return true;
  }
  out[0] = wrapCoordinate(u, m.wrap);
  out[1] = wrapCoordinate(v, m.wrap);
  return true;
};

/** The RGBA byte offset of the texel a source coordinate falls in. */
export const uvToPixelOffset = (
  u: number,
  v: number,
  width: number,
  height: number
): number => {
  const px = Math.min(width - 1, (u * width) | 0);
  const py = Math.min(height - 1, (v * height) | 0);
  return (py * width + px) * 4;
};
