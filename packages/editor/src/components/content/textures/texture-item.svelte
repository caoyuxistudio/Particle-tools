<script>
  import Card, { PrimaryAction, Media, Content } from '@smui/card';
  import Dialog, { Title, Content as DialogContent, Actions } from '@smui/dialog';
  import Button, { Icon, Label } from '@smui/button';
  import Textfield from '@smui/textfield';

  import { getVideoBlob } from '@particle-tools/engine/video-textures';

  let {
    id,
    name = $bindable(),
    url,
    rename,
    remove,
    use,
    inUse = false,
    kind = 'image',
    meta = null,
  } = $props();

  let open = $state(false);

  $effect(() => {
    if (name || name === '') rename({ id, name });
  });

  const removeRequest = () => (open = true);

  const formatDuration = (seconds) => {
    if (!seconds || !isFinite(seconds)) return '';
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  };

  const videoCaption = $derived(
    kind === 'video' && meta
      ? [
          formatDuration(meta.duration),
          meta.width && `${meta.width}×${meta.height}`,
          meta.source === 'url' ? 'URL' : meta.size && `${(meta.size / 1024 / 1024).toFixed(1)} MB`,
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  );

  const downloadTexture = async () => {
    try {
      let blob;
      if (kind === 'video') {
        blob =
          meta?.source === 'url' && meta.url
            ? await (await fetch(meta.url)).blob()
            : await getVideoBlob(name);
        if (!blob) return;
      } else {
        blob = await (await fetch(url)).blob();
      }
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${name}.${kind === 'video' ? 'mp4' : 'png'}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(blobUrl);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Failed to download texture:', error);
    }
  };
</script>

<div class="wrapper" class:in-use={inUse}>
  <Card>
    <Media class="card-media-16x9" aspectRatio="16x9">
      <div class="transparent-background"></div>
      <div class="media-background" style={`background-image: url(${url})`}></div>
      {#if kind === 'video'}
        <div class="kind-badge">VIDEO</div>
      {/if}
      {#if inUse}
        <div class="in-use-badge">INSTANCE</div>
      {/if}
    </Media>
    <Content class="mdc-typography--body2">
      <Textfield bind:value={name} />
      {#if videoCaption}
        <div class="caption">{videoCaption} · loops</div>
      {/if}
      <div class="actions">
        <Button color="secondary" variant={inUse ? 'raised' : 'outlined'} onclick={() => use(id)}>
          <Icon class="material-icons">colorize</Icon><Label>{inUse ? 'In Use' : 'Use'}</Label>
        </Button>
        <PrimaryAction onclick={downloadTexture}>
          <Icon class="material-icons">download</Icon>
        </PrimaryAction>
        <PrimaryAction onclick={removeRequest}>
          <Icon class="material-icons">delete</Icon>
        </PrimaryAction>
      </div>
    </Content>
  </Card>
</div>

<Dialog bind:open aria-labelledby="texture-delete-title" aria-describedby="texture-delete-content">
  <Title id="texture-delete-title">Delete {name}</Title>
  <DialogContent id="texture-delete-content">
    Are you sure you want to delete this texture?
  </DialogContent>
  <Actions>
    <Button>
      <Icon class="material-icons">close</Icon><Label>No</Label>
    </Button>
    <Button onclick={() => remove(id)}>
      <Icon class="material-icons">check</Icon><Label>Yes</Label>
    </Button>
  </Actions>
</Dialog>

<style lang="scss">
  .wrapper {
    margin: 16px;
    border: 1px solid var(--border);
    border-radius: 4px;

    &.in-use {
      border-color: var(--mdc-theme-secondary, #ff5722);
    }

    .transparent-background {
      background-image: url(./assets/images/transparent.webp);
      background-repeat: repeat;
      background-size: 10%;
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
    }

    .media-background {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-size: cover;
      background-position: center;
    }

    .kind-badge {
      position: absolute;
      top: 8px;
      left: 8px;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: #fff;
      background: #7e57c2;
    }

    .caption {
      margin-top: 4px;
      font-size: 11px;
      opacity: 0.7;
    }

    .in-use-badge {
      position: absolute;
      top: 8px;
      right: 8px;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: #fff;
      background: var(--mdc-theme-secondary, #ff5722);
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;

      :global(.mdc-card__primary-action) {
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
      }
    }
  }
</style>
