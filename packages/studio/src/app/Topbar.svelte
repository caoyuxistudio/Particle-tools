<script lang="ts">
  import { serialize, load } from '../store/document.svelte';
  import { revision, get } from '../store/document.svelte';
  import { present, togglePerfHud, toggleGyroHud } from '../engine/session';

  let status = $state('');
  const flash = (text: string) => {
    status = text;
    setTimeout(() => (status = ''), 1800);
  };

  const copy = async () => {
    const json = serialize();
    try {
      await navigator.clipboard.writeText(json);
      flash('copied');
    } catch {
      flash('clipboard unavailable');
    }
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      load(JSON.parse(text));
      flash('loaded');
    } catch {
      flash('nothing to paste');
    }
  };

  const name = $derived((revision(), get('_editorData.metadata.name') ?? 'untitled'));
</script>

<header class="topbar">
  <span class="brand">PARTICLE TOOLS STUDIO</span>
  <span class="piece">{name}</span>
  <span class="spacer"></span>
  <span class="status">{status}</span>
  <button onclick={togglePerfHud} title="Performance HUD (P)">perf</button>
  <button onclick={toggleGyroHud} title="Gyro parallax panel (G)">gyro</button>
  <button class="presentation-toggle" onclick={present} title="Present: this window becomes the display (Esc to return)">present</button>
  <button onclick={copy} title="Copy the piece as JSON (what V1's COPY gives)">copy</button>
  <button onclick={paste} title="Load a piece from the clipboard">paste</button>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 0 var(--sp-3);
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    font-size: var(--fs-2);
  }
  .brand {
    color: var(--fg-strong);
    letter-spacing: 0.12em;
  }
  .piece {
    color: var(--fg-dim);
  }
  .spacer {
    flex: 1;
  }
  .status {
    color: var(--fg-dim);
  }
  @media (max-width: 760px) {
    .brand,
    .status {
      display: none;
    }
  }
</style>
