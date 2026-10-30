import { resolve } from 'node:path';

export default {
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      input: {
        export: resolve(import.meta.dirname, 'export.html'),
        'service-worker': resolve(import.meta.dirname, 'src/runtime/service-worker.ts')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  },
  worker: {
    format: 'es',
    rolldownOptions: {
      output: {
        entryFileNames: 'export-worker.js',
        chunkFileNames: 'chunks/[name].js'
      }
    }
  }
};
