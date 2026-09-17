#!/usr/bin/env node
/* global console, process */
// The presets — the pieces under presets/examples and the assets they use —
// live with the engine (V2-ARCHITECTURE.md §6 M4). A front end serves its
// public folder, so this copies them there before a dev server or a build:
//   node scripts/sync-presets.mjs            # into ../editor/public
//   node scripts/sync-presets.mjs <dir>      # into another public folder
// The copies are ignored by git; the presets folder is the source.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const presets = here('../presets/');
const target = process.argv[2] ? process.argv[2] : here('../../editor/public/');
mkdirSync(target, { recursive: true });

// assets/ whole; examples/ one folder per piece, beside whatever else is there.
rmSync(join(target, 'assets'), { recursive: true, force: true });
cpSync(join(presets, 'assets'), join(target, 'assets'), { recursive: true });
mkdirSync(join(target, 'examples'), { recursive: true });
for (const piece of readdirSync(join(presets, 'examples'))) {
  const src = join(presets, 'examples', piece);
  if (!existsSync(join(src, 'config.json'))) continue;
  rmSync(join(target, 'examples', piece), { recursive: true, force: true });
  cpSync(src, join(target, 'examples', piece), { recursive: true });
}
console.log(`presets synced into ${target}`);
