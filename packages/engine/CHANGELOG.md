# @particle-tools/engine

## Unreleased

- `initAssets` takes an `onProgress(done, total)` (the studio's loading bar).
- Fix: `fieldAt` answers a component of a compound field (`position.x` of a vec3, `.min` of a value, a bezier point) with the field itself; such paths used to name no field, so a front end applying changes by the field's level dropped them. jest +1 (24).
- schema: `noise.direction.x / y / z` — per world axis the curl field pushes both ways (default) or only towards + / −. The library folds that component of the displacement onto the chosen side (|flow| × sign): a vec3 uniform in the GPU kernel (live, no rebuild), the same fold on the CPU port; legacy (non-curl) noise is untouched. Only a one-way axis is written into a saved piece.
- schema: `renderer.points.velocityStretch` (seconds of travel; a `Points` group shown for POINTS and INSTANCED). The library stretches each sprite on screen along its heading by speed × seconds, head on the particle: the kernel's travel direction and speed (the same ones the MESH stretch reads), the instanced billboard's vertex stage, and POINTS promoted to that billboard while the stretch is on (a point primitive cannot be stretched; same pixel size). GPU compute only; sprite rotation and sheet animation are off on a stretched sprite.

## 0.1.0 — 2026-09-17

The engine as a package of its own (V2 plan §6 M4). Everything here was written inside `packages/editor` between 2026-09-11 and 2026-09-17 and moved on this day; the per-feature history is in `packages/editor/CLAUDE.md`.

- Boundary: `engine-boundary.json` + `scripts/check-engine-boundary.mjs` (engine modules import only the engine and three / @newkrok; player.ts's graph stays inside; the studio imports only listed modules).
- Injection instead of DOM lookups: `setViewportInsets`, `setStatsContainer` (world.ts), `notify.ts`; document change events (`document-events.ts`) from the gizmos, the scene and the probe bake.
- `schema.ts`: the parameter table with three change levels, `documentDefaults()`; covered by jest and by the front ends' harnesses.
- `presets/`: the pieces and their assets, synced into a front end's public folder by `scripts/sync-presets.mjs`; `presets.ts` lists them; `saved-configs.ts` reads and writes the browser's saved pieces.
- The preview is a window (edges resize, the inside moves, position remembered); the colour-source debug plane sits in the depth of the space; the emitter shape helper is blue-violet with an arrow and a tag; wall helpers no longer tint the view; the ground grid a notch brighter.
- The curve and gradient editors ask a preset's name through `setPresetPrompts` (default: the browser's prompt).
- Fixes found on the way: COPY dropped a wall's `touchCap` / `maxSpeed`; the standalone player embedded a URL video's thumbnail as an image; four stray keys under `_editorData.terrain` on every new document.
