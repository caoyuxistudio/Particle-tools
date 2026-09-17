<script>
  import { loadCustomAssets } from '@particle-tools/engine/assets';
  import { textureConfigs } from '@particle-tools/engine/texture-config';
  import {
    VIDEO_TEXTURES_CHANGED,
    addVideoFile,
    addVideoUrl,
    ensureVideoTexture,
    readVideoEntries,
    removeVideo,
    renameVideo,
  } from '@particle-tools/engine/video-textures';
  import { getTexture } from '@particle-tools/engine/assets';
  import FileUploader from './../library/file-uploader.svelte';
  import VideoUploader from './video-uploader.svelte';
  import { Svroller } from 'svrollbar';
  import { Input } from '@smui/textfield';
  import Paper from '@smui/paper';
  import { Icon } from '@smui/common';
  import TextureItem from './texture-item.svelte';
  import { showErrorSnackbar, showSuccessSnackbar } from './../../../js/stores/snackbar-store';

  const STORAGE_KEY = 'particle-system-editor/image-textures';

  let rawList = $state(JSON.parse(localStorage.getItem(STORAGE_KEY)) || []);
  // Videos keep their own list (and their bytes in IndexedDB); this panel is
  // where the two kinds of colour source meet.
  let videoList = $state(readVideoEntries());
  let addingVideo = $state(false);
  let filter = $state('');
  let currentTextureId = $state(getCurrentId());

  function getCurrentId() {
    return window.editor?.getCurrentParticleSystemConfig()._editorData.colorInstanceTextureId;
  }

  // The list can change under this panel: a loaded config importing a URL
  // video, another window of the editor, the harness. Re-read it whenever the
  // module says so, and on cross-window storage events.
  $effect(() => {
    const refresh = () => {
      videoList = readVideoEntries();
      currentTextureId = getCurrentId();
    };
    const onStorage = (event) => {
      if (event.key === null || event.key === 'particle-system-editor/video-textures') refresh();
    };
    window.addEventListener(VIDEO_TEXTURES_CHANGED, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(VIDEO_TEXTURES_CHANGED, refresh);
      window.removeEventListener('storage', onStorage);
    };
  });

  // One list for the panel: videos first (newest first), then images (newest
  // first). Keys are prefixed so an image and a video can never collide.
  const items = $derived(
    [
      ...videoList.map((entry) => ({
        key: `v${entry.id}`,
        id: entry.id,
        name: entry.name,
        url: entry.thumbnail || '',
        kind: 'video',
        meta: entry,
      })),
      ...rawList.map((entry) => ({
        key: `i${entry.id}`,
        id: entry.id,
        name: entry.name,
        url: entry.url,
        kind: 'image',
        meta: null,
      })),
    ].filter(({ name }) => name.toLowerCase().includes(filter.toLowerCase()))
  );

  // Returns false when the write was rejected (quota) so callers can roll back
  // instead of showing an entry that will be gone after a reload.
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rawList));
      return true;
    } catch (error) {
      showErrorSnackbar('Not enough browser storage left — delete some textures and try again.');
      return false;
    }
  };

  const add = (url) => {
    const randomId = Math.floor(Math.random() * 100000000);
    const entry = {
      url,
      // 1000 names collide after a few dozen uploads (birthday bound), which
      // makes a config's embedded texture bind to an unrelated local image.
      name: `ImageTexture-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      id: randomId,
    };
    rawList.unshift(entry);
    // Persist immediately: the entry must survive even if the image cannot be
    // decoded into a GPU texture, otherwise it shows in the list but is gone
    // after a reload.
    if (!save()) {
      rawList.shift();
      return;
    }
    loadCustomAssets({
      textures: [{ id: entry.name, url }],
      onComplete: () => {},
    });
  };

  const addVideo = async (file) => {
    addingVideo = true;
    try {
      const entry = await addVideoFile(file);
      videoList = readVideoEntries();
      showSuccessSnackbar(`Video added as ${entry.name}`);
    } catch (error) {
      showErrorSnackbar(error?.message || 'Failed to add the video');
    } finally {
      addingVideo = false;
    }
  };

  const addVideoByUrl = async (url) => {
    addingVideo = true;
    try {
      const entry = await addVideoUrl(url);
      videoList = readVideoEntries();
      showSuccessSnackbar(`Video added as ${entry.name}`);
    } catch (error) {
      showErrorSnackbar(error?.message || 'Failed to load the video from that address');
    } finally {
      addingVideo = false;
    }
  };

  const removeVideoEntry = async (id) => {
    const entry = videoList.find((e) => e.id === id);
    if (entry && getCurrentId() === entry.name) {
      window.editor.setColorInstanceTexture(undefined);
      currentTextureId = undefined;
    }
    await removeVideo(id);
    videoList = readVideoEntries();
  };

  const renameVideoEntry = async ({ id, name }) => {
    const entry = videoList.find((e) => e.id === id);
    if (!entry || entry.name === name || !name) return;
    const wasCurrent = getCurrentId() === entry.name;
    await renameVideo(id, name);
    if (wasCurrent) {
      window.editor.getCurrentParticleSystemConfig()._editorData.colorInstanceTextureId = name;
      currentTextureId = name;
    }
    videoList = readVideoEntries();
  };

  const useVideo = async (id) => {
    const entry = videoList.find((e) => e.id === id);
    if (!entry) return;
    // A card can outlive its video (removed elsewhere, or a failed decode).
    // Binding a name nothing answers to would silently leave the particles
    // colourless, so make sure the source is really there first.
    if (!getTexture(entry.name)) {
      const record = await ensureVideoTexture(entry.name).catch(() => null);
      if (!record) {
        showErrorSnackbar(`"${entry.name}" is no longer available — add it again.`);
        videoList = readVideoEntries();
        return;
      }
    }
    window.editor.setColorInstanceTexture(entry.name);
    currentTextureId = entry.name;
  };

  const remove = (id) => {
    const entry = rawList.find(({ id: currentId }) => currentId === id);
    if (entry) {
      const idx = textureConfigs.findIndex(({ id: cfgId }) => cfgId === entry.name);
      if (idx >= 0) textureConfigs.splice(idx, 1);
      if (getCurrentId() === entry.name) {
        window.editor.setColorInstanceTexture(undefined);
        currentTextureId = undefined;
      }
    }
    rawList = rawList.filter(({ id: currentId }) => currentId !== id);
    save();
  };

  const rename = ({ id, name }) => {
    const currentEntry = rawList.find((entry) => entry.id === id);
    if (currentEntry && currentEntry.name !== name) {
      textureConfigs.forEach(
        (entry) => (entry.id = entry.id === currentEntry.name ? name : entry.id)
      );
      if (getCurrentId() === currentEntry.name) {
        window.editor.getCurrentParticleSystemConfig()._editorData.colorInstanceTextureId = name;
        currentTextureId = name;
      }
      currentEntry.name = name;
      save();
    }
  };

  const use = (id) => {
    const entry = rawList.find(({ id: currentId }) => currentId === id);
    if (!entry) return;
    window.editor.setColorInstanceTexture(entry.name);
    currentTextureId = entry.name;
  };
</script>

<div class="head">
  <Paper class="solo-paper" elevation={6}>
    <Icon class="material-icons">search</Icon>
    <Input bind:value={filter} placeholder="Search" class="solo-input" />
  </Paper>
  <FileUploader {add} />
  <VideoUploader add={addVideo} addUrl={addVideoByUrl} />
  <div class="current">
    Instance source: <b>{currentTextureId || 'None'}</b>
    {#if addingVideo}<span class="busy">— storing video…</span>{/if}
  </div>
</div>
<Svroller width="100%" height="calc(100% - 168px)">
  {#each items as item (item.key)}
    {#if item.kind === 'video'}
      <TextureItem
        id={item.id}
        name={item.name}
        url={item.url}
        kind="video"
        meta={item.meta}
        remove={removeVideoEntry}
        rename={renameVideoEntry}
        use={useVideo}
        inUse={item.name === currentTextureId}
      />
    {:else}
      <TextureItem
        id={item.id}
        name={item.name}
        url={item.url}
        {remove}
        {rename}
        {use}
        inUse={item.name === currentTextureId}
      />
    {/if}
  {/each}
  {#if items.length === 0}
    <div class="empty">
      No colour sources yet — "Add Image" or "Add Video" to upload one. A video plays on a loop and
      the particles sample whichever frame is showing when they are born.
    </div>
  {/if}
</Svroller>

<style lang="scss">
  .head {
    margin-bottom: 8px;
  }

  .current {
    padding: 8px 16px 0;
    font-size: 12px;
    opacity: 0.8;
  }

  .busy {
    opacity: 0.7;
  }

  .empty {
    padding: 24px 16px;
    font-size: 13px;
    opacity: 0.6;
  }

  * :global(.solo-paper) {
    display: flex;
    align-items: center;
    flex-grow: 1;
    max-width: 600px;
    padding: 0 12px;
    height: 48px;
    margin: 16px;
  }
  * :global(.solo-paper > *) {
    display: inline-block;
    margin: 0 12px;
  }
  * :global(.solo-input) {
    flex-grow: 1;
    color: var(--mdc-theme-on-surface, #000);
  }
  * :global(.solo-input::placeholder) {
    color: var(--mdc-theme-on-surface, #000);
    opacity: 0.6;
  }
</style>
