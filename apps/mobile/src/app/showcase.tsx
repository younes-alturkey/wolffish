import { BuildInfo } from '@/components/common/build-info/BuildInfo'
import { LanguageToggle } from '@/components/common/language-toggle/LanguageToggle'
import { ThemeSelector } from '@/components/common/theme-selector/ThemeSelector'
import { Alert } from '@/components/core/Alert'
import { Button } from '@/components/core/Button'
import { GlobalIcon } from '@/components/core/icons'
import { Input } from '@/components/core/Input'
import { Select, type SelectOption } from '@/components/core/Select'
import { Textarea } from '@/components/core/Textarea'
import { useToast } from '@/providers/toast/useToast'
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

function Section({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <View className="bg-surface border-border flex-col gap-4 rounded-2xl border p-4">
      <Text className="text-fg font-sans-semibold text-left text-lg">{title}</Text>
      {children}
    </View>
  )
}

type Channel = 'telegram' | 'whatsapp' | 'extension' | 'inapp'
type Model = 'claude' | 'gpt' | 'gemini' | 'llama' | 'mistral' | 'qwen' | 'deepseek'

const MODEL_OPTIONS: readonly SelectOption<Model>[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'gpt', label: 'GPT' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'llama', label: 'Llama' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'qwen', label: 'Qwen' },
  { value: 'deepseek', label: 'DeepSeek' }
]

