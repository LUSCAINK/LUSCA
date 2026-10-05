import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startLive } from '@/lib/live'
import { installReloadOnStaleBuild } from '@/components/ErrorBoundary'

// after a deploy, stale chunk URLs 404: reload once (loop-guarded) instead of going black
installReloadOnStaleBuild()
startLive()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
