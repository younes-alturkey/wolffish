import { Button } from '@components/core/Button'
import { useToast } from '@components/core/toast/useToast'
import { Modal } from '@components/core/Modal'
import { cn } from '@lib/utils/cn'
import { requestSettingsTab } from '@pages/settings/settingsNav'
import type { AutostartInfo, AutostartMechanisms, CliConfig, CliPathStatus } from '@preload/index'
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  File01Icon,
  CommandLineIcon,
  ServerStack01Icon,
  ShieldKeyIcon,
  Settings02Icon,
  ComputerTerminal01Icon,
  Tick02Icon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Module-level snapshot of everything this panel renders, warmed once at app
 * start — Settings.tsx imports this file eagerly, so the load below runs
 * during startup. By the time anyone opens the tab the data is in memory and
 * paints on the first frame: no probe round-trip, no skeleton→content reflow.
 * Mirrors TelegramPanel / GitHubPanel / GooglePanel.
 *
 * It matters more here than on those panels, because three of these four
 * values come from shelling out (`command -v wolffish`, `systemctl`,
 * `launchctl`). Those are tens of milliseconds each — long enough that a
 * fetch-on-mount panel visibly assembles itself.
 *
 * `null` means "not loaded yet".
 */
type CliSnapshot = {
  config: CliConfig
  path: CliPathStatus
  service: AutostartInfo
  mechanisms: AutostartMechanisms
}

let cachedSnapshot: CliSnapshot | null = null
let loadPromise: Promise<CliSnapshot | null> | null = null

function loadCliSnapshot(): Promise<CliSnapshot | null> {
  if (cachedSnapshot) return Promise.resolve(cachedSnapshot)
  const api = window.api?.cli
  if (!api) return Promise.resolve(null) // preload not ready yet; the mount effect retries
  if (!loadPromise) {
    loadPromise = Promise.all([
      api.getConfig(),
      api.pathStatus(),
      api.serviceStatus(),
      api.serviceMechanism()
    ])
      .then(([config, path, service, mechanisms]) => {
        cachedSnapshot = { config, path, service, mechanisms }
        return cachedSnapshot
      })
      .catch(() => null) // leave the cache cold so the mount effect can retry
      .finally(() => {
        loadPromise = null
      })
  }
  return loadPromise
}

// Prefill at app start.
void loadCliSnapshot()

// Keep the cache current while the panel is closed, so reopening paints the
// real state rather than a stale one. Never torn down, like Telegram's status
// mirror: the app writes the shim on every launch, and "Launch at startup" can
// be flipped from the Wolffish tab at any time.
window.api?.cli?.onPathChange((path) => {
  if (cachedSnapshot) cachedSnapshot = { ...cachedSnapshot, path }
})
// The verbose toggle is editable from the paired phone too, and a phone-side
// write lands as this push (main broadcasts it from applyMobileSettings, the
// same way cli:setConfig does). Kept warm so reopening the tab paints what the
// workspace actually holds rather than the value this window last wrote.
window.api?.cli?.onConfigChange((config) => {
  if (cachedSnapshot) cachedSnapshot = { ...cachedSnapshot, config }
})
window.api?.runtime?.onPreferencesChanged(() => {
  void window.api?.cli?.serviceStatus().then((service) => {
    if (cachedSnapshot) cachedSnapshot = { ...cachedSnapshot, service }
  })
})

/**
 * Settings → Channels → CLI.
 *
 * Two things this screen exists to do, in this order. First, tell the truth
 * about whether the `wolffish` command actually works — that failure is
 * invisible from inside the app and shows up in a terminal as nothing but
 * "command not found", so it gets the top card and a real error state rather
 * than a hint buried in prose. Second, explain the handful of ways the CLI
 * genuinely differs from the window, and list the commands so nobody has to
 * find `--help` first.
 */
