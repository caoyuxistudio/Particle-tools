# particle-tools-studio

## Unreleased — 2026-09-18

- The v2 branch is merged into `main`; the studio is now the only editor under development (V1 is history). `deploy.yml` builds V1 and the studio from the same checkout.

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
