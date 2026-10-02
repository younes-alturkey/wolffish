import { Button } from '@components/core/Button'
import { Input } from '@components/core/Input'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { PanelBackChevron } from '@pages/settings/drillNav'
import type { VideoServiceStatus } from '@preload/index'
import { useFlow } from '@providers/flow/useFlow'
import {
  AiVideoIcon,
  BubbleChatIcon,
  Film01Icon,
  CloudDownloadIcon,
  ComputerIcon,
  EyeIcon,
  FolderLibraryIcon,
  Image02Icon,
  LinkSquare02Icon,
  MagicWand01Icon,
  SentIcon,
  TaskDaily01Icon,
  ViewOffIcon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CapabilityGateBody, CapabilityGateCard, useCapabilityGate } from './capabilityGate'
import { PROVIDER_LOGOS } from './modelCatalog'

const MINIMAX_PLATFORM_URL = 'https://platform.minimax.io'

const STATUS_DOT: Record<'ready' | 'error' | 'disabled', string> = {
  ready: 'bg-emerald-500',
  error: 'bg-rose-500',
  disabled: 'bg-border'
}

/**
 * Settings → Services → Video generation.
 *
 * Its own API key on purpose: MiniMax issues one credential that unlocks
 * both the chat completions API and the video API, but the two are separate
 * decisions here — swapping the chat brain to another provider must not
 * silently kill video generation. The explainer cards below carry that
 * reasoning plus how the flow actually works, since none of it is visible
 * from the model picker (H3 is a tool backend, never a selectable brain).
 */
