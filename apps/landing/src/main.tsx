import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// three.js is most of the bundle; the page and its download links render without waiting for it.
const OceanScene = lazy(() => import('./OceanScene'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense>
      <OceanScene />
    </Suspense>
    <App />
  </StrictMode>
)
