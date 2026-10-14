import { Button } from '@components/core/Button'
import { Input } from '@components/core/Input'
import { Modal } from '@components/core/Modal'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { isWeb } from '@lib/utils/platform'
import {
  PASSWORD_MIN_LENGTH,
  scorePassword,
  type PasswordLevel
} from '@main/channels/web/password-strength'
import { Notice, WebHttpsCard } from '@pages/settings/WebHttpsCard'
import type {
  WebPublicLinkView,
  WebSessionView,
  WebUiConfigPatch,
  WebUiPublicConfig,
  WebUiStatus
} from '@preload/index'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  EyeIcon,
  Globe02Icon,
  LinkSquare02Icon,
  Notification03Icon,
  RefreshIcon,
  SquareLock01Icon,
  Tick02Icon,
  ViewOffIcon
} from 'hugeicons-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Settings → Channels → Web UI.
 *
 * The desktop app served to a browser. Three things the panel exists to do,
 * in this order: tell the truth about whether the server is up and at which
 * addresses; hold the one credential (the master password) and the two
 * knobs that decide what a browser can do (HTTPS, notifications); and list
 * the browsers that have signed in, with a way to sign any of them out.
 *
 * Module-level snapshot cache, like the other channel panels: Settings.tsx
 * imports this eagerly, so the status is in memory before the tab opens.
 */
type Snapshot = { config: WebUiPublicConfig; status: WebUiStatus }

/**
 * The async clipboard exists only on a secure origin. The Web UI over plain
 * HTTP on a LAN address is not one, and that is exactly where the passphrase
 * gets copied to a phone's password manager — so fall back to the selection
 * route, which every browser still honours from a click handler.
 */
async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      /* permission or insecure context — try the old way */
    }
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const done = document.execCommand('copy')
  area.remove()
  if (!done) throw new Error('could not copy')
}

let cachedSnapshot: Snapshot | null = null
let loadPromise: Promise<Snapshot | null> | null = null

function loadSnapshot(): Promise<Snapshot | null> {
  if (cachedSnapshot) return Promise.resolve(cachedSnapshot)
  const api = window.api?.web
  if (!api) return Promise.resolve(null)
  if (!loadPromise) {
    loadPromise = Promise.all([api.getConfig(), api.status()])
      .then(([config, status]) => {
        cachedSnapshot = { config, status }
        return cachedSnapshot
      })
      .catch(() => null)
      .finally(() => {
        loadPromise = null
      })
  }
  return loadPromise
}

void loadSnapshot()
window.api?.web?.onConfigChange((config) => {
  if (cachedSnapshot) cachedSnapshot = { ...cachedSnapshot, config }
})
window.api?.web?.onStatusChange((status) => {
  if (cachedSnapshot) cachedSnapshot = { ...cachedSnapshot, status }
})

const LEVEL_RANK: Record<PasswordLevel, number> = { weak: 1, fair: 2, good: 3, strong: 4 }
const LEVEL_COLOR: Record<PasswordLevel, string> = {
  weak: 'bg-rose-500',
  fair: 'bg-amber-500',
  good: 'bg-sky-500',
  strong: 'bg-emerald-500'
}
const LEVEL_TEXT: Record<PasswordLevel, string> = {
  weak: 'text-rose-500',
  fair: 'text-amber-500',
  good: 'text-sky-500',
  strong: 'text-emerald-500'
}
const BIND_PRESETS = ['0.0.0.0', '127.0.0.1']

/**
 * The public-address field. Local draft state, remounted (by key) whenever
 * the config changes under it, so a save from another surface is shown
 * without an effect writing state.
 */
