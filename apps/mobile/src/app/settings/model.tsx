import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { Button } from '@/components/core/Button'
import { Input } from '@/components/core/Input'
import { Select } from '@/components/core/Select'
import { CheckmarkCircle02Icon } from '@/components/core/icons'
import { PROVIDER_LABELS, PROVIDER_LOGOS } from '@/components/core/providerLogos'
import { ModeAndThinkingControls } from '@/components/chat/ChatControls'
import { ModelSwitch } from '@/components/chat/ModelSwitch'
import { PanelScreen, Section, StatusDot } from '@/components/settings/SettingsUI'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/providers/toast/useToast'
import {
  saveDesktopSetting,
  setConfigValue,
  useConfigValue,
  useDemoConfig,
  useSettingsReadOnly,
  type DemoProvider
} from '@/state/demoConfig'
import { useAppStore } from '@/state/appStore'
import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/**
 * Model, desktop UX: behavior controls up top — the two knobs touched every
 * session — then the Model card (provider chips, then that provider's
 * models — Ollama listed beside the cloud providers, no Local/Cloud switch),
 * Local, then a card per cloud provider (logo, key state,
 * masked key preview, new-key entry). Every control writes through to the
 * paired desktop over configSet; the connection test is the one demo-only
 * affordance, because the desktop has no test RPC to run it against.
 */

