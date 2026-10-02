import { Button } from '@components/core/Button'
import { Num } from '@components/core/Num'
import { useOnline } from '@hooks/use-online/useOnline'
import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { PanelBackChevron } from '@pages/settings/drillNav'
import { formatBytesL, formatDurationL, formatGBL, ltrIsolate } from '@lib/utils/format'
import type {
  ModelEntry,
  ModelFamily,
  OllamaModelDetail,
  OllamaTag,
  SystemInfo
} from '@preload/index'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import {
  ArrowLeft02Icon,
  ArrowRight02Icon,
  ComputerIcon,
  CpuIcon,
  FolderOpenIcon,
  HardDriveIcon,
  Loading03Icon,
  RamMemoryIcon,
  Tick02Icon
} from 'hugeicons-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const FAMILY_ORDER: ModelFamily[] = ['gemma', 'qwen', 'llama', 'deepseek', 'kimi']

const LATEST_SERIES: Partial<Record<ModelFamily, string>> = {
  gemma: 'gemma4',
  qwen: 'qwen3.6',
  llama: 'llama4',
  deepseek: 'deepseek-r1'
}

type TagKey =
  | 'vision'
  | 'tools'
  | 'thinking'
  | 'code'
  | 'safety'
  | 'embedding'
  | 'medical'
  | 'translation'
  | 'math'
  | 'reasoning'
  | 'ocr'

const MODEL_TAGS: Partial<Record<string, TagKey[]>> = {
  gemma4: ['vision', 'tools', 'thinking'],
  gemma3: ['vision'],
  codegemma: ['code'],
  shieldgemma: ['safety'],
  embeddinggemma: ['embedding'],
  medgemma: ['medical'],
  'medgemma1.5': ['medical'],
  translategemma: ['translation'],
  functiongemma: ['tools'],
  'qwen3.6': ['vision'],
  'qwen3.5': ['vision'],
  'qwen3-coder': ['code'],
  'qwen3-vl': ['vision'],
  'qwen3-embedding': ['embedding'],
  'qwen2.5-coder': ['code'],
  'qwen2.5vl': ['vision'],
  'qwen2-math': ['math'],
  codeqwen: ['code'],
  qwq: ['reasoning'],
  'llama3.2-vision': ['vision'],
  'llama3-groq-tool-use': ['tools'],
  'llama-guard3': ['safety'],
  codellama: ['code'],
  'deepseek-r1': ['reasoning'],
  'deepseek-coder-v2': ['code'],
  'deepseek-coder': ['code'],
  'deepseek-ocr': ['ocr']
}

function formatParamsValue(n: number): string {
  if (n >= 1000) {
    const t = n / 1000
    return `${Number.isInteger(t) ? t : t.toFixed(1)}T`
  }
  const rounded = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10
  return `${rounded}B`
}

function formatReleaseDate(iso: string, locale: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }).format(d)
}

type PullPhase = 'idle' | 'pulling' | 'error'
type StatusKind = 'lookingUp' | 'downloading' | 'processing' | 'verifying'

// Ollama's per-layer pull events look like "pulling 8eeb..." or
// "downloading sha256:abc...". Both refer to a downloadable layer.
const LAYER_RE = /^(?:pulling|downloading)\s+(?:sha256:)?([0-9a-f]{6,})/i

function statusKindFor(raw: string): StatusKind {
  const lower = raw.toLowerCase()
  if (LAYER_RE.test(lower)) return 'downloading'
  if (lower === 'pulling manifest') return 'lookingUp'
  if (lower === 'verifying sha256 digest') return 'verifying'
  return 'processing'
}

function statusLabel(kind: StatusKind, t: (k: string) => string): string {
  return t(`modelPicker.pullStatus.${kind}`)
}

function localizeError(raw: string, t: (k: string, v?: Record<string, unknown>) => string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('manifest') && lower.includes('does not exist')) {
    return t('modelPicker.pullErrors.manifestMissing')
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up') ||
    lower.includes('fetch failed') ||
    lower.includes('no route to host') ||
    lower.includes('network is unreachable') ||
    lower.includes('connection refused') ||
    lower.includes('i/o timeout') ||
    lower.includes('registry.ollama.ai')
  ) {
    return t('modelPicker.pullErrors.connection')
  }
  return t('modelPicker.pullErrors.generic')
}

function platformLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

