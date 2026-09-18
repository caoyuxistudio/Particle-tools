<script lang="ts">
  // The timeline (engine/timeline.ts): the piece's time as a bar you hold —
  // play / pause / stop, a range with two ends you can drag or type, a frame
  // rate, loop, and real time on or off. It reads the engine's clock every
  // animation frame; what it changes goes into the document
  // (`_editorData.timeline`), so it travels with the piece.
  import { patch } from '../store/document.svelte';
  import { play, pause, stop, holdPlayhead, getTimelineState, getTimelineSettings, type TimelineState } from '../engine/session';

  const FPS_CHOICES = [24, 25, 30, 50, 60, 120];

  let state = $state<TimelineState>(getTimelineState());
  $effect(() => {
    let raf = 0;
    const tick = () => {
      state = getTimelineState();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  /** Writes the whole block: a piece carries a complete timeline or none. */
  const set = (change: Partial<TimelineState>) => {
    const { fps, length, start, end, loop, realtime, restartOnLoop } = { ...getTimelineSettings(), ...change };
    patch('_editorData.timeline', { fps, length, start, end, loop, realtime, restartOnLoop });
  };

  /** A new frame rate keeps the seconds: 1200 frames at 60 are 600 at 30, and the range with them. */
  const setFps = (fps: number) => {
    const k = fps / state.fps;
    set({ fps, length: Math.round(state.length * k), start: Math.round(state.start * k), end: Math.round(state.end * k) });
  };

  // The track is the whole project, frame 0 to its length; the range is chosen inside it.
  const extent = $derived(Math.max(2, state.length));
  const pct = (frame: number) => `${Math.min(100, Math.max(0, (frame / extent) * 100))}%`;

  let track: HTMLDivElement;
  let dragging: 'start' | 'end' | 'head' | null = null;

  const frameAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * extent);
  };
  /** A synthetic pointer (the harness's) has nothing to capture. */
  const capture = (el: HTMLElement, id: number) => {
    try {
      el.setPointerCapture(id);
    } catch {
      /* not a real pointer */
    }
  };
  const grab = (which: 'start' | 'end') => (event: PointerEvent) => {
    dragging = which;
    capture(event.currentTarget as HTMLElement, event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const inRange = (frame: number) => Math.min(state.end, Math.max(state.start, frame));
  /** The playhead itself, taken by the hand: time goes where it is dragged and plays on from there. */
  const grabHead = (event: PointerEvent) => {
    dragging = 'head';
    capture(event.currentTarget as HTMLElement, event.pointerId);
    holdPlayhead(inRange(frameAt(event.clientX)));
    event.preventDefault();
    event.stopPropagation();
  };
  const drag = (event: PointerEvent) => {
    if (!dragging) return;
    const frame = frameAt(event.clientX);
    if (dragging === 'head') holdPlayhead(inRange(frame));
    else if (dragging === 'start') set({ start: Math.min(frame, state.end - 1) });
    else set({ end: Math.max(frame, state.start + 1) });
  };
  const release = () => {
    if (dragging === 'head') holdPlayhead(null);
    dragging = null;
  };

  const commit = (key: 'start' | 'end', raw: string) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return;
    if (key === 'start') set({ start: Math.max(0, Math.min(n, state.end - 1)) });
    else set({ end: Math.min(state.length, Math.max(n, state.start + 1)) });
  };
  /** A new length keeps the range where it was, as far as it still fits. */
  const commitLength = (raw: string) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 2) return;
    set({ length: n, start: Math.min(state.start, n - 1), end: Math.min(state.end, n) });
  };
  const seconds = (frames: number) => (frames / state.fps).toFixed(frames % state.fps === 0 ? 0 : 2);
</script>

