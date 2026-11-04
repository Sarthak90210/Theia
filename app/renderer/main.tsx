import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { TitleBar } from './TitleBar.tsx'

createRoot(document.getElementById('root')!).render(
  <>
    <TitleBar />
    <App />
  </>,
)
