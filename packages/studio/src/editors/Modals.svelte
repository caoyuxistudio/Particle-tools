<!--
  The DOM V1's three canvas editors draw into (curve-editor.ts, gradient-editor.ts,
  texture-selector.ts look these classes up); copied from V1's content.svelte on
  2026-09-17 so the editors need no change (V2-ARCHITECTURE.md §9 question 4:
  the studio pre-embeds the same structure).
-->
<div class="gradient-editor-modal" style="display: none;">
  <div class="gradient-editor-modal__content">
    <div class="gradient-editor-modal__header">
      <h2>Gradient Editor</h2>
      <div class="gradient-editor-modal__header-buttons">
        <button class="gradient-editor-modal__info" title="Toggle controls info">?</button>
        <button class="gradient-editor-modal__close">×</button>
      </div>
    </div>
    <div class="gradient-editor-modal__body">
      <div class="gradient-editor-wrapper">
        <canvas class="gradient-editor-canvas" width="300" height="200"></canvas>
      </div>
      <div class="gradient-editor-info" style="display: none;">
        <p><strong>Click</strong> on the gradient bar to add new color stops</p>
        <p><strong>Double-click</strong> a stop to edit color and opacity</p>
        <p><strong>Drag</strong> middle stops to reposition (first/last are fixed)</p>
        <p><strong>Right-click</strong> a stop to delete (except first/last)</p>
      </div>
      <div class="gradient-editor-presets"></div>
    </div>
  </div>
</div>
<div class="bezier-editor-modal" style="display: none;">
  <div class="bezier-editor-modal__content">
    <div class="bezier-editor-modal__header">
      <h2>Bezier Curve Editor</h2>
      <div class="bezier-editor-modal__header-buttons">
        <button class="bezier-editor-modal__info" title="Toggle controls info">?</button>
        <button class="bezier-editor-modal__close">×</button>
      </div>
    </div>
    <div class="bezier-editor-modal__body">
      <div class="bezier-editor__content">
        <canvas class="bezier-editor__canvas" width="300" height="200"></canvas>
        <div class="draggable-points"></div>
      </div>
      <div class="bezier-editor-info" style="display: none;">
        <p><strong>Drag</strong> the points to adjust the curve shape</p>
        <p><strong>Control handles</strong> adjust the curve smoothness between points</p>
        <p><strong>First and last</strong> points can only move vertically</p>
        <p><strong>Middle point</strong> can move freely within the canvas</p>
      </div>
      <div class="bezier-editor-presets"></div>
    </div>
  </div>
</div>
<div class="texture-selector-modal" style="display: none;">
  <div class="texture-selector-modal__content">
    <div class="texture-selector-modal__header">
      <h2>Texture Selector</h2>
      <div class="texture-selector-modal__header-buttons">
        <button class="texture-selector-modal__close">×</button>
      </div>
    </div>
    <div class="texture-selector-modal__body">
      <div class="texture-selector-search">
        <span class="texture-selector-search-icon">⌕</span>
        <input
          type="text"
          class="texture-selector-search-input"
          placeholder="Search textures..."
        />
      </div>
      <div class="texture-selector-grid"></div>
    </div>
  </div>
</div>
