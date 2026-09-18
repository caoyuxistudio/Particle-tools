# particle-tools-studio

## Unreleased — 2026-09-18

- The v2 branch is merged into `main`; the studio is now the only editor under development (V1 is history). `deploy.yml` builds V1 and the studio from the same checkout.
- Fix: a piece saved in this browser could not be loaded back — the saved list was a deep `$state` proxy and `structuredClone` threw `DataCloneError`; the list is `$state.raw` now and a failed load says so. Harness +2 (55).
- Fix: editing one axis of a vec3 (a collision plane's position or normal, a force field's position, noise drift, the colour source's offset, the transform) never reached the engine — the component path named no field, so `applyChange` answered `none`; a plane only moved once toggling it re-sent the list. Fixed in the engine's `fieldAt`. Harness +1 (56).
- Noise: `direction x / y / z` (BOTH / POSITIVE / NEGATIVE) under the curl noise group, rendered from the schema; live. Harness +2 (58).
- Fix: the number beside a vec3 / colour / min–max slider did not follow a drag (noise drift, influence, …) — the value is written one component at a time into the same object, and a `$derived` that returns the same object is unchanged; FieldView now derives a shallow copy per revision.
- Points group (POINTS and INSTANCED): `velocity stretch (s of travel)` — sprites become streaks along their travel. Harness +5 (63).
- Scene → camera: a `feedback (trails)` group — enabled, mode (lighter / mix / over), persistence (s), amount — and a `Trail layer only` view. Harness +4 (67).
- `Emitter Source Image Tweak` (was Source Image Tweak): black point, gamma and brightness under level; saturation up to 5.
- Scene → camera: a `post effect` group after feedback — saturation, brightness, contrast, hue, level (black / white / gamma), and a reset. Harness +8 (75); the preview drag checks start from a small preview instead of whatever size the last session left.
- Fix: number fields clipped their last digit behind the spin buttons — maxParticles 500000 read as "50000", rateOverTime 100000 as "10000", −120.411 as "−120." — which looked like caps ten times lower. Spin buttons off, fields a little wider (inspector and scene panel). Harness +1 (76).

## Unreleased

- Loading bar: `#boot-loader` inline in `index.html` (up with the first paint, before the bundle), driven by the boot marks through `BootOptions.onBootPhase` → `app/boot-progress.ts`; follows the built-in textures one by one (`initAssets` gained `onProgress` in the engine); fills and fades on the first frame. Harness +2 (53).

## 0.1.0 — 2026-09-17

Particle Tools Studio: V2 of the editor over the same engine and the same document, live at `/Studio/` beside V1.

- Shell: Vite 8 + Svelte 5, no component library; one monospace face, greys, 1px lines (`ui/tokens.css`, `reset.css`).
- `engine/session.ts` boots the engine into the piece (example-1-1), applies each change at the cost the schema names (updateConfig or a throttled rebuild), runs the frame loop, installs the Perf / Gyro HUDs, presentation mode and touch input.
- `store/document.svelte.ts`: the single truth; engine events bump its revision.
- Inspector rendered from the schema with native controls; V1's Scene panel ported; pieces (examples + saved in this browser) and textures (colour sources) tabs.
- The three canvas editors (curve, gradient, texture selector) in pre-embedded DOM styled by tokens; curves and gradients apply on demand; presets named inline.
- Furniture follows the document: collision-plane, force-field, shape and axes helpers, the colour-source plane; scene objects wear edge wires, a camera body, lamps and a sun aim; a furniture toolbar and reset view; the 45° home view at boot.
- Phone layout under 760px; HUDs in tokens with close buttons.
- Harness `__st.report()` (dev only): 51 checks including both §2.1 round trips.
