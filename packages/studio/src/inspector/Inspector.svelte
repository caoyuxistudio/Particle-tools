<script lang="ts">
  import { schema } from '@engine/schema';
  import GroupView from './GroupView.svelte';
</script>

<!-- The inspector is a renderer of the schema and nothing else (V2-ARCHITECTURE.md §3). -->
<aside class="inspector">
  {#each schema as group (group.id)}
    <GroupView {group} prefix="" />
  {/each}
</aside>

<style>
  .inspector {
    overflow-y: auto;
    min-height: 0;
    font-size: var(--fs-2);
  }
</style>
