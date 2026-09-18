import {
  applyColorTweak,
  buildColorTweak,
  remapLuminance,
} from '../color-tweak';

const apply = (
  settings: Parameters<typeof buildColorTweak>[0],
  rgb: [number, number, number]
): [number, number, number] => {
  const tweak = buildColorTweak(settings);
  if (!tweak) return rgb;
  return applyColorTweak(tweak, rgb[0], rgb[1], rgb[2], [0, 0, 0]);
};

const luma = ([r, g, b]: [number, number, number]): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

describe('color tweak', () => {
  it('is the identity by default, and skips the work', () => {
    expect(buildColorTweak(undefined)).toBeNull();
    expect(buildColorTweak({ saturation: 1, contrast: 1, hue: 0 })).toBeNull();
  });

  it('saturation 0 turns a colour into its own grey', () => {
    const out = apply({ saturation: 0 }, [0.9, 0.2, 0.1]);
    expect(out[0]).toBeCloseTo(out[1], 6);
    expect(out[1]).toBeCloseTo(out[2], 6);
    expect(out[0]).toBeCloseTo(luma([0.9, 0.2, 0.1]), 6);
  });

  it('saturation above 1 pushes a colour further from grey, keeping its luma', () => {
    const input: [number, number, number] = [0.6, 0.4, 0.3];
    const out = apply({ saturation: 1.5 }, input);
    expect(out[0] - out[2]).toBeGreaterThan(input[0] - input[2]);
    expect(luma(out)).toBeCloseTo(luma(input), 6);
  });

  it('a hue turn of 120 degrees sends red toward green', () => {
    const out = apply({ hue: 120 }, [1, 0, 0]);
    expect(out[1]).toBeGreaterThan(out[0]);
    expect(out[1]).toBeGreaterThan(out[2]);
  });

  it('contrast spreads about mid-grey and clamps', () => {
    expect(apply({ contrast: 2 }, [0.25, 0.25, 0.25])).toEqual([0, 0, 0]);
    expect(apply({ contrast: 2 }, [0.75, 0.75, 0.75])).toEqual([1, 1, 1]);
    const flat = apply({ contrast: 0 }, [0.9, 0.1, 0.4]);
    expect(flat[0]).toBeCloseTo(0.5, 6);
    expect(flat[1]).toBeCloseTo(0.5, 6);
    expect(flat[2]).toBeCloseTo(0.5, 6);
  });

  it('leaves grey alone under hue and saturation', () => {
    const out = apply({ hue: 90, saturation: 2 }, [0.5, 0.5, 0.5]);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(0.5, 6);
  });
});

describe('tone: brightness, black point, gamma', () => {
  it('a black point presses the darks down and leaves white alone', () => {
    const out = apply({ blackPoint: 0.2 }, [0.2, 0.6, 1]);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(1, 6);
    expect(apply({ blackPoint: 0.2 }, [0.1, 0.1, 0.1])[0]).toBe(0);
  });

  it('gamma moves the mid-tones and keeps black and white', () => {
    const lifted = apply({ gamma: 2 }, [0, 0.25, 1]);
    expect(lifted[0]).toBe(0);
    expect(lifted[1]).toBeCloseTo(0.5, 6);
    expect(lifted[2]).toBeCloseTo(1, 6);
    expect(apply({ gamma: 0.5 }, [0.5, 0.5, 0.5])[0]).toBeCloseTo(0.25, 6);
  });

  it('brightness is a multiplier, clamped at white', () => {
    const out = apply({ brightness: 1.5 }, [0.2, 0.5, 0.8]);
    expect(out[0]).toBeCloseTo(0.3, 6);
    expect(out[1]).toBeCloseTo(0.75, 6);
    expect(out[2]).toBe(1);
  });

  it('all at their neutral values prepares nothing', () => {
    expect(
      buildColorTweak({ brightness: 1, blackPoint: 0, gamma: 1 })
    ).toBeNull();
    expect(buildColorTweak({ blackPoint: 0.1 })).not.toBeNull();
  });
});

describe('luminosity noise map', () => {
  it('is the identity by default', () => {
    expect(remapLuminance(0.3)).toBeCloseTo(0.3, 9);
  });

  it('stretches the range between the black and white points', () => {
    expect(remapLuminance(0.2, 0.2, 0.6)).toBe(0);
    expect(remapLuminance(0.4, 0.2, 0.6)).toBeCloseTo(0.5, 9);
    expect(remapLuminance(0.6, 0.2, 0.6)).toBe(1);
    expect(remapLuminance(0.9, 0.2, 0.6)).toBe(1);
    expect(remapLuminance(0.1, 0.2, 0.6)).toBe(0);
  });

  it('a collapsed range is a threshold', () => {
    expect(remapLuminance(0.49, 0.5, 0.5)).toBe(0);
    expect(remapLuminance(0.5, 0.5, 0.5)).toBe(1);
    expect(remapLuminance(0.7, 0.8, 0.2)).toBe(0);
    expect(remapLuminance(0.9, 0.8, 0.2)).toBe(1);
  });
});
