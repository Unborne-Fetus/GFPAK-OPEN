import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'web/e2e',
  timeout: 45000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173/GFPAK-OPEN/',
    acceptDownloads: true,
    headless: true,
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'] }
  },
  reporter: 'list',
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/GFPAK-OPEN/',
    reuseExistingServer: !process.env.CI,
    timeout: 120000
  }
});
