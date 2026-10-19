import { createRoot } from 'react-dom/client'

import WebApp from './WebApp'
import { ready } from './webI18n'

import './web.css'

await ready
createRoot(document.getElementById('root')!).render(<WebApp />)
