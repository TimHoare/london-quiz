import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build works at any path (e.g. GitHub Pages' /london-quiz/).
  base: './',
  // MapLibre loads its web worker relative to its own module URL, which breaks
  // if Vite pre-bundles it into node_modules/.vite.
  optimizeDeps: { exclude: ['maplibre-gl', '@maplibre/maplibre-gl-leaflet'] },
});
