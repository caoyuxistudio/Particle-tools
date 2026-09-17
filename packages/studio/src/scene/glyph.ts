// V1's Material icon names, as text glyphs (V2-ARCHITECTURE.md §4: one typeface, no icon font).
const GLYPHS: Record<string, string> = {
  visibility: '◉',
  visibility_off: '○',
  gps_fixed: '⊕',
  gps_not_fixed: '⊙',
  expand_less: '▴',
  expand_more: '▾',
  delete: '×',
  content_copy: '⧉',
  view_in_ar: '▣',
  circle: '●',
  crop_din: '▭',
  lightbulb: '✦',
  wb_sunny: '☼',
  blur_on: '◌',
  photo_camera: '▤',
  panorama_photosphere: '◐',
  open_with: '✥',
  rotate_right: '↻',
  aspect_ratio: '⤢',
  videocam: '▶',
  videocam_off: '▷',
};

export const glyph = (name: string): string => GLYPHS[name] ?? name;
