import { Button } from '@components/core/Button'
import { Input } from '@components/core/Input'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { PanelBackChevron } from '@pages/settings/drillNav'
import { getCachedGoogleSnapshot, prefetchGooglePanel } from '@pages/settings/googleSnapshot'
import type {
  GoogleBinaryStatus,
  GoogleConfig,
  GoogleSetupStateEvent,
  GoogleStatus
} from '@preload/index'
import {
  CheckmarkCircle02Icon,
  CloudUploadIcon,
  Copy01Icon,
  Delete02Icon,
  InformationCircleIcon,
  LinkSquare02Icon
} from 'hugeicons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

const GOOGLE_CONSOLE_URL = 'https://console.cloud.google.com/auth/clients'

const STATUS_DOT: Record<GoogleStatus['status'], string> = {
  active: 'bg-emerald-500',
  error: 'bg-rose-500',
  inactive: 'bg-border'
}

type Stage = 'idle' | 'setup' | 'updating' | 'validating' | 'authorizing'

const EMPTY_STATUS: GoogleStatus = {
  status: 'inactive',
  errorKind: null,
  error: null
}

// Main owns the real setup/update progress; this module-level snapshot mirrors
// it so a panel remounted after navigation restores the running install instead
// of resetting. Registered once at import, never torn down — outlives any mount.
// Same pattern as UpdatesPanel for the app updater.
let cachedSetup: GoogleSetupStateEvent = { stage: 'idle', percent: 0 }
window.api.google.onSetupState((s) => {
  cachedSetup = s
})

