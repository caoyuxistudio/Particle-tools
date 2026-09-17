<!-- Ported from V1 packages/editor/src/components/content/scene/scene.svelte (2026-09-17): same markup and logic, tokens instead of SMUI, a plain scrolling list instead of svrollbar. -->
<script>
  import { glyph } from './glyph';
  import SceneItem from './SceneItem.svelte';
  import {
    getSceneObjects,
    addSceneObject,
    updateSceneObject,
    removeSceneObject,
    bakeLightProbe,
    duplicateSceneObject,
    selectSceneObject,
    getSelectedId,
    setTransformMode,
    setOnSceneChanged,
    allowedTransformModes,
    getSceneObject,
    getOutputCameraId,
  } from '@engine/scene-objects';
  import {
    setPreviewVisible,
    isPreviewVisible,
  } from '@engine/world';
  import { onMount } from 'svelte';

  let objects = $state([...getSceneObjects()]);
  let selectedId = $state(getSelectedId());
  let mode = $state('translate');
  /** Right-click target: { id, x, y } while open, null when closed. */
  let menu = $state(null);

  const refresh = () => {
    objects = [...getSceneObjects()];
    outputCameraId = getOutputCameraId();
  };

  let outputCameraId = $state(null);
  let preview = $state(true);

  const togglePreview = () => {
    preview = !preview;
    setPreviewVisible(preview);
  };

  // The stored objects change without the panel asking — a gizmo drag, or a
  // config load bringing its own scene. Mirror them back into the list.
  onMount(() => {
    setOnSceneChanged(() => {
      refresh();
      selectedId = getSelectedId();
    });
    return () => setOnSceneChanged(null);
  });

  const select = (id) => {
    selectedId = selectedId === id ? null : id;
    selectSceneObject(selectedId);
    // A light has no meaningful rotate or scale, so fall back to move rather
    // than leaving a mode selected that does nothing.
    if (selectedId && !allowedTransformModes(getSceneObject(selectedId)?.type).includes(mode)) {
      chooseMode('translate');
    }
  };

  const visibleModes = $derived(
    MODES.filter((m) =>
      allowedTransformModes(getSceneObject(selectedId)?.type).includes(m.id)
    )
  );

  const chooseMode = (m) => {
    mode = m;
    setTransformMode(m);
  };

  const add = (type) => {
    const obj = addSceneObject(type);
    refresh();
    // A freshly added object is what you want to place, so grab it right away.
    if (obj.type !== 'LIGHT_PROBE') {
      selectedId = obj.id;
      selectSceneObject(obj.id);
    }
  };

  const update = (id, patch) => {
    updateSceneObject(id, patch);
    refresh();
  };

  const remove = (id) => {
    removeSceneObject(id);
    if (selectedId === id) selectedId = null;
    refresh();
  };

  const bake = async (id) => {
    await bakeLightProbe(id);
  };

  const contextMenu = (id, x, y) => (menu = { id, x, y });
  const closeMenu = () => (menu = null);

  const duplicate = (id) => {
    const copy = duplicateSceneObject(id);
    closeMenu();
    refresh();
    if (copy && copy.type !== 'LIGHT_PROBE') {
      selectedId = copy.id;
      selectSceneObject(copy.id);
    }
  };

  const removeFromMenu = (id) => {
    closeMenu();
    remove(id);
  };

  const BUTTONS = [
    { type: 'BOX', icon: 'view_in_ar', label: 'Box' },
    { type: 'SPHERE', icon: 'circle', label: 'Sphere' },
    { type: 'FRAME', icon: 'crop_din', label: 'Frame' },
    { type: 'POINT_LIGHT', icon: 'lightbulb', label: 'Point' },
    { type: 'DIRECTIONAL_LIGHT', icon: 'wb_sunny', label: 'Sun' },
    { type: 'LIGHT_PROBE', icon: 'blur_on', label: 'Probe' },
    { type: 'CAMERA', icon: 'photo_camera', label: 'Camera' },
    { type: 'ENVIRONMENT', icon: 'panorama_photosphere', label: 'Env' },
  ];

  const MODES = [
    { id: 'translate', icon: 'open_with', label: 'Move' },
    { id: 'rotate', icon: 'rotate_right', label: 'Rotate' },
    { id: 'scale', icon: 'aspect_ratio', label: 'Scale' },
  ];
