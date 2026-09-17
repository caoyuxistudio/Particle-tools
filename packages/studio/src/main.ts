import { mount } from 'svelte';
import './ui/tokens.css';
import './ui/reset.css';
import App from './App.svelte';

export default mount(App, { target: document.getElementById('app')! });

// The harness rides in the dev bundle only: `await __st.report()` in the console.
if (import.meta.env.DEV) void import('./harness');
