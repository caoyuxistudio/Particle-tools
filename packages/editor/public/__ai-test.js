/**
 * Verification harness. Not part of the app — nothing imports it, and it ships
 * only so that a session can pick it up without being handed it. It is fetched
 * and eval'd from the console after a reload:
 *
 *   await fetch('/__ai-test.js').then(r=>r.text()).then(eval); __t.report()
 *
 * It exists so a change can be checked in two tool calls instead of twenty
 * clicks and screenshots.
 */
(() => {
  const FIXTURE = 'example-1-1';
  const KEY_SAVED = 'three-particles-saved-configs';
  const KEY_SCENE = 'particle-system-editor/scene-objects';

  const errs = [];
  addEventListener('error', (e) => errs.push('error: ' + e.message));
  addEventListener('unhandledrejection', (e) =>
    errs.push('rejection: ' + (e.reason?.message || e.reason))
  );

  /**
   * The fixture config, read from the example on disk.
   *
   * Examples are the editor's own durable storage: the app fetches them from
   * `public/examples/<name>/config.json` at load time, so unlike a saved config
   * they owe nothing to localStorage and survive a restart or a wiped profile.
   */
  const EXAMPLE_URL = './examples/example-1-1/config.json';
  let cached = null;

  const fixture = async () => {
    if (!cached) cached = await (await fetch(EXAMPLE_URL)).json();
    return structuredClone(cached);
  };

  /**
   * What scene-objects.ts currently holds. Reading localStorage rather than the
   * module: persist() writes on every change, so this is the same array that
   * serializeConfig would embed, and it needs no hook in the app.
   */
  const storedScene = () => JSON.parse(localStorage.getItem(KEY_SCENE) || '[]');

  /** Live THREE objects, to catch mounts that leak or never happen. */
  const live = () => {
    const scene = window.__world?.scene;
    if (!scene) return { error: 'no window.__world' };
    const c = { box: 0, sphere: 0, point: 0, dir: 0, probe: 0 };
    scene.children.forEach((o) => {
      if (o.isLightProbe) c.probe++;
      else if (o.isDirectionalLight) c.dir++;
      else if (o.isPointLight) c.point++;
      else if (o.isMesh && o.geometry?.type === 'BoxGeometry') c.box++;
      else if (o.isMesh && o.geometry?.type === 'SphereGeometry') c.sphere++;
    });
    const targets = new Set(scene.children.filter((o) => o.isDirectionalLight).map((l) => l.target));
    c.orphanTargets = scene.children.filter((o) => targets.has(o)).length - c.dir;
    return c;
  };

  const load = async () => {
    const cfg = await fixture();
    errs.length = 0;
    window.editor.load(cfg);
    return cfg;
  };

  /** Field-by-field diff, so a report names what drifted instead of "not equal". */
  const diff = (a, b, path = '', out = []) => {
    if (a === b) return out;
    const plain = (v) => v && typeof v === 'object';
    if (!plain(a) || !plain(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      return out;
    }
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach((k) => diff(a[k], b[k], path ? `${path}.${k}` : k, out));
    return out;
  };

  /**
   * Loads the fixture and checks it arrived intact. Everything here is an
   * invariant the fixture is built to exercise, so a regression anywhere in
   * save/load shows up as a named FAIL rather than a blank screen.
   */
  const report = async () => {
    // Read before the fixture replaces it: what the page booted into.
    const bootLine = (window.__perfHud?.report?.() ?? '').split('\n').find((l) => l.startsWith('boot:')) ?? '';
    // A new system starts at installation scale — the library's defaults are a
    // game effect's (100 particles, 10 a second). Read before the fixture load
    // below replaces it.
    window.editor.createNew();
    const fresh = window.editor.getCurrentParticleSystemConfig();
    const freshMax = fresh.maxParticles;
    const freshRate = fresh.emission?.rateOverTime;
    const freshTex = fresh._editorData?.colorInstanceTextureId;
    const cfg = await load();
    const want = cfg._editorData.sceneObjects;
    const got = storedScene();
    const l = live();
    const ed = window.editor.getCurrentParticleSystemConfig()._editorData;
    const mesh = window.editor.getCurrentParticleSystemConfig().renderer?.mesh;

    const lines = [];
    const check = (label, ok, detail = '') => lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    check('boots into example-1-1', bootLine.includes('default example-1-1 loaded'), bootLine.replace(/^boot: /, ''));
    // How the page comes up: fonts must not block the first paint, the
    // page is black before any stylesheet, and the boot goes piece → first
    // frame → panel with nothing built twice.
    const fontLinks = performance.getEntriesByType('resource').filter((e) => /fonts\.googleapis/.test(e.name));
    check('the font stylesheets do not block the first paint', fontLinks.length > 0 && fontLinks.every((e) => e.renderBlockingStatus === 'non-blocking'), fontLinks.map((e) => e.renderBlockingStatus).join(','));
    // Read through the CSSOM, not the attribute: once anything sets a custom
    // property on the root (fitPlayerCanvas does, for the viewport gaps) the
    // browser re-serialises the attribute and #000 comes back as rgb(0, 0, 0).
    check('the page is black before any stylesheet', document.documentElement.style.backgroundColor === 'rgb(0, 0, 0)', document.documentElement.style.backgroundColor);
    const timeline = (bootLine.split('timeline ')[1] || '').split(' → ').map((s) => s.split(' ')[0]);
    check('the boot loads the piece before it builds a panel', timeline.indexOf('example') >= 0 && timeline.indexOf('first-frame') > timeline.indexOf('example') && timeline.indexOf('panel') > timeline.indexOf('first-frame'), timeline.join(' → '));
    check('and compiles the shaders ahead of the first frame', timeline.indexOf('compiled') > timeline.indexOf('example') && timeline.indexOf('compiled') < timeline.indexOf('first-frame'), timeline.join(' → '));
    check('new system starts at 10000 particles', freshMax === 10000, `${freshMax}`);
    check('new system starts at 1000 a second', freshRate === 1000, `${freshRate}`);
    check('new system colours from the built-in picture', freshTex === 'DEFAULT_TEXTURE', `${freshTex}`);
    check('scene object count', got.length === want.length, `${got.length}/${want.length}`);
    // COPY keeps every wall setting the piece carries (touchCap / maxSpeed were dropped until 2026-09-17).
    const wallsBack = JSON.parse(window.editor.serialize()).collisionPlanes ?? [];
    check('COPY keeps the walls\' touchCap and maxSpeed', wallsBack.length === cfg.collisionPlanes.length && wallsBack.every((w, i) => w.touchCap === cfg.collisionPlanes[i].touchCap && w.maxSpeed === cfg.collisionPlanes[i].maxSpeed), JSON.stringify(wallsBack[0] ?? null));
    check('scene data identical', diff(want, got).length === 0, diff(want, got).slice(0, 4).join(' | '));
    check('live boxes', l.box === want.filter((o) => o.type === 'BOX').length, `${l.box}`);
    check('live spheres', l.sphere === want.filter((o) => o.type === 'SPHERE').length, `${l.sphere}`);
    check('live point lights', l.point === want.filter((o) => o.type === 'POINT_LIGHT').length, `${l.point}`);
    check('live probes', l.probe === want.filter((o) => o.type === 'LIGHT_PROBE').length, `${l.probe}`);
    check('no orphaned light targets', l.orphanTargets === 0, `${l.orphanTargets}`);
    check('sceneObjects stripped from live config', !('sceneObjects' in ed));
    check('mesh.lit preserved', mesh?.lit === cfg.renderer?.mesh?.lit, `${mesh?.lit}`);
    check('mesh.emissive preserved', mesh?.emissive === cfg.renderer?.mesh?.emissive, `${mesh?.emissive}`);

    const wantTex = cfg._editorData.colorInstanceTextureId;
    const gotTex = ed.colorInstanceTextureId;
    check('colour texture bound', !!gotTex, `${wantTex} -> ${gotTex}`);

    // Opacity over lifetime is its own section, right under Size, and the
    // gradient editor no longer reaches into it.
    // Top-level sections only: a section's own sub-folders have titles too.
    const titles = [...document.querySelectorAll('.lil-gui.root > .children > .lil-gui > .title')].map((t) => t.textContent.trim());
    const iSize = titles.indexOf('Size over lifetime');
    const iOpacity = titles.indexOf('Opacity over lifetime');
    check('opacity section sits under size', iSize >= 0 && iOpacity === iSize + 1, `${iSize} -> ${iOpacity}`);
    // The source's look sits right under the section that picks the source.
    const iSource = titles.indexOf('Particle Color Instance');
    const iTweak = titles.indexOf('Source Image Tweak');
    check('source image tweak sits under the colour source', iSource >= 0 && iTweak === iSource + 1, `${iSource} -> ${iTweak}`);
    const ciCfg = window.editor.getCurrentParticleSystemConfig().particleColorInstance;
    const fixCi = cfg.particleColorInstance ?? {};
    const tweakWant = { saturation: 1, contrast: 1, hue: 0, ...(fixCi.colorTweak ?? {}) };
    const mapWant = { black: 0, white: 1, ...(fixCi.luminanceMap ?? {}) };
    check('tweak and noise map come in from the piece, defaults filling the rest', JSON.stringify(ciCfg?.colorTweak) === JSON.stringify(tweakWant) && JSON.stringify(ciCfg?.luminanceMap) === JSON.stringify(mapWant), JSON.stringify({ tweak: ciCfg?.colorTweak, map: ciCfg?.luminanceMap }));
    const cfgLive = window.editor.getCurrentParticleSystemConfig();
    const gradientFolder = [...document.querySelectorAll('.lil-gui')].find((g) => g.querySelector(':scope > .title')?.textContent.trim() === 'Color over lifetime (Gradient)');
    const enableBox = gradientFolder?.querySelector('.controller input[type=checkbox]');
    check('gradient editor is colour only', !!gradientFolder && !!enableBox);
    if (enableBox) {
      const opacityBefore = cfgLive.opacityOverLifetime?.isActive;
      const colorBefore = cfgLive.colorOverLifetime?.isActive;
      enableBox.click();
      const colorToggled = cfgLive.colorOverLifetime?.isActive === !colorBefore;
      const opacityUntouched = cfgLive.opacityOverLifetime?.isActive === opacityBefore;
      enableBox.click();
      check('gradient toggle drives colour', colorToggled && cfgLive.colorOverLifetime?.isActive === colorBefore);
      check('gradient toggle leaves opacity alone', opacityUntouched);
    }

    // The panel's ranges: gravity ±1, max particles 1000–500000, rate over time
    // 1000–100000 — and the number inputs clamp typed values the same way, so
    // neither can be driven under 1000. The slider fill is (value − min) /
    // (max − min), which pins both ends given the fixture's values.
    const numberRow = (name) => [...document.querySelectorAll('.lil-gui .controller.number')].find((c) => c.querySelector('.name')?.textContent.trim() === name);
    const fillOf = (name) => parseFloat(numberRow(name)?.querySelector('.slider .fill')?.style.width ?? 'NaN');
    const typeInto = (name, text) => {
      const input = numberRow(name)?.querySelector('input');
      if (!input) return false;
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
      return true;
    };
    const span = (value, min, max) => ((value - min) / (max - min)) * 100;
    check('max particles slider spans 1000–500000', Math.abs(fillOf('maxParticles') - span(cfgLive.maxParticles, 1000, 500000)) < 0.05, `${fillOf('maxParticles')}%`);
    check('rate over time slider spans 1000–100000', Math.abs(fillOf('rateOverTime') - span(cfgLive.emission.rateOverTime, 1000, 100000)) < 0.05, `${fillOf('rateOverTime')}%`);
    const gravityBefore = cfgLive.gravity ?? 0;
    typeInto('gravity', '5');
    const gravityUp = cfgLive.gravity;
    typeInto('gravity', '-7');
    const gravityDown = cfgLive.gravity;
    typeInto('gravity', String(gravityBefore));
    check('gravity clamps to ±1', gravityUp === 1 && gravityDown === -1 && cfgLive.gravity === gravityBefore, `${gravityUp} / ${gravityDown}`);
    const rateBefore = cfgLive.emission.rateOverTime;
    typeInto('rateOverTime', '10');
    const rateLow = cfgLive.emission.rateOverTime;
    typeInto('rateOverTime', String(rateBefore));
    check('rate over time never drops below 1000', rateLow === 1000 && cfgLive.emission.rateOverTime === rateBefore, `${rateLow}`);
    const maxBefore = cfgLive.maxParticles;
    typeInto('maxParticles', '50');
    const maxLow = cfgLive.maxParticles;
    typeInto('maxParticles', String(maxBefore));
    check('max particles never drops below 1000', maxLow === 1000 && cfgLive.maxParticles === maxBefore, `${maxLow}`);

    // The first real example (2026-09-16; the piece since 2026-09-17): served
    // from disk, its colour source the site's own video named by URL — nothing
    // embedded, so the config is small and every device plays the same file —
    // and the Examples panel lists it with the two WIP tests and nothing else.
    // The built-in picture stays the colour source of a new system.
    const ex = await (await fetch('./examples/example-1-1/config.json')).json();
    const exVideoId = ex._editorData?.colorInstanceTextureId ?? '';
    const exVideo = ex._editorData?.embeddedVideos?.[exVideoId];
    check('example-1-1 names its video by URL and embeds no image', /^VideoTexture-/.test(exVideoId) && /^\.\/assets\/videos\//.test(exVideo?.url ?? '') && !ex._editorData?.embeddedTextures && ex._editorData?.metadata?.name === 'example-1-1', `${exVideoId} ${exVideo?.url}`);
    const picture = await createImageBitmap(await (await fetch('./assets/textures/default-texture.webp')).blob());
    check('default-texture.webp is the picture at full size', picture.width === 816 && picture.height === 1456, `${picture.width}×${picture.height}`);
    picture.close();
    window.editor.load(ex);
    const exLive = window.editor.getCurrentParticleSystemConfig();
    const exMap = exLive.particleColorInstance?.map;
    check('loading it binds the video, not an upload', exLive._editorData?.colorInstanceTextureId === exVideoId && !!window.__videoTextures?.get?.(exVideoId) && (exMap?.image?.tagName === 'VIDEO' || !!exMap?.isVideoTexture), `${exLive._editorData?.colorInstanceTextureId} ${exMap?.image?.tagName ?? exMap?.type}`);
    const tabs = [...document.querySelectorAll('[role=tab]')];
    const previousTab = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    tabs.find((t) => /examples/i.test(t.textContent))?.click();
    await new Promise((res) => setTimeout(res, 300));
    const savedNames = new Set(JSON.parse(localStorage.getItem(KEY_SAVED) || '[]').map((e) => e.name));
    const listed = [...document.querySelectorAll('.mdc-card h4')].map((h) => h.textContent.trim()).filter((n) => !savedNames.has(n));
    previousTab?.click();
    check('the examples panel lists the two and nothing else', JSON.stringify(listed) === JSON.stringify(['example-1-1', 'WIP-Test-2']), listed.join(', '));
    check('no runtime errors', errs.length === 0, errs.slice(0, 3).join(' | '));

    const failed = lines.filter((s) => s.startsWith('FAIL')).length;
    return [`${FIXTURE}: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * Which top-level objects the output camera can still see. The layer split is
   * the whole point of the preview, so it is checked by asking a layer-0 mask
   * rather than by trusting that every helper remembered to mark itself.
   */
  const layerSplit = () => {
    const scene = window.__world.scene;
    const artworkOnly = new window.__world.THREE.Layers();
    artworkOnly.set(0);
    const seen = [];
    const hidden = [];
    scene.children.forEach((o) => {
      const label = `${o.type}${o.material ? '/' + o.material.type : ''}`;
      (o.layers.test(artworkOnly) ? seen : hidden).push(label);
    });
    return { seen, hidden };
  };

  /** Camera-specific checks, run on top of report()'s fixture load. */
  const cameraReport = () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    const split = layerSplit();
    const leaked = split.seen.filter((l) => /Basic|Line|AxesHelper/.test(l));
    check('no editor furniture on the artwork layer', leaked.length === 0, leaked.join(','));
    check('furniture is actually marked', split.hidden.length >= 7, `${split.hidden.length} hidden`);
    check('editor camera sees everything', window.__world.camera.layers.mask === -1 >>> 0 || window.__world.camera.layers.mask === -1);

    const cams = storedScene().filter((o) => o.type === 'CAMERA');
    const active = window.__world.getOutputCamera();
    check('camera count', cams.length > 0, `${cams.length}`);
    if (cams.length) {
      const c = cams[0];
      check('camera has a lens', c.fov > 0 && c.near > 0 && c.far > c.near, `fov ${c.fov} near ${c.near} far ${c.far}`);
      check('camera has an aspect', !!c.aspect, `${(c.aspect || 0).toFixed(3)}`);
      check('camera has a rotation', !!c.rotation, JSON.stringify(c.rotation));
      check('output camera wired to world', !!active, active ? `fov ${active.fov}` : 'null');
      check('output camera only sees artwork', active ? active.layers.mask === 1 : false, active ? String(active.layers.mask) : '-');
      // The grip is drawn with canvas-relative coordinates but clicked with
    // window-relative ones. They differ by the toolbar's height, and when that
    // was unaccounted for the handle rendered in one place and responded in
    // another — invisible in a screenshot, so it gets an assertion.
    const canvas = window.__world.canvasBounds();
    const box = window.__world.previewRect();
    const gripX = box.x + 8;
    const gripY = box.y + box.h - 8;
    check('resize grip reacts where it is drawn', window.__world.overPreviewHandle(gripX, gripY));
    check(
      'grip hit test is in canvas space, not window space',
      canvas.top === 0 || !window.__world.overPreviewHandle(gripX + canvas.left, gripY + canvas.top),
      `canvas offset ${canvas.left},${canvas.top}`
    );
    // Reset Camera exists to rescue a lost view, so it has to land on the scene
    // rather than merely somewhere, and at the agreed three-quarter angle.
    (() => {
      const w = window.__world;
      const restore = { pos: w.camera.position.clone(), target: w.controls.target.clone() };
      w.camera.position.set(-1400, 900, 2200);
      w.controls.target.set(700, -400, -1100);
      w.controls.update();
      window.editor.resetCamera();

      const offset = w.camera.position.clone().sub(w.controls.target);
      const dist = offset.length();
      const elevation = w.THREE.MathUtils.radToDeg(Math.asin(offset.y / dist));
      const azimuth = w.THREE.MathUtils.radToDeg(Math.atan2(offset.x, offset.z));
      check('reset camera lands on the scene', w.controls.target.length() < 3, `target ${w.controls.target.toArray().map((n) => n.toFixed(1))}`);
      check('reset camera uses a 45/45 view', Math.abs(elevation - 45) < 1 && Math.abs(azimuth - 45) < 1, `${elevation.toFixed(0)}deg up, ${azimuth.toFixed(0)}deg around`);
      check('reset camera frames the scene', dist > 5 && dist < 200, `${dist.toFixed(0)} away`);

      w.camera.position.copy(restore.pos);
      w.controls.target.copy(restore.target);
      w.controls.update();
    })();

    // The engine never reads the panels' DOM (V2-ARCHITECTURE.md §1.2): the UI
    // injects how much of the canvas it covers, and the engine believes it.
    (() => {
      const w = window.__world;
      check('viewport insets are injected, not queried', typeof w.setViewportInsets === 'function');
      const previous = w.setViewportInsets(() => ({ left: 123, right: 456, top: 7 }));
      const injected = w.freeViewportBounds();
      check('the engine uses the injected insets', injected.left === 123 && injected.right === 456 && injected.top === 7, JSON.stringify(injected));
      w.setViewportInsets(previous);
      const restored = w.freeViewportBounds();
      const rightPanel = document.querySelector('.right-panel')?.getBoundingClientRect().left - w.canvasBounds().left;
      check('V1 injects its own panels', typeof previous === 'function' && Math.abs(restored.right - rightPanel) < 1, `${restored.right} vs panel at ${rightPanel}`);
    })();

    check('preview can take half the screen, or all the room between the panels', (() => {
      const before = window.__world.getPreviewScale();
      window.__world.setPreviewScale(1);
      const widest = window.__world.previewRect().w;
      window.__world.setPreviewScale(before);
      // A pane too narrow for half the screen between its panels still gives
      // the preview everything that is there (16px margins on each side).
      const free = window.__world.freeViewportBounds();
      const room = free.right - free.left - 32;
      return widest >= Math.min(window.innerWidth / 2, room) - 1;
    })());

    // Reflections are a property of the camera, not of the editor session — the
    // whole reason they kept vanishing on reload before.
    const shot = storedScene().find((o) => o.type === 'CAMERA');
    const live = window.__world.getSsrSettings();
    check('camera carries its own SSR settings', !!shot?.ssr, JSON.stringify(shot?.ssr ?? null));
    check('stored SSR settings are complete', shot?.ssr && Object.keys(shot.ssr).length === Object.keys(live).length, `${Object.keys(shot?.ssr ?? {}).length} of ${Object.keys(live).length} keys`);
    // Compared key by key: stringify would also fail on a difference of order,
    // which says nothing about whether the renderer got the right values.
    const sameSettings =
      shot?.ssr && Object.keys(live).every((k) => shot.ssr[k] === live[k]);
    check(
      'renderer uses the camera\'s settings',
      sameSettings,
      sameSettings ? '' : Object.keys(live).filter((k) => shot?.ssr?.[k] !== live[k]).join(',')
    );
    check('fixture ships with reflections on', live.enabled === true);
    // Occlusion rides on the camera the same way.
    const liveAo = window.__world.getAoSettings();
    check('camera carries its own AO settings', !!shot?.ao, JSON.stringify(shot?.ao ?? null));
    check('stored AO settings are complete', shot?.ao && Object.keys(shot.ao).length === Object.keys(liveAo).length, `${Object.keys(shot?.ao ?? {}).length} of ${Object.keys(liveAo).length} keys`);
    const sameAo = shot?.ao && Object.keys(liveAo).every((k) => shot.ao[k] === liveAo[k]);
    check(
      'renderer uses the camera\'s AO settings',
      sameAo,
      sameAo ? '' : Object.keys(liveAo).filter((k) => shot?.ao?.[k] !== liveAo[k]).join(',')
    );

    const frustums = window.__world.scene.children.filter((o) => o.type === 'CameraHelper');
      check('frustum helper present', frustums.length === cams.length, `${frustums.length}`);
      check(
        'frustum helper kept out of output',
        frustums.every((f) => !f.layers.test((() => { const l = new window.__world.THREE.Layers(); l.set(0); return l; })()))
      );
    }

    const failed = lines.filter((s) => s.startsWith('FAIL')).length;
    return [`camera: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * Environment checks, run against a panorama generated here rather than the
   * fixture's, so the test scene keeps whatever look it was saved with.
   */
  const environmentReport = async () => {
    const w = window.__world;
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    const before = w.getEnvironmentSettings();

    // A 2x1 panorama: blue above, black below. Small, but a real decode.
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 1;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3070ff';
    ctx.fillRect(0, 0, 2, 1);
    const source = c.toDataURL('image/png');

    await w.setEnvironment({ source, format: 'ldr' });
    check('panorama decodes and prefilters', w.hasEnvironmentTexture());
    check('scene receives the environment', !!w.scene.environment);

    // The two visibilities are the point. scene.background cannot be inspected
    // for this — it holds whichever pass ran last — so the decision is queried
    // per view instead.
    await w.setEnvironment({ showInViewport: false, showInCamera: false });
    check('lighting survives both backdrops hidden', !!w.scene.environment);
    check('no backdrop anywhere when both are off', !w.backdropFor('viewport').isTexture && !w.backdropFor('camera').isTexture);

    await w.setEnvironment({ showInViewport: true, showInCamera: false });
    check('viewport shows it while the camera does not', w.backdropFor('viewport').isTexture === true && !w.backdropFor('camera').isTexture);
    check('hiding the backdrop leaves the lighting alone', !!w.scene.environment);

    await w.setEnvironment({ showInViewport: false, showInCamera: true });
    check('camera shows it while the viewport does not', w.backdropFor('camera').isTexture === true && !w.backdropFor('viewport').isTexture);

    await w.setEnvironment({ intensity: 2.5 });
    check('intensity reaches the scene', w.scene.environmentIntensity === 2.5);
    await w.setEnvironment({ rotation: 90 });
    check('rotation reaches the scene', Math.abs(w.scene.environmentRotation.y - Math.PI / 2) < 1e-6);

    await w.setEnvironment({ source: null });
    check('clearing the panorama releases it', !w.hasEnvironmentTexture());

    await w.setEnvironment(before);
    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`environment: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /** Frame checks, on a frame built here rather than one saved in the fixture. */
  const frameReport = async () => {
    const w = window.__world;
    const T = w.THREE;
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    const build = async (patch, mutatePiece = null) => {
      const cfg = await fixture();
      if (mutatePiece) mutatePiece(cfg);
      // The fixture has a frame of its own now, and scene order would hand back
      // that one instead of the probe. Measure a scene with exactly one frame.
      cfg._editorData.sceneObjects = cfg._editorData.sceneObjects.filter((o) => o.type !== 'FRAME');
      cfg._editorData.sceneObjects.push({
        id: 'obj-frame-probe', type: 'FRAME', name: 'Frame probe', visible: true,
        position: { x: 0, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
        innerWidth: 6, innerHeight: 3.5, border: 0.6, depth: 0.5,
        color: '#d8d8d8', roughness: 0.6, metalness: 0.2,
        edgeColor: '#ffffff', edgeRoughness: 0.25, edgeMetalness: 0.9,
        ...patch,
      });
      window.editor.load(cfg);
      await new Promise((r) => setTimeout(r, 700));
      const mesh = w.scene.children.find((o) => o.isMesh && Array.isArray(o.material));
      const size = new T.Box3().setFromObject(mesh).getSize(new T.Vector3());
      return { mesh, size };
    };

    const base = await build({});
    check('frame builds one mesh with two material slots', base.mesh?.material?.length === 2);
    check('geometry groups match the slots', base.mesh?.geometry.groups.length === 2);
    // Outer size is the opening plus the surround on both sides: the whole point
    // of measuring a frame this way rather than by its outside.
    check('outer size is opening plus surround', Math.abs(base.size.x - 7.2) < 0.01 && Math.abs(base.size.y - 4.7) < 0.01, `${base.size.x.toFixed(2)}x${base.size.y.toFixed(2)}`);
    check('depth is honoured', Math.abs(base.size.z - 0.5) < 0.01, base.size.z.toFixed(2));
    check('face and edge materials are distinct', base.mesh.material[0].roughness !== base.mesh.material[1].roughness);

    // The inner edge lit by the picture: the particles' mean colour added to
    // the edge colour ("lighter"), every frame, scaled by amount. Every
    // particle the same known colour (no colour source, one start colour),
    // so the mean — and the sum — is exact; a dark base so it has room to
    // show. Needs frames: the tint is applied in the frame loop.
    const settleTint = () => new Promise((r) => setTimeout(r, 1800));
    const onePaint = (cfg) => {
      cfg.startColor = { min: { r: 0.5, g: 0.25, b: 0.125 }, max: { r: 0.5, g: 0.25, b: 0.125 } };
      cfg.particleColorInstance = { ...(cfg.particleColorInstance || {}), isActive: false };
    };
    const paint = new T.Color().setRGB(0.5, 0.25, 0.125, T.SRGBColorSpace); // linear
    const darkBase = new T.Color('#202020');
    const near = (c, want) => !!c && Math.abs(c.r - want.r) < 0.02 && Math.abs(c.g - want.g) < 0.02 && Math.abs(c.b - want.b) < 0.02;
    const tinted = await build({ edgeColor: '#202020', edgeTint: { fromParticles: true, amount: 1 } }, onePaint);
    await settleTint();
    const lit = tinted.mesh?.material[1].color;
    const wantFull = { r: Math.min(1, darkBase.r + paint.r), g: Math.min(1, darkBase.g + paint.g), b: Math.min(1, darkBase.b + paint.b) };
    check('the edge is its own colour plus the particles\' (lighter)', near(lit, wantFull), lit ? `edge ${lit.r.toFixed(3)},${lit.g.toFixed(3)},${lit.b.toFixed(3)} vs ${wantFull.r.toFixed(3)},${wantFull.g.toFixed(3)},${wantFull.b.toFixed(3)}` : 'no edge material');
    const half = await build({ edgeColor: '#202020', edgeTint: { fromParticles: true, amount: 0.5 } }, onePaint);
    await settleTint();
    const litHalf = half.mesh?.material[1].color;
    const wantHalf = { r: darkBase.r + paint.r * 0.5, g: darkBase.g + paint.g * 0.5, b: darkBase.b + paint.b * 0.5 };
    check('amount scales what is added', near(litHalf, wantHalf), litHalf ? `edge ${litHalf.r.toFixed(3)},${litHalf.g.toFixed(3)},${litHalf.b.toFixed(3)} vs ${wantHalf.r.toFixed(3)},${wantHalf.g.toFixed(3)},${wantHalf.b.toFixed(3)}` : 'no edge material');
    const plain = await build({ edgeColor: '#202020', edgeTint: { fromParticles: false, amount: 1 } }, onePaint);
    await settleTint();
    const unlit = plain.mesh?.material[1].color;
    check('off, the edge is its own colour', !!unlit && Math.abs(unlit.r - darkBase.r) < 1e-4 && Math.abs(unlit.g - darkBase.g) < 1e-4 && Math.abs(unlit.b - darkBase.b) < 1e-4, unlit ? `${unlit.r.toFixed(4)}` : 'no edge material');
    check('the tint travels in the config', JSON.parse(window.editor.serialize())._editorData.sceneObjects.find((o) => o.id === 'obj-frame-probe')?.edgeTint?.fromParticles === false);

    const wider = await build({ innerWidth: 12 });
    check('opening drives the geometry', Math.abs(wider.size.x - 13.2) < 0.01, wider.size.x.toFixed(2));
    const thicker = await build({ border: 2 });
    check('surround drives the geometry', Math.abs(thicker.size.x - 10) < 0.01, thicker.size.x.toFixed(2));
    const deeper = await build({ depth: 3 });
    check('depth drives the geometry', Math.abs(deeper.size.z - 3) < 0.01, deeper.size.z.toFixed(2));

    // Rounded corners: the opening keeps its rectangle and four fillets fill
    // the corners, as a child mesh in the frame's own face material with its
    // edge material on the walls.
    const rounded = await build({ cornerRadius: { topLeft: 0.5, topRight: 0.5, bottomLeft: 0.5, bottomRight: 0.5 } });
    const mask = rounded.mesh?.children.find((c) => c.name === 'frame-corners');
    check('rounded corners add a corner mask', !!mask && mask.visible && Array.isArray(mask.material) && mask.material.length === 2);
    if (mask) {
      // The geometry's own box: the frame sits at y=2 in the world.
      mask.geometry.computeBoundingBox();
      const box = mask.geometry.boundingBox;
      const inside = box.max.x <= 3 + 0.01 && box.min.x >= -3 - 0.01 && box.max.y <= 1.75 + 0.01 && box.min.y >= -1.75 - 0.01;
      check('the mask stays inside the opening', inside, `${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)} x ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}`);
      check('the mask fills the corners to the frame\'s depth', Math.abs(box.max.z - box.min.z - 0.5) < 0.01, (box.max.z - box.min.z).toFixed(2));
      check('the mask shares the face material', mask.material[0] === rounded.mesh.material[0]);
      check('the mask shares the edge material', mask.material[1] === rounded.mesh.material[1]);
      check('the frame itself is unchanged', Math.abs(rounded.size.x - 7.2) < 0.01 && Math.abs(rounded.size.y - 4.7) < 0.01);
    }
    const square = await build({});
    const noMask = square.mesh?.children.find((c) => c.name === 'frame-corners');
    check('square corners show no mask', !!noMask && noMask.visible === false);

    // The top edge brought down: the frame loses that much height at the top
    // only, and the top corners come down with it.
    const lowered = await build({ topOffset: 0.5, cornerRadius: { topLeft: 0.5, topRight: 0.5, bottomLeft: 0, bottomRight: 0 } });
    check('top edge down shortens the frame from the top', Math.abs(lowered.size.y - 4.2) < 0.01 && Math.abs(lowered.size.x - 7.2) < 0.01, `${lowered.size.x.toFixed(2)}x${lowered.size.y.toFixed(2)}`);
    const loweredMask = lowered.mesh?.children.find((c) => c.name === 'frame-corners');
    if (loweredMask) {
      loweredMask.geometry.computeBoundingBox();
      const b = loweredMask.geometry.boundingBox;
      check('the top corners ride on the lowered edge', Math.abs(b.max.y - (1.75 - 0.5)) < 0.01, b.max.y.toFixed(2));
    }
    // The bottom edge brought up: the same at the other end, bottom corners along.
    const raised = await build({ bottomOffset: 0.5, cornerRadius: { topLeft: 0, topRight: 0, bottomLeft: 0.5, bottomRight: 0.5 } });
    check('bottom edge up shortens the frame from the bottom', Math.abs(raised.size.y - 4.2) < 0.01 && Math.abs(raised.size.x - 7.2) < 0.01, `${raised.size.x.toFixed(2)}x${raised.size.y.toFixed(2)}`);
    const raisedMask = raised.mesh?.children.find((c) => c.name === 'frame-corners');
    if (raisedMask) {
      raisedMask.geometry.computeBoundingBox();
      const b = raisedMask.geometry.boundingBox;
      check('the bottom corners ride on the raised edge', Math.abs(b.min.y - (-1.75 + 0.5)) < 0.01 && b.max.y < 0, `${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)}`);
    }

    // "Top" is the screen's top. A frame lying flat under the fixture's
    // top-down camera has its local +y pointing down the screen, so the
    // offset and the top corners must land on the local -y edge there.
    const flat = await build({ rotation: { x: 90, y: 0, z: 0 }, topOffset: 0.5, cornerRadius: { topLeft: 0.5, topRight: 0.5, bottomLeft: 0, bottomRight: 0 } });
    flat.mesh.geometry.computeBoundingBox();
    const fb = flat.mesh.geometry.boundingBox;
    check('flat under a top-down camera, the offset takes the local -y edge', Math.abs(fb.min.y - (-2.35 + 0.5)) < 0.01 && Math.abs(fb.max.y - 2.35) < 0.01, `${fb.min.y.toFixed(2)}..${fb.max.y.toFixed(2)}`);
    const flatMask = flat.mesh?.children.find((c) => c.name === 'frame-corners');
    if (flatMask) {
      flatMask.geometry.computeBoundingBox();
      const mb = flatMask.geometry.boundingBox;
      check('and the top corners with it', Math.abs(mb.min.y - (-1.75 + 0.5)) < 0.01 && mb.max.y < 0, `${mb.min.y.toFixed(2)}..${mb.max.y.toFixed(2)}`);
    }

    // The curve's resolution and its shading are the frame's to set: more
    // segments make a rounder silhouette; smooth shading gives every wall
    // vertex on the arc the arc's own radial normal instead of its facet's.
    const round = { topLeft: 0.5, topRight: 0.5, bottomLeft: 0.5, bottomRight: 0.5 };
    const maskOf = (m) => m?.children.find((c) => c.name === 'frame-corners');
    const vertexCount = (m) => maskOf(m)?.geometry.getAttribute('position').count ?? 0;
    const coarse = await build({ cornerRadius: round, cornerSegments: 4 });
    const fine = await build({ cornerRadius: round, cornerSegments: 24 });
    check('corner segments drive the mask\'s resolution', vertexCount(fine.mesh) > vertexCount(coarse.mesh), `${vertexCount(coarse.mesh)} -> ${vertexCount(fine.mesh)}`);
    // How closely the wall normals on the top-right arc (centre 2.5, 1.25, r 0.5)
    // agree with the radial direction, tangent points excluded.
    const arcDots = (m) => {
      const g = maskOf(m)?.geometry;
      if (!g) return [];
      const p = g.getAttribute('position');
      const n = g.getAttribute('normal');
      const out = [];
      g.groups.filter((gr) => gr.materialIndex === 1).forEach((gr) => {
        for (let i = gr.start; i < gr.start + gr.count; i++) {
          const dx = 2.5 - p.getX(i);
          const dy = 1.25 - p.getY(i);
          const d = Math.hypot(dx, dy);
          if (Math.abs(d - 0.5) < 1e-4 && p.getX(i) > 2.5 && p.getY(i) > 1.25) out.push((n.getX(i) * dx + n.getY(i) * dy) / d);
        }
      });
      return out;
    };
    const flatDots = arcDots(coarse.mesh);
    check('flat corners shade by facet', flatDots.length > 0 && Math.min(...flatDots) < 0.99, `min dot ${Math.min(...flatDots).toFixed(3)} over ${flatDots.length}`);
    const smooth = await build({ cornerRadius: round, cornerSegments: 4, cornerSmooth: true });
    const smoothDots = arcDots(smooth.mesh);
    check('smooth corners shade by the curve', smoothDots.length > 0 && Math.min(...smoothDots) > 0.9999, `min dot ${Math.min(...smoothDots).toFixed(4)} over ${smoothDots.length}`);

    await load();
    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`frame: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };


  /**
   * Parallax: the screen as a window. Driven through the debug seam rather
   * than real sensors — the checks are about the geometry, which is the part
   * that would go wrong silently.
   */
  const parallaxReport = async () => {
    const w = window.__world;
    const T = w.THREE;
    const px = w.parallax;
    const lines = [];
    const check = (label, ok, detail = '') => lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    check('the parallax seam exists', !!px && typeof px.apply === 'function');
    if (!px) return ['parallax: 0/1 passed', ...lines].join('\n');

    const cfg = await load();
    const cam = w.getOutputCamera();
    const base = { enabled: true, amount: 0.05, maxOffset: 2, smoothing: 1, recenter: 0, planeDistance: 10, invertX: false, invertY: false };

    // Off: nothing touches the camera.
    px.reset();
    px.setSettings({ ...base, enabled: false });
    const p0 = cam.position.clone();
    // A fresh projection: the loop updates the camera's aspect between frames,
    // and in a hidden pane the matrix can lag it.
    cam.updateProjectionMatrix();
    const m0 = cam.projectionMatrix.clone();
    px.apply(cam)();
    check('disabled, the camera is left alone', cam.position.equals(p0) && cam.projectionMatrix.equals(m0));

    // The mouse: the desktop stand-in. Half way across the window is half the travel.
    px.reset();
    px.setSettings(base);
    px.feedPointer(0.5, 0);
    px.update(1);
    const s1 = px.state();
    check('the mouse moves the eye', s1.source === 'mouse' && Math.abs(s1.offset.x - 1) < 1e-6 && Math.abs(s1.offset.y) < 1e-6, `${s1.source} ${s1.offset.x.toFixed(3)}/${s1.offset.y.toFixed(3)}`);

    // The window: with the eye moved, a point on the held plane keeps its
    // place in the picture and a deeper one does not.
    cam.updateMatrixWorld(true);
    const world = (local) => local.clone().applyMatrix4(cam.matrixWorld);
    const onPlane = world(new T.Vector3(1, 0.5, -10));
    const deeper = world(new T.Vector3(1, 0.5, -20));
    const before = { plane: onPlane.clone().project(cam), deep: deeper.clone().project(cam) };
    const aspect0 = cam.aspect;
    const restore = px.apply(cam);
    const moved = cam.position.distanceTo(p0);
    const aspectDuring = cam.aspect;
    const during = { plane: onPlane.clone().project(cam), deep: deeper.clone().project(cam) };
    restore();
    check('the eye moved', Math.abs(moved - 1) < 1e-6, moved.toFixed(4));
    // setViewOffset rewrites the aspect from the full size it is given.
    check('the aspect is untouched', Math.abs(aspectDuring - aspect0) < 1e-9 && cam.aspect === aspect0, `${aspect0.toFixed(4)} -> ${aspectDuring.toFixed(4)} -> ${cam.aspect.toFixed(4)}`);
    check('a point on the plane keeps its place', during.plane.distanceTo(before.plane) < 1e-5, during.plane.distanceTo(before.plane).toExponential(2));
    check('a deeper point shifts', during.deep.distanceTo(before.deep) > 1e-3, during.deep.distanceTo(before.deep).toFixed(4));
    check('restore puts the camera back', cam.position.equals(p0) && cam.projectionMatrix.equals(m0));

    // The gyroscope: tilt from the resting pose moves the eye by amount per
    // degree — gamma up (right edge away) is eye -x — and the travel is capped.
    px.reset();
    px.setSettings(base);
    px.feedOrientation(60, 0);
    px.update(0.1);
    px.feedOrientation(60, 10);
    px.update(0.1);
    const g = px.state();
    check('the gyroscope moves the eye', g.source === 'gyro' && Math.abs(g.offset.x + 0.5) < 1e-6 && Math.abs(g.offset.y) < 1e-6, `${g.source} ${g.offset.x.toFixed(3)}/${g.offset.y.toFixed(3)} from rest ${g.rest?.x}/${g.rest?.y}`);
    px.feedOrientation(60, 80);
    px.update(0.1);
    const capped = px.state().offset;
    check('travel is capped', Math.abs(Math.hypot(capped.x, capped.y) - 2) < 1e-6, Math.hypot(capped.x, capped.y).toFixed(3));
    px.setSettings({ ...base, invertX: true });
    px.feedOrientation(60, 10);
    px.update(0.1);
    check('invert flips it', Math.abs(px.state().offset.x - 0.5) < 1e-6, px.state().offset.x.toFixed(3));

    // Smoothing: half the remaining way per 60 Hz frame.
    px.reset();
    px.setSettings({ ...base, smoothing: 0.5 });
    px.feedPointer(1, 0);
    px.update(1 / 60);
    check('smoothing eases the eye in', Math.abs(px.state().offset.x - 1) < 1e-6, px.state().offset.x.toFixed(3));

    // The plane held still defaults to the fixture's frame — its face toward
    // the camera, half the depth in front of its centre, measured along the view.
    px.setSettings({ ...base, planeDistance: 0 });
    const frame = cfg._editorData.sceneObjects.find((o) => o.type === 'FRAME');
    const forward = new T.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const centreDistance = new T.Vector3(frame.position.x, frame.position.y, frame.position.z).sub(cam.position).dot(forward);
    const rot = frame.rotation ?? { x: 0, y: 0, z: 0 };
    const normal = new T.Vector3(0, 0, 1).applyEuler(new T.Euler(T.MathUtils.degToRad(rot.x), T.MathUtils.degToRad(rot.y), T.MathUtils.degToRad(rot.z)));
    const expected = centreDistance - (Math.max(0.01, frame.depth ?? 0.5) / 2) * Math.abs(normal.dot(forward));
    check('the plane defaults to the frame\'s face', Math.abs(px.state().plane - expected) < 1e-3, `${px.state().plane.toFixed(3)} vs ${expected.toFixed(3)} (centre ${centreDistance.toFixed(3)})`);
    check('the face is nearer than the centre', expected < centreDistance - 1e-6, `${expected.toFixed(3)} < ${centreDistance.toFixed(3)}`);

    // The gyro panel: the levers on the phone, and the two resets.
    const gh = window.__gyroHud;
    check('the gyro panel exists', !!gh && typeof gh.toggle === 'function');
    if (gh) {
      gh.show();
      const panel = document.querySelector('.gyro-hud');
      const labels = [...(panel?.querySelectorAll('.gyro-hud__label') ?? [])].map((e) => e.textContent.trim());
      check('the gyro panel carries the levers', ['gyro', 'amount', 'max travel', 'smoothing', 'auto recenter', 'invert x', 'invert y'].every((l) => labels.includes(l)), labels.join(', '));
      const buttonNamed = (text) => [...(panel?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === text);
      check('the gyro panel has both resets', !!buttonNamed('Reset camera') && !!buttonNamed('Reset gyroscope'));
      // Reset camera: the pose of this moment becomes the centre, and the eye
      // eases back to the composed view.
      px.reset();
      px.setSettings({ ...base, recenter: 0 });
      px.feedOrientation(60, 0);
      px.update(0.1);
      px.feedOrientation(60, 10);
      px.update(0.1);
      const pushed = px.state().offset.x;
      buttonNamed('Reset camera')?.click();
      px.update(0.1);
      const afterReset = px.state();
      check('reset camera makes the current pose the centre', pushed !== 0 && !!afterReset.rest && Math.abs(afterReset.rest.x - 10) < 1e-9 && Math.abs(afterReset.offset.x) < 1e-6, `eye ${pushed.toFixed(3)} -> ${afterReset.offset.x.toFixed(3)}, rest ${afterReset.rest?.x}`);
      // Reset gyroscope: every sample forgotten; the next one is the centre.
      buttonNamed('Reset gyroscope')?.click();
      check('reset gyroscope forgets the pose', px.state().tilt === null && px.state().rest === null);
      gh.hide();
    }

    px.reset();
    await load();
    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`parallax: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * Touch: fingers brushing through the particles. The mapping from the
   * screen to the emitter's plane, the radius as a share of the view, and
   * the samples reaching the live system.
   */
  const touchReport = async () => {
    const w = window.__world;
    const T = w.THREE;
    const lines = [];
    const check = (label, ok, detail = '') => lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const touch = window.__touch;
    check('the touch seam exists', !!touch && typeof touch.screenToWorld === 'function');
    if (!touch) return ['touch: 0/1 passed', ...lines].join('\n');

    const cfg = await load();
    const titles = [...document.querySelectorAll('.lil-gui.root > .children > .lil-gui > .title')].map((t) => t.textContent.trim());
    const iTouch = titles.indexOf('Touch');
    const iForce = titles.indexOf('Force Fields');
    check('the Touch section sits before Force Fields', iTouch >= 0 && iForce === iTouch + 1, `${iTouch} -> ${iForce}`);

    // The screen's centre lands on the emitter's plane, under the camera's axis.
    const cam = w.getOutputCamera();
    const centre = touch.screenToWorld(0, 0);
    const transform = cfg.transform ?? {};
    const p = transform.position ?? {};
    const r = transform.rotation ?? {};
    const normal = new T.Vector3(0, 0, 1).applyEuler(new T.Euler(T.MathUtils.degToRad(r.x ?? 0), T.MathUtils.degToRad(r.y ?? 0), T.MathUtils.degToRad(r.z ?? 0)));
    const onPlane = centre ? Math.abs(centre.clone().sub(new T.Vector3(p.x ?? 0, p.y ?? 0, p.z ?? 0)).dot(normal)) : Infinity;
    check('the screen centre lands on the emitter plane', !!centre && onPlane < 1e-4, centre ? `${centre.toArray().map((n) => n.toFixed(2))} off by ${onPlane.toExponential(1)}` : 'no hit');
    const forward = new T.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const offAxis = centre ? centre.clone().sub(cam.position).cross(forward).length() : Infinity;
    check('and on the camera axis', offAxis < 1e-3, offAxis.toExponential(1));

    // The radius is a share of the view's width at that depth.
    if (centre) {
      const depth = centre.clone().sub(cam.position).dot(forward);
      const viewWidth = 2 * depth * Math.tan((cam.fov * Math.PI) / 360) * cam.aspect;
      const share = window.editor.getCurrentParticleSystemConfig().touch?.radius ?? 0.12;
      check('the radius is a share of the view width', Math.abs(touch.radiusAt(centre) - share * viewWidth) < 1e-6, `${touch.radiusAt(centre).toFixed(3)} = ${share} × ${viewWidth.toFixed(3)}`);
    }

    // The piece has touch on. Off, the system takes no samples.
    check('the piece has touch on', cfgLiveTouch());
    const offCfg = window.editor.getCurrentParticleSystemConfig();
    offCfg.touch = { ...(offCfg.touch ?? {}), isActive: false };
    window.editor.reset();
    await new Promise((r) => setTimeout(r, 300));
    check('an inactive system takes no samples', (touch.feed({ x: 0, y: 0, z: 0, radius: 1, vx: 1, vy: 0, vz: 0 }), touch.count()) === 0);

    // On: samples reach the live system and can be cleared.
    const live = window.editor.getCurrentParticleSystemConfig();
    live.touch = { ...(live.touch ?? {}), isActive: true };
    window.editor.reset();
    await new Promise((r) => setTimeout(r, 300));
    touch.feed({ x: 0, y: 0, z: 0, radius: 1, vx: 1, vy: 0, vz: 0 });
    touch.feed({ x: 0.1, y: 0, z: 0, radius: 1, vx: 1, vy: 0, vz: 0 });
    check('an active system takes samples', touch.count() === 2, `${touch.count()}`);
    touch.clear();
    check('and forgets them on clear', touch.count() === 0);

    await load();
    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`touch: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };
  const cfgLiveTouch = () => !!window.editor.getCurrentParticleSystemConfig().touch?.isActive;

  /**
   * The standalone player: a fresh page in an iframe, given the piece the way
   * a person gives it — the text COPY produces — and checked against the
   * editor it came from. Same origin, so a storage write by the player would
   * be visible here; the player counts its own attempts instead, which is
   * exact.
   */
  const standaloneReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') => lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    const cfg = await load();
    const json = window.editor.serialize?.();
    check('the editor hands the piece out as COPY does', typeof json === 'string' && json.length > 100, `${json?.length ?? 0} chars`);

    const frame = document.createElement('iframe');
    frame.src = './player/?standalone-test';
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:360px;height:640px;border:0;opacity:0.02;pointer-events:none;';
    document.body.appendChild(frame);
    const until = async (fn, ms) => {
      const start = performance.now();
      while (performance.now() - start < ms) {
        let v = null;
        try { v = fn(); } catch { v = null; }
        if (v) return v;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    const p = await until(() => frame.contentWindow?.__player?.ready && frame.contentWindow.__player, 20000);
    check('a standalone player boots', !!p);

    if (p) {
      check('it is standalone: no link, no editor heard', p.mode() === 'standalone' && p.heardEditor() === false);
      check('it shows nothing until a paste', p.hasContent() === false);
      check('the frame counter starts hidden', p.statsVisible() === false);
      check('the Paste control is offered', !frame.contentDocument.querySelector('.player-paste').hidden);
      // iOS zooms a page toward a focused field smaller than 16px, and a zoomed
      // display renders as a magnified corner. Both guards, checked.
      const sheetFont = parseFloat(frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector('.player-paste-sheet textarea')).fontSize);
      check('the paste box will not make iOS zoom', sheetFont >= 16, `${sheetFont}px`);
      const viewportMeta = frame.contentDocument.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
      check('the page forbids pinch zoom', /maximum-scale=1/.test(viewportMeta) && /user-scalable=no/.test(viewportMeta), viewportMeta);
      const writesBefore = p.storageWrites();

      const ok = await p.paste(json);
      check('a pasted piece loads', ok === true && p.hasContent() === true);
      check('the Paste control steps aside', !!frame.contentDocument.querySelector('.player-paste').hidden);

      const want = cfg._editorData.sceneObjects;
      const got = p.getSceneObjects();
      check('the scene arrives whole', got.length === want.length && got.every((o, i) => o.id === want[i].id && o.type === want[i].type), `${got.length}/${want.length}`);
      check('the output camera is the piece\'s', !!p.getOutputCamera());

      // The same loader on both sides: what the player would COPY back is
      // what it was given, field for field.
      const back = p.serialize();
      const drift = diff(JSON.parse(json), back);
      check('the player serialises the piece back identically', drift.length === 0, drift.slice(0, 4).join(' | '));

      const source = JSON.parse(json)._editorData?.colorInstanceTextureId;
      const hasSource = source ? await until(() => p.hasTexture(source), 10000) : true;
      check('the colour source is registered from the embedded data', !!hasSource, source ?? 'none');

      const cam = want.find((o) => o.type === 'CAMERA');
      check('the camera\'s parallax settings travel', p.getParallax().enabled === !!cam?.parallax?.enabled);
      check('the touch settings travel', JSON.stringify(back.touch ?? null) === JSON.stringify(JSON.parse(json).touch ?? null), `${JSON.stringify(back.touch)} vs ${JSON.stringify(JSON.parse(json).touch)}`);
      check('nothing was written to storage', writesBefore === 0 && p.storageWrites() === 0, `${p.storageWrites()} writes`);

      // A second paste replaces the first: no leftovers from the previous piece.
      const again = JSON.parse(json);
      again._editorData.sceneObjects = again._editorData.sceneObjects.filter((o) => o.type !== 'FRAME');
      const ok2 = await p.paste(JSON.stringify(again));
      check('a second paste replaces the piece', ok2 && p.getSceneObjects().length === again._editorData.sceneObjects.length, `${p.getSceneObjects().length} objects`);
      check('junk is refused, and the piece stays', (await p.paste('not a config')) === false && p.hasContent());
      // A double tap toggles the gyro parallax and says so.
      const gyroBefore = p.getParallax().enabled;
      p.toggleGyro();
      const gyroAfter = p.getParallax().enabled;
      const caption = frame.contentDocument.querySelector('.player-status')?.textContent ?? '';
      p.toggleGyro();
      check('a double tap toggles the gyro and captions it', gyroAfter === !gyroBefore && p.getParallax().enabled === gyroBefore && /^Gyro (on|off)$/.test(caption), `${gyroBefore} -> ${gyroAfter} -> ${p.getParallax().enabled}, "${caption}"`);
    }
    frame.remove();

    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`standalone: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * The link to the display window, exercised from this side of it.
   *
   * The display is a separate page with its own renderer, so what can be
   * checked from here is the contract rather than the picture: that the editor
   * answers a display announcing itself, that what it sends survives a
   * structured clone — the live config carries the entries' own recreate
   * callbacks, and posting one of those is exactly how this broke the first
   * time — and that a panorama is not re-cloned onto the wire on every push.
   */
  const playerReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    const channel = new BroadcastChannel('three-particles-player');
    const inbox = [];
    channel.onmessage = (event) => inbox.push(event.data);

    /** A channel never receives its own posts, so everything here is the editor's. */
    const waitFor = async (type, ms = 4000) => {
      const start = performance.now();
      while (performance.now() - start < ms) {
        const found = inbox.filter((m) => m?.type === type).pop();
        if (found) return found;
        await new Promise((r) => setTimeout(r, 40));
      }
      return null;
    };

    // A tiny 2x1 PNG standing in for a panorama: large enough to be a real
    // source string, small enough to read back in an assertion.
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 1;
    canvas.getContext('2d').fillStyle = '#3070ff';
    canvas.getContext('2d').fillRect(0, 0, 2, 1);
    const panorama = canvas.toDataURL('image/png');

    const withEnvironment = async (extra) => {
      const cfg = await fixture();
      cfg._editorData.sceneObjects = cfg._editorData.sceneObjects.filter(
        (o) => o.type !== 'ENVIRONMENT'
      );
      cfg._editorData.sceneObjects.push({
        id: 'obj-env-probe',
        type: 'ENVIRONMENT',
        name: 'Panorama probe',
        visible: false,
        position: { x: 0, y: 0, z: 0 },
        environment: { source: panorama, format: 'ldr', intensity: 1, rotation: 0, blur: 0, showInViewport: false, showInCamera: false },
      });
      Object.assign(cfg._editorData.sceneObjects.find((o) => o.type === 'FRAME'), extra);
      window.editor.load(cfg);
    };

    // ── The handshake ────────────────────────────────────────────────────────
    channel.postMessage({ type: 'hello' });
    // A live display keeps saying so; without this the editor would drop the
    // link partway through the checks below, as it should for a dead one.
    const pinger = setInterval(() => channel.postMessage({ type: 'ping' }), 2000);
    const snapshot = await waitFor('snapshot');
    check('editor answers a display that announces itself', !!snapshot);

    if (snapshot) {
      const data = snapshot.config?._editorData ?? {};
      check('snapshot carries the scene', Array.isArray(data.sceneObjects), `${data.sceneObjects?.length ?? 0} objects`);
      check('snapshot carries the emitter', typeof snapshot.config?.duration === 'number' || !!snapshot.config?.emission);
      // Uploaded textures live in localStorage, which the display shares.
      check('snapshot leaves texture payloads at home', data.embeddedTextures === undefined);
      // The emitter's canned motion is config, not scene, so it rides in
      // _editorData — and the display runs it from the same numbers.
      check(
        'snapshot carries the emitter simulation',
        typeof data.simulation?.movements === 'string' && typeof data.simulation?.movementSpeed === 'number',
        `${data.simulation?.movements} @ ${data.simulation?.movementSpeed}`
      );

      // The editor also leaves its latest piece in storage, for a display that
      // cannot reach a live editor — a phone freezes the tab it came from.
      const stored = JSON.parse(localStorage.getItem('particle-system-editor/player-snapshot') || 'null');
      check('a stored snapshot accompanies the live one', !!stored?.config && typeof stored.savedAt === 'number', stored ? `saved ${Date.now() - stored.savedAt}ms ago` : 'none');
      check('the stored snapshot is the same piece', stored?.config?._editorData?.metadata?.name === snapshot.config?._editorData?.metadata?.name, `${stored?.config?._editorData?.metadata?.name}`);
      check('the stored snapshot leaves the scene to scene-objects', stored?.config?._editorData?.sceneObjects === undefined);
      check('the stored snapshot leaves texture payloads at home', stored?.config?._editorData?.embeddedTextures === undefined);

      // The clone already happened — a function anywhere in here would have
      // thrown DataCloneError instead of arriving — but naming it makes the
      // failure legible rather than a silent absence.
      const functions = [];
      const walk = (node, path, seen) => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        Object.keys(node).forEach((key) => {
          const value = node[key];
          if (typeof value === 'function') functions.push(`${path}.${key}`);
          else if (value && typeof value === 'object') walk(value, `${path}.${key}`, seen);
        });
      };
      walk(snapshot.config, 'config', new Set());
      check('nothing on the wire is a function', functions.length === 0, functions.join(', '));
    }

    // ── Incremental pushes ───────────────────────────────────────────────────
    inbox.length = 0;
    await withEnvironment({ position: { x: 1.5, y: 1.5, z: 0 } });
    const first = await waitFor('scene');
    check('a scene change reaches the display', !!first);
    const firstEnv = first?.objects?.find((o) => o.type === 'ENVIRONMENT');
    check('a panorama the display has not seen travels in full', firstEnv?.environment?.source === panorama);

    // An emitter change refreshes the stored copy too, live display or not.
    const storedBefore = JSON.parse(localStorage.getItem('particle-system-editor/player-snapshot') || 'null')?.savedAt ?? 0;
    inbox.length = 0;
    await withEnvironment({ position: { x: -1.5, y: 1.5, z: 0 } });
    const second = await waitFor('scene');
    await new Promise((r) => setTimeout(r, 300));
    const storedAfter = JSON.parse(localStorage.getItem('particle-system-editor/player-snapshot') || 'null')?.savedAt ?? 0;
    check('an emitter change refreshes the stored snapshot', storedAfter > storedBefore, `${storedAfter - storedBefore}ms later`);
    const secondEnv = second?.objects?.find((o) => o.type === 'ENVIRONMENT');
    check('the next push moves the object', second?.objects?.find((o) => o.type === 'FRAME')?.position.x === -1.5);
    check(
      'an unchanged panorama travels as a sentinel',
      typeof secondEnv?.environment?.source === 'string' &&
        secondEnv.environment.source !== panorama &&
        secondEnv.environment.source.length < 64,
      `${secondEnv?.environment?.source?.length ?? 0} chars vs ${panorama.length}`
    );

    // ── The button ───────────────────────────────────────────────────────────
    const button = document.querySelector('.player-window-toggle');
    check('the toggle button exists', !!button);
    if (button && window.__world?.getOutputCamera()) {
      const box = button.getBoundingClientRect();
      const canvasBox = window.__world.canvasBounds();
      const preview = window.__world.previewRect();
      check('the button sits outside the preview, not on it', box.right <= canvasBox.left + preview.x);
      check('the button lines up with the preview top', Math.abs(box.top - (canvasBox.top + preview.y)) <= 1, `${Math.round(box.top)} vs ${Math.round(canvasBox.top + preview.y)}`);
    }

    // ── Suspension ───────────────────────────────────────────────────────────
    //
    // `linked` is true from the hello above, so the focus input alone decides.
    // This page can never lose focus for real, which is why the editor exposes
    // an override for it.
    const link = window.__playerLink;
    check('the editor exposes its suspension rule', typeof link?.shouldSuspendEditor === 'function');

    if (link) {
      check('no display, no suspension', link.shouldSuspendEditor(false, false) === false);
      check('display open, editor focused — keeps drawing', link.shouldSuspendEditor(true, true) === false);
      check('display open, editor blurred — suspends', link.shouldSuspendEditor(true, false) === true);

      const card = document.querySelector('.player-suspend-card');
      const canvas = window.__world.renderer.domElement;
      check('the pause card exists', !!card);

      /** Frames are irregular in an automated pane, so this waits rather than counts. */
      const drewAFrame = async (ms) => {
        const start = link.frames();
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
          if (link.frames() > start) return true;
          await new Promise((r) => setTimeout(r, 40));
        }
        return false;
      };

      link.setFocusOverride(true);
      check('a focused editor keeps drawing beside the display', await drewAFrame(3000));
      check('no card while the editor is drawing', card?.style.display === 'none');
      check('the viewport is at full strength while drawing', canvas.style.filter === '');

      link.setFocusOverride(false);
      // One frame for the loop to notice, then the loop must go quiet. A hidden
      // pane gets that frame about once a second, so this waits for it rather
      // than assuming it.
      const noticed = async (ms) => {
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
          if (link.isSuspended()) return true;
          await new Promise((r) => setTimeout(r, 40));
        }
        return link.isSuspended();
      };
      check('the loop applied the suspension', await noticed(4000));
      check('a blurred editor stops drawing', (await drewAFrame(600)) === false);
      check('the card says so', card?.style.display === 'flex');
      check('the frozen viewport is dimmed', canvas.style.filter.includes('brightness'));

      if (card) {
        const z = Number(getComputedStyle(card).zIndex);
        const buttonZ = Number(getComputedStyle(document.querySelector('.player-window-toggle')).zIndex);
        // A suspended editor is a control surface, not a modal: nothing may
        // cover the panels, and the card must not outrank them either.
        check('the card sits under the panels', z < 10, `z ${z}`);
        check('the toggle button stays above the card', buttonZ > z, `${buttonZ} vs ${z}`);
        check('nothing covers the panels', !document.querySelector('.player-suspend-overlay'));
        // lil-gui is the half of the editor that still works while suspended.
        const gui = document.querySelector('.lil-gui');
        check('the control panel is untouched', !gui || getComputedStyle(gui).filter === 'none');
        check('the card itself is clickable', getComputedStyle(card).pointerEvents === 'auto');
      }

      const editorStats = document.querySelector('.stats');
      check('the frozen counter is dimmed', editorStats?.style.opacity === '0.25');

      link.setFocusOverride(true);
      check('focus brings the editor back', await drewAFrame(3000));
      check('and takes the card away', card?.style.display === 'none');
      check('and the dim with it', canvas.style.filter === '');
      check('and the counter with it', editorStats?.style.opacity === '');

      // A display that goes silent — killed without its bye — must not leave
      // the editor suspended. Stop answering and wait past the timeout.
      clearInterval(pinger);
      link.setFocusOverride(false);
      await new Promise((r) => setTimeout(r, 6500));
      check('a display that fell silent releases the editor', link.isSuspended() === false);
      link.setFocusOverride(null);
    }

    clearInterval(pinger);
    // Stop the editor pushing at a display that was never really there.
    channel.postMessage({ type: 'bye' });
    channel.close();
    await load();

    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`player: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * A video as the colour source, end to end: stored the way an upload is,
   * playing on a loop, read back by the library as frames arrive, and gone
   * without a trace afterwards.
   *
   * The readback assertions need frames: emission happens inside the render
   * loop, and rVFC only fires in a visible document. In an automated pane the
   * frame-dependent lines can fail for that reason alone — they say so.
   */
  const videoReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (pred, ms) => {
      const start = performance.now();
      while (performance.now() - start < ms) {
        if (pred()) return true;
        await settle(50);
      }
      return !!pred();
    };
    const VIDEO_URL = './assets-local/AnimateDiff_00013.mp4';

    const api = window.__videoTextures;
    check('editor exposes the video registry', !!api);
    if (!api) return ['video: 0/1 passed', ...lines].join('\n');

    // Leftovers from an interrupted run would otherwise pile up in IndexedDB.
    for (const stale of api.entries().filter((e) => e.url === VIDEO_URL || e.size === 73618914)) {
      await api.remove(stale.id);
    }

    const response = await fetch(VIDEO_URL);
    check('test video is served', response.ok, `HTTP ${response.status}`);
    if (!response.ok) return [`video: ${lines.length - 1}/${lines.length} passed`, ...lines].join('\n');
    const blob = await response.blob();

    // ── The upload path, minus the file dialog ────────────────────────────
    const t0 = performance.now();
    let entry = null;
    try {
      entry = await api.addFile(new File([blob], 'AnimateDiff_00013.mp4', { type: 'video/mp4' }));
    } catch (error) {
      check('upload stores and decodes', false, String(error));
    }
    if (entry) {
      check('upload stores and decodes', entry.width === 2048 && entry.height === 2048, `${entry.width}x${entry.height} in ${Math.round(performance.now() - t0)}ms`);
      check('duration is known', entry.duration > 47 && entry.duration < 48, `${entry.duration?.toFixed(2)}s`);
      check('entry persisted in the list', api.entries().some((e) => e.id === entry.id));
      check('thumbnail captured', typeof entry.thumbnail === 'string' && entry.thumbnail.startsWith('data:image/webp'), `${entry.thumbnail?.length ?? 0} chars`);
      check('the list stays small (bytes are not in localStorage)', (localStorage.getItem('particle-system-editor/video-textures') || '').length < 64 * 1024);
      const stored = await new Promise((resolve) => {
        const open = indexedDB.open('three-particles-editor');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const get = db.transaction('videos').objectStore('videos').get(entry.name);
            get.onsuccess = () => { resolve(get.result); db.close(); };
            get.onerror = () => { resolve(null); db.close(); };
          } catch { resolve(null); }
        };
      });
      check('bytes are in IndexedDB', stored instanceof Blob && stored.size === blob.size, `${stored?.size ?? 0} bytes`);
    }

    const tex = entry && api.get(entry.name);
    const video = tex?.video;
    check('registered under its name with a video-backed map', !!tex?.map && tex.map.image instanceof HTMLVideoElement);
    if (video) {
      check('video loops', video.loop === true);
      check('video is muted (autoplay-safe)', video.muted === true);
      check('video element is in the document and renderable', video.isConnected && getComputedStyle(video).display !== 'none');
      check('video is playing', await waitFor(() => !video.paused && video.readyState >= 2, 3000), `paused ${video.paused}, readyState ${video.readyState}`);
    }

    // ── As the colour source ──────────────────────────────────────────────
    if (entry && tex) {
      window.editor.setColorInstanceTexture(entry.name);
      const cfg = window.editor.getCurrentParticleSystemConfig();
      check('config points at the video by name', cfg._editorData.colorInstanceTextureId === entry.name);
      check('particleColorInstance is on with the video map', cfg.particleColorInstance?.isActive === true && cfg.particleColorInstance.map === tex.map);

      const statsOf = () => tex.map.userData.colorInstanceReadback;
      const first = await waitFor(() => (statsOf()?.count ?? 0) > 0, 4000);
      check('first frame read back on emission (needs frames)', first, JSON.stringify(statsOf() ?? null));
      if (first) {
        const st = statsOf();
        check('readback grid is bounded to 512', st.width <= 512 && st.height <= 512, `${st.width}x${st.height}`);
        check('frames are being watched', st.live === true);
        const before = st.count;
        const more = await waitFor(() => statsOf().count > before + 3, 3000);
        check('readbacks follow the video, not the render loop (needs a visible window)', more, `${statsOf().count - before} more in ≤3s`);
        check('a readback per video frame, not per spawn', statsOf().count < 400, `${statsOf().count} total`);
        // After the first frame the reading leaves the main thread. What the
        // main thread still pays is wrapping the frame and posting it.
        const after = statsOf();
        check('reading moved off the main thread', after.mode === 'worker', `mode ${after.mode}`);
        check('the hand-over is cheap on the main thread', after.mode === 'worker' && after.lastMs < 2, `${after.lastMs.toFixed(2)}ms`);
        check('the worker reports its own time', after.mode !== 'worker' || after.workerMs > 0, `${after.workerMs.toFixed(2)}ms in the worker`);
      }

      cfg.particleColorInstance.sampleSize = 256;
      window.editor.reset();
      const resized = await waitFor(() => statsOf()?.width === 256, 3000);
      check('sample size lever reaches the grid (needs frames)', resized, `${statsOf()?.width ?? 0}`);
      cfg.particleColorInstance.sampleSize = 0;

      if (video && video.duration) {
        video.currentTime = Math.max(0, video.duration - 0.3);
        const wrapped = await waitFor(() => video.currentTime < 1 && !video.paused, 3000);
        check('loops back to the start (needs playback)', wrapped, `t=${video.currentTime.toFixed(2)} paused=${video.paused}`);
      }

      // The wire: the name travels, the bytes do not.
      const wire = JSON.stringify(window.__playerLink ? cfg._editorData : {});
      check('nothing video-sized in the editor data', wire.length < 1024 * 1024, `${wire.length} chars`);
    }

    // ── Cleanup ───────────────────────────────────────────────────────────
    if (entry) {
      await api.remove(entry.id);
      check('removal unregisters the name', !api.get(entry.name));
      check('removal drops the list entry', !api.entries().some((e) => e.id === entry.id));
      check('removal detaches the element', !video || !video.isConnected);
    }
    await load();
    check('no runtime errors', errs.length === 0, errs.slice(0, 3).join(' | '));

    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`video: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * The drag gizmo, exercised the way a hand would: select an object from the
   * Scene panel, hover its handle, drag it, and expect it to have moved.
   *
   * The handles sit on the furniture layer so the output camera never sees
   * them; the first time that was done, TransformControls' own raycaster —
   * which looks at layer 0 like every raycaster — stopped finding them, and
   * every handle in the editor could be shown but not moved. Pointer events
   * here are synthetic but real DOM events on the canvas, which is exactly
   * what TransformControls listens to.
   */
  const gizmoReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const w = window.__world;
    const T = w.THREE;

    /** Frames are irregular in an automated pane, so wait for them rather than count. */
    const frames = async (n, ms = 3000) => {
      const link = window.__playerLink;
      const start = link.frames();
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        if (link.frames() >= start + n) return true;
        await settle(30);
      }
      return false;
    };

    await load();
    // The handle has to be in view to be hovered, and the editor camera is
    // wherever the session left it. Frame the scene, and put it back after.
    const cameraBefore = { pos: w.camera.position.clone(), target: w.controls.target.clone() };
    window.editor.resetCamera();
    await frames(2);

    // Select the frame from the panel, like a user would.
    const previousTab = [...document.querySelectorAll('[role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true');
    const sceneTab = [...document.querySelectorAll('[role=tab]')].find((t) => /scene/i.test(t.textContent));
    sceneTab?.click();
    await settle(300);
    const item = [...document.querySelectorAll('.item')].find((el) => /frame/i.test(el.querySelector('.title')?.textContent || ''));
    const selectButton = item?.querySelector('button[title="Show drag axes in the viewport"]');
    check('the Scene panel offers a handle toggle for the frame', !!selectButton);
    selectButton?.click();
    await frames(2);

    const root = w.scene.children.find((o) => o.isTransformControlsRoot);
    const controls = root?.controls;
    check('selecting attaches the gizmo', !!controls?.object, controls?.object?.type ?? 'nothing attached');

    if (controls?.object) {
      // Layer contract: drawn only for the editor, but findable by its own raycaster.
      const artwork = new T.Layers();
      artwork.set(0);
      const leaks = [];
      root.traverse((o) => { if (o.layers.test(artwork)) leaks.push(o.type); });
      check('gizmo stays off the artwork layer', leaks.length === 0, leaks.slice(0, 3).join(','));
      check('gizmo raycaster can see the furniture layer', controls.getRaycaster().layers.test(root.layers));

      const canvas = w.renderer.domElement;
      // A real pointermove reports button -1; TransformControls ignores moves
      // that claim a button, so the synthetic ones have to say the same.
      const fire = (type, x, y) =>
        canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true, bubbles: true, cancelable: true }));
      const clientOf = (v) => {
        const p = v.clone().project(w.camera);
        const b = w.canvasBounds();
        return [b.left + ((p.x + 1) / 2) * b.width, b.top + ((1 - p.y) / 2) * b.height];
      };
      const origin = controls.object.getWorldPosition(new T.Vector3());
      const [cx, cy] = clientOf(origin);
      const b = w.canvasBounds();
      check('the selected object is on screen', cx > b.left && cx < b.right && cy > b.top && cy < b.bottom, `${Math.round(cx)},${Math.round(cy)}`);

      // Hover a spiral around the centre until a handle lights up.
      let hit = null;
      for (let r = 0; r <= 80 && !hit; r += 4) {
        for (let a = 0; a < 360 && !hit; a += 30) {
          const x = cx + r * Math.cos((a * Math.PI) / 180);
          const y = cy + r * Math.sin((a * Math.PI) / 180);
          fire('pointermove', x, y);
          if (controls.axis) hit = { x, y, axis: controls.axis };
        }
      }
      check('hovering a handle highlights an axis', !!hit, hit ? `${hit.axis} at ${Math.round(hit.x - cx)},${Math.round(hit.y - cy)}` : 'nothing within 80px');

      if (hit) {
        const before = controls.object.position.clone();
        const stored = () => storedScene().find((o) => o.type === 'FRAME')?.position;
        const storedBefore = JSON.stringify(stored());
        const events = [];
        const unwatch = window.editor.watchDocument((e) => events.push(e));
        fire('pointerdown', hit.x, hit.y);
        check('pressing a handle starts a drag', controls.dragging === true);
        fire('pointermove', hit.x + 40, hit.y + 25);
        fire('pointermove', hit.x + 80, hit.y + 50);
        const during = controls.object.position.clone();
        fire('pointerup', hit.x + 80, hit.y + 50);
        const moved = during.distanceTo(before);
        check('dragging moves the object', moved > 0.05, `${moved.toFixed(3)} units`);
        check('the drag ends on release', controls.dragging === false);
        check('the stored scene follows the drag', JSON.stringify(stored()) !== storedBefore);
        check('orbit controls are back after the drag', w.controls.enabled === true);
        unwatch();
        const frameId = storedScene().find((o) => o.type === 'FRAME')?.id;
        const fromGizmo = events.filter((e) => e.scope === 'scene' && e.source === 'gizmo');
        check('the drag announces a document change (scene, gizmo, position)', fromGizmo.length > 0 && fromGizmo.every((e) => e.id === frameId && e.keys.includes('position')), `${fromGizmo.length} events, ${JSON.stringify(fromGizmo[0] ?? null)}`);
      }
    }

    previousTab?.click();
    await load();
    w.camera.position.copy(cameraBefore.pos);
    w.controls.target.copy(cameraBefore.target);
    w.controls.update();
    check('no runtime errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`gizmo: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * The schema against V1's own panel (V2-ARCHITECTURE.md §2.2, M1): on a
   * fresh system, every leaf of the live document has a field, every field
   * resolves, and every lil-gui controller agrees with the field at its path —
   * kind, range, step, options. documentDefaults() is compared with the
   * document the editor actually builds.
   */
  const schemaReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const S = window.editor.schema;
    const resolve = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
    check('the schema is exposed', !!S && Array.isArray(S.schema) && S.schema.length > 10, `${S?.schema?.length} groups`);

    const saved = JSON.parse(window.editor.serialize());
    window.editor.createNew();
    await new Promise((r) => setTimeout(r, 400));
    const doc = window.editor.getCurrentParticleSystemConfig();
    const panel = window.editor.getPanel();

    // Coverage, both ways, on the live document.
    // Functions V1's entries hang on the config (`_recreateParticleSystem` and friends) are not document data.
    const leaves = S.leafPaths(doc).filter((p) => typeof resolve(doc, p) !== 'function');
    const uncovered = leaves.filter((p) => !S.coversLeaf(p));
    check('every leaf of the live document has a field', uncovered.length === 0, uncovered.slice(0, 8).join(', '));
    const exempt = new Set(['_editorData.sceneObjects', '_editorData.embeddedTextures', '_editorData.embeddedVideos', 'map', 'renderer.mesh.geometry', 'subEmitters']);
    const visible = (f, groupWhen) => (!groupWhen || groupWhen(doc)) && (!f.when || f.when(doc));
    const dangling = [];
    const walk = (groups, parentWhen) => {
      for (const g of groups) {
        const w = g.when ? (d) => (!parentWhen || parentWhen(d)) && g.when(d) : parentWhen;
        for (const f of g.fields) {
          if (exempt.has(f.path) || f.kind === 'hidden' || !visible(f, w)) continue;
          if (resolve(doc, f.path) === undefined) dangling.push(f.path);
        }
        if (g.groups) walk(g.groups, w);
      }
    };
    walk(S.schema, null);
    check('every visible field resolves in the live document', dangling.length === 0, dangling.join(', '));

    // The editor's own defaults against the schema's.
    const defaults = S.documentDefaults();
    const skip = (p) => p.startsWith('_editorData.metadata') || p.startsWith('_editorData.embedded') || p.startsWith('_editorData.trailGradientStops') || p === '_editorData.textureId' || p === '_editorData.colorInstanceTextureId' || p === 'map' || p === 'particleColorInstance.map' || p.startsWith('renderer.mesh.geometry') || p === 'maxParticles' || p === 'emission.rateOverTime';
    // A `value` field may hold a constant or { min, max }: V1's panel expands the library's constants.
    const same = (p) => {
      const a = resolve(doc, p);
      const m = p.match(/^(.*)\.(min|max)$/);
      const b = m && typeof resolve(defaults, m[1]) === 'number' ? resolve(defaults, m[1]) : resolve(defaults, p);
      return JSON.stringify(a) === JSON.stringify(b);
    };
    const diffs = [];
    for (const p of leaves) {
      if (skip(p)) continue;
      if (!same(p)) diffs.push(`${p}: editor ${JSON.stringify(resolve(doc, p))} vs schema ${JSON.stringify(resolve(defaults, p))}`);
    }
    check('documentDefaults() matches the document the editor builds', diffs.length === 0, diffs.slice(0, 6).join(' | '));
    check('a new system starts at the editor\'s counts, not the library\'s', doc.maxParticles === 10000 && doc.emission.rateOverTime === 1000, `${doc.maxParticles}, ${doc.emission.rateOverTime}`);

    // Every controller of V1's panel against the field at its path.
    const paths = new Map();
    const index = (o, p) => {
      if (!o || typeof o !== 'object' || paths.has(o)) return;
      paths.set(o, p);
      if (Array.isArray(o)) o.forEach((v, i) => index(v, `${p}.${i}`));
      else for (const [k, v] of Object.entries(o)) index(v, p ? `${p}.${k}` : k);
    };
    index(doc, '');
    const kindOf = (c) => {
      const cls = c.constructor.name;
      if (c._names) return 'enum';
      if (c.$input?.type === 'checkbox') return 'bool';
      if (c.$input?.type === 'color' || c.$text && c.$input && cls.length && c.domElement.classList.contains('color')) return 'color';
      if (c.$slider || c.$input?.type === 'text' && c._min !== undefined) return 'number';
      return cls;
    };
    let compared = 0;
    const mismatches = [];
    for (const c of panel.controllersRecursive()) {
      const base = paths.get(c.object);
      if (base === undefined) continue; // UI-only helpers (buttons, Size (all axes), info)
      const path = base ? `${base}.${c.property}` : c.property;
      const f = S.fieldAt(path) ?? S.fieldAt(path.replace(/\.(min|max|x|y|z|r|g|b|scale)$/, ''));
      if (!f) { mismatches.push(`${path}: no field`); continue; }
      compared++;
      const k = kindOf(c);
      const numeric = ['number', 'int', 'value', 'vec2', 'vec3', 'curve'];
      if (k === 'enum') {
        const want = (f.options ?? []).map((o) => String(o.value)).join(',');
        const got = c._values.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(',');
        if (f.kind !== 'enum' || want !== got) mismatches.push(`${path}: options ${got} vs ${want}`);
      } else if (k === 'bool') {
        if (f.kind !== 'bool' && !(f.kind === 'gradient' && c.property === 'isActive')) mismatches.push(`${path}: bool vs ${f.kind}`);
      } else if (k === 'number') {
        if (!numeric.includes(f.kind)) mismatches.push(`${path}: number vs ${f.kind}`);
        else if (c._min !== f.min || c._max !== f.max || c._step !== f.step) {
          // rateOverDistance and burst counts widen with Enable big numbers; the schema carries the wide range.
          const widened = /rateOverDistance|bursts\.\d+\.count/.test(path);
          if (!widened) mismatches.push(`${path}: ${c._min}..${c._max}/${c._step} vs ${f.min}..${f.max}/${f.step}`);
        }
      } else if (c.domElement.classList.contains('color')) {
        if (!['color', 'minmaxColor'].includes(f.kind)) mismatches.push(`${path}: color vs ${f.kind}`);
      }
    }
    check('V1 controllers agree with the fields at their paths', mismatches.length === 0, mismatches.slice(0, 8).join(' | '));
    check('a meaningful number of controllers were compared', compared > 100, `${compared}`);

    // Change levels: the ones the glue bakes are structural in the table.
    const structural = ['noise.isActive', 'noise.curl', 'noise.type', 'noise.octaves', 'colorOverLifetime.isActive', 'sizeOverLifetime.isActive', 'opacityOverLifetime.isActive', 'rotationOverLifetime.isActive', 'renderer.rendererType', 'maxParticles', 'touch.isActive', 'forceFields', 'collisionPlanes'];
    const wrong = structural.filter((p) => S.fieldAt(p)?.change !== 'structural');
    check('kernel-baked switches are marked structural', wrong.length === 0, wrong.join(', '));
    const live = ['noise.strength', 'particleColorInstance.scale', 'emission.rateOverTime', 'forceFields.0.strength', 'collisionPlanes.0.dampen', 'startLifetime'];
    const notLive = live.filter((p) => S.fieldAt(p)?.change !== 'live');
    check('updateConfig-able keys are marked live', notLive.length === 0, notLive.join(', '));

    window.editor.load(saved);
    await new Promise((r) => setTimeout(r, 400));
    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`schema: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * Presentation mode: this window as the display. Entered from the button
   * under the player toggle, checked for what it promises — panels gone, the
   * canvas the camera's shape, the frame still advancing, the output going
   * through the encode once — and left again by Escape.
   */
  const presentReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const w = window.__world;
    const link = window.__playerLink;
    const frames = async (n, ms = 3000) => {
      const start = link.frames();
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        if (link.frames() >= start + n) return true;
        await settle(30);
      }
      return false;
    };

    await load();
    await frames(2);

    const toggle = document.querySelector('.player-window-toggle');
    const present = document.querySelector('.presentation-toggle');
    check('the presentation button exists', !!present);
    if (toggle && present) {
      const a = toggle.getBoundingClientRect();
      const b = present.getBoundingClientRect();
      check('it sits directly under the player toggle', Math.abs(a.left - b.left) < 1 && b.top > a.bottom && b.top - a.bottom < 12, `${Math.round(b.top - a.bottom)}px below`);
    }

    const cam = w.getOutputCamera();
    const canvas = w.renderer.domElement;
    const sizeBefore = [canvas.clientWidth, canvas.clientHeight];

    present?.click();
    await frames(2);

    check('body is marked presenting', document.body.classList.contains('presenting'));
    // Not rendered at all — its own display or an ancestor's; computed style
    // on the element alone would miss the ancestor case.
    const hidden = (el) => !el || el.getClientRects().length === 0;
    check('the control panel is hidden', hidden(document.querySelector('.lil-gui.root')));
    check('the left panel is hidden', hidden(document.querySelector('.wrapper .wrapper')));
    check('the toolbar is hidden', hidden(document.querySelector('body > .wrapper:not(:has(#three-particles-editor))')));
    check('the player buttons are hidden', hidden(toggle) && hidden(present));
    check('the frame counter stays', !hidden(document.querySelector('.stats')));

    // Two displays, two rules (fitPlayerCanvas). Held in the hand, the canvas
    // is the whole window and the camera covers it, cropped rather than
    // barred. On a desktop the whole composed frame is shown: the canvas cut
    // to the frame's shape and centred, black at the sides, the preset lens.
    const handheld = navigator.maxTouchPoints > 0;
    const windowAspectNow = window.innerWidth / window.innerHeight;
    const presetAspect = cam?.userData.presetAspect || windowAspectNow;
    const presetFov = cam?.userData.presetFov ?? cam?.fov;
    const expected = handheld
      ? { w: window.innerWidth, h: window.innerHeight }
      : windowAspectNow > presetAspect
        ? { w: Math.round(window.innerHeight * presetAspect), h: window.innerHeight }
        : { w: window.innerWidth, h: Math.round(window.innerWidth / presetAspect) };
    check(handheld ? 'the canvas covers the window' : 'the canvas is cut to the composed frame', Math.abs(canvas.clientWidth - expected.w) <= 1 && Math.abs(canvas.clientHeight - expected.h) <= 1, `${canvas.clientWidth}x${canvas.clientHeight}, expected ${expected.w}x${expected.h} in ${window.innerWidth}x${window.innerHeight}`);
    const canvasRect = canvas.getBoundingClientRect();
    check('the canvas is centred in the window', Math.abs(canvasRect.left + canvasRect.width / 2 - window.innerWidth / 2) <= 1 && Math.abs(canvasRect.top + canvasRect.height / 2 - window.innerHeight / 2) <= 1, `centre ${Math.round(canvasRect.left + canvasRect.width / 2)},${Math.round(canvasRect.top + canvasRect.height / 2)} in ${window.innerWidth}x${window.innerHeight}`);
    check('the black at the sides is the page, not the canvas', getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)' && getComputedStyle(canvas.parentElement).backgroundColor === 'rgb(0, 0, 0)', `${getComputedStyle(document.body).backgroundColor} / ${getComputedStyle(canvas.parentElement).backgroundColor}`);
    const canvasAspect = canvas.clientWidth / canvas.clientHeight;
    check('the camera takes the canvas\'s aspect while presenting', Math.abs((cam?.aspect ?? 0) - canvasAspect) < 1e-3, `${cam?.aspect.toFixed(3)} vs ${canvasAspect.toFixed(3)}`);
    const expectedFov = handheld && windowAspectNow > presetAspect ? (180 / Math.PI) * 2 * Math.atan(Math.tan((presetFov * Math.PI) / 360) * (presetAspect / windowAspectNow)) : presetFov;
    check(handheld ? 'the field of view covers the composed frame' : 'the lens is the composed frame\'s', Math.abs((cam?.fov ?? 0) - expectedFov) < 0.01, `${cam?.fov.toFixed(2)} vs ${expectedFov.toFixed(2)} (preset ${presetFov}, aspect ${presetAspect.toFixed(3)})`);
    // The rendered image is the composed frame: the same lens and aspect the
    // editor's preview draws (outputAspect), so nothing is cropped away.
    check('nothing of the composition is cropped', handheld || (Math.abs((cam?.aspect ?? 0) - presetAspect) < 5e-3 && Math.abs((cam?.fov ?? 0) - presetFov) < 1e-6), `aspect ${cam?.aspect.toFixed(3)} vs preset ${presetAspect.toFixed(3)}`);

    check('the output goes through the encode once', w._ssr().postProcessing?.outputColorTransform === true);
    check('frames keep coming', await frames(3));
    check('the editor is not suspended while presenting', link.isSuspended() === false);
    check('orbit controls are off', w.controls.enabled === false);

    // A tap brings up the way out. Down then up, like a real finger: the
    // controls on the canvas capture the pointer on the way down and release
    // it on the way up, and an up on its own makes that release throw.
    // The mouse pointer (id 1) is the one pointer a synthetic event can name
    // that the browser considers active; a made-up touch id makes the canvas
    // controls' pointer capture throw, which a real finger never does.
    const tap = (type) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: 10, clientY: 10 }));
    tap('pointerdown');
    tap('pointerup');
    await settle(50);
    const bar = document.querySelector('.presentation-bar');
    check('a tap shows the exit bar', !!bar && bar.classList.contains('is-visible'));

    // The performance HUD rides on the bar: numbers, and levers that work.
    const perfButton = bar?.querySelector('.presentation-bar__perf');
    check('the bar offers the performance HUD', !!perfButton);
    const gyroButton = bar?.querySelector('.presentation-bar__gyro');
    check('the bar has a Gyro button', !!gyroButton && gyroButton.textContent.trim() === 'Gyro');
    const hud = window.__perfHud;
    perfButton?.click();
    await settle(700);
    check('the HUD is shown', !!hud && hud.isShown() && !!document.querySelector('.perf-hud') && !document.querySelector('.perf-hud').hidden);
    const text = hud ? hud.report() : '';
    check('the report names the piece and the pixels', /piece: example-1-1/.test(text) && /pixels: \d+×\d+/.test(text) && /^fps: /m.test(text));
    const beforeScale = w.renderer.getPixelRatio();
    const css = [canvas.clientWidth, canvas.clientHeight];
    w.setRenderScale(1);
    await frames(1);
    const buffer = w.renderer.getDrawingBufferSize(new w.THREE.Vector2());
    check('the scale lever changes the drawing buffer', Math.abs(buffer.x - css[0]) <= 1 && Math.abs(buffer.y - css[1]) <= 1, `${buffer.x}x${buffer.y} at scale 1 for ${css[0]}x${css[1]} css`);
    w.setRenderScale(beforeScale >= (window.devicePixelRatio || 1) ? Infinity : beforeScale);
    await frames(1);
    check('and back', Math.abs(w.renderer.getPixelRatio() - beforeScale) < 1e-6);
    hud?.hide();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frames(2);
    check('Escape leaves presentation', !document.body.classList.contains('presenting'));
    check('the canvas is back to the window', Math.abs(canvas.clientWidth - sizeBefore[0]) <= 1 && Math.abs(canvas.clientHeight - sizeBefore[1]) <= 1, `${canvas.clientWidth}x${canvas.clientHeight}`);
    check('the camera is back to its composed frame', Math.abs((cam?.aspect ?? 0) - (cam?.userData.presetAspect || window.innerWidth / window.innerHeight)) < 1e-3 && Math.abs((cam?.fov ?? 0) - (cam?.userData.presetFov ?? 0)) < 1e-6, `${cam?.aspect.toFixed(3)} fov ${cam?.fov}`);
    check('the encode goes back to the blit', w._ssr().postProcessing?.outputColorTransform === false);
    check('orbit controls are back', w.controls.enabled === true);
    check('the buttons are back', !hidden(document.querySelector('.presentation-toggle')));

    // ── Fit window: the frame takes the window's shape, so no bars ──────────
    const previousTab = [...document.querySelectorAll('[role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true');
    [...document.querySelectorAll('[role=tab]')].find((t) => /scene/i.test(t.textContent))?.click();
    await settle(300);
    const cameraItem = [...document.querySelectorAll('.item')].find((el) => /camera/i.test(el.querySelector('.title')?.textContent || ''));
    const chipsOf = () => [...(cameraItem?.querySelectorAll('.chips button') ?? [])];
    if (cameraItem && chipsOf().length === 0) cameraItem.querySelector('button.title')?.click();
    await settle(200);
    const labels = chipsOf().map((b) => b.textContent.trim());
    check('the frame offers an iPhone 17 Pro Max preset', labels.includes('iPhone 17 Pro Max'), labels.join(' | '));
    const fitChip = chipsOf().find((b) => b.textContent.trim() === 'Fit window');
    check('the frame offers Fit window', !!fitChip);
    fitChip?.click();
    await frames(2);
    const windowAspect = window.innerWidth / window.innerHeight;
    check('fit window sets the camera to the window\'s aspect', Math.abs((w.getOutputCamera()?.aspect ?? 0) - windowAspect) < 1e-3, `${w.getOutputCamera()?.aspect.toFixed(3)} vs ${windowAspect.toFixed(3)}`);
    document.querySelector('.presentation-toggle')?.click();
    await frames(2);
    check('presenting with fit window fills the window', Math.abs(canvas.clientWidth - window.innerWidth) <= 1 && Math.abs(canvas.clientHeight - window.innerHeight) <= 1, `${canvas.clientWidth}x${canvas.clientHeight} in ${window.innerWidth}x${window.innerHeight}`);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frames(2);
    previousTab?.click();
    await load();
    check('no runtime errors', errs.length === 0, errs.slice(0, 3).join(' | '));

    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`present: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * Shadows. The renderer has shadow maps on, the MESH particle material feeds
   * the shadow pass through castShadowPositionNode / receivedShadowPositionNode,
   * directional lights cast and point lights do not. The last two checks are
   * the picture itself: the artwork layer is rendered from above into an
   * offscreen target and read back with the sun's shadow.intensity at 1 and at
   * 0. A grazing sun over the frame's walls must darken the bed; with the frame
   * hidden, what is left is the particles shading each other, which must still
   * darken it. Readback rows are padded to 256 bytes, so the target is 512 wide.
   * The pane's own screenshots cannot do this: they show a stale WebGPU canvas.
   */
  const shadowReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const w = window.__world;
    const T = w.THREE;
    const r = w.renderer;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));

    check('shadow maps are on', r.shadowMap.enabled === true, `type ${r.shadowMap.type}`);

    const cfg = await fixture();
    const objs = cfg._editorData.sceneObjects.filter((o) => o.type !== 'DIRECTIONAL_LIGHT');
    // Only the sun lights this picture, so its shadow is what the readback measures.
    for (const o of objs) if (o.type === 'POINT_LIGHT') o.intensity = 0;
    const frame = objs.find((o) => o.type === 'FRAME');
    const fx = frame?.position.x ?? 0;
    const fy = frame?.position.y ?? 0;
    const fz = frame?.position.z ?? 0;
    const probeShadow = { enabled: true, mapSize: 1024, radius: 2, bias: -0.0005, normalBias: 0.02, intensity: 1 };
    const probe = {
      id: 'obj-sun-probe', type: 'DIRECTIONAL_LIGHT', name: 'Sun probe', visible: true,
      position: { x: fx + 12, y: fy + 5, z: fz }, target: { x: fx, y: fy, z: fz },
      color: '#ffffff', intensity: 3, shadow: probeShadow,
    };
    objs.push(probe);
    cfg._editorData.sceneObjects = objs;
    window.editor.load(cfg);
    await wait(2500); // let the bed fill

    const scene = w.scene;
    const sun = scene.children.find((o) => o.isDirectionalLight);
    const points = scene.children.filter((o) => o.isPointLight);
    check('the sun casts, point lights do not', !!sun && sun.castShadow && points.every((p) => !p.castShadow), `${points.length} point`);
    // The shadow's own settings ride on the light in the config.
    const storedSun = storedScene().find((o) => o.type === 'DIRECTIONAL_LIGHT');
    check('the light carries its shadow settings', storedSun?.shadow && Object.keys(storedSun.shadow).length === Object.keys(probeShadow).length, `${Object.keys(storedSun?.shadow ?? {}).length} of ${Object.keys(probeShadow).length} keys`);
    check(
      'and the renderer uses them',
      !!sun && sun.shadow.mapSize.x === 1024 && Math.abs(sun.shadow.radius - 2) < 1e-9 && Math.abs(sun.shadow.normalBias - 0.02) < 1e-9,
      sun ? `map ${sun.shadow.mapSize.x}, radius ${sun.shadow.radius}, normalBias ${sun.shadow.normalBias}` : 'no sun'
    );
    let particles = null;
    scene.traverse((o) => { if (o.geometry?.isInstancedBufferGeometry) particles = o; });
    check('mesh particles are in the shadow exchange', !!particles && particles.castShadow && particles.receiveShadow);
    check(
      'their material feeds the shadow pass',
      !!particles?.material.castShadowPositionNode && !!particles?.material.receivedShadowPositionNode
    );
    const frameMesh = scene.children.find((o) => o.isMesh && Array.isArray(o.material));
    check('the frame casts and receives', !!frameMesh && frameMesh.castShadow && frameMesh.receiveShadow);

    // Top-down readback of the artwork layer only (a fresh camera sees layer 0).
    const S = 512;
    const rt = new T.RenderTarget(S, S, { depthBuffer: true });
    const cam = new T.PerspectiveCamera(30, 1, 0.1, 100);
    cam.up.set(0, 0, -1);
    cam.position.set(fx, fy + 18, fz);
    cam.lookAt(fx, fy, fz);
    const mean = async () => {
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt);
      r.render(scene, cam);
      r.setRenderTarget(prev);
      const buf = await r.readRenderTargetPixelsAsync(rt, 0, 0, S, S);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 4) sum += buf[i] + buf[i + 1] + buf[i + 2];
      return sum / (buf.length / 4) / 3;
    };
    let lit = 0;
    let flat = 0;
    let litNoFrame = 0;
    let flatNoFrame = 0;
    if (sun) {
      sun.shadow.intensity = 1;
      lit = await mean();
      sun.shadow.intensity = 0;
      flat = await mean();
      if (frameMesh) {
        frameMesh.visible = false;
        flatNoFrame = await mean();
        sun.shadow.intensity = 1;
        litNoFrame = await mean();
        frameMesh.visible = true;
      }
      sun.shadow.intensity = 1;
    }
    rt.dispose();
    check(
      'a grazing sun over the walls darkens the bed',
      lit > 0 && lit < flat * 0.85,
      `${lit.toFixed(1)} with shadows, ${flat.toFixed(1)} without`
    );
    check(
      'particles shade each other',
      litNoFrame > 0 && litNoFrame < flatNoFrame * 0.97,
      `${litNoFrame.toFixed(1)} with, ${flatNoFrame.toFixed(1)} without, frame hidden`
    );

    // Off in the config means the light stops casting, not a shadow at zero.
    probe.shadow = { ...probeShadow, enabled: false };
    window.editor.load(cfg);
    await wait(1200);
    const sunOff = w.scene.children.find((o) => o.isDirectionalLight);
    check('shadow off in the config stops the sun casting', !!sunOff && sunOff.castShadow === false);

    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`shadow: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * Occlusion. Settings ride on the camera like SSR, and the pipeline composes
   * occlusion before reflections. Measured on the picture: the post pipeline is
   * rendered into an offscreen target and read back with the strength at the
   * camera's value and at zero — a uniform, so nothing recompiles in between —
   * and the occlusion view itself has to be neither blank nor black. Then off
   * has to mean off: no pass left in the graph.
   */
  const aoReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const w = window.__world;
    const T = w.THREE;
    const r = w.renderer;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));

    const cfg = await fixture();
    const cam = cfg._editorData.sceneObjects.find((o) => o.type === 'CAMERA');
    cam.ao = { ...(cam.ao ?? w.getAoSettings()), enabled: true, intensity: 0.9, radius: 0.6 };
    window.editor.load(cfg);
    await wait(2500);

    const live = w.getAoSettings();
    check('the camera hands its occlusion to the renderer', live.enabled === true && live.intensity === 0.9 && live.radius === 0.6, JSON.stringify(live));
    w.ensurePostPipeline();
    let ps = w._ssr();
    check('the pipeline is compiled with the occlusion pass', !!ps.aoPass && !!ps.denoisePass && /ao/.test(ps.pipelineKey), ps.pipelineKey);
    check('and still with reflections', !!ps.ssrPass && /ssr/.test(ps.pipelineKey), ps.pipelineKey);

    // The preview's pipeline runs at the preview box, not the canvas
    // (withDisplaySize in world.ts). Before it did, every pass was the whole
    // canvas — 6016×3018 for a 1360×2954 preview — and the editor ran at 19 fps
    // against 60 with SSR off. Needs a frame: the sizes are set when the
    // preview renders.
    {
      const link = window.__playerLink;
      const f0 = link.frames();
      const t0 = performance.now();
      while (link.frames() < f0 + 2 && performance.now() - t0 < 3000) await wait(50);
      ps = w._ssr();
      const pt = ps.previewTarget;
      const ssrRt = ps.ssrPass?._ssrRenderTarget;
      const canvas = r.getDrawingBufferSize(new T.Vector2());
      check('the preview\'s passes are the preview\'s size, not the canvas\'s (needs frames)', !!pt && !!ssrRt && ssrRt.width === pt.width && ssrRt.height === pt.height && pt.width < canvas.x, `ssr ${ssrRt?.width}x${ssrRt?.height} for a ${pt?.width}x${pt?.height} preview in a ${canvas.x}x${canvas.y} canvas`);
    }

    const S = 512;
    const rt = new T.RenderTarget(S, S, { depthBuffer: false });
    const mean = async () => {
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt);
      ps.postProcessing.render();
      r.setRenderTarget(prev);
      const buf = await r.readRenderTargetPixelsAsync(rt, 0, 0, S, S);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 4) sum += buf[i] + buf[i + 1] + buf[i + 2];
      return sum / (buf.length / 4) / 3;
    };
    const withAo = await mean();
    w.setAoSettings({ intensity: 0 });
    const without = await mean();
    w.setAoSettings({ intensity: 0.9 });
    check('occlusion darkens the picture', withAo > 0 && withAo < without * 0.97, `${withAo.toFixed(1)} with, ${without.toFixed(1)} without`);

    w.setSsrSettings({ debug: 'ao' });
    const map = await mean();
    w.setSsrSettings({ debug: 'off' });
    check('the occlusion view is a map, not a flat', map > 255 * 0.2 && map < 255 * 0.98, `mean ${map.toFixed(1)}`);
    rt.dispose();

    w.setAoSettings({ enabled: false });
    w.ensurePostPipeline();
    ps = w._ssr();
    check('off leaves no pass in the graph', !ps.aoPass && !/ao/.test(ps.pipelineKey), ps.pipelineKey);
    w.setAoSettings({ enabled: true });
    w.ensurePostPipeline();
    check('and on brings it back', !!w._ssr().aoPass);

    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`ao: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };


  /**
   * Velocity stretch: a motion-blur streak on MESH particles, GPU path only.
   * The compute kernel writes each particle's real speed (from its
   * displacement, so curl noise counts) into particleState.w and the mesh
   * material lengthens the shape along its heading by speed × seconds. Checked
   * by structure, by a config round trip, and by an off-screen readback of the
   * output camera's view — the readback pair needs frames, so it can fail
   * falsely while the automation panel is hidden.
   */
  const stretchReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const w = window.__world;
    const T = w.THREE;
    const r = w.renderer;
    const scene = w.scene;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const particles = () => {
      let p = null;
      scene.traverse((o) => { if (o.geometry?.isInstancedBufferGeometry) p = o; });
      return p;
    };

    const cfg = await fixture();
    delete cfg.renderer.mesh.velocityStretch;
    window.editor.load(cfg);
    await wait(2500);
    const live = window.editor.getCurrentParticleSystemConfig();
    check('a config without the key loads as 0', live.renderer.mesh.velocityStretch === 0, `${live.renderer.mesh.velocityStretch}`);
    check('a plain build records no stretch', particles()?.material.userData.velocityStretch === 0);

    // The output camera's view, square and zoomed in so a particle covers pixels.
    const outCam = scene.children.find((o) => o.isPerspectiveCamera);
    const S = 512;
    const rt = new T.RenderTarget(S, S, { depthBuffer: true });
    const cam = outCam.clone();
    cam.aspect = 1;
    cam.fov = 12;
    cam.updateProjectionMatrix();
    const grab = async () => {
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt);
      r.render(scene, cam);
      r.setRenderTarget(prev);
      return await r.readRenderTargetPixelsAsync(rt, 0, 0, S, S);
    };
    const plain = await grab();

    // Stretch on, with align to velocity off: the streak has to bring the heading with it.
    live.renderer.mesh.alignToVelocity = false;
    live.renderer.mesh.velocityStretch = 0.15;
    window.editor.reset();
    await wait(2500);
    const stretched = particles();
    check('the stretched build records it', stretched?.material.userData.velocityStretch === 0.15);
    check('stretch binds the heading without align to velocity', !!stretched?.geometry.attributes.instanceVelocity);
    check('the GPU path stays on', !!stretched?.geometry.attributes.instanceParticleState);
    const streaked = await grab();
    // Coverage is not compared: in a dense bed the streaks overlap each other
    // as much as they add, and the two grabs are different moments anyway.
    let changed = 0;
    for (let i = 0; i < plain.length; i += 4) {
      const a = plain[i] + plain[i + 1] + plain[i + 2];
      const b = streaked[i] + streaked[i + 1] + streaked[i + 2];
      if (Math.abs(a - b) > 60) changed++;
    }
    const px = plain.length / 4;
    check('the streaks change the picture (needs frames)', changed / px > 0.05, `${((changed / px) * 100).toFixed(1)}% of pixels`);
    rt.dispose();

    // Round trip: the value is part of the piece.
    const json = JSON.parse(window.editor.serialize());
    check('the value travels in the config', json.renderer?.mesh?.velocityStretch === 0.15, `${json.renderer?.mesh?.velocityStretch}`);
    window.editor.load(json);
    await wait(2000);
    const back = window.editor.getCurrentParticleSystemConfig();
    check(
      'and comes back on load',
      back.renderer.mesh.velocityStretch === 0.15 && particles()?.material.userData.velocityStretch === 0.15,
      `${back.renderer.mesh.velocityStretch} / ${particles()?.material.userData.velocityStretch}`
    );

    // A finger's push moves the particles but is not travel: the streak reads
    // the frame's own motion, with the shove taken out. On a phone a quick
    // finger is tens of units a second, and before this every box under it
    // was drawn as a long twitching streak. Stretch on, touch on, a hard push
    // fed straight to the system: the particles under it move, and none of
    // them reports the push as speed.
    // And a wall two units along the push: the finger presses the particles
    // against it. The wall holds — they stay inside — and it answers the push
    // as if the finger had pushed at no more than its speed cap: the
    // particles come back off the wall at up to dampen × that, not at the
    // hundreds of units a second the finger's overlapping samples add up to
    // (which came off the wall as a long streak), and not pinned dead
    // against it either.
    const touch = window.__touch;
    if (touch && back.touch) {
      back.touch = { ...back.touch, isActive: true, strength: 1 };
      const centre = touch.screenToWorld(0, 0);
      const wallX = centre.x + 2;
      const wall = (over = {}) => ({ isActive: true, mode: 'BOUNCE', position: { x: wallX, y: centre.y, z: centre.z }, normal: { x: -1, y: 0, z: 0 }, dampen: 0.5, lifetimeLoss: 0, recover: 1, ...over });
      // Feed a 40 u/s finger at the centre for 1.2 s against the given walls,
      // read the particles before, right after, and half a second later.
      const pushIntoWall = async (planes) => {
        const cfg = window.editor.getCurrentParticleSystemConfig();
        cfg.collisionPlanes = planes;
        window.editor.reset();
        await wait(2500);
        const g = particles().geometry;
        const readPositions = async () => new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceOffset));
        const readAlpha = async () => new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceColor));
        const before = await readPositions();
        const aliveBefore = await readAlpha();
        const push = 40;
        const t0 = performance.now();
        while (performance.now() - t0 < 1200) {
          touch.feed({ x: centre.x, y: centre.y, z: centre.z, radius: 4, vx: push, vy: 0, vz: 0 });
          await wait(40);
        }
        const after = await readPositions();
        const aliveAfter = await readAlpha();
        const st = new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceParticleState));
        touch.clear();
        await wait(500);
        const later = await readPositions();
        const aliveLater = await readAlpha();
        let pushed = 0, dx = 0, alive = 0, fast = 0, maxSpeed = 0;
        for (let i = 0; i < g.attributes.instanceOffset.count; i++) {
          if (aliveAfter[i * 4 + 3] <= 0.01) continue;
          alive++;
          const speed = st[i * 4 + 3];
          if (speed > maxSpeed) maxSpeed = speed;
          if (speed > 20) fast++;
          if (aliveBefore[i * 4 + 3] <= 0.01) continue;
          const ox = before[i * 4] - centre.x, oz = before[i * 4 + 2] - centre.z;
          if (ox * ox + oz * oz > 4) continue;
          pushed++;
          dx += after[i * 4] - before[i * 4];
        }
        const meanDx = pushed ? dx / pushed : 0;
        let through = 0, beyond = 0;
        for (let i = 0; i < g.attributes.instanceOffset.count; i++) {
          if (aliveAfter[i * 4 + 3] <= 0.01) continue;
          const over = after[i * 4] - wallX;
          if (over > 1) through++;
          if (over > beyond) beyond = over;
        }
        let atWall = 0, moved = 0;
        for (let i = 0; i < g.attributes.instanceOffset.count; i++) {
          if (aliveAfter[i * 4 + 3] <= 0.01 || aliveLater[i * 4 + 3] <= 0.01) continue;
          const x = after[i * 4];
          if (x < wallX - 0.4 || Math.abs(after[i * 4 + 2] - centre.z) > 2) continue;
          atWall++;
          moved += later[i * 4] - x;
        }
        return { push, pushed, meanDx, alive, fast, maxSpeed, through, beyond, atWall, meanBack: atWall ? moved / atWall : 0 };
      };

      const a = await pushIntoWall([wall()]);
      const cap = (back.touch.maxSpeed ?? 8) * 0.5;
      check('a finger\'s push moves the particles under it (needs frames)', a.pushed > 50 && a.meanDx > 1, `${a.pushed} particles, mean ${a.meanDx.toFixed(2)} along the push`);
      check('but is not read as speed by the stretch (needs frames)', a.alive > 1000 && a.fast === 0, `${a.fast} of ${a.alive} faster than 20 u/s, max ${a.maxSpeed.toFixed(1)} against a ${a.push} u/s push`);
      check('the wall holds against the finger (needs frames)', a.through === 0, `${a.through} more than a unit past it, furthest ${a.beyond.toFixed(2)}`);
      check('and gives back no more than the finger\'s pace (needs frames)', a.maxSpeed < cap + 2, `max ${a.maxSpeed.toFixed(1)} u/s off a ${a.push} u/s push, cap ${cap} + flow`);
      check('and they come back off it once the finger is gone (needs frames)', a.atWall > 30 && a.meanBack < -0.15, `${a.atWall} at the wall moved ${a.meanBack.toFixed(2)} along the push in half a second`);

      // Each wall answers with its own settings. `touchCap` is the most this
      // wall gives back of a finger's push: at 1 u/s (× dampen 0.5) the
      // particles come back at a walking pace against the same 40 u/s push.
      const b = await pushIntoWall([wall({ touchCap: 1 })]);
      check('a wall\'s own touchCap holds the finger\'s push down (needs frames)', b.through === 0 && b.maxSpeed < 0.5 + 2, `max ${b.maxSpeed.toFixed(1)} u/s off a ${b.push} u/s push, cap 0.5 + flow`);
      // `maxSpeed` is a ceiling on the speed anything leaves this wall with,
      // whatever pushed it there: 2 u/s where the default cap gave back 4.
      const c = await pushIntoWall([wall({ maxSpeed: 2 })]);
      check('a wall\'s own maxSpeed caps the speed off it (needs frames)', c.through === 0 && c.maxSpeed < 2.5, `max ${c.maxSpeed.toFixed(1)} u/s off a ${c.push} u/s push, ceiling 2`);
      // `recover` is the wall's own: a bounce off a 0.05 s wall is over
      // before the half second is up, so the particles hardly come back —
      // even with another bounce wall in the piece set to a whole second
      // (the recover used to be one system-wide maximum).
      const d = await pushIntoWall([wall({ recover: 0.05 }), wall({ position: { x: centre.x - 40, y: centre.y, z: centre.z }, normal: { x: 1, y: 0, z: 0 }, recover: 1 })]);
      check('a wall\'s own recover ends its bounces at its own pace (needs frames)', d.atWall > 30 && d.meanBack > -0.6 && d.through === 0, `${d.atWall} at the 0.05 s wall moved ${d.meanBack.toFixed(2)} along the push in half a second (a 1 s wall: ${a.meanBack.toFixed(2)})`);

      // The walls' own settings travel in the config and reach the panel.
      const json2 = JSON.parse(window.editor.serialize());
      check('the wall\'s own settings travel in the config', json2.collisionPlanes?.[0]?.recover === 0.05 && json2.collisionPlanes?.[1]?.recover === 1, JSON.stringify(json2.collisionPlanes?.map((cp) => [cp.recover, cp.touchCap, cp.maxSpeed])));
    }
    check('no runtime errors', errs.length === 0, errs.slice(0, 3).join(' | '));

    const failed = lines.filter((s) => s.startsWith('FAIL')).length;
    return [`stretch: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };


  /**
   * The trail on the GPU: with WebGPU compute available, a TRAIL piece runs
   * the GPU simulation and its ribbon is built in the vertex stage from the
   * history ring the kernel records — no CPU-built ribbon mesh at all.
   * Checked by structure, by an off-screen readback (needs frames), by a
   * config round trip, and by the absence of shader errors.
   */
  const trailReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const w = window.__world;
    const T = w.THREE;
    const r = w.renderer;
    const scene = w.scene;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const errBefore = errs.length;

    const cfg = await fixture();
    cfg.maxParticles = 20000;
    cfg.renderer.rendererType = 'TRAIL';
    cfg.renderer.trail = {
      length: 24, width: 0.04, minVertexDistance: 0, maxTime: 0, smoothing: true, smoothingSubdivisions: 3, twistPrevention: false,
      widthOverTrail: { type: 'BEZIER', scale: 1, bezierPoints: [{ x: 0, y: 1, percentage: 0 }, { x: 1, y: 0, percentage: 1 }] },
      opacityOverTrail: { type: 'BEZIER', scale: 1, bezierPoints: [{ x: 0, y: 1, percentage: 0 }, { x: 1, y: 0, percentage: 1 }] },
    };
    window.editor.load(cfg);
    await wait(3000);

    let particles = null;
    scene.traverse((o) => { if (o.geometry?.isInstancedBufferGeometry) particles = o; });
    let cpuRibbon = null;
    scene.traverse((o) => { if (o.geometry?.attributes?.trailNext) cpuRibbon = o; });
    check('a trail runs on the GPU path', !!particles?.geometry.attributes.instanceParticleState, particles ? Object.keys(particles.geometry.attributes).join(',') : 'no instanced mesh');
    check('its ribbon is the GPU-built one', particles?.material.userData.gpuTrail === true, particles?.material.type);
    check('no CPU-built ribbon mesh in the scene', !cpuRibbon);
    check('the ring is bound (sample count rides in instanceVelocity)', !!particles?.geometry.attributes.instanceVelocity);
    // With smoothing the strip has subdivisions points per raw segment.
    check('the strip has two vertices per drawn point', particles?.geometry.attributes.position.count === ((24 - 1) * 3 + 1) * 2, `${particles?.geometry.attributes.position.count}`);
    // The panel shows the width ×100: a 0.04 ribbon reads 4.
    const trailFolder = [...document.querySelectorAll('.lil-gui')].find((g) => g.querySelector(':scope > .title')?.textContent.trim() === 'Trail');
    const widthRow = trailFolder && [...trailFolder.querySelectorAll('.controller.number')].find((c) => c.querySelector('.name')?.textContent.trim().startsWith('width'));
    check('the panel shows the width times a hundred', !!widthRow && Math.abs(parseFloat(widthRow.querySelector('input').value) - 4) < 1e-6, widthRow ? widthRow.querySelector('input').value : 'no width row');

    // The picture: something is drawn where the particles are (needs frames).
    const outCam = scene.children.find((o) => o.isPerspectiveCamera);
    const S = 512;
    const rt = new T.RenderTarget(S, S, { depthBuffer: true });
    const cam = outCam.clone();
    cam.aspect = 1;
    cam.updateProjectionMatrix();
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.render(scene, cam);
    r.setRenderTarget(prev);
    const buf = await r.readRenderTargetPixelsAsync(rt, 0, 0, S, S);
    rt.dispose();
    let lit = 0;
    for (let i = 0; i < buf.length; i += 4) if (buf[i] + buf[i + 1] + buf[i + 2] > 30) lit++;
    check('the ribbons draw (needs frames)', lit / (buf.length / 4) > 0.02, `${((lit / (buf.length / 4)) * 100).toFixed(1)}% lit`);

    // The trail's settings are part of the piece and come back the same.
    const json = JSON.parse(window.editor.serialize());
    check('the trail settings travel in the config', json.renderer?.rendererType === 'TRAIL' && json.renderer?.trail?.length === 24 && json.renderer?.trail?.smoothing === true);
    check('no runtime errors', errs.length === errBefore, errs.slice(errBefore, errBefore + 3).join(' | '));

    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`trail: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };


  /**
   * Collision planes on the GPU: applied at the end of the frame against the
   * particle's real motion. With WIP-Test-2's four walls switched to BOUNCE
   * the particles stay inside the box and leave the walls; with CLAMP they
   * stay inside and keep sliding rather than freezing; KILL keeps killing.
   * Reads the compute buffers back, so it needs frames.
   */
  const collisionReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const w = window.__world;
    const r = w.renderer;
    const scene = w.scene;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const errBefore = errs.length;

    const walls = (mode) => [
      { isActive: true, mode, position: { x: -5.33, y: 0.25, z: -0.74 }, normal: { x: 1, y: 0, z: 0 }, dampen: 0.5, lifetimeLoss: 0, recover: 1 },
      { isActive: true, mode, position: { x: 5.4, y: 0, z: 0 }, normal: { x: -1, y: 0, z: 0 }, dampen: 0.5, lifetimeLoss: 0, recover: 1 },
      { isActive: true, mode, position: { x: 0, y: 0, z: -5.4 }, normal: { x: 0, y: 0, z: 1 }, dampen: 0.5, lifetimeLoss: 0, recover: 1 },
      { isActive: true, mode, position: { x: 0, y: 0, z: 6.4 }, normal: { x: 0, y: 0, z: -1 }, dampen: 0.5, lifetimeLoss: 0, recover: 1 },
    ];
    const particles = () => { let m = null; scene.traverse((o) => { if (o.geometry?.isInstancedBufferGeometry) m = o; }); return m; };
    const readBuffers = async () => {
      const g = particles().geometry;
      const [pb, vb, cb] = await Promise.all([r.getArrayBufferAsync(g.attributes.instanceOffset), r.getArrayBufferAsync(g.attributes.instanceVelocity), r.getArrayBufferAsync(g.attributes.instanceColor)]);
      return { pos: new Float32Array(pb), vel: new Float32Array(vb), col: new Float32Array(cb), n: g.attributes.instanceOffset.count };
    };
    // The box the walls enclose, in world units (the piece simulates in WORLD space).
    const inside = (x, z) => x > -5.33 - 0.05 && x < 5.4 + 0.05 && z > -5.4 - 0.05 && z < 6.4 + 0.05;
    const wallDist = (x, z) => Math.min(x + 5.33, 5.4 - x, z + 5.4, 6.4 - z);
    const outwardNormal = (x, z) => { const d = [x + 5.33, 5.4 - x, z + 5.4, 6.4 - z]; const k = d.indexOf(Math.min(...d)); return [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]][k]; };
    const measure = async () => {
      const a = await readBuffers();
      await wait(150);
      const b = await readBuffers();
      let alive = 0, outside = 0, nearWall = 0, leaving = 0, nearSpeedSum = 0;
      for (let i = 0; i < a.n; i++) {
        if (a.col[i * 4 + 3] <= 0.01 || b.col[i * 4 + 3] <= 0.01) continue;
        alive++;
        const x = b.pos[i * 4], z = b.pos[i * 4 + 2];
        if (!inside(x, z)) outside++;
        if (wallDist(x, z) < 0.4) {
          nearWall++;
          const n = outwardNormal(x, z);
          // A bounce leaves the particle with the damped reflection as its
          // velocity, away from the wall; it fades with `recover`, and the
          // field's push back toward the wall makes the next bounces small,
          // so the sign is the mark, not the size.
          if (b.vel[i * 4] * n[0] + b.vel[i * 4 + 2] * n[2] > 1e-4) leaving++;
          const dx = b.pos[i * 4] - a.pos[i * 4], dz = b.pos[i * 4 + 2] - a.pos[i * 4 + 2];
          nearSpeedSum += Math.hypot(dx, dz) / 0.15;
        }
      }
      return { alive, outsidePct: alive ? (100 * outside) / alive : 0, nearWall, leaving, nearSpeed: nearWall ? nearSpeedSum / nearWall : 0 };
    };

    const cfg = await fixture();
    cfg.maxParticles = 20000;
    cfg.collisionPlanes = walls('BOUNCE');
    window.editor.load(cfg);
    await wait(3500);
    check('the piece runs on the GPU path', !!particles()?.geometry.attributes.instanceParticleState);
    const bounce = await measure();
    check('BOUNCE keeps the particles inside the walls (needs frames)', bounce.outsidePct < 1, `${bounce.outsidePct.toFixed(2)}% of ${bounce.alive} outside`);
    check('and the ones that hit a wall carry a velocity away from it (needs frames)', bounce.nearWall > 20 && bounce.leaving >= 50, `${bounce.leaving} of ${bounce.nearWall} near a wall are leaving it`);

    const live = window.editor.getCurrentParticleSystemConfig();
    live.collisionPlanes = walls('CLAMP');
    window.editor.reset();
    await wait(3500);
    const clamp = await measure();
    check('CLAMP keeps the particles inside the walls (needs frames)', clamp.outsidePct < 1, `${clamp.outsidePct.toFixed(2)}% outside`);
    check('and they keep sliding along the wall rather than freezing (needs frames)', clamp.nearWall > 20 && clamp.nearSpeed > 0.05, `${clamp.nearWall} near a wall, mean speed ${clamp.nearSpeed.toFixed(3)}`);

    live.collisionPlanes = walls('KILL');
    window.editor.reset();
    await wait(3500);
    const kill = await measure();
    check('KILL leaves nothing outside (needs frames)', kill.outsidePct < 0.5, `${kill.outsidePct.toFixed(2)}% outside`);

    // A bounce mirrors the position across the plane; a particle born behind
    // a wall jumps units in one frame. The velocity stretch reads its speed
    // from the frame's travel, which must not include that jump — or every
    // such birth draws a streak dozens of units long out through the wall.
    live.collisionPlanes = walls('BOUNCE').map((cp) => ({ ...cp, position: { ...cp.position, x: cp.position.x * 0.36, z: cp.position.z * 0.75 } }));
    live.renderer.mesh.velocityStretch = 0.15;
    window.editor.reset();
    await wait(3500);
    // The speeds the stretch reads, over the live particles: the fastest and
    // the fastest thousandth.
    const speeds = async () => {
      const g = particles().geometry;
      const st = new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceParticleState));
      const col = new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceColor));
      const all = [];
      for (let i = 0; i < g.attributes.instanceOffset.count; i++) {
        if (col[i * 4 + 3] <= 0.01) continue;
        all.push(st[i * 4 + 3]);
      }
      all.sort((a, b) => a - b);
      return { alive: all.length, fast: all.filter((v) => v > 20).length, max: all[all.length - 1] ?? 0, p999: all[Math.floor(all.length * 0.999)] ?? 0 };
    };
    const withWalls = await speeds();
    check('a bounce\'s mirror jump is not read as speed by the stretch (needs frames)', withWalls.alive > 1000 && withWalls.fast === 0, `${withWalls.fast} of ${withWalls.alive} faster than 20 u/s, max ${withWalls.max.toFixed(1)}`);

    // A bounce leaves at the damped speed and is handed back to the field:
    // the particle's motion is vel + (1 − bounce) × flow with both fading, so
    // it is never faster than the reflection or the flow. Before this the
    // reflection was stored relative to the flow at the wall, and where the
    // field differed a step away the stale part showed as a burst of speed
    // off the wall — up to twice the flow. Same piece, walls off, is the
    // flow's own speed to compare against.
    live.collisionPlanes = [];
    window.editor.reset();
    await wait(3500);
    const noWalls = await speeds();
    check('a bounce never speeds a particle up (needs frames)', withWalls.alive > 1000 && noWalls.alive > 1000 && withWalls.p999 <= noWalls.p999 * 1.15 && withWalls.max <= noWalls.max * 1.25, `with walls max ${withWalls.max.toFixed(2)} / p99.9 ${withWalls.p999.toFixed(2)}, without ${noWalls.max.toFixed(2)} / ${noWalls.p999.toFixed(2)}`);
    live.renderer.mesh.velocityStretch = 0;

    // The recover time is part of the piece.
    const json = JSON.parse(window.editor.serialize());
    check('the recover time travels in the config', json.collisionPlanes?.every((cp) => cp.recover === 1), JSON.stringify(json.collisionPlanes?.map((cp) => cp.recover)));
    check('no runtime errors', errs.length === errBefore, errs.slice(errBefore, errBefore + 3).join(' | '));

    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`collision: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * Particle Color Instance, end to end: the spawn position → source texel
   * mapping through plane, scale and wrap. A motionless piece on a 4 × 2
   * rectangle with a still image source and white colour curves, so a
   * particle's colour in the GPU buffer is the texel it was born on. For
   * each plane (the emitter turned to lie in it) and each wrap at half scale,
   * the buffer is compared against a reference mapping computed here from
   * the same image (the library's conventions, restated in one place).
   */
  const colorInstanceReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const w = window.__world;
    const r = w.renderer;
    const scene = w.scene;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const errBefore = errs.length;
    const fix = await fixture();
    const flat = (y) => ({ bezierPoints: [{ x: 0, y, percentage: 0 }, { x: 1, y, percentage: 1 }] });
    const RECT = [4, 2];
    const piece = (rotation, ci) => {
      const c = structuredClone(fix);
      c.transform = { position: { x: 0, y: 0, z: 0 }, rotation, scale: { x: 1, y: 1, z: 1 } };
      c.simulationSpace = 'WORLD';
      c.startSpeed = { min: 0, max: 0 };
      c.startLifetime = { min: 30, max: 30 };
      c.startColor = { min: { r: 0, g: 0, b: 0 }, max: { r: 0, g: 0, b: 0 } };
      c.maxParticles = 3000;
      c.emission = { rateOverTime: 3000, bursts: [] };
      c.shape = { shape: 'RECTANGLE', rectangle: { scale: { x: RECT[0], y: RECT[1] } } };
      c.gravity = 0;
      c.noise = { ...(c.noise || {}), isActive: false };
      c.forceFields = [];
      c.collisionPlanes = [];
      c.touch = { ...(c.touch || {}), isActive: false };
      c.velocityOverLifetime = { linear: { x: { min: 0, max: 0 }, y: { min: 0, max: 0 }, z: { min: 0, max: 0 } }, orbital: { x: { min: 0, max: 0 }, y: { min: 0, max: 0 }, z: { min: 0, max: 0 } } };
      c.colorOverLifetime = { r: flat(1), g: flat(1), b: flat(1) };
      // The reference mapping needs a still: the built-in picture, whatever the piece itself colours from.
      c._editorData = { ...c._editorData, colorInstanceTextureId: 'DEFAULT_TEXTURE' };
      delete c._editorData.embeddedVideos;
      c.particleColorInstance = {
        ...(c.particleColorInstance || {}),
        isActive: true,
        plane: 'XZ',
        offset: { x: 0, y: 0, z: 0 },
        luminanceMap: { black: 0, white: 1 },
        area: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1 },
        wrap: 'ZERO',
        useAlphaForOpacity: false,
        useLuminanceForNoise: false,
        colorTweak: { saturation: 1, contrast: 1, hue: 0 },
        ...ci,
      };
      return c;
    };
    const particles = () => { let m = null; scene.traverse((o) => { if (o.geometry?.isInstancedBufferGeometry) m = o; }); return m; };
    const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

    // The source as the library reads a still image: native size, sRGB bytes.
    let source = null;
    const readSource = () => {
      const map = window.editor.getCurrentParticleSystemConfig().particleColorInstance?.map;
      const img = map?.image;
      if (!img) return null;
      const width = img.naturalWidth || img.videoWidth || img.width;
      const height = img.naturalHeight || img.videoHeight || img.height;
      const cv = document.createElement('canvas');
      cv.width = width; cv.height = height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      return { width, height, data: ctx.getImageData(0, 0, width, height).data };
    };
    // The reference: the library's conventions, restated.
    const refUv = (plane, scale, wrap, offset, x, y, z) => {
      const dx = x - offset[0], dy = y - offset[1], dz = z - offset[2];
      let a, d;
      if (plane === 'XY') { a = dx; d = -dy; } else if (plane === 'YZ') { a = -dz; d = -dy; } else { a = dx; d = dz; }
      const u = a / RECT[0] / scale[0] + 0.5;
      const v = d / RECT[1] / scale[1] + 0.5;
      const wrapT = (t) => {
        if (wrap === 'REPEAT') return t - Math.floor(t);
        if (wrap === 'MIRROR') { const m = t - 2 * Math.floor(t / 2); return m > 1 ? 2 - m : m; }
        if (wrap === 'STRETCH') return Math.min(1, Math.max(0, t));
        return t;
      };
      if (wrap === 'ZERO' && (u < 0 || u > 1 || v < 0 || v > 1)) return null;
      return [wrapT(u), wrapT(v)];
    };
    const expectedColour = (uv) => {
      if (!uv) return [0, 0, 0];
      const px = Math.min(source.width - 1, (uv[0] * source.width) | 0);
      const py = Math.min(source.height - 1, (uv[1] * source.height) | 0);
      const o = (py * source.width + px) * 4;
      return [toLinear(source.data[o] / 255), toLinear(source.data[o + 1] / 255), toLinear(source.data[o + 2] / 255)];
    };

    const run = async (label, rotation, ci, editorData = {}) => {
      const c = piece(rotation, ci);
      Object.assign(c._editorData, editorData);
      window.editor.load(c);
      await wait(1600);
      if (!source) source = readSource();
      const g = particles()?.geometry;
      if (!g || !source) { check(label, false, !g ? 'no particle mesh' : 'no source image'); return null; }
      const pos = new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceOffset));
      const col = new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceColor));
      const plane = ci.plane || 'XZ';
      const scale = [ci.scale?.x ?? 1, ci.scale?.y ?? 1];
      const wrap = ci.wrap || 'ZERO';
      const offset = [ci.offset?.x ?? 0, ci.offset?.y ?? 0, ci.offset?.z ?? 0];
      let alive = 0, match = 0, black = 0, maxAbsX = 0, maxAbsZ = 0;
      const distinct = new Set();
      for (let i = 0; i < g.attributes.instanceOffset.count; i++) {
        if (col[i * 4 + 3] <= 0.01) continue;
        alive++;
        maxAbsX = Math.max(maxAbsX, Math.abs(pos[i * 4]));
        maxAbsZ = Math.max(maxAbsZ, Math.abs(pos[i * 4 + 2]));
        const want = expectedColour(refUv(plane, scale, wrap, offset, pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2]));
        const got = [col[i * 4], col[i * 4 + 1], col[i * 4 + 2]];
        if (got.every((c, k) => Math.abs(c - want[k]) < 0.02)) match++;
        if (got.every((c) => c < 0.005)) black++;
        distinct.add(got.map((c) => Math.round(c * 20)).join(','));
      }
      // Texel-edge births can round differently between the CPU's doubles and
      // the buffer's floats; the mapping is right when nearly all agree.
      const ratio = alive ? match / alive : 0;
      check(label, alive > 500 && ratio >= 0.97, `${match}/${alive} match the reference, ${distinct.size} colours, ${black} black`);
      return { alive, match, black, distinct: distinct.size, maxAbsX, maxAbsZ };
    };

    const xz = await run('XZ: the texel under (x, z), the top-down piece', { x: 90, y: 0, z: 0 }, { plane: 'XZ' });
    check('the source is not flat (colours differ across the area)', !!xz && xz.distinct > 10, `${xz?.distinct} colours`);
    await run('XY: a wall facing +Z, columns along +X, rows along −Y', { x: 0, y: 0, z: 0 }, { plane: 'XY' });
    await run('YZ: a wall facing +X, columns along −Z, rows along −Y', { x: 0, y: 90, z: 0 }, { plane: 'YZ' });
    await run('scale 2 shows the middle half of the source', { x: 90, y: 0, z: 0 }, { plane: 'XZ', scale: { x: 2, y: 2 } });
    // Under ZERO at half scale the source covers the middle quarter of the
    // 4 × 2 rectangle: |x| ≤ 1, |z| ≤ 0.5. Births land only there (the
    // budget goes to the picture); with that off, a birth off the source is
    // nothing — invisible, so it does not count as alive here.
    const zero = await run('scale 0.5, ZERO: every birth lands on the source', { x: 90, y: 0, z: 0 }, { plane: 'XZ', scale: { x: 0.5, y: 0.5 }, wrap: 'ZERO' });
    check('and all of them inside its footprint, |x| ≤ 1, |z| ≤ 0.5', !!zero && zero.alive > 2500 && zero.maxAbsX <= 1.02 && zero.maxAbsZ <= 0.52, `${zero?.alive} alive, |x| ≤ ${zero?.maxAbsX.toFixed(2)}, |z| ≤ ${zero?.maxAbsZ.toFixed(2)}`);
    const anywhere = await run('spawn only on the source off: births off it are nothing, invisible', { x: 90, y: 0, z: 0 }, { plane: 'XZ', scale: { x: 0.5, y: 0.5 }, wrap: 'ZERO', spawnOnSource: false });
    // (The black ones that do show are the painting's own dark texels.)
    check('so a quarter of the births show', !!anywhere && anywhere.alive > 3000 * 0.15 && anywhere.alive < 3000 * 0.35, `${anywhere?.alive} visible of 3000`);
    await run('scale 0.5, REPEAT: the source tiles', { x: 90, y: 0, z: 0 }, { plane: 'XZ', scale: { x: 0.5, y: 0.5 }, wrap: 'REPEAT' });
    await run('scale 0.5, MIRROR: every other tile flipped', { x: 90, y: 0, z: 0 }, { plane: 'XZ', scale: { x: 0.5, y: 0.5 }, wrap: 'MIRROR' });
    await run('scale 0.5, STRETCH: the edge texel runs on', { x: 90, y: 0, z: 0 }, { plane: 'XZ', scale: { x: 0.5, y: 0.5 }, wrap: 'STRETCH' });
    await run('offset 1 / 0.5 moves the source off the emitter', { x: 90, y: 0, z: 0 }, { plane: 'XZ', offset: { x: 1, y: 0, z: 0.5 } });

    // ── Live: a lever moved in the panel recolours the particles already out, no rebuild ──
    // The XZ piece again, then the panel's own controls (the same path a hand
    // takes): scale down and mirror. The mesh must be the same object, the
    // particles must stay where they are, and their colours must follow the
    // new mapping — read back straight from the GPU buffers.
    {
      window.editor.load(piece({ x: 90, y: 0, z: 0 }, { plane: 'XZ' }));
      await wait(1600);
      const meshBefore = particles();
      const g = meshBefore?.geometry;
      const posBefore = g ? new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceOffset)) : null;
      const colBefore = g ? new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceColor)) : null;
      const gui = document.querySelector('.lil-gui.root');
      const controlOf = (name) => [...(gui?.querySelectorAll('.controller') ?? [])].find((c) => c.querySelector('.name')?.textContent.trim() === name);
      // lil-gui: a number controller takes its input's value; an option
      // controller reads selectedIndex, its options labelled by display name.
      const setControl = (name, value) => {
        const c = controlOf(name);
        const select = c?.querySelector('select');
        if (select) {
          const index = [...select.options].findIndex((o) => o.textContent.trim().toLowerCase().startsWith(String(value).toLowerCase()));
          if (index < 0) return false;
          select.selectedIndex = index;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        const el = c?.querySelector('input');
        if (!el) return false;
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const tasks = [];
      const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) tasks.push(Math.round(e.duration)); });
      obs.observe({ entryTypes: ['longtask'] });
      const set1 = setControl('x (across)', 0.5);
      const set2 = setControl('y (down)', 0.5);
      const set3 = setControl('outside the source', 'mirror');
      await wait(400);
      obs.disconnect();
      check('the panel controls were reached', set1 && set2 && set3);
      const live = window.editor.getCurrentParticleSystemConfig().particleColorInstance;
      check('the config took the levers', live.scale?.x === 0.5 && live.scale?.y === 0.5 && live.wrap === 'MIRROR', JSON.stringify({ scale: live.scale, wrap: live.wrap }));
      const meshAfter = particles();
      check('no rebuild: the particle mesh is the same object', !!meshBefore && meshAfter === meshBefore);
      if (g && posBefore && colBefore && meshAfter === meshBefore) {
        const posAfter = new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceOffset));
        const colAfter = new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceColor));
        let alive = 0, stayed = 0, recoloured = 0, match = 0;
        for (let i = 0; i < g.attributes.instanceOffset.count; i++) {
          if (colBefore[i * 4 + 3] <= 0.01 || colAfter[i * 4 + 3] <= 0.01) continue;
          alive++;
          if (Math.abs(posAfter[i * 4] - posBefore[i * 4]) < 1e-4 && Math.abs(posAfter[i * 4 + 2] - posBefore[i * 4 + 2]) < 1e-4) stayed++;
          const want = expectedColour(refUv('XZ', [0.5, 0.5], 'MIRROR', [0, 0, 0], posAfter[i * 4], posAfter[i * 4 + 1], posAfter[i * 4 + 2]));
          const got = [colAfter[i * 4], colAfter[i * 4 + 1], colAfter[i * 4 + 2]];
          if (got.every((c, k) => Math.abs(c - want[k]) < 0.02)) match++;
          if (got.some((c, k) => Math.abs(c - colBefore[i * 4 + k]) > 0.02)) recoloured++;
        }
        check('the particles stayed where they were', alive > 500 && stayed >= alive * 0.99, `${stayed}/${alive}`);
        check('and took the new mapping in place', alive > 500 && match >= alive * 0.97 && recoloured > alive * 0.3, `${match}/${alive} match the new reference, ${recoloured} changed colour`);
      }
      check('no long task from the change (needs a real window)', tasks.every((t) => t < 120), tasks.join(',') || 'none');
    }

    // ── The debug plane: the source laid where it maps, and the handle ──────
    const cameraBefore = { pos: w.camera.position.clone(), target: w.controls.target.clone() };
    await run('with the debug plane shown the mapping is unchanged', { x: 90, y: 0, z: 0 }, { plane: 'XZ', offset: { x: 1, y: 0, z: 0.5 } }, { showColorSourceDebug: true });
    await wait(200);
    const debug = scene.getObjectByName('color-source-debug');
    check('the debug plane is in the scene and shown', !!debug && debug.visible);
    if (debug) {
      const T = w.THREE;
      const artwork = new T.Layers();
      artwork.set(0);
      const leaks = [];
      debug.traverse((o) => { if (o.layers.test(artwork)) leaks.push(o.name || o.type); });
      check('it is furniture: nothing of it on the artwork layer', leaks.length === 0, leaks.slice(0, 3).join(','));
      const plane = debug.getObjectByName('color-source-debug-plane');
      const frame = debug.getObjectByName('color-source-debug-frame');
      const label = debug.getObjectByName('color-source-debug-label');
      check('the image plane sits in the depth of the space and is see-through', !!plane && plane.material.depthTest === true && plane.material.depthWrite === false && plane.material.transparent === true && !!plane.material.opacityNode, plane ? `depthTest ${plane.material.depthTest}, depthWrite ${plane.material.depthWrite}` : 'no plane');
      check('a green frame and a label mark it', !!frame && frame.isLineSegments && frame.material.color.getHex() === 0x33ff88 && !!label && label.isSprite, `${frame?.type} ${frame?.material.color.getHexString()} ${label?.type}`);
      const box = debug.getObjectByName('color-source-debug-box');
      check('the frame is the mapped area, 4 × 2', !!box && Math.abs(box.scale.x - 4) < 1e-3 && Math.abs(box.scale.y - 2) < 1e-3, `${box?.scale.x} × ${box?.scale.y}`);
      check('it lies on the XZ plane at the emitter plus the offset', Math.abs(debug.rotation.x + Math.PI / 2) < 1e-6 && Math.abs(debug.position.x - 1) < 1e-6 && Math.abs(debug.position.z - 0.5) < 1e-6, `rot ${debug.rotation.x.toFixed(3)} at ${debug.position.x}, ${debug.position.z}`);

      // Click it, drag its handle, and the offset follows.
      window.editor.resetCamera();
      await wait(300);
      const canvas = r.domElement;
      const fire = (type, x, y) =>
        canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true, bubbles: true, cancelable: true }));
      const clientOf = (v) => {
        const p = v.clone().project(w.camera);
        const b = w.canvasBounds();
        return [b.left + ((p.x + 1) / 2) * b.width, b.top + ((1 - p.y) / 2) * b.height];
      };
      const [cx, cy] = clientOf(debug.getWorldPosition(new T.Vector3()));
      fire('pointerdown', cx, cy);
      fire('pointerup', cx, cy);
      await wait(50);
      const root = scene.children.find((o) => o.isTransformControlsRoot && o.controls?.object === debug);
      const controls = root?.controls;
      check('clicking the plane attaches a gizmo to it', !!controls && debug.userData.selected === true);
      if (controls) {
        check('the gizmo moves only along the plane\'s own axes (no Y on XZ)', controls.showX === true && controls.showY === false && controls.showZ === true, `x ${controls.showX} y ${controls.showY} z ${controls.showZ}`);
        let hit = null;
        for (let rad = 0; rad <= 80 && !hit; rad += 4) {
          for (let a = 0; a < 360 && !hit; a += 30) {
            const x = cx + rad * Math.cos((a * Math.PI) / 180);
            const y = cy + rad * Math.sin((a * Math.PI) / 180);
            fire('pointermove', x, y);
            if (controls.axis) hit = { x, y, axis: controls.axis };
          }
        }
        check('hovering finds a handle', !!hit, hit ? hit.axis : 'nothing within 80px');
        if (hit) {
          const before = JSON.stringify(window.editor.getCurrentParticleSystemConfig().particleColorInstance.offset);
          const events = [];
          const unwatch = window.editor.watchDocument((e) => events.push(e));
          fire('pointerdown', hit.x, hit.y);
          fire('pointermove', hit.x + 40, hit.y + 25);
          fire('pointermove', hit.x + 80, hit.y + 50);
          fire('pointerup', hit.x + 80, hit.y + 50);
          await wait(250);
          const after = window.editor.getCurrentParticleSystemConfig().particleColorInstance.offset;
          check('dragging the handle rewrites the offset', JSON.stringify(after) !== before && Math.abs(after.y) < 1e-6, `${before} → ${JSON.stringify(after)}`);
          check('orbit controls are back after the drag', w.controls.enabled === true);
          unwatch();
          check('the drag announces particleColorInstance.offset', events.some((e) => e.scope === 'particle' && e.path === 'particleColorInstance.offset' && e.source === 'gizmo'), `${events.length} events`);
        }
      }
      // It draws: the editor camera, rendered offscreen, shows more green
      // (frame, label, tinted image) with the plane than without.
      const S = 512;
      const rt = new T.RenderTarget(S, S, { depthBuffer: true });
      const greenPixels = async () => {
        const prev = r.getRenderTarget();
        r.setRenderTarget(rt);
        r.render(scene, w.camera);
        r.setRenderTarget(prev);
        const buf = await r.readRenderTargetPixelsAsync(rt, 0, 0, S, S);
        let green = 0;
        for (let i = 0; i < buf.length; i += 4) if (buf[i + 1] > buf[i] + 40 && buf[i + 1] > buf[i + 2] + 40) green++;
        return green;
      };
      const shownGreen = await greenPixels();
      debug.visible = false;
      const hiddenGreen = await greenPixels();
      debug.visible = true;
      rt.dispose();
      check('the plane, frame and label are drawn (needs frames)', shownGreen > hiddenGreen + 200, `${shownGreen} green pixels shown, ${hiddenGreen} hidden`);

      // Off again from the flag, as the Helper section would do it.
      window.editor.getCurrentParticleSystemConfig()._editorData.showColorSourceDebug = false;
      await wait(150);
      check('clearing the flag hides it and drops the handle', debug.visible === false && debug.userData.selected === false);
    }
    w.camera.position.copy(cameraBefore.pos);
    w.controls.target.copy(cameraBefore.target);
    w.controls.update();

    // The levers travel in the config, and only when they leave the default.
    window.editor.load(piece({ x: 0, y: 0, z: 0 }, { plane: 'XY', scale: { x: 0.5, y: 0.5 }, wrap: 'STRETCH', offset: { x: 1, y: 0.5, z: 0 } }));
    await wait(400);
    const json = JSON.parse(window.editor.serialize());
    const pci = json.particleColorInstance || {};
    check('plane, scale, wrap and offset travel in the config', pci.plane === 'XY' && pci.scale?.x === 0.5 && pci.scale?.y === 0.5 && pci.wrap === 'STRETCH' && pci.offset?.x === 1 && pci.offset?.y === 0.5, JSON.stringify({ plane: pci.plane, scale: pci.scale, wrap: pci.wrap, offset: pci.offset }));
    const gui = document.querySelector('.lil-gui.root');
    const names = [...(gui?.querySelectorAll('.name') ?? [])].map((n) => n.textContent.trim());
    check('the panel offers plane, scale, the outside-the-source choice, spawn-on-source, the offset and the debug toggle', ['plane', 'x (across)', 'y (down)', 'outside the source', 'spawn only on the source', 'show source (debug)', 'Show colour source (debug)'].every((n) => names.includes(n)), names.filter((n) => /plane|across|down|outside|spawn|debug/.test(n)).join(' | '));

    await load();
    check('no runtime errors', errs.length === errBefore, errs.slice(errBefore, errBefore + 3).join(' | '));
    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`colorInstance: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * The curl noise field: its base noise (simplex or classic Perlin), its
   * drift, and their levers. A still piece flows through the field; the
   * field's shape is read from the GPU as the particles' displacement per
   * frame, binned over the emitter, and compared between two moments: a
   * still field (drift 0) keeps its shape, a fast-drifting one does not.
   * Both noises must be coherent flows of about the same speed.
   */
  const noiseReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const w = window.__world;
    const r = w.renderer;
    const scene = w.scene;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const errBefore = errs.length;
    const link = window.__playerLink;
    const frames = async (n, ms = 4000) => {
      const start = link.frames();
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        if (link.frames() >= start + n) return true;
        await wait(30);
      }
      return false;
    };
    const fix = await fixture();
    const piece = (noise) => {
      const c = structuredClone(fix);
      c.transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 90, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
      c.simulationSpace = 'WORLD';
      c.startSpeed = { min: 0, max: 0 };
      c.startLifetime = { min: 40, max: 40 };
      c.maxParticles = 4000;
      c.emission = { rateOverTime: 4000, bursts: [] };
      c.shape = { shape: 'RECTANGLE', rectangle: { scale: { x: 6, y: 6 } } };
      c.gravity = 0;
      c.forceFields = [];
      c.collisionPlanes = [];
      c.touch = { ...(c.touch || {}), isActive: false };
      c.particleColorInstance = { ...(c.particleColorInstance || {}), isActive: false, useLuminanceForNoise: false };
      c.velocityOverLifetime = { linear: { x: { min: 0, max: 0 }, y: { min: 0, max: 0 }, z: { min: 0, max: 0 } }, orbital: { x: { min: 0, max: 0 }, y: { min: 0, max: 0 }, z: { min: 0, max: 0 } } };
      // Slow enough that a bin keeps its population between two reads a second apart.
      c.noise = { isActive: true, useRandomOffset: false, curl: true, strength: 0.25, frequency: 0.5, octaves: 1, positionAmount: 1, rotationAmount: 0, sizeAmount: 0, influence: { x: 1, y: 1, z: 1 }, type: 'SIMPLEX', drift: { x: 0, y: 0, z: 0 }, ...noise };
      return c;
    };
    const particles = () => { let m = null; scene.traverse((o) => { if (o.geometry?.isInstancedBufferGeometry) m = o; }); return m; };
    // The buffers exist on the GPU only once a frame has run; in a starved
    // pane that can take a while, so a read that finds none waits and tries again.
    const positions = async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const g = particles().geometry;
          const pos = new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceOffset));
          const col = new Float32Array(await r.getArrayBufferAsync(g.attributes.instanceColor));
          return { pos, col, n: g.attributes.instanceOffset.count };
        } catch (e) {
          await frames(1, 1500);
        }
      }
      throw new Error('particle buffers never reached the GPU');
    };
    // The field's shape: mean displacement per 1 × 1 bin over the 6 × 6 emitter, from two reads a couple of frames apart.
    const shape = async () => {
      const a = await positions();
      await frames(2);
      const b = await positions();
      const bins = new Map();
      let speedSq = 0, moved = 0;
      let coherent = 0, pairs = 0;
      const sample = [];
      for (let i = 0; i < a.n; i++) {
        if (a.col[i * 4 + 3] <= 0.01 || b.col[i * 4 + 3] <= 0.01) continue;
        const dx = b.pos[i * 4] - a.pos[i * 4], dy = b.pos[i * 4 + 1] - a.pos[i * 4 + 1], dz = b.pos[i * 4 + 2] - a.pos[i * 4 + 2];
        const l = Math.hypot(dx, dy, dz);
        if (l < 1e-6) continue;
        moved++;
        speedSq += l * l;
        const key = `${Math.floor(a.pos[i * 4])},${Math.floor(a.pos[i * 4 + 2])}`;
        const bin = bins.get(key) || { x: 0, y: 0, z: 0, n: 0 };
        bin.x += dx / l; bin.y += dy / l; bin.z += dz / l; bin.n++;
        bins.set(key, bin);
        if (sample.length < 400) sample.push({ x: a.pos[i * 4], z: a.pos[i * 4 + 2], dx: dx / l, dy: dy / l, dz: dz / l });
      }
      // Neighbours within 0.3 move the same way in a flow field.
      for (let i = 0; i < sample.length; i++) for (let j = i + 1; j < sample.length; j++) {
        const p = sample[i], q = sample[j];
        if (Math.hypot(p.x - q.x, p.z - q.z) > 0.3) continue;
        coherent += p.dx * q.dx + p.dy * q.dy + p.dz * q.dz; pairs++;
      }
      return { bins, moved, rms: Math.sqrt(speedSq / Math.max(1, moved)), coherence: pairs ? coherent / pairs : 0, pairs };
    };
    const compare = (s1, s2) => {
      let dot = 0, n = 0;
      for (const [k, b1] of s1.bins) {
        const b2 = s2.bins.get(k);
        if (!b2 || b1.n < 10 || b2.n < 10) continue;
        const l1 = Math.hypot(b1.x, b1.y, b1.z), l2 = Math.hypot(b2.x, b2.y, b2.z);
        if (l1 < 1e-6 || l2 < 1e-6) continue;
        dot += (b1.x * b2.x + b1.y * b2.y + b1.z * b2.z) / (l1 * l2); n++;
      }
      return { similarity: n ? dot / n : 0, bins: n };
    };

    // ── Simplex, still field ────────────────────────────────────────────────
    window.editor.load(piece({ type: 'SIMPLEX', drift: { x: 0, y: 0, z: 0 } }));
    await wait(1500);
    await frames(2);
    const stillA = await shape();
    check('the particles flow through a simplex curl field (neighbours move together)', stillA.moved > 1000 && stillA.coherence > 0.35, `${stillA.moved} moving, coherence ${stillA.coherence.toFixed(2)} over ${stillA.pairs} pairs`);
    await wait(1000);
    await frames(2);
    const stillB = await shape();
    const still = compare(stillA, stillB);
    check('with drift 0 the field keeps its shape over time', still.bins >= 12 && still.similarity > 0.6, `similarity ${still.similarity.toFixed(2)} over ${still.bins} bins`);
    const meshStill = particles();

    // ── Drift: a live change, and a fast one changes the shape ─────────────
    const gui = document.querySelector('.lil-gui.root');
    const controlOf = (name, within = null) => [...((within ?? gui)?.querySelectorAll('.controller') ?? [])].find((c) => c.querySelector('.name')?.textContent.trim() === name);
    const driftFolder = [...(gui?.querySelectorAll('.lil-gui') ?? [])].find((f) => f.querySelector('.title')?.textContent.trim().startsWith('drift'));
    const setNumber = (c, value) => { const el = c?.querySelector('input'); if (!el) return false; el.value = String(value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    const setDrift = (x, y, z) => setNumber(controlOf('x', driftFolder), x) && setNumber(controlOf('y', driftFolder), y) && setNumber(controlOf('z', driftFolder), z);
    check('the panel has the drift sliders', !!driftFolder && !!controlOf('x', driftFolder) && !!controlOf('z', driftFolder));
    const setOk = setDrift(3, 3, 3);
    await wait(400);
    check('drift is live: the mesh is the same object after the change', setOk && particles() === meshStill);
    const liveCfg = window.editor.getCurrentParticleSystemConfig();
    check('the config took the drift', liveCfg.noise?.drift?.x === 3 && liveCfg.noise?.drift?.z === 3, JSON.stringify(liveCfg.noise?.drift));
    await frames(2);
    const driftA = await shape();
    await wait(1000);
    await frames(2);
    const driftB = await shape();
    const drifting = compare(driftA, driftB);
    // Drift 3 at frequency 0.5 moves the field six world units in a second: another field.
    check('a fast drift changes the field\'s shape between two moments', drifting.bins >= 12 && drifting.similarity < still.similarity - 0.3, `similarity ${drifting.similarity.toFixed(2)} vs still ${still.similarity.toFixed(2)}`);

    // ── Perlin: a rebuild, a flow of the same order ─────────────────────────
    const typeControl = controlOf('type (curl)');
    const select = typeControl?.querySelector('select');
    let typeOk = false;
    if (select) {
      const index = [...select.options].findIndex((o) => /perlin/i.test(o.textContent));
      if (index >= 0) { select.selectedIndex = index; select.dispatchEvent(new Event('change', { bubbles: true })); typeOk = true; }
    }
    await wait(1800);
    await frames(2);
    check('the panel offers the noise type, and Perlin rebuilds the system', typeOk && particles() !== meshStill && window.editor.getCurrentParticleSystemConfig().noise?.type === 'PERLIN');
    setDrift(0, 0, 0);
    await wait(400);
    await frames(2);
    const perlin = await shape();
    check('the particles flow through a Perlin curl field', perlin.moved > 1000 && perlin.coherence > 0.35, `${perlin.moved} moving, coherence ${perlin.coherence.toFixed(2)}`);
    check('Perlin flows at about the speed of simplex (the gain)', perlin.rms > stillA.rms * 0.4 && perlin.rms < stillA.rms * 2.5, `rms ${perlin.rms.toFixed(4)} vs simplex ${stillA.rms.toFixed(4)} per frame`);

    const json = JSON.parse(window.editor.serialize());
    check('type and drift travel in the config', json.noise?.type === 'PERLIN' && json.noise?.drift?.x === 0, JSON.stringify({ type: json.noise?.type, drift: json.noise?.drift }));

    await load();
    check('no runtime errors', errs.length === errBefore, errs.slice(errBefore, errBefore + 3).join(' | '));
    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`noise: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * The frame budget: fps, the main thread's share of a frame by pass, the
   * GPU's timestamp sum (open the page with ?gputime), and the sizes the
   * preview's passes run at. A measurement, not a pass/fail list, and only
   * honest in a real window — the automation pane starves requestAnimationFrame
   * (see scripts/cdp-eval.mjs for running it in a separate Chrome).
   * Works in the editor and in the player.
   */
  const perfReport = async (ms = 3000) => {
    const sleep = (t) => new Promise((res) => setTimeout(res, t));
    const w = window.__world;
    const T = w.THREE;
    const r = w.renderer;
    const proto = Object.getPrototypeOf(r);
    const oR = proto.render;
    const oC = proto.compute;
    let sun = null;
    w.scene.traverse((o) => { if (o.isDirectionalLight) sun = o; });
    const shadowCam = sun?.shadow?.camera ?? null;
    const pipeCam = w._ssr().pipelineCamera;
    const key = (cam) => cam === w.camera ? 'viewport' : cam === shadowCam ? 'shadow' : (cam === w.getOutputCamera() || cam === pipeCam) ? 'output' : cam?.isOrthographicCamera ? 'quad' : 'other';
    const frames = [];
    let cur = null;
    const stack = [];
    let rendered = false;
    // Exclusive main-thread time per call, so a scene pass inside the post pipeline is not counted twice.
    const timed = (k, fn) => { rendered = true; const t = performance.now(); stack.push(0); const v = fn(); const inner = stack.pop(); const total = performance.now() - t; if (stack.length) stack[stack.length - 1] += total; if (cur) { cur[k] = (cur[k] || 0) + (total - inner); cur['n_' + k] = (cur['n_' + k] || 0) + 1; } return v; };
    r.render = function (scene, cam, ...rest) { return timed('r_' + key(cam), () => oR.call(this, scene, cam, ...rest)); };
    r.compute = function (...a) { return timed('compute', () => oC.apply(this, a)); };
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => origRaf.call(window, (t) => { const c = {}; cur = c; rendered = false; const t0 = performance.now(); cb(t); const d = performance.now() - t0; if (rendered) { c.js = d; c.t = t; frames.push(c); } cur = null; });
    const t0 = performance.now();
    await sleep(ms);
    const seconds = (performance.now() - t0) / 1000;
    window.requestAnimationFrame = origRaf;
    delete r.render;
    delete r.compute;
    const gpu = [];
    const cmp = [];
    for (let i = 0; i < 8; i++) { await sleep(100); try { await r.resolveTimestampsAsync('render'); await r.resolveTimestampsAsync('compute'); gpu.push(r.info.render.timestamp); cmp.push(r.info.compute.timestamp); } catch (e) { /* not tracking */ } }
    const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : null; };
    const p90 = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length * 0.9)].toFixed(2) : null; };
    const keys = [...new Set(frames.flatMap((f) => Object.keys(f)))].filter((k) => !k.startsWith('n_') && k !== 't');
    const gaps = frames.slice(1).map((f, i) => f.t - frames[i].t);
    const out = { fps: +(frames.length / seconds).toFixed(1), frameMs: med(gaps), frameP90: p90(gaps), framesOver50ms: gaps.filter((g) => g > 50).length, gpuSumMs: med(gpu), gpuSumP90: p90(gpu), gpuComputeMs: med(cmp), tracking: r.trackTimestamp === true };
    for (const k of keys) out[k] = med(frames.map((f) => f[k] ?? 0));
    out.jsP90 = p90(frames.map((f) => f.js));
    out.rest = +((out.js || 0) - keys.filter((k) => k !== 'js').reduce((acc, k) => acc + (out[k] || 0), 0)).toFixed(2);
    out.calls = Object.fromEntries(keys.filter((k) => k.startsWith('r_')).map((k) => [k, med(frames.map((f) => f['n_' + k] ?? 0))]));
    const b = r.getDrawingBufferSize(new T.Vector2());
    out.canvas = `${b.x}x${b.y} @${r.getPixelRatio()}`;
    const ps = w._ssr();
    const dims = (o) => (o ? `${o.width}x${o.height}` : null);
    out.passes = { previewTarget: dims(ps.previewTarget), ssr: dims(ps.ssrPass?._ssrRenderTarget), ao: dims(ps.aoPass?._aoRenderTarget), pipeline: ps.pipelineKey };
    return JSON.stringify(out);
  };

  window.__t = {
    perfReport,
    colorInstanceReport,
    noiseReport,
    collisionReport,
    trailReport,
    stretchReport,
    aoReport,
    shadowReport,
    presentReport,
    parallaxReport,
    touchReport,
    standaloneReport,
    gizmoReport,
    schemaReport,
    videoReport,
    playerReport,
    frameReport,
    environmentReport,
    fixture,
    storedScene,
    live,
    load,
    diff,
    report,
    layerSplit,
    cameraReport,
    errs,
  };
  return 'harness ready: await __t.report() | __t.cameraReport() | await __t.perfReport() (real window only) | await __t.shadowReport() | await __t.aoReport() | await __t.videoReport() | await __t.gizmoReport() | await __t.load() | __t.errs';
})();
