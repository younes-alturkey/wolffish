import { OllamaLogo } from '@components/core/ProviderLogos'
import { cn } from '@lib/utils/cn'
import { formatBytesL } from '@lib/utils/format'
import type { ReasoningMode } from '@main/runtime/reasoning'
import {
  BADGE_STYLES,
  isModelDisabled,
  findModelSpec,
  PROVIDER_LOGOS,
  PROVIDER_ORDER,
  shortModelName,
  sortOpenRouterModelIds
} from '@pages/settings/modelCatalog'
import type { BrainSelection, CloudProviderConfig, OllamaSnapshot } from '@preload/index'
import {
  AiBrain01Icon,
  BrainIcon,
  BubbleChatIcon,
  CloudIcon,
  FireIcon,
  FlashIcon,
  Search01Icon,
  Tick02Icon,
  WorkflowSquare03Icon
} from 'hugeicons-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type ChatMode = 'single' | 'workflow'

/** One-word title per reasoning mode, worn by its chip. */
const MODE_SHORT_KEY: Record<ReasoningMode, string> = {
  off: 'chat.reasoning.shortOff',
  on: 'chat.reasoning.shortOn',
  high: 'chat.reasoning.shortHigh',
  max: 'chat.reasoning.shortMax'
}

/** One-line description per reasoning mode, carried as the chip's tooltip. */
const MODE_DESC_KEY: Record<ReasoningMode, string> = {
  off: 'chat.reasoning.off',
  on: 'chat.reasoning.on',
  high: 'chat.reasoning.high',
  max: 'chat.reasoning.max'
}

/**
 * Effort ladder, one icon per mode: instant (no thinking) → brain →
 * amped brain → full burn.
 */
const MODE_ICON: Record<ReasoningMode, typeof BrainIcon> = {
  off: FlashIcon,
  on: BrainIcon,
  high: AiBrain01Icon,
  max: FireIcon
}

/**
 * Composer model switch: ONE control showing the ONE model that will answer —
 * its logo (Ollama, or the cloud provider's) plus its name — with the
 * searchable, scrollable model-picker card built in (the ContextMeter
 * hover/pin recipe). Hovering previews the card; clicking the chip pins it
 * open. There is no Local/Cloud tab pair: a runtime with no model chosen in
 * it was never a thing you could run, so the runtime is a consequence of the
 * pick, not a separate switch, and closed the control says only what is live.
 *
 * The list carries both runtimes: the installed Ollama models first, then
 * one group per connected cloud provider. One search box filters across
 * all of them. Ollama is listed exactly as a cloud provider is — only while
 * it can answer: a cloud group needs its key, the local group needs the
 * daemon up. Both are flags the card READS, never something it checks on
 * open: main watches the daemon in the background (`useOllama`), so the
 * card renders from a settled answer and nothing refreshes when it opens.
 * Picking writes the local model or the Brain — and flips the runtime switch
 * when you picked from the other side — the card is the ONLY model-selection
 * surface; settings keeps just the API keys.
 *
 * The card also carries the two per-turn knobs that used to be their own
 * composer pills — reasoning effort and chat mode — as one chip row each,
 * sitting above the search input. Same selections, same handlers, one panel.
 */
