import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'esnext',
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          tweakpane: ['tweakpane', '@tweakpane/core'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['three', 'tweakpane'],
  },
});
