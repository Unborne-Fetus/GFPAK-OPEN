import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: process.env.GFPAK_DESKTOP === '1' ? '/' : '/GFPAK-OPEN/',
  publicDir: 'public',
  // ooz-wasm uses top-level await to instantiate its local embedded WASM.
  // Vite's dev prebundle otherwise defaults to es2020 and rejects it.
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  build: {
    outDir: process.env.GFPAK_DESKTOP === '1' ? '../dist-desktop' : '../dist-web',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
