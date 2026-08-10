import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/geist-mono/wght.css'

import { AuthGate } from './components/auth/AuthGate.js'
import './styles.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Expected #root element for web app bootstrap.')
}

createRoot(root).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
)
