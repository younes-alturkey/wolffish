import { Select, type SelectOption } from '@components/core/Select'
import { cn } from '@lib/utils/cn'
import { PanelBackChevron } from '@pages/settings/drillNav'
import { Loading03Icon, PauseIcon, PlayIcon } from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CapabilityGateBody, CapabilityGateCard, useCapabilityGate } from './capabilityGate'
import { EngineInstallCard } from './EngineInstallCard'
import { useEngineInstall } from './useEngineInstall'

type Voice = {
  id: string
  label: string
  lang: string
  gender: 'female' | 'male'
}

// Kokoro voices. English only (American af_/am_, British bf_/bm_). The engine
// runs fully locally; ids match the cerebellum text-to-speech plugin catalog.
const VOICES: Voice[] = [
  { id: 'af_bella', label: 'Bella', lang: 'English (US)', gender: 'female' },
  { id: 'af_heart', label: 'Heart', lang: 'English (US)', gender: 'female' },
  { id: 'af_nicole', label: 'Nicole', lang: 'English (US)', gender: 'female' },
  { id: 'af_sarah', label: 'Sarah', lang: 'English (US)', gender: 'female' },
  { id: 'af_aoede', label: 'Aoede', lang: 'English (US)', gender: 'female' },
  { id: 'af_kore', label: 'Kore', lang: 'English (US)', gender: 'female' },
  { id: 'af_nova', label: 'Nova', lang: 'English (US)', gender: 'female' },
  { id: 'af_sky', label: 'Sky', lang: 'English (US)', gender: 'female' },
  { id: 'am_adam', label: 'Adam', lang: 'English (US)', gender: 'male' },
  { id: 'am_michael', label: 'Michael', lang: 'English (US)', gender: 'male' },
  { id: 'am_eric', label: 'Eric', lang: 'English (US)', gender: 'male' },
  { id: 'am_liam', label: 'Liam', lang: 'English (US)', gender: 'male' },
  { id: 'am_onyx', label: 'Onyx', lang: 'English (US)', gender: 'male' },
  { id: 'am_puck', label: 'Puck', lang: 'English (US)', gender: 'male' },
  { id: 'bf_emma', label: 'Emma', lang: 'English (UK)', gender: 'female' },
  { id: 'bf_isabella', label: 'Isabella', lang: 'English (UK)', gender: 'female' },
  { id: 'bf_alice', label: 'Alice', lang: 'English (UK)', gender: 'female' },
  { id: 'bf_lily', label: 'Lily', lang: 'English (UK)', gender: 'female' },
  { id: 'bm_george', label: 'George', lang: 'English (UK)', gender: 'male' },
  { id: 'bm_lewis', label: 'Lewis', lang: 'English (UK)', gender: 'male' },
  { id: 'bm_daniel', label: 'Daniel', lang: 'English (UK)', gender: 'male' },
  { id: 'bm_fable', label: 'Fable', lang: 'English (UK)', gender: 'male' }
]

type Speed = { value: string; label: string; rate: number }

// Kokoro takes a float multiplier (0.5–1.5). Stored as a plain number string.
const SPEEDS: Speed[] = [
  { value: '0.75', label: 'Slow', rate: 0.75 },
  { value: '1.0', label: 'Normal', rate: 1 },
  { value: '1.25', label: 'Fast', rate: 1.25 },
  { value: '1.5', label: 'Very fast', rate: 1.5 }
]

const DEFAULT_VOICE = 'af_bella'
const DEFAULT_SPEED = '1.0'

const VOICE_IDS = new Set(VOICES.map((v) => v.id))
const SPEED_VALUES = new Set(SPEEDS.map((s) => s.value))

