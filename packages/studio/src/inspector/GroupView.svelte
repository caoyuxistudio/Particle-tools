<script lang="ts">
  import type { Group } from '@particle-tools/engine/schema';
  import FieldView from './FieldView.svelte';
  import { revision, document } from '../store/document.svelte';
  import GroupView from './GroupView.svelte';

  let { group, prefix, scope = null, open = false }: { group: Group; prefix: string; scope?: any; open?: boolean } = $props();

  // `when` reads the document (or, inside a list item, the item).
  const shown = $derived((revision(), !group.when || group.when(scope ?? document)));
</script>

{#if shown}
  <details class="group" {open}>
    <summary>{group.label}</summary>
    <div class="body">
      {#each group.fields as field (field.path)}
        <FieldView {field} {prefix} {scope} />
      {/each}
      {#each group.groups ?? [] as sub (sub.id)}
        <GroupView group={sub} {prefix} {scope} open={true} />
      {/each}
    </div>
  </details>
{/if}

<style>
  .group {
    border-bottom: 1px solid var(--line-soft);
  }
  summary {
    padding: var(--sp-2) var(--sp-3);
    color: var(--fg-strong);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--fs-1);
  }
  summary:hover {
    background: var(--panel-2);
  }
  .body {
    padding: 0 var(--sp-3) var(--sp-2);
  }
  .body :global(.group) {
    border: 0;
    border-top: 1px solid var(--line-soft);
    margin-top: var(--sp-1);
  }
  .body :global(.group > summary) {
    padding-left: 0;
    padding-right: 0;
    text-transform: none;
    letter-spacing: var(--tracking);
    color: var(--fg);
  }
  .body :global(.group > .body) {
    padding-left: 0;
    padding-right: 0;
  }
</style>
