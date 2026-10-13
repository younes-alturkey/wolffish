import { Button } from '@/components/core/Button'
import { Input } from '@/components/core/Input'
import { Modal as Dialog } from '@/components/core/Modal'
import {
  Globe02Icon,
  Key01Icon,
  KeyboardIcon,
  QrCode01Icon,
  SquareLock02Icon
} from '@/components/core/icons'
import {
  autoDashPairingCode,
  formatPairingCode,
  pairingCodeIssue,
  normalizeRelayUrl,
  tunnelClient
} from '@/lib/tunnel/client'
import { DEFAULT_RELAY_URL } from '@/lib/tunnel/protocol'
import { useTokens } from '@/providers/theme/useTheme'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

const RELAY_REPO_URL = 'https://github.com/younes-alturkey/wolffish/tree/main/packages/relay'

// Base direction for URL values inside an RTL layout.
const LTR = { writingDirection: 'ltr' } as const

/**
 * The pairing sheet — one screen, two routes to the same tunnel: type the
 * code the desktop shows, or point the camera at its QR.
 *
 * Scanning is preferred because the secret travels screen-to-camera and
 * never crosses a network or a clipboard. The typed code covers the cases
 * scanning cannot: a desktop reached over SSH, a headless machine, a denied
 * camera permission. Both routes end in the same place — a tunnel with both
 * keys pinned.
 *
 * The relay is a card, not a hidden option: the code route dials whatever
 * the card says (the QR names its own relay), and changing it confirms
 * through the same dialog the desktop uses.
 */
