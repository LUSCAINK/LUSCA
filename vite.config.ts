import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const API = process.env.LUSCA_API ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  base: '/',
  // Pre-bundle every client dependency in one pass. Lazy pages otherwise trigger late
  // re-optimisation, which can load two copies of React in dev ("Invalid hook call").
  optimizeDeps: {
    include: [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      'react-router-dom',
      'zustand',
      'three',
      'three/examples/jsm/postprocessing/EffectComposer.js',
      'three/examples/jsm/postprocessing/RenderPass.js',
      'three/examples/jsm/postprocessing/UnrealBloomPass.js',
      'three/examples/jsm/postprocessing/OutputPass.js',
      'three/examples/jsm/controls/OrbitControls.js',
    ],
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
  },
})
