# Particle Tools

A modified fork of NewKrok's Three.js particle system and its visual editor,
extended for Cao Yuxi's (曹雨西) media-art installation work.

## Layout

```
packages/
  three-particles/   the particle library (fork of NewKrok/three-particles)
  editor/            the visual editor  (fork of NewKrok/three-particles-editor)
```

The editor depends on the library through `file:../three-particles`, so the two
always travel together — this is the reason they live in one repository.

## What this fork adds

Every item below is understood only by **this** library. A config saved here and
loaded by the stock `@newkrok/three-particles` does not error — the unknown keys
are merged in and never read, so the piece silently renders wrong.

| Feature | Config |
| --- | --- |
| Curl-noise flow field (spatially coherent motion) | `noise.curl` |
| Per-axis damping of the noise displacement | `noise.influence.{x,y,z}` |
| Start colour sampled from an image or video over the emitter's XZ, XY or YZ plane | `particleColorInstance`, `particleColorInstance.plane` |
| The source scaled about its centre, and tiled, mirrored, stretched or cut where it runs out | `particleColorInstance.scale`, `particleColorInstance.wrap` |
| Image brightness drives curl strength (signed, so dark or bright can be the moving half) | `particleColorInstance.useLuminanceForNoise`, `luminanceNoiseAmount` |
| Per-axis mesh scale | `renderer.mesh.scale` |
| Mesh oriented along its direction of travel | `renderer.mesh.alignToVelocity` |
| Mesh stretched along its direction of travel by the distance covered in N seconds (a motion-blur streak, speed taken from the actual displacement so noise-driven motion counts) | `renderer.mesh.velocityStretch` |
| Collision planes applied after every modifier, against the frame's real motion; BOUNCE mirrors the position and stores the reflection relative to the flow, fading back over `recover` seconds | `collisionPlanes[].recover` |
| Trail ribbons built on the GPU: the compute kernel records a per-particle history ring, the vertex stage expands it (smoothing, age fade, curves, roll); a trail piece runs the GPU simulation | `renderer.rendererType: 'TRAIL'` with WebGPU |

All of the above run on the **WebGPU compute backend**. On the CPU backend
(the TRAIL renderer, `simulationBackend: CPU`, or the WebGL fallback) the
curl-noise flow field is the same field — `curl-noise.ts` is a scalar port of
the kernel's simplex and curl — and the rest is ignored or falls back to the
stock behaviour.

## Running the editor

```bash
cd packages/three-particles && npm install && npm run build
cd ../editor && npm install && npm run dev
```

The editor serves on <http://localhost:8080>. `npm run dev` rebuilds on change
but does not reload the page — refresh manually.

## A config is not a self-contained artwork

Reproducing a piece needs four things, only one of which lives in the JSON:

1. this fork of the library,
2. a WebGPU context (`enableWebGPU` from `@newkrok/three-particles/webgpu`),
3. the texture images — the config stores only a texture *name*; the pixels sit
   in the editor's `localStorage`,
4. `renderer.mesh.geometry` — a THREE object the editor builds from the
   editor-only `geometryType` field.

## Upstream

- Library — <https://github.com/NewKrok/three-particles>
- Editor — <https://github.com/NewKrok/three-particles-editor>

Both are MIT licensed by Istvan Krisztian Somoracz; the original licence is kept
in `packages/three-particles/LICENSE` and applies to this fork's derived work.
