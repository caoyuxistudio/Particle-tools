// The studio's harness (V2-ARCHITECTURE.md §3, §6 M2): the shell boots into
// the piece, the inspector is the schema, a change costs what the field says,
// and the document survives the two round trips of §2.1. Dev bundle only.
//   await __st.report()

import { schema, fieldsOf, leafPaths, coversLeaf, type Field, type Group } from '@engine/schema';
import { getSceneObjects, updateSceneObject } from '@engine/scene-objects';
import { revision, patch, get, load } from './store/document.svelte';
import { doc, getParticleSystem, getFrames, rebuildCount, serialize, bootTimeline } from './engine/session';

type Line = string;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  ps.updateConfig = original;

  const max = get('maxParticles');
  patch('maxParticles', max === 10000 ? 20000 : 10000);
  await settle(250);
  check('a structural field rebuilds the system', rebuildCount() === builds + 1 && getParticleSystem() !== ps, `${rebuildCount() - builds} rebuilds`);
  patch('maxParticles', max);
  await settle(250);

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
