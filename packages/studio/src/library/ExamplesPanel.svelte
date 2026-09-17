<script lang="ts">
  // The pieces: the ones that ship with the engine, and the ones saved in
  // this browser. Loading either goes through the store's one load path.
  import { examples, exampleConfigUrl, examplePreviewUrl } from '@engine/presets';
  import { readSavedConfigs, writeSavedConfigs, createConfigId, type SavedConfig } from '@engine/saved-configs';
  import { load, serialize, get, revision } from '../store/document.svelte';

  let saved = $state<SavedConfig[]>(readSavedConfigs());
  let saveName = $state('');
  let note = $state('');
  const flash = (text: string) => {
    note = text;
    setTimeout(() => (note = ''), 1800);
  };

  const openExample = async (name: string) => {
    try {
      const res = await fetch(exampleConfigUrl(name));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      load(await res.json());
      flash(`loaded ${name}`);
    } catch (e) {
      flash(`could not load ${name}`);
    }
  };
  const openSaved = (entry: SavedConfig) => {
    load(structuredClone(entry.config));
    flash(`loaded ${entry.name}`);
  };
  const saveCurrent = () => {
    const name = saveName.trim() || (get('_editorData.metadata.name') ?? 'untitled');
    const now = Date.now();
    const config = JSON.parse(serialize());
    const existing = saved.find((s) => s.name === name);
    if (existing) {
      existing.config = config;
      existing.updatedAt = now;
    } else {
      saved = [{ id: createConfigId(now), name, config, createdAt: now, updatedAt: now }, ...saved];
    }
    try {
      writeSavedConfigs(saved);
      saved = readSavedConfigs();
      flash(existing ? `updated ${name}` : `saved ${name}`);
    } catch {
      flash('not enough browser storage');
    }
    saveName = '';
  };
  const remove = (entry: SavedConfig) => {
    saved = saved.filter((s) => s.id !== entry.id);
    writeSavedConfigs(saved);
  };
  const current = $derived((revision(), get('_editorData.metadata.name') ?? ''));
</script>

<div class="panel">
  <div class="section">
    <div class="heading">saved in this browser</div>
    <div class="save">
      <input type="text" placeholder={current || 'name'} bind:value={saveName} onkeydown={(e) => e.key === 'Enter' && saveCurrent()} />
      <button onclick={saveCurrent} title="Save the current piece under this name (the current name if empty)">save</button>
    </div>
    {#if saved.length === 0}
      <div class="empty">nothing saved yet</div>
    {/if}
    {#each saved as entry (entry.id)}
      <div class="row" class:current={entry.name === current}>
        <button class="name" onclick={() => openSaved(entry)} title="Load">{entry.name}</button>
        <span class="when">{new Date(entry.updatedAt).toLocaleDateString()}</span>
        <button class="x" onclick={() => remove(entry)} title="Delete">×</button>
      </div>
    {/each}
  </div>
  <div class="section">
    <div class="heading">examples</div>
    <div class="grid">
      {#each examples as ex (ex.name)}
        <button class="card" class:current={ex.name === current} onclick={() => openExample(ex.name)} title={`Load ${ex.name}`}>
          <img src={examplePreviewUrl(ex.name)} alt="" loading="lazy" />
          <span>{ex.name}</span>
        </button>
      {/each}
    </div>
  </div>
  {#if note}<div class="note">{note}</div>{/if}
</div>

<style>
  .panel {
    overflow-y: auto;
    min-height: 0;
    font-size: var(--fs-2);
  }
  .section {
    padding: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--line-soft);
  }
  .heading {
    color: var(--fg-strong);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--fs-1);
    margin-bottom: var(--sp-2);
  }
  .save {
    display: flex;
    gap: var(--sp-1);
    margin-bottom: var(--sp-2);
  }
  .row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: var(--sp-2);
    align-items: center;
    min-height: var(--control-h);
  }
  .row.current .name,
  .card.current {
    border-color: var(--fg-strong);
    color: var(--fg-strong);
  }
  .name {
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    color: var(--fg-dim);
    font-size: var(--fs-1);
  }
  .x {
    width: var(--control-h);
    padding: 0;
  }
  .empty,
  .note {
    color: var(--fg-dim);
    font-size: var(--fs-1);
  }
  .note {
    padding: var(--sp-2) var(--sp-3);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--sp-2);
  }
  .card {
    height: auto;
    padding: var(--sp-1);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    align-items: stretch;
  }
  .card img {
    width: 100%;
    aspect-ratio: 9 / 16;
    object-fit: cover;
    background: var(--panel-2);
    display: block;
  }
  .card span {
    text-align: left;
    font-size: var(--fs-1);
  }
</style>
