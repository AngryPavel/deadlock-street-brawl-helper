import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // Electron loads dist/index.html via loadFile (no server), so assets must resolve relative to the
  // file, not from the site root; the browser dev server still needs the root-relative default.
  base: process.env.BASE_PATH ?? (mode === 'electron' ? './' : '/'),
  plugins: [
    react(),
    mode === 'electron' &&
      electron([
        {
          entry: 'electron/main.ts',
          vite: { build: { outDir: 'electron-dist', rollupOptions: { external: ['koffi', 'sharp'] } } },
        },
        {
          entry: 'electron/preload.ts',
          // Electron's sandboxed preload loader rejects ESM ("Cannot use import statement outside a
          // module"); package.json has "type": "module" so vite-plugin-electron's default output would
          // otherwise emit ESM. Force CommonJS and name the file .cjs so Node/Electron never guesses ESM
          // from the package type.
          vite: {
            build: {
              outDir: 'electron-dist',
              lib: { entry: 'electron/preload.ts', formats: ['cjs'], fileName: () => 'preload.cjs' },
              rollupOptions: { output: { format: 'cjs' } },
            },
          },
        },
      ]),
  ],
  server: { host: true },
  test: {
    environmentMatchGlobs: [['src/components/**', 'jsdom']],
  },
}));
