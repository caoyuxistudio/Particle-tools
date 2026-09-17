<script lang="ts">
  import Topbar from './app/Topbar.svelte';
  import Viewport from './viewport/Viewport.svelte';
  import Column from './inspector/Column.svelte';
  import Bottombar from './app/Bottombar.svelte';
</script>

<!--
  Two grids (V2-ARCHITECTURE.md §4): topbar / workspace / bottombar, and inside
  the workspace the viewport and the inspector. The canvas itself is not in a
  cell: the engine draws full-window underneath, and the viewport cell tells it
  which part is free (setViewportInsets). Panels are opaque, so what shows is
  exactly the cell.
-->
<!-- The engine's canvas: the whole window, under the studio. -->
<div id="studio-stage" class="stage"></div>
<div class="studio">
  <Topbar />
  <div class="workspace">
    <Viewport />
    <Column />
  </div>
  <Bottombar />
</div>

<style>
  .stage {
    position: fixed;
    inset: 0;
    z-index: 0;
  }
  .stage :global(canvas) {
    display: block;
  }
  .studio {
    position: fixed;
    inset: 0;
    z-index: 1;
    display: grid;
    grid-template-rows: var(--topbar-h) 1fr var(--bottombar-h);
    pointer-events: none;
  }
  .workspace {
    display: grid;
    grid-template-columns: 1fr var(--inspector-w);
    min-height: 0;
  }
  /* Panels take the pointer; the workspace and the viewport cell let it through to the canvas. */
  .studio > :global(header),
  .studio > :global(footer),
  .workspace > :global(aside) {
    pointer-events: auto;
  }
</style>
