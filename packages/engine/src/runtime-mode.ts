/**
 * Which of the two front ends is running this module graph.
 *
 * The world, the scene objects and the particle factory are shared between the
 * editor and the player window, but a handful of behaviours must not be: the
 * player has no gizmos, no orbit controls and — most importantly — must never
 * write to localStorage, because it shares an origin with the editor and would
 * otherwise overwrite the scene the editor is still editing.
 *
 * Set once, before anything else is imported into life. Anything that branches
 * on it reads it lazily, so the order of module evaluation does not matter.
 */
export type RuntimeMode = 'editor' | 'player';

let mode: RuntimeMode = 'editor';

export const setRuntimeMode = (next: RuntimeMode): void => {
  mode = next;
};

export const getRuntimeMode = (): RuntimeMode => mode;

/** True in the display window, which is read-only by construction. */
export const isPlayer = (): boolean => mode === 'player';

/**
 * Where a player gets its piece. A *linked* player was opened by the editor
 * and shares its origin's storage (uploaded images, the video list, the last
 * snapshot). A *standalone* player — the default at /player/ — takes a
 * pasted config and touches no storage at all: what the loader would persist
 * stays in memory for the session.
 */
export type PlayerSource = 'linked' | 'standalone';

let playerSource: PlayerSource = 'linked';

export const setPlayerSource = (next: PlayerSource): void => {
  playerSource = next;
};

/** True in a player that must neither read nor write the origin's storage. */
export const isStandalone = (): boolean => mode === 'player' && playerSource === 'standalone';
