import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft02Icon,
  ArrowRight02Icon,
  CheckmarkCircle02Icon,
  Download04Icon,
  StartUp01Icon,
  Radar01Icon,
  RefreshIcon
} from 'hugeicons-react'
import { Button } from '@components/core/Button'
import { useToast } from '@components/core/toast/useToast'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'

const POLL_MS = 3000

export function OllamaSetup(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const isRtl = RTL_LOCALES.has(locale)
  const ArrowIcon = isRtl ? ArrowLeft02Icon : ArrowRight02Icon

  const { goTo, returnTo } = useFlow()
  const toast = useToast()
  const [reachable, setReachable] = useState<boolean | null>(null)
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [polling, setPolling] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const detect = async (): Promise<boolean> => {
    setChecking(true)
    try {
      // Pin a minimum 500ms so the spinner + disabled state are always
      // observable. Localhost responds in milliseconds otherwise and the
      // user wouldn't see any feedback.
      const [r] = await Promise.all([
        window.api.ollama.detect(),
        new Promise((resolve) => setTimeout(resolve, 500))
      ])
      setReachable(r.reachable)
      setInstalled(r.installed)
      // Stop polling when we've found Ollama. Doing it here (inside the
      // async resolution) keeps the polling effect free of synchronous
      // setState calls in its body.
      if (r.reachable) setPolling(false)
      return r.reachable
    } finally {
      setChecking(false)
    }
  }

  // User-initiated detect — surface feedback via toast when nothing's found.
  // Silent detect is used for mount + polling so we don't spam toasts.
  const onDetectClick = async (): Promise<void> => {
    const ok = await detect()
    if (ok) return
    toast.show({
      tone: 'warning',
      message: installed
        ? t('ollamaSetup.toast.installedNotRunning')
        : t('ollamaSetup.toast.notDetected')
    })
  }

  useEffect(() => {
    // detect() flips setChecking(true) on its first line, which would be
    // a synchronous setState in the effect body. Defer it via a microtask
    // so the state update lands after the effect returns.
    queueMicrotask(() => {
      void detect()
    })
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!polling || reachable) return
    pollTimer.current = setInterval(() => {
      void detect()
    }, POLL_MS)
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current)
        pollTimer.current = null
      }
    }
  }, [polling, reachable])

  const onDownload = async (): Promise<void> => {
    await window.api.ollama.openInstallPage()
    setPolling(true)
  }

  const onStart = async (): Promise<void> => {
    setStarting(true)
    try {
      await window.api.ollama.start()
      setPolling(true)
    } finally {
      setStarting(false)
    }
  }

  const onContinue = (): void => {
    // Every way into this screen comes from Settings → Models → Ollama and
    // carries returnTo='settings', so that is where finishing lands. The
    // fallback is the chat, never a model picker: choosing a local model is
    // something the user goes looking for in the Models panel, not a step
    // this screen graduates them into.
    goTo(returnTo ?? 'chat', null)
  }

  // Until the very first detect() resolves we don't know whether Ollama is
  // running, just installed, or absent. Show a single neutral "detecting"
  // state in that window so the UI doesn't flash a wrong assumption.
  const knowState = reachable !== null && installed !== null

  return (
    <main className="bg-bg flex min-h-full w-full items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-md flex-col gap-6">
        <header className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {!knowState
              ? t('ollamaSetup.titleDetecting')
              : reachable
                ? t('ollamaSetup.title')
                : installed
                  ? t('ollamaSetup.titleNotRunning')
                  : t('ollamaSetup.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">
            {!knowState
              ? t('ollamaSetup.subtitleDetecting')
              : reachable
                ? t('ollamaSetup.subtitle')
                : installed
                  ? t('ollamaSetup.subtitleNotRunning')
                  : t('ollamaSetup.subtitle')}
          </p>
        </header>

        <section
          className={cn(
            'border-border bg-surface rounded-2xl border p-6 shadow-sm dark:shadow-none',
            'flex flex-col gap-4'
          )}
        >
          {!knowState ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <Radar01Icon size={36} className="text-muted" />
              <p className="text-fg text-base font-medium">{t('ollamaSetup.detectingTitle')}</p>
              <p className="text-muted text-sm leading-relaxed">{t('ollamaSetup.detecting')}</p>
            </div>
          ) : reachable === true ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <CheckmarkCircle02Icon size={36} className="text-accent" />
              <p className="text-fg text-base font-medium">{t('ollamaSetup.detected')}</p>
              <p className="text-muted text-sm leading-relaxed">{t('ollamaSetup.detectedHint')}</p>
            </div>
          ) : installed === true ? (
            <div className="flex flex-col gap-4">
              <p className="text-fg text-sm leading-relaxed">{t('ollamaSetup.notRunningHint')}</p>
              <Button size="lg" disabled={starting} onClick={() => void onStart()}>
                <StartUp01Icon size={18} />
                <span>{t('ollamaSetup.openOllama')}</span>
              </Button>
              <Button
                size="lg"
                variant="outline"
                disabled={checking}
                onClick={() => void onDetectClick()}
              >
                <RefreshIcon size={18} className={checking ? 'animate-spin' : ''} />
                <span>{t('ollamaSetup.detectButton')}</span>
              </Button>
              {polling && reachable === false && (
                <p className="text-muted animate-pulse text-center text-xs">
                  {t('ollamaSetup.polling')}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-fg text-sm leading-relaxed">{t('ollamaSetup.howToInstall')}</p>
              <Button size="lg" onClick={() => void onDownload()}>
                <Download04Icon size={18} />
                <span>{t('ollamaSetup.download')}</span>
              </Button>
              <Button
                size="lg"
                variant="outline"
                disabled={checking}
                onClick={() => void onDetectClick()}
              >
                <RefreshIcon size={18} className={checking ? 'animate-spin' : ''} />
                <span>{t('ollamaSetup.detectButton')}</span>
              </Button>
              {polling && reachable === false && (
                <p className="text-muted animate-pulse text-center text-xs">
                  {t('ollamaSetup.polling')}
                </p>
              )}
              {reachable === false && !polling && installed === false && (
                <p className="text-muted text-center text-xs">{t('ollamaSetup.notDetected')}</p>
              )}
            </div>
          )}
        </section>

        {!knowState && (
          <Button size="lg" disabled>
            <RefreshIcon size={18} className="animate-spin" />
            <span>{t('ollamaSetup.detectButton')}</span>
          </Button>
        )}

        {reachable === true && (
          <Button size="lg" onClick={onContinue}>
            <span>{t('ollamaSetup.continue')}</span>
            <ArrowIcon size={18} />
          </Button>
        )}

        {/* Always rendered, in every detection state. This screen paints over
            the whole app — no sidebar, no chrome — so this link is the only
            way off it, and gating it on "Ollama isn't reachable" left anyone
            with Ollama running exactly one button to press. Setting up a
            local provider is optional; leaving must never be. */}
        <button
          type="button"
          onClick={() => goTo(returnTo ?? 'chat', null)}
          className="text-muted hover:text-fg cursor-pointer self-center text-sm underline underline-offset-2"
        >
          {t('ollamaSetup.skip')}
        </button>
      </div>
    </main>
  )
}
