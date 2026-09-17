<script lang="ts">
  import Inspector from './Inspector.svelte';
  import ScenePanel from '../scene/ScenePanel.svelte';

  let tab = $state<'particles' | 'scene'>('particles');
</script>

<!-- The right column: the particle inspector (a rendering of the schema) and the Scene panel (ported from V1). -->
<aside class="column">
  <nav class="tabs">
    <button aria-pressed={tab === 'particles'} onclick={() => (tab = 'particles')}>particles</button>
    <button aria-pressed={tab === 'scene'} onclick={() => (tab = 'scene')}>scene</button>
  </nav>
  <div class="pane" hidden={tab !== 'particles'}><Inspector /></div>
  <div class="pane" hidden={tab !== 'scene'}><ScenePanel /></div>
</aside>

<style>
  .column {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 0;
    background: var(--panel);
    border-left: 1px solid var(--line);
  }
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--line);
  }
  .tabs button {
    flex: 1;
    border: 0;
    border-right: 1px solid var(--line);
    height: 28px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--fs-1);
  }
  .tabs button:last-child {
    border-right: 0;
  }
  .pane {
    min-height: 0;
    overflow: hidden;
    display: grid;
  }
  .pane[hidden] {
    display: none;
  }
</style>
