// After `vite build`: the pieces and their assets, shared with V1, go next to
// the studio's bundle so a config's `./assets/...` and `./examples/...`
// addresses resolve under the studio's own path.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
// The presets live with the engine; the favicon is V1's.
const presets = here('../../engine/presets/');
const from = here('../../editor/public/');
const to = here('../dist/');
mkdirSync(to, { recursive: true });
for (const [base, dir] of [[presets, 'assets'], [presets, 'examples'], [from, 'favicon']]) {
  if (!existsSync(base + dir)) continue;
  cpSync(base + dir, to + dir, { recursive: true });
  console.log(`copied ${dir}/`);
}