function PublicOriginForm({
  initial,
  disabled,
  onSave
}: {
  initial: string
  disabled: boolean
  onSave: (origin: string | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(initial)
  const unchanged = draft.trim() === initial
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(draft.trim() || null)
      }}
    >
      <span className="text-muted text-xs">{t('settings.web.public.origin.label')}</span>
      <div className="flex items-center gap-2 max-sm:flex-col max-sm:items-stretch">
        <div className="min-w-0 flex-1">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('settings.web.public.origin.placeholder')}
            dir="ltr"
          />
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={disabled || unchanged}>
          {t('settings.web.public.origin.save')}
        </Button>
      </div>
      <p className="text-muted text-[11px] leading-relaxed">
        {t('settings.web.public.origin.description')}
      </p>
    </form>
  )
}

export function WebUiPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [config, setConfig] = useState<WebUiPublicConfig | null>(cachedSnapshot?.config ?? null)
  const [status, setStatus] = useState<WebUiStatus | null>(cachedSnapshot?.status ?? null)
  const [sessions, setSessions] = useState<WebSessionView[] | null>(null)
  const [links, setLinks] = useState<WebPublicLinkView[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [configEpoch, setConfigEpoch] = useState(0)
  const loaded = config !== null && status !== null

  useEffect(() => {
    let alive = true
    void loadSnapshot().then((snap) => {
      if (!alive || !snap) return
      setConfig(snap.config)
      setStatus(snap.status)
    })
    void window.api.web.listSessions().then((list) => {
      if (alive) setSessions(list)
    })
    void window.api.web
      .listPublic()
      .then((list) => {
        if (alive) setLinks(list)
      })
      .catch(() => undefined)
    const offPublic = window.api.web.onPublicChange((next) => {
      if (alive) setLinks(next)
    })
    const offConfig = window.api.web.onConfigChange((next) => {
      if (!alive) return
      setConfig(next)
      setConfigEpoch((n) => n + 1)
    })
    const offStatus = window.api.web.onStatusChange((next) => {
      if (!alive) return
      setStatus(next)
      void window.api.web.listSessions().then((list) => {
        if (alive) setSessions(list)
      })
    })
    // Events sent while the socket was down are gone — a config change that
    // rebuilt a listener, say — so a reconnect reads the truth back.
    let offConnection: (() => void) | undefined
    if (isWeb) {
      void import('@lib/web-bridge/boot').then(({ webTransport }) => {
        if (!alive) return
        offConnection = webTransport()?.onConnection((state) => {
          if (state !== 'open') return
          void Promise.all([
            window.api.web.getConfig(),
            window.api.web.status(),
            window.api.web.listSessions()
          ]).then(([nextConfig, nextStatus, list]) => {
            if (!alive) return
            setConfig(nextConfig)
            setStatus(nextStatus)
            setSessions(list)
            setConfigEpoch((n) => n + 1)
          })
        })
      })
    }
    return () => {
      alive = false
      offConfig()
      offPublic()
      offStatus()
      offConnection?.()
    }
  }, [])

  // Turning the Web UI off FROM the Web UI ends the session doing it — the
  // confirm says so, and the socket going away under the call is then the
  // expected outcome rather than an error.
  const [disableOpen, setDisableOpen] = useState(false)

  const apply = useCallback(
    async (key: string, patch: WebUiConfigPatch): Promise<void> => {
      setBusy(key)
      try {
        const result = await window.api.web.setConfig(patch)
        setConfig(result.config)
        setStatus(result.status)
        if (result.status.enabled && !result.status.listening && result.status.error) {
          toast.show({ message: result.status.error, tone: 'error' })
        }
      } catch (err) {
        if (isWeb && patch.enabled === false) return
        toast.show({ message: err instanceof Error ? err.message : String(err), tone: 'error' })
      } finally {
        setBusy(null)
      }
    },
    [toast]
  )

  const copy = (text: string): void => {
    void writeClipboard(text).catch(() => undefined)
    setCopied(text)
    setTimeout(() => setCopied(null), 1500)
  }

  const toggleOptions = useMemo(
    () => [
      { value: false, label: t('settings.web.toggle.off') },
      { value: true, label: t('settings.web.toggle.on') }
    ],
    [t]
  )

  const dot = !status?.enabled
    ? 'bg-border'
    : status.listening
      ? status.clients > 0
        ? 'bg-emerald-500'
        : 'bg-sky-500'
      : 'bg-rose-500'
  const statusKey = !status?.enabled
    ? 'off'
    : status.listening
      ? status.clients > 0
        ? 'connected'
        : 'listening'
      : 'error'

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10 max-sm:px-4 max-sm:py-6">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.web.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">{t('settings.web.subtitle')}</p>
        </header>

        {/* ── Status + switch ─────────────────────────────────────────────── */}
        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn('size-2 shrink-0 rounded-full', dot)} />
              <span className="text-fg truncate text-sm font-medium">
                {t(`settings.web.status.${statusKey}`)}
                {status?.listening &&
                  status.clients > 0 &&
                  ` · ${t('settings.web.clients', { count: status.clients })}`}
              </span>
            </div>
            <ToggleRow
              compact
              label=""
              description=""
              value={config?.enabled === true}
              loaded={loaded}
              disabled={!config?.passwordSet || busy !== null}
              options={toggleOptions}
              onChange={(value) => {
                if (isWeb && !value) setDisableOpen(true)
                else void apply('enabled', { enabled: value })
              }}
            />
          </div>
          <Modal
            open={disableOpen}
            onClose={() => setDisableOpen(false)}
            title={t('settings.web.disable.title')}
            footer={
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => setDisableOpen(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  className="flex-1 border border-transparent bg-red-600 text-white shadow-none hover:bg-red-700"
                  disabled={busy !== null}
                  onClick={() => {
                    setDisableOpen(false)
                    void apply('enabled', { enabled: false })
                  }}
                >
                  {t('settings.web.disable.confirm')}
                </Button>
              </div>
            }
          >
            <p className="text-muted">{t('settings.web.disable.body')}</p>
          </Modal>
          {!config?.passwordSet && loaded && (
            <Notice tone="warning" text={t('settings.web.needsPassword')} />
          )}
          {status?.enabled && !status.listening && status.error && (
            <Notice tone="error" text={t('settings.web.notListening', { error: status.error })} />
          )}
          {status?.listening && (
            <div className="flex flex-col gap-2">
              <span className="text-muted text-xs">{t('settings.web.openAt')}</span>
              <ul className="flex flex-col gap-1.5">
                {status.urls.map((url) => (
                  <li key={url} className="flex items-center gap-2">
                    <code
                      dir="ltr"
                      className="bg-bg border-border text-fg min-w-0 flex-1 truncate rounded-lg border px-2.5 py-1.5 font-mono text-xs"
                    >
                      {url}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(url)}
                      aria-label={t('settings.web.copy')}
                      className="text-muted hover:text-fg flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg"
                    >
                      {copied === url ? (
                        <Tick02Icon size={16} className="text-emerald-500" />
                      ) : (
                        <Copy01Icon size={16} />
                      )}
                    </button>
                    {!isWeb && (
                      <button
                        type="button"
                        onClick={() => void window.api.browser.openExternal(url)}
                        aria-label={t('settings.web.open')}
                        className="text-muted hover:text-fg flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg"
                      >
                        <LinkSquare02Icon size={16} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-muted text-xs leading-relaxed">
                {status.scheme === 'https'
                  ? t('settings.web.httpsHint')
                  : t('settings.web.httpHint')}
              </p>
            </div>
          )}
          {status?.enabled && (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  setBusy('restart')
                  void window.api.web
                    .restart()
                    .then(setStatus)
                    .finally(() => setBusy(null))
                }}
              >
                <RefreshIcon size={14} />
                {t('settings.web.restart')}
              </Button>
            </div>
          )}
        </section>

        {/* ── Master password ────────────────────────────────────────────── */}
        <PasswordCard
          passwordSet={config?.passwordSet === true}
          passwordGenerated={config?.passwordGenerated === true}
          epoch={configEpoch}
          loaded={loaded}
          onSaved={(result) => {
            setConfig(result.config)
            setStatus(result.status)
            setSessions([])
          }}
        />

        {/* ── Network ─────────────────────────────────────────────────────── */}
        <NetworkCard
          config={config}
          loaded={loaded}
          busy={busy}
          onApply={(patch) => apply('network', patch)}
        />

        {/* ── HTTPS ───────────────────────────────────────────────────────── */}
        <WebHttpsCard
          config={config}
          status={status}
          loaded={loaded}
          busy={busy}
          onApply={(patch) => apply('https', patch)}
          onStatus={setStatus}
        />

        {/* ── Notifications + feed ────────────────────────────────────────── */}
        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <ToggleRow
            label={t('settings.web.notifications.label')}
            description={t('settings.web.notifications.description')}
            value={config?.notifications !== false}
            loaded={loaded}
            disabled={busy !== null}
            options={toggleOptions}
            onChange={(value) => void apply('notifications', { notifications: value })}
          />
          <div className="flex items-center justify-between gap-4">
            <p className="text-muted text-xs leading-relaxed">
              {t('settings.web.notifications.subscriptions', { count: status?.subscriptions ?? 0 })}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || !status?.listening}
              onClick={() => {
                setBusy('test')
                void window.api.web
                  .testNotification()
                  .then((r) =>
                    toast.show({
                      message: t('settings.web.notifications.testResult', {
                        inband: r.inband,
                        pushed: r.pushed
                      }),
                      tone: r.inband + r.pushed > 0 ? 'success' : 'warning'
                    })
                  )
                  .catch((err) => toast.show({ message: String(err), tone: 'error' }))
                  .finally(() => setBusy(null))
              }}
            >
              <Notification03Icon size={14} />
              {t('settings.web.notifications.test')}
            </Button>
          </div>
          <div className="border-border/60 border-t" />
          <ToggleRow
            label={t('settings.web.verbose.label')}
            description={t('settings.web.verbose.description')}
            value={config?.verbose === true}
            loaded={loaded}
            disabled={busy !== null}
            options={toggleOptions}
            onChange={(value) => void apply('verbose', { verbose: value })}
          />
        </section>

        {/* ── Signed-in browsers ──────────────────────────────────────────── */}
        <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
          <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-start">
            <div className="flex flex-col gap-1">
              <span className="text-fg text-sm font-medium">
                {t('settings.web.sessions.title')}
              </span>
              <p className="text-muted text-xs leading-relaxed">
                {t('settings.web.sessions.description')}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || !sessions || sessions.length === 0}
              onClick={() => {
                setBusy('revokeAll')
                void window.api.web
                  .revokeAllSessions()
                  .then(() => setSessions([]))
                  .finally(() => setBusy(null))
              }}
            >
              {t('settings.web.sessions.revokeAll')}
            </Button>
          </div>
          {sessions && sessions.length === 0 && (
            <p className="text-muted text-xs">{t('settings.web.sessions.none')}</p>
          )}
          {sessions && sessions.length > 0 && (
            <ul className="flex flex-col gap-2">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="border-border flex items-center justify-between gap-3 rounded-xl border px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-fg truncate text-xs font-medium" title={s.userAgent}>
                      {describeAgent(s.userAgent)}
                    </span>
                    <span className="text-muted truncate text-[11px]">
                      {s.address} ·{' '}
                      {t('settings.web.sessions.lastSeen', {
                        when: new Date(s.lastSeenAt).toLocaleString()
                      })}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      setBusy(`revoke-${s.id}`)
                      void window.api.web
                        .revokeSession(s.id)
                        .then(() =>
                          setSessions((prev) => (prev ?? []).filter((x) => x.id !== s.id))
                        )
                        .finally(() => setBusy(null))
                    }}
                  >
                    {t('settings.web.sessions.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Public links ────────────────────────────────────────────────── */}
        <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
          <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-start">
            <div className="flex flex-col gap-1">
              <span className="text-fg text-sm font-medium">{t('settings.web.public.title')}</span>
              <p className="text-muted text-xs leading-relaxed">
                {t('settings.web.public.description')}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || !links || links.length === 0}
              onClick={() => {
                setBusy('revokeAllPublic')
                void window.api.web
                  .revokeAllPublic()
                  .then(() => setLinks([]))
                  .finally(() => setBusy(null))
              }}
            >
              {t('settings.web.public.revokeAll')}
            </Button>
          </div>
          {links && links.length === 0 && (
            <p className="text-muted text-xs">{t('settings.web.public.none')}</p>
          )}
          {links && links.length > 0 && (
            <ul className="flex flex-col gap-2">
              {links.map((l) => (
                <li
                  key={l.id}
                  className="border-border flex items-center justify-between gap-3 rounded-xl border px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-fg truncate text-xs font-medium" title={l.path ?? ''}>
                      {l.name}{' '}
                      <span className="text-muted font-normal">
                        ·{' '}
                        {l.kind === 'proxy'
                          ? t('settings.web.public.kind.proxy', { port: l.port })
                          : t(`settings.web.public.kind.${l.kind}`)}
                      </span>
                    </span>
                    <span className="text-muted truncate text-[11px]" dir="ltr">
                      {l.url}
                    </span>
                    <span className="text-muted truncate text-[11px]">
                      {t('settings.web.public.opens', { count: l.hits })} ·{' '}
                      {l.expiresAt
                        ? t('settings.web.public.expires', {
                            when: new Date(l.expiresAt).toLocaleString()
                          })
                        : t('settings.web.public.never')}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      className="text-muted hover:text-fg rounded-lg p-1.5 transition-colors"
                      aria-label={t('settings.web.copy')}
                      onClick={() => {
                        void writeClipboard(l.url).then(() => {
                          setCopied(`public-${l.id}`)
                          setTimeout(() => setCopied(null), 1500)
                        })
                      }}
                    >
                      {copied === `public-${l.id}` ? (
                        <Tick02Icon size={16} />
                      ) : (
                        <Copy01Icon size={16} />
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => {
                        setBusy(`unlink-${l.id}`)
                        void window.api.web
                          .revokePublic(l.id)
                          .then(() => setLinks((prev) => (prev ?? []).filter((x) => x.id !== l.id)))
                          .finally(() => setBusy(null))
                      }}
                    >
                      {t('settings.web.public.revoke')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <PublicOriginForm
            key={configEpoch}
            initial={config?.publicOrigin ?? ''}
            disabled={busy !== null}
            onSave={(origin) => void apply('publicOrigin', { publicOrigin: origin })}
          />
        </section>

        {/* ── VPS notes ───────────────────────────────────────────────────── */}
        <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
          <div className="flex items-center gap-2">
            <Globe02Icon size={18} className="text-muted shrink-0" />
            <span className="text-fg text-sm font-medium">{t('settings.web.vps.title')}</span>
          </div>
          <ol className="text-muted flex list-decimal flex-col gap-1.5 ps-5 text-xs leading-relaxed">
            <li>{t('settings.web.vps.step1')}</li>
            <li>{t('settings.web.vps.step2')}</li>
            <li>{t('settings.web.vps.step3')}</li>
            <li>{t('settings.web.vps.step4')}</li>
          </ol>
        </section>
      </div>
    </div>
  )
}

/** "Chrome · Android" from a user agent, as far as it can be told. */
function describeAgent(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser'
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return os ? `${browser} · ${os}` : browser
}

function PasswordCard({
  passwordSet,
  passwordGenerated,
  epoch,
  loaded,
  onSaved
}: {
  passwordSet: boolean
  passwordGenerated: boolean
  /** Bumps on every config change, so a shown passphrase never outlives its password. */
  epoch: number
  loaded: boolean
  onSaved: (result: { config: WebUiPublicConfig; status: WebUiStatus }) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [revealed, setRevealed] = useState<string | null>(null)
  const phraseRef = useRef<HTMLElement>(null)
  // The revealed passphrase stays on one line, whole: its font shrinks until
  // it fits the box. Measured, not computed — the monospace font, and so the
  // width of a character, differs per platform.
  useLayoutEffect(() => {
    const el = phraseRef.current
    const box = el?.parentElement
    if (!el || !box || !revealed) return
    const fit = (): void => {
      el.style.fontSize = ''
      const ratio = el.clientWidth / el.scrollWidth
      if (ratio < 1) {
        const base = parseFloat(getComputedStyle(el).fontSize)
        el.style.fontSize = `${Math.floor(base * ratio * 100) / 100}px`
      }
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    return () => ro.disconnect()
  }, [revealed])
  const [copied, setCopied] = useState(false)
  const [regenOpen, setRegenOpen] = useState(false)
  const [ownOpen, setOwnOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const mismatch = confirm.length > 0 && confirm !== password
  // The same scorer the main process refuses with — the meter can never
  // say "Good" about a password the save would then reject.
  const strength = useMemo(() => scorePassword(password), [password])
  const canSave = loaded && strength.acceptable && confirm === password && !busy

  // The config changed under this card — from the CLI, another window, or
  // this very card — so whatever phrase is on screen belonged to the previous
  // password and comes down. Derived during render, the way React asks for
  // state that follows a prop.
  const [seenEpoch, setSeenEpoch] = useState(epoch)
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch)
    setRevealed(null)
  }

  const failed = (err: unknown): void => {
    toast.show({ message: err instanceof Error ? err.message : String(err), tone: 'error' })
  }

  const fetchPhrase = async (): Promise<string | null> =>
    (await window.api.web.revealPassword()).password

  const toggleReveal = async (): Promise<void> => {
    if (revealed) {
      setRevealed(null)
      return
    }
    try {
      setRevealed(await fetchPhrase())
    } catch (err) {
      failed(err)
    }
  }

  const copyPhrase = async (): Promise<void> => {
    try {
      const phrase = revealed ?? (await fetchPhrase())
      if (!phrase) return
      await writeClipboard(phrase)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      failed(err)
    }
  }

  const regenerate = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.web.regeneratePassword()
      onSaved(result)
      setRevealed(result.password)
      toast.show({ message: t('settings.web.password.regenerated'), tone: 'success' })
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
      setRegenOpen(false)
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.web.setPassword(password)
      onSaved(result)
      setRevealed(null)
      setPassword('')
      setConfirm('')
      setShown(false)
      setOwnOpen(false)
      toast.show({ message: t('settings.web.password.saved'), tone: 'success' })
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
      setConfirmOpen(false)
    }
  }

  return (
    <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
      <div className="flex items-start gap-3">
        <SquareLock01Icon size={18} className="text-muted mt-0.5 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-fg text-sm font-medium">{t('settings.web.password.title')}</span>
            {passwordSet && (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                {passwordGenerated
                  ? t('settings.web.password.generated')
                  : t('settings.web.password.own')}
              </span>
            )}
          </div>
          <p className="text-muted text-xs leading-relaxed">
            {t('settings.web.password.description')}
          </p>
        </div>
      </div>

      {/* The passphrase itself: hidden until asked for, copyable without being shown. */}
      <div className="bg-bg border-border flex flex-col gap-3 rounded-xl border p-4">
        {passwordGenerated ? (
          <code
            ref={phraseRef}
            dir="ltr"
            className={cn(
              'text-fg block font-mono text-sm leading-relaxed whitespace-nowrap select-all',
              !revealed && 'text-muted overflow-hidden'
            )}
          >
            {revealed ?? '•'.repeat(72)}
          </code>
        ) : (
          <p className="text-muted text-xs leading-relaxed">{t('settings.web.password.ownNote')}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {passwordGenerated && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={!loaded || busy}
                aria-pressed={revealed !== null}
                onClick={() => void toggleReveal()}
              >
                {revealed ? <ViewOffIcon size={14} /> : <EyeIcon size={14} />}
                {revealed ? t('settings.web.password.hide') : t('settings.web.password.show')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!loaded || busy}
                onClick={() => void copyPhrase()}
              >
                {copied ? (
                  <Tick02Icon size={14} className="text-emerald-500" />
                ) : (
                  <Copy01Icon size={14} />
                )}
                {copied ? t('settings.web.password.copied') : t('settings.web.password.copy')}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!loaded || busy}
            onClick={() => setRegenOpen(true)}
          >
            <RefreshIcon size={14} />
            {t('settings.web.password.regenerate')}
          </Button>
        </div>
        {passwordGenerated && (
          <p className="text-muted text-xs leading-relaxed">
            {t('settings.web.password.generatedNote')}
          </p>
        )}
      </div>

      {/* A password of the user's own, folded away: the passphrase is the default. */}
      <button
        type="button"
        onClick={() => setOwnOpen((open) => !open)}
        aria-expanded={ownOpen}
        className="text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 self-start text-xs font-medium"
      >
        {ownOpen ? (
          <ArrowDown01Icon size={14} />
        ) : (
          <ArrowRight01Icon size={14} className="rtl:rotate-180" />
        )}
        {t('settings.web.password.useOwn')}
      </button>
      {ownOpen && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!canSave) return
            if (passwordSet) setConfirmOpen(true)
            else void save()
          }}
        >
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <div className="relative">
              <Input
                type={shown ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder={t('settings.web.password.placeholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                dir="ltr"
                className="pe-10"
              />
              <button
                type="button"
                onClick={() => setShown((value) => !value)}
                aria-label={t(shown ? 'settings.web.password.hide' : 'settings.web.password.show')}
                aria-pressed={shown}
                className="text-muted hover:text-fg absolute end-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md"
              >
                {shown ? <ViewOffIcon size={16} /> : <EyeIcon size={16} />}
              </button>
            </div>
            <Input
              type={shown ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder={t('settings.web.password.confirmPlaceholder')}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              dir="ltr"
            />
          </div>
          {/* Strength, live, under the field: four segments filled to the
              level, the level's name, and the one thing that would raise it.
              The button only unlocks at the level the server accepts. */}
          <div className="flex flex-col gap-1.5" aria-live="polite">
            <div
              className="flex w-full gap-1"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={4}
              aria-valuenow={password ? LEVEL_RANK[strength.level] : 0}
              aria-label={t('settings.web.password.strength.label')}
            >
              {[1, 2, 3, 4].map((segment) => (
                <span
                  key={segment}
                  className={cn(
                    'h-1.5 flex-1 rounded-full transition-colors',
                    password && segment <= LEVEL_RANK[strength.level]
                      ? LEVEL_COLOR[strength.level]
                      : 'bg-border/60'
                  )}
                />
              ))}
            </div>
            <div className="flex items-start justify-between gap-3">
              <p className="text-muted text-xs leading-relaxed">
                {password && strength.hints[0]
                  ? t(`settings.web.password.hint.${strength.hints[0]}`, {
                      min: PASSWORD_MIN_LENGTH
                    })
                  : t('settings.web.password.requirements', { min: PASSWORD_MIN_LENGTH })}
              </p>
              {password && (
                <span className={cn('shrink-0 text-xs font-medium', LEVEL_TEXT[strength.level])}>
                  {t(`settings.web.password.strength.${strength.level}`)}
                </span>
              )}
            </div>
          </div>
          {mismatch && (
            <p className="text-xs text-rose-500">{t('settings.web.password.mismatch')}</p>
          )}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!canSave}>
              {passwordSet
                ? t('settings.web.password.change')
                : t('settings.web.password.setAction')}
            </Button>
          </div>
        </form>
      )}
      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t('settings.web.password.confirmTitle')}
        footer={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setConfirmOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button size="sm" className="flex-1" disabled={busy} onClick={() => void save()}>
              {t('settings.web.password.change')}
            </Button>
          </div>
        }
      >
        <p className="text-muted">{t('settings.web.password.confirmBody')}</p>
      </Modal>
      <Modal
        open={regenOpen}
        onClose={() => setRegenOpen(false)}
        title={t('settings.web.password.regenerateTitle')}
        footer={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setRegenOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button size="sm" className="flex-1" disabled={busy} onClick={() => void regenerate()}>
              {t('settings.web.password.regenerate')}
            </Button>
          </div>
        }
      >
        <p className="text-muted">{t('settings.web.password.regenerateBody')}</p>
      </Modal>
    </section>
  )
}

function NetworkCard({
  config,
  loaded,
  busy,
  onApply
}: {
  config: WebUiPublicConfig | null
  loaded: boolean
  busy: string | null
  onApply: (patch: WebUiConfigPatch) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [port, setPort] = useState('')
  const [bind, setBind] = useState('')
  const [base, setBase] = useState<string | null>(null)
  // Drafts follow the applied values; reconciled during render so unrelated
  // status ticks never clobber keystrokes.
  const applied = config ? `${config.port ?? 8787}|${config.bind ?? '0.0.0.0'}` : null
  if (applied !== base) {
    setBase(applied)
    setPort(String(config?.port ?? 8787))
    setBind(config?.bind ?? '0.0.0.0')
  }
  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
  const bindValid = /^[0-9a-fA-F.:[\]]+$/.test(bind.trim())
  const dirty =
    loaded && (String(config?.port ?? 8787) !== port || (config?.bind ?? '0.0.0.0') !== bind)

  return (
    <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
      <div className="flex flex-col gap-1">
        <span className="text-fg text-sm font-medium">{t('settings.web.network.title')}</span>
        <p className="text-muted text-xs leading-relaxed">
          {t('settings.web.network.description')}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">{t('settings.web.network.port')}</span>
          <Input
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            dir="ltr"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">{t('settings.web.network.bind')}</span>
          <Input
            value={bind}
            onChange={(e) => setBind(e.target.value)}
            list="wf-web-bind-presets"
            dir="ltr"
          />
          <datalist id="wf-web-bind-presets">
            {BIND_PRESETS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
      </div>
      <p className="text-muted text-xs leading-relaxed">{t('settings.web.network.bindHint')}</p>
      {portValid && portNumber < 1024 && (
        <Notice tone="info" text={t('settings.web.network.lowPort')} />
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!dirty || !portValid || !bindValid || busy !== null}
          onClick={() => void onApply({ port: portNumber, bind: bind.trim() })}
        >
          {t('settings.web.network.apply')}
        </Button>
      </div>
    </section>
  )
}

function ToggleRow({
  label,
  description,
  value,
  loaded,
  disabled,
  options,
  onChange,
  compact
}: {
  label: string
  description: string
  value: boolean
  loaded: boolean
  disabled?: boolean
  options: Array<{ value: boolean; label: string }>
  onChange: (value: boolean) => void
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-between gap-4', compact && 'justify-end')}>
      {!compact && (
        <div className="flex flex-col gap-1">
          <span className="text-fg text-sm font-medium">{label}</span>
          <p className="text-muted text-xs">{description}</p>
        </div>
      )}
      {!loaded ? (
        <div
          aria-hidden="true"
          className="bg-border/30 h-7 w-19.5 shrink-0 animate-pulse rounded-lg"
        />
      ) : (
        <div
          role="tablist"
          className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
        >
          {options.map((opt) => {
            const active = opt.value === value
            return (
              <button
                key={String(opt.value)}
                role="tab"
                type="button"
                aria-selected={active}
                disabled={disabled}
                onClick={() => {
                  if (opt.value !== value) onChange(opt.value)
                }}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  active
                    ? 'bg-primary text-primary-fg shadow-sm'
                    : 'text-muted hover:text-fg cursor-pointer'
                )}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
