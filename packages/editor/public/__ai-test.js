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
  const FIXTURE = 'WIP-Test';
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
  const EXAMPLE_URL = './examples/wip-test/config.json';
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
    const cfg = await load();
    const want = cfg._editorData.sceneObjects;
    const got = storedScene();
    const l = live();
    const ed = window.editor.getCurrentParticleSystemConfig()._editorData;
    const mesh = window.editor.getCurrentParticleSystemConfig().renderer?.mesh;

    const lines = [];
    const check = (label, ok, detail = '') => lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    check('boots into WIP-Test-2', bootLine.includes('default WIP-Test-2 loaded'), bootLine.replace(/^boot: /, ''));
    check('new system starts at 10000 particles', freshMax === 10000, `${freshMax}`);
    check('new system starts at 1000 a second', freshRate === 1000, `${freshRate}`);
    check('scene object count', got.length === want.length, `${got.length}/${want.length}`);
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
    check('tweak and noise map defaults are in place', ciCfg?.colorTweak?.saturation === 1 && ciCfg?.colorTweak?.contrast === 1 && ciCfg?.colorTweak?.hue === 0 && ciCfg?.luminanceMap?.black === 0 && ciCfg?.luminanceMap?.white === 1, JSON.stringify({ tweak: ciCfg?.colorTweak, map: ciCfg?.luminanceMap }));
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

    const build = async (patch) => {
      const cfg = await fixture();
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

    // Off by default: the fixture's system takes no samples.
    check('the fixture has touch off', !cfgLiveTouch());
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
      check('the touch settings travel', JSON.stringify(p.getConfig().touch ?? null) === JSON.stringify(JSON.parse(json).touch ?? p.getConfig().touch ?? null));
      check('nothing was written to storage', writesBefore === 0 && p.storageWrites() === 0, `${p.storageWrites()} writes`);

      // A second paste replaces the first: no leftovers from the previous piece.
      const again = JSON.parse(json);
      again._editorData.sceneObjects = again._editorData.sceneObjects.filter((o) => o.type !== 'SPHERE');
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
      Object.assign(cfg._editorData.sceneObjects.find((o) => o.type === 'SPHERE'), extra);
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
    check('the next push moves the object', second?.objects?.find((o) => o.type === 'SPHERE')?.position.x === -1.5);
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

    // Select the sphere from the panel, like a user would.
    const previousTab = [...document.querySelectorAll('[role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true');
    const sceneTab = [...document.querySelectorAll('[role=tab]')].find((t) => /scene/i.test(t.textContent));
    sceneTab?.click();
    await settle(300);
    const item = [...document.querySelectorAll('.item')].find((el) => /sphere/i.test(el.querySelector('.title')?.textContent || ''));
    const selectButton = item?.querySelector('button[title="Show drag axes in the viewport"]');
    check('the Scene panel offers a handle toggle for the sphere', !!selectButton);
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
        const stored = () => storedScene().find((o) => o.type === 'SPHERE')?.position;
        const storedBefore = JSON.stringify(stored());
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

    // The canvas covers the window; the camera is aimed so the composed frame
    // covers it too, cropped rather than barred.
    check('the canvas covers the window', Math.abs(canvas.clientWidth - window.innerWidth) <= 1 && Math.abs(canvas.clientHeight - window.innerHeight) <= 1, `${canvas.clientWidth}x${canvas.clientHeight} in ${window.innerWidth}x${window.innerHeight}`);
    const windowAspectNow = window.innerWidth / window.innerHeight;
    check('the camera takes the window\'s aspect while presenting', Math.abs((cam?.aspect ?? 0) - windowAspectNow) < 1e-3, `${cam?.aspect.toFixed(3)} vs ${windowAspectNow.toFixed(3)}`);
    const presetAspect = cam?.userData.presetAspect || windowAspectNow;
    const presetFov = cam?.userData.presetFov ?? cam?.fov;
    const expectedFov = windowAspectNow < presetAspect ? presetFov : (180 / Math.PI) * 2 * Math.atan(Math.tan((presetFov * Math.PI) / 360) * (presetAspect / windowAspectNow));
    check('the field of view covers the composed frame', Math.abs((cam?.fov ?? 0) - expectedFov) < 0.01, `${cam?.fov.toFixed(2)} vs ${expectedFov.toFixed(2)} (preset ${presetFov}, aspect ${presetAspect.toFixed(3)})`);

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
    check('the report names the piece and the pixels', /piece: WIP-Test/.test(text) && /pixels: \d+×\d+/.test(text) && /^fps: /m.test(text));
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

  window.__t = {
    trailReport,
    stretchReport,
    aoReport,
    shadowReport,
    presentReport,
    parallaxReport,
    touchReport,
    standaloneReport,
    gizmoReport,
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
  return 'harness ready: await __t.report() | __t.cameraReport() | await __t.shadowReport() | await __t.aoReport() | await __t.videoReport() | await __t.gizmoReport() | await __t.load() | __t.errs';
})();
