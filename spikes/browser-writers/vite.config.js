import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      exceljs: resolve(import.meta.dirname, 'node_modules/exceljs/dist/exceljs.min.js')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: {
        export: resolve(import.meta.dirname, 'export.html'),
        background: resolve(import.meta.dirname, 'src/background.js')
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
    rollupOptions: {
      output: {
        entryFileNames: 'export-worker.js',
        chunkFileNames: 'chunks/[name].js'
      }
    }
  }
});
