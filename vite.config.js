import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: process.env.GFPAK_DESKTOP === '1' ? '/' : '/GFPAK-OPEN/',
  publicDir: 'public',
  build: {
    outDir: process.env.GFPAK_DESKTOP === '1' ? '../dist-desktop' : '../dist-web',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