export function TextToSpeechPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const gate = useCapabilityGate('text-to-speech')
  const engine = useEngineInstall('tts')
  const ready = engine.installed === true
  const [voice, setVoice] = useState(DEFAULT_VOICE)
  const [speed, setSpeed] = useState(DEFAULT_SPEED)
  const [previewing, setPreviewing] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const previewUrlRef = useRef<string | null>(null)

  // Hydrate from config.json on mount; persist on every change so
  // the cerebellum plugin (which re-reads config before every
  // voice_generate / voice_respond call) picks up the user's
  // selection without a restart.
  useEffect(() => {
    let cancelled = false
    void window.api.tts.getConfig().then((cfg) => {
      if (cancelled) return
      // Migrate stale values: configs from the old edge-tts engine stored ids
      // like "en-US-AriaNeural" / rates like "+0%". If the stored value isn't a
      // known Kokoro voice/speed, fall back to the default and persist the fix.
      if (cfg.defaultVoice && VOICE_IDS.has(cfg.defaultVoice)) setVoice(cfg.defaultVoice)
      else void window.api.tts.setConfig({ defaultVoice: DEFAULT_VOICE })
      if (cfg.defaultSpeed && SPEED_VALUES.has(cfg.defaultSpeed)) setSpeed(cfg.defaultSpeed)
      else void window.api.tts.setConfig({ defaultSpeed: DEFAULT_SPEED })
    })
    return () => {
      cancelled = true
    }
  }, [])

  // The paired phone (or another window) can change these too; re-seed when
  // one does, with the same known-value validation the mount hydrate applies.
  // Both selects save on change, so there is no draft to guard.
  useEffect(
    () =>
      window.api.services.onChanged((payload) => {
        if (payload.service !== 'tts') return
        void window.api.tts.getConfig().then((cfg) => {
          if (cfg.defaultVoice && VOICE_IDS.has(cfg.defaultVoice)) setVoice(cfg.defaultVoice)
          if (cfg.defaultSpeed && SPEED_VALUES.has(cfg.defaultSpeed)) setSpeed(cfg.defaultSpeed)
        })
      }),
    []
  )

  const onVoiceChange = (next: string): void => {
    setVoice(next)
    void window.api.tts.setConfig({ defaultVoice: next })
  }
  const onSpeedChange = (next: string): void => {
    setSpeed(next)
    void window.api.tts.setConfig({ defaultSpeed: next })
  }

  const voiceOptions: SelectOption<string>[] = useMemo(
    () =>
      VOICES.map((v) => ({
        value: v.id,
        label: `${v.label} — ${v.lang} (${v.gender})`
      })),
    []
  )

  const speedOptions: SelectOption<string>[] = useMemo(
    () => SPEEDS.map((s) => ({ value: s.value, label: s.label })),
    []
  )

  const stopPreview = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      // Detach handlers BEFORE tearing down so teardown can't fire a spurious
      // 'error' (e.g. clearing src dispatches one) that would surface a false
      // "couldn't play" warning right after a clean playback. pause() is enough
      // to stop audio; we intentionally do NOT set src='' (that's what fired the
      // bogus error). The element is dropped and garbage-collected.
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audioRef.current = null
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setPreviewing(false)
  }, [])

  // Real preview: synthesize a short sample with the *selected* Kokoro voice and
  // speed in the main process, then play the returned MP3. Unlike the old
  // browser-speechSynthesis preview, this is the actual voice the agent uses.
  const togglePreview = useCallback(async () => {
    if (previewing || previewLoading) {
      stopPreview()
      setPreviewLoading(false)
      return
    }
    setPreviewError(null)
    setPreviewLoading(true)
    try {
      const res = await window.api.tts.preview({ voice, speed })
      if (!res.ok) {
        setPreviewError(res.error)
        setPreviewLoading(false)
        return
      }
      const buffer = await window.api.voice.readFile(res.filePath)
      const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/mpeg' }))
      previewUrlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => stopPreview()
      audio.onerror = () => {
        setPreviewError(t('settings.services.tts.previewError'))
        stopPreview()
      }
      setPreviewLoading(false)
      setPreviewing(true)
      // play() rejects with AbortError if the user stops it before it starts —
      // that's benign and must not surface the error warning.
      audio.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setPreviewError(t('settings.services.tts.previewError'))
        stopPreview()
      })
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err))
      setPreviewLoading(false)
      stopPreview()
    }
  }, [previewing, previewLoading, voice, speed, stopPreview, t])

  // Stop any in-flight preview on unmount.
  useEffect(() => () => stopPreview(), [stopPreview])

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <PanelBackChevron />
            <h1 className="text-fg text-2xl font-semibold tracking-tight">
              {t('settings.services.tts.title')}
            </h1>
          </div>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.tts.subtitle')}
          </p>
        </header>

        <CapabilityGateCard gate={gate} label={t('settings.services.tabs.tts')} />

        <CapabilityGateBody gate={gate}>
          <EngineInstallCard
            state={engine}
            requirementKey="settings.services.tts.installRequirement"
          />

          <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
            <div className="flex flex-col gap-1">
              <span className="text-muted text-xs font-medium uppercase tracking-wider">
                {t('settings.services.engine')}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-fg text-sm font-medium">
                  {t('settings.services.tts.engineName')}
                </span>
                <span className="bg-border/60 text-muted rounded-md px-1.5 py-0.5 text-[10px] font-medium">
                  {t('settings.services.tts.local')}
                </span>
                <span className="bg-border/60 text-muted rounded-md px-1.5 py-0.5 text-[10px] font-medium">
                  MP3
                </span>
              </div>
              <p className="text-muted text-xs">{t('settings.services.tts.engineDescription')}</p>
            </div>

            <div
              className={cn(
                'flex flex-col gap-5',
                !ready && 'pointer-events-none select-none opacity-40'
              )}
              aria-disabled={!ready}
            >
              <div className="border-border/60 border-t" />

              <div className="flex flex-col gap-3">
                <Select<string>
                  label={t('settings.services.tts.voice')}
                  value={voice}
                  options={voiceOptions}
                  onChange={onVoiceChange}
                />

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void togglePreview()}
                      disabled={!ready || previewLoading}
                      className={cn(
                        'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full',
                        'bg-primary text-primary-fg hover:brightness-110 disabled:cursor-default disabled:opacity-60',
                        'focus-visible:ring-accent focus-visible:ring-offset-bg focus-visible:ring-2 focus-visible:ring-offset-2'
                      )}
                    >
                      {previewLoading ? (
                        <Loading03Icon size={14} className="animate-spin" />
                      ) : previewing ? (
                        <PauseIcon size={14} />
                      ) : (
                        <PlayIcon size={14} />
                      )}
                    </button>
                    <span className="text-muted text-xs">
                      {t('settings.services.tts.previewHint')}
                    </span>
                  </div>
                  {previewError ? (
                    <span className="text-xs text-amber-500">{previewError}</span>
                  ) : null}
                </div>
              </div>

              <div className="border-border/60 border-t" />

              <Select<string>
                label={t('settings.services.tts.speed')}
                value={speed}
                options={speedOptions}
                onChange={onSpeedChange}
              />
            </div>
          </section>

          <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
            <h2 className="text-fg text-sm font-medium">
              {t('settings.services.tts.voicesTitle')}
            </h2>
            <div className="divide-border/40 divide-y">
              {VOICES.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between py-2 first:pt-0 last:pb-0"
                >
                  <div className="flex flex-col">
                    <span className="text-fg text-sm">{v.label}</span>
                    <span className="text-muted text-xs">{v.lang}</span>
                  </div>
                  <span className="text-muted text-xs capitalize">{v.gender}</span>
                </div>
              ))}
            </div>
          </section>
        </CapabilityGateBody>
      </div>
    </div>
  )
}
