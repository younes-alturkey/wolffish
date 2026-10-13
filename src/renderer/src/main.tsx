import '@lib/i18n'
import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * Two ways in. In Electron the preload has already put `window.api` on the
 * window before any script runs, and the app mounts at once. In a browser
 * there is no preload: the page is the Web UI, so the document is flagged
 * (`wf-web` — the stylesheet and `isWeb` read it) BEFORE the app's modules
 * load, the browser is checked for a session, and either the sign-in screen
 * or, once the socket says hello, the very same app is mounted.
 *
 * The app's modules are imported only once `window.api` exists: several
 * panels warm their caches at module scope, and on the web that object is
 * the socket bridge, which exists only after sign-in.
 */
const isWeb = typeof window.api === 'undefined'
if (isWeb) document.documentElement.classList.add('wf-web')

const root = createRoot(document.getElementById('root')!)

async function mountApp(): Promise<void> {
  const { default: App } = await import('@renderer/App')
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

async function start(): Promise<void> {
  if (!isWeb) {
    await mountApp()
    return
  }

  const [{ fetchAuthStatus, connectWeb, pendingNext, followNext }, { WebLogin }, i18n] =
    await Promise.all([
      import('@lib/web-bridge/boot'),
      import('@pages/WebLogin'),
      import('@lib/i18n').then((m) => m.default)
    ])
  // The sign-in screen renders before the app's locale is known: follow the
  // browser's language and the browser's color scheme until the app takes over.
  if (navigator.language.toLowerCase().startsWith('ar')) {
    await i18n.changeLanguage('ar')
    document.documentElement.lang = 'ar'
    document.documentElement.dir = 'rtl'
  }
  const dark = window.matchMedia('(prefers-color-scheme: dark)')
  const applyScheme = (): void => {
    document.documentElement.classList.toggle('dark', dark.matches)
  }
  applyScheme()
  dark.addEventListener('change', applyScheme)

  // A file link opened without a session was redirected here with the link
  // in `next`: sign in (or be signed in already), then go to it.
  const next = pendingNext()
  const mountSignedIn = async (): Promise<void> => {
    const mount = async (): Promise<void> => {
      await connectWeb()
      dark.removeEventListener('change', applyScheme)
      await mountApp()
    }
    if (next) await followNext(next, mount)
    else await mount()
  }

  const status = await fetchAuthStatus()
  if (status.authenticated) {
    await mountSignedIn()
    return
  }
  root.render(
    <StrictMode>
      <WebLogin status={status} next={next} onSignedIn={mountSignedIn} />
    </StrictMode>
  )
}

void start().catch((err) => {
  console.error('[boot] failed', err)
  root.render(
    <div className="bg-bg text-fg flex h-full w-full items-center justify-center p-6 text-sm">
      {err instanceof Error ? err.message : String(err)}
    </div>
  )
})
