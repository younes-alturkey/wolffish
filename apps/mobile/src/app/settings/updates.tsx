import { Alert } from '@/components/core/Alert'
import { Button } from '@/components/core/Button'
import { ConfirmDialog } from '@/components/core/ConfirmDialog'
import { ComputerIcon, SmartPhone01Icon } from '@/components/core/icons'
import { ProgressBar } from '@/components/core/ProgressBar'
import { ConfigSwitchRow } from '@/components/settings/ConfigRows'
import {
  CodeChip,
  InfoRow,
  NavRow,
  PanelScreen,
  Section,
  SwitchRow
} from '@/components/settings/SettingsUI'
import { checkDesktopUpdate, installDesktopUpdate, useDesktopUpdater } from '@/lib/sync/updater'
import {
  checkForUpdateNow,
  updatesAvailable,
  type UpdateCheckOutcome
} from '@/lib/updates/useOtaUpdates'
import { formatRelativeTime } from '@/lib/utils/relativeTime'
import { useLocale } from '@/providers/locale/useLocale'
import { useToast } from '@/providers/toast/useToast'
import { useAppStore } from '@/state/appStore'
import { useDesktopInfo } from '@/state/demoConfig'
import Constants from 'expo-constants'
import { router } from 'expo-router'
import * as Updates from 'expo-updates'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/**
 * Both ends of a long id, with the gap marked. The fingerprint runtime is 40
 * hex characters — in full it is noise inside a one-line row, and cut to a
 * bare prefix it reads as the whole value, so two different runtimes can look
 * identical. Values already short enough are left alone.
 */
function shortId(value: string): string {
  return value.length > 9 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value
}

/**
 * Updates — two apps, kept apart on purpose.
 *
 * One card per app, each shaped the same way: what it is (version, and the
 * facts identifying exactly which bundle is running) above what you can change
 * about it. THIS app's card governs OTA delivery for real — device-local
 * appStore.otaEnabled, read by lib/updates/useOtaUpdates. The DESKTOP card's
 * switch is config the desktop owns and this device only mirrors. Those two
 * were one switch until they weren't: the toggle here used to write the
 * desktop's preference under a label about this phone.
 *
 * The desktop card also DRIVES that app's updater now — check, watch the
 * download, install-and-restart — through the same registered handlers a
 * click on the desktop or a CLI command invokes (see lib/sync/updater). The
 * check row is always on the card; the button only works while the live
 * mirror does — connected, to a desktop that serves it.
 */
