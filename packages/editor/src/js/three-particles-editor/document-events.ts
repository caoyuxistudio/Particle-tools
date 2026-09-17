// Engine → UI: "the document changed, here" (V2-ARCHITECTURE.md §1.3a).
//
// The document is the piece: the particle config plus the scene objects in
// `_editorData`. Most edits come from the UI and it knows about them. These
// events cover the other direction — a gizmo drag, a probe bake, a config
// load — where the engine changes the document behind the UI's back. V1's
// lil-gui polls (`.listen()`) and does not need them; a studio subscribes and
// re-reads the path instead of polling anything.

export type DocumentChange =
  | {
      scope: 'scene';
      /** The scene object's id, or null when the whole scene was replaced. */
      id: string | null;
      /** Which of its keys changed; `['*']` for add / remove / replace. */
      keys: string[];
      source: 'gizmo' | 'update' | 'add' | 'remove' | 'load' | 'bake';
    }
  | {
      scope: 'particle';
      /** Dotted path into the particle config, e.g. `forceFields.2.position`. */
      path: string;
      source: 'gizmo';
    };

const watchers = new Set<(change: DocumentChange) => void>();

/** Subscribes; returns the unsubscribe. */
export const watchDocument = (watcher: (change: DocumentChange) => void): (() => void) => {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
};

export const emitDocumentChange = (change: DocumentChange): void => {
  watchers.forEach((watcher) => watcher(change));
};
