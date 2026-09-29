import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式：前端 5173，后端 3000；/api 与静态资源代理到后端
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
