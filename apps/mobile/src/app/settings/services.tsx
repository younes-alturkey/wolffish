import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { Button } from '@/components/core/Button'
import { Input } from '@/components/core/Input'
import type { SelectOption } from '@/components/core/Select'
import { SERVICE_LOGOS } from '@/components/core/providerLogos'
import { ConfigSelectRow, ConfigSwitchRow } from '@/components/settings/ConfigRows'
import { PanelScreen, Section, StatusDot } from '@/components/settings/SettingsUI'
import { useToast } from '@/providers/toast/useToast'
import { cn } from '@/lib/utils/cn'
import {
  saveDesktopSetting,
  useConfigValue,
  useDemoConfig,
  useSettingsReadOnly,
  type DemoConfigValues
} from '@/state/demoConfig'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/**
 * Services — every desktop service panel, with the full config.json surface
 * each one owns: Brave, Video, Memes, STT, TTS and Computer Use are edited
 * here; Google / GitHub / Notion stay read-only because the action behind
 * them is an OAuth flow or a token the desktop keychain holds. Every editable
 * row binds to a single flat config key.
 *
 * The browser extension is NOT one of them. A browser Wolffish drives is a
 * place it works on your behalf rather than a connection it borrows, which is
 * why the desktop keeps that panel under Channels › Browser — and so does
 * this app, next to the terminal and the bridges.
 */

/** Kokoro's English voice catalog, verbatim from the desktop TTS panel. */
const VOICES: Array<{ id: string; label: string; lang: 'us' | 'uk' }> = [
  { id: 'af_bella', label: 'Bella', lang: 'us' },
  { id: 'af_heart', label: 'Heart', lang: 'us' },
  { id: 'af_nicole', label: 'Nicole', lang: 'us' },
  { id: 'af_sarah', label: 'Sarah', lang: 'us' },
  { id: 'af_aoede', label: 'Aoede', lang: 'us' },
  { id: 'af_kore', label: 'Kore', lang: 'us' },
  { id: 'af_nova', label: 'Nova', lang: 'us' },
  { id: 'af_sky', label: 'Sky', lang: 'us' },
  { id: 'am_adam', label: 'Adam', lang: 'us' },
  { id: 'am_michael', label: 'Michael', lang: 'us' },
  { id: 'am_eric', label: 'Eric', lang: 'us' },
  { id: 'am_liam', label: 'Liam', lang: 'us' },
  { id: 'am_onyx', label: 'Onyx', lang: 'us' },
  { id: 'am_puck', label: 'Puck', lang: 'us' },
  { id: 'bf_emma', label: 'Emma', lang: 'uk' },
  { id: 'bf_isabella', label: 'Isabella', lang: 'uk' },
  { id: 'bf_alice', label: 'Alice', lang: 'uk' },
  { id: 'bf_lily', label: 'Lily', lang: 'uk' },
  { id: 'bm_george', label: 'George', lang: 'uk' },
  { id: 'bm_lewis', label: 'Lewis', lang: 'uk' },
  { id: 'bm_daniel', label: 'Daniel', lang: 'uk' },
  { id: 'bm_fable', label: 'Fable', lang: 'uk' }
]

/** Whisper's transcription languages — the desktop catalog (wolffish-app
 *  pages/settings/whisperLanguages.ts) verbatim; 'auto' is prepended with a
 *  localized label where the options are built. */