const ProviderCard = memo(function ProviderCard({
  provider
}: {
  provider: DemoProvider
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const paired = useAppStore((state) => state.paired)
  const readOnly = useSettingsReadOnly()
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * Typing composes a NEW key, always — the stored one appears only as the
   * placeholder preview. Paired, the snapshot carries a 12-char mask rather
   * than the credential (it never leaves that machine), so prefilling it as
   * editable text would invite a stray edit that saves mask-junk over the
   * real key. The draft lives locally until saved, so a snapshot refresh
   * mid-typing cannot yank the text out from under the user.
   */
  const [draft, setDraft] = useState('')
  const stored = provider.apiKey ?? ''
  const savable = draft.trim().length > 0
  const Logo = PROVIDER_LOGOS[provider.id]

  const saveKey = async (): Promise<void> => {
    if (!savable || busy) return
    setBusy(true)
    // The whole array travels; the desktop honors the one field that changed
    // and ignores its own masked previews on every other row.
    const key = draft.trim()
    const next = useDemoConfig
      .getState()
      .providers.map((entry) =>
        entry.id === provider.id ? { ...entry, apiKey: key, hasKey: true } : entry
      )
    const saved = await saveDesktopSetting('providers', next)
    setBusy(false)
    toast.show({
      tone: saved ? 'success' : 'error',
      message: saved ? t('settings.services.keySaved') : t('settings.services.keySaveFailed')
    })
    if (saved) setDraft('')
  }

  const test = (): void => {
    setTesting(true)
    // Demo happy path: the desktop would run the real verification.
    setTimeout(() => {
      setTesting(false)
      toast.show({
        tone: 'success',
        message: `${PROVIDER_LABELS[provider.id] ?? provider.id} — ${t('settings.model.testSuccess')}`
      })
    }, 900)
  }

  return (
    <Section className="gap-3">
      <View className="flex-row items-center gap-2.5">
        {Logo ? <Logo size={18} className="text-fg" /> : null}
        <Text className="text-fg font-sans-semibold flex-1 text-left text-sm">
          {PROVIDER_LABELS[provider.id] ?? provider.id}
        </Text>
        {provider.hasKey ? (
          <View className="flex-row items-center gap-1">
            <CheckmarkCircle02Icon size={14} className="text-emerald-600" />
            <Text className="font-sans text-xs text-emerald-600">{t('settings.model.keySet')}</Text>
          </View>
        ) : (
          <Text className="text-muted font-sans text-xs">{t('settings.model.noKey')}</Text>
        )}
      </View>
      {provider.model ? (
        <Text
          selectable
          numberOfLines={1}
          className="text-fg text-left font-mono text-xs"
          style={{ writingDirection: 'ltr' }}
        >
          {provider.model}{' '}
          <Text className="text-muted font-sans">
            · {t('settings.model.modelsCount', { count: provider.models.length })}
          </Text>
        </Text>
      ) : null}
      {/* The placeholder previews what is installed — never more than the
          mask already shows (first 12 characters), whichever mode minted the
          value — and the secure field masks what is being typed. */}
      <Input
        label={t('settings.model.apiKey')}
        value={draft}
        onChangeText={setDraft}
        placeholder={stored ? `${stored.slice(0, 12)}…` : t('settings.services.secretPlaceholder')}
        editable={!readOnly && !busy}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      {savable ? (
        <Button
          size="sm"
          onPress={() => void saveKey()}
          disabled={busy}
          className="self-start"
          accessibilityLabel={t('settings.services.saveKey')}
        >
          {t('settings.services.saveKey')}
        </Button>
      ) : null}
      {/* Demo only: the desktop is the side that can actually reach the
          provider, and it has no test RPC — a button that toasted success
          without testing would be the one lying control on the card. The
          label never swaps for a loading string, and nothing is inserted
          beside it — the disabled dim carries the busy state so the button
          keeps its size and its word mid-action. */}
      {!paired ? (
        <Button variant="outline" size="sm" disabled={testing} onPress={test}>
          {t('settings.model.testConnection')}
        </Button>
      ) : null}
    </Section>
  )
})

/**
 * Local — the engine card, headed like Providers below it (name outside, card
 * within) because it is the same kind of thing: the runtime the local models
 * run on. What it holds is the desktop's to know — whether Ollama answered at
 * snapshot time, which models it has pulled, the folder it scans — since this
 * device cannot reach that machine's localhost. Choosing among the installed
 * models is ours; pulling a new one, the endpoint, and the enabled switch are
 * not, and the Model picker above already says whether Ollama is answering.
 */
const LocalSection = memo(function LocalSection(): React.JSX.Element {
  const { t } = useTranslation()
  const running = useDemoConfig((state) => state.ollamaRunning)
  const models = useDemoConfig((state) => state.localModels)
  const model = useConfigValue('localModel')
  const folder = useConfigValue('ollamaModelsFolder')
  const Logo = PROVIDER_LOGOS.ollama
  const options = useMemo(() => models.map((name) => ({ value: name, label: name })), [models])
  return (
    <>
      <View className="flex-col gap-1.5">
        <Text className="text-fg font-sans-semibold text-left text-base">
          {t('settings.model.localTitle')}
        </Text>
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.model.localNote')}
        </Text>
      </View>
      <Section className="gap-3">
        {/* Dot and label read as one unit — the same pairing the Services panel
            uses for a link that is either up or down. */}
        <View className="flex-row items-center gap-2">
          {Logo ? <Logo size={16} className="text-fg" /> : null}
          <Text className="text-fg font-sans-medium flex-1 text-left text-sm">
            {PROVIDER_LABELS.ollama}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <StatusDot connected={running} />
            <Text
              className={cn(
                'font-sans text-xs',
                running ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted'
              )}
            >
              {running ? t('settings.model.ollamaRunning') : t('settings.model.ollamaNotRunning')}
            </Text>
          </View>
        </View>
        {/* Pick among what the desktop has pulled. With nothing pulled the
            picker would open on an empty sheet, so say so in its place. */}
        {options.length > 0 ? (
          <Select<string>
            label={t('settings.model.installedModel')}
            value={model}
            options={options}
            placeholder={t('settings.model.installedModelPlaceholder')}
            onChange={(next) => setConfigValue('localModel', next)}
            searchable={options.length > 8}
          />
        ) : (
          <Text className="text-muted text-left font-sans text-xs">
            {t('settings.model.noModelsInstalled')}
          </Text>
        )}
        <View className="flex-col gap-1.5">
          <Text className="text-muted font-sans-medium text-left text-sm">
            {t('settings.model.ollamaModelsFolder')}
          </Text>
          {/* The desktop's path box: a bordered mono capsule on the page
              ground, forced LTR because a filesystem path is not a sentence —
              under RTL its leading slash would jump to the wrong end. An
              empty key falls back to the folder the desktop actually scans
              when nothing is configured (defaultModelsFolder in ollama.ts). */}
          <View className="bg-bg border-border rounded-lg border px-3 py-2">
            <Text
              selectable
              className="text-muted text-left font-mono text-[11px] leading-4"
              style={{ writingDirection: 'ltr' }}
            >
              {folder || '~/.ollama/models'}
            </Text>
          </View>
        </View>
      </Section>
    </>
  )
})

export default function ModelScreen(): React.JSX.Element {
  // Desktop-owned values: pull the current ones when this screen opens.
  useFreshConfig()
  const { t } = useTranslation()
  const providers = useDemoConfig((state) => state.providers)

  return (
    <PanelScreen title={t('settings.tabs.model')} subtitle={t('settings.model.subtitle')}>
      <Section title={t('settings.model.behaviorTitle')}>
        <ModeAndThinkingControls />
      </Section>

      <Section title={t('settings.model.modelTitle')}>
        <ModelSwitch />
      </Section>

      <LocalSection />

      <View className="flex-col gap-1.5">
        <Text className="text-fg font-sans-semibold text-left text-base">
          {t('settings.model.providersTitle')}
        </Text>
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.model.desktopNote')}
        </Text>
      </View>
      {providers.map((provider) => (
        <ProviderCard key={provider.id} provider={provider} />
      ))}
    </PanelScreen>
  )
}
