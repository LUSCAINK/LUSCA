import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Serves the SEPIA-1 tokenizer release (models/sepia-1-tokenizer) at the stable path
 * /models/sepia-1-tokenizer/<file>: copied into dist at build time, served from the repo in dev.
 * The /sepia playground loads tokenizer.json from there and links the model card and eval.
 */
function tokenizerRelease(): Plugin {
  const dir = fileURLToPath(new URL('./models/sepia-1-tokenizer', import.meta.url))
  const files = ['tokenizer.json', 'vocab.json', 'merges.txt', 'eval.json', 'eval.md', 'MODEL_CARD.md', 'manifest.json']
  const prefix = '/models/sepia-1-tokenizer/'
  return {
    name: 'lusca-tokenizer-release',
    generateBundle() {
      for (const f of files) this.emitFile({ type: 'asset', fileName: `models/sepia-1-tokenizer/${f}`, source: fs.readFileSync(path.join(dir, f)) })
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.startsWith(prefix) ? decodeURIComponent(req.url.slice(prefix.length).split('?')[0]) : null
        if (!name || !files.includes(name)) return next()
        const type = name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'
        res.setHeader('Content-Type', type)
        res.end(fs.readFileSync(path.join(dir, name)))
      })
    },
  }
}

const API = process.env.LUSCA_API ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react(), tokenizerRelease()],
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
