import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/main.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