export default function UpdatesScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const toast = useToast()
  const otaEnabled = useAppStore((state) => state.otaEnabled)
  const setOtaEnabled = useAppStore((state) => state.setOtaEnabled)
  const desktop = useDesktopInfo()
  const [checking, setChecking] = useState(false)

  const version = Constants.expoConfig?.version ?? '?'
  const build =
    Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode ?? '?'
  const channel = __DEV__
    ? 'dev'
    : !Updates.isEnabled || Updates.isEmbeddedLaunch || !Updates.updateId
      ? t('settings.updates.embedded')
      : t('settings.updates.ota')
  const updateId = Updates.updateId ? Updates.updateId.slice(0, 8) : '—'
  const runtime =
    typeof Updates.runtimeVersion === 'string' && Updates.runtimeVersion
      ? shortId(Updates.runtimeVersion)
      : '—'
  // Dates follow the app's language, not the device's regional calendar: a
  // bare toLocaleDateString() renders "13/02/1448 AH" for a phone set to Saudi
  // Arabia, inside an interface that is otherwise entirely in English.
  const publishedAt = Updates.createdAt ? Updates.createdAt.toLocaleDateString(locale) : '—'
  // How stale the mirror is, not when it was taken — "2h" answers the question
  // the row is actually asking, and a same-day sync reads as today's date.
  const syncedAtMs = desktop.syncedAt ? new Date(desktop.syncedAt).getTime() : Number.NaN
  const syncedAt = Number.isNaN(syncedAtMs) ? '—' : formatRelativeTime(syncedAtMs, t)

  const onCheck = useCallback(async () => {
    if (checking) return
    setChecking(true)
    const outcome: UpdateCheckOutcome = await checkForUpdateNow()
    setChecking(false)
    // A download announces itself: UpdateNotice watches the same pending state
    // and slides its card in over this screen. A toast here would say it twice.
    if (outcome === 'downloaded') return
    if (outcome === 'upToDate') {
      toast.show({ message: t('settings.updates.upToDate'), tone: 'success' })
    } else if (outcome === 'unavailable') {
      toast.show({ message: t('settings.updates.checkUnavailable'), tone: 'info' })
    } else {
      toast.show({ message: t('settings.updates.checkFailed'), tone: 'error' })
    }
  }, [checking, toast, t])

  return (
    <PanelScreen title={t('settings.tabs.updates')} subtitle={t('settings.updates.subtitle')}>
      <NavRow
        label={t('settings.changelog.title')}
        description={t('settings.changelog.subtitle')}
        onPress={() => router.push('/settings/changelog')}
      />

      <Section title={t('settings.updates.thisAppTitle')}>
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.updates.thisAppDescription')}
        </Text>
        <InfoRow
          icon={<SmartPhone01Icon size={15} className="text-muted" />}
          label={t('settings.updates.version')}
          value={`v${version} (${build})`}
          code
          mono
        />
        <InfoRow label={t('settings.updates.channel')} value={channel} code />
        <InfoRow label={t('settings.updates.runtime')} value={runtime} code mono />
        <InfoRow label={t('settings.updates.updateId')} value={updateId} code mono />
        <InfoRow label={t('settings.updates.publishedAt')} value={publishedAt} />
        <SwitchRow
          label={t('settings.updates.autoLabel')}
          description={t('settings.updates.autoDescription')}
          value={otaEnabled}
          onValueChange={setOtaEnabled}
        />
        <View className="flex-row items-center gap-3">
          <View className="flex-1 flex-col gap-0.5">
            <Text className="text-fg font-sans-medium text-left text-sm">
              {t('settings.updates.checkManual')}
            </Text>
            <Text className="text-muted text-left font-sans text-xs leading-5">
              {updatesAvailable()
                ? t('settings.updates.checkManualDescription')
                : t('settings.updates.checkUnavailable')}
            </Text>
          </View>
          <Button variant="outline" size="sm" disabled={checking} onPress={() => void onCheck()}>
            {t('settings.updates.check')}
          </Button>
        </View>
      </Section>

      <Section title={t('settings.updates.desktopTitle')}>
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.updates.desktopDescription')}
        </Text>
        <InfoRow
          icon={<ComputerIcon size={15} className="text-muted" />}
          label={t('settings.updates.version')}
          value={desktop.version ? `v${desktop.version}` : '—'}
          code
          mono
        />
        <InfoRow label={t('settings.updates.platform')} value={desktop.platform ?? '—'} code mono />
        <InfoRow label={t('settings.updates.syncedAt')} value={syncedAt} code />
        <ConfigSwitchRow
          field="updatesEnabled"
          label={t('settings.updates.desktopAutoLabel')}
          description={t('settings.updates.desktopAutoDescription')}
        />
        <DesktopUpdateControls />
      </Section>
    </PanelScreen>
  )
}

/** Error codes this build can name; anything else falls back to the wire's
 *  own message. The same exact-match rule the provider error cards follow. */
const UPDATE_ERROR_CODES = ['checksum', 'network', 'timeout', 'filesystem', 'unknown'] as const

/**
 * Check / download / install for the paired desktop's updater — this phone
 * driving the same phase machine the desktop's own Updates panel renders,
 * through the same registered handlers a click there or a CLI command
 * invokes. Phases arrive as pushes (seeded per connection), so what this row
 * shows is what the desktop is actually doing, whoever asked for it.
 *
 * PAIRED with no live mirror — disconnected, or a desktop too old to serve
 * the updater RPCs — keeps the check row but deadens its button: the phone
 * can ask nothing, and the disabled state says so without the card changing
 * shape on every drop. DEMO (unpaired) keeps the button live, like every
 * other working control on this card: the tour's desktop is a fiction this
 * device owns outright, and that fiction is always current, so a check
 * answers "up to date" without a wire to ask. The install flow stays
 * unreachable there — no phase ever moves — which is the truth too.
 *
 * Install is the one gated act: it restarts the desktop, so a dialog says so
 * before anything is sent. After "armed", the restart looks like any other
 * drop-and-reconnect — the tunnel re-forms on its own and the fresh snapshot
 * carries the new version into the card above.
 */