<section class="timeline" aria-label="Timeline">
  <div class="transport">
    {#if state.playing}
      <button onclick={pause} title="Pause: time stops where it is">❙❙</button>
    {:else}
      <button onclick={play} title="Play">▶</button>
    {/if}
    <button onclick={stop} title="Stop: back to the start of the range, the simulation cleared">■</button>
  </div>

  <div class="readout" title="The current frame at this frame rate, and the timecode: minutes : seconds : frames">
    <span class="frame">{state.frame}</span>
    <span class="code">{state.timecode}</span>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="track" bind:this={track} onpointermove={drag} onpointerup={release} onpointercancel={release}>
    <div class="range" style:left={pct(state.start)} style:width={`calc(${pct(state.end)} - ${pct(state.start)})`}></div>
    <div class="head" style:left={pct(state.frame)} onpointerdown={grabHead} title="Drag the playhead: time goes where you put it and plays on from there. The particles are not re-run."></div>
    <div class="handle" style:left={pct(state.start)} onpointerdown={grab('start')} title="Start of the range: drag, or type it on the right"></div>
    <div class="handle" style:left={pct(state.end)} onpointerdown={grab('end')} title="End of the range: drag, or type it on the right"></div>
  </div>

  <label title="First frame of the range">start <input type="number" min="0" value={state.start} onchange={(e) => commit('start', e.currentTarget.value)} /></label>
  <label title="Last frame of the range">end <input type="number" min="1" value={state.end} onchange={(e) => commit('end', e.currentTarget.value)} /></label>
  <span class="total" title="Frames in the range, and how long that is at this frame rate">{state.total} f · {seconds(state.total - 1)} s</span>
  <label title="Frames a second. The range keeps its length in seconds when this changes.">fps
    <select value={String(state.fps)} onchange={(e) => setFps(Number(e.currentTarget.value))}>
      {#each FPS_CHOICES.includes(state.fps) ? FPS_CHOICES : [...FPS_CHOICES, state.fps].sort((a, b) => a - b) as f (f)}
        <option value={String(f)}>{f}</option>
      {/each}
    </select>
  </label>
  <label title="The whole project in frames: start and end are chosen inside 0 … length.">length <input type="number" min="2" value={state.length} onchange={(e) => commitLength(e.currentTarget.value)} /></label>
  <label class="check" title="At the end of the range: back to the start, or hold on the last frame">
    <input type="checkbox" checked={state.loop} onchange={(e) => set({ loop: e.currentTarget.checked })} /> loop
  </label>
  {#if state.loop}
    <label class="check" title="Each time the loop comes round: off, the frame counter goes back and the particles carry on; on, the simulation starts over from nothing, so every pass through the range is the same run.">
      <input type="checkbox" checked={state.restartOnLoop} onchange={(e) => set({ restartOnLoop: e.currentTarget.checked })} /> restart
    </label>
  {/if}
  <label class="check" title="On: the piece keeps its speed, and a slow frame skips frame numbers. Off: every frame is simulated and drawn, one step of 1/fps each, however long it takes — slow motion instead of dropped frames.">
    <input type="checkbox" checked={state.realtime} onchange={(e) => set({ realtime: e.currentTarget.checked })} /> real time
  </label>
</section>

<style>
  .timeline {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: 0 var(--sp-3);
    background: var(--panel);
    border-top: 1px solid var(--line);
    font-size: var(--fs-1);
    color: var(--fg-dim);
    white-space: nowrap;
    min-width: 0;
  }
  .transport {
    display: flex;
    gap: var(--sp-1);
  }
  .transport button {
    width: 26px;
    padding: 0;
    font-size: var(--fs-2);
  }
  .readout {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    min-width: 108px;
  }
  .frame {
    color: var(--fg-strong);
    font-size: var(--fs-3);
    min-width: 40px;
    text-align: right;
  }
  .code {
    color: var(--fg);
  }
  .track {
    position: relative;
    flex: 1;
    min-width: 80px;
    height: 14px;
    border: 1px solid var(--line);
    touch-action: none;
  }
  .range {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--panel-2);
    border-left: 1px solid var(--fg-dim);
    border-right: 1px solid var(--fg-dim);
  }
  /* The playhead: a line to see, a wider strip to take hold of. */
  .head {
    position: absolute;
    top: -4px;
    bottom: -4px;
    width: 11px;
    margin-left: -5px;
    cursor: grab;
    z-index: 1;
  }
  .head::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 5px;
    width: 1px;
    background: var(--accent);
  }
  .head:hover::before,
  .head:active::before {
    width: 3px;
    left: 4px;
  }
  .head:active {
    cursor: grabbing;
  }
  .handle {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 9px;
    margin-left: -4px;
    cursor: ew-resize;
  }
  .handle:hover {
    background: color-mix(in srgb, var(--fg) 25%, transparent);
  }
  label {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
  }
  label input[type='number'] {
    width: 58px;
  }
  label select {
    width: 52px;
  }
  .check input {
    margin: 0;
  }
  .total {
    color: var(--fg);
  }
  @media (max-width: 1100px) {
    .total,
    .code {
      display: none;
    }
  }
  @media (max-width: 760px) {
    .track {
      display: none;
    }
  }
</style>
