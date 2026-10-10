import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: '/GFPAK-OPEN/',
  publicDir: 'public',
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
