<script lang="ts">
  import type { Field } from '@particle-tools/engine/schema';
  import { get, patch, revision, document } from '../store/document.svelte';
  import NumberRow from './NumberRow.svelte';
  import ListView from './ListView.svelte';
  import { openCurve, openGradient, resetGradient, openTexture } from '../editors/open';

  let { field, prefix, scope = null }: { field: Field; prefix: string; scope?: any } = $props();

  const path = $derived(prefix + field.path);
  // A compound value (vec3, colour, min/max) is written one component at a
  // time, in place: the object the document holds stays the same object, and
  // a derived that hands back the same object is "unchanged" — the number
  // beside a drift or influence slider never followed the drag. A shallow
  // copy per revision makes the change visible; nothing writes through it.
  const value = $derived.by(() => {
    revision();
    const v = get(path);
    return v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : v;
  });
  const shown = $derived((revision(), !field.when || field.when(scope ?? document)));

  const toHex = (c: any): string => {
    if (!c || typeof c !== 'object') return '#ffffff';
    const h = (v: number) => Math.round(Math.min(1, Math.max(0, v ?? 0)) * 255).toString(16).padStart(2, '0');
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  };
  const fromHex = (hex: string) => ({
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  });
  const isCurve = (v: any) => v && typeof v === 'object' && 'type' in v;
  const minmax = (v: any): { min: number; max: number } =>
    v && typeof v === 'object' && !isCurve(v) ? { min: v.min ?? 0, max: v.max ?? 0 } : { min: Number(v) || 0, max: Number(v) || 0 };
  const displayScale = $derived(field.displayScale ?? 1);
</script>

{#if shown && field.kind !== 'hidden'}
  <div class="field" data-path={path} data-kind={field.kind}>
    {#if field.kind === 'number' || field.kind === 'int'}
      <NumberRow label={field.label} min={field.min!} max={field.max!} step={field.step!} value={(value ?? 0) * displayScale} onchange={(v) => patch(path, v / displayScale)} hint={field.hint} />
    {:else if field.kind === 'bool'}
      <label class="row">
        <span class="label" title={field.hint}>{field.label}</span>
        <input type="checkbox" checked={!!value} onchange={(e) => patch(path, (e.currentTarget as HTMLInputElement).checked)} />
      </label>
    {:else if field.kind === 'enum'}
      <label class="row">
        <span class="label" title={field.hint}>{field.label}</span>
        <select value={String(value)} onchange={(e) => { const raw = (e.currentTarget as HTMLSelectElement).value; const opt = field.options!.find((o) => String(o.value) === raw); patch(path, opt ? opt.value : raw); }}>
          {#each field.options ?? [] as o (o.value)}
            <option value={String(o.value)}>{o.label}</option>
          {/each}
        </select>
      </label>
    {:else if field.kind === 'color'}
      <label class="row">
        <span class="label" title={field.hint}>{field.label}</span>
        <input type="color" value={toHex(value)} oninput={(e) => patch(path, fromHex((e.currentTarget as HTMLInputElement).value))} />
      </label>
    {:else if field.kind === 'vec2' || field.kind === 'vec3'}
      <div class="sub" title={field.hint}>{field.label}</div>
      {#each field.kind === 'vec2' ? ['x', 'y'] : ['x', 'y', 'z'] as axis (axis)}
        <NumberRow label={axis} min={field.min!} max={field.max!} step={field.step!} value={value?.[axis] ?? 0} onchange={(v) => patch(`${path}.${axis}`, v)} />
      {/each}
    {:else if field.kind === 'value'}
      <div class="sub" title={field.hint}>{field.label}</div>
      {#if isCurve(value)}
        <div class="row"><span class="label">curve · scale {value.scale ?? 1}</span><button onclick={() => openCurve(path)}>edit curve</button></div>
      {:else}
        {@const mm = minmax(value)}
        <NumberRow label="min" min={field.min!} max={field.max!} step={field.step!} value={mm.min} onchange={(v) => patch(path, { min: v, max: Math.max(v, mm.max) })} />
        <NumberRow label="max" min={field.min!} max={field.max!} step={field.step!} value={mm.max} onchange={(v) => patch(path, { min: Math.min(v, mm.min), max: v })} />
      {/if}
    {:else if field.kind === 'minmaxColor'}
      <div class="sub" title={field.hint}>{field.label}</div>
      <label class="row"><span class="label">min</span><input type="color" value={toHex(value?.min)} oninput={(e) => patch(`${path}.min`, fromHex((e.currentTarget as HTMLInputElement).value))} /></label>
      <label class="row"><span class="label">max</span><input type="color" value={toHex(value?.max)} oninput={(e) => patch(`${path}.max`, fromHex((e.currentTarget as HTMLInputElement).value))} /></label>
    {:else if field.kind === 'curve'}
      <NumberRow label={`${field.label} · scale`} min={field.min ?? 0} max={field.max ?? 10} step={field.step ?? 0.1} value={value?.scale ?? 1} onchange={(v) => patch(`${path}.scale`, v)} hint={field.hint} />
      <div class="row"><span></span><button onclick={() => openCurve(path)}>edit curve</button></div>
    {:else if field.kind === 'gradient'}
      <div class="row"><span class="label" title={field.hint}>{field.label}</span><span class="pair"><button onclick={openGradient}>edit gradient</button><button onclick={resetGradient} title="Reset to the default gradient">reset</button></span></div>
    {:else if field.kind === 'texture'}
      <div class="row"><span class="label" title={field.hint}>{field.label}</span><span class="mono">{value ?? 'none'}</span></div>
      <div class="row"><span></span><button onclick={() => openTexture(field.path === '_editorData.textureId' ? 'sprite' : 'source')}>choose…</button></div>
    {:else if field.kind === 'list'}
      <ListView {field} {path} />
    {/if}
  </div>
{/if}

<style>
  .field {
    margin: var(--sp-1) 0;
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-items: center;
    gap: var(--sp-2);
    min-height: var(--control-h);
  }
  .label {
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    color: var(--fg-dim);
    margin-top: var(--sp-1);
  }
  .note {
    color: var(--fg-dim);
    font-size: var(--fs-1);
  }
  .pair {
    display: flex;
    gap: var(--sp-1);
  }
  .pair button {
    flex: 1;
  }
  .mono {
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
