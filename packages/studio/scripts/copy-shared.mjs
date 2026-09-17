// After `vite build`: the pieces and their assets, shared with V1, go next to
// the studio's bundle so a config's `./assets/...` and `./examples/...`
// addresses resolve under the studio's own path.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const from = here('../../editor/public/');
const to = here('../dist/');
mkdirSync(to, { recursive: true });
for (const dir of ['assets', 'examples', 'favicon']) {
  if (!existsSync(from + dir)) continue;
  cpSync(from + dir, to + dir, { recursive: true });
  console.log(`copied ${dir}/`);
}