export function GooglePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()

  // Hydrate from the module-level cache — Settings.tsx kicks off the fetch
  // on its own mount, so by the time the user clicks Google Workspace the
  // snapshot is usually already available and we render in one shot.
  const initial = getCachedGoogleSnapshot()
  // Why the last install/update failed, verbatim from main. A toast alone
  // reduces every failure to "Install failed" and then vanishes, which is
  // exactly the state where the user needs the reason most.
  const [setupError, setSetupError] = useState<string | null>(null)
  const [binary, setBinary] = useState<GoogleBinaryStatus>(
    initial?.binary ?? { gogInstalled: false, gogVersion: null }
  )
  const [config, setConfig] = useState<GoogleConfig | null>(initial?.config ?? null)
  const [status, setStatus] = useState<GoogleStatus>(initial?.status ?? EMPTY_STATUS)
  const [email, setEmail] = useState('')
  // Seed setup/update progress from the module cache so navigating away and back
  // mid-install restores instantly rather than resetting to idle.
  const setupBusy = cachedSetup.stage !== 'idle'
  const [stage, setStage] = useState<Stage>(setupBusy ? cachedSetup.stage : 'idle')
  const [credsDone, setCredsDone] = useState(initial?.config?.credentialsStored ?? false)
  const [progress, setProgress] = useState(
    setupBusy ? cachedSetup.percent : initial?.binary.gogInstalled ? 100 : 0
  )
  const [accounts, setAccounts] = useState<string[]>(initial?.accounts ?? [])
  // Per-account token health (email → false when its refresh token has
  // expired/been revoked). Missing entries mean "healthy or not-yet-checked" —
  // the chip stays green so healthy accounts never flicker.
  const [health, setHealth] = useState<Record<string, boolean>>({})
  // Which account's reconnect is running, so only that row's button spins.
  const [reauthing, setReauthing] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const authCanceledRef = useRef(false)
  // Flipped once a live setup-state event lands, so the async getSetupState seed
  // never clobbers fresher state.
  const liveSeen = useRef(false)

  useEffect(() => {
    let cancelled = false
    void prefetchGooglePanel().then((snap) => {
      if (cancelled) return
      setBinary(snap.binary)
      setConfig(snap.config)
      setStatus(snap.status)
      setAccounts(snap.accounts)
      setCredsDone(snap.config.credentialsStored)
      if (snap.binary.gogInstalled) setProgress(100)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Recover a setup/update that's still running in main after a remount (covers
  // a full renderer reload too), unless a live event already superseded it.
  useEffect(() => {
    let cancelled = false
    liveSeen.current = false
    void window.api.google.getSetupState().then((s) => {
      if (cancelled || liveSeen.current) return
      if (s.stage === 'setup' || s.stage === 'updating') {
        // Never knock a transient OAuth stage (validating/authorizing) into a
        // setup/update view. Today these never overlap, but the guard keeps it
        // correct if that ever changes.
        setStage((prev) => (prev === 'validating' || prev === 'authorizing' ? prev : s.stage))
        setProgress(s.percent)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Live setup/update progress, broadcast from main so it tracks regardless of
  // which surface started the install. An 'idle' event means the install just
  // finished — clear the busy stage and refresh the binary (the local
  // handleSetup/handleUpdate also do this for the initiating panel; both are
  // idempotent, and this covers a panel that remounted mid-install).
  useEffect(() => {
    return window.api.google.onSetupState((s) => {
      liveSeen.current = true
      if (s.stage === 'setup' || s.stage === 'updating') {
        setStage((prev) => (prev === 'validating' || prev === 'authorizing' ? prev : s.stage))
        setProgress(s.percent)
      } else {
        setProgress(s.percent)
        setStage((prev) => (prev === 'setup' || prev === 'updating' ? 'idle' : prev))
        void window.api.google.checkBinary().then((b) => setBinary(b))
      }
    })
  }, [])

  useEffect(() => {
    return window.api.google.onAuthUrl((evt) => setAuthUrl(evt.url))
  }, [])

  // After install/update completes, refresh the auth list — gogcli might
  // be brand new (so the prefetch found nothing) or might have new accounts.
  useEffect(() => {
    if (!binary.gogInstalled) return
    let cancelled = false
    void window.api.google.listAccounts().then((list) => {
      if (!cancelled) setAccounts(list)
    })
    return () => {
      cancelled = true
    }
  }, [binary.gogInstalled])

  // Silently verify each authorized account's refresh token whenever the set of
  // accounts changes. gogcli refresh tokens expire/get revoked over time, and
  // when they do every google_* call for that account fails — this flips its
  // chip to "inactive" (red) so the panel tells the truth. Best-effort and
  // non-blocking: on any failure we leave chips as-is (no toast, no flicker).
  const accountsKey = accounts.join('\n')
  useEffect(() => {
    // Nothing to probe (no binary / no accounts) — leave `health` as-is; the
    // chips only render when there are accounts, and the next successful probe
    // replaces the whole map anyway.
    if (!binary.gogInstalled || accountsKey === '') return
    let cancelled = false
    void window.api.google.checkAccounts().then(
      (map) => {
        if (!cancelled) setHealth(map)
      },
      () => {
        /* best-effort — leave existing chips untouched on failure */
      }
    )
    return () => {
      cancelled = true
    }
  }, [accountsKey, binary.gogInstalled])

  const handleSetup = useCallback(async () => {
    setStage('setup')
    setProgress(0)
    try {
      const result = await window.api.google.setup()
      if (result.ok) {
        setSetupError(null)
        setBinary(result.binary)
        setProgress(100)
        toast.show({
          message: t('settings.services.google.toasts.installed', {
            version: result.binary.gogVersion ?? ''
          }),
          tone: 'success'
        })
      } else {
        setSetupError(result.message?.trim() || null)
        toast.show({
          message: t(`settings.services.google.errors.${result.kind}`, {
            defaultValue: t('settings.services.google.toasts.installFailed')
          }),
          tone: 'error'
        })
        const fresh = await window.api.google.checkBinary()
        setBinary(fresh)
        setProgress(fresh.gogInstalled ? 100 : 0)
      }
    } catch (err) {
      // A rejected IPC call (stale handler, main-process throw) would
      // otherwise resolve nothing and leave the card sitting at 0% with no
      // toast and no reason — the update path already guards this.
      setSetupError((err as Error)?.message?.trim() || null)
      toast.show({
        message: t('settings.services.google.toasts.installFailed'),
        tone: 'error'
      })
      const fresh = await window.api.google.checkBinary().catch(() => null)
      if (fresh) {
        setBinary(fresh)
        setProgress(fresh.gogInstalled ? 100 : 0)
      } else {
        setProgress(0)
      }
    } finally {
      setStage('idle')
    }
  }, [t, toast])

  const processCredentialsFile = useCallback(
    async (file: File) => {
      setStage('validating')
      try {
        const text = await file.text()
        const result = await window.api.google.uploadCredentials(text)
        if (result.ok) {
          setCredsDone(true)
          setConfig((prev) =>
            prev
              ? {
                  ...prev,
                  clientId: result.clientId,
                  projectId: result.projectId,
                  credentialsStored: true
                }
              : prev
          )
          toast.show({
            message: t('settings.services.google.toasts.credentialsStored'),
            tone: 'success'
          })
        } else {
          toast.show({
            message: t('settings.services.google.toasts.credentialsRejected'),
            tone: 'error'
          })
        }
      } finally {
        setStage('idle')
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    },
    [t, toast]
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) void processCredentialsFile(file)
    },
    [processCredentialsFile]
  )

  const handleDeleteCredentials = useCallback(async () => {
    const result = await window.api.google.deleteCredentials()
    if (!result.ok) {
      toast.show({
        message: t('settings.services.google.toasts.credentialsDeleteFailed'),
        tone: 'error'
      })
      return
    }
    setCredsDone(false)
    setAccounts([])
    setConfig((prev) =>
      prev ? { ...prev, clientId: '', projectId: '', credentialsStored: false } : prev
    )
    setStatus({ status: 'inactive', errorKind: null, error: null })
    toast.show({
      message: t('settings.services.google.toasts.credentialsDeleted'),
      tone: 'success'
    })
  }, [t, toast])

  const handleUpdate = useCallback(async () => {
    setStage('updating')
    setProgress(0)
    try {
      const result = await window.api.google.update()
      if (result?.ok) {
        setSetupError(null)
        if (result.updated) {
          setBinary({ gogInstalled: true, gogVersion: result.version })
          setProgress(100)
          toast.show({
            message: t('settings.services.google.toasts.updated', {
              version: result.version ?? ''
            }),
            tone: 'success'
          })
        } else {
          // Already on latest — keep the bar full and let the user know.
          setProgress(100)
          toast.show({
            message: t('settings.services.google.toasts.latest'),
            tone: 'success'
          })
        }
      } else {
        setSetupError(result?.message?.trim() || null)
        toast.show({
          message: t('settings.services.google.toasts.updateFailed'),
          tone: 'error'
        })
        const fresh = await window.api.google.checkBinary()
        setBinary(fresh)
        setProgress(fresh.gogInstalled ? 100 : 0)
      }
    } catch (err) {
      // Anything that throws (stale IPC handler, network reject, etc.)
      // would otherwise leave the bar at 0 with no feedback. Surface it.
      setSetupError((err as Error)?.message?.trim() || null)
      toast.show({
        message: t('settings.services.google.toasts.updateFailed'),
        tone: 'error'
      })
      const fresh = await window.api.google.checkBinary().catch(() => null)
      if (fresh) {
        setBinary(fresh)
        setProgress(fresh.gogInstalled ? 100 : 0)
      } else {
        setProgress(0)
      }
    } finally {
      setStage('idle')
    }
  }, [t, toast])

  const handleRemove = useCallback(
    async (accountEmail: string) => {
      const result = await window.api.google.removeAccount(accountEmail)
      if (!result.ok) {
        toast.show({
          message: t('settings.services.google.toasts.removeFailed'),
          tone: 'error'
        })
        return
      }
      setAccounts(result.accounts)
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              status: result.accounts.length > 0 ? 'active' : 'inactive'
            }
          : prev
      )
      const live = await window.api.google.status()
      setStatus(live)
      toast.show({
        message: t('settings.services.google.toasts.removed'),
        tone: 'success'
      })
    },
    [t, toast]
  )

  // The single OAuth path: "Add account" and an inactive account's reconnect
  // button both land here, so re-connecting behaves exactly like a fresh add —
  // same authorizing stage, same link fallback, same Cancel button. `reauth`
  // only tells gogcli to force Google's consent screen for an account it
  // already knows, which is what makes the new refresh token actually arrive.
  const runAuth = useCallback(
    async (target: string, opts?: { reauth?: boolean }) => {
      const trimmed = target.trim()
      if (!trimmed) return
      authCanceledRef.current = false
      setStage('authorizing')
      setAuthUrl(null)
      try {
        const result = await window.api.google.authAdd(trimmed, opts)
        if (result.ok) {
          setConfig((prev) => (prev ? { ...prev, status: 'active' } : prev))
          setStatus({ status: 'active', errorKind: null, error: null })
          // Only the typed-in field gets cleared; a reconnect never touches it.
          if (!opts?.reauth) setEmail('')
          const refreshed = await window.api.google.listAccounts()
          setAccounts(refreshed)
          // A reconnect leaves the account set unchanged, so the health effect
          // (keyed on that set) won't re-fire and the chip would stay red.
          // Flip it here for the account gogcli actually stored, then re-probe
          // to replace the guess with the truth.
          setHealth((prev) => ({ ...prev, [result.account]: true }))
          void window.api.google.checkAccounts().then(
            (map) => setHealth(map),
            () => {
              /* best-effort — the optimistic chip stands until the next probe */
            }
          )
          toast.show({
            message: t('settings.services.google.toasts.authorized'),
            tone: 'success'
          })
        } else if (!authCanceledRef.current) {
          // User-canceled auths are silent — they pressed Cancel deliberately.
          toast.show({
            message: t('settings.services.google.toasts.authFailed'),
            tone: 'error'
          })
          const live = await window.api.google.status()
          setStatus(live)
        }
      } finally {
        setStage('idle')
        setAuthUrl(null)
        authCanceledRef.current = false
      }
    },
    [t, toast]
  )

  const handleAuth = useCallback(() => runAuth(email), [email, runAuth])

  const handleReauth = useCallback(
    async (accountEmail: string) => {
      setReauthing(accountEmail)
      try {
        await runAuth(accountEmail, { reauth: true })
      } finally {
        setReauthing(null)
      }
    },
    [runAuth]
  )

  const handleCancelAuth = useCallback(async () => {
    authCanceledRef.current = true
    await window.api.google.cancelAuth()
  }, [])

  const ready = binary.gogInstalled

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <PanelBackChevron />
              <h1 className="text-fg text-2xl font-semibold tracking-tight">
                {t('settings.services.google.title')}
              </h1>
            </div>
            <a
              href={GOOGLE_CONSOLE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'text-muted hover:text-fg flex items-center gap-1.5 text-xs',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-md px-1.5 py-1'
              )}
            >
              <span>{t('settings.services.google.platform')}</span>
              <LinkSquare02Icon size={13} className="shrink-0" />
            </a>
          </div>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.google.subtitle')}
          </p>
        </header>

        <SetupSection
          binary={binary}
          stage={stage}
          progress={progress}
          error={setupError}
          onSetup={() => void handleSetup()}
          onUpdate={() => void handleUpdate()}
        />

        <CredentialsSection
          enabled={ready}
          credsDone={credsDone}
          stage={stage}
          config={config}
          fileInputRef={fileInputRef}
          onFile={handleFileChange}
          onUpload={(file) => void processCredentialsFile(file)}
          onDelete={() => void handleDeleteCredentials()}
        />

        <AuthSection
          enabled={ready && credsDone}
          stage={stage}
          email={email}
          accounts={accounts}
          health={health}
          reauthing={reauthing}
          authUrl={authUrl}
          onEmailChange={setEmail}
          onAuthorize={() => void handleAuth()}
          onCancel={() => void handleCancelAuth()}
          onRemove={(acc) => void handleRemove(acc)}
          onReauth={(acc) => void handleReauth(acc)}
        />

        {!credsDone && <OAuthGuide />}

        <StatusSection status={status} config={config} accounts={accounts} />
      </div>
    </div>
  )
}

function SetupSection({
  binary,
  stage,
  progress,
  error,
  onSetup,
  onUpdate
}: {
  binary: GoogleBinaryStatus
  stage: Stage
  progress: number
  error: string | null
  onSetup: () => void
  onUpdate: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const installing = stage === 'setup'
  const updating = stage === 'updating'
  const busy = installing || updating
  const ready = binary.gogInstalled

  return (
    <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-fg text-sm font-medium">
            {t('settings.services.google.setup.label')}
          </span>
          <span className="text-muted text-xs">
            {ready ? (
              <Trans
                i18nKey="settings.services.google.setup.ready"
                values={{ version: binary.gogVersion ?? '' }}
                components={{
                  code: (
                    <code className="bg-bg/60 border-border rounded border px-1.5 py-0.5 font-mono text-[11px]" />
                  )
                }}
              />
            ) : (
              <Trans
                i18nKey="settings.services.google.setup.needsInstall"
                components={{
                  code: (
                    <code className="bg-bg/60 border-border rounded border px-1.5 py-0.5 font-mono text-[11px]" />
                  )
                }}
              />
            )}
          </span>
        </div>
        {ready ? (
          <Button type="button" variant="outline" onClick={onUpdate} disabled={busy}>
            {t('settings.services.google.setup.update')}
          </Button>
        ) : (
          <Button type="button" onClick={onSetup} disabled={busy}>
            {t('settings.services.google.setup.install')}
          </Button>
        )}
      </div>
      <div className="bg-border/30 h-1 overflow-hidden rounded-full">
        <div
          className="h-full bg-emerald-500 transition-[width] duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
      {error && !busy && (
        <p className="text-xs leading-relaxed wrap-break-word text-amber-500">{error}</p>
      )}
    </section>
  )
}

function CredentialsSection({
  enabled,
  credsDone,
  stage,
  config,
  fileInputRef,
  onFile,
  onUpload,
  onDelete
}: {
  enabled: boolean
  credsDone: boolean
  stage: Stage
  config: GoogleConfig | null
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void
  onUpload: (file: File) => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const validating = stage === 'validating'
  const [dragActive, setDragActive] = useState(false)
  const dropDisabled = validating || !enabled

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (dropDisabled) return
      // Only react to actual file drags, not text selections.
      if (!Array.from(e.dataTransfer.types).includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setDragActive(true)
    },
    [dropDisabled]
  )

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLElement>) => {
    const related = e.relatedTarget as Node | null
    if (related && (e.currentTarget as Node).contains(related)) return
    setDragActive(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault()
      e.stopPropagation()
      setDragActive(false)
      if (dropDisabled) return
      const file = e.dataTransfer.files?.[0]
      if (file) onUpload(file)
    },
    [dropDisabled, onUpload]
  )

  return (
    <section
      className={cn(
        'bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6',
        !enabled && 'pointer-events-none opacity-40'
      )}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-muted text-xs font-medium uppercase tracking-wider">
          {t('settings.services.google.credentials.label')}
        </span>
        <p className="text-muted text-xs">{t('settings.services.google.credentials.hint')}</p>
      </div>

      {credsDone ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CheckmarkCircle02Icon size={16} className="text-emerald-500 shrink-0" />
              <span className="text-fg text-sm">
                {t('settings.services.google.credentials.stored')}
              </span>
            </div>
            <button
              type="button"
              onClick={onDelete}
              title={t('settings.services.google.credentials.delete')}
              aria-label={t('settings.services.google.credentials.delete')}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-md cursor-pointer',
                'text-muted hover:bg-rose-500/10 hover:text-rose-500',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
              )}
            >
              <Delete02Icon size={16} />
            </button>
          </div>
          <dl className="bg-bg/40 border-border grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs">
            {config?.projectId && (
              <>
                <dt className="text-muted">{t('settings.services.google.credentials.project')}</dt>
                <dd className="text-fg truncate font-mono">{config.projectId}</dd>
              </>
            )}
            {config?.clientId && (
              <>
                <dt className="text-muted">{t('settings.services.google.credentials.client')}</dt>
                <dd className="text-fg truncate font-mono" title={config.clientId}>
                  {truncateClientId(config.clientId)}
                </dd>
              </>
            )}
          </dl>
          <label
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cn(
              'flex items-center gap-2 rounded-md border border-dashed px-3 py-2',
              validating
                ? 'border-border pointer-events-none cursor-default'
                : dragActive
                  ? 'border-primary bg-primary/5 cursor-copy'
                  : 'border-border hover:border-muted cursor-pointer'
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={onFile}
              className="hidden"
              disabled={validating}
            />
            <CloudUploadIcon
              size={14}
              className={cn('shrink-0', dragActive ? 'text-primary' : 'text-muted')}
            />
            <span className={cn('text-xs', dragActive ? 'text-primary' : 'text-muted')}>
              {dragActive
                ? t('settings.services.google.credentials.dropzoneActive')
                : t('settings.services.google.credentials.rotate')}
            </span>
          </label>
        </div>
      ) : (
        <label
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8',
            dropDisabled
              ? 'border-border pointer-events-none opacity-60'
              : dragActive
                ? 'border-primary bg-primary/5 cursor-copy'
                : 'border-border hover:border-muted'
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={onFile}
            className="hidden"
          />
          <CloudUploadIcon size={24} className={dragActive ? 'text-primary' : 'text-muted'} />
          <span className={cn('text-sm', dragActive ? 'text-primary' : 'text-muted')}>
            {validating
              ? t('settings.services.google.credentials.validating')
              : dragActive
                ? t('settings.services.google.credentials.dropzoneActive')
                : t('settings.services.google.credentials.dropzone')}
          </span>
        </label>
      )}
    </section>
  )
}

function AuthSection({
  enabled,
  stage,
  email,
  accounts,
  health,
  reauthing,
  authUrl,
  onEmailChange,
  onAuthorize,
  onCancel,
  onRemove,
  onReauth
}: {
  enabled: boolean
  stage: Stage
  email: string
  accounts: string[]
  health: Record<string, boolean>
  reauthing: string | null
  authUrl: string | null
  onEmailChange: (v: string) => void
  onAuthorize: () => void
  onCancel: () => void
  onRemove: (account: string) => void
  onReauth: (account: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const authorizing = stage === 'authorizing'

  return (
    <section
      className={cn(
        'bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6',
        !enabled && 'pointer-events-none opacity-40'
      )}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-muted text-xs font-medium uppercase tracking-wider">
          {t('settings.services.google.auth.label')}
        </span>
        <p className="text-muted text-xs">{t('settings.services.google.auth.hint')}</p>
      </div>

      {accounts.length > 0 && (
        <div className="flex flex-col gap-2">
          {accounts.map((acc) => {
            // Only an explicit `false` (refresh token positively failed) flips
            // the chip to inactive; unknown/not-yet-checked accounts stay green.
            const expired = health[acc] === false
            return (
              <div key={acc} className="flex items-center gap-2">
                <div
                  className={cn(
                    'flex h-9 flex-1 items-center gap-2 rounded-md border px-3',
                    'border-border bg-bg/30'
                  )}
                  aria-label={t('settings.services.google.auth.accountLabel', { account: acc })}
                >
                  <span className="text-fg flex-1 truncate font-mono text-sm select-text">
                    {acc}
                  </span>
                  {expired && (
                    <button
                      type="button"
                      onClick={() => onReauth(acc)}
                      disabled={authorizing}
                      aria-label={t('settings.services.google.auth.reconnectLabel', {
                        account: acc
                      })}
                      className={cn(
                        'shrink-0 rounded text-[11px] font-medium',
                        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                        // One text color per branch — cn doesn't merge conflicting
                        // utilities. Dim while another account is authorizing;
                        // the row actually reconnecting says so in words.
                        reauthing === acc
                          ? 'text-muted animate-pulse cursor-default'
                          : authorizing
                            ? 'text-muted/50 cursor-default'
                            : 'text-accent cursor-pointer hover:underline'
                      )}
                    >
                      {t(
                        reauthing === acc
                          ? 'settings.services.google.auth.reconnecting'
                          : 'settings.services.google.auth.reconnect'
                      )}
                    </button>
                  )}
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                      expired
                        ? 'bg-rose-500/10 text-rose-500'
                        : 'bg-emerald-500/10 text-emerald-500'
                    )}
                    aria-label={t(
                      expired
                        ? 'settings.services.google.auth.inactive'
                        : 'settings.services.google.auth.active'
                    )}
                  >
                    {t(
                      expired
                        ? 'settings.services.google.auth.inactive'
                        : 'settings.services.google.auth.active'
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(acc)}
                  title={t('settings.services.google.auth.remove')}
                  aria-label={t('settings.services.google.auth.remove')}
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-md cursor-pointer',
                    'text-muted hover:bg-rose-500/10 hover:text-rose-500',
                    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                  )}
                >
                  <Delete02Icon size={16} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Input
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && email.trim() && !authorizing) {
                e.preventDefault()
                onAuthorize()
              }
            }}
            placeholder={t('settings.services.google.auth.placeholder')}
            autoComplete="email"
            disabled={authorizing}
          />
        </div>
        {authorizing ? (
          <Button type="button" onClick={onCancel}>
            {t('settings.services.google.auth.cancel')}
          </Button>
        ) : (
          <Button type="button" onClick={onAuthorize} disabled={!email.trim()}>
            {t(
              accounts.length > 0
                ? 'settings.services.google.auth.addMore'
                : 'settings.services.google.auth.authorize'
            )}
          </Button>
        )}
      </div>

      {authUrl && (
        <div className="flex items-center gap-2 text-xs">
          <p className="text-muted truncate flex-1">
            {t('settings.services.google.auth.linkNote')}{' '}
            <a
              href={authUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault()
                window.open(authUrl, '_blank', 'noopener,noreferrer')
              }}
              className="text-accent hover:underline"
            >
              {t('settings.services.google.auth.linkOpen')}
            </a>
          </p>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(authUrl).then(
                () =>
                  toast.show({
                    message: t('settings.services.google.toasts.linkCopied'),
                    tone: 'success'
                  }),
                () =>
                  toast.show({
                    message: t('settings.services.google.toasts.linkCopyFailed'),
                    tone: 'error'
                  })
              )
            }}
            title={t('settings.services.google.auth.copyLink')}
            aria-label={t('settings.services.google.auth.copyLink')}
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md cursor-pointer',
              'text-muted hover:bg-border/40 hover:text-fg',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
            )}
          >
            <Copy01Icon size={14} />
          </button>
        </div>
      )}
    </section>
  )
}

