import { PROVIDER_LABELS, ProviderMark } from '@/components/core/providerLogos'
import { cn } from '@/lib/utils/cn'
import { setConfigValue, useConfigValue, useDemoConfig } from '@/state/demoConfig'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, View } from 'react-native'

/** The provider id Ollama wears in the provider row — the same key its logo and label sit under. */
const OLLAMA = 'ollama'

/**
 * A picker row in the project chips' shape: the whole list on one x-scrolling
 * line, one tap to choose. Chips rather than a Select for the reason the chat
 * menu's project row states — the whole list is the point, and a Select hid
 * every option behind a modal and truncated the value it showed. The row never
 * wraps and scrolls freely on x, so every chip carries its full provider or
 * model name however long it runs.
 */
function ChipRow({
  label,
  chips,
  value,
  onChange
}: {
  label: string
  chips: readonly {
    value: string
    label: string
    /** By active, so a provider logo flips to primary-fg on the lit chip. */
    icon?: (active: boolean) => React.JSX.Element
  }[]
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  // The lit chip can start off the row's right edge — the row would open
  // reading as nothing chosen. Scroll it into view the once; every later
  // change comes from a tap, which is already in view. The latch turns only on
  // a scroll that actually happened, so a chip laid out at the start before
  // the provider list lands still gets carried in when the list pushes it
  // right.
  const rowRef = useRef<ScrollView | null>(null)
  const settled = useRef(false)
  const onActiveLayout = (x: number): void => {
    if (settled.current || x <= 0) return
    settled.current = true
    rowRef.current?.scrollTo({ x: Math.max(x - 12, 0), animated: false })
  }

  return (
    <View className="flex-col gap-1.5">
      <Text className="text-muted font-sans-medium text-left text-sm">{label}</Text>
      <ScrollView
        ref={rowRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        // The visible label above is a SIBLING Text, so without this the row
        // announces only its chips, with no hint of what they choose.
        accessibilityLabel={label}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ alignItems: 'center', gap: 8 }}
      >
        {chips.map((chip) => {
          const active = chip.value === value
          return (
            <Pressable
              key={chip.value}
              accessibilityRole="tab"
              accessibilityLabel={chip.label}
              accessibilityState={{ selected: active }}
              onLayout={active ? (event) => onActiveLayout(event.nativeEvent.layout.x) : undefined}
              onPress={() => onChange(chip.value)}
              className={cn(
                'h-9 shrink-0 flex-row items-center gap-2 rounded-lg border px-3',
                active ? 'bg-primary border-primary' : 'bg-bg border-border active:bg-border-soft'
              )}
            >
              {chip.icon?.(active)}
              <Text
                numberOfLines={1}
                className={cn('font-sans-medium text-xs', active ? 'text-primary-fg' : 'text-fg')}
                // Provider and model names are identifiers, not sentences —
                // keep them LTR under an RTL locale.
                style={{ writingDirection: 'ltr' }}
              >
                {chip.label}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}

/**
 * The model answering, picked the way the desktop's composer card picks it:
 * a provider, then one of that provider's models. Two chip rows — providers
 * on top, the lit provider's models below — and the same control in both
 * places it is mounted (the chat menu sheet and the Model settings screen).
 *
 * There is no Local/Cloud switch. Ollama sits in the provider row exactly as
 * a cloud provider does, listed while it can answer: a cloud provider needs
 * its key, Ollama needs the daemon up on the desktop (the snapshot's
 * `running`). The desktop's `localOnly` flag still exists underneath — it is
 * what its runtime reads to route a turn — but here it is a consequence of the
 * pick, never a thing to flip on its own: choosing Ollama (or one of its
 * models) sets it, choosing a cloud provider clears it, which is exactly what
 * the desktop's own picker does behind a click.
 *
 * The lit provider always has a chip and the lit model always has a chip,
 * even when the list the desktop sent has lost them (a key removed mid-
 * session, a daemon that stopped, a catalog not yet landed) — a row with
 * nothing lit would hide what is answering.
 */
export function ModelSwitch(): React.JSX.Element {
  const { t } = useTranslation()
  const localOnly = useConfigValue('localOnly')
  const localModel = useConfigValue('localModel')
  const localModels = useDemoConfig((state) => state.localModels)
  const ollamaRunning = useDemoConfig((state) => state.ollamaRunning)
  const brainProvider = useConfigValue('brainProvider')
  const brainModel = useConfigValue('brainModel')
  const providers = useDemoConfig((state) => state.providers)

  const activeProvider = localOnly ? OLLAMA : brainProvider

  const providerChips = useMemo(() => {
    const markFor = (id: string) => (active: boolean) => (
      <ProviderMark provider={id} size={16} className={active ? 'text-primary-fg' : 'text-muted'} />
    )
    const chipFor = (id: string) => ({
      value: id,
      label: PROVIDER_LABELS[id] ?? id,
      icon: markFor(id)
    })
    const rows: ReturnType<typeof chipFor>[] = []
    // Ollama leads, as it does in the desktop's list — while the daemon is
    // up, or while it is the side answering (the lit provider keeps its chip).
    if (ollamaRunning || localOnly) rows.push(chipFor(OLLAMA))
    for (const provider of providers) {
      if (provider.hasKey && provider.id !== OLLAMA) rows.push(chipFor(provider.id))
    }
    if (!localOnly && brainProvider && !rows.some((row) => row.value === brainProvider)) {
      rows.push(chipFor(brainProvider))
    }
    return rows
  }, [providers, brainProvider, localOnly, ollamaRunning])

  const cloudProvider = providers.find((provider) => provider.id === brainProvider)
  const modelChips = useMemo(() => {
    if (localOnly) {
      const models = [...localModels]
      if (localModel && !models.includes(localModel)) models.push(localModel)
      return models.map((model) => ({ value: model, label: model }))
    }
    const models = cloudProvider?.models?.length ? [...cloudProvider.models] : []
    if (brainModel && !models.includes(brainModel)) models.push(brainModel)
    return models.map((model) => ({ value: model, label: model }))
  }, [localOnly, localModels, localModel, cloudProvider, brainModel])

  const pickProvider = (id: string): void => {
    if (id === activeProvider) return
    if (id === OLLAMA) {
      // Same courtesy a cloud chip extends: land on a model, not on "No
      // model", when the desktop has one pulled and none was chosen yet.
      if (!localModel && localModels[0]) setConfigValue('localModel', localModels[0])
      setConfigValue('localOnly', true)
      return
    }
    const provider = providers.find((candidate) => candidate.id === id)
    if (!provider) return
    setConfigValue('brainProvider', provider.id)
    setConfigValue('brainModel', provider.model ?? provider.models[0] ?? '')
    // Picking a cloud provider while running local means "use this one" —
    // the desktop's picker flips the runtime behind the same click.
    if (localOnly) setConfigValue('localOnly', false)
  }

  const pickModel = (model: string): void => {
    if (localOnly) {
      if (model !== localModel) setConfigValue('localModel', model)
      return
    }
    if (model === brainModel) return
    setConfigValue('brainModel', model)
    // Mirror onto the provider entry like the desktop's setBrain.
    setConfigValue(
      'providers',
      useDemoConfig
        .getState()
        .providers.map((provider) =>
          provider.id === brainProvider ? { ...provider, model } : provider
        )
    )
  }

  return (
    <View className="flex-col gap-4">
      <ChipRow
        label={t('settings.model.providerLabel')}
        chips={providerChips}
        value={activeProvider}
        onChange={pickProvider}
      />
      <ChipRow
        // Switching provider swaps the whole chip set: remount so the fresh
        // row starts at its left edge and carries the new lit chip in.
        key={activeProvider}
        label={t('settings.model.brainLabel')}
        chips={modelChips}
        value={localOnly ? localModel : brainModel}
        onChange={pickModel}
      />
    </View>
  )
}