/**
 * The Ollama panel of Settings → Models — and nothing else. It has no screen
 * of its own and no place in onboarding: a local model is opt-in, something
 * the user comes looking for, never a step the app marches them through. Its
 * exits are Settings' own — the sidebar and the drill-back chevron in the
 * header — so it carries no "skip" or "back to chat" of its own.
 */
export function ModelPicker(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const isRtl = RTL_LOCALES.has(locale)
  const ArrowIcon = isRtl ? ArrowLeft02Icon : ArrowRight02Icon

  const { goTo, status, refreshStatus } = useFlow()
  const online = useOnline()
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [catalog, setCatalog] = useState<readonly ModelEntry[]>([])
  const [installed, setInstalled] = useState<OllamaTag[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [availableModels, setAvailableModels] = useState<OllamaModelDetail[]>([])
  const [modelsFolder, setModelsFolder] = useState<string>('')
  const [showAvailable, setShowAvailable] = useState(false)
  const [family, setFamily] = useState<ModelFamily>('gemma')
  const [selected, setSelected] = useState<string | null>(null)
  const [phase, setPhase] = useState<PullPhase>('idle')
  // Persisting an already-downloaded model is a config write, not a transfer.
  // It gets its own flag so it never borrows the download UI.
  const [switching, setSwitching] = useState(false)
  const [statusKind, setStatusKind] = useState<StatusKind>('lookingUp')
  const [fakePercent, setFakePercent] = useState(0)
  const [progress, setProgress] = useState<{ completed: number | null; total: number | null }>({
    completed: null,
    total: null
  })
  const [error, setError] = useState<string | null>(null)
  const [speedBps, setSpeedBps] = useState<number | null>(null)
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null)
  const layersRef = useRef<Map<string, { completed: number; total: number }>>(new Map())
  const speedSampleRef = useRef<{ time: number; completed: number } | null>(null)
  const scrollRef = useRef<HTMLElement>(null)

  const currentModel = status?.config?.llm.local.model ?? null
  const restrictModels = status?.config?.llm.restrictPowerfulModels ?? true

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.system.getInfo(),
      window.api.workspace.getModelCatalog(),
      window.api.ollama.listInstalled(),
      window.api.ollama.scanAvailable(),
      window.api.ollama.getModelsFolder()
    ])
      .then(([info, entries, tags, scanned, folder]) => {
        if (cancelled) return
        setSystem(info)
        setCatalog(entries)
        setInstalled(tags)
        setAvailableModels(scanned)
        setModelsFolder(folder)

        const hasAvailable = scanned.length > 0
        if (hasAvailable) setShowAvailable(true)

        const currentEntry = currentModel
          ? entries.find((e) => e.ollamaName === currentModel)
          : undefined
        const initialFamily = currentEntry?.family ?? 'gemma'
        if (!hasAvailable) setFamily(initialFamily)
        setSelected(
          currentModel ??
            defaultModelForFamily(entries, initialFamily, info.totalRamBytes, restrictModels)
        )
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentModel, restrictModels])

  useEffect(() => {
    const offProgress = window.api.model.onPullProgress((event) => {
      if (event.modelName !== selected) return
      // A progress event means main decided to pull after all — hand the UI
      // over to the download card.
      if (event.status !== 'success' && phase !== 'pulling') {
        setSwitching(false)
        setPhase('pulling')
      }

      // Aggregate per-layer progress so the user sees one smooth bar instead
      // of N back-to-back 0→100% cycles. Each layer is keyed by its hash; we
      // track its latest (completed, total) and roll up totals across all
      // layers seen so far.
      const layerMatch = LAYER_RE.exec(event.status.toLowerCase())
      if (layerMatch && event.completed != null && event.total != null) {
        layersRef.current.set(layerMatch[1], {
          completed: event.completed,
          total: event.total
        })
      }

      let totalSum = 0
      let completedSum = 0
      for (const v of layersRef.current.values()) {
        totalSum += v.total
        completedSum += v.completed
      }

      // Phase comes straight from Ollama's status. We used to override to
      // 'processing' when the aggregate hit 100%, but that misfires on
      // multi-layer pulls: layer 1 finishes (100%, override → processing),
      // then layer 2 announces (denominator grows, override breaks → back
      // to downloading). The trade-off is the bar may pin at 100% for a
      // moment between the last `pulling <hash>` and `writing manifest` —
      // honest, since we are still in the downloading stage.
      const kind = statusKindFor(event.status)
      setStatusKind(kind)

      if (kind === 'downloading' && totalSum > 0) {
        setProgress({ completed: completedSum, total: totalSum })
      } else if (kind !== 'downloading') {
        // Once layers are done (processing/verifying/lookingUp), drop the bar.
        setProgress({ completed: null, total: null })
        setSpeedBps(null)
        setEtaSeconds(null)
        speedSampleRef.current = null
      }

      // 1-second speed sampling — uses aggregated bytes so the value isn't
      // reset between layers.
      if (kind === 'downloading') {
        const now = Date.now()
        const start = speedSampleRef.current
        if (!start) {
          speedSampleRef.current = { time: now, completed: completedSum }
        } else if (now - start.time >= 1000) {
          const deltaBytes = completedSum - start.completed
          const deltaSec = (now - start.time) / 1000
          if (deltaBytes > 0 && deltaSec > 0) {
            const speed = deltaBytes / deltaSec
            setSpeedBps(speed)
            if (totalSum > completedSum) {
              setEtaSeconds((totalSum - completedSum) / speed)
            } else {
              setEtaSeconds(null)
            }
          }
          speedSampleRef.current = { time: now, completed: completedSum }
        }
      }
    })
    const offDone = window.api.model.onPullDone((event) => {
      if (event.modelName !== selected) return
      setSwitching(false)
      if (event.ok) {
        // Stay put. This panel lives in Settings → Models → Ollama, so a
        // finished install returns to the list with the model now marked
        // current — it does not walk the user out to the chat. The tag list
        // is re-read HERE rather than left to the load effect: that effect
        // keys on currentModel, and re-pulling the model config already names
        // (one removed with `ollama rm`, or a pull that died half way) writes
        // the same string, so the effect would not re-run and the card would
        // sit there still offering "Install".
        setPhase('idle')
        setError(null)
        setProgress({ completed: null, total: null })
        setStatusKind('lookingUp')
        setSpeedBps(null)
        setEtaSeconds(null)
        speedSampleRef.current = null
        layersRef.current.clear()
        void refreshStatus()
        void Promise.all([window.api.ollama.listInstalled(), window.api.ollama.scanAvailable()])
          .then(([tags, scanned]) => {
            setInstalled(tags)
            setAvailableModels(scanned)
          })
          .catch(() => {})
      } else if (event.aborted) {
        setPhase('idle')
        setError(null)
        setProgress({ completed: null, total: null })
        setStatusKind('lookingUp')
        setSpeedBps(null)
        setEtaSeconds(null)
        speedSampleRef.current = null
        layersRef.current.clear()
      } else {
        setPhase('error')
        setError(localizeError(event.error, t))
      }
    })
    return () => {
      offProgress()
      offDone()
    }
  }, [selected, phase, refreshStatus, t])

  // Cancel an in-flight pull immediately when the network drops. Only during
  // the network-bound phases — processing/verifying are local and don't care.
  useEffect(() => {
    if (phase !== 'pulling') return
    if (statusKind !== 'lookingUp' && statusKind !== 'downloading') return
    const onOffline = (): void => {
      void window.api.model.cancelPull()
    }
    window.addEventListener('offline', onOffline)
    return () => window.removeEventListener('offline', onOffline)
  }, [phase, statusKind])

  // Asymptotic fake progress for phases without real numbers (lookingUp /
  // processing / verifying). Each tick adds a random fraction of the
  // remaining distance to a 95% cap, so the bar creeps up but never lands.
  // The reset is deferred via queueMicrotask so we don't fire a synchronous
  // setState inside the effect body (cascading-render rule).
  useEffect(() => {
    queueMicrotask(() => setFakePercent(0))
    if (phase !== 'pulling' || statusKind === 'downloading') return
    const id = setInterval(() => {
      setFakePercent((prev) => {
        const remaining = 95 - prev
        if (remaining <= 0.5) return prev
        return prev + remaining * (0.04 + Math.random() * 0.06)
      })
    }, 350)
    return () => clearInterval(id)
  }, [phase, statusKind])

  useEffect(() => {
    if (!selected || !scrollRef.current) return
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-model="${selected}"]`)
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(frame)
  }, [selected])

  const filtered = useMemo(() => {
    const prefix = LATEST_SERIES[family] ?? ''
    const isLatest = (m: ModelEntry): boolean => !!prefix && m.ollamaName.split(':')[0] === prefix
    return catalog
      .filter((m) => m.family === family)
      .sort((a, b) => {
        const aL = isLatest(a)
        const bL = isLatest(b)
        if (aL !== bL) return aL ? -1 : 1
        return a.ramBytes - b.ramBytes
      })
  }, [catalog, family])

  // When the user flips to the other family, jump the selection to that
  // family's recommended (largest-fits) model so they don't end up with a
  // selection from the family they just left. Done in the event handler
  // (not an effect) so we never call setState synchronously in an effect
  // body.
  const switchFamily = (next: ModelFamily): void => {
    setFamily(next)
    if (!system || catalog.length === 0) return
    setSelected(defaultModelForFamily(catalog, next, system.totalRamBytes, restrictModels))
  }

  if (!system) {
    return <div className="bg-bg h-full w-full" aria-hidden />
  }

  const recommended =
    system && catalog.length > 0
      ? defaultModelForFamily(catalog, family, system.totalRamBytes, restrictModels)
      : null

  const ramLabel = formatGBL(system.totalRamBytes, t)
  const diskLabel = system.freeDiskBytes != null ? formatGBL(system.freeDiskBytes, t) : null
  const isInstalled = (name: string): boolean =>
    installed.some((t) => t.name === name) || availableModels.some((m) => m.fullName === name)
  // 50-60% of total RAM is the safe ceiling per the rule of thumb in the
  // Ollama community: anything bigger leaves no room for KV cache, the OS,
  // and the app itself, and Ollama starts offloading layers to CPU at huge
  // speed cost. We pick 55% as the middle of that range.
  const maxModelBytes = Math.floor(system.totalRamBytes * 0.55)
  const fitsInRam = (m: ModelEntry): boolean => !restrictModels || m.sizeBytes <= maxModelBytes
  // Disk: keep ~1 GB of slack on top of the model size for temp files and OS
  // breathing room. If we couldn't read free disk, don't block — fall through
  // and let Ollama surface its own error.
  const DISK_MARGIN_BYTES = 1024 ** 3
  const freeDiskBytes = system.freeDiskBytes
  const fitsOnDisk = (m: ModelEntry): boolean =>
    freeDiskBytes == null || m.sizeBytes + DISK_MARGIN_BYTES <= freeDiskBytes
  const selectedEntry = catalog.find((m) => m.ollamaName === selected)
  const selectedFits = !!selectedEntry && fitsInRam(selectedEntry)
  const selectedFitsOnDisk = !selectedEntry || fitsOnDisk(selectedEntry)
  const alreadyHave = !!selected && isInstalled(selected)
  // Anything that would move `selected` out from under an in-flight
  // model:select is locked while one is running — the done/progress listeners
  // key off `selected` and would stop matching.
  const locked = phase === 'pulling' || switching
  const canInstall =
    !!selected &&
    !locked &&
    (online || alreadyHave) &&
    (selectedFits || alreadyHave) &&
    (selectedFitsOnDisk || alreadyHave)

  const onPickFolder = async (): Promise<void> => {
    const folder = await window.api.ollama.pickModelsFolder()
    if (!folder) return
    await window.api.ollama.setModelsFolder(folder)
    setModelsFolder(folder)
    const models = await window.api.ollama.scanAvailable()
    setAvailableModels(models)
    if (models.length > 0) setShowAvailable(true)
  }

  // Two actions sit behind the one primary button:
  //   · model not downloaded    → pull it (download card + Cancel)
  //   · downloaded, not current → persist the choice, in place
  // Only the first is a transfer, so only the first gets the transfer UI. A
  // model that is downloaded AND already current needs neither — config
  // already names it — so the button renders nothing at all rather than a
  // "Continue" that only ever meant "leave this screen".
  const isCurrentSelection = alreadyHave && selected === currentModel

  const onInstall = async (): Promise<void> => {
    if (!selected) return
    // `installed` is Ollama's own tag list — the exact check main runs to
    // decide whether a pull is needed. Predicting it here keeps the download
    // card out of the picture when nothing is going to be downloaded; if the
    // prediction is wrong, the first progress event promotes us to 'pulling'.
    const needsDownload = !installed.some((tag) => tag.name === selected)
    setError(null)
    if (!needsDownload) {
      setSwitching(true)
    } else {
      setPhase('pulling')
      setStatusKind('lookingUp')
      setProgress({ completed: null, total: null })
      setSpeedBps(null)
      setEtaSeconds(null)
      speedSampleRef.current = null
      layersRef.current.clear()
    }
    const result = await window.api.model.select(selected)
    if (!result.ok) {
      setSwitching(false)
      if (result.aborted) {
        setPhase('idle')
        setStatusKind('lookingUp')
        setProgress({ completed: null, total: null })
        setSpeedBps(null)
        setEtaSeconds(null)
        speedSampleRef.current = null
        layersRef.current.clear()
      } else {
        setPhase('error')
        setError(localizeError(result.error, t))
      }
    } else if (result.alreadyRunning) {
      // We joined a pull already in flight — that call owns the pullDone
      // broadcast, so nothing will arrive to clear this for us.
      setSwitching(false)
    }
  }

  const onCancel = (): void => {
    void window.api.model.cancelPull()
  }

  const percent =
    progress.total && progress.total > 0 && progress.completed != null
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : null

  return (
    <main className="bg-bg h-full w-full overflow-y-auto">
      <div className="flex min-h-full w-full items-center justify-center px-6 py-10">
        <div className="flex w-full max-w-2xl flex-col gap-6">
          <header className="flex flex-col items-center gap-2 text-center">
            <div className="flex items-center gap-1.5">
              <PanelBackChevron />
              <h1 className="text-fg text-2xl font-semibold tracking-tight">
                {t('modelPicker.title')}
              </h1>
            </div>
            <p className="text-muted text-sm leading-relaxed">{t('modelPicker.tagline')}</p>
          </header>

          <DeviceSpecsCard
            os={platformLabel(system.platform)}
            cpuModel={system.cpuModel}
            cpuCount={system.cpuCount}
            ramLabel={ramLabel}
            diskLabel={diskLabel}
            t={t}
          />

          {!online && (
            <div
              role="alert"
              className="bg-surface border-border text-muted rounded-2xl border px-4 py-2 text-center text-xs"
            >
              {t('common.offline')}
            </div>
          )}

          <ModelsFolderCard folder={modelsFolder} onPickFolder={onPickFolder} t={t} />

          <FamilyToggle
            family={family}
            setFamily={switchFamily}
            catalog={catalog}
            t={t}
            disabled={locked}
            showAvailable={showAvailable}
            setShowAvailable={setShowAvailable}
            availableCount={availableModels.length}
          />

          {showAvailable ? (
            <section ref={scrollRef} className="flex max-h-136 flex-col gap-3 overflow-y-auto">
              {availableModels.length === 0 && (
                <div className="bg-surface border-border text-muted rounded-2xl border p-5 text-center text-sm">
                  {t('modelPicker.noAvailableModels')}
                </div>
              )}
              {availableModels.map((model) => (
                <AvailableModelCard
                  key={model.fullName}
                  model={model}
                  isSelected={selected === model.fullName}
                  isCurrent={model.fullName === currentModel}
                  disabled={locked}
                  onSelect={() => setSelected(model.fullName)}
                  t={t}
                />
              ))}
            </section>
          ) : (
            <section ref={scrollRef} className="flex max-h-136 flex-col gap-3 overflow-y-auto">
              {catalogLoading && filtered.length === 0 && (
                <div className="bg-surface border-border text-muted animate-pulse rounded-2xl border p-5 text-center text-sm">
                  {t('modelPicker.loadingCatalog')}
                </div>
              )}
              {!catalogLoading && filtered.length === 0 && (
                <div className="bg-surface border-border text-muted rounded-2xl border p-5 text-center text-sm">
                  {t('modelPicker.catalogUnavailable')}
                </div>
              )}
              {filtered.map((entry) => {
                const fits = fitsInRam(entry)
                const fitsDisk = fitsOnDisk(entry)
                const isSelected = selected === entry.ollamaName
                const isCurrent = entry.ollamaName === currentModel
                const installedAlready = isInstalled(entry.ollamaName)
                const blocked = (!fits || !fitsDisk) && !installedAlready
                const disabled = locked || blocked
                return (
                  <button
                    key={entry.ollamaName}
                    data-model={entry.ollamaName}
                    type="button"
                    disabled={disabled}
                    onClick={() => !disabled && setSelected(entry.ollamaName)}
                    aria-pressed={isSelected}
                    className={cn(
                      'bg-surface border-border flex items-start gap-4 rounded-2xl border p-5 text-start',
                      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      !disabled
                        ? 'cursor-pointer hover:border-muted'
                        : 'cursor-not-allowed opacity-50',
                      isSelected && !disabled && 'border-primary'
                    )}
                  >
                    <div
                      aria-hidden
                      className={cn(
                        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                        isSelected && !disabled
                          ? 'border-primary bg-primary text-primary-fg'
                          : 'border-border bg-bg'
                      )}
                    >
                      {isSelected && !disabled && <Tick02Icon size={12} />}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="flex items-baseline gap-2">
                          <span className="text-fg text-base font-semibold">
                            {entry.ollamaName.split(':')[0]}
                          </span>
                          {entry.ollamaName.split(':')[0] === LATEST_SERIES[entry.family] && (
                            <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                              {t('modelPicker.latest')}
                            </span>
                          )}
                          {(MODEL_TAGS[entry.ollamaName.split(':')[0]] ?? []).map((tag) => (
                            <span
                              key={tag}
                              className="bg-fg/5 text-muted rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                            >
                              {t(`modelPicker.tags.${tag}`)}
                            </span>
                          ))}
                        </span>
                        <span className="text-muted shrink-0 text-xs">
                          {t(`modelPicker.modelSize.${entry.sizeKey}`)}
                        </span>
                      </div>
                      <p className="text-muted text-sm leading-relaxed">
                        {t(`modelPicker.modelDescription.${entry.sizeKey}`)}
                      </p>
                      <p
                        className={cn(
                          'text-xs',
                          fits ? 'text-muted' : 'text-amber-700 dark:text-amber-400'
                        )}
                      >
                        {t('modelPicker.approxRam', {
                          ram: formatGBL(entry.ramBytes, t)
                        })}
                        {entry.paramsBillions != null &&
                          ` · ${ltrIsolate(t('modelPicker.params', { value: formatParamsValue(entry.paramsBillions) }))}`}
                        {entry.releaseDate &&
                          ` · ${ltrIsolate(formatReleaseDate(entry.releaseDate, locale))}`}
                        {!fits && ` · ${t('modelPicker.tooBig')}`}
                      </p>
                      {isCurrent && installedAlready ? (
                        <p className="text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                          {t('modelPicker.current')}
                        </p>
                      ) : installedAlready ? (
                        <p className="text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                          {t('modelPicker.alreadyInstalled')}
                        </p>
                      ) : recommended === entry.ollamaName ? (
                        <p className="text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                          {t('modelPicker.recommended')}
                        </p>
                      ) : null}
                    </div>
                  </button>
                )
              })}
            </section>
          )}

          {phase === 'pulling' && (
            <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-fg flex animate-pulse items-baseline gap-1.5 text-sm font-medium">
                  <span>{statusLabel(statusKind, t)}</span>
                  {selected && <Num className="font-semibold">{selected}</Num>}
                  {statusKind === 'downloading' && percent != null && (
                    <Num>{Math.round(percent)}%</Num>
                  )}
                </span>
                {statusKind === 'downloading' &&
                  progress.completed != null &&
                  progress.total != null && (
                    // No <Num> here: it forces dir="ltr", which under Arabic tears
                    // each numeral away from its unit word ("4.0" strands to the far
                    // left of "جيجا بايت / 1.2 جيجا بايت"). formatBytesL already
                    // isolates the numeral, so the string is safe in ambient flow.
                    <span className="text-muted text-xs tabular-nums">
                      {formatBytesL(progress.completed, t)} / {formatBytesL(progress.total, t)}
                    </span>
                  )}
              </div>

              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  statusKind === 'downloading' ? (percent ?? 0) : Math.round(fakePercent)
                }
                className="bg-border/40 h-2 w-full overflow-hidden rounded-full"
              >
                <div
                  className="bg-primary h-full rounded-full transition-[width] duration-300 ease-out"
                  style={{
                    width: `${statusKind === 'downloading' ? (percent ?? 8) : fakePercent}%`
                  }}
                />
              </div>

              <p className="text-muted text-xs">
                {statusKind === 'downloading' && speedBps != null
                  ? etaSeconds != null && Number.isFinite(etaSeconds)
                    ? t('modelPicker.speedLine', {
                        speed: formatBytesL(speedBps, t),
                        eta: formatDurationL(etaSeconds, t)
                      })
                    : t('modelPicker.speedLineNoEta', {
                        speed: formatBytesL(speedBps, t)
                      })
                  : t(`modelPicker.pullHints.${statusKind}`)}
              </p>

              <Button
                size="md"
                variant="ghost"
                onClick={onCancel}
                disabled={statusKind === 'processing' || statusKind === 'verifying'}
              >
                {t('modelPicker.cancel')}
              </Button>
            </section>
          )}

          {phase === 'error' && error && (
            <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-5">
              <p className="text-fg text-sm leading-relaxed">{error}</p>
              <Button size="md" onClick={() => void onInstall()}>
                {t('modelPicker.retry')}
              </Button>
            </section>
          )}

          {phase === 'idle' && (
            <div className="flex flex-col items-stretch gap-3">
              {!isCurrentSelection && (
                <Button size="lg" disabled={!canInstall} onClick={() => void onInstall()}>
                  <span>{alreadyHave ? t('modelPicker.use') : t('modelPicker.install')}</span>
                  {switching ? (
                    <Loading03Icon size={18} className="animate-spin" />
                  ) : (
                    <ArrowIcon size={18} />
                  )}
                </Button>
              )}
              <button
                type="button"
                disabled={locked}
                onClick={() => goTo('ollama-setup', 'settings')}
                className={cn(
                  'text-muted text-center text-xs',
                  locked ? 'cursor-not-allowed opacity-60' : 'hover:text-fg cursor-pointer'
                )}
              >
                {t('modelPicker.reinstallOllama')}
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

function DeviceSpecsCard({
  os,
  cpuCount,
  ramLabel,
  diskLabel,
  t
}: {
  os: string
  cpuModel: string
  cpuCount: number
  ramLabel: string
  diskLabel: string | null
  t: (k: string, v?: Record<string, unknown>) => string
}): React.JSX.Element {
  return (
    <section className="bg-surface border-border grid grid-cols-4 gap-2 rounded-2xl border p-4">
      <Spec
        icon={<ComputerIcon size={18} />}
        label={t('modelPicker.specs.os')}
        value={<span>{os}</span>}
      />
      <Spec
        icon={<CpuIcon size={18} />}
        label={t('modelPicker.specs.cpu')}
        value={<Num>{cpuCount}</Num>}
      />
      <Spec
        icon={<RamMemoryIcon size={18} />}
        label={t('modelPicker.specs.ram')}
        value={<span className="tabular-nums">{ramLabel}</span>}
      />
      <Spec
        icon={<HardDriveIcon size={18} />}
        label={t('modelPicker.specs.disk')}
        value={diskLabel ? <span className="tabular-nums">{diskLabel}</span> : <span>—</span>}
      />
    </section>
  )
}

function Spec({
  icon,
  label,
  value
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col items-center gap-1 text-center">
      <span className="text-muted">{icon}</span>
      <span className="text-muted truncate text-[10px] uppercase tracking-wide whitespace-nowrap w-full">
        {label}
      </span>
      <span className="text-fg truncate text-sm font-medium whitespace-nowrap w-full">{value}</span>
    </div>
  )
}

function ModelsFolderCard({
  folder,
  onPickFolder,
  t
}: {
  folder: string
  onPickFolder: () => void
  t: (k: string) => string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const onCopy = (): void => {
    if (!folder || copied) return
    void navigator.clipboard.writeText(folder)
    setCopied(true)
    setTimeout(() => setCopied(false), 3000)
  }
  return (
    <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-fg flex items-center gap-2 text-sm font-medium">
          <FolderOpenIcon size={16} className="text-muted shrink-0" />
          {t('modelPicker.modelsFolder')}
        </div>
        <button
          type="button"
          onClick={onPickFolder}
          className="text-primary hover:text-primary/80 shrink-0 cursor-pointer text-sm font-medium"
        >
          {t('modelPicker.chooseFolder')}
        </button>
      </div>
      {folder && (
        <div dir="ltr" className="bg-bg flex w-full items-center gap-2 rounded-lg px-3 py-2">
          <code className="text-muted min-w-0 flex-1 truncate text-xs">{folder}</code>
          <button
            type="button"
            disabled={copied}
            onClick={onCopy}
            className={cn(
              'shrink-0',
              copied ? 'text-muted' : 'text-muted hover:text-fg cursor-pointer'
            )}
            aria-label="Copy path"
          >
            {copied ? (
              <Tick02Icon size={14} />
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        </div>
      )}
    </section>
  )
}

function AvailableModelCard({
  model,
  isSelected,
  isCurrent,
  disabled,
  onSelect,
  t
}: {
  model: OllamaModelDetail
  isSelected: boolean
  isCurrent: boolean
  disabled: boolean
  onSelect: () => void
  t: (k: string, v?: Record<string, unknown>) => string
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={isSelected}
      className={cn(
        'bg-surface border-border flex items-start gap-4 rounded-2xl border p-5 text-start',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        !disabled ? 'cursor-pointer hover:border-muted' : 'cursor-not-allowed opacity-50',
        isSelected && !disabled && 'border-primary'
      )}
    >
      <div
        aria-hidden
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
          isSelected && !disabled
            ? 'border-primary bg-primary text-primary-fg'
            : 'border-border bg-bg'
        )}
      >
        {isSelected && !disabled && <Tick02Icon size={12} />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-fg text-base font-semibold">{model.fullName}</span>
          <span className="text-muted shrink-0 text-xs">{formatBytesL(model.sizeBytes, t)}</span>
        </div>
        <div className="text-muted flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {model.family && (
            <span>
              {t('modelPicker.availableDetail.family')}: {model.family}
            </span>
          )}
          {model.parameterSize && (
            <span>
              {t('modelPicker.availableDetail.params')}: {model.parameterSize}
            </span>
          )}
          {model.quantization && (
            <span>
              {t('modelPicker.availableDetail.quantization')}: {model.quantization}
            </span>
          )}
          {model.format && (
            <span>
              {t('modelPicker.availableDetail.format')}: {model.format}
            </span>
          )}
        </div>
        {isCurrent ? (
          <p className="text-emerald-600 dark:text-emerald-400 text-xs font-medium">
            {t('modelPicker.current')}
          </p>
        ) : (
          <p className="text-emerald-600 dark:text-emerald-400 text-xs font-medium">
            {t('modelPicker.alreadyInstalled')}
          </p>
        )}
      </div>
    </button>
  )
}

function FamilyToggle({
  family,
  setFamily,
  catalog,
  t,
  disabled,
  showAvailable,
  setShowAvailable,
  availableCount
}: {
  family: ModelFamily
  setFamily: (f: ModelFamily) => void
  catalog: readonly ModelEntry[]
  t: (k: string) => string
  disabled: boolean
  showAvailable: boolean
  setShowAvailable: (v: boolean) => void
  availableCount: number
}): React.JSX.Element {
  const visible = FAMILY_ORDER.filter((f) => catalog.some((m) => m.family === f))
  return (
    <div
      role="tablist"
      className="bg-surface border-border inline-flex w-full self-center rounded-full border p-1"
    >
      {availableCount > 0 && (
        <button
          key="available"
          role="tab"
          type="button"
          disabled={disabled}
          aria-selected={showAvailable}
          onClick={() => setShowAvailable(true)}
          className={cn(
            'flex-1 rounded-full px-4 py-1.5 text-sm font-medium',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            showAvailable
              ? 'bg-primary text-primary-fg'
              : 'text-muted hover:text-fg cursor-pointer',
            disabled && 'cursor-not-allowed opacity-60'
          )}
        >
          {t('modelPicker.available')}
        </button>
      )}
      {visible.map((f) => {
        const active = family === f && !showAvailable
        return (
          <button
            key={f}
            role="tab"
            type="button"
            disabled={disabled}
            aria-selected={active}
            onClick={() => {
              setShowAvailable(false)
              setFamily(f)
            }}
            className={cn(
              'flex-1 rounded-full px-4 py-1.5 text-sm font-medium',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
              active ? 'bg-primary text-primary-fg' : 'text-muted hover:text-fg cursor-pointer',
              disabled && 'cursor-not-allowed opacity-60'
            )}
          >
            {t(`modelPicker.family.${f}`)}
          </button>
        )
      })}
    </div>
  )
}

function defaultModelForFamily(
  catalog: readonly ModelEntry[],
  family: ModelFamily,
  totalRamBytes: number,
  restrict: boolean
): string | null {
  const ceiling = Math.floor(totalRamBytes * 0.55)
  const prefix = LATEST_SERIES[family] ?? ''
  const isLatest = (m: ModelEntry): boolean => !!prefix && m.ollamaName.split(':')[0] === prefix

  const familyModels = catalog
    .filter((m) => m.family === family)
    .sort((a, b) => a.ramBytes - b.ramBytes)

  if (!restrict) {
    const latest = familyModels.filter(isLatest)
    return (latest[latest.length - 1] ?? familyModels[familyModels.length - 1])?.ollamaName ?? null
  }

  const latestFitting = familyModels.filter((m) => isLatest(m) && m.sizeBytes <= ceiling)
  if (latestFitting.length > 0) return latestFitting[latestFitting.length - 1].ollamaName

  const anyFitting = familyModels.filter((m) => m.sizeBytes <= ceiling)
  if (anyFitting.length > 0) return anyFitting[anyFitting.length - 1].ollamaName

  return null
}
