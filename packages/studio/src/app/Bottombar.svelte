<script lang="ts">
  import { lastApplied, revision } from '../store/document.svelte';
  import { rebuildCount, getFrames } from '../engine/session';

  let frames = $state(0);
  let builds = $state(0);
  $effect(() => {
    const id = setInterval(() => {
      frames = getFrames();
      builds = rebuildCount();
    }, 500);
    return () => clearInterval(id);
  });
  const last = $derived((revision(), lastApplied()));
</script>

<footer class="bottombar">
  <span>frames {frames}</span>
  <span>rebuilds {builds}</span>
  <span>rev {revision()}</span>
  {#if last}<span class="last">{last.path} · {last.level}</span>{/if}
</footer>

<style>
  .bottombar {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    padding: 0 var(--sp-3);
    background: var(--panel);
    border-top: 1px solid var(--line);
    font-size: var(--fs-1);
    color: var(--fg-dim);
  }
  .last {
    color: var(--fg);
  }
</style>
