import { Button } from '@/components/core/Button'
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Download01Icon,
  SentIcon
} from '@/components/core/icons'
import { formatByteProgress, formatBytes } from '@/lib/files/fileKinds'
import {
  exportDiagnostics,
  onDiagnosticProgress,
  type DiagnosticPhase
} from '@/lib/sync/diagnostics'
import { DIAGNOSTIC_STEPS, type DiagnosticResult } from '@/lib/tunnel/protocol'
import { cn } from '@/lib/utils/cn'
import * as Sharing from 'expo-sharing'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, Modal, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * The Debug button's overlay — the desktop's DiagnosticExportOverlay, on a
 * phone. Same shape, same order, same words (one i18n bundle, ported key for
 * key): ringed status icon, started-at + live elapsed, the explanatory block,
 * the step bar, then the archive card with its bundle summary.
 *
 * BLOCKING, exactly as the desktop's is: no backdrop dismissal and no close
 * affordance while it runs. The only way out is Done, and Done only exists once
 * the archive is ready or the run has failed. The reason is the same on both —
 * the collector is a single-flight job on the desktop, and a screen that could
 * be swiped away mid-run would leave it running with nowhere to land.
 *
 * ONE PHASE MORE THAN THE DESKTOP, because the archive is written on the other
 * side of a relay: after the desktop's steps come the archive's bytes, on their
 * own bar. Then the share sheet opens by itself — the point of pressing this on
 * a phone is to send the file to someone — and the card keeps a Share button so
 * a dismissed sheet is not a lost archive.
 */

const TOTAL_STEPS = DIAGNOSTIC_STEPS.length

