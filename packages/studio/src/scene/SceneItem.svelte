<!-- Ported from V1 packages/editor/src/components/content/scene/scene-item.svelte (2026-09-17): same markup and logic, tokens instead of SMUI and inline colours. -->
<script>
  import {
    CORNER_PRESETS,
    squareCorners,
    defaultLightShadowSettings,
  } from '@engine/scene-objects';
  import { glyph } from './glyph';
  import * as THREE from 'three';
  import {
    getCamera,
    defaultSsrSettings,
    defaultAoSettings,
    defaultEnvironmentSettings,
    setOnEnvironmentLoaded,
  } from '@engine/world';
  import { onMount } from 'svelte';
  import { defaultParallaxSettings } from '@engine/parallax';

  let { obj, update, remove, bake, selected = false, select, contextMenu } = $props();

  let open = $state(false);
  let baking = $state(false);

  const set = (patch) => update(obj.id, patch);

  // ── Frame corners ─────────────────────────────────────────────────────────
  const corners = (o) => o.cornerRadius ?? squareCorners();
  const uniformCorners = (r) => ({ topLeft: r, topRight: r, bottomLeft: r, bottomRight: r });
  const setCorners = (patch) => set({ cornerRadius: { ...corners(obj), ...patch } });
  const cornerMax = (o) => Math.max(...Object.values(corners(o)));
  const cornerLimit = (o) => +(Math.min(o.innerWidth ?? 6, o.innerHeight ?? 3.5) / 2).toFixed(2);
  const cornerPresetActive = (p) => {
    const r = p.ratio * (obj.innerWidth ?? 6);
    return Object.values(corners(obj)).every((v) => Math.abs(v - r) < 0.005);
  };

  /**
   * Reflection settings live on the camera, so they patch like anything else —
   * but always onto a complete set. Storing only the keys that were touched
   * would leave the rest reading from whatever the defaults happen to be later,
   * so an old camera's look would drift when those change.
   */
  const setSsr = (patch) => set({ ssr: { ...defaultSsrSettings(), ...(obj.ssr ?? {}), ...patch } });
  const setAo = (patch) => set({ ao: { ...defaultAoSettings(), ...(obj.ao ?? {}), ...patch } });
  const setShadow = (patch) =>
    set({ shadow: { ...defaultLightShadowSettings(), ...(obj.shadow ?? {}), ...patch } });
  const setParallax = (patch) =>
    set({ parallax: { ...defaultParallaxSettings(), ...(obj.parallax ?? {}), ...patch } });

  const SSR_VIEWS = [
    { id: 'off', label: 'Final image' },
    { id: 'reflection', label: 'Reflections only' },
    { id: 'ao', label: 'Occlusion only' },
    { id: 'color', label: 'Colour buffer' },
    { id: 'normal', label: 'Normals' },
    { id: 'metalness', label: 'Metalness' },
    { id: 'roughness', label: 'Roughness' },
    { id: 'depth', label: 'Depth' },
  ];

  /** Snaps this camera onto the viewport's current position and lens. */
  const alignToView = () => {
    const view = getCamera();
    const euler = new THREE.Euler().setFromQuaternion(view.quaternion, 'XYZ');
    set({
      position: { x: view.position.x, y: view.position.y, z: view.position.z },
      rotation: {
        x: THREE.MathUtils.radToDeg(euler.x),
        y: THREE.MathUtils.radToDeg(euler.y),
        z: THREE.MathUtils.radToDeg(euler.z),
      },
      fov: view.fov,
    });
  };
  const setVec = (key, axis, value) => set({ [key]: { ...obj[key], [axis]: value } });

  const runBake = async () => {
    baking = true;
    try {
      await bake(obj.id);
    } finally {
      baking = false;
    }
  };

  const ICON = {
    BOX: 'view_in_ar',
    SPHERE: 'circle',
    POINT_LIGHT: 'lightbulb',
    DIRECTIONAL_LIGHT: 'wb_sunny',
    LIGHT_PROBE: 'blur_on',
    CAMERA: 'photo_camera',
    ENVIRONMENT: 'panorama_photosphere',
    FRAME: 'crop_din',
  };

  /** The five knobs a standard material exposes, reused for both frame slots. */
  const MATERIAL_ROWS = [
    { key: 'roughness', label: 'rough', min: 0, max: 1, step: 0.01, fallback: 0.6 },
    { key: 'metalness', label: 'metal', min: 0, max: 1, step: 0.01, fallback: 0.2 },
    { key: 'emissiveIntensity', label: 'glow', min: 0, max: 4, step: 0.01, fallback: 0 },
  ];

  let envFileInput;
  let envStatus = $state('');

  onMount(() => {
    setOnEnvironmentLoaded(
      (error) => (envStatus = error ? `Could not read that file: ${error}` : '')
    );
    return () => setOnEnvironmentLoaded(null);
  });

  const setEnv = (patch) =>
    set({ environment: { ...defaultEnvironmentSettings(), ...(obj.environment ?? {}), ...patch } });

  /** Radiance and OpenEXR are not image formats the browser can decode. */
  const formatOf = (name) => {
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'exr') return 'exr';
    if (ext === 'hdr' || ext === 'pic') return 'hdr';
    return 'ldr';
  };

  const readAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const onEnvFile = async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    envStatus = 'Reading…';
    try {
      const source = await readAsDataUrl(file);
      // High dynamic range panoramas are routinely tens of megabytes, well past
      // what localStorage holds. Loading one still works for the session; it is
      // only the saving that cannot, and saying so beats a silent loss.
      const megabytes = source.length / (1024 * 1024);
      setEnv({ source, format: formatOf(file.name), name: file.name });
      envStatus =
        megabytes > 4
          ? `${file.name} — ${megabytes.toFixed(1)}MB, too large to save; reload will clear it`
          : '';
    } catch {
      envStatus = 'Could not read that file';
    }
  };

  /**
   * Common output shapes, so an installation's frame is one click away.
   *
   * The phone entry is the whole screen in logical pixels (440×956 on an
   * iPhone 17 Pro Max), which is what a page opened from the Home Screen gets.
   * "Fit window" stores 0: the camera takes whatever shape the window it is
   * shown in has, so the player and presentation mode fill it with no bars —
   * at the price of a composition that changes with the screen.
   */
  const ASPECTS = [
    { label: '16:9', value: 16 / 9 },
    { label: '4:3', value: 4 / 3 },
    { label: '1:1', value: 1 },
    { label: '9:16', value: 9 / 16 },
    { label: '2:1', value: 2 },
    { label: 'iPhone 17 Pro Max', value: 440 / 956 },
    // The same phone as a Home Screen app: the page sits below the status bar.
    { label: 'iPhone 17 Pro Max · app', value: 440 / 894 },
    { label: 'Fit window', value: 0 },
  ];
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="item"
  class:hidden={!obj.visible}
  class:selected
  oncontextmenu={(e) => {
    e.preventDefault();
    contextMenu?.(obj.id, e.clientX, e.clientY);
  }}