</script>

<div class="scene">
<div class="add-bar">
  {#each BUTTONS as b}
    <button onclick={() => add(b.type)} title={`Add ${b.label}`}>
      <span class="icon">{glyph(b.icon)}</span>
      <span>{b.label}</span>
    </button>
  {/each}
</div>

{#if outputCameraId}
  <button class="preview-toggle" class:on={preview} onclick={togglePreview}>
    <span class="icon">{glyph(preview ? 'videocam' : 'videocam_off')}</span>
    <span>{preview ? 'Preview on' : 'Preview off'}</span>
  </button>
{/if}

{#if selectedId && visibleModes.length > 1}
  <div class="mode-bar">
    {#each visibleModes as m}
      <button class:active={mode === m.id} onclick={() => chooseMode(m.id)} title={m.label}>
        <span class="icon">{glyph(m.icon)}</span>
        <span>{m.label}</span>
      </button>
    {/each}
  </div>
{/if}

<div class="list">
  {#each objects as obj (obj.id)}
    <SceneItem
      {obj}
      {update}
      {remove}
      {bake}
      selected={selectedId === obj.id}
      {select}
      {contextMenu}
    />
  {/each}
  {#if objects.length === 0}
    <div class="empty">
      Nothing in the scene yet. Add a box to build a space, a light to shade it,
      and a probe for indirect light.
    </div>
  {/if}
</div>

</div>
{#if menu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="menu-backdrop" onclick={closeMenu} oncontextmenu={(e) => { e.preventDefault(); closeMenu(); }}></div>
  <div class="menu" style={`left:${menu.x}px; top:${menu.y}px`}>
    <button onclick={() => duplicate(menu.id)}>
      <span class="icon">{glyph('content_copy')}</span>
      <span>Duplicate</span>
    </button>
    <button class="danger" onclick={() => removeFromMenu(menu.id)}>
      <span class="icon">{glyph('delete')}</span>
      <span>Delete</span>
    </button>
  </div>
{/if}

<style lang="scss">
  .scene {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 900;
  }

  .menu {
    position: fixed;
    z-index: 901;
    min-width: 150px;
    padding: 4px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 0;
    box-shadow: none;

    button {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 7px 10px;
      background: none;
      border: none;
      border-radius: 0;
      color: inherit;
      cursor: pointer;
      font: inherit;
      font-size: var(--fs-3);
      text-align: left;

      &:hover { background: rgba(255, 255, 255, 0.1); }
      &.danger:hover { background: rgba(255, 107, 107, 0.18); color: var(--fg-max); }
      .icon { font-size: 16px; opacity: 0.8; }
    }
  }

  .add-bar {
    display: flex;
    gap: 6px;
    padding: 14px 12px;

    button {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      padding: 6px 2px;
      height: auto;
      background: transparent;
      border: 1px solid var(--line);
      border-radius: 0;
      color: var(--fg-dim);
      cursor: pointer;
      font: inherit;
      font-size: var(--fs-0);

      &:hover { background: rgba(255, 255, 255, 0.12); }
      .icon { font-size: 18px; }
    }
  }

  .preview-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: calc(100% - 16px);
    margin: 0 8px 8px;
    padding: 4px 0;
    height: auto;
    border: 1px solid var(--line);
    border-radius: 0;
    background: transparent;
    color: var(--fg-dim);
    cursor: pointer;
    font-size: var(--fs-1);
  }

  .preview-toggle.on {
    border-color: var(--fg-strong);
    color: var(--fg-strong);
  }

  .mode-bar {
    display: flex;
    gap: 4px;
    padding: 0 12px 8px;

    button {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 5px 2px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--line);
      border-radius: 0;
      color: inherit;
      cursor: pointer;
      font: inherit;
      font-size: var(--fs-1);

      &.active {
        background: var(--fg-strong);
        border-color: transparent;
        color: var(--fg-max);
      }
      .icon { font-size: 15px; }
    }
  }

  .empty {
    padding: 20px 16px;
    font-size: var(--fs-3);
    line-height: 1.6;
    opacity: 0.55;
  }
</style>
