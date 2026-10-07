import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Shell } from '@/components/shell/Shell'
import { ErrorBoundary } from '@/components/ErrorBoundary'

const Landing = lazy(() => import('@/pages/Landing'))
const Observatory = lazy(() => import('@/pages/Observatory'))
const Agents = lazy(() => import('@/pages/Agents'))
const Node = lazy(() => import('@/pages/Node'))
const Chain = lazy(() => import('@/pages/Chain'))
const Lens = lazy(() => import('@/pages/Lens'))
const Scan = lazy(() => import('@/pages/Scan'))
const Radar = lazy(() => import('@/pages/Radar'))
const Control = lazy(() => import('@/pages/Control'))
const Sepia = lazy(() => import('@/pages/Sepia'))
const Earn = lazy(() => import('@/pages/Earn'))
const Docs = lazy(() => import('@/pages/Docs'))
const NotFound = lazy(() => import('@/pages/NotFound'))
const Privacy = lazy(() => import('@/pages/Privacy'))
const Terms = lazy(() => import('@/pages/Terms'))

function Loading() {
  return (
    <div style={{ height: 'calc(100dvh - var(--bar-h) - var(--status-h))', display: 'grid', placeItems: 'center' }}>
      <span className="label caret">loading</span>
    </div>
  )
}

// Two error boundaries: this outer one catches a crash in the shell itself (full-screen
// panel); the one inside Shell wraps each page and keeps the top and status bars alive.
export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary variant="full">
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Suspense fallback={<Loading />}><Landing /></Suspense>} />
            <Route path="live" element={<Suspense fallback={<Loading />}><Observatory /></Suspense>} />
            <Route path="agents" element={<Suspense fallback={<Loading />}><Agents /></Suspense>} />
            <Route path="agents/:id" element={<Suspense fallback={<Loading />}><Agents /></Suspense>} />
            <Route path="chain" element={<Suspense fallback={<Loading />}><Chain /></Suspense>} />
            <Route path="chain/:chain/:address" element={<Suspense fallback={<Loading />}><Chain /></Suspense>} />
            <Route path="lens" element={<Suspense fallback={<Loading />}><Lens /></Suspense>} />
            <Route path="lens/:chain/:address" element={<Suspense fallback={<Loading />}><Lens /></Suspense>} />
            <Route path="scan" element={<Suspense fallback={<Loading />}><Scan /></Suspense>} />
            <Route path="radar" element={<Suspense fallback={<Loading />}><Radar /></Suspense>} />
            <Route path="control" element={<Suspense fallback={<Loading />}><Control /></Suspense>} />
            <Route path="node" element={<Suspense fallback={<Loading />}><Node /></Suspense>} />
            <Route path="sepia" element={<Suspense fallback={<Loading />}><Sepia /></Suspense>} />
            <Route path="earn" element={<Suspense fallback={<Loading />}><Earn /></Suspense>} />
            <Route path="docs" element={<Suspense fallback={<Loading />}><Docs /></Suspense>} />
            <Route path="docs/:section" element={<Suspense fallback={<Loading />}><Docs /></Suspense>} />
            <Route path="privacy" element={<Suspense fallback={<Loading />}><Privacy /></Suspense>} />
            <Route path="terms" element={<Suspense fallback={<Loading />}><Terms /></Suspense>} />
            <Route path="*" element={<Suspense fallback={<Loading />}><NotFound /></Suspense>} />
          </Route>
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