export function CliPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()

  // Seeded from the warm cache, so the common path renders final content on
  // the first frame and never transitions at all.
  const [config, setConfig] = useState<CliConfig | null>(cachedSnapshot?.config ?? null)
  const [pathState, setPathState] = useState<CliPathStatus | null>(cachedSnapshot?.path ?? null)
  const [service, setService] = useState<AutostartInfo | null>(cachedSnapshot?.service ?? null)
  const [mechanisms, setMechanisms] = useState<AutostartMechanisms | null>(
    cachedSnapshot?.mechanisms ?? null
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [confirmMode, setConfirmMode] = useState(false)

  // Whether the first render was already seeded — if so there is nothing for
  // the mount effect to fill in. Captured once.
  const seededRef = useRef(cachedSnapshot !== null)

  useEffect(() => {
    let cancelled = false
    if (!seededRef.current) {
      void (async () => {
        const snap = await loadCliSnapshot()
        if (cancelled || !snap) return
        setConfig(snap.config)
        setPathState(snap.path)
        setService(snap.service)
        setMechanisms(snap.mechanisms)
      })()
    }
    // "Launch at startup" is the same registration, edited from the Wolffish
    // tab. Follow its broadcast so this card never shows a stale state after
    // the user flips it there.
    const offPrefs = window.api.runtime.onPreferencesChanged(() => {
      void window.api.cli.serviceStatus().then((next) => {
        if (!cancelled) setService(next)
      })
    })
    // The shim is (re)written on every app launch, so a status change can
    // originate outside this panel — follow the push rather than snapshotting.
    const off = window.api.cli.onPathChange((next) => {
      if (!cancelled) setPathState(next)
    })
    // Verbose is editable from the phone's Channels → CLI card as well, and
    // that write is announced on this channel. Following it is what makes the
    // two screens one control instead of two copies that drift apart the
    // moment either is touched.
    const offConfig = window.api.cli.onConfigChange((next) => {
      if (!cancelled) setConfig(next)
    })
    return () => {
      cancelled = true
      off()
      offPrefs()
      offConfig()
    }
  }, [])

  const setVerbose = useCallback(async (value: boolean) => {
    setConfig((prev) => ({ ...(prev ?? {}), verbose: value }))
    await window.api.cli.setConfig({ verbose: value })
  }, [])

  /**
   * Install (or re-point) the shim, then say what actually happened in one
   * line. Four outcomes, not two: writing the file is not the same as the
   * shell being able to find it, and the two half-successes are the ones a
   * silent green tick would hide — a shim in a directory that isn't on PATH,
   * or one that is shadowed by another binary of the same name. The card
   * below carries the detail and the fix; the toast is only the verdict.
   */
  const installPath = useCallback(async () => {
    setBusy('path')
    try {
      const next = await window.api.cli.installPath()
      setPathState(next)
      if (next.error) {
        toast.show({ message: t('settings.channels.cli.path.toast.failed'), tone: 'error' })
      } else if (next.needsPathEntry && next.profileHasEntry) {
        toast.show({ message: t('settings.channels.cli.path.toast.openTerminal'), tone: 'success' })
      } else if (next.needsPathEntry) {
        toast.show({ message: t('settings.channels.cli.path.toast.needsPath'), tone: 'warning' })
      } else if (next.shadowedBy) {
        toast.show({ message: t('settings.channels.cli.path.toast.shadowed'), tone: 'warning' })
      } else {
        toast.show({ message: t('settings.channels.cli.path.toast.installed'), tone: 'success' })
      }
    } catch {
      toast.show({ message: t('settings.channels.cli.path.toast.failed'), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }, [t, toast])

  /**
   * Take the shim back off the PATH.
   *
   * Worth a button of its own rather than leaving the terminal as the only way
   * out: the card that installs a thing is where someone looks to uninstall
   * it, and a screen that can only add is a screen you have to leave to undo.
   * No confirmation — the shim is one click to put back, and the state after
   * is rendered from what main answers, not assumed.
   */
  const removePath = useCallback(async () => {
    setBusy('path')
    try {
      const next = await window.api.cli.uninstallPath()
      setPathState(next)
      toast.show({
        message: next.error
          ? t('settings.channels.cli.path.toast.removeFailed')
          : t('settings.channels.cli.path.toast.removed'),
        tone: next.error ? 'error' : 'success'
      })
    } catch {
      toast.show({ message: t('settings.channels.cli.path.toast.removeFailed'), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }, [t, toast])

  /**
   * Turn autostart on or off. Lands on the same main-process dispatcher the
   * Wolffish tab's toggle calls, which writes the stored intent and the OS
   * registration together — so the two screens move as one. The answer is
   * rendered rather than the optimistic value: the OS can refuse, and a
   * refusal has to show as "not registered", not as success.
   */
  const toggleService = useCallback(async (value: boolean) => {
    setBusy('service')
    try {
      setService(
        value ? await window.api.cli.serviceInstall() : await window.api.cli.serviceUninstall()
      )
    } finally {
      setBusy(null)
    }
  }, [])

  /**
   * Switch the mechanism, keeping the on/off as it was. The main process tears
   * the old registration down before writing the new one, and answers with the
   * state that actually holds — rendered, never the optimistic guess, because
   * a registration can fail.
   */
  const setMode = useCallback(async (mode: 'gui' | 'headless') => {
    setBusy('service')
    try {
      setService(await window.api.cli.serviceSetMode(mode))
    } finally {
      setBusy(null)
    }
  }, [])

  const copy = useCallback(async (text: string, key: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied((current) => (current === key ? null : current)), 1600)
  }, [])

  const pathHealthy = pathState?.installed === true
  const pathBroken = pathState !== null && !pathState.installed

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ComputerTerminal01Icon size={22} className="text-muted" />
            {t('settings.channels.cli.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.channels.cli.subtitle')}
          </p>
        </header>

        {/* The command's own health. First card by design: everything else on
            this screen is unreachable if the shell cannot resolve the name.
            It keeps the normal card surface in both states and signals the
            problem with the border alone — swapping bg-surface out for a 5%
            danger tint read as a card with no background at all. Written as
            two complete class sets rather than a base plus an override,
            because cn() concatenates without tailwind-merge: two border-color
            utilities in one string are resolved by stylesheet order, not by
            which came last. */}
        <section
          className={cn(
            'bg-surface flex flex-col gap-4 rounded-2xl border p-6',
            // Attention reads as the brand blue, not a hazard red. The state
            // this card flags is "one click away from working", which a red
            // card overstates — and the app has no --color-danger token
            // anyway, so `border-danger` generated nothing and the `border`
            // utility fell back to currentColor, i.e. a black outline.
            pathBroken ? 'border-primary/50' : 'border-border'
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <CommandLineIcon
                size={18}
                className={
                  pathState === null
                    ? 'text-muted'
                    : pathHealthy
                      ? 'text-emerald-500'
                      : 'text-primary'
                }
              />
              <div className="flex flex-col gap-1">
                <span className="text-fg text-sm font-medium">
                  {t('settings.channels.cli.path.title')}
                </span>
                {/* The skeleton sits INSIDE the same text-xs span, so the line
                    box is identical loaded or not and the header cannot shift
                    by even a pixel when the probe lands. */}
                <span className={cn('text-xs', pathHealthy ? 'text-emerald-500' : 'text-primary')}>
                  {pathState === null ? (
                    <Skeleton className="h-2.5 w-24 align-middle" />
                  ) : pathHealthy ? (
                    t('settings.channels.cli.path.installed')
                  ) : (
                    t('settings.channels.cli.path.missing')
                  )}
                </span>
              </div>
            </div>
            {/* Install is always rendered, so the header never reflows when the
                probe lands — only its label and emphasis change. Remove joins
                it only once there is a shim to remove — gated on `present`, not
                `installed`: a shim written somewhere the shell cannot see it is
                still a file this app put there, and that is precisely when
                someone wants it gone.

                Both are the shared Button, and Remove wears the destructive
                treatment the Data tab's factory reset uses — red border, red
                tint, red text, before it is hovered rather than after. Removal
                should look like removal everywhere in the app, and a control
                that only reveals its danger on hover reveals it too late. */}
            <div className="flex shrink-0 items-center gap-2">
              {pathState?.present && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === 'path'}
                  onClick={() => void removePath()}
                  className="border-red-500/40 bg-red-500/10 text-red-700 hover:bg-red-500/20 active:bg-red-500/20 dark:text-red-400"
                >
                  {t('settings.channels.cli.path.remove')}
                </Button>
              )}
              <Button
                size="sm"
                variant={pathHealthy ? 'outline' : 'primary'}
                disabled={busy === 'path' || pathState === null}
                onClick={() => void installPath()}
              >
                {pathHealthy
                  ? t('settings.channels.cli.path.reinstall')
                  : t('settings.channels.cli.path.install')}
              </Button>
            </div>
          </div>

          {/* Notices are CONTENT, not a loading state — they belong to a
              machine whose PATH is misconfigured, and on the warm path they
              are present on the very first frame. No placeholder stands in for
              them while loading: a fixed-height block that then becomes a
              three-line warning is a jump too, just a different one. */}
          {pathState !== null && (
            <>
              {pathState.error && (
                <Notice tone="danger">
                  {t('settings.channels.cli.path.failed', { error: pathState.error })}
                </Notice>
              )}
              {pathState.shadowedBy && (
                <Notice tone="warn">
                  {t('settings.channels.cli.path.shadowed', {
                    dir: pathState.target.replace(/[/\\][^/\\]+$/, '')
                  })}
                </Notice>
              )}
              {pathState.needsPathEntry && pathState.profileHasEntry && (
                <Notice tone="warn">{t('settings.channels.cli.path.needsEntryDone')}</Notice>
              )}
              {pathState.needsPathEntry && pathState.profileHint && (
                <div className="flex flex-col gap-2">
                  <Notice tone="warn">{t('settings.channels.cli.path.needsEntry')}</Notice>
                  <CodeLine
                    text={pathState.profileHint}
                    copied={copied === 'hint'}
                    onCopy={() => void copy(pathState.profileHint as string, 'hint')}
                  />
                </div>
              )}
            </>
          )}

          {/* Two fixed rows: the shim's location, and what the shell resolves.
              The second reads "nothing" rather than disappearing, so the block
              is the same height before and after the probe. */}
          <dl className="flex flex-col gap-1.5 text-xs">
            <Row
              label={t('settings.channels.cli.path.installed_at')}
              value={pathState?.target ?? null}
            />
            <Row
              label={t('settings.channels.cli.path.resolves')}
              value={
                pathState ? (pathState.resolved ?? t('settings.channels.cli.path.nothing')) : null
              }
            />
          </dl>

          {/* Always rendered, in both states — it is true either way, and a
              paragraph that only appears once healthy is one more thing that
              can move the page after paint. */}
          <p className="text-muted text-xs leading-relaxed">
            {t('settings.channels.cli.path.hint')}
          </p>

          <div className="flex flex-col gap-1.5">
            <span className="text-muted text-xs">{t('settings.channels.cli.path.verify')}</span>
            <CodeLine
              text="wolffish path status"
              copied={copied === 'verify'}
              onCopy={() => void copy('wolffish path status', 'verify')}
            />
          </div>
        </section>

        {/* Autostart, in full: the on/off AND the mechanism.

            Both this and the Wolffish tab's "Launch at startup" write through
            one dispatcher in main, which moves the stored intent and the OS
            registration together and answers with what actually holds. That is
            what makes two knobs safe rather than a drift waiting to happen —
            and two are wanted, because the people who live in the terminal and
            the people who live in Preferences are not the same people. Each
                screen follows `preferences:changed`, so flipping one moves the other. */}
        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <ServerStack01Icon size={18} className="text-muted mt-0.5" />
              <div className="flex flex-col gap-1">
                {/* Title + Active/Inactive pill, the same shape the Wolffish
                    tab's "Launch at startup" row uses — same setting, so it
                    should be recognisable at a glance from either screen. The
                    pill is the REGISTRATION, which is not the same claim as
                    the switch beside it: an OS that refused reads On · Inactive
                    rather than pretending it worked. */}
                <div className="flex items-center gap-2.5">
                  <span className="text-fg text-sm font-medium">
                    {t('settings.channels.cli.service.title')}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase',
                      service === null
                        ? 'bg-border/40 text-muted'
                        : service.active
                          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                    )}
                  >
                    {service === null ? (
                      <Skeleton className="my-0.5 h-2 w-12 align-middle" />
                    ) : service.active ? (
                      t('settings.wolffish.launchAtStartup.active')
                    ) : (
                      t('settings.wolffish.launchAtStartup.inactive')
                    )}
                  </span>
                </div>
                <p className="text-muted text-xs leading-relaxed">
                  {t('settings.channels.cli.service.description')}
                </p>
              </div>
            </div>
            <Segmented
              value={service?.active ?? false}
              onChange={(value) => void toggleService(value)}
              disabled={busy === 'service' || service === null}
              options={[
                { value: false, label: t('settings.services.inapp.toggle.off') },
                { value: true, label: t('settings.services.inapp.toggle.on') }
              ]}
            />
          </div>

          {service?.warning && <Notice tone="warn">{service.warning}</Notice>}

          <div className="flex flex-col gap-2">
            <span className="text-muted text-xs font-medium">
              {t('settings.channels.cli.service.modeLabel')}
            </span>
            {(['gui', 'headless'] as const).map((mode) => {
              const selected = service?.mode === mode
              const mechanism = mode === 'gui' ? mechanisms?.gui : mechanisms?.headless
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={busy === 'service' || service === null}
                  onClick={() => {
                    if (selected) return
                    // Only the switch INTO a background service on a machine
                    // that has a desktop needs asking about — that is the one
                    // with a surprising consequence (see the dialog). On a
                    // real headless host it is the correct choice and a
                    // confirmation would be noise; switching back is always
                    // safe and never prompts.
                    if (mode === 'headless' && !mechanisms?.headlessHost) setConfirmMode(true)
                    else void setMode(mode)
                  }}
                  className={cn(
                    'flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-start',
                    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                    'disabled:cursor-default',
                    selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-border/20'
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-fg text-xs font-medium">
                      {t(`settings.channels.cli.service.mode.${mode}.label`)}
                    </span>
                    {mechanism ? (
                      <code className="text-muted font-mono text-[10px]" dir="ltr">
                        {mechanism}
                      </code>
                    ) : (
                      <Skeleton className="h-2.5 w-14" />
                    )}
                    {selected && <Tick02Icon size={12} className="text-primary ms-auto" />}
                  </span>
                  <span className="text-muted text-xs leading-relaxed">
                    {t(`settings.channels.cli.service.mode.${mode}.description`)}
                  </span>
                </button>
              )
            })}
          </div>

          {mechanisms?.headlessHost && service?.mode === 'gui' && (
            <Notice tone="warn">{t('settings.channels.cli.service.headlessHostHint')}</Notice>
          )}

          <dl className="flex flex-col gap-1.5 text-xs">
            <Row
              label={t('settings.channels.cli.service.location')}
              value={
                service
                  ? (service.location ?? t('settings.channels.cli.service.managedByOs'))
                  : null
              }
            />
          </dl>

          {/* Where the same switch lives. The label is composed from the keys
              the real UI renders — the destination tab's own label — so it
              stays localized and follows a rename instead of drifting into a
              lie about a screen that no longer exists by that name. */}
          <div className="border-border/60 flex items-center justify-between gap-4 border-t pt-4">
            <p className="text-muted text-xs leading-relaxed">
              {t('settings.channels.cli.service.sameAsPreferences')}
            </p>
            <button
              type="button"
              onClick={() => requestSettingsTab('wolffish')}
              className={cn(
                'border-border bg-bg/40 text-muted hover:text-fg shrink-0 cursor-pointer',
                'rounded-lg border px-3 py-1.5 text-xs font-medium',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
              )}
            >
              {t('settings.channels.cli.service.openSetting', {
                tab: t('settings.tabs.wolffish')
              })}
            </button>
          </div>
        </section>

        {/* Feed verbosity — the same toggle every other channel carries. */}
        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-fg text-sm font-medium">
                {t('settings.channels.cli.verbose.label')}
              </span>
              <p className="text-muted text-xs">{t('settings.channels.cli.verbose.description')}</p>
            </div>
            {config === null ? (
              <div
                aria-hidden="true"
                className="bg-border/30 h-7 w-19.5 shrink-0 animate-pulse rounded-lg"
              />
            ) : (
              <div
                role="tablist"
                className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
              >
                {[false, true].map((value) => {
                  const active = value === (config.verbose === true)
                  return (
                    <button
                      key={String(value)}
                      role="tab"
                      type="button"
                      aria-selected={active}
                      onClick={() => {
                        if (value !== (config.verbose === true)) void setVerbose(value)
                      }}
                      className={cn(
                        'rounded-md px-3 py-1 text-xs font-medium',
                        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                        active
                          ? 'bg-primary text-primary-fg shadow-sm'
                          : 'text-muted hover:text-fg cursor-pointer'
                      )}
                    >
                      {value
                        ? t('settings.services.inapp.toggle.on')
                        : t('settings.services.inapp.toggle.off')}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </section>

        {/* The quirks. Four, because four is what actually differs. */}
        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <h2 className="text-fg text-sm font-medium">{t('settings.channels.cli.guide.title')}</h2>
          <Guide icon={<ServerStack01Icon size={16} />} k="daemon" />
          <Guide icon={<File01Icon size={16} />} k="files" />
          <Guide icon={<Settings02Icon size={16} />} k="settings" />
          <Guide icon={<ShieldKeyIcon size={16} />} k="approvals" />
        </section>

        <CommandReference copied={copied} onCopy={copy} />
      </div>

      {/* Asked before switching a desktop machine to a background service,
          because the consequence is surprising and looks exactly like a bug:
          the agent is registered with KeepAlive, so quitting the app brings it
          straight back. That is correct on a server and alarming on a laptop.
          The dialog names the behaviour and says plainly that it is reversible
          from this same card — the thing someone mid-panic most needs to
          know. */}
      <Modal
        open={confirmMode}
        onClose={() => setConfirmMode(false)}
        dismissable={busy !== 'service'}
        title={t('settings.channels.cli.service.confirm.title')}
        footer={
          <>
            <Button
              size="md"
              variant="primary"
              disabled={busy === 'service'}
              onClick={() => {
                setConfirmMode(false)
                void setMode('headless')
              }}
            >
              {t('settings.channels.cli.service.confirm.accept')}
            </Button>
            <Button
              size="md"
              variant="ghost"
              disabled={busy === 'service'}
              onClick={() => setConfirmMode(false)}
            >
              {t('settings.channels.cli.service.confirm.cancel')}
            </Button>
          </>
        }
      >
        <p>{t('settings.channels.cli.service.confirm.body')}</p>
        <p className="text-muted text-xs leading-relaxed">
          {t('settings.channels.cli.service.confirm.reversible')}
        </p>
      </Modal>
    </div>
  )
}

function Guide({ icon, k }: { icon: React.ReactNode; k: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-3">
      <span className="text-muted mt-0.5 shrink-0">{icon}</span>
      <div className="flex flex-col gap-1">
        <span className="text-fg text-sm font-medium">
          {t(`settings.channels.cli.guide.${k}.title`)}
        </span>
        <p className="text-muted text-xs leading-relaxed">
          {t(`settings.channels.cli.guide.${k}.body`)}
        </p>
      </div>
    </div>
  )
}

/**
 * A loading placeholder. The card renders its full skeleton on first paint and
 * swaps values in as the probes land, so nothing below it ever gets pushed
 * down — the alternative (mounting rows once their data arrives) reflows the
 * whole page a few hundred milliseconds after it looks finished.
 */
function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn('bg-border/40 inline-block animate-pulse rounded', className)}
    />
  )
}

/** The app's standard two-option switch — same markup the other panels use. */
function Segmented<T extends string | boolean>({
  value,
  options,
  onChange,
  disabled
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div
      role="tablist"
      className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={String(option.value)}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={disabled}
            onClick={() => {
              if (option.value !== value) onChange(option.value)
            }}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
              active
                ? 'bg-primary text-primary-fg shadow-sm'
                : 'text-muted hover:text-fg cursor-pointer'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** A label/value line. `null` renders a skeleton, keeping the row's height. */
function Row({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-muted shrink-0">{label}</dt>
      <dd
        className="text-fg/80 min-w-0 flex-1 truncate font-mono text-[11px]"
        dir="ltr"
        title={value ?? undefined}
      >
        {value ?? <Skeleton className="h-2.5 w-40 align-middle" />}
      </dd>
    </div>
  )
}

function Notice({
  tone,
  children
}: {
  tone: 'warn' | 'danger'
  children: React.ReactNode
}): React.JSX.Element {
  // Tailwind's own palette, matching every other panel. The theme defines no
  // danger/success/warning tokens, so `bg-danger/10` and friends compiled to
  // nothing and the bare `border` fell back to currentColor — a black outline.
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3 text-xs leading-relaxed',
        tone === 'danger'
          ? 'border-rose-500/40 bg-rose-500/10 text-rose-500'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
      )}
    >
      <Alert02Icon size={14} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

function CodeLine({
  text,
  copied,
  onCopy
}: {
  text: string
  copied: boolean
  onCopy: () => void
}): React.JSX.Element {
  return (
    <div className="border-border bg-bg/60 flex items-center gap-2 rounded-lg border p-2">
      <code className="text-fg/90 flex-1 overflow-x-auto font-mono text-[11px]" dir="ltr">
        {text}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label="copy"
        className="text-muted hover:text-fg shrink-0 cursor-pointer rounded p-1 focus-visible:ring-2 focus-visible:ring-accent"
      >
        {copied ? <Tick02Icon size={13} /> : <Copy01Icon size={13} />}
      </button>
    </div>
  )
}

/**
 * The command reference. Grouped the way `wolffish help` groups them, so the
 * two never read as different products.
 */
function CommandReference({
  copied,
  onCopy
}: {
  copied: string | null
  onCopy: (text: string, key: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const groups = useMemo(
    () => [
      {
        key: 'chat',
        rows: [
          ['wolffish', 'open an interactive session'],
          ['wolffish "why is the disk full"', 'ask once, print, exit'],
          ['wolffish -p "summarize" -f report.pdf', 'attach files by path'],
          ['cat error.log | wolffish -p "what broke?"', 'pipe context in']
        ]
      },
      {
        key: 'conversations',
        rows: [
          ['wolffish conversations', 'list conversations'],
          ['wolffish conversations show <id>', 'print a transcript'],
          ['wolffish resume <id>', 'continue one'],
          ['wolffish conversations rm <id>', 'delete one']
        ]
      },
      {
        // The terminal's settings surface is this window's, walked: page, then
        // card, then row. These are the words that open each level.
        key: 'settings',
        rows: [
          ['wolffish settings', 'browse every page and card'],
          ['wolffish settings channels telegram', 'straight to one card'],
          ['wolffish settings list', 'every setting and its value'],
          ['wolffish settings set <id> <value>', 'change one'],
          ['wolffish settings providers', 'keys and the brain']
        ]
      },
      {
        key: 'workspace',
        rows: [
          ['wolffish projects', 'projects'],
          ['wolffish procedures run <id>', 'run a procedure'],
          ['wolffish automations edit', 'edit the automation file'],
          ['wolffish documents soul', 'edit Soul in $EDITOR'],
          ['wolffish files', 'browse the workspace'],
          ['wolffish settings usage', 'tokens and cost']
        ]
      },
      {
        key: 'machine',
        rows: [
          ['wolffish status', 'daemon, brain, autostart, channels'],
          ['wolffish service install --headless', 'run as a background service'],
          ['wolffish path status', 'is the command findable'],
          ['wolffish pair phone', 'QR (or a typed code over SSH)'],
          ['wolffish service logs -f', 'follow the log']
        ]
      }
    ],
    []
  )

  return (
    <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
      <h2 className="text-fg flex items-center gap-2 text-sm font-medium">
        <CommandLineIcon size={16} className="text-muted" />
        {t('settings.channels.cli.commands.title')}
      </h2>
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-2">
          <span className="text-muted text-xs font-medium uppercase tracking-wide">
            {t(`settings.channels.cli.commands.${group.key}`)}
          </span>
          <div className="flex flex-col gap-1">
            {group.rows.map(([command, description]) => (
              <button
                key={command}
                type="button"
                onClick={() => onCopy(command, command)}
                title={description}
                className="border-border/60 hover:bg-border/20 flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-1.5 text-start"
              >
                <code className="text-fg/90 shrink-0 font-mono text-[11px]" dir="ltr">
                  {command}
                </code>
                <span className="text-muted flex-1 truncate text-xs">{description}</span>
                {copied === command ? (
                  <CheckmarkCircle02Icon size={13} className="shrink-0 text-emerald-500" />
                ) : (
                  <Copy01Icon size={13} className="text-muted/50 shrink-0" />
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