function DesktopUpdateControls(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const paired = useAppStore((store) => store.paired)
  const state = useDesktopUpdater((store) => store.state)
  const [checking, setChecking] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [installing, setInstalling] = useState(false)

  const onCheck = useCallback(async () => {
    if (checking) return
    // The demo desktop is this device's own fiction, and it is always
    // current — answer as the live check does when nothing newer exists.
    if (!paired) {
      toast.show({ message: t('settings.updates.upToDate'), tone: 'success' })
      return
    }
    setChecking(true)
    const result = await checkDesktopUpdate()
    setChecking(false)
    // 'found' needs no toast: the phase pushes flip this row into the
    // download view, which is the announcement.
    if (result.outcome === 'upToDate') {
      toast.show({ message: t('settings.updates.upToDate'), tone: 'success' })
    } else if (result.outcome !== 'found') {
      toast.show({ message: t('settings.updates.checkFailed'), tone: 'error' })
    }
  }, [checking, paired, toast, t])

  const onInstall = useCallback(async () => {
    // Close the dialog before the round trip so the toast that answers it
    // never paints behind a dismissing RN Modal.
    setConfirming(false)
    setInstalling(true)
    const result = await installDesktopUpdate()
    setInstalling(false)
    if (result === 'armed') {
      toast.show({ message: t('settings.updates.installStarted'), tone: 'success' })
    } else if (result === 'unknown') {
      // The answer may have died with the connection the restart closed —
      // an unknown outcome, never claimed as a failure.
      toast.show({ message: t('settings.updates.installUnknown'), tone: 'info' })
    } else if (result === 'refused') {
      toast.show({ message: t('settings.updates.installRefused'), tone: 'error' })
    }
  }, [toast, t])

  if (state?.phase === 'downloading' || state?.phase === 'verifying') {
    const verifying = state.phase === 'verifying'
    return (
      <View className="flex-col gap-2">
        <View className="flex-row items-center gap-3">
          <View className="flex-1 flex-col gap-0.5">
            <Text className="text-fg font-sans-medium text-left text-sm">
              {verifying
                ? t('settings.updates.verifyingTitle')
                : t('settings.updates.downloadingTitle')}
            </Text>
            <Text className="text-muted text-left font-sans text-xs leading-5">
              {verifying
                ? t('settings.updates.verifyingSubtitle')
                : `${t('settings.updates.downloadingSubtitle')}${state.percent > 0 ? ` ${state.percent}%` : ''}`}
            </Text>
          </View>
          {state.version ? <CodeChip mono value={`v${state.version}`} /> : null}
        </View>
        <ProgressBar value={verifying ? 1 : state.percent / 100} />
      </View>
    )
  }

  if (state?.phase === 'ready' || state?.phase === 'installing') {
    const busy = installing || state.phase === 'installing'
    return (
      <>
        <View className="flex-row items-center gap-3">
          <View className="flex-1 flex-col gap-1">
            <Text className="text-fg font-sans-medium text-left text-sm">
              {t('settings.updates.installReady')}
            </Text>
            <View className="flex-row items-center gap-2">
              {state.version ? <CodeChip mono value={`v${state.version}`} /> : null}
              <Text className="text-muted text-left font-sans text-xs">
                {t('settings.updates.updateAvailable')}
              </Text>
            </View>
          </View>
          <Button size="sm" disabled={busy} onPress={() => setConfirming(true)}>
            {t('settings.updates.install')}
          </Button>
        </View>
        <ConfirmDialog
          open={confirming}
          title={t('settings.updates.confirmTitle')}
          message={t('settings.updates.confirmMessage', { version: state.version ?? '?' })}
          confirmLabel={t('settings.updates.confirmAction')}
          cancelLabel={t('common.cancel')}
          onConfirm={() => void onInstall()}
          onCancel={() => setConfirming(false)}
        />
      </>
    )
  }

  if (state?.phase === 'error') {
    const code = state.error?.code ?? 'unknown'
    const known = (UPDATE_ERROR_CODES as readonly string[]).includes(code)
    return (
      <View className="flex-col gap-2">
        <Alert
          tone="error"
          title={t('settings.updates.errorTitle')}
          message={
            known
              ? t(`settings.updates.errors.${code}`)
              : state.error?.message || t('settings.updates.errors.unknown')
          }
        />
        <Button variant="outline" size="sm" disabled={checking} onPress={() => void onCheck()}>
          {t('settings.updates.retry')}
        </Button>
      </View>
    )
  }

  // idle / checking — the desktop-flavoured twin of the This-app check row.
  // Paired with nothing mirrored means there is no desktop to ask right now;
  // the demo's mirror is always empty and its button stays live on purpose.
  const unreachable = paired && !state
  const busy = checking || state?.phase === 'checking'
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 flex-col gap-0.5">
        <Text className="text-fg font-sans-medium text-left text-sm">
          {t('settings.updates.checkManual')}
        </Text>
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.updates.desktopCheckDescription')}
        </Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || unreachable}
        onPress={() => void onCheck()}
      >
        {t('settings.updates.check')}
      </Button>
    </View>
  )
}
