<script lang="ts">
  import Topbar from './app/Topbar.svelte';
  import Viewport from './viewport/Viewport.svelte';
  import Column from './inspector/Column.svelte';
  import Bottombar from './app/Bottombar.svelte';
  import Modals from './editors/Modals.svelte';
  import '../src/editors/editors.css';
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
<!-- The frame counter: outside the grid so presentation mode can keep it. -->
<div id="studio-stats" class="stats"></div>
<div class="studio">
  <Topbar />
  <div class="workspace">
    <Viewport />
    <Column />
  </div>
  <Bottombar />
</div>
<Modals />

<style>
  .stage {
    position: fixed;
    inset: 0;
    z-index: 0;
  }
  .stage :global(canvas) {
    display: block;
  }
  .stats {
    position: fixed;
    left: var(--sp-2);
    top: calc(var(--topbar-h) + var(--sp-2));
    z-index: 2;
  }
  .stats :global(> div) {
    position: static !important;
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
  @media (max-width: 760px) {
    .workspace {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr 45svh;
    }
  }
  /* Panels take the pointer; the workspace and the viewport cell let it through to the canvas. */
  .studio > :global(header),
  .studio > :global(footer),
  .workspace > :global(aside) {
    pointer-events: auto;
  }
</style>
