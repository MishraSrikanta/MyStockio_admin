/**
 * The MyStockio logo, imported so the bundler fingerprints it and rewrites the URL.
 *
 * Referencing `/src/assets/logo.png` as a bare string works under `vite dev` and is emitted
 * verbatim into a production build, where that path does not exist — the built asset is hashed.
 * Importing it is what makes the URL correct in both. Same arrangement as the shop app.
 */
import logoUrl from './logo.png'

export { logoUrl }

/** Shown beside the logo. Kept here so the two travel together. */
export const APP_NAME = 'MyStockio'
export const CONSOLE_NAME = 'Admin Console'

/**
 * The public marketing site.
 *
 * The same value MyStockio holds in `src/lib/legal.ts`. Duplicated rather than shared because these
 * are separate deployments with no common package — change it in both when the site moves.
 */
export const OFFICIAL_SITE_URL = 'https://mystockiooffical.vercel.app/'
