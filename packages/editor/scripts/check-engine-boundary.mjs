#!/usr/bin/env node
/* global console, process */
// Checks the engine boundary declared in engine-boundary.json
// (V2-ARCHITECTURE.md §1): engine modules import only engine modules and the
// listed external packages, and every root's import graph stays inside the
// engine. Exits 1 with one line per violation.
//
//   node scripts/check-engine-boundary.mjs          # from packages/editor
//   node scripts/check-engine-boundary.mjs --list   # also print the engine set

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(pkgRoot, 'engine-boundary.json'), 'utf8'));
const toPosix = (p) => p.split(sep).join('/');
const rel = (abs) => toPosix(relative(pkgRoot, abs));

// --- the engine set -------------------------------------------------------

const engine = new Set();
for (const entry of spec.engine) {
  const abs = join(pkgRoot, entry);
  if (entry.endsWith('/')) {
    if (!existsSync(abs)) {
      console.error(`engine-boundary.json: missing directory ${entry}`);
      process.exit(2);
    }
    for (const f of readdirSync(abs)) {
      if (/\.(ts|js|mjs)$/.test(f) && !f.endsWith('.test.ts')) engine.add(rel(join(abs, f)));
    }
  } else {
    if (!existsSync(abs)) {
      console.error(`engine-boundary.json: missing file ${entry}`);
      process.exit(2);
    }
    engine.add(entry);
  }
}
const roots = spec.roots;
const externals = spec.externals;

// --- import parsing ---------------------------------------------------------

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

const importsOf = (relFile) => {
  const src = readFileSync(join(pkgRoot, relFile), 'utf8');
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
};

const resolveRelative = (fromRel, specifier) => {
  const base = resolve(pkgRoot, dirname(fromRel), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    `${base}.js`,
    `${base}.svelte`,
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return rel(c);
  }
  return null;
};

const packageOf = (specifier) => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

// --- rule 1: engine modules import only engine + externals -------------------

const violations = [];
for (const file of engine) {
  for (const s of importsOf(file)) {
    if (s.startsWith('.')) {
      const target = resolveRelative(file, s);
      if (target === null) violations.push(`${file}: cannot resolve '${s}'`);
      else if (!engine.has(target))
        violations.push(`${file}: imports '${s}' → ${target}, which is outside the engine`);
    } else if (!externals.includes(packageOf(s))) {
      violations.push(`${file}: imports package '${s}', not in externals`);
    }
  }
}

// --- rule 2: each root's import graph stays inside the engine ---------------

let reached = new Set();
for (const root of roots) {
  const seen = new Map([[root, null]]);
  const queue = [root];
  while (queue.length) {
    const file = queue.shift();
    for (const s of importsOf(file)) {
      if (!s.startsWith('.')) continue;
      const target = resolveRelative(file, s);
      if (target === null) {
        violations.push(`${file}: cannot resolve '${s}'`);
        continue;
      }
      if (seen.has(target)) continue;
      seen.set(target, file);
      if (engine.has(target)) queue.push(target);
      else {
        const chain = [];
        for (let f = file; f; f = seen.get(f)) chain.unshift(f);
        violations.push(`${root}: reaches ${target} (outside the engine) via ${chain.join(' → ')}`);
      }
    }
  }
  seen.delete(root);
  reached = new Set([...reached, ...seen.keys()]);
}

// --- report -----------------------------------------------------------------

if (process.argv.includes('--list')) {
  console.log('engine modules:');
  for (const f of [...engine].sort()) console.log(`  ${reached.has(f) ? '*' : ' '} ${f}`);
  console.log('  (* = reached from a root)');
}
console.log(
  `engine boundary: ${engine.size} modules, ${reached.size} reached from ${roots.join(', ')}, ${violations.length} violation${violations.length === 1 ? '' : 's'}`
);
for (const v of violations) console.log(`  ✗ ${v}`);
process.exit(violations.length ? 1 : 0);
