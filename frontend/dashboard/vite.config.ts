import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [svelte()],
  build: {
    outDir: '../../dist/frontend/dashboard',
    emptyOutDir: true
  }
});
