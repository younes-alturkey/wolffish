import { Badge } from '@components/core/Badge'
import { Button } from '@components/core/Button'
import { cn } from '@lib/utils/cn'
import { signIn, type WebAuthStatus } from '@lib/web-bridge/boot'
import iconTransparent from '@resources/images/icon_transparent.png'
import {
  AlertCircleIcon,
  Clock01Icon,
  Download01Icon,
  EyeIcon,
  File01Icon,
  Login03Icon,
  Pdf02Icon,
  SquareLock01Icon,
  SquareUnlock01Icon,
  ViewOffIcon
} from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Notice = { kind: 'wrong' | 'locked' | 'failed'; text: string }

type LinkKind = 'file' | 'download' | 'pdf'

const LINK_ICONS: Record<LinkKind, typeof File01Icon> = {
  file: File01Icon,
  download: Download01Icon,
  pdf: Pdf02Icon
}

/**
 * The link this browser was sent here from, for the card: the workspace path
 * behind `/files/…` and `/download/…`, the device path behind
 * `/device?path=…`, otherwise the link itself.
 */
function describeNext(next: string): { kind: LinkKind; path: string } {
  const url = new URL(next, 'http://wolffish.invalid')
  const workspace = /^\/(files|download)\/(.+)$/.exec(url.pathname)
  try {
    if (workspace) {
      return {
        kind: workspace[1] === 'files' ? 'file' : 'download',
        path: decodeURIComponent(workspace[2])
      }
    }
    if (url.pathname === '/device') {
      return { kind: 'download', path: url.searchParams.get('path') ?? url.pathname }
    }
  } catch {
    /* a malformed escape — show the link as it is */
  }
  return { kind: url.pathname.startsWith('/pdf/') ? 'pdf' : 'file', path: url.pathname }
}

/**
 * The Web UI's door: one password field, the master password set in the
 * desktop app. Rendered before `window.api` exists, so it is deliberately
 * self-contained — no providers, no settings, the browser's own color
 * scheme. A successful sign-in sets the cookie that every later visit from
 * this browser rides on; `onSignedIn` then connects and mounts the app.
 */
export function WebLogin({
  status,
  next = null,
  onSignedIn
}: {
  status: WebAuthStatus
  /** A file link this browser was sent here from; shown so the detour makes sense. */
  next?: string | null
  onSignedIn: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (): Promise<void> => {
    if (busy || !password) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await signIn(password)
      if (!result.ok) {
        setNotice(
          result.retryAfterMs
            ? {
                kind: 'locked',
                text: t('web.login.rateLimited', { seconds: Math.ceil(result.retryAfterMs / 1000) })
              }
            : { kind: 'wrong', text: t('web.login.wrong') }
        )
        setPassword('')
        inputRef.current?.focus()
        return
      }
      await onSignedIn()
    } catch (err) {
      setNotice({ kind: 'failed', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const NoticeIcon = notice?.kind === 'locked' ? Clock01Icon : AlertCircleIcon
  const link = next ? describeNext(next) : null
  const LinkIcon = LINK_ICONS[link?.kind ?? 'file']

  return (
    <main className="bg-bg text-fg flex min-h-full w-full items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-md flex-col items-center gap-8">
        <header className="flex flex-col items-center gap-4 text-center">
          <img src={iconTransparent} alt="" width={80} height={80} className="h-20 w-20" />
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2">
              <h1 className="text-fg text-2xl font-semibold tracking-tight">
                {t('web.login.title')}
              </h1>
              <Badge variant="default" size="sm" dir="ltr" className="font-mono">
                v{status.version}
              </Badge>
            </div>
            <p className="text-muted text-sm">
              {status.passwordSet ? t('web.login.subtitle') : t('web.login.noPassword')}
            </p>
          </div>
        </header>
        <div className="flex w-full flex-col gap-4">
          {link && (
            <section className="bg-surface border-border flex w-full flex-col gap-3 rounded-2xl border p-5 text-start shadow-sm dark:shadow-none">
              <div className="flex items-start gap-3">
                <span className="bg-primary/15 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
                  <LinkIcon size={20} />
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-fg text-sm font-semibold">{t('web.login.link.title')}</p>
                  <p className="text-muted text-xs leading-relaxed">
                    {t('web.login.link.description')}
                  </p>
                </div>
              </div>
              <code
                dir="ltr"
                className="border-border bg-bg text-fg block w-full rounded-lg border px-3 py-2 text-left font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere"
              >
                {link.path}
              </code>
            </section>
          )}
          <section className="bg-surface border-border flex w-full flex-col gap-4 rounded-2xl border p-6 shadow-sm dark:shadow-none">
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <label className="relative block">
                <SquareLock01Icon
                  size={16}
                  aria-hidden
                  className="text-muted pointer-events-none absolute start-3 top-1/2 -translate-y-1/2"
                />
                <input
                  ref={inputRef}
                  type={shown ? 'text' : 'password'}
                  autoComplete="current-password"
                  enterKeyHint="go"
                  aria-label={t('web.login.placeholder')}
                  aria-invalid={notice?.kind === 'wrong' || undefined}
                  placeholder={t('web.login.placeholder')}
                  value={password}
                  disabled={busy || !status.passwordSet}
                  onChange={(e) => setPassword(e.target.value)}
                  className={cn(
                    'border-border bg-bg text-fg placeholder:text-muted/60 w-full rounded-lg border py-3 pe-11 ps-9 text-base',
                    'focus:border-primary/60 outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    notice?.kind === 'wrong' && 'border-red-500/70'
                  )}
                />
                <button
                  type="button"
                  onClick={() => setShown((value) => !value)}
                  aria-label={t(shown ? 'web.login.hide' : 'web.login.show')}
                  aria-pressed={shown}
                  className="text-muted hover:text-fg absolute end-2 top-1/2 flex h-8 w-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md"
                >
                  {shown ? <ViewOffIcon size={18} /> : <EyeIcon size={18} />}
                </button>
              </label>
              {notice && (
                <div
                  role="alert"
                  className={cn(
                    'flex items-start gap-2 rounded-lg border px-3 py-2 text-start text-sm',
                    notice.kind === 'locked'
                      ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100'
                      : 'border-red-300 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-900/40 dark:text-red-100'
                  )}
                >
                  <NoticeIcon size={16} className="mt-0.5 shrink-0" />
                  <span>{notice.text}</span>
                </div>
              )}
              <Button
                type="submit"
                size="lg"
                disabled={busy || !password || !status.passwordSet}
                className="w-full"
              >
                <Login03Icon size={18} />
                {t('web.login.signIn')}
              </Button>
            </form>
          </section>
          {!window.isSecureContext && (
            <section className="bg-surface border-border flex w-full items-start gap-3 rounded-2xl border p-5 text-start shadow-sm dark:shadow-none">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-300">
                <SquareUnlock01Icon size={20} />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-fg text-sm font-semibold">{t('web.login.insecure.title')}</p>
                <p className="text-muted text-xs leading-relaxed">
                  {t('web.login.insecure.description')}
                </p>
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  )
}
