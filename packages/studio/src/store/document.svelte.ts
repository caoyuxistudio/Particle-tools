// The single truth (V2-ARCHITECTURE.md §3): only the store changes the
// document. The UI calls patch(); the engine's own changes (a gizmo drag, a
// bake, a load) arrive as document events and bump the revision the same way.
//
// The document object itself is the engine's — the loader merges into it in
// place — so it is not made deeply reactive. Instead every change bumps `rev`,
// and anything that reads a value through `get()` re-reads when `rev` moves.

import { doc, applyChange, load as sessionLoad, serialize as sessionSerialize } from '../engine/session';
import { watchDocument, type DocumentChange } from '@engine/document-events';
import type { ChangeLevel } from '@engine/schema';

let rev = $state(0);
let lastChange = $state<{ path: string; level: ChangeLevel | 'none' } | null>(null);

export const revision = (): number => rev;
export const lastApplied = () => lastChange;

export const get = (path: string): any => {
  void rev;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
};

const setAt = (path: string, value: unknown): void => {
  const keys = path.split('.');
  let o: any = doc;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
};

/** The UI's one way to change the document. */
export const patch = (path: string, value: unknown): void => {
  setAt(path, value);
  const level = applyChange(path);
  lastChange = { path, level };
  rev += 1;
};

export const load = (config: Record<string, any>): void => {
  sessionLoad(config);
  rev += 1;
};

export const serialize = (): string => sessionSerialize();

/** After the engine changed the document without an event (the boot load). */
export const refresh = (): void => {
  rev += 1;
};

export const document = doc;

let unwatch: (() => void) | null = null;
export const connectEvents = (): void => {
  if (unwatch) return;
  unwatch = watchDocument((change: DocumentChange) => {
    lastChange = { path: change.scope === 'scene' ? `_editorData.sceneObjects.${change.id ?? '*'}` : change.path, level: 'none' };
    rev += 1;
  });
};
