<script lang="ts">
  let { label, min, max, step, value, onchange, hint = undefined }: { label: string; min: number; max: number; step: number; value: number; onchange: (v: number) => void; hint?: string } = $props();
  const decimals = $derived(Math.max(0, Math.min(6, Math.ceil(-Math.log10(step || 1)))));
  const shown = $derived(Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    onchange(Math.min(max, Math.max(min, n)));
  };
</script>

<!-- genie's pair: a range and a number for the same value. -->
<div class="row" title={hint}>
  <span class="label">{label}</span>
  <input type="range" {min} {max} {step} value={shown} oninput={(e) => commit((e.currentTarget as HTMLInputElement).value)} />
  <input type="number" {min} {max} {step} value={shown} onchange={(e) => commit((e.currentTarget as HTMLInputElement).value)} />
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr 64px;
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
</style>