const STT_LANGUAGES: readonly SelectOption<string>[] = [
  { value: 'af', label: 'Afrikaans' },
  { value: 'sq', label: 'Albanian' },
  { value: 'am', label: 'Amharic' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hy', label: 'Armenian' },
  { value: 'as', label: 'Assamese' },
  { value: 'az', label: 'Azerbaijani' },
  { value: 'ba', label: 'Bashkir' },
  { value: 'eu', label: 'Basque' },
  { value: 'be', label: 'Belarusian' },
  { value: 'bn', label: 'Bengali' },
  { value: 'bs', label: 'Bosnian' },
  { value: 'br', label: 'Breton' },
  { value: 'bg', label: 'Bulgarian' },
  { value: 'yue', label: 'Cantonese' },
  { value: 'ca', label: 'Catalan' },
  { value: 'zh', label: 'Chinese' },
  { value: 'hr', label: 'Croatian' },
  { value: 'cs', label: 'Czech' },
  { value: 'da', label: 'Danish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'en', label: 'English' },
  { value: 'et', label: 'Estonian' },
  { value: 'fo', label: 'Faroese' },
  { value: 'fi', label: 'Finnish' },
  { value: 'fr', label: 'French' },
  { value: 'gl', label: 'Galician' },
  { value: 'ka', label: 'Georgian' },
  { value: 'de', label: 'German' },
  { value: 'el', label: 'Greek' },
  { value: 'gu', label: 'Gujarati' },
  { value: 'ht', label: 'Haitian Creole' },
  { value: 'ha', label: 'Hausa' },
  { value: 'haw', label: 'Hawaiian' },
  { value: 'he', label: 'Hebrew' },
  { value: 'hi', label: 'Hindi' },
  { value: 'hu', label: 'Hungarian' },
  { value: 'is', label: 'Icelandic' },
  { value: 'id', label: 'Indonesian' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'jw', label: 'Javanese' },
  { value: 'kn', label: 'Kannada' },
  { value: 'kk', label: 'Kazakh' },
  { value: 'km', label: 'Khmer' },
  { value: 'ko', label: 'Korean' },
  { value: 'lo', label: 'Lao' },
  { value: 'la', label: 'Latin' },
  { value: 'lv', label: 'Latvian' },
  { value: 'ln', label: 'Lingala' },
  { value: 'lt', label: 'Lithuanian' },
  { value: 'lb', label: 'Luxembourgish' },
  { value: 'mk', label: 'Macedonian' },
  { value: 'mg', label: 'Malagasy' },
  { value: 'ms', label: 'Malay' },
  { value: 'ml', label: 'Malayalam' },
  { value: 'mt', label: 'Maltese' },
  { value: 'mi', label: 'Maori' },
  { value: 'mr', label: 'Marathi' },
  { value: 'mn', label: 'Mongolian' },
  { value: 'my', label: 'Myanmar' },
  { value: 'ne', label: 'Nepali' },
  { value: 'no', label: 'Norwegian' },
  { value: 'nn', label: 'Norwegian Nynorsk' },
  { value: 'oc', label: 'Occitan' },
  { value: 'ps', label: 'Pashto' },
  { value: 'fa', label: 'Persian' },
  { value: 'pl', label: 'Polish' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'pa', label: 'Punjabi' },
  { value: 'ro', label: 'Romanian' },
  { value: 'ru', label: 'Russian' },
  { value: 'sa', label: 'Sanskrit' },
  { value: 'sr', label: 'Serbian' },
  { value: 'sn', label: 'Shona' },
  { value: 'sd', label: 'Sindhi' },
  { value: 'si', label: 'Sinhala' },
  { value: 'sk', label: 'Slovak' },
  { value: 'sl', label: 'Slovenian' },
  { value: 'so', label: 'Somali' },
  { value: 'es', label: 'Spanish' },
  { value: 'su', label: 'Sundanese' },
  { value: 'sw', label: 'Swahili' },
  { value: 'sv', label: 'Swedish' },
  { value: 'tl', label: 'Tagalog' },
  { value: 'tg', label: 'Tajik' },
  { value: 'ta', label: 'Tamil' },
  { value: 'tt', label: 'Tatar' },
  { value: 'te', label: 'Telugu' },
  { value: 'th', label: 'Thai' },
  { value: 'bo', label: 'Tibetan' },
  { value: 'tr', label: 'Turkish' },
  { value: 'tk', label: 'Turkmen' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'ur', label: 'Urdu' },
  { value: 'uz', label: 'Uzbek' },
  { value: 'vi', label: 'Vietnamese' },
  { value: 'cy', label: 'Welsh' },
  { value: 'yi', label: 'Yiddish' },
  { value: 'yo', label: 'Yoruba' }
]

/** Whisper sizes the desktop offers, plus the turbo build the workspace runs. */
const STT_MODELS = ['tiny', 'base', 'small', 'medium', 'large', 'large-v3-turbo']

/**
 * Section header: the service's brand mark and name on the leading edge, and
 * — for the services that have a link to be up or down — the connection state
 * on the trailing edge, dot and label together, in the tone that state
 * deserves.
 */
function ServiceHeader({
  serviceKey,
  connected
}: {
  serviceKey: string
  connected?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const Logo = SERVICE_LOGOS[serviceKey]
  return (
    <View className="flex-row items-center gap-2">
      {Logo ? <Logo size={16} className="text-fg" /> : null}
      <Text className="text-fg font-sans-semibold flex-1 text-left text-sm">
        {t(`settings.services.items.${serviceKey}`)}
      </Text>
      {/* Dot and label read as one unit — the dot is the label's bullet, so
          it sits with the state, not with the service's identity. */}
      {connected === undefined ? null : (
        <View className="flex-row items-center gap-1.5">
          <StatusDot connected={connected} />
          <Text
            className={cn(
              'font-sans text-xs',
              connected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted'
            )}
          >
            {connected ? t('settings.services.connected') : t('settings.services.notConnected')}
          </Text>
        </View>
      )}
    </View>
  )
}

/** The credential keys the phone edits — each row binds to exactly one. */
type SecretField = Extract<
  keyof DemoConfigValues,
  'braveApiKey' | 'videoApiKey' | 'imgflipUsername' | 'imgflipPassword' | 'giphyApiKey'
>

/**
 * A credential field, bound and editable: the value is the desktop's own
 * (synced in the snapshot), and Save writes it back through Rpc.configSet —
 * the same setter the desktop's panel calls — with the same saved/failed
 * confirmation that panel shows. The draft lives locally until saved, so a
 * snapshot refresh mid-typing cannot yank the text out from under the user.
 */
function SecretRow({
  field,
  label,
  secure = true
}: {
  field: SecretField
  label: string
  secure?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const readOnly = useSettingsReadOnly()
  const stored = useConfigValue(field)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dirty = draft !== null && draft !== stored

  const save = async (): Promise<void> => {
    if (!dirty || draft === null || busy) return
    setBusy(true)
    const saved = await saveDesktopSetting(field, draft)
    setBusy(false)
    toast.show({
      tone: saved ? 'success' : 'error',
      message: saved ? t('settings.services.keySaved') : t('settings.services.keySaveFailed')
    })
    if (saved) setDraft(null)
  }

  return (
    <View className="flex-col gap-1.5">
      <Input
        label={label}
        value={draft ?? stored}
        onChangeText={setDraft}
        placeholder={t('settings.services.secretPlaceholder')}
        editable={!readOnly && !busy}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {dirty ? (
        <Button
          size="sm"
          onPress={() => void save()}
          disabled={busy}
          className="self-start"
          accessibilityLabel={t('settings.services.saveKey')}
        >
          {t('settings.services.saveKey')}
        </Button>
      ) : null}
    </View>
  )
}

function DesktopNote(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Text className="text-muted text-left font-sans text-xs leading-5">
      {t('settings.services.desktopOnly')}
    </Text>
  )
}

export default function ServicesScreen(): React.JSX.Element {
  // Desktop-owned values: pull the current ones when this screen opens.
  useFreshConfig()
  const { t } = useTranslation()
  const services = useDemoConfig((state) => state.services)
  const byKey = new Map(services.map((service) => [service.key, service]))

  const voiceOptions = useMemo<readonly SelectOption<string>[]>(
    () =>
      VOICES.map((voice) => ({
        value: voice.id,
        label: `${voice.label} · ${t(`settings.services.voiceLang.${voice.lang}`)}`
      })),
    [t]
  )
  const sttOptions = useMemo<readonly SelectOption<string>[]>(
    () => STT_MODELS.map((value) => ({ value, label: value })),
    []
  )
  const sttLanguageOptions = useMemo<readonly SelectOption<string>[]>(
    () => [{ value: 'auto', label: t('settings.services.sttLanguageAuto') }, ...STT_LANGUAGES],
    [t]
  )
  const speedOptions = useMemo<readonly SelectOption<string>[]>(
    () => [
      { value: '0.75', label: t('settings.services.speed.slow') },
      { value: '1.0', label: t('settings.services.speed.normal') },
      { value: '1.25', label: t('settings.services.speed.fast') },
      { value: '1.5', label: t('settings.services.speed.veryFast') }
    ],
    [t]
  )

  const connectionRows = (key: string): React.JSX.Element[] =>
    (byKey.get(key)?.connections ?? []).map((connection, index) => (
      <View key={index} className="flex-row items-center justify-between gap-3">
        <Text className="text-fg text-left font-sans text-sm">{connection.label}</Text>
        <Text numberOfLines={1} className="text-muted flex-shrink text-left font-sans text-xs">
          {connection.detail}
        </Text>
      </View>
    ))

  return (
    <PanelScreen title={t('settings.tabs.services')} subtitle={t('settings.services.subtitle')}>
      {/* Account links — the connect/OAuth/token half stays desktop-bound. */}
      {['google', 'github', 'notion'].map((key) => (
        <Section key={key}>
          <ServiceHeader serviceKey={key} connected={byKey.get(key)?.connected ?? false} />
          {connectionRows(key)}
          <DesktopNote />
        </Section>
      ))}

      <Section>
        <ServiceHeader serviceKey="brave" />
        <ConfigSwitchRow
          field="braveEnabled"
          label={t('settings.channels.enabled')}
          description={t('settings.services.brave.description')}
        />
        <SecretRow field="braveApiKey" label={t('settings.services.brave.apiKey')} />
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.services.secretNote')}
        </Text>
      </Section>

      {/* Video generation (MiniMax H3). Its own key on purpose — the desktop
          keeps it independent of the MiniMax chat provider so switching
          brains never silently kills video generation. */}
      <Section>
        <ServiceHeader serviceKey="video" />
        <ConfigSwitchRow
          field="videoEnabled"
          label={t('settings.channels.enabled')}
          description={t('settings.services.video.description')}
        />
        <ConfigSwitchRow
          field="videoDirector"
          label={t('settings.services.video.director')}
          description={t('settings.services.video.directorDescription')}
        />
        <SecretRow field="videoApiKey" label={t('settings.services.video.apiKey')} />
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.services.video.separateKeyNote')}
        </Text>
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.services.secretNote')}
        </Text>
      </Section>

      <Section>
        <ServiceHeader serviceKey="memes" />
        <ConfigSwitchRow
          field="memesEnabled"
          label={t('settings.channels.enabled')}
          description={t('settings.services.memes.description')}
        />
        <SecretRow
          field="imgflipUsername"
          label={t('settings.services.memes.imgflipUsername')}
          secure={false}
        />
        <SecretRow field="imgflipPassword" label={t('settings.services.memes.imgflipPassword')} />
        <SecretRow field="giphyApiKey" label={t('settings.services.memes.giphyKey')} />
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.services.secretNote')}
        </Text>
      </Section>

      <Section>
        <ServiceHeader serviceKey="stt" />
        <ConfigSelectRow
          field="sttModel"
          label={t('settings.services.sttModel')}
          options={sttOptions}
        />
        <ConfigSelectRow
          field="sttLanguage"
          label={t('settings.services.sttLanguage')}
          options={sttLanguageOptions}
          searchable
        />
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.services.stt.hint')}
        </Text>
      </Section>

      <Section>
        <ServiceHeader serviceKey="tts" />
        <ConfigSelectRow
          field="ttsVoice"
          label={t('settings.services.ttsVoice')}
          options={voiceOptions}
          searchable
        />
        <ConfigSelectRow
          field="ttsSpeed"
          label={t('settings.services.ttsSpeed')}
          options={speedOptions}
        />
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.services.tts.hint')}
        </Text>
      </Section>

      <Section>
        <ServiceHeader
          serviceKey="computerUse"
          connected={byKey.get('computerUse')?.connected ?? false}
        />
        {connectionRows('computerUse')}
        {/* Screenshot width and format used to live here. They are the
            agent's to pick per capture now (max_width / format on
            computer_screenshot), so there is no key on this or any device
            to edit. */}
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.services.computerUse.agentControlled')}
        </Text>
      </Section>
    </PanelScreen>
  )
}