export function VideoPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const gate = useCapabilityGate('video')

  const [apiKey, setApiKey] = useState('')
  const [savedApiKey, setSavedApiKey] = useState('')
  const [keyVisible, setKeyVisible] = useState(false)
  const [director, setDirector] = useState(true)
  const [status, setStatus] = useState<VideoServiceStatus | null>(null)
  const [busy, setBusy] = useState<'idle' | 'saving' | 'testing'>('idle')
  // Mid-edit guard: a save from another window (or the phone) must never
  // overwrite text the user is typing, and an event callback can't read
  // fresh state.
  const dirtyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const cfg = await window.api.video.getConfig()
      if (cancelled) return
      if (!dirtyRef.current) {
        setApiKey(cfg.apiKey)
        setSavedApiKey(cfg.apiKey)
      }
      setDirector(cfg.director)
      // Probe on open so the status dot reflects reality, not just presence.
      const live = await window.api.video.test()
      if (!cancelled) setStatus(live)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleDirectorToggle = useCallback(async (value: boolean) => {
    // A model directive, not a harness behavior — persist and let the next
    // turn's system prompt carry it. Optimistic; the services push folds
    // back whatever actually stuck (e.g. a phone-side flip racing this one).
    setDirector(value)
    await window.api.video.setConfig({ director: value })
  }, [])

  useEffect(
    () =>
      window.api.services.onChanged((payload) => {
        if (payload.service !== 'video') return
        void (async () => {
          const cfg = await window.api.video.getConfig()
          if (!dirtyRef.current) {
            setApiKey(cfg.apiKey)
            setSavedApiKey(cfg.apiKey)
          }
          // The director toggle has no draft state — a phone-side flip (or
          // another window's) lands here directly.
          setDirector(cfg.director)
        })()
      }),
    []
  )

  const handleSave = useCallback(async () => {
    setBusy('saving')
    try {
      await window.api.video.setConfig({ apiKey: apiKey.trim() })
      setSavedApiKey(apiKey.trim())
      dirtyRef.current = false
      const live = await window.api.video.test()
      setStatus(live)
      toast.show({ message: t('settings.services.video.saveSuccess'), tone: 'success' })
    } finally {
      setBusy('idle')
    }
  }, [apiKey, t, toast])

  const handleTest = useCallback(async () => {
    setBusy('testing')
    try {
      // Test what's typed: persist first, then probe, so the button always
      // reports on the value the user is looking at.
      await window.api.video.setConfig({ apiKey: apiKey.trim() })
      setSavedApiKey(apiKey.trim())
      dirtyRef.current = false
      const live = await window.api.video.test()
      setStatus(live)
      toast.show({
        message: live.reachable
          ? t('settings.services.video.testSuccess')
          : t('settings.services.video.testFailure'),
        tone: live.reachable ? 'success' : 'error'
      })
    } finally {
      setBusy('idle')
    }
  }, [apiKey, t, toast])

  const dot = !status?.configured ? 'disabled' : status.reachable ? 'ready' : 'error'

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <PanelBackChevron />
              <h1 className="text-fg text-2xl font-semibold tracking-tight">
                {t('settings.services.video.title')}
              </h1>
            </div>
            <a
              href={MINIMAX_PLATFORM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'text-muted hover:text-fg flex items-center gap-1.5 text-xs',
                'focus-visible:ring-accent rounded-md px-1.5 py-1 focus-visible:ring-2'
              )}
            >
              <span>{t('settings.services.video.platform')}</span>
              <LinkSquare02Icon size={13} className="shrink-0" />
            </a>
          </div>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.video.subtitle')}
          </p>
        </header>

        <CapabilityGateCard gate={gate} label={t('settings.services.video.title')} />

        <CapabilityGateBody gate={gate}>
          <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted text-xs font-medium tracking-wider uppercase">
                  {t('settings.services.video.status.label')}
                </span>
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn('h-2 w-2 rounded-full', STATUS_DOT[dot])}
                  />
                  <span className="text-fg text-sm">
                    {t(`settings.services.video.status.${dot}`)}
                  </span>
                </div>
              </div>
              {status && !status.reachable && status.configured && (
                <pre
                  className={cn(
                    'bg-bg/40 border-border rounded-md border px-3 py-2',
                    'wrap-break-word font-mono text-xs whitespace-pre-wrap text-rose-500'
                  )}
                >
                  {status.detail}
                </pre>
              )}
            </div>

            <div className="border-border/60 border-t" />

            <div className="flex flex-col gap-1.5">
              <label htmlFor="video-api-key" className="text-muted text-sm font-medium">
                {t('settings.services.video.apiKey')}
              </label>
              <div className="relative w-full">
                <Input
                  id="video-api-key"
                  type={keyVisible ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => {
                    dirtyRef.current = true
                    setApiKey(e.target.value)
                  }}
                  placeholder={t('settings.services.video.apiKeyPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                  className="pe-10 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setKeyVisible((v) => !v)}
                  aria-label={t(
                    keyVisible
                      ? 'settings.services.video.hideKey'
                      : 'settings.services.video.showKey'
                  )}
                  className={cn(
                    'text-muted hover:text-fg inset-e-2 absolute top-1/2 -translate-y-1/2',
                    'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md',
                    'focus-visible:ring-accent focus-visible:ring-2'
                  )}
                >
                  {keyVisible ? <ViewOffIcon size={16} /> : <EyeIcon size={16} />}
                </button>
              </div>
              <p className="text-muted text-xs">{t('settings.services.video.apiKeyHint')}</p>
            </div>

            <div className="border-border/60 border-t" />

            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                onClick={() => void handleSave()}
                disabled={busy !== 'idle' || apiKey.trim() === savedApiKey.trim()}
              >
                {t('settings.services.video.save')}
              </Button>
              {/* Byte-for-byte the provider panel's "Test connection" control
                  (CloudProviderPanel), so the two screens read as one app. */}
              <button
                type="button"
                disabled={busy !== 'idle' || apiKey.trim().length === 0}
                onClick={() => void handleTest()}
                className={cn(
                  'text-sm font-medium capitalize',
                  busy === 'testing'
                    ? 'text-muted animate-pulse cursor-wait'
                    : busy !== 'idle' || apiKey.trim().length === 0
                      ? 'text-muted cursor-not-allowed'
                      : 'text-primary hover:text-primary/80 cursor-pointer'
                )}
              >
                {t('settings.services.video.test')}
              </button>
            </div>
          </section>

          <ExplainerCard
            title={t('settings.services.video.separateKey.title')}
            body={[
              t('settings.services.video.separateKey.p1'),
              t('settings.services.video.separateKey.p2')
            ]}
            tone="accent"
          />

          <ExplainerCard
            title={t('settings.services.video.howItWorks.title')}
            body={[t('settings.services.video.howItWorks.p1')]}
            // One icon per beat of the flow: you ask → a task card tracks it
            // → the file lands → your model hands it over.
            steps={[
              { icon: BubbleChatIcon, text: t('settings.services.video.howItWorks.s1') },
              { icon: TaskDaily01Icon, text: t('settings.services.video.howItWorks.s2') },
              { icon: CloudDownloadIcon, text: t('settings.services.video.howItWorks.s3') },
              { icon: SentIcon, text: t('settings.services.video.howItWorks.s4') }
            ]}
            footer={t('settings.services.video.howItWorks.footer')}
          />

          <DirectorCard enabled={director} onToggle={(v) => void handleDirectorToggle(v)} />

          <ExplainerCard
            title={t('settings.services.video.capabilities.title')}
            body={[t('settings.services.video.capabilities.p1')]}
            steps={[
              { icon: Image02Icon, text: t('settings.services.video.capabilities.modes') },
              { icon: AiVideoIcon, text: t('settings.services.video.capabilities.output') },
              { icon: MagicWand01Icon, text: t('settings.services.video.capabilities.limits') },
              { icon: FolderLibraryIcon, text: t('settings.services.video.capabilities.storage') }
            ]}
            footer={t('settings.services.video.capabilities.footer')}
          />
        </CapabilityGateBody>
      </div>
    </div>
  )
}

