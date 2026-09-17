<script lang="ts">
  import { onMount } from 'svelte';
  import { boot, doc } from '../engine/session';
  import { connectEvents, refresh, engineChanged } from '../store/document.svelte';
  import Toolbar from './Toolbar.svelte';

  let cell: HTMLDivElement;
  let note = $state('');

  const DEFAULT_PIECE = './examples/example-1-1/config.json';

  onMount(async () => {
    connectEvents();
    let piece = null;
    try {
      const res = await fetch(DEFAULT_PIECE);
      if (res.ok) piece = await res.json();
    } catch {
      /* no piece: the default system */
    }
    if (!piece) note = 'default system (example-1-1 not found)';
    await boot({
      stage: '#studio-stage',
      statsContainer: window.document.getElementById('studio-stats'),
      // The free viewport is this cell, measured against the canvas (which is
      // the whole window): left/right/top in canvas pixels.
      viewportInsets: (canvas) => {
        const r = cell.getBoundingClientRect();
        return { left: r.left - canvas.left, right: r.right - canvas.left, top: r.top - canvas.top };
      },
      notifier: { info: (m) => (note = m), success: (m) => (note = m), error: (m) => (note = m) },
      piece,
      onEngineChange: engineChanged,
    });
    refresh();
    void doc;
  });
</script>

<!-- The canvas is mounted at the app level (the whole window); this cell is only the free area. -->
<div class="cell" bind:this={cell}>
  <Toolbar />
  {#if note}<div class="note">{note}</div>{/if}
</div>

<style>
  .cell {
    position: relative;
    pointer-events: none;
    z-index: 1;
  }
  .note {
    position: absolute;
    left: var(--sp-2);
    bottom: calc(var(--sp-4) + var(--control-h) + var(--sp-2));
    color: var(--fg-dim);
    font-size: var(--fs-1);
  }
</style>