export function ModelSwitch({
  localOnly,
  localModel,
  providers,
  ollama,
  brain,
  disabled,
  reasoningModes,
  reasoningMode,
  chatMode,
  showControls,
  onModeChange,
  onSelectModel,
  onSelectLocalModel,
  onSelectReasoning,
  onSelectChatMode
}: {
  localOnly: boolean
  localModel: string | null
  providers: CloudProviderConfig[]
  /** The daemon's settled state (see useOllama): decides whether the local group exists at all. */
  ollama: OllamaSnapshot
  brain: BrainSelection | null
  disabled: boolean
  /** Ordered reasoning modes this model honours (from reasoningModesFor). */
  reasoningModes: readonly ReasoningMode[]
  /** Active reasoning mode, already clamped to `reasoningModes`. */
  reasoningMode: ReasoningMode
  chatMode: ChatMode
  /** Chip rows hidden while recording, exactly as the old pills were. */
  showControls: boolean
  /**
   * Promise-returning like the pickers below: `pick`/`pickLocal` await it
   * before dropping their optimistic state, so the chip never falls back to a
   * runtime the write has already changed.
   */
  onModeChange: (localOnly: boolean) => Promise<void>
  onSelectModel: (sel: BrainSelection) => Promise<void>
  /** Selects an already-installed Ollama model as the local model. */
  onSelectLocalModel: (model: string) => Promise<void>
  onSelectReasoning: (next: ReasoningMode) => void
  onSelectChatMode: (next: ChatMode) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [query, setQuery] = useState('')
  const [optimistic, setOptimistic] = useState<BrainSelection | null>(null)
  const [optimisticLocal, setOptimisticLocal] = useState<string | null>(null)
  const [optimisticChatMode, setOptimisticChatMode] = useState<ChatMode | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Escape unpins/closes; clicking outside while open closes.
  useEffect(() => {
    if (!open && !pinned) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPinned(false)
        setOpen(false)
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPinned(false)
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, pinned])

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
    }
  }, [])

  // Autofocus the search only when pinned (deliberate open), never on hover —
  // mousing across the composer must not steal focus from the textarea.
  useEffect(() => {
    if (!pinned) return
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [pinned])

  const onEnter = (): void => {
    if (disabled) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setOpen(true), 150)
  }
  const onLeave = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (pinned) return
    hoverTimer.current = setTimeout(() => setOpen(false), 200)
  }
  const cardVisible = (open || pinned) && !disabled

  // Installed Ollama models come with the snapshot — main's watch re-reads
  // them on its own tick, so `ollama pull` in a terminal (or an `ollama rm`)
  // shows up here without a relaunch and without the card asking.
  const installed = ollama.installed

  const shown = optimistic ?? brain
  const connected = useMemo(() => {
    const withKey = providers.filter((p) => p.apiKey && p.apiKey.length > 0)
    return [...withKey].sort((a, b) => PROVIDER_ORDER.indexOf(a.id) - PROVIDER_ORDER.indexOf(b.id))
  }, [providers])

  const activeCloud = useMemo(() => {
    if (!shown) return null
    return connected.some((p) => p.id === shown.providerId) ? shown : null
  }, [shown, connected])

  const q = query.trim().toLowerCase()
  const groups = useMemo(
    () =>
      connected
        .map((p) => {
          let ids = (p.models ?? []).filter(Boolean)
          if (ids.length === 0 && p.model) ids = [p.model]
          if (p.id === 'openrouter') ids = sortOpenRouterModelIds(ids)
          ids = ids.filter((m) => !isModelDisabled(m))
          if (q) {
            ids = ids.filter((m) => m.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
          }
          return { provider: p, ids }
        })
        .filter((g) => g.ids.length > 0),
    [connected, q]
  )

  const shownLocal = optimisticLocal ?? localModel
  const localIds = useMemo(() => {
    const names = installed.map((tag) => tag.name)
    // The configured local model always gets a row of its own — the mirror
    // of a cloud provider whose list is empty still offering its `model`.
    if (shownLocal && !names.includes(shownLocal)) names.push(shownLocal)
    names.sort((a, b) => a.localeCompare(b))
    if (!q) return names
    return names.filter((m) => m.toLowerCase().includes(q) || 'ollama'.includes(q))
  }, [installed, shownLocal, q])

  // No daemon, no group — Ollama is hidden like any provider that cannot
  // answer, and the flag was settled before the card opened. With the daemon
  // up: a search hides an empty local group as noise, while with no search
  // the group always shows, its "nothing installed" line being the answer to
  // "why is there no Ollama model to pick?".
  const showLocalGroup = ollama.reachable && (localIds.length > 0 || !q)

  // ONE model is active at a time, and the closed control shows only that
  // one: its runtime is something the logo says, not a second thing to pick.
  // An in-flight pick decides the runtime before its await lands, so the chip
  // and the checkmark move with the click rather than a round-trip later.
  const shownLocalOnly = optimisticLocal !== null ? true : optimistic !== null ? false : localOnly

  // The chip text is the MODEL name (the logo already says local vs cloud) —
  // with nothing configured it must say so, not echo the mode name as if
  // "Local"/"Cloud" were a model.
  const CloudLogo = activeCloud ? PROVIDER_LOGOS[activeCloud.providerId] : CloudIcon
  const cloudName = activeCloud
    ? shortModelName(activeCloud.model)
    : t('chat.modeToggle.noModelShort')
  const localName = shownLocal ? shortModelName(shownLocal) : t('chat.modeToggle.noModelShort')
  const ActiveLogo = shownLocalOnly ? OllamaLogo : CloudLogo
  const activeName = shownLocalOnly ? localName : cloudName
  /** Whether the chip is showing a real model id (LTR) or the empty-state line. */
  const activeNamed = shownLocalOnly ? Boolean(shownLocal) : Boolean(activeCloud)

  const pick = async (providerId: CloudProviderConfig['id'], model: string): Promise<void> => {
    const sel = { providerId, model }
    setOptimistic(sel)
    try {
      await onSelectModel(sel)
      // Picking a cloud model while running local means "use this model" —
      // flip the switch too instead of leaving the choice inert.
      if (localOnly) await onModeChange(false)
    } finally {
      setOptimistic(null)
    }
  }

  const pickLocal = async (model: string): Promise<void> => {
    setOptimisticLocal(model)
    try {
      await onSelectLocalModel(model)
      // Mirror of `pick`: choosing from the other side of the switch means
      // "run this one", so flip the runtime too.
      if (!localOnly) await onModeChange(true)
    } finally {
      setOptimisticLocal(null)
    }
  }

  // Reasoning: unsupported models get the explanation line instead of chips,
  // and a single-mode model shows its chip inert — the old pill's rules.
  const reasoningSupported = reasoningModes.length > 0
  const reasoningSwitchable = reasoningModes.length > 1

  const pickReasoning = (next: ReasoningMode): void => {
    if (next !== reasoningMode) onSelectReasoning(next)
  }

  const shownChatMode = optimisticChatMode ?? chatMode
  const CHAT_MODES: Array<{
    key: ChatMode
    Icon: typeof BubbleChatIcon
    name: string
    desc: string
  }> = [
    {
      key: 'single',
      Icon: BubbleChatIcon,
      name: t('chat.modePicker.single'),
      desc: t('chat.modePicker.singleDesc')
    },
    {
      key: 'workflow',
      Icon: WorkflowSquare03Icon,
      name: t('chat.modePicker.workflow'),
      desc: t('chat.modePicker.workflowDesc')
    }
  ]

  const pickChatMode = async (next: ChatMode): Promise<void> => {
    setOptimisticChatMode(next)
    try {
      await onSelectChatMode(next)
    } finally {
      setOptimisticChatMode(null)
    }
  }

  const chipClass = (active: boolean, interactive: boolean): string =>
    cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium',
      'focus-visible:ring-2 focus-visible:ring-accent',
      active ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-fg',
      interactive && !active && 'hover:bg-border/40',
      interactive ? 'cursor-pointer' : 'cursor-default'
    )

  // One quiet footer chip (the composer card supplies the surface): the model
  // that will answer, worn as a soft primary tint.
  const modelChipClass = cn(
    'flex h-7 min-w-0 shrink items-center gap-1.5 rounded-lg px-2',
    'bg-primary/10 text-primary',
    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-primary/15'
  )

  return (
    <span
      ref={rootRef}
      className="relative inline-flex shrink-0"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={t('chat.modelPicker.ariaLabel')}
        aria-expanded={cardVisible}
        disabled={disabled}
        onClick={() => {
          if (disabled) return
          setPinned((p) => {
            const next = !p
            if (next) setOpen(true)
            return next
          })
        }}
        onFocus={onEnter}
        onBlur={onLeave}
        className={modelChipClass}
      >
        <ActiveLogo size={14} />
        <span
          className="max-w-64 truncate text-[11px] leading-tight font-medium"
          dir={activeNamed ? 'ltr' : 'auto'}
        >
          {activeName}
        </span>
      </button>

      {cardVisible && (
        <div
          role="dialog"
          className="border-border bg-surface absolute bottom-full inset-s-0 z-50 mb-2 w-104 max-w-[90vw] rounded-xl border shadow-xl"
        >
          {showControls && (
            <div className="border-border flex flex-col gap-1.5 border-b px-3 py-2.5">
              <div
                role="group"
                aria-label={t('chat.reasoning.ariaLabel')}
                className="flex items-center gap-1.5"
              >
                <span className="text-muted w-14 shrink-0 text-[10px] font-medium tracking-wide uppercase">
                  {t('chat.reasoning.label')}
                </span>
                {!reasoningSupported ? (
                  <span className="text-muted text-[11px] leading-snug" dir="auto">
                    {t('chat.reasoning.unsupported')}
                  </span>
                ) : (
                  reasoningModes.map((m) => {
                    const isActive = m === reasoningMode
                    const RowIcon = MODE_ICON[m]
                    return (
                      <button
                        key={m}
                        type="button"
                        disabled={!reasoningSwitchable}
                        title={t(MODE_DESC_KEY[m])}
                        onClick={() => pickReasoning(m)}
                        className={chipClass(isActive, reasoningSwitchable)}
                      >
                        <RowIcon
                          size={13}
                          className={cn('shrink-0', isActive ? 'text-primary' : 'text-muted')}
                        />
                        {t(MODE_SHORT_KEY[m])}
                      </button>
                    )
                  })
                )}
              </div>
              <div
                role="group"
                aria-label={t('chat.modePicker.ariaLabel')}
                className="flex items-center gap-1.5"
              >
                <span className="text-muted w-14 shrink-0 text-[10px] font-medium tracking-wide uppercase">
                  {t('chat.modePicker.label')}
                </span>
                {CHAT_MODES.map(({ key, Icon, name, desc }) => {
                  const isActive = key === shownChatMode
                  return (
                    <button
                      key={key}
                      type="button"
                      title={desc}
                      onClick={() => void pickChatMode(key)}
                      className={chipClass(isActive, true)}
                    >
                      <Icon
                        size={13}
                        className={cn('shrink-0', isActive ? 'text-primary' : 'text-muted')}
                      />
                      {name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="border-border flex items-center gap-2 border-b px-3 py-2">
            <Search01Icon size={14} className="text-muted shrink-0" />
            <input
              ref={searchRef}
              value={query}
              // Engaging the search is a deliberate open — pin the card so the
              // hover-leave timer can't close it out from under the typing.
              onFocus={() => {
                if (hoverTimer.current) clearTimeout(hoverTimer.current)
                setPinned(true)
                setOpen(true)
              }}
              onChange={(e) => {
                setQuery(e.target.value)
                setPinned(true)
              }}
              placeholder={t('chat.modelPicker.search')}
              className="bg-transparent text-fg placeholder:text-muted/50 w-full text-sm outline-none"
            />
          </div>
          {/* Model ids are technical LTR identifiers — the whole list renders
              LTR (logo → id → badges → context → check) even in the RTL UI,
              so rows never mirror around the ids. */}
          <div className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5" dir="ltr">
            {groups.length === 0 && !showLocalGroup && (
              <div className="text-muted px-2 py-4 text-center text-xs" dir="auto">
                {t('chat.modelPicker.noResults')}
              </div>
            )}
            {showLocalGroup && (
              <div className="mb-1.5 flex flex-col gap-1 last:mb-0">
                <div className="text-muted flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide uppercase">
                  <OllamaLogo size={12} />
                  <span dir="auto">{t('settings.model.providers.ollama')}</span>
                </div>
                {localIds.length === 0 ? (
                  <p className="text-muted px-2 pb-1 text-[11px] leading-snug" dir="auto">
                    {t('chat.modelPicker.noLocalModels')}
                  </p>
                ) : (
                  localIds.map((m) => {
                    // The check means "this is THE active model" — with the
                    // runtime tabs gone, a remembered-but-not-running local
                    // model must not wear it while a cloud model answers.
                    const active = shownLocalOnly && shownLocal === m
                    const size = installed.find((tag) => tag.name === m)?.size
                    return (
                      <button
                        key={`ollama::${m}`}
                        type="button"
                        onClick={() => void pickLocal(m)}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-start',
                          'focus-visible:ring-2 focus-visible:ring-accent',
                          active ? 'bg-primary/10 text-fg' : 'text-fg hover:bg-border/40'
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-xs" dir="ltr">
                          {m}
                        </span>
                        {size ? (
                          <span className="text-muted shrink-0 text-[10px] tabular-nums" dir="auto">
                            {formatBytesL(size, t)}
                          </span>
                        ) : null}
                        <span className="w-4 shrink-0">
                          {active ? <Tick02Icon size={14} className="text-primary" /> : null}
                        </span>
                      </button>
                    )
                  })
                )}
              </div>
            )}
            {!q && connected.length === 0 && (
              <div className="text-muted px-2 py-4 text-center text-xs" dir="auto">
                {t('chat.modelPicker.noProviders')}
              </div>
            )}
            {groups.map(({ provider, ids }) => {
              const Logo = PROVIDER_LOGOS[provider.id]
              return (
                <div key={provider.id} className="mb-1.5 flex flex-col gap-1 last:mb-0">
                  <div className="text-muted flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide uppercase">
                    {Logo ? <Logo size={12} /> : null}
                    <span dir="auto">{t(`settings.model.providers.${provider.id}`)}</span>
                  </div>
                  {ids.map((m) => {
                    const active =
                      !shownLocalOnly &&
                      activeCloud?.providerId === provider.id &&
                      activeCloud?.model === m
                    const spec = findModelSpec(provider.id, m)
                    return (
                      <button
                        key={`${provider.id}::${m}`}
                        type="button"
                        onClick={() => void pick(provider.id, m)}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-start',
                          'focus-visible:ring-2 focus-visible:ring-accent',
                          active ? 'bg-primary/10 text-fg' : 'text-fg hover:bg-border/40'
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-xs" dir="ltr">
                          {m}
                        </span>
                        {spec?.badges?.slice(0, 2).map((b) => (
                          <span
                            key={b}
                            dir="auto"
                            className={cn(
                              'inline-flex shrink-0 items-center rounded px-1 text-[9px] font-medium',
                              BADGE_STYLES[b]
                            )}
                          >
                            {t(`settings.model.cloud.breakdown.badges.${b}`)}
                          </span>
                        ))}
                        {spec?.context ? (
                          <span className="text-muted shrink-0 text-[10px] tabular-nums" dir="ltr">
                            {spec.context}
                          </span>
                        ) : null}
                        <span className="w-4 shrink-0">
                          {active ? <Tick02Icon size={14} className="text-primary" /> : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </span>
  )
}
