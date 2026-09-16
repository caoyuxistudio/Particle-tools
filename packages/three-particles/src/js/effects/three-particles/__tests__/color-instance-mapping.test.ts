import {
  spawnToUv,
  uvToPixelOffset,
  type ColorInstanceMapping,
} from '../color-instance-mapping';
import {
  ColorInstancePlane,
  ColorInstanceWrap,
} from '../three-particles-enums';

const mapping = (
  over: Partial<ColorInstanceMapping> = {}
): ColorInstanceMapping => ({
  plane: ColorInstancePlane.XZ,
  areaX: 0,
  areaY: 0,
  areaZ: 0,
  scaleX: 1,
  scaleY: 1,
  wrap: ColorInstanceWrap.ZERO,
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
  ...over,
});

const uv = (
  m: ColorInstanceMapping,
  x: number,
  y: number,
  z: number,
  rect: [number, number] = [4, 2]
): [number, number] | null => {
  const out: [number, number] = [0, 0];
  return spawnToUv(m, x, y, z, rect[0], rect[1], out) ? [out[0], out[1]] : null;
};

describe('the plane picks which two spawn coordinates map to the source', () => {
  it('XZ: columns along +X, rows along +Z, over the rectangle 4 × 2', () => {
    const m = mapping();
    expect(uv(m, 0, 99, 0)).toEqual([0.5, 0.5]);
    expect(uv(m, -2, 0, -1)).toEqual([0, 0]);
    expect(uv(m, 2, 0, 1)).toEqual([1, 1]);
    expect(uv(m, 1, 0, 0.5)).toEqual([0.75, 0.75]);
  });

  it('XY: columns along +X, rows along −Y (the top row is the +Y edge)', () => {
    const m = mapping({ plane: ColorInstancePlane.XY });
    expect(uv(m, -2, 1, 99)).toEqual([0, 0]);
    expect(uv(m, 2, -1, 99)).toEqual([1, 1]);
    expect(uv(m, 0, 0.5, 0)).toEqual([0.5, 0.25]);
  });

  it('YZ: columns along −Z, rows along −Y (seen from +X)', () => {
    const m = mapping({ plane: ColorInstancePlane.YZ });
    expect(uv(m, 99, 1, 2)).toEqual([0, 0]);
    expect(uv(m, 99, -1, -2)).toEqual([1, 1]);
    expect(uv(m, 0, 0, 1)).toEqual([0.25, 0.5]);
  });

  it('an explicit area overrides the rectangle, axis by axis and plane by plane', () => {
    expect(uv(mapping({ areaX: 8 }), 2, 0, 1)).toEqual([0.75, 1]);
    expect(uv(mapping({ areaZ: 8 }), 2, 0, 1)).toEqual([1, 0.625]);
    expect(
      uv(mapping({ plane: ColorInstancePlane.XY, areaY: 8 }), 0, -2, 0)
    ).toEqual([0.5, 0.75]);
    expect(
      uv(mapping({ plane: ColorInstancePlane.YZ, areaZ: 8 }), 0, 0, -2)
    ).toEqual([0.75, 0.5]);
  });
});

describe('offset moves the source off the emitter', () => {
  it("the source is centred on the offset, along the plane's own axes", () => {
    expect(uv(mapping({ offsetX: 1, offsetZ: 0.5 }), 1, 0, 0.5)).toEqual([
      0.5, 0.5,
    ]);
    expect(uv(mapping({ offsetX: 1 }), 3, 0, 1)).toEqual([1, 1]);
    expect(
      uv(mapping({ plane: ColorInstancePlane.XY, offsetY: 1 }), 0, 2, 0)
    ).toEqual([0.5, 0]);
    expect(
      uv(mapping({ plane: ColorInstancePlane.YZ, offsetZ: -2 }), 0, 0, -2)
    ).toEqual([0.5, 0.5]);
  });

  it("the plane's third axis of the offset is ignored", () => {
    expect(uv(mapping({ offsetY: 7 }), 1, 0, 0.5)).toEqual([0.75, 0.75]);
  });
});