/**
 * The Director card: what the selected chat model contributes. This is the
 * least obvious part of the feature — the video quality depends on the brain
 * you are chatting with, not on this panel — so it shows a real before/after
 * rather than describing one.
 */
function DirectorCard({
  enabled,
  onToggle
}: {
  enabled: boolean
  onToggle: (value: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { status } = useFlow()

  // The live director: the Brain, resolved exactly the way the composer
  // resolves it (a brain whose provider lost its key isn't active), falling
  // back to the local model. Naming the actual model — with its provider's
  // logo — is what turns "your chat model directs this" from a claim into
  // something the user can see.
  const director = useMemo(() => {
    const llm = status?.config?.llm
    if (!llm) return null
    const brain = llm.brain
    if (brain && !llm.localOnly) {
      const provider = llm.providers?.find((p) => p.id === brain.providerId)
      if (provider?.apiKey && provider.apiKey.length > 0) {
        return { kind: 'cloud' as const, providerId: brain.providerId, model: brain.model }
      }
    }
    if (llm.local?.model) return { kind: 'local' as const, model: llm.local.model }
    return null
  }, [status?.config?.llm])

  const Logo = director?.kind === 'cloud' ? PROVIDER_LOGOS[director.providerId] : null

  return (
    <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-fg text-sm font-semibold">
            {t('settings.services.video.director.title')}
          </h2>
          {/* The switch lives on the card that explains it — same tablist
              toggle every service panel uses. A model directive only: the
              system prompt tells the model to direct or to forward the
              user's prompt verbatim; nothing is enforced by the harness. */}
          <div
            role="tablist"
            className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
          >
            {([false, true] as const).map((value) => {
              const active = value === enabled
              return (
                <button
                  key={String(value)}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={() => onToggle(value)}
                  className={cn(
                    'rounded-md px-3 py-1 text-xs font-medium',
                    'focus-visible:ring-accent focus-visible:ring-offset-bg focus-visible:ring-2 focus-visible:ring-offset-2',
                    active
                      ? 'bg-primary text-primary-fg shadow-sm'
                      : 'text-muted hover:text-fg cursor-pointer'
                  )}
                >
                  {t(
                    value
                      ? 'settings.services.video.director.on'
                      : 'settings.services.video.director.off'
                  )}
                </button>
              )
            })}
          </div>
        </div>
        <p className="text-muted text-sm leading-relaxed">
          {t('settings.services.video.director.p1')}
        </p>
        {!enabled && (
          <p className="border-amber-500/30 bg-amber-500/5 text-fg mt-1 rounded-md border px-3 py-2 text-xs leading-relaxed">
            {t('settings.services.video.director.offHint')}
          </p>
        )}
      </div>

      <div className="border-accent/30 bg-accent/5 flex items-center gap-3 rounded-xl border px-4 py-3">
        <span
          aria-hidden="true"
          className="bg-bg border-border text-fg flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
        >
          {Logo ? <Logo size={18} /> : <ComputerIcon size={18} />}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-muted text-[10px] font-medium tracking-wider uppercase">
            {t('settings.services.video.director.currentLabel')}
          </span>
          <span dir="ltr" className="text-fg truncate text-sm font-medium">
            {director?.model ?? t('settings.services.video.director.noModel')}
          </span>
        </div>
        <Film01Icon size={16} className="text-accent ms-auto shrink-0" aria-hidden />
      </div>
      <p className="text-muted -mt-1 text-xs leading-relaxed">
        {t('settings.services.video.director.currentHint')}
      </p>

      <div className="flex flex-col gap-2">
        <span className="text-muted text-xs font-medium tracking-wider uppercase">
          {t('settings.services.video.director.youAsk')}
        </span>
        <p
          dir="auto"
          className="text-fg bg-bg/40 border-border rounded-md border px-3 py-2 text-sm"
        >
          {t('settings.services.video.director.askExample')}
        </p>
        <span className="text-muted mt-1 text-xs font-medium tracking-wider uppercase">
          {t('settings.services.video.director.modelSends')}
        </span>
        <p
          dir="auto"
          className="text-fg border-accent/40 bg-accent/5 rounded-md border px-3 py-2 text-sm leading-relaxed"
        >
          {t('settings.services.video.director.promptExample')}
        </p>
      </div>

      <ul className="flex flex-col gap-1.5">
        {[
          t('settings.services.video.director.b1'),
          t('settings.services.video.director.b2'),
          t('settings.services.video.director.b3')
        ].map((line, i) => (
          <li key={i} dir="auto" className="text-muted flex gap-2 text-sm leading-relaxed">
            <span aria-hidden="true" className="text-accent shrink-0">
              •
            </span>
            {line}
          </li>
        ))}
      </ul>

      <p className="text-muted border-border/60 border-t pt-3 text-xs leading-relaxed">
        {t('settings.services.video.director.footer')}
      </p>
    </section>
  )
}

type ExplainerStep = {
  icon: React.ComponentType<{ size?: number; className?: string }>
  text: string
}

/**
 * An icon per point rather than a number or a bullet: these lists mix a
 * sequence (how it works) with a set of facts (what H3 can do), and a
 * picture of the idea — a chat bubble, a task card, a download, a send —
 * carries the meaning faster than an index does.
 */
function ExplainerCard({
  title,
  body,
  steps,
  footer,
  tone = 'plain'
}: {
  title: string
  body: string[]
  steps?: ExplainerStep[]
  footer?: string
  tone?: 'plain' | 'accent'
}): React.JSX.Element {
  return (
    <section
      className={cn(
        'flex flex-col gap-3 rounded-2xl border p-6',
        tone === 'accent' ? 'border-accent/30 bg-accent/5' : 'bg-surface border-border'
      )}
    >
      <h2 className="text-fg text-sm font-semibold">{title}</h2>
      {body.map((paragraph, i) => (
        <p key={i} dir="auto" className="text-muted text-sm leading-relaxed">
          {paragraph}
        </p>
      ))}
      {steps && steps.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {steps.map((step, i) => (
            <li key={i} dir="auto" className="text-muted flex gap-3 text-sm leading-relaxed">
              <span
                aria-hidden="true"
                className="bg-bg border-border text-accent mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border"
              >
                <step.icon size={13} />
              </span>
              <span className="min-w-0">{step.text}</span>
            </li>
          ))}
        </ul>
      )}
      {footer && (
        <p className="text-muted border-border/60 border-t pt-3 text-xs leading-relaxed">
          {footer}
        </p>
      )}
    </section>
  )
}
