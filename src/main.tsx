import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { logoUrl } from './assets/brand'
import { App } from './App'
import './index.css'

/*
 * The tab icon is set here rather than with a `<link href="./logo.png">` in index.html.
 *
 * A static tag would need a second copy of the image in `public/`, and the logo is ~900 KB — so the
 * deployment would carry it twice for one 16-pixel icon. Pointing the existing tag at the imported
 * URL reuses the one hashed asset the bundle already has, and it stays correct under a subdirectory
 * or a CDN path where a relative href would not.
 */
const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
if (icon) icon.href = logoUrl

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