describe('scale enlarges the source about its centre', () => {
  it('at 2 the area shows the middle half of the source', () => {
    const m = mapping({ scaleX: 2, scaleY: 2 });
    expect(uv(m, -2, 0, -1)).toEqual([0.25, 0.25]);
    expect(uv(m, 2, 0, 1)).toEqual([0.75, 0.75]);
    expect(uv(m, 0, 0, 0)).toEqual([0.5, 0.5]);
  });

  it('at 0.5 the source covers only the middle of the area, per axis', () => {
    const m = mapping({
      scaleX: 0.5,
      scaleY: 1,
      wrap: ColorInstanceWrap.STRETCH,
    });
    expect(uv(m, -1, 0, 0)).toEqual([0, 0.5]);
    expect(uv(m, 1, 0, 0)).toEqual([1, 0.5]);
    expect(uv(m, 0.5, 0, 0)).toEqual([0.75, 0.5]);
  });

  it('a zero or missing scale counts as 1', () => {
    expect(uv(mapping({ scaleX: 0, scaleY: 0 }), 1, 0, 0.5)).toEqual([
      0.75, 0.75,
    ]);
  });
});

describe('wrap decides what the area sees where the source runs out', () => {
  const half = (wrap: ColorInstanceWrap) =>
    mapping({ scaleX: 0.5, scaleY: 0.5, wrap });

  it('ZERO: nothing — off the source is off', () => {
    const m = half(ColorInstanceWrap.ZERO);
    expect(uv(m, 0, 0, 0)).toEqual([0.5, 0.5]);
    expect(uv(m, 0.9, 0, 0)).toEqual([0.95, 0.5]);
    expect(uv(m, 1.5, 0, 0)).toBeNull();
    expect(uv(m, 0, 0, -0.9)).toBeNull();
  });

  it('REPEAT: the source tiles', () => {
    const m = half(ColorInstanceWrap.REPEAT);
    expect(uv(m, 1.5, 0, 0)![0]).toBeCloseTo(0.25);
    expect(uv(m, -1.5, 0, 0)![0]).toBeCloseTo(0.75);
    expect(uv(m, 0, 0, 0.9)![1]).toBeCloseTo(0.4);
  });

  it('MIRROR: every other tile is flipped', () => {
    const m = half(ColorInstanceWrap.MIRROR);
    // u = 1.25 reflects to 0.75; u = −0.25 reflects to 0.25.
    expect(uv(m, 1.5, 0, 0)![0]).toBeCloseTo(0.75);
    expect(uv(m, -1.5, 0, 0)![0]).toBeCloseTo(0.25);
    expect(uv(m, 0, 0, 0.9)![1]).toBeCloseTo(0.6);
    // Two tiles out it is the source again, the right way round: u = 2.25.
    expect(
      uv(
        mapping({ scaleX: 0.25, scaleY: 0.25, wrap: ColorInstanceWrap.MIRROR }),
        1.75,
        0,
        0
      )![0]
    ).toBeCloseTo(0.25);
  });

  it('STRETCH: the edge texel runs on', () => {
    const m = half(ColorInstanceWrap.STRETCH);
    expect(uv(m, 1.5, 0, 0)).toEqual([1, 0.5]);
    expect(uv(m, -1.5, 0, -0.9)).toEqual([0, 0]);
  });

  it('inside the source all four agree', () => {
    for (const wrap of [
      ColorInstanceWrap.ZERO,
      ColorInstanceWrap.REPEAT,
      ColorInstanceWrap.MIRROR,
      ColorInstanceWrap.STRETCH,
    ]) {
      const got = uv(half(wrap), 0.5, 0, 0.25)!;
      expect(got[0]).toBeCloseTo(0.75);
      expect(got[1]).toBeCloseTo(0.75);
    }
  });
});

describe('the texel a coordinate falls in', () => {
  it('rounds down and never runs past the last column or row', () => {
    expect(uvToPixelOffset(0, 0, 4, 2)).toBe(0);
    expect(uvToPixelOffset(0.26, 0, 4, 2)).toBe(4);
    expect(uvToPixelOffset(1, 1, 4, 2)).toBe((1 * 4 + 3) * 4);
    expect(uvToPixelOffset(0.5, 0.5, 4, 2)).toBe((1 * 4 + 2) * 4);
  });
});
