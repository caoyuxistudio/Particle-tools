// The pieces that ship with the engine (V2-ARCHITECTURE.md §6 M4: presets
// travel with the engine): each is public/examples/<slug>/config.json with a
// preview.webp beside it. V1's examples-config.js re-exports these.

export type ExampleEntry = { name: string };

/** The pieces the Examples panel lists, in order. */
// WIP-Test (the early test scene) was dropped on 2026-09-17: it crashed on load and nothing needs it.
export const examples: ExampleEntry[] = [{ name: 'example-1-1' }, { name: 'WIP-Test-2' }];

/** The piece an editor opens into. */
export const DEFAULT_EXAMPLE = 'example-1-1';

/** A piece's folder under public/examples: lower case, anything but letters and digits a hyphen. */
export const exampleSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const exampleConfigUrl = (name: string): string => `./examples/${exampleSlug(name)}/config.json`;
export const examplePreviewUrl = (name: string): string => `./examples/${exampleSlug(name)}/preview.webp`;
