import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The studio is a second front end over V1's engine (V2-ARCHITECTURE.md §1):
// the engine modules are imported in place from packages/editor, through the
// `@engine` alias, and only the modules in packages/editor/engine-boundary.json
// may be imported (the boundary script checks V1; the studio is checked by its
// own harness).
export default defineConfig({
  plugins: [svelte()],
  // V1's public folder is the studio's too: examples, assets, videos, the
  // fonts — served at the root, exactly as V1 sees them, so a config's
  // `./assets/...` addresses resolve unchanged.
  publicDir: here('../editor/public'),
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
});
