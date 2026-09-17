<script lang="ts">
  import type { Field } from '@particle-tools/engine/schema';
  import { get, patch, revision } from '../store/document.svelte';
  import GroupView from './GroupView.svelte';

  let { field, path }: { field: Field; path: string } = $props();
  const items = $derived((revision(), (get(path) as any[]) ?? []));

  // What a new item starts as: enough for the engine to accept it.
  const TEMPLATES: Record<string, () => any> = {
    forceFields: () => ({ isActive: true, type: 'POINT', position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 }, strength: 1, range: 5, falloff: 'LINEAR' }),
    collisionPlanes: () => ({ isActive: true, mode: 'BOUNCE', position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, dampen: 0.5, lifetimeLoss: 0, recover: 1, touchCap: 8, maxSpeed: 0 }),
    'emission.bursts': () => ({ time: 0, count: 10, cycles: 1, interval: 1, probability: 1 }),
    subEmitters: () => ({ trigger: 'DEATH', inheritVelocity: 0, maxInstances: 8, config: {} }),
  };
  const add = () => patch(path, [...items, (TEMPLATES[path] ?? (() => ({})))()]);
  const remove = (i: number) => patch(path, items.filter((_, j) => j !== i));
</script>

<div class="list">
  {#each items as item, i (i)}
    <div class="item">
      <GroupView group={{ ...field.item!, label: `${field.item!.label} ${i + 1}` }} prefix={`${path}.${i}.`} scope={item} open={true} />
      <button class="remove" onclick={() => remove(i)}>remove</button>
    </div>
  {/each}
  <button onclick={add}>+ add {field.item?.label.toLowerCase()}</button>
</div>

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .item {
    border: 1px solid var(--line-soft);
    padding: 0 var(--sp-2) var(--sp-2);
  }
  .remove {
    margin-top: var(--sp-1);
  }
</style>