const GUIDE_STEPS = [1, 2, 3, 4, 5, 6] as const

function OAuthGuide(): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const creds = 'settings.services.google.credentials'

  return (
    <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 cursor-pointer"
      >
        <h2 className="text-fg text-sm font-semibold">{t(`${creds}.guideTitle`)}</h2>
        <span
          className={cn(
            'text-muted text-xs transition-transform',
            expanded ? 'rotate-90' : 'rotate-0'
          )}
        >
          ›
        </span>
      </button>

      {expanded && (
        <>
          <p className="text-muted text-xs">{t(`${creds}.guidePrereq`)}</p>

          <ol className="flex flex-col gap-3">
            {GUIDE_STEPS.map((step) => (
              <li key={step} className="flex items-start gap-3">
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                    'bg-primary/15 text-primary'
                  )}
                >
                  {step}
                </span>
                <div className="flex flex-col gap-1">
                  <span className="text-muted text-sm leading-relaxed">
                    {step === 1 ? (
                      <>
                        {t(`${creds}.step1`)}
                        <a
                          href="https://console.cloud.google.com/projectcreate"
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => {
                            e.preventDefault()
                            window.open(
                              'https://console.cloud.google.com/projectcreate',
                              '_blank',
                              'noopener,noreferrer'
                            )
                          }}
                          className="text-primary hover:text-primary/80 underline"
                        >
                          {t(`${creds}.step1Link`)}
                        </a>
                        {t(`${creds}.step1Rest`)}
                      </>
                    ) : (
                      t(`${creds}.step${step}`)
                    )}
                  </span>
                  {step === 2 && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {(
                        t(`${creds}.step2Apis`, {
                          returnObjects: true,
                          defaultValue: []
                        }) as string[]
                      ).map((api) => (
                        <span
                          key={api}
                          className="bg-bg/60 border-border text-muted rounded border px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          {api}
                        </span>
                      ))}
                    </div>
                  )}
                  <span className="text-muted/60 text-xs flex items-start gap-1.5">
                    <CheckmarkCircle02Icon size={12} className="shrink-0 mt-0.5" />
                    {t(`${creds}.step${step}Confirm`)}
                  </span>
                </div>
              </li>
            ))}
          </ol>

          <div className="bg-bg/40 border-border flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
            <div className="flex items-start gap-2 text-xs">
              <InformationCircleIcon size={13} className="text-muted shrink-0 mt-0.5" />
              <span className="text-muted">{t(`${creds}.guideTip1`)}</span>
            </div>
            <div className="flex items-start gap-2 text-xs">
              <InformationCircleIcon size={13} className="text-muted shrink-0 mt-0.5" />
              <span className="text-muted">{t(`${creds}.guideTip2`)}</span>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function StatusSection({
  status,
  config,
  accounts
}: {
  status: GoogleStatus
  config: GoogleConfig | null
  accounts: string[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const services: string[] = t('settings.services.google.capabilities.list', {
    returnObjects: true,
    defaultValue: []
  }) as unknown as string[]

  return (
    <section
      className={cn(
        'bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6',
        status.status === 'inactive' && 'pointer-events-none opacity-40'
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted text-xs font-medium uppercase tracking-wider">
          {t('settings.services.google.status.label')}
        </span>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn('h-2 w-2 rounded-full', STATUS_DOT[status.status])}
          />
          <span className="text-fg text-sm">
            {t(`settings.services.google.status.${status.status}`)}
          </span>
        </div>
      </div>

      {accounts.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="text-muted text-xs">
            {t('settings.services.google.status.accounts')}
          </span>
          <span className="text-fg text-sm font-mono wrap-break-word">{accounts.join(', ')}</span>
        </div>
      )}

      {config?.projectId && (
        <div className="flex flex-col gap-0.5">
          <span className="text-muted text-xs">{t('settings.services.google.status.project')}</span>
          <span className="text-fg text-sm font-mono">{config.projectId}</span>
        </div>
      )}

      {status.error && (
        <pre
          className={cn(
            'bg-bg/40 border-border rounded-md border px-3 py-2',
            'text-xs whitespace-pre-wrap wrap-break-word font-mono text-rose-500'
          )}
        >
          {status.error}
        </pre>
      )}

      <div className="border-border/60 border-t" />

      <div className="flex flex-col gap-1.5">
        <span className="text-muted text-xs font-medium">
          {t('settings.services.google.capabilities.title')}
        </span>
        <ul className="text-muted flex flex-col gap-1 text-xs leading-relaxed">
          {services.map((line, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function truncateClientId(id: string): string {
  if (id.length <= 32) return id
  // 1234567890-abcdef…apps.googleusercontent.com
  const head = id.slice(0, 12)
  const tail = id.slice(-26)
  return `${head}…${tail}`
}
