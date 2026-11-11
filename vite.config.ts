import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(rootDir, 'sidepanel.html'),
        popup: resolve(rootDir, 'popup.html'),
        options: resolve(rootDir, 'options.html'),
        background: resolve(rootDir, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});