export default function Showcase(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const insets = useSafeAreaInsets()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [notes, setNotes] = useState('')
  const [channel, setChannel] = useState<Channel | ''>('')
  const [model, setModel] = useState<Model>('claude')
  const [longItem, setLongItem] = useState('item-1')
  const [dismissed, setDismissed] = useState(false)

  // 100 generated options to exercise the Select's virtualized list.
  const longOptions = useMemo<readonly SelectOption<string>[]>(
    () =>
      Array.from({ length: 100 }, (_, i) => ({
        value: `item-${i + 1}`,
        label: `${t('showcase.selects.item')} ${i + 1}`
      })),
    [t]
  )

  const channelOptions: readonly SelectOption<Channel>[] = [
    { value: 'inapp', label: t('app.name') },
    { value: 'telegram', label: 'Telegram' },
    { value: 'whatsapp', label: 'WhatsApp' },
    { value: 'extension', label: 'Extension', disabled: true }
  ]

  return (
    <ScrollView
      className="bg-bg flex-1"
      contentContainerStyle={{
        paddingTop: insets.top + 16,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: 16,
        gap: 16
      }}
    >
      <View className="flex-col gap-1">
        <Text className="text-fg font-sans-bold text-left text-3xl">{t('app.name')}</Text>
        <Text className="text-muted text-left font-sans text-base">{t('app.tagline')}</Text>
      </View>

      <Section title={t('settings.title')}>
        {/* Both are full-width switch tracks now, so they stack rather than
            share a row. */}
        <View className="flex-col gap-3">
          <ThemeSelector />
          <LanguageToggle label={t('locale.label')} />
        </View>
      </Section>

      <View className="flex-col gap-1">
        <Text className="text-fg font-sans-semibold text-left text-xl">{t('showcase.title')}</Text>
        <Text className="text-muted text-left font-sans text-sm">{t('showcase.subtitle')}</Text>
      </View>

      <Section title={t('showcase.buttons.title')}>
        <View className="flex-row flex-wrap items-center gap-2">
          <Button onPress={() => {}}>{t('showcase.buttons.primary')}</Button>
          <Button variant="ghost" onPress={() => {}}>
            {t('showcase.buttons.ghost')}
          </Button>
          <Button variant="outline" onPress={() => {}}>
            {t('showcase.buttons.outline')}
          </Button>
          <Button variant="danger" onPress={() => {}}>
            {t('showcase.buttons.danger')}
          </Button>
        </View>
        <View className="flex-row flex-wrap items-center gap-2">
          <Button size="sm" onPress={() => {}}>
            {t('showcase.buttons.small')}
          </Button>
          <Button size="md" onPress={() => {}}>
            {t('showcase.buttons.medium')}
          </Button>
          <Button size="lg" onPress={() => {}}>
            {t('showcase.buttons.large')}
          </Button>
        </View>
        <View className="flex-row flex-wrap items-center gap-2">
          <Button disabled onPress={() => {}}>
            {t('showcase.buttons.disabled')}
          </Button>
          <Button variant="outline" onPress={() => {}}>
            <GlobalIcon size={16} className="text-fg" />
            {t('showcase.buttons.withIcon')}
          </Button>
          {/* Loading looks exactly like disabled on purpose: a busy button
              keeps its label and dims — no spinner joins it, so it never
              changes size mid-action. */}
          <Button disabled onPress={() => {}}>
            {t('showcase.buttons.loadingState')}
          </Button>
        </View>
      </Section>

      <Section title={t('showcase.inputs.title')}>
        <Input
          label={t('showcase.inputs.name')}
          placeholder={t('showcase.inputs.namePlaceholder')}
          value={name}
          onChangeText={setName}
        />
        <Input
          label={t('showcase.inputs.email')}
          placeholder={t('showcase.inputs.emailPlaceholder')}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Input
          label={t('showcase.inputs.password')}
          placeholder={t('showcase.inputs.passwordPlaceholder')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />
        <Input
          label={t('showcase.inputs.disabled')}
          value={t('showcase.inputs.disabledValue')}
          editable={false}
        />
      </Section>

      <Section title={t('showcase.textarea.title')}>
        <Textarea
          label={t('showcase.textarea.notes')}
          placeholder={t('showcase.textarea.notesPlaceholder')}
          value={notes}
          onChangeText={setNotes}
        />
        <Textarea
          label={t('showcase.textarea.disabled')}
          value={t('showcase.inputs.disabledValue')}
          rows={2}
          editable={false}
        />
      </Section>

      <Section title={t('showcase.selects.title')}>
        <Select<Channel | ''>
          label={t('showcase.selects.channel')}
          placeholder={t('showcase.selects.channelPlaceholder')}
          value={channel}
          options={channelOptions}
          onChange={setChannel}
        />
        <Select<Model>
          label={t('showcase.selects.searchable')}
          value={model}
          options={MODEL_OPTIONS}
          onChange={setModel}
          searchable
          searchPlaceholder={t('showcase.selects.searchPlaceholder')}
        />
        <Select<string>
          label={t('showcase.selects.long')}
          value={longItem}
          options={longOptions}
          onChange={setLongItem}
          searchable
        />
        <Select<Model>
          label={t('showcase.selects.disabled')}
          value={model}
          options={MODEL_OPTIONS}
          onChange={setModel}
          disabled
        />
      </Section>

      <Section title={t('showcase.alerts.title')}>
        <Alert
          tone="info"
          title={t('showcase.alerts.infoTitle')}
          message={t('showcase.alerts.info')}
        />
        <Alert
          tone="success"
          title={t('showcase.alerts.successTitle')}
          message={t('showcase.alerts.success')}
        />
        <Alert
          tone="warning"
          title={t('showcase.alerts.warningTitle')}
          message={t('showcase.alerts.warning')}
        />
        <Alert
          tone="error"
          title={t('showcase.alerts.errorTitle')}
          message={t('showcase.alerts.error')}
        />
        {dismissed ? (
          <Button variant="outline" size="sm" onPress={() => setDismissed(false)}>
            {t('common.back')}
          </Button>
        ) : (
          <Alert
            tone="info"
            message={t('showcase.alerts.dismissible')}
            onDismiss={() => setDismissed(true)}
          />
        )}
      </Section>

      <Section title={t('showcase.toasts.title')}>
        <View className="flex-row flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onPress={() => toast.show({ message: t('showcase.toasts.infoMessage') })}
          >
            {t('showcase.toasts.info')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={() =>
              toast.show({ tone: 'success', message: t('showcase.toasts.successMessage') })
            }
          >
            {t('showcase.toasts.success')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={() =>
              toast.show({ tone: 'warning', message: t('showcase.toasts.warningMessage') })
            }
          >
            {t('showcase.toasts.warning')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={() =>
              toast.show({ tone: 'error', message: t('showcase.toasts.errorMessage') })
            }
          >
            {t('showcase.toasts.error')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={() =>
              toast.show({
                tone: 'warning',
                sticky: true,
                message: t('showcase.toasts.stickyMessage')
              })
            }
          >
            {t('showcase.toasts.sticky')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={() =>
              toast.show({ placement: 'top', message: t('showcase.toasts.topMessage') })
            }
          >
            {t('showcase.toasts.top')}
          </Button>
        </View>
      </Section>

      <BuildInfo />
    </ScrollView>
  )
}
