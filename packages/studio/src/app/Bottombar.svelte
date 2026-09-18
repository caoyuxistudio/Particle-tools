<script lang="ts">
  import { lastApplied, revision } from '../store/document.svelte';
  import { rebuildCount, getFrames, getLiveStats, type LiveStats } from '../engine/session';

  // Left: what the editor did. Right: what the particle system is doing.
  // Both are read twice a second — a footer is not worth a frame's time.
  const PERIOD_MS = 500;
  let frames = $state(0);
  let builds = $state(0);
  let fps = $state(0);
  let stats = $state<LiveStats | null>(null);
  $effect(() => {
    let lastFrames = getFrames();
    let lastAt = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const drawn = getFrames();
      fps = Math.round(((drawn - lastFrames) * 1000) / Math.max(1, now - lastAt));
      lastFrames = drawn;
      lastAt = now;
      frames = drawn;
      builds = rebuildCount();
      stats = getLiveStats();
    }, PERIOD_MS);
    return () => clearInterval(id);
  });
  const last = $derived((revision(), lastApplied()));
  const n = (v: number) => Math.round(v).toLocaleString('en-US');
</script>

<footer class="bottombar">
  <span title="Frames drawn since the page opened. It stops while the tab is hidden.">frames {frames}</span>
  <span title="How many times the particle system was torn down and built again. A live change (most sliders) does not rebuild; a structural one (maxParticles, renderer type…) does.">rebuilds {builds}</span>
  <span title="The document's revision: goes up by one with every change to the piece, from a panel or from a gizmo.">rev {revision()}</span>
  {#if last}<span class="last" title="The last change: which field, and what it cost — live (no rebuild), rebuild, structural, or none (editor-only).">{last.path} · {last.level}</span>{/if}
  <span class="spacer"></span>
  {#if stats}
    <span class="live" title="Particles alive right now, out of maxParticles. It fills to about rateOverTime × the mean lifetime, and stops at maxParticles.">live {n(stats.live)} / {n(stats.max)} · {stats.max ? Math.round((stats.live / stats.max) * 100) : 0}%</span>
    <span title="The emission rate the piece asks for (emission.rateOverTime), particles a second.">emit {n(stats.rate)}/s</span>
    <span title="Frames a second, over the last half second.">{fps} fps</span>
    <span title="Seconds on the simulation clock{stats.paused ? ' (paused)' : ''}.">t {stats.elapsed.toFixed(1)}s{stats.paused ? ' · paused' : ''}</span>
    <span title="Where the simulation runs, and how the particles are drawn.">{stats.backend} · {stats.renderer}</span>
  {/if}
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
    white-space: nowrap;
    overflow: hidden;
  }
  .spacer {
    flex: 1;
  }
  .last,
  .live {
    color: var(--fg);
  }
  .last {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
