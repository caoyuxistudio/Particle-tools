<script>
  import { onMount } from 'svelte';
  import { createParticleSystemEditor } from './js/three-particles-editor';
  import Header from './components/header/header.svelte';
  import Content from './components/content/content.svelte';
  import LegacyConfigModal from './components/legacy-config-modal/legacy-config-modal.svelte';
  import Snackbar from './components/snackbar/snackbar.svelte';

  // As soon as the components are in the DOM — not on window.onload, which
  // waits for every example thumbnail and the fonts to finish first.
  onMount(() => {
    createParticleSystemEditor('#three-particles-editor');
  });
</script>

<Header />
<Content />
<LegacyConfigModal />
<Snackbar />