export function PairSheet({
  visible,
  onClose,
  onPaired
}: {
  visible: boolean
  onClose: () => void
  onPaired: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tokens = useTokens()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const [code, setCode] = useState('')
  // The relay the code route dials. `applied` is what pairing uses, `draft`
  // tracks the input, and `pending` is what the confirm dialog will apply.
  const [relayApplied, setRelayApplied] = useState(DEFAULT_RELAY_URL)
  const [relayDraft, setRelayDraft] = useState(DEFAULT_RELAY_URL)
  const [pendingRelay, setPendingRelay] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Errors render inline, not as toasts: this sheet is a native Modal, and on
  // iOS the app's toast viewport is a sibling *below* that window — a toast
  // raised from here is painted behind the sheet and never seen.
  const [pairError, setPairError] = useState<string | null>(null)
  const [relayError, setRelayError] = useState<string | null>(null)
  // A camera reports the same QR many times a second; one accepted scan must
  // not start several pairings.
  const [claimed, setClaimed] = useState(false)
  // A ref, not state: the in-flight attempt reads this after awaiting, where a
  // state value captured at call time would still say "not cancelled".
  const cancelled = useRef(false)

  const reset = (): void => {
    setClaimed(false)
    setBusy(false)
    setCode('')
    setRelayApplied(DEFAULT_RELAY_URL)
    setRelayDraft(DEFAULT_RELAY_URL)
    setPendingRelay(null)
    setPairError(null)
    setRelayError(null)
  }

  const finish = async (run: () => Promise<void>): Promise<void> => {
    cancelled.current = false
    setBusy(true)
    setPairError(null)
    try {
      await run()
      // Losing the race with a cancel means the keys were already dropped —
      // finishing here would hand back a pairing the user just abandoned.
      if (cancelled.current) return
      reset()
      onPaired()
    } catch (error) {
      // Tearing the socket down to cancel surfaces as a failure here. It is
      // not one, and the user is already looking at a field they can retype.
      if (cancelled.current) return
      setClaimed(false)
      setBusy(false)
      setPairError(error instanceof Error ? error.message : t('pair.failed'))
    }
  }

  /**
   * Abandon an attempt in flight. Drops the socket and the half-written
   * pairing so the next try starts clean, and deliberately keeps the typed
   * code — the usual reason to cancel is a stale code worth editing, not
   * retyping from scratch.
   */
  const cancelPairing = (): void => {
    cancelled.current = true
    setClaimed(false)
    setBusy(false)
    setPairError(null)
    void tunnelClient.disconnect()
  }

  const onScanned = (value: string): void => {
    if (claimed || busy) return
    setClaimed(true)
    void finish(() => tunnelClient.pairWithQr(value))
  }

  const submitCode = (): void => {
    if (busy) return
    // Tidy here as well as on blur: a field can be submitted straight from the
    // keyboard without ever losing focus, and this is the moment the canonical
    // form matters. Cosmetic either way — pairWithCode takes any spelling.
    const tidied = formatPairingCode(code)
    if (tidied !== code) setCode(tidied)
    // The keyboard's Go key reaches here even when the button is disabled, so
    // this validates rather than assuming.
    const issue = pairingCodeIssue(tidied)
    if (issue !== null) {
      if (issue !== 'empty') setPairError(t(`pair.codeIssue.${issue}`))
      return
    }
    void finish(() => tunnelClient.pairWithCode(tidied, relayApplied))
  }

  // Validates the draft and opens the confirm dialog; an unchanged value just
  // tidies the input back to canonical form.
  const askRelayChange = (): void => {
    let target: string
    try {
      target = normalizeRelayUrl(relayDraft) ?? DEFAULT_RELAY_URL
    } catch {
      setRelayError(t('pair.relayInvalid'))
      return
    }
    setRelayError(null)
    if (target === relayApplied) {
      setRelayDraft(target)
      return
    }
    setPendingRelay(target)
  }

  const confirmRelay = (): void => {
    if (pendingRelay === null) return
    setRelayApplied(pendingRelay)
    setRelayDraft(pendingRelay)
    setPendingRelay(null)
  }

  const relayDraftChanged = relayDraft.trim() !== relayApplied
  const cameraReady = permission?.granted === true

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View
        className="bg-bg flex-1"
        style={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }}
      >
        <View className="flex-row items-center justify-between px-6">
          <Text className="text-fg font-sans-bold text-lg">{t('pair.title')}</Text>
          <Pressable onPress={onClose} disabled={busy} className="px-2 py-1">
            <Text className="text-muted font-sans text-sm">{t('common.close')}</Text>
          </Pressable>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 8 }}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
        >
          <Text className="text-muted mt-2 text-left font-sans text-sm leading-relaxed">
            {t('pair.instructions')}
          </Text>

          {/* What actually happens — the same three facts the desktop's
              "How it works" card states, so both devices tell one story. */}
          <View className="bg-surface border-border mt-4 gap-3 rounded-2xl border p-4">
            <Text className="text-fg text-left font-sans-medium text-sm">
              {t('pair.how.title')}
            </Text>
            <HowRow
              icon={<Key01Icon size={16} className="text-muted" />}
              title={t('pair.how.pairTitle')}
              body={t('pair.how.pairBody')}
            />
            <HowRow
              icon={<SquareLock02Icon size={16} className="text-muted" />}
              title={t('pair.how.e2eTitle')}
              body={t('pair.how.e2eBody')}
            />
            <HowRow
              icon={<Globe02Icon size={16} className="text-muted" />}
              title={t('pair.how.relayTitle')}
              body={t('pair.how.relayBody')}
            />
          </View>

          {/* The two routes, one card each — the desktop panel's icon +
              title + description rows, split into cards for a phone. The QR
              leads: it carries the relay and the desktop's key, so it is one
              tap where the code is a transcription. */}
          <View className="bg-surface border-border mt-4 gap-4 rounded-2xl border p-4">
            <CardHeader
              icon={<QrCode01Icon size={18} className="text-muted" />}
              title={t('pair.qrTitle')}
              body={t('pair.qrDesc')}
            />
            {cameraReady ? (
              <View className="border-border aspect-square overflow-hidden rounded-xl border">
                <CameraView
                  style={{ flex: 1 }}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={({ data }) => onScanned(data)}
                />
                {/* A QR leaves the frame the instant it is read, so without
                    this the preview just keeps scanning and nothing says the
                    code landed. Covers the viewfinder the moment one is
                    accepted, and stays until the attempt resolves. */}
                {claimed && (
                  <View className="absolute inset-0 items-center justify-center gap-3 bg-black/60">
                    <ActivityIndicator size="large" color="#ffffff" />
                    <Text className="font-sans-medium text-center text-sm text-white">
                      {t('pair.qrFound')}
                    </Text>
                  </View>
                )}
              </View>
            ) : (
              <View className="gap-3">
                {/* Only the denied case needs prose — it names a fix the
                    button can't perform. Otherwise the header line above
                    already says what the button is for. */}
                {permission?.canAskAgain === false ? (
                  <Text className="text-muted text-left font-sans text-xs leading-relaxed">
                    {t('pair.cameraDenied')}
                  </Text>
                ) : (
                  <Button
                    // Inline style so the base self-start can never win the
                    // cascade — this one button fills the row, centered text.
                    style={{ alignSelf: 'stretch' }}
                    disabled={busy}
                    onPress={() => void requestPermission()}
                  >
                    {t('pair.allowCamera')}
                  </Button>
                )}
              </View>
            )}
          </View>

          <View className="bg-surface border-border mt-4 gap-3 rounded-2xl border p-4">
            <CardHeader
              icon={<KeyboardIcon size={18} className="text-muted" />}
              title={t('pair.codeTitle')}
              body={t('pair.codeDesc')}
            />
            {/* items-end so the button lines up with the field rather than
                stretching to the label's height. */}
            <View className="flex-row items-end gap-2">
              <Input
                label={t('pair.codeLabel')}
                containerClassName="flex-1"
                value={code}
                // Typed text is left exactly as typed — no live reformatting.
                // The dash and upper case are applied once, on the way out.
                onChangeText={(next) => {
                  setCode(autoDashPairingCode(next, code))
                  setPairError(null)
                }}
                onBlur={() => setCode((current) => formatPairingCode(current))}
                placeholder="K7M9-2QXR"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect={false}
                editable={!busy}
                onSubmitEditing={submitCode}
                returnKeyType="go"
              />
              {/* Connecting turns the button into the way out of it: red,
                  still spinning, and pressable. An attempt that cannot be
                  abandoned strands anyone who mistyped a code or watched one
                  expire. Raw Pressable for the filled red — the same styling
                  the Data screen's destructive confirm uses. */}
              {busy ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={cancelPairing}
                  style={{ alignSelf: 'flex-end' }}
                  className="h-10 flex-row items-center justify-center gap-2 rounded-lg bg-red-600 px-4 active:bg-red-700"
                >
                  <ActivityIndicator size="small" color="#ffffff" />
                  <Text className="font-sans-medium text-sm text-white">{t('common.cancel')}</Text>
                </Pressable>
              ) : (
                <Button
                  // Inline: the Button base sets self-start, which beats the
                  // row's items-end and floats it above the field.
                  style={{ alignSelf: 'flex-end' }}
                  onPress={submitCode}
                  disabled={pairingCodeIssue(code) !== null}
                >
                  {t('pair.submit')}
                </Button>
              )}
            </View>
            {pairError !== null && (
              <Text className="text-left font-sans text-xs leading-relaxed text-rose-500">
                {pairError}
              </Text>
            )}
          </View>

          {/* The relay closes: only the code route needs it (the QR carries
              its own), and the default is right for everyone else. */}
          <View className="bg-surface border-border mt-4 gap-3 rounded-2xl border p-4">
            <Text className="text-fg text-left font-sans-medium text-sm">
              {t('pair.relayCard.title')}
            </Text>
            <Text className="text-muted text-left font-sans text-xs leading-relaxed">
              {t('pair.relayCard.body')}
            </Text>
            <Input
              label={t('pair.relayLabel')}
              value={relayDraft}
              onChangeText={(next) => {
                setRelayDraft(next)
                setRelayError(null)
              }}
              placeholder={DEFAULT_RELAY_URL}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              className="font-mono text-xs"
            />
            {relayError !== null && (
              <Text className="text-left font-sans text-xs leading-relaxed text-rose-500">
                {relayError}
              </Text>
            )}
            {/* Buttons and the repo link on separate rows: with both buttons
                showing there is no width left for the link beside them. */}
            {(relayDraftChanged || relayApplied !== DEFAULT_RELAY_URL) && (
              <View className="flex-row gap-2">
                {relayDraftChanged && (
                  <Button size="sm" disabled={busy} onPress={askRelayChange}>
                    {t('pair.relayCard.apply')}
                  </Button>
                )}
                {relayApplied !== DEFAULT_RELAY_URL && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onPress={() => setPendingRelay(DEFAULT_RELAY_URL)}
                  >
                    {t('pair.relayCard.reset')}
                  </Button>
                )}
              </View>
            )}
            <Pressable
              onPress={() => void WebBrowser.openBrowserAsync(RELAY_REPO_URL)}
              className="self-start py-1"
            >
              <Text className="text-muted font-sans text-xs underline">
                {t('pair.relayCard.repo')}
              </Text>
            </Pressable>
          </View>
        </ScrollView>

        {/* Same confirmation the desktop shows before a relay change. */}
        <Dialog
          open={pendingRelay !== null}
          onClose={() => setPendingRelay(null)}
          title={t('pair.relayCard.confirmTitle')}
          footer={
            <View className="flex-row gap-2">
              <Button variant="ghost" onPress={() => setPendingRelay(null)} className="flex-1">
                {t('common.cancel')}
              </Button>
              <Button onPress={confirmRelay} className="flex-1">
                {t('pair.relayCard.confirmApply')}
              </Button>
            </View>
          }
        >
          <View className="gap-3">
            <Text className="text-fg text-left font-sans text-sm leading-relaxed">
              {t('pair.relayCard.confirmBody')}
            </Text>
            <Text selectable className="text-fg text-left font-mono text-xs" style={LTR}>
              {pendingRelay ?? ''}
            </Text>
            <Text className="text-muted text-left font-sans text-sm leading-relaxed">
              {t('pair.relayCard.confirmCompat')}
            </Text>
            <Pressable
              onPress={() => void WebBrowser.openBrowserAsync(RELAY_REPO_URL)}
              className="self-start"
            >
              <Text className="text-muted font-sans text-sm underline">
                {t('pair.relayCard.repo')}
              </Text>
            </Pressable>
          </View>
        </Dialog>
      </View>
    </Modal>
  )
}

function HowRow({
  icon,
  title,
  body
}: {
  icon: React.ReactNode
  title: string
  body: string
}): React.JSX.Element {
  return (
    <View className="flex-row items-start gap-3">
      <View className="mt-0.5">{icon}</View>
      <View className="flex-1 gap-0.5">
        <Text className="text-fg text-left font-sans-medium text-sm">{title}</Text>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">{body}</Text>
      </View>
    </View>
  )
}

/** A card's icon + title + one-line description — the desktop panel's row. */
function CardHeader({
  icon,
  title,
  body
}: {
  icon: React.ReactNode
  title: string
  body: string
}): React.JSX.Element {
  return (
    <View className="flex-row items-start gap-3">
      <View className="mt-0.5">{icon}</View>
      <View className="flex-1 gap-1">
        <Text className="text-fg text-left font-sans-medium text-sm">{title}</Text>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">{body}</Text>
      </View>
    </View>
  )
}