>
  <div class="head">
    <button class="eye" title="Show / hide" onclick={() => set({ visible: !obj.visible })}>
      <span class="icon">{glyph(obj.visible ? 'visibility' : 'visibility_off')}</span>
    </button>
    {#if obj.type !== 'LIGHT_PROBE' && obj.type !== 'ENVIRONMENT'}
      <button
        class="pick"
        title={selected ? 'Hide drag axes' : 'Show drag axes in the viewport'}
        onclick={() => select(obj.id)}
      >
        <span class="icon">{glyph(selected ? 'gps_fixed' : 'gps_not_fixed')}</span>
      </button>
    {/if}
    <button class="title" onclick={() => (open = !open)}>
      <span class="icon type">{glyph(ICON[obj.type])}</span>
      <span class="name">{obj.name}</span>
      <span class="icon chevron">{glyph(open ? 'expand_less' : 'expand_more')}</span>
    </button>
    <button class="del" title="Delete" onclick={() => remove(obj.id)}>
      <span class="icon">{glyph('delete')}</span>
    </button>
  </div>

  {#if open}
    <div class="body">
      {#if obj.type !== 'ENVIRONMENT'}
        <div class="group-label">position</div>
        {#each ['x', 'y', 'z'] as axis}
          <label class="row">
            <span>{axis}</span>
            <input
              type="range"
              min="-20"
              max="20"
              step="0.05"
              value={obj.position[axis]}
              oninput={(e) => setVec('position', axis, +e.target.value)}
            />
            <input
              type="number"
              step="0.05"
              value={obj.position[axis]}
              oninput={(e) => setVec('position', axis, +e.target.value)}
            />
          </label>
        {/each}
      {/if}

      {#if obj.type === 'ENVIRONMENT'}
        <button class="wide" onclick={() => envFileInput.click()}>
          {obj.environment?.name ? 'Replace panorama' : 'Load panorama'}
        </button>
        <input
          style="display:none"
          type="file"
          accept=".jpg,.jpeg,.png,.webp,.hdr,.exr"
          bind:this={envFileInput}
          onchange={onEnvFile}
        />
        <p class="hint">
          {obj.environment?.name || 'Equirectangular JPEG, PNG, WebP, Radiance HDR or OpenEXR.'}
        </p>
        {#if envStatus}
          <p class="hint warn">{envStatus}</p>
        {/if}

        <div class="group-label">lighting</div>
        <label class="row">
          <span>intensity</span>
          <input
            type="range"
            min="0"
            max="5"
            step="0.05"
            value={obj.environment?.intensity ?? 1}
            oninput={(e) => setEnv({ intensity: +e.target.value })}
          />
          <input
            type="number"
            step="0.05"
            value={obj.environment?.intensity ?? 1}
            oninput={(e) => setEnv({ intensity: +e.target.value })}
          />
        </label>
        <label class="row">
          <span>rotation</span>
          <input
            type="range"
            min="0"
            max="360"
            step="1"
            value={obj.environment?.rotation ?? 0}
            oninput={(e) => setEnv({ rotation: +e.target.value })}
          />
          <input
            type="number"
            step="1"
            value={obj.environment?.rotation ?? 0}
            oninput={(e) => setEnv({ rotation: +e.target.value })}
          />
        </label>
        <label class="row">
          <span>blur</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={obj.environment?.blur ?? 0}
            oninput={(e) => setEnv({ blur: +e.target.value })}
          />
          <input
            type="number"
            step="0.01"
            value={obj.environment?.blur ?? 0}
            oninput={(e) => setEnv({ blur: +e.target.value })}
          />
        </label>

        <div class="group-label">show backdrop in</div>
        <label class="row check">
          <span>viewport</span>
          <input
            type="checkbox"
            checked={obj.environment?.showInViewport ?? true}
            onchange={(e) => setEnv({ showInViewport: e.target.checked })}
          />
        </label>
        <label class="row check">
          <span>camera</span>
          <input
            type="checkbox"
            checked={obj.environment?.showInCamera ?? true}
            onchange={(e) => setEnv({ showInCamera: e.target.checked })}
          />
        </label>
        <p class="hint">
          These hide the panorama from view only. It keeps lighting the scene and showing up in
          reflections either way — which is how you get the light without the backdrop.
        </p>
      {/if}

      {#if obj.type === 'FRAME'}
        <div class="group-label">opening</div>
        {#each [{ key: 'innerWidth', label: 'width', max: 30, fallback: 6 }, { key: 'innerHeight', label: 'height', max: 30, fallback: 3.5 }] as f}
          <label class="row">
            <span>{f.label}</span>
            <input
              type="range"
              min="0.1"
              max={f.max}
              step="0.05"
              value={obj[f.key] ?? f.fallback}
              oninput={(e) => set({ [f.key]: +e.target.value })}
            />
            <input
              type="number"
              step="0.05"
              value={obj[f.key] ?? f.fallback}
              oninput={(e) => set({ [f.key]: +e.target.value })}
            />
          </label>
        {/each}

        <div class="group-label">surround</div>
        {#each [{ key: 'border', label: 'thickness', max: 8, fallback: 0.6 }, { key: 'depth', label: 'depth', max: 8, fallback: 0.5 }] as f}
          <label class="row">
            <span>{f.label}</span>
            <input
              type="range"
              min="0.01"
              max={f.max}
              step="0.01"
              value={obj[f.key] ?? f.fallback}
              oninput={(e) => set({ [f.key]: +e.target.value })}
            />
            <input
              type="number"
              step="0.01"
              value={obj[f.key] ?? f.fallback}
              oninput={(e) => set({ [f.key]: +e.target.value })}
            />
          </label>
        {/each}
        <p class="hint">
          Outer size is the opening plus the surround on each side, so widening the border grows the
          frame rather than eating into the picture.
        </p>

        <div class="group-label">face material</div>
        <label class="row">
          <span>color</span>
          <input
            type="color"
            value={obj.color ?? '#d8d8d8'}
            oninput={(e) => set({ color: e.target.value })}
          />
        </label>
        {#each MATERIAL_ROWS as m}
          <label class="row">
            <span>{m.label}</span>
            <input
              type="range"
              min={m.min}
              max={m.max}
              step={m.step}
              value={obj[m.key] ?? m.fallback}
              oninput={(e) => set({ [m.key]: +e.target.value })}
            />
            <input
              type="number"
              step={m.step}
              value={obj[m.key] ?? m.fallback}
              oninput={(e) => set({ [m.key]: +e.target.value })}
            />
          </label>
        {/each}

        <div class="group-label">inner edge material</div>
        <label class="row">
          <span>color</span>
          <input
            type="color"
            value={obj.edgeColor ?? 'var(--fg-max)fff'}
            oninput={(e) => set({ edgeColor: e.target.value })}
          />
        </label>
        <label class="row check">
          <span>+ particles' colour (lighter)</span>
          <input
            type="checkbox"
            checked={obj.edgeTint?.fromParticles ?? false}
            onchange={(e) =>
              set({
                edgeTint: { amount: obj.edgeTint?.amount ?? 1, fromParticles: e.target.checked },
              })}
          />
        </label>
        <label class="row">
          <span>amount</span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.01"
            value={obj.edgeTint?.amount ?? 1}
            oninput={(e) =>
              set({
                edgeTint: {
                  fromParticles: obj.edgeTint?.fromParticles ?? false,
                  amount: +e.target.value,
                },
              })}
          />
          <input
            type="number"
            step="0.01"
            value={obj.edgeTint?.amount ?? 1}
            oninput={(e) =>
              set({
                edgeTint: {
                  fromParticles: obj.edgeTint?.fromParticles ?? false,
                  amount: +e.target.value,
                },
              })}
          />
        </label>
        {#each MATERIAL_ROWS as m}
          <label class="row">
            <span>{m.label}</span>
            <input
              type="range"
              min={m.min}
              max={m.max}
              step={m.step}
              value={obj['edge' + m.key[0].toUpperCase() + m.key.slice(1)] ??
                (m.key === 'roughness' ? 0.25 : m.key === 'metalness' ? 0.9 : 0)}
              oninput={(e) =>
                set({ ['edge' + m.key[0].toUpperCase() + m.key.slice(1)]: +e.target.value })}
            />
            <input
              type="number"
              step={m.step}
              value={obj['edge' + m.key[0].toUpperCase() + m.key.slice(1)] ??
                (m.key === 'roughness' ? 0.25 : m.key === 'metalness' ? 0.9 : 0)}
              oninput={(e) =>
                set({ ['edge' + m.key[0].toUpperCase() + m.key.slice(1)]: +e.target.value })}
            />
          </label>
        {/each}
        <p class="hint">
          Roughness stops at 1 — that is the whole range the shading model has, and it already lands
          on the blurriest reflection there is. For softer reflections use the camera's blur and
          resolution instead.
        </p>

        <div class="group-label">corners</div>
        <div class="chips">
          {#each CORNER_PRESETS as p}
            <button
              class:active={cornerPresetActive(p)}
              onclick={() => setCorners(uniformCorners(p.ratio * (obj.innerWidth ?? 6)))}
              >{p.label}</button
            >
          {/each}
          <button class:active={cornerMax(obj) === 0} onclick={() => setCorners(uniformCorners(0))}
            >square</button
          >
        </div>
        {#each [{ label: 'all corners', keys: ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] }, { label: 'top corners', keys: ['topLeft', 'topRight'] }, { label: 'bottom corners', keys: ['bottomLeft', 'bottomRight'] }] as g}
          <label class="row">
            <span>{g.label}</span>
            <input
              type="range"
              min="0"
              max={cornerLimit(obj)}
              step="0.01"
              value={corners(obj)[g.keys[0]]}
              oninput={(e) =>
                setCorners(Object.fromEntries(g.keys.map((k) => [k, +e.target.value])))}
            />
            <input
              type="number"
              step="0.01"
              value={corners(obj)[g.keys[0]]}
              oninput={(e) =>
                setCorners(Object.fromEntries(g.keys.map((k) => [k, +e.target.value])))}
            />
          </label>
        {/each}
        <label class="row">
          <span>top edge down</span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.01"
            value={obj.topOffset ?? 0}
            oninput={(e) => set({ topOffset: +e.target.value })}
          />
          <input
            type="number"
            step="0.01"
            value={obj.topOffset ?? 0}
            oninput={(e) => set({ topOffset: +e.target.value })}
          />
        </label>
        <label class="row">
          <span>bottom edge up</span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.01"
            value={obj.bottomOffset ?? 0}
            oninput={(e) => set({ bottomOffset: +e.target.value })}
          />
          <input
            type="number"
            step="0.01"
            value={obj.bottomOffset ?? 0}
            oninput={(e) => set({ bottomOffset: +e.target.value })}
          />
        </label>
        <label class="row">
          <span>smooth shading</span>
          <input
            type="checkbox"
            checked={obj.cornerSmooth ?? false}
            onchange={(e) => set({ cornerSmooth: e.target.checked })}
          />
        </label>
        <label class="row">
          <span>segments</span>
          <input
            type="range"
            min="2"
            max="64"
            step="2"
            value={obj.cornerSegments ?? 24}
            oninput={(e) => set({ cornerSegments: +e.target.value })}
          />
          <input
            type="number"
            step="2"
            value={obj.cornerSegments ?? 24}
            oninput={(e) => set({ cornerSegments: +e.target.value })}
          />
        </label>
        <p class="hint">
          The opening keeps its rectangle; a rounded corner is filled in with the face material, so
          whatever lies beyond the curve is covered. The presets are Apple's display corner radii as
          a share of the screen's width, applied to the opening's width — right when the opening
          stands for the screen. Segments is how many straight pieces draw each quarter curve;
          smooth shading blends the normals along the curve, so the wall reads as round under light
          and reflections even with few of them.
        </p>
      {/if}

      {#if obj.type === 'BOX' || obj.type === 'SPHERE' || obj.type === 'CAMERA' || obj.type === 'FRAME'}
        <div class="group-label">rotation (deg)</div>
        {#each ['x', 'y', 'z'] as axis}
          <label class="row">
            <span>{axis}</span>
            <input
              type="range"
              min="-180"
              max="180"
              step="1"
              value={obj.rotation?.[axis] ?? 0}
              oninput={(e) => setVec('rotation', axis, +e.target.value)}
            />
            <input
              type="number"
              step="1"
              value={obj.rotation?.[axis] ?? 0}
              oninput={(e) => setVec('rotation', axis, +e.target.value)}
            />
          </label>
        {/each}
      {/if}

      {#if obj.type === 'CAMERA'}
        <div class="group-label">lens</div>
        <label class="row">
          <span>fov</span>
          <input
            type="range"
            min="10"
            max="120"
            step="1"
            value={obj.fov ?? 45}
            oninput={(e) => set({ fov: +e.target.value })}
          />
          <input
            type="number"
            step="1"
            value={obj.fov ?? 45}
            oninput={(e) => set({ fov: +e.target.value })}
          />
        </label>
        <label class="row">
          <span>near</span>
          <input
            type="range"
            min="0.01"
            max="5"
            step="0.01"
            value={obj.near ?? 0.1}
            oninput={(e) => set({ near: +e.target.value })}
          />
          <input
            type="number"
            step="0.01"
            value={obj.near ?? 0.1}
            oninput={(e) => set({ near: +e.target.value })}
          />
        </label>
        <label class="row">
          <span>far</span>
          <input
            type="range"
            min="10"
            max="500"
            step="1"
            value={obj.far ?? 200}
            oninput={(e) => set({ far: +e.target.value })}
          />
          <input
            type="number"
            step="1"
            value={obj.far ?? 200}
            oninput={(e) => set({ far: +e.target.value })}
          />
        </label>

        <div class="group-label">output frame</div>
        <div class="chips">
          {#each ASPECTS as a}
            <button
              class:active={Math.abs((obj.aspect ?? 16 / 9) - a.value) < 0.001}
              onclick={() => set({ aspect: a.value })}>{a.label}</button
            >
          {/each}
        </div>

        <button class="wide" onclick={alignToView}> Align to current view </button>

        <div class="group-label">parallax (gyro)</div>
        <label class="row check">
          <span>enabled</span>
          <input
            type="checkbox"
            checked={obj.parallax?.enabled ?? false}
            onchange={(e) => setParallax({ enabled: e.target.checked })}
          />
        </label>

        {#if obj.parallax?.enabled}
          {#each [{ key: 'amount', label: 'amount', min: 0, max: 1, step: 0.01, fallback: 0.25 }, { key: 'maxOffset', label: 'max travel', min: 0, max: 10, step: 0.1, fallback: 4 }, { key: 'smoothing', label: 'smoothing', min: 0.01, max: 1, step: 0.01, fallback: 0.12 }, { key: 'recenter', label: 'auto recenter (s)', min: 0, max: 30, step: 0.5, fallback: 8 }, { key: 'planeDistance', label: 'plane', min: 0, max: 60, step: 0.5, fallback: 0 }] as p}
            <label class="row">
              <span>{p.label}</span>
              <input
                type="range"
                min={p.min}
                max={p.max}
                step={p.step}
                value={obj.parallax?.[p.key] ?? p.fallback}
                oninput={(e) => setParallax({ [p.key]: +e.target.value })}
              />
              <input
                type="number"
                step={p.step}
                value={obj.parallax?.[p.key] ?? p.fallback}
                oninput={(e) => setParallax({ [p.key]: +e.target.value })}
              />
            </label>
          {/each}
          <label class="row check">
            <span>invert x</span>
            <input
              type="checkbox"
              checked={obj.parallax?.invertX ?? false}
              onchange={(e) => setParallax({ invertX: e.target.checked })}
            />
          </label>
          <label class="row check">
            <span>invert y</span>
            <input
              type="checkbox"
              checked={obj.parallax?.invertY ?? false}
              onchange={(e) => setParallax({ invertY: e.target.checked })}
            />
          </label>
          <p class="hint">
            The screen as a window: tilting the phone moves the eye behind it, the frame's plane
            stays put and what lies deeper shifts. Amount is eye travel per degree of tilt, capped
            by max travel; auto recenter re-learns the resting tilt over that many seconds, so a new
            holding angle drifts back to centre (0 = only Reset camera recenters); plane is the
            distance held still (0 = the face of the first visible frame, so the opening stays fixed
            and its walls become the tunnel). On a desktop the mouse stands in for the gyroscope.
            iPhone asks for motion access the first time you present.
          </p>
        {/if}

        <div class="group-label">reflections (SSR)</div>
        <label class="row check">
          <span>enabled</span>
          <input
            type="checkbox"
            checked={obj.ssr?.enabled ?? false}
            onchange={(e) => setSsr({ enabled: e.target.checked })}
          />
        </label>

        {#if obj.ssr?.enabled}
          {#each [{ key: 'maxDistance', label: 'distance', min: 1, max: 60, step: 0.5, fallback: 20 }, { key: 'opacity', label: 'strength', min: 0, max: 1, step: 0.01, fallback: 1 }, { key: 'quality', label: 'quality', min: 0.1, max: 1, step: 0.05, fallback: 1 }, { key: 'thickness', label: 'thickness', min: 0.01, max: 1, step: 0.01, fallback: 0.15 }, { key: 'blurQuality', label: 'blur', min: 0, max: 8, step: 1, fallback: 2 }, { key: 'resolutionScale', label: 'resolution', min: 0.15, max: 1, step: 0.05, fallback: 1 }] as p}
            <label class="row">
              <span>{p.label}</span>
              <input
                type="range"
                min={p.min}
                max={p.max}
                step={p.step}
                value={obj.ssr?.[p.key] ?? p.fallback}
                oninput={(e) => setSsr({ [p.key]: +e.target.value })}
              />
              <input
                type="number"
                step={p.step}
                value={obj.ssr?.[p.key] ?? p.fallback}
                oninput={(e) => setSsr({ [p.key]: +e.target.value })}
              />
            </label>
          {/each}

          <p class="hint">
            Only surfaces with metalness above zero reflect, and only what is already on screen can
            appear in them. If a wall stays blank, check it in the Metalness view first.
          </p>
          <p class="hint">
            For softer reflections, lower the resolution before raising blur — it smears just as
            well and costs less rather than more. Blur widens the kernel, and its samples grow as
            the square.
          </p>
        {/if}

        <div class="group-label">occlusion (AO)</div>
        <label class="row check">
          <span>enabled</span>
          <input
            type="checkbox"
            checked={obj.ao?.enabled ?? false}
            onchange={(e) => setAo({ enabled: e.target.checked })}
          />
        </label>

        {#if obj.ao?.enabled}
          {#each [{ key: 'intensity', label: 'strength', min: 0, max: 1, step: 0.01, fallback: 0.7 }, { key: 'radius', label: 'radius', min: 0.05, max: 3, step: 0.05, fallback: 0.3 }, { key: 'samples', label: 'samples', min: 4, max: 32, step: 1, fallback: 8 }, { key: 'thickness', label: 'thickness', min: 0.05, max: 2, step: 0.05, fallback: 0.5 }, { key: 'scale', label: 'contrast', min: 0.5, max: 3, step: 0.1, fallback: 1.5 }, { key: 'resolutionScale', label: 'resolution', min: 0.25, max: 1, step: 0.05, fallback: 0.5 }, { key: 'denoise', label: 'denoise', min: 1, max: 8, step: 1, fallback: 4 }] as p}
            <label class="row">
              <span>{p.label}</span>
              <input
                type="range"
                min={p.min}
                max={p.max}
                step={p.step}
                value={obj.ao?.[p.key] ?? p.fallback}
                oninput={(e) => setAo({ [p.key]: +e.target.value })}
              />
              <input
                type="number"
                step={p.step}
                value={obj.ao?.[p.key] ?? p.fallback}
                oninput={(e) => setAo({ [p.key]: +e.target.value })}
              />
            </label>
          {/each}
          <p class="hint">
            Darkens wherever the depth buffer says something is close: the frame's inner corners,
            grains against each other. Radius is in world units, so a grain-sized radius shades
            contacts and a frame-sized one shades the cavity. It runs before the reflections, so
            they show it too. The noise pattern is fixed frame to frame; denoise blurs it out.
          </p>
        {/if}

        {#if obj.ssr?.enabled || obj.ao?.enabled}
          <label class="row">
            <span>view</span>
            <select
              value={obj.ssr?.debug ?? 'off'}
              onchange={(e) => setSsr({ debug: e.target.value })}
            >
              {#each SSR_VIEWS as v}
                <option value={v.id}>{v.label}</option>
              {/each}
            </select>
          </label>
        {/if}

        <p class="hint">
          The corner preview renders through the first visible camera. Hide this one to preview
          another. Drag the grip in its bottom-left corner to resize it.
        </p>
      {/if}

      {#if obj.type === 'BOX' || obj.type === 'SPHERE'}
        <div class="group-label">size</div>
        {#each ['x', 'y', 'z'] as axis}
          <label class="row">
            <span>{axis}</span>
            <input
              type="range"
              min="0.05"
              max="30"
              step="0.05"
              value={obj.size[axis]}
              oninput={(e) => setVec('size', axis, +e.target.value)}
            />
            <input
              type="number"
              step="0.05"
              value={obj.size[axis]}
              oninput={(e) => setVec('size', axis, +e.target.value)}
            />
          </label>
        {/each}

        <div class="group-label">material</div>
        <label class="row">
          <span>color</span>
          <input type="color" value={obj.color} oninput={(e) => set({ color: e.target.value })} />
        </label>
        <label class="row">
          <span>rough</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={obj.roughness}
            oninput={(e) => set({ roughness: +e.target.value })}
          />
          <input
            type="number"
            step="0.01"
            value={obj.roughness}
            oninput={(e) => set({ roughness: +e.target.value })}
          />
        </label>
        <label class="row">
          <span>metal</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={obj.metalness}
            oninput={(e) => set({ metalness: +e.target.value })}
          />
          <input
            type="number"
            step="0.01"
            value={obj.metalness}
            oninput={(e) => set({ metalness: +e.target.value })}
          />
        </label>
        <label class="row">
          <span>emis</span>
          <input
            type="color"
            value={obj.emissive}
            oninput={(e) => set({ emissive: e.target.value })}
          />
          <input
            type="number"
            step="0.1"
            min="0"
            value={obj.emissiveIntensity}
            oninput={(e) => set({ emissiveIntensity: +e.target.value })}
          />
        </label>
        <label class="row check">
          <input
            type="checkbox"
            checked={obj.insideOut}
            onchange={(e) => set({ insideOut: e.target.checked })}
          />
          <span>inside out (room)</span>
        </label>
      {/if}

      {#if obj.type === 'POINT_LIGHT' || obj.type === 'DIRECTIONAL_LIGHT'}
        <div class="group-label">light</div>
        <label class="row">
          <span>color</span>
          <input type="color" value={obj.color} oninput={(e) => set({ color: e.target.value })} />
        </label>
        <label class="row">
          <span>power</span>
          <input
            type="range"
            min="0"
            max={obj.type === 'POINT_LIGHT' ? 400 : 20}
            step="0.5"
            value={obj.intensity}
            oninput={(e) => set({ intensity: +e.target.value })}
          />
          <input
            type="number"
            step="0.5"
            value={obj.intensity}
            oninput={(e) => set({ intensity: +e.target.value })}
          />
        </label>
        {#if obj.type === 'DIRECTIONAL_LIGHT'}
          <div class="group-label">aims at</div>
          {#each ['x', 'y', 'z'] as axis}
            <label class="row">
              <span>{axis}</span>
              <input
                type="range"
                min="-20"
                max="20"
                step="0.1"
                value={obj.target?.[axis] ?? 0}
                oninput={(e) => setVec('target', axis, +e.target.value)}
              />
              <input
                type="number"
                step="0.1"
                value={obj.target?.[axis] ?? 0}
                oninput={(e) => setVec('target', axis, +e.target.value)}
              />
            </label>
          {/each}
          <div class="hint">
            A directional light points from its position to this target; rotating it has no effect.
          </div>

          <div class="group-label">shadow</div>
          <label class="row check">
            <span>casts</span>
            <input
              type="checkbox"
              checked={obj.shadow?.enabled ?? true}
              onchange={(e) => setShadow({ enabled: e.target.checked })}
            />
          </label>
          {#if obj.shadow?.enabled ?? true}
            {#each [{ key: 'radius', label: 'softness', min: 0, max: 8, step: 0.1, fallback: 1 }, { key: 'intensity', label: 'darkness', min: 0, max: 1, step: 0.01, fallback: 1 }, { key: 'normalBias', label: 'normal bias', min: 0, max: 0.2, step: 0.005, fallback: 0.02 }, { key: 'bias', label: 'depth bias', min: -0.005, max: 0.005, step: 0.0001, fallback: -0.0005 }] as p}
              <label class="row">
                <span>{p.label}</span>
                <input
                  type="range"
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  value={obj.shadow?.[p.key] ?? p.fallback}
                  oninput={(e) => setShadow({ [p.key]: +e.target.value })}
                />
                <input
                  type="number"
                  step={p.step}
                  value={obj.shadow?.[p.key] ?? p.fallback}
                  oninput={(e) => setShadow({ [p.key]: +e.target.value })}
                />
              </label>
            {/each}
            <label class="row">
              <span>map size</span>
              <select
                value={obj.shadow?.mapSize ?? 2048}
                onchange={(e) => setShadow({ mapSize: +e.target.value })}
              >
                {#each [512, 1024, 2048, 4096] as n}
                  <option value={n}>{n}</option>
                {/each}
              </select>
            </label>
            <p class="hint">
              Softness is the filter radius in shadow-map texels, so the same value reads sharper on
              a bigger map. If flat faces show a stepped moiré, raise the normal bias before
              touching the depth bias. Only directional lights cast; particles take part only as
              MESH.
            </p>
          {/if}
        {/if}
        {#if obj.type === 'POINT_LIGHT'}
          <label class="row">
            <span>decay</span>
            <input
              type="range"
              min="0"
              max="4"
              step="0.1"
              value={obj.decay}
              oninput={(e) => set({ decay: +e.target.value })}
            />
            <input
              type="number"
              step="0.1"
              value={obj.decay}
              oninput={(e) => set({ decay: +e.target.value })}
            />
          </label>
        {/if}
      {/if}

      {#if obj.type === 'LIGHT_PROBE'}
        <div class="group-label">probe</div>
        <label class="row">
          <span>power</span>
          <input
            type="range"
            min="0"
            max="6"
            step="0.05"
            value={obj.intensity}
            oninput={(e) => set({ intensity: +e.target.value })}
          />
          <input
            type="number"
            step="0.05"
            value={obj.intensity}
            oninput={(e) => set({ intensity: +e.target.value })}
          />
        </label>
        <label class="row">
          <span>cap. h</span>
          <input
            type="range"
            min="0"
            max="15"
            step="0.1"
            value={obj.captureHeight}
            oninput={(e) => set({ captureHeight: +e.target.value })}
          />
          <input
            type="number"
            step="0.1"
            value={obj.captureHeight}
            oninput={(e) => set({ captureHeight: +e.target.value })}
          />
        </label>
        <label class="row check">
          <input
            type="checkbox"
            checked={obj.includeParticles}
            onchange={(e) => set({ includeParticles: e.target.checked })}
          />
          <span>include particles</span>
        </label>
        <button class="bake" onclick={runBake} disabled={baking}>
          {baking ? 'Baking…' : 'Bake environment'}
        </button>
        <div class="hint">
          A probe is a single average of the surroundings — it has no notion of position or
          occlusion, so it tints every surface equally. Re-bake after changing lights, colours or
          the emitter.
        </div>
      {/if}
    </div>
  {/if}
</div>

<style lang="scss">
  .item {
    border: 1px solid var(--line);
    border-radius: 0;
    margin: 8px 12px;
    background: rgba(255, 255, 255, 0.02);

    &.hidden {
      opacity: 0.45;
    }
    &.selected {
      border-color: var(--fg-strong);
    }
  }

  .head {
    display: flex;
    align-items: center;

    button {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 6px 6px;
      height: auto;
      display: flex;
      align-items: center;
      font: inherit;
    }

    .title {
      flex: 1;
      gap: 6px;
      min-width: 0;
      .name {
        flex: 1;
        text-align: left;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--fs-3);
      }
    }

    .icon {
      font-size: 17px;
    }
    :global(.type) {
      opacity: 0.75;
    }
    :global(.chevron) {
      opacity: 0.5;
    }
    .del:hover {
      color: var(--fg-max);
    }
    .pick {
      opacity: 0.7;
      &:hover {
        opacity: 1;
      }
    }
  }

  .body {
    padding: 4px 10px 12px;
    border-top: 1px solid var(--line);
  }

  .group-label {
    font-size: var(--fs-1);
    text-transform: uppercase;
    letter-spacing: 0.6px;
    opacity: 0.5;
    margin: 10px 0 4px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;

    span {
      width: 42px;
      font-size: var(--fs-2);
      opacity: 0.75;
    }
    input[type='range'] {
      flex: 1;
      min-width: 0;
    }
    input[type='number'] {
      width: 58px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--line);
      border-radius: 0;
      color: inherit;
      font-size: var(--fs-2);
      padding: 2px 4px;
    }
    input[type='color'] {
      width: 34px;
      height: 22px;
      padding: 0;
      background: none;
      border: 1px solid var(--line);
      border-radius: 0;
    }
    &.check {
      span {
        width: auto;
      }
    }
  }

  .bake {
    width: 100%;
    height: auto;
    margin-top: 8px;
    padding: 6px;
    background: var(--fg-strong);
    color: var(--fg-max);
    border: none;
    border-radius: 0;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-3);

    &:disabled {
      opacity: 0.6;
      cursor: default;
    }
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 2px 0 4px;

    button {
      flex: 1 1 auto;
      padding: 4px 0;
      background: var(--panel-2);
      color: var(--fg-dim);
      border: 1px solid var(--line);
      border-radius: 0;
      cursor: pointer;
      font: inherit;
      font-size: var(--fs-1);

      &.active {
        border-color: var(--fg-strong);
        color: var(--fg-strong);
      }
    }
  }

  select {
    flex: 1;
    min-width: 0;
    padding: 2px 4px;
    background: var(--panel-2);
    color: var(--fg-strong);
    border: 1px solid var(--line);
    border-radius: 0;
    font: inherit;
    font-size: var(--fs-2);
  }

  .wide {
    width: 100%;
    height: auto;
    margin-top: 8px;
    padding: 6px;
    background: var(--panel-2);
    color: var(--fg-strong);
    border: 1px solid var(--line);
    border-radius: 0;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-2);

    &:hover {
      border-color: var(--fg-strong);
    }
  }

  .hint.warn {
    color: var(--fg-strong);
    opacity: 0.95;
  }

  .hint {
    margin-top: 8px;
    font-size: var(--fs-1);
    line-height: 1.5;
    opacity: 0.55;
  }
</style>
