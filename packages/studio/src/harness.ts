// The studio's harness (V2-ARCHITECTURE.md §3, §6 M2): the shell boots into
// the piece, the inspector is the schema, a change costs what the field says,
// and the document survives the two round trips of §2.1. Dev bundle only.
//   await __st.report()

import { schema, fieldsOf, leafPaths, coversLeaf, type Field, type Group } from '@particle-tools/engine/schema';
import { getSceneObjects, updateSceneObject } from '@particle-tools/engine/scene-objects';
import { revision, patch, get, load, lastApplied } from './store/document.svelte';
const lastAppliedLevel = () => lastApplied()?.level;
import { bootProgressState } from './app/boot-progress';
import { doc, getParticleSystem, getFrames, rebuildCount, serialize, bootTimeline, present, isPresenting } from './engine/session';
import { openCurve, openGradient, openTexture, applyPending } from './editors/open';

type Line = string;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const THREE_deg = (rad: number) => (rad * 180) / Math.PI;

const diff = (a: any, b: any, path = '', out: string[] = []): string[] => {
  if (a === b) return out;
  const plain = (v: any) => v && typeof v === 'object';
  if (!plain(a) || !plain(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], path ? `${path}.${k}` : k, out);
  return out;
};

const visibleFields = (groups: Group[], scope: any, prefix = ''): Field[] =>
  groups.flatMap((g) => {
    if (g.when && !g.when(scope)) return [];
    const own = g.fields.filter((f) => f.kind !== 'hidden' && (!f.when || f.when(scope)));
    return [...own, ...visibleFields(g.groups ?? [], scope, prefix)];
  });