export function DiagnosticExportOverlay({
  conversationId,
  onClose
}: {
  conversationId: string
  onClose: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const insets = useSafeAreaInsets()
  const [phase, setPhase] = useState<DiagnosticPhase>({ kind: 'collecting', progress: null })
  const [result, setResult] = useState<DiagnosticResult | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  // Fired exactly once per mount. Without the guard React's development
  // double-invoke would start two collections over the same files — and the
  // desktop would rightly attach the second to the first, but the phone would
  // download the archive twice.
  const startedRef = useRef(false)

  // The desktop's ticks, while it collects. Attached before the run starts so
  // the first step is never the one that is missed.
  useEffect(
    () =>
      onDiagnosticProgress(conversationId, (progress) =>
        setPhase((current) =>
          current.kind === 'collecting' ? { kind: 'collecting', progress } : current
        )
      ),
    [conversationId]
  )

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    // No `cancelled` flag, deliberately — the same reasoning as the desktop's:
    // it would pair with the guard above to hang the overlay forever under
    // StrictMode's mount/cleanup/mount. Settling state after a real unmount is
    // a no-op in React 18+, so there is nothing to guard.
    void exportDiagnostics(conversationId, setPhase).then((done) => {
      setResult(done.result)
      setUri(done.uri)
      // The share sheet, unprompted: on a phone this button exists to hand the
      // archive to someone, and making that a second tap only adds a step to
      // the one path everybody takes. Dismissing it leaves the card's own
      // Share button, so nothing is lost by closing it.
      if (done.uri) void Sharing.shareAsync(done.uri).catch(() => undefined)
    })
  }, [conversationId])

  // Ticks only while running — a finished bundle shows its own duration.
  useEffect(() => {
    if (result) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [result])

  const share = useCallback(() => {
    if (uri) void Sharing.shareAsync(uri).catch(() => undefined)
  }, [uri])

  const running = result === null
  // Live while running; once finished it freezes on the run's OWN duration
  // (the desktop's measurement) rather than however long this screen stayed up.
  const elapsed = Math.max(0, Math.floor((running ? now - startedAt : result.durationMs) / 1000))
  const elapsedStr = `${Math.floor(elapsed / 60)}:${(elapsed % 60).toString().padStart(2, '0')}`
  const startedStr = new Date(startedAt).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit'
  })

  // Collecting fills the first 95% over the desktop's steps, exactly as the
  // desktop's bar does; the download owns the last stretch, against real bytes.
  const stepIndex = phase.kind === 'collecting' ? (phase.progress?.index ?? 0) : TOTAL_STEPS
  const pct = !running
    ? 100
    : phase.kind === 'downloading'
      ? phase.totalBytes > 0
        ? Math.min(100, Math.round((phase.receivedBytes / phase.totalBytes) * 100))
        : 0
      : Math.min(95, Math.round((stepIndex / (TOTAL_STEPS + 1)) * 100))

  const stepLabel =
    phase.kind === 'downloading'
      ? t('diagnostics.overlay.downloading')
      : phase.progress
        ? t(`diagnostics.steps.${phase.progress.step}`)
        : t('diagnostics.overlay.progress')
  const stepCount =
    phase.kind === 'downloading'
      ? // Zero reads as "0 KB", not as a blank: the first frame of the download
        // is a full round-trip long (the file's stat), and a counter that shows
        // only its total there looks like a stall in the numbers.
        formatByteProgress(phase.receivedBytes, phase.totalBytes)
      : `${stepIndex} / ${TOTAL_STEPS}`

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      // Android's hardware back, refused while collecting for the same reason
      // the backdrop is: the run owns the screen until it settles.
      onRequestClose={running ? () => undefined : onClose}
      accessibilityViewIsModal
    >
      {/* Opaque `bg-bg`, not a scrim — the desktop's choice, and what makes the
          blocking intent unambiguous rather than looking like a dialog. */}
      <View
        className="bg-bg flex-1"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 24,
            paddingVertical: 32,
            gap: 20
          }}
          showsVerticalScrollIndicator={false}
        >
          <View className="w-full max-w-md flex-col items-center gap-5">
            <View
              className={cn(
                'h-10 w-10 items-center justify-center rounded-full',
                running ? 'bg-amber-500/15' : result?.ok ? 'bg-emerald-500/15' : 'bg-red-500/15'
              )}
            >
              {running ? (
                <ActivityIndicator size="small" color="#f59e0b" />
              ) : result?.ok ? (
                <CheckmarkCircle02Icon size={20} className="text-emerald-500" />
              ) : (
                <Alert02Icon size={20} className="text-red-500" />
              )}
            </View>

            <View className="flex-col items-center gap-1.5">
              <Text className="text-fg font-sans-medium text-center text-sm">
                {running
                  ? t('diagnostics.overlay.title')
                  : result?.ok
                    ? t('diagnostics.overlay.doneTitle')
                    : t('diagnostics.overlay.failedTitle')}
              </Text>
              <View className="flex-row items-center gap-2">
                <Text className="text-muted font-sans text-xs">
                  {t('diagnostics.overlay.startedAt', { time: startedStr })}
                </Text>
                <Text className="text-border font-sans text-xs">·</Text>
                {/* duration is conventionally LTR even in RTL UIs */}
                <Text style={{ writingDirection: 'ltr' }} className="text-muted font-mono text-xs">
                  {elapsedStr}
                </Text>
              </View>
            </View>

            {running ? (
              <>
                <View className="bg-surface border-border w-full rounded-lg border px-3 py-2">
                  <Text className="text-muted text-left font-sans text-[11px] leading-relaxed">
                    {t('diagnostics.overlay.body')}
                  </Text>
                </View>

                <View className="border-border bg-surface w-full rounded-lg border px-3 py-2.5">
                  <View className="mb-1.5 flex-row items-center justify-between gap-2">
                    <Text
                      numberOfLines={1}
                      className="text-muted font-sans-medium min-w-0 flex-1 text-left text-[10px] uppercase"
                    >
                      {stepLabel}
                    </Text>
                    {/* pinned LTR so the count reads correctly in RTL */}
                    <Text
                      style={{ writingDirection: 'ltr' }}
                      className="text-muted shrink-0 font-sans text-[10px]"
                    >
                      {stepCount}
                    </Text>
                  </View>
                  <View className="bg-border h-1.5 w-full overflow-hidden rounded-full">
                    <View
                      className="h-full rounded-full bg-amber-500"
                      style={{ width: `${pct}%` }}
                    />
                  </View>
                  {phase.kind === 'collecting' && (phase.progress?.files ?? 0) > 0 && (
                    <Text className="text-muted mt-1.5 text-left font-sans text-[10px]">
                      {t('diagnostics.overlay.filesCollected', {
                        count: phase.progress?.files ?? 0
                      })}
                    </Text>
                  )}
                </View>

                <Text className="text-muted text-center font-sans text-[11px]">
                  {t('diagnostics.overlay.blocked')}
                </Text>
              </>
            ) : result?.ok ? (
              <>
                <View className="border-border bg-surface w-full rounded-lg border p-3">
                  <View className="flex-row items-start gap-3">
                    <View className="bg-primary-soft h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                      <Download01Icon size={16} className="text-primary" />
                    </View>
                    <View className="min-w-0 flex-1">
                      <Text
                        numberOfLines={1}
                        style={{ writingDirection: 'ltr' }}
                        className="text-fg font-sans-medium text-left text-xs"
                      >
                        {result.fileName}
                      </Text>
                      <Text
                        style={{ writingDirection: 'ltr' }}
                        className="text-muted mt-0.5 text-left font-sans text-[11px]"
                      >
                        {formatBytes(result.sizeBytes)} ·{' '}
                        {t('diagnostics.overlay.fileCount', { count: result.fileCount })}
                      </Text>
                    </View>
                  </View>
                  <View className="mt-3">
                    {uri ? (
                      <Button variant="outline" size="sm" onPress={share} className="w-full">
                        <SentIcon size={13} className="text-fg" />
                        {t('diagnostics.overlay.share')}
                      </Button>
                    ) : (
                      // The bundle exists — on the desktop, where it can still
                      // be found — and only the transfer failed. Saying which
                      // is the difference between "try again" and "it's gone".
                      <Text className="text-muted text-left font-sans text-[11px] leading-relaxed">
                        {t('diagnostics.overlay.downloadFailed', {
                          path: result.relativePath
                        })}
                      </Text>
                    )}
                  </View>
                </View>

                <View className="border-border bg-surface w-full rounded-lg border px-3 py-2.5">
                  <Text className="text-muted font-sans-medium mb-1.5 text-left text-[10px] uppercase">
                    {t('diagnostics.overlay.summary')}
                  </Text>
                  <View className="flex-col gap-1">
                    {result.groups
                      .filter((group) => group.count > 0)
                      .map((group) => (
                        <View
                          key={group.key}
                          className="flex-row items-center justify-between gap-2"
                        >
                          <Text
                            numberOfLines={1}
                            className="text-muted min-w-0 flex-1 text-left font-sans text-[11px]"
                          >
                            {t(`diagnostics.groups.${group.key}`)}
                          </Text>
                          <Text
                            style={{ writingDirection: 'ltr' }}
                            className="text-muted shrink-0 font-sans text-[11px]"
                          >
                            {group.count}
                          </Text>
                        </View>
                      ))}
                    <View className="flex-row items-center justify-between gap-2">
                      <Text className="text-muted min-w-0 flex-1 text-left font-sans text-[11px]">
                        {t('diagnostics.groups.opinion')}
                      </Text>
                      <Text
                        numberOfLines={1}
                        className="text-muted shrink-0 text-right font-sans text-[11px]"
                      >
                        {result.modelOpinion
                          ? t('diagnostics.overlay.opinionIncluded')
                          : t(
                              `diagnostics.overlay.opinionSkipped.${result.opinionSkipped ?? 'failed'}`
                            )}
                      </Text>
                    </View>
                  </View>
                  {result.warnings.length > 0 && (
                    <View className="border-border mt-2 flex-col gap-1 border-t pt-2">
                      {result.warnings.map((warning) => (
                        <Text key={warning} className="text-muted text-left font-sans text-[10px]">
                          {warning}
                        </Text>
                      ))}
                    </View>
                  )}
                </View>

                <Text className="text-muted text-center font-sans text-[11px] leading-relaxed">
                  {t('diagnostics.overlay.forward')}
                </Text>
              </>
            ) : (
              <>
                <View className="bg-surface border-border w-full rounded-lg border px-3 py-2">
                  <Text className="text-muted text-left font-sans text-[11px] leading-relaxed">
                    {result?.error || t('diagnostics.overlay.failedBody')}
                  </Text>
                </View>
                <Text className="text-muted text-center font-sans text-[11px]">
                  {t('diagnostics.overlay.failedHint')}
                </Text>
              </>
            )}

            {/* The ONLY way out, and it only exists once the run has settled. */}
            {!running && (
              <Button onPress={onClose} className="w-full">
                {t('diagnostics.overlay.done')}
              </Button>
            )}
          </View>
        </ScrollView>
      </View>
    </Modal>
  )
}
