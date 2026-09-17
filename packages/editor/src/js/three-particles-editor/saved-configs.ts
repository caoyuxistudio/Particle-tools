// The user's saved pieces in this browser's localStorage. Moved from
// src/js/utils (V1's UI) into the engine on 2026-09-17 so the studio can
// list them; V1's util re-exports this.
/**
 * Shared access to the saved-configuration list in localStorage.
 *
 * Both the save and load dialogs render this list with a keyed `{#each}`
 * (`config.id`). Ids used to be derived solely from the config's `createdAt`
 * timestamp, which is baked into example configs — saving two configs that
 * share one (e.g. the same example saved twice) produced duplicate ids and
 * Svelte threw `each_key_duplicate`, aborting the flush and freezing the whole
 * UI. Ids are now unique per entry, and reads repair pre-existing duplicates.
 */

export const SAVED_CONFIGS_KEY = 'three-particles-saved-configs';

export type SavedConfig = {
  id: string;
  name: string;
  config: any;
  createdAt: number;
  updatedAt: number;
  editorVersion?: string;
};

/** Creates an id that stays unique even within the same millisecond. */
export const createConfigId = (createdAt: number): string =>
  `config-${createdAt}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Reads the saved configs, dropping entries with a duplicate or missing id so
 * a list corrupted by an older build can no longer break rendering. The first
 * entry seen for an id wins; callers sort by `updatedAt` afterwards.
 */
export const readSavedConfigs = (): SavedConfig[] => {
  try {
    const raw = localStorage.getItem(SAVED_CONFIGS_KEY);
    const parsed: SavedConfig[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();
    let repaired = false;
    const result = parsed.map((config) => {
      if (!config?.id || seen.has(config.id)) {
        repaired = true;
        const id = createConfigId(config?.createdAt ?? Date.now());
        seen.add(id);
        return { ...config, id };
      }
      seen.add(config.id);
      return config;
    });

    if (repaired) localStorage.setItem(SAVED_CONFIGS_KEY, JSON.stringify(result));
    return result;
  } catch {
    return [];
  }
};

export const writeSavedConfigs = (configs: SavedConfig[]): void => {
  localStorage.setItem(SAVED_CONFIGS_KEY, JSON.stringify(configs));
};