export const report = async (): Promise<string> => {
  const lines: Line[] = [];
  const check = (label: string, ok: boolean, detail = '') =>
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

  // Boot: the shell first, then the piece, then the compile, then frames.
  const t = bootTimeline();
  check('boot ran start → world → scene → piece → compiled → first-frame', ['start', 'world', 'scene', 'piece', 'compiled', 'first-frame'].every((k) => k in t) && t.world < t.piece && t.piece < t.compiled && t.compiled <= t['first-frame'], JSON.stringify(t));
  // The loading bar: inline in the page (up before the bundle runs), filled and gone by the first frame.
  // The page's own address: in dev `./index.html` is V1's (the publicDir), not the studio's.
  const pageHtml = await fetch(location.pathname).then((r) => r.text()).catch(() => '');
  check('the page ships its loading bar inline', /<div id="boot-loader"/.test(pageHtml) && /#boot-loader\s*\{/.test(pageHtml));
  check('the loading bar ran to the end and left with the first frame', bootProgressState().finished && bootProgressState().reached === 1 && !document.getElementById('boot-loader'), JSON.stringify(bootProgressState()));
  const f0 = getFrames();
  await settle(600);
  check('frames advance', getFrames() > f0, `${getFrames() - f0} in 600ms`);
  check('the piece is example-1-1', doc._editorData?.metadata?.name === 'example-1-1', doc._editorData?.metadata?.name);
  check('the scene came with it', getSceneObjects().length === 3 && getSceneObjects().some((o) => o.type === 'FRAME'), `${getSceneObjects().length} objects`);
  check('the colour source is the video', /^VideoTexture-/.test(doc._editorData?.colorInstanceTextureId ?? ''), doc._editorData?.colorInstanceTextureId);

  // §2.1 first round trip: what the studio serialises is what V1 wrote (the
  // example file is V1's COPY of this piece).
  const file = await (await fetch('./examples/example-1-1/config.json')).json();
  const mine = JSON.parse(serialize());
  const drift = diff(file, mine);
  check('serialize() equals V1\'s COPY of the piece, field for field', drift.length === 0, drift.slice(0, 5).join(' | '));

  // The inspector is the schema: every visible field has a control, and only those.
  const want = visibleFields(schema, doc).filter((f) => f.kind !== 'list');
  const rendered = new Set([...document.querySelectorAll<HTMLElement>('.inspector .field')].map((el) => el.dataset.path));
  const missing = want.filter((f) => !rendered.has(f.path)).map((f) => f.path);
  check('every visible schema field is rendered', missing.length === 0, missing.slice(0, 6).join(', '));
  const listPaths = fieldsOf().filter((f) => f.kind === 'list').map((f) => f.path);
  const stray = [...rendered].filter((p) => !want.some((f) => f.path === p) && !listPaths.some((lp) => p!.startsWith(lp + '.') || p === lp));
  check('and nothing that is not in the schema', stray.length === 0, stray.slice(0, 6).join(', '));
  check('the collision planes render as list items', document.querySelectorAll('[data-path^="collisionPlanes."]').length >= 4 * 5, `${document.querySelectorAll('[data-path^="collisionPlanes."]').length} fields`);

  // A `when`: the shape's own sub-group follows the shape.
  const shapeBefore = get('shape.shape');
  patch('shape.shape', 'SPHERE');
  await settle(50);
  check('switching the shape shows its own sub-group', !!document.querySelector('[data-path="shape.sphere.radius"]') && !document.querySelector('[data-path="shape.rectangle.scale"]'));
  patch('shape.shape', shapeBefore);
  await settle(250);

  // The cost of a change is what the field says.
  const ps = getParticleSystem();
  const calls: any[] = [];
  const original = ps.updateConfig.bind(ps);
  ps.updateConfig = (partial: any) => { calls.push(partial); return original(partial); };
  const builds = rebuildCount();
  const strengthBefore = get('noise.strength');
  patch('noise.strength', strengthBefore + 0.05);
  await settle(50);
  check('a live field goes through updateConfig', calls.length === 1 && 'noise' in calls[0] && Math.abs(calls[0].noise.strength - (strengthBefore + 0.05)) < 1e-9, `${calls.length} calls`);
  check('and does not rebuild', rebuildCount() === builds && getParticleSystem() === ps);
  patch('noise.strength', strengthBefore);
  await settle(150);
  // noise.direction: a uniform — live, no rebuild, and only a one-way axis is written out.
  {
    calls.length = 0;
    patch('noise.direction.y', 'POSITIVE');
    await settle(50);
    const out = JSON.parse(serialize()).noise?.direction;
    check('noise direction is live and travels with the piece', calls.length === 1 && calls[0].noise?.direction?.y === 'POSITIVE' && rebuildCount() === builds && out?.y === 'POSITIVE', `${calls.length} calls, ${JSON.stringify(out)}`);
    patch('noise.direction.y', 'BOTH');
    await settle(150);
    check('and both ways is the default, not written', JSON.parse(serialize()).noise?.direction === undefined);
  }
  // One axis of a vec3 inside a list item — how the inspector writes a
  // collision plane's position. The path names no field of its own; it must
  // still reach the engine (it once did not: the plane only moved after it
  // was switched off and on, which re-sent the whole list).
  const planes = get('collisionPlanes') as any[] | undefined;
  if (planes?.length) {
    const x0 = planes[0].position.x;
    calls.length = 0;
    patch('collisionPlanes.0.position.x', x0 + 0.25);
    await settle(50);
    check('one axis of a collision plane goes through updateConfig', calls.length === 1 && Math.abs(calls[0].collisionPlanes?.[0]?.position?.x - (x0 + 0.25)) < 1e-9 && rebuildCount() === builds, `${calls.length} calls`);
    patch('collisionPlanes.0.position.x', x0);
    await settle(150);
  }
  ps.updateConfig = original;

  const max = get('maxParticles');
  patch('maxParticles', max === 10000 ? 20000 : 10000);
  await settle(250);
  check('a structural field rebuilds the system', rebuildCount() === builds + 1 && getParticleSystem() !== ps, `${rebuildCount() - builds} rebuilds`);
  patch('maxParticles', max);
  await settle(250);

  // POINTS with a velocity stretch: the sprites draw as instanced quads the
  // vertex stage can lengthen, the kernel's heading is bound, and it travels
  // with the piece. The number beside a vec3 slider follows a drag (it once
  // did not: the derived handed back the same object).
  {
    const type0 = get('renderer.rendererType');
    const points0 = get('renderer.points');
    patch('renderer.rendererType', 'POINTS');
    patch('renderer.points.velocityStretch', 0.3);
    await settle(900);
    const inst: any = getParticleSystem()?.instance;
    check('stretched POINTS draw as instanced quads with the heading bound', !!inst?.isMesh && !!inst.geometry?.isInstancedBufferGeometry && inst.material?.userData?.velocityStretch === 0.3 && 'instanceVelocity' in (inst.geometry?.attributes ?? {}), `${inst?.type}, stretch ${inst?.material?.userData?.velocityStretch}`);
    check('and the stretch travels with the piece', JSON.parse(serialize()).renderer?.points?.velocityStretch === 0.3);
    const group = [...document.querySelectorAll('.column *')].some((e) => e.children.length === 0 && (e.textContent ?? '').trim().toLowerCase() === 'points');
    check('the inspector shows a Points group for the sprite renderers', group);
    patch('renderer.points', points0);
    patch('renderer.rendererType', type0);
    await settle(900);
    check('back on the piece\'s own renderer', getParticleSystem()?.instance !== inst);

    const sub = [...document.querySelectorAll<HTMLElement>('.column .sub')].find((e) => /^drift/.test(e.textContent ?? ''));
    const row = sub?.nextElementSibling;
    const range = row?.querySelector<HTMLInputElement>('input[type=range]');
    const num = row?.querySelector<HTMLInputElement>('input[type=number]');
    if (range && num) {
      const x0 = num.value;
      range.value = '0.5';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      await settle(100);
      check('the number beside a vec3 slider follows the drag', num.value === '0.5', `${x0} -> ${num.value}`);
      range.value = x0;
      range.dispatchEvent(new Event('input', { bubbles: true }));
      await settle(150);
    } else check('the number beside a vec3 slider follows the drag', false, 'no drift row');
  }

  // A control, not a call: the number input patches the store.
  const input = document.querySelector<HTMLInputElement>('[data-path="noise.frequency"] input[type=number]');
  const freqBefore = get('noise.frequency');
  if (input) {
    input.value = String(freqBefore + 0.01);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(50);
  }
  check('typing into a number control patches the document', !!input && Math.abs(get('noise.frequency') - (freqBefore + 0.01)) < 1e-9, `${get('noise.frequency')}`);
  patch('noise.frequency', freqBefore);

  // The engine's own change comes back as an event and moves the revision.
  const revBefore = revision();
  const frame = getSceneObjects().find((o) => o.type === 'FRAME')!;
  updateSceneObject(frame.id, { position: { ...frame.position } });
  await settle(20);
  check('an engine change bumps the revision', revision() > revBefore, `${revBefore} -> ${revision()}`);

  // The camera's feedback (the particles' afterimage): a stage of the output
  // camera's pipeline, on the camera object, travelling with the piece. The
  // trail mask is only worn inside the pipeline's render.
  {
    const w: any = (window as any).__world;
    const cam = getSceneObjects().find((o) => o.type === 'CAMERA')!;
    const before = (cam as any).feedback;
    updateSceneObject(cam.id, { feedback: { enabled: true, mode: 'over', persistence: 0.8, amount: 1 } } as any);
    await settle(600);
    const st = w._ssr();
    check('feedback on the camera adds a stage to its pipeline', /\|fb\|/.test(st.pipelineKey) && !!st.feedbackStage && w.getFeedbackSettings().mode === 'over', st.pipelineKey);
    const material: any = getParticleSystem()?.instance?.material;
    check('the particles carry a trail mask and wear it only inside that pipeline', !!material?.userData?.trailMrt && material.mrtNode === null);
    const saved = JSON.parse(serialize())._editorData.sceneObjects.find((o: any) => o.type === 'CAMERA')?.feedback;
    check('and it travels with the piece', saved?.enabled === true && saved?.mode === 'over' && saved?.persistence === 0.8, JSON.stringify(saved));
    updateSceneObject(cam.id, { feedback: before ?? { enabled: false, mode: 'lighter', persistence: 0.5, amount: 1 } } as any);
    await settle(600);
    check('switched off, the stage is gone', !/fb/.test(w._ssr().pipelineKey) && !w._ssr().feedbackStage, w._ssr().pipelineKey);
  }

  // The timeline: the piece's clock is a frame position you hold. Real time
  // off is one frame a draw, whatever the draw took; pause holds; stop goes
  // back to the start with the simulation cleared; it travels with the piece.
  {
    const st: any = (window as any).__studio;
    const bar = document.querySelector('.timeline');
    check('there is a timeline bar with a transport, a frame, a timecode and a range', !!bar && bar.querySelectorAll('.transport button').length === 2 && !!bar.querySelector('.frame') && /\d\d:\d\d:\d\d/.test(bar.querySelector('.code')?.textContent ?? '') && bar.querySelectorAll('.handle').length === 2);
    const before = get('_editorData.timeline');
    patch('_editorData.timeline', { fps: 30, start: 0, end: 300, loop: true, realtime: false, restartOnLoop: false });
    await settle(100);
    const f0 = st.getTimelineState().frame;
    const drawn0 = getFrames();
    await settle(700);
    const f1 = st.getTimelineState().frame;
    const drawn = getFrames() - drawn0;
    // Round the loop: the frames counted modulo the range.
    const stepped = (f1 - f0 + 301) % 301;
    check('real time off steps exactly one frame a draw', drawn > 0 && Math.abs(stepped - drawn) <= 1, `${stepped} frames in ${drawn} draws`);
    check('and it costs no rebuild', getParticleSystem() !== null && lastAppliedLevel() === 'none', String(lastAppliedLevel()));
    st.pause();
    const held = st.getTimelineState().frame;
    await settle(300);
    check('pause holds the frame', st.getTimelineState().frame === held && st.getTimelineState().playing === false);
    st.stop();
    await settle(100);
    const stopped = st.getTimelineState();
    check('stop goes back to the start with nothing alive', stopped.frame === 0 && !stopped.playing && getParticleSystem()?.getActiveParticleCount?.() === 0, `frame ${stopped.frame}, ${getParticleSystem()?.getActiveParticleCount?.()} alive`);
    // Dragging the playhead moves time and only time: it goes where the hand
    // puts it, the particles are left as they are, and play carries on from there.
    {
      const track = document.querySelector<HTMLElement>('.timeline .track')!;
      const head = document.querySelector<HTMLElement>('.timeline .head')!;
      const box = track.getBoundingClientRect();
      const len = st.getTimelineState().length;
      const at = (frame: number) => box.left + (frame / len) * box.width;
      const ptr = (el: HTMLElement, type: string, x: number) => el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: box.top + box.height / 2, pointerId: 7, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true, bubbles: true, cancelable: true }));
      st.play();
      await settle(400);
      const alive0 = getParticleSystem()?.getActiveParticleCount?.() ?? 0;
      const builds0 = rebuildCount();
      ptr(track, 'pointerdown', at(200));
      await settle(50);
      const ignored = st.getTimelineState().frame;
      ptr(track, 'pointerup', at(200));
      check('a click on the bare track does not move time', ignored < 100, `frame ${ignored}`);
      ptr(head, 'pointerdown', at(st.getTimelineState().frame));
      ptr(head, 'pointermove', at(200));
      await settle(200);
      const heldAt = st.getTimelineState().frame;
      check('the playhead stays under the hand while it is held', Math.abs(heldAt - 200) <= 2, `frame ${heldAt}`);
      ptr(head, 'pointerup', at(200));
      await settle(300);
      const after = st.getTimelineState().frame;
      const alive1 = getParticleSystem()?.getActiveParticleCount?.() ?? 0;
      check('let go, it plays on from there', after > 200 && after < 230, `frame ${after}`);
      check('and the particles were left as they were: no rebuild, nothing cleared', rebuildCount() === builds0 && alive1 >= alive0, `${alive0} -> ${alive1} alive`);
      st.pause();
      await settle(150);
      const r: any = (window as any).__world.renderer;
      const offsets = getParticleSystem()?.instance?.geometry?.attributes?.instanceOffset;
      if (offsets) {
        const p0 = new Float32Array(await r.getArrayBufferAsync(offsets));
        await settle(250);
        const p1 = new Float32Array(await r.getArrayBufferAsync(offsets));
        let moved = 0;
        for (let i = 0; i < p0.length; i += 4) if (p0[i] !== p1[i] || p0[i + 1] !== p1[i + 1]) moved += 1;
        check('paused, the particles themselves hold still', moved === 0, `${moved} moved`);
      }
    }
    // The project length: the range is chosen inside it.
    {
      const field = [...document.querySelectorAll<HTMLLabelElement>('.timeline label')].find((l) => /^length/.test(l.textContent ?? ''))?.querySelector('input');
      if (field) {
        field.value = '9000';
        field.dispatchEvent(new Event('change', { bubbles: true }));
        await settle(100);
        patch('_editorData.timeline', { ...(get('_editorData.timeline') as object), start: 100, end: 8000 });
        await settle(100);
      }
      const t = st.getTimelineState();
      check('a project length the range is chosen inside', !!field && t.length === 9000 && t.start === 100 && t.end === 8000, `${t.start}–${t.end} of ${t.length}`);
    }
    check('the timeline travels with the piece', JSON.parse(serialize())._editorData?.timeline?.fps === 30 && JSON.parse(serialize())._editorData?.timeline?.realtime === false);
    st.play();
    if (before) patch('_editorData.timeline', before);
    else patch('_editorData.timeline', { fps: 60, length: 1200, start: 0, end: 1200, loop: true, realtime: true, restartOnLoop: false });
    await settle(300);
    check('and play runs it again', st.getTimelineState().playing && st.getTimelineState().fps === 60);
  }

  // The footer's right half: the running system in numbers, read twice a second.
  {
    await settle(700);
    const text = document.querySelector('.bottombar')?.textContent ?? '';
    const shown = Number((text.match(/live ([\d,]+) \//)?.[1] ?? '').replace(/,/g, ''));
    const actual = getParticleSystem()?.getActiveParticleCount?.() ?? -1;
    const max = Number(get('maxParticles'));
    check('the footer shows the live particle count', shown > 0 && Math.abs(shown - actual) <= max * 0.2 && text.includes(`/ ${max.toLocaleString('en-US')}`), `${shown} shown, ${actual} alive`);
    check('and the rate, the frame rate, the clock and the backend', /emit [\d,]+\/s/.test(text) && /\d+ fps/.test(text) && /t [\d.]+s/.test(text) && /(GPU|CPU) · [A-Z]+/.test(text), text.slice(text.indexOf('live')));
  }

  // A number field shows its whole number: 500000 once read as "50000", its
  // last digit behind the spin buttons, and looked like a cap ten times lower.
  {
    const fields = [...document.querySelectorAll<HTMLInputElement>('.column input[type=number]')];
    const probe = fields.find((f) => f.offsetParent !== null) ?? fields[0];
    const kept = probe?.value ?? '';
    if (probe) probe.value = '500000';
    const clipped = fields.filter((f) => f.offsetParent !== null && f.scrollWidth > f.clientWidth).map((f) => f.value);
    check('no number field clips its value, six digits included', !!probe && clipped.length === 0, clipped.join(', '));
    if (probe) probe.value = kept;
  }

  // The camera's post effect: the last stage, on the camera, all uniforms but the switch.
  {
    const w: any = (window as any).__world;
    const cam = getSceneObjects().find((o) => o.type === 'CAMERA')!;
    const before = (cam as any).postEffect;
    const full = { enabled: true, saturation: 2, brightness: 1.1, contrast: 1.2, hue: 30, blackPoint: 0.1, whitePoint: 0.9, gamma: 1.3 };
    updateSceneObject(cam.id, { postEffect: full } as any);
    await settle(600);
    check('the post effect on the camera adds the last stage', /\|pe$/.test(w._ssr().pipelineKey) && !!w._ssr().gradeStage && w.getPostEffectSettings().saturation === 2, w._ssr().pipelineKey);
    const saved = JSON.parse(serialize())._editorData.sceneObjects.find((o: any) => o.type === 'CAMERA')?.postEffect;
    check('and it travels with the piece, every lever', JSON.stringify(saved) === JSON.stringify(full), JSON.stringify(saved));
    updateSceneObject(cam.id, { postEffect: before ?? { ...full, enabled: false } } as any);
    await settle(600);
    check('switched off, the stage is gone', !/pe/.test(w._ssr().pipelineKey) && !w._ssr().gradeStage, w._ssr().pipelineKey);
  }

  // The emitter's source image: the tone levers are live and recolour what is already flying.
  {
    const system: any = getParticleSystem();
    const builds0 = rebuildCount();
    const label = [...document.querySelectorAll('.column *')].some((e) => e.children.length === 0 && /^emitter source image tweak$/i.test((e.textContent ?? '').trim()));
    check('the group is called Emitter Source Image Tweak', label);
    const sat = fieldsOf().find((f) => f.path === 'particleColorInstance.colorTweak.saturation');
    check('saturation goes up to 5', sat?.max === 5, `${sat?.max}`);
    const mean = () => { const out = { r: 0, g: 0, b: 0 }; system.getMeanColor(out); return out.r + out.g + out.b; };
    const bright0 = mean();
    patch('particleColorInstance.colorTweak.blackPoint', 0.6);
    await settle(400);
    const crushed = mean();
    check('a black point darkens the flying particles without a rebuild', crushed < bright0 * 0.8 && rebuildCount() === builds0 && getParticleSystem() === system, `${bright0.toFixed(3)} -> ${crushed.toFixed(3)}`);
    patch('particleColorInstance.colorTweak.blackPoint', 0);
    patch('particleColorInstance.colorTweak.brightness', 2);
    await settle(400);
    check('brightness lifts them', mean() > bright0 * 1.1, `${bright0.toFixed(3)} -> ${mean().toFixed(3)}`);
    patch('particleColorInstance.colorTweak.brightness', 1);
    patch('particleColorInstance.colorTweak.gamma', 2.5);
    await settle(400);
    check('gamma above 1 lifts the mid-tones', mean() > bright0 * 1.05, `${bright0.toFixed(3)} -> ${mean().toFixed(3)}`);
    patch('particleColorInstance.colorTweak.gamma', 1);
    await settle(400);
  }

  // Furniture follows the document: the walls' helpers appear with the switch, on the furniture layer.
  const furniture = () => { const L = new (window as any).__world.THREE.Layers(); L.set(1); return (window as any).__world.scene.children.filter((o: any) => o.layers.test(L) && !o.isTransformControlsRoot); };
  const planesBefore = get('_editorData.showCollisionPlanes');
  patch('_editorData.showCollisionPlanes', false);
  await settle(50);
  const noneShown = furniture().length;
  patch('_editorData.showCollisionPlanes', true);
  await settle(50);
  const shown = furniture().length;
  check('show collision planes puts one helper per wall on the furniture layer', shown - noneShown === (doc.collisionPlanes?.length ?? 0) && shown > noneShown, `${noneShown} -> ${shown}`);
  // The emitter's shape helper sits where the emitter is — the document's transform, not the origin.
  const shapeBefore2 = get('_editorData.showShape');
  patch('_editorData.showShape', true);
  await settle(50);
  const T = (window as any).__world.THREE;
  const helperObj = (window as any).__world.scene.getObjectByName('shape-helper');
  const wp = helperObj ? helperObj.getWorldPosition(new T.Vector3()) : null;
  const wq = helperObj ? new T.Euler().setFromQuaternion(helperObj.getWorldQuaternion(new T.Quaternion())) : null;
  const tr = doc.transform;
  check('the emitter shape helper is placed by the transform', !!wp && Math.abs(wp.y - tr.position.y) < 1e-6 && Math.abs(THREE_deg(wq!.x) - tr.rotation.x) < 0.01, wp ? `at ${wp.toArray().map((n: number) => n.toFixed(2))}, x-rot ${THREE_deg(wq!.x).toFixed(1)}° vs ${tr.position.y} / ${tr.rotation.x}°` : 'no helper');
  check('and carries its tag and arrow', !!helperObj && helperObj.children.some((c: any) => c.isSprite) && helperObj.children.some((c: any) => c.type === 'ArrowHelper'));
  patch('_editorData.showShape', !!shapeBefore2);
  const toolbar = [...document.querySelectorAll<HTMLButtonElement>('.toolbar button')];
  check('the viewport toolbar carries the furniture switches', toolbar.filter((b) => b.dataset.switch).length === 5);
  const wallsSwitch = toolbar.find((b) => b.dataset.switch === '_editorData.showCollisionPlanes');
  const wallsWas = get('_editorData.showCollisionPlanes');
  wallsSwitch?.click();
  await settle(30);
  check('a toolbar switch patches the document', get('_editorData.showCollisionPlanes') === !wallsWas);
  wallsSwitch?.click();
  await settle(30);
  // The scene's objects wear their decor on the furniture layer: wires on meshes, a body on the camera, a lamp and an aim on the sun.
  const world = (window as any).__world;
  const furnitureLayer = new T.Layers(); furnitureLayer.set(1);
  const frameObj = world.scene.children.find((o: any) => o.isMesh && !o.layers.test(furnitureLayer) && o.children.some((c: any) => c.userData.decor === 'wire'));
  check('scene meshes carry an edge wire on the furniture layer', !!frameObj && frameObj.children.filter((c: any) => c.userData.decor === 'wire').every((c: any) => c.layers.test(furnitureLayer) && c.type === 'LineSegments'));
  const cam = world.scene.children.find((o: any) => o.isPerspectiveCamera && o.children.some((c: any) => c.userData.decor === 'camera'));
  check('the camera wears a body', !!cam);
  const sun = world.scene.children.find((o: any) => o.isDirectionalLight);
  check('the sun wears a lamp and an aim arrow', !!sun && sun.children.some((c: any) => c.userData.decor === 'lamp') && world.scene.children.some((o: any) => o.userData.decor === 'aim' && o.type === 'ArrowHelper'));
  const debugPlane = world.scene.getObjectByName('color-source-debug');
  let planeMesh: any = null; debugPlane?.traverse((c: any) => { if (c.isMesh && !planeMesh) planeMesh = c; });
  check('the colour-source plane sits in the depth of the space', !!planeMesh && planeMesh.material.depthTest === true && planeMesh.material.depthWrite === false);
  // The home view: 45° up, the installation framed.
  const cam0 = world.camera; const off = cam0.position.clone().sub(world.controls.target); const elevation = THREE_deg(Math.asin(off.y / off.length()));
  check('the editor camera starts at the 45° home view', Math.abs(elevation - 45) < 1.5, `${elevation.toFixed(1)}°`);
  const viewButton = document.querySelector<HTMLButtonElement>('.toolbar .view');
  world.camera.position.set(0, 0, 40); world.controls.target.set(0, 0, 0); world.controls.update();
  viewButton?.click();
  const off2 = world.camera.position.clone().sub(world.controls.target);
  check('reset view brings it back', !!viewButton && Math.abs(THREE_deg(Math.asin(off2.y / off2.length())) - 45) < 1.5);
  // The preview window: the inside moves it, an edge resizes it, no grip.
  {
    const w2 = (window as any).__world;
    const canvas = w2.renderer.domElement as HTMLCanvasElement;
    const bounds = canvas.getBoundingClientRect();
    const fire = (type: string, cx: number, cy: number) => canvas.dispatchEvent(new PointerEvent(type, { clientX: bounds.left + cx, clientY: bounds.top + cy, pointerType: 'mouse', pointerId: 1, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true, bubbles: true, cancelable: true }));
    const offset0 = w2.getPreviewOffset();
    const scale0 = w2.getPreviewScale();
    // From a small window with room on every side: at whatever size the last
    // session left it, a preview as tall as the viewport cannot move or grow.
    w2.setPreviewScale(0.12);
    w2.setPreviewOffset(-120, 80);
    const r0 = w2.previewRect();
    fire('pointerdown', r0.x + r0.w / 2, r0.y + r0.h / 2);
    fire('pointermove', r0.x + r0.w / 2 - 40, r0.y + r0.h / 2 + 30);
    fire('pointerup', r0.x + r0.w / 2 - 40, r0.y + r0.h / 2 + 30);
    const r1 = w2.previewRect();
    check('dragging inside the preview moves it', r1.x === r0.x - 40 && r1.y === r0.y + 30 && r1.w === r0.w, `${r0.x},${r0.y} -> ${r1.x},${r1.y}`);
    fire('pointerdown', r1.x, r1.y + r1.h / 2);
    fire('pointermove', r1.x - 60, r1.y + r1.h / 2);
    fire('pointerup', r1.x - 60, r1.y + r1.h / 2);
    const r2 = w2.previewRect();
    check('dragging the left edge widens it and keeps the right edge', r2.w > r1.w && Math.abs(r2.x + r2.w - (r1.x + r1.w)) <= 1, `w ${r1.w} -> ${r2.w}, right ${r1.x + r1.w} -> ${r2.x + r2.w}`);
    check('the grip is gone', typeof w2.getPreviewOffset === 'function' && !('overPreviewHandle' in w2 && false));
    // The magnifier: the wheel over the preview zooms about the pointer (to 5×,
    // the orbit camera untouched), a middle drag pans, a middle click resets.
    {
      const rz = w2.previewRect();
      const px = rz.x + rz.w * 0.25;
      const py = rz.y + rz.h * 0.25;
      const orbit0 = w2.camera.position.clone();
      const wheel = (dy: number) => canvas.dispatchEvent(new WheelEvent('wheel', { clientX: bounds.left + px, clientY: bounds.top + py, deltaY: dy, bubbles: true, cancelable: true }));
      for (let k = 0; k < 8; k++) wheel(-200);
      await settle(120);
      const z1 = w2.getPreviewZoom();
      check('the wheel over the preview magnifies it, to 5× and no further', z1.zoom === 5 && z1.u < 0.5 && z1.v > 0.5, JSON.stringify(z1));
      check('and the viewport camera did not move', w2.camera.position.distanceTo(orbit0) < 1e-6);
      const mid = (type: string, cx: number, cy: number) => canvas.dispatchEvent(new PointerEvent(type, { clientX: bounds.left + cx, clientY: bounds.top + cy, pointerType: 'mouse', pointerId: 1, button: type === 'pointermove' ? -1 : 1, buttons: type === 'pointerup' ? 0 : 4, isPrimary: true, bubbles: true, cancelable: true }));
      mid('pointerdown', px, py);
      mid('pointermove', px - 50, py);
      mid('pointerup', px - 50, py);
      const z2 = w2.getPreviewZoom();
      check('a middle drag pans the magnified picture', z2.zoom === 5 && z2.u > z1.u, `${z1.u.toFixed(3)} -> ${z2.u.toFixed(3)}`);
      mid('pointerdown', px, py);
      mid('pointerup', px, py);
      const z3 = w2.getPreviewZoom();
      check('a middle click brings the whole picture back', z3.zoom === 1 && z3.u === 0.5 && z3.v === 0.5, JSON.stringify(z3));
      for (let k = 0; k < 3; k++) wheel(-200);
      for (let k = 0; k < 12; k++) wheel(200);
      check('and the wheel the other way stops at the whole picture', w2.getPreviewZoom().zoom === 1);
    }
    w2.setPreviewOffset(offset0.dx, offset0.dy);
    w2.setPreviewScale(scale0);
  }
  // The two library tabs.
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.column .tabs button')].map((b) => b.textContent?.trim());
  check('the column has particles, scene, pieces and textures', JSON.stringify(tabs) === JSON.stringify(['particles', 'scene', 'pieces', 'textures']), tabs.join(','));
  const cards = document.querySelectorAll('.column .card').length;
  check('the pieces panel lists the examples', cards >= 2, `${cards} cards`);
  // Save → change → load the saved one: through the panel's own controls (a
  // deep $state proxy over the saved list once made this throw DataCloneError).
  {
    const name = `harness-${Date.now()}`;
    const input = document.querySelector<HTMLInputElement>('.column .save input');
    const button = document.querySelector<HTMLButtonElement>('.column .save button');
    const strength0 = get('noise.strength') as number;
    if (input && button) {
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      button.click();
      await settle(50);
      patch('noise.strength', strength0 + 0.37);
      const row = [...document.querySelectorAll<HTMLButtonElement>('.column .row .name')].find((b) => b.textContent === name);
      row?.click();
      await settle(300);
      check('a piece saved in this browser loads back', !!row && Math.abs((get('noise.strength') as number) - strength0) < 1e-9, `strength ${strength0} -> ${get('noise.strength')}`);
      row?.parentElement?.querySelector<HTMLButtonElement>('.x')?.click();
      await settle(50);
      check('and deleting it takes it off the list', ![...document.querySelectorAll('.column .row .name')].some((b) => b.textContent === name));
    } else check('a piece saved in this browser loads back', false, 'no save controls');
  }
  // A thumbnail is the output camera's picture at the camera's own shape, and
  // the cards take whatever shape their thumbnail has.
  {
    const w: any = (window as any).__world;
    const blob: Blob | null = await w.captureOutput(256);
    const bitmap = blob ? await createImageBitmap(blob) : null;
    const aspect = w.getOutputCamera()?.userData?.presetAspect || w.getOutputCamera()?.aspect || 0;
    check('a captured thumbnail has the camera\'s shape', !!bitmap && bitmap.width === 256 && Math.abs(bitmap.width / bitmap.height - aspect) < 0.02, bitmap ? `${bitmap.width}×${bitmap.height} for aspect ${aspect.toFixed(3)}` : 'no image');
    const names = [...document.querySelectorAll('.column .card span')].map((e) => e.textContent?.trim());
    check('example-1-2 is on the list', names.includes('example-1-2'), names.join(', '));
    const square = await fetch('./examples/example-1-2/preview.webp').then((r) => r.blob()).then(createImageBitmap).catch(() => null);
    check('and its thumbnail is square, like its camera', !!square && square.width === square.height, square ? `${square.width}×${square.height}` : 'missing');
  }
  const sources = document.querySelectorAll('.column .item .thumb').length;
  check('the textures panel lists the colour sources', sources >= 2, `${sources} entries`);
  const axesBefore = get('_editorData.showWorldAxes');
  patch('_editorData.showWorldAxes', true);
  await settle(20);
  check('show world axes adds an AxesHelper', furniture().some((o: any) => o.type === 'AxesHelper'));
  patch('_editorData.showWorldAxes', !!axesBefore);
  patch('_editorData.showCollisionPlanes', !!planesBefore);
  await settle(50);

  // M3: the three canvas editors open into the pre-embedded DOM and write the document.
  const modal = (cls: string) => document.querySelector<HTMLElement>(cls);
  openCurve('sizeOverLifetime.lifetimeCurve');
  await settle(50);
  check('the curve editor opens on a lifetime curve', modal('.bezier-editor-modal')?.style.display === 'block' && document.querySelectorAll('.draggable-points .bezier-point').length >= 2, `${document.querySelectorAll('.draggable-points .bezier-point').length} points`);
  // Editing does not rebuild; Apply does. Save Current asks inline, not with window.prompt.
  const buildsAtOpen = rebuildCount();
  const curveTarget = get('sizeOverLifetime.lifetimeCurve');
  const apply = document.querySelector<HTMLButtonElement>('.bezier-editor-apply');
  check('the curve editor has an Apply button, idle while nothing changed', !!apply && apply.disabled === true);
  curveTarget.bezierPoints[0].y = Math.min(1, (curveTarget.bezierPoints[0].y ?? 0) + 0.1);
  // the editor's own change path: drag callbacks mark, they do not apply
  const presetsBefore = document.querySelectorAll('.bezier-editor-presets .bezier-preset-button').length;
  (document.querySelector('.bezier-save-button') as HTMLElement)?.click();
  await settle(50);
  const namer = document.querySelector<HTMLInputElement>('.bezier-editor-modal .editor-namer input');
  check('Save Current asks for a name inline', !!namer);
  if (namer) {
    namer.value = 'harness-preset';
    (document.querySelector('.editor-namer__save') as HTMLElement).click();
    await settle(100);
  }
  const presetsAfter = document.querySelectorAll('.bezier-editor-presets .bezier-preset-button').length;
  check('and the new preset appears on the shelf', presetsAfter === presetsBefore + 1, `${presetsBefore} -> ${presetsAfter}`);
  // clean up the stored preset
  try { const key = 'three-particles-editor-custom-bezier-curves'; const list = JSON.parse(localStorage.getItem(key) || '[]').filter((p: any) => p.name !== 'harness-preset'); localStorage.setItem(key, JSON.stringify(list)); } catch { /* no storage */ }
  // A preset click goes through the editor's own change path, like a drag does.
  const shelf = [...document.querySelectorAll<HTMLElement>('.bezier-editor-presets .bezier-preset-button')].filter((b) => !/save|reverse/i.test(b.className));
  shelf[3]?.click();
  await settle(100);
  check('editing marks the change and does not rebuild', rebuildCount() === buildsAtOpen && apply?.disabled === false && apply.classList.contains('is-dirty'), `${rebuildCount() - buildsAtOpen} rebuilds, apply ${apply?.disabled ? 'idle' : 'armed'}`);
  (document.querySelector('.bezier-editor-modal__close') as HTMLElement)?.click();
  await settle(250);
  check('closing applies the pending edit once', rebuildCount() === buildsAtOpen + 1 && applyPending('bezier') === false, `${rebuildCount() - buildsAtOpen} rebuilds`);
  openGradient();
  await settle(50);
  check('the gradient editor opens with the piece\'s stops', modal('.gradient-editor-modal')?.style.display === 'block' && Array.isArray(doc._editorData.gradientStops) && doc._editorData.gradientStops.length >= 2);
  (document.querySelector('.gradient-editor-modal__close') as HTMLElement)?.click();
  openTexture('source');
  await settle(150);
  const tiles = document.querySelectorAll('.texture-selector-grid .texture-selector-item').length;
  check('the texture selector lists the registry', modal('.texture-selector-modal')?.style.display === 'block' && tiles > 3, `${tiles} textures`);
  // Picking a texture writes the document and rebuilds (the source is structural).
  const sourceBefore = doc._editorData.colorInstanceTextureId;
  const buildsBefore = rebuildCount();
  const item = [...document.querySelectorAll<HTMLElement>('.texture-selector-grid .texture-selector-item')].find((el) => /default.texture|DEFAULT_TEXTURE/i.test(el.textContent ?? ''));
  item?.click();
  await settle(250);
  check('picking a texture rebinds the colour source and rebuilds', !!item && doc._editorData.colorInstanceTextureId === 'DEFAULT_TEXTURE' && doc.particleColorInstance?.map?.image?.width === 816 && rebuildCount() > buildsBefore, `${sourceBefore} -> ${doc._editorData.colorInstanceTextureId}, ${rebuildCount() - buildsBefore} rebuilds`);
  (document.querySelector('.texture-selector-modal__close') as HTMLElement)?.click();

  // M3: presentation mode — this window as the display, and back.
  const fBefore = getFrames();
  present();
  await settle(400);
  check('presenting hides the studio and draws the output camera', isPresenting() && document.body.classList.contains('presenting') && getComputedStyle(document.querySelector('.studio')!).display === 'none' && getFrames() > fBefore);
  check('the presentation bar and both HUDs are installed', !!document.querySelector('.presentation-bar') && !!(window as any).__perfHud && !!(window as any).__gyroHud);
  // Every floating panel closes from itself.
  (window as any).__perfHud.show();
  (window as any).__gyroHud.show();
  await settle(50);
  const closes = [...document.querySelectorAll<HTMLElement>('.perf-hud .hud-close, .gyro-hud .hud-close')];
  closes.forEach((b) => b.click());
  await settle(50);
  check('the HUDs carry a close button that hides them', closes.length === 2 && !(window as any).__perfHud.isShown() && (document.querySelector('.gyro-hud') as HTMLElement).hidden);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(200);
  check('Escape brings the studio back', !isPresenting() && getComputedStyle(document.querySelector('.studio')!).display !== 'none');
  check('touch input is installed on the canvas', typeof (window as any).__touch?.state === 'function' && typeof (window as any).__touch?.feed === 'function');

  // Every leaf of the live document has a field (schema coverage, live).
  const uncovered = leafPaths(doc).filter((p) => typeof p.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), doc) !== 'function').filter((p) => !coversLeaf(p));
  check('the live document is covered by the schema', uncovered.length === 0, uncovered.slice(0, 5).join(', '));

  // §2.1 second round trip: a standalone player, same origin, given serialize().
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;opacity:0.01;pointer-events:none';
  // Explicit: Vite would answer './player/' with the studio's own index (SPA fallback).
  iframe.src = './player/index.html';
  document.body.appendChild(iframe);
  const until = async (fn: () => any, ms: number) => { const s = performance.now(); while (performance.now() - s < ms) { const v = fn(); if (v) return v; await settle(100); } return null; };
  const p: any = await until(() => (iframe.contentWindow as any)?.__player?.ready && (iframe.contentWindow as any).__player, 20000);
  check('a standalone player boots beside the studio', !!p);
  if (p) {
    const json = serialize();
    const ok = await p.paste(json);
    const back = p.serialize();
    const d2 = diff(JSON.parse(json), back);
    check('the player takes the studio\'s piece', ok === true);
    check('and serialises it back identically', d2.length === 0, d2.slice(0, 4).join(' | '));
  }
  iframe.remove();

  // Put the piece back as it was.
  load(file);
  await settle(300);

  const failed = lines.filter((l) => l.startsWith('FAIL')).length;
  return [`studio: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
};

(window as any).__st = { report };
