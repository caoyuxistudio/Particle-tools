<script lang="ts">
  import { get, patch, revision } from '../store/document.svelte';

  // The furniture switches, where the furniture is. The same document keys the
  // Helper group edits; this is just a nearer place to reach them.
  const SWITCHES = [
    { path: '_editorData.showShape', label: 'emitter', title: 'The emitter shape (blue-violet)' },
    { path: '_editorData.showCollisionPlanes', label: 'walls', title: 'Collision planes and their drag handles' },
    { path: '_editorData.showForceFields', label: 'fields', title: 'Force fields and their drag handles' },
    { path: '_editorData.showColorSourceDebug', label: 'source', title: 'The colour source laid over the emitter (debug)' },
    { path: '_editorData.showWorldAxes', label: 'axes', title: 'World axes' },
  ];
  const on = (path: string) => (revision(), !!get(path));
</script>

<nav class="toolbar">
  {#each SWITCHES as s (s.path)}
    <button aria-pressed={on(s.path)} title={s.title} data-switch={s.path} onclick={() => patch(s.path, !get(s.path))}>{s.label}</button>
  {/each}
</nav>

<style>
  .toolbar {
    position: absolute;
    left: var(--sp-2);
    bottom: var(--sp-4);
    display: flex;
    gap: var(--sp-1);
    pointer-events: auto;
  }
  .toolbar button {
    background: rgba(0, 0, 0, 0.55);
    font-size: var(--fs-1);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .toolbar button[aria-pressed='true'] {
    background: var(--fg-strong);
  }
</style>
