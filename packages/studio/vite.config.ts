import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The studio is a second front end over V1's engine (V2-ARCHITECTURE.md §1):
// the engine modules are imported in place from packages/editor, through the
// `@engine` alias, and only the modules in packages/editor/engine-boundary.json
// may be imported (the boundary script checks V1; the studio is checked by its
// own harness).
export default defineConfig(({ command }) => ({
  plugins: [svelte()],
  // Relative asset paths: the built studio works at any path — the site's root
  // or /studio/ beside V1 — the way V1's own index.html does.
  base: './',
  // In development V1's public folder is the studio's too: examples, assets,
  // videos, the built player — served at the root, exactly as V1 sees them, so
  // a config's `./assets/...` addresses resolve unchanged. A production build
  // copies only what a piece needs (scripts/copy-shared.mjs), not V1's bundles.
  publicDir: command === 'serve' ? here('../editor/public') : false,
  resolve: {
    alias: [
      { find: '@engine', replacement: here('../editor/src/js/three-particles-editor') },
      // V1's rollup does the same: bare `three` is the WebGPU build, so the
      // whole graph — engine, library, studio — shares one three.
      { find: /^three$/, replacement: 'three/webgpu' },
    ],
    dedupe: ['three'],
  },
  optimizeDeps: {
    // Pre-bundling would give the library its own copy of three.
    exclude: ['@newkrok/three-particles', '@newkrok/three-utils', 'three'],
  },
  server: {
    fs: { allow: [here('..')] },
  },
}));
