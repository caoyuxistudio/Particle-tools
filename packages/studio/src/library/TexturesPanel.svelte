<script lang="ts">
  // The colour sources: images uploaded here (kept in localStorage as data
  // URLs, bounded in size), videos (metadata in localStorage, bytes in
  // IndexedDB, or a URL), and the built-in pictures. Ported from V1's Textures
  // panel: same registries, native controls, the studio's store for "use".
  import { loadCustomAssets, getTexture } from '@engine/assets';
  import { textureConfigs } from '@engine/texture-config';
  import { VIDEO_TEXTURES_CHANGED, addVideoFile, addVideoUrl, ensureVideoTexture, readVideoEntries, removeVideo } from '@engine/video-textures';
  import { get, revision } from '../store/document.svelte';
  import { useColourSource } from '../editors/open';

  const STORAGE_KEY = 'particle-system-editor/image-textures';
  type ImageEntry = { id: number; name: string; url: string };
  let images = $state<ImageEntry[]>(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') || []);
  let videos = $state<any[]>(readVideoEntries());
  let filter = $state('');
  let videoUrl = $state('');
  let busy = $state('');
  let note = $state('');
  let fileInput: HTMLInputElement;
  let videoInput: HTMLInputElement;
  const flash = (text: string) => {
    note = text;
    setTimeout(() => (note = ''), 2200);
  };
  const current = $derived((revision(), get('_editorData.colorInstanceTextureId') as string | undefined));

  $effect(() => {
    const refresh = () => (videos = readVideoEntries());
    window.addEventListener(VIDEO_TEXTURES_CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(VIDEO_TEXTURES_CHANGED, refresh);
      window.removeEventListener('storage', refresh);
    };
  });

  const builtIns = $derived(
    // Pictures only: not sprites, not the terrain tiles, not uploads (listed above from their own registry).
    textureConfigs.filter((c: any) => typeof c.url === 'string' && !c.url.startsWith('data:') && !c.isParticleTexture && !/^(TERRAIN|WIREFRAME)/.test(String(c.id))).map((c: any) => ({ key: `b${c.id}`, name: c.id, url: c.url, kind: 'built-in' as const }))
  );
  const items = $derived(
    [
      ...videos.map((v) => ({ key: `v${v.id}`, id: v.id, name: v.name, url: v.thumbnail || '', kind: 'video' as const })),
      ...images.map((i) => ({ key: `i${i.id}`, id: i.id, name: i.name, url: i.url, kind: 'image' as const })),
      ...builtIns,
    ].filter((i) => i.name.toLowerCase().includes(filter.toLowerCase()))
  );

  const save = (): boolean => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(images));
      return true;
    } catch {
      flash('not enough browser storage — delete some textures');
      return false;
    }
  };

  /** A data URL no wider than 1024px: camera-sized images would not survive localStorage. */
  const shrink = (dataUrl: string): Promise<string> =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const max = 1024;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        if (scale === 1) return resolve(dataUrl);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/webp', 0.9));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });

  const addImage = async (file: File) => {
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const url = await shrink(dataUrl);
    const entry: ImageEntry = { id: Math.floor(Math.random() * 1e8), name: `ImageTexture-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, url };
    images = [entry, ...images];
    if (!save()) {
      images = images.filter((i) => i.id !== entry.id);
      return;
    }
    loadCustomAssets({ textures: [{ id: entry.name, url }], onComplete: () => flash(`added ${entry.name}`) });
  };
  const addVideo = async (file: File) => {
    busy = 'storing video…';
    try {
      const entry = await addVideoFile(file);
      videos = readVideoEntries();
      flash(`added ${entry.name}`);
    } catch (e: any) {
      flash(e?.message || 'could not add the video');
    } finally {
      busy = '';
    }
  };
  const addVideoByUrl = async () => {
    const url = videoUrl.trim();
    if (!url) return;
    busy = 'loading video…';
    try {
      const entry = await addVideoUrl(url);
      videos = readVideoEntries();
      videoUrl = '';
      flash(`added ${entry.name}`);
    } catch (e: any) {
      flash(e?.message || 'could not load that address');
    } finally {
      busy = '';
    }
  };
  const use = async (item: any) => {
    if (item.kind === 'video' && !getTexture(item.name)) {
      const record = await ensureVideoTexture(item.name).catch(() => null);
      if (!record) {
        flash(`${item.name} is no longer available`);
        videos = readVideoEntries();
        return;
      }
    }
    useColourSource(item.name);
  };
  const remove = async (item: any) => {
    if (item.kind === 'video') {
      if (current === item.name) useColourSource(undefined);
      await removeVideo(item.id);
      videos = readVideoEntries();
    } else if (item.kind === 'image') {
      const idx = textureConfigs.findIndex((c: any) => c.id === item.name);
      if (idx >= 0) textureConfigs.splice(idx, 1);
      if (current === item.name) useColourSource(undefined);
      images = images.filter((i) => i.id !== item.id);
      save();
    }
  };
</script>

<div class="panel">
  <div class="head">
    <input type="text" placeholder="search" bind:value={filter} />
    <div class="actions">
      <button onclick={() => fileInput.click()}>add image</button>
      <button onclick={() => videoInput.click()}>add video</button>
    </div>
    <div class="actions">
      <input type="text" placeholder="video by URL (./assets/videos/…)" bind:value={videoUrl} onkeydown={(e) => e.key === 'Enter' && addVideoByUrl()} />
      <button onclick={addVideoByUrl}>add</button>
    </div>
    <div class="current">source: <b>{current || 'none'}</b>{#if busy}<span class="busy"> · {busy}</span>{/if}</div>
    {#if note}<div class="note">{note}</div>{/if}
  </div>
  <div class="list">
    {#each items as item (item.key)}
      <div class="item" class:in-use={item.name === current}>
        <div class="thumb" style={`background-image:url(${item.url})`}></div>
        <div class="meta">
          <div class="name" title={item.name}>{item.name}</div>
          <div class="kind">{item.kind}</div>
        </div>
        <div class="buttons">
          <button aria-pressed={item.name === current} onclick={() => use(item)}>{item.name === current ? 'in use' : 'use'}</button>
          {#if item.kind !== 'built-in'}<button class="x" onclick={() => remove(item)} title="Delete">×</button>{/if}
        </div>
      </div>
    {/each}
    {#if items.length === 0}
      <div class="empty">no colour sources match</div>
    {/if}
  </div>
</div>
<input type="file" accept="image/*" hidden bind:this={fileInput} onchange={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f) addImage(f); (e.currentTarget as HTMLInputElement).value = ''; }} />
<input type="file" accept="video/*" hidden bind:this={videoInput} onchange={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f) addVideo(f); (e.currentTarget as HTMLInputElement).value = ''; }} />

<style>
  .panel {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 0;
    font-size: var(--fs-2);
  }
  .head {
    padding: var(--sp-2) var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    border-bottom: 1px solid var(--line);
  }
  .actions {
    display: flex;
    gap: var(--sp-1);
  }
  .actions button {
    flex: 1;
  }
  .current,
  .note,
  .empty {
    color: var(--fg-dim);
    font-size: var(--fs-1);
  }
  .current b {
    color: var(--fg);
    font-weight: 400;
  }
  .list {
    overflow-y: auto;
    min-height: 0;
    padding: var(--sp-2) var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .item {
    display: grid;
    grid-template-columns: 44px 1fr auto;
    gap: var(--sp-2);
    align-items: center;
    padding: var(--sp-1);
    border: 1px solid var(--line-soft);
  }
  .item.in-use {
    border-color: var(--fg-strong);
  }
  .thumb {
    width: 44px;
    height: 44px;
    background: var(--panel-2) center / cover no-repeat;
  }
  .meta {
    min-width: 0;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kind {
    color: var(--fg-dim);
    font-size: var(--fs-1);
  }
  .buttons {
    display: flex;
    gap: var(--sp-1);
  }
  .x {
    width: var(--control-h);
    padding: 0;
  }
</style>
