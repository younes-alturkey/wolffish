import { CloudIcon, Copy01Icon, RefreshIcon, Tick02Icon } from '@/components/core/icons'
import { PROVIDER_LOGOS } from '@/components/core/providerLogos'
import type { NoProviderAvailableInfo } from '@/lib/conversations/types'
import * as Clipboard from 'expo-clipboard'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

/**
 * The desktop's provider error card, ported: what a failed turn renders as.
 * A structured failure wears its provider's own logo; anything without one —
 * no provider configured, a bare error string — falls back to the generic
 * cloud mark. "View details" opens the verbatim failure trace with a copy
 * button; the retry button rides only where the screen offers one, which is
 * the last message of an idle conversation, exactly the desktop's rule.
 */

function descriptionKeyFor(errorReason: string, statusCode: number | null): string {
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    errorReason === 'authentication failed' ||
    errorReason === 'forbidden'
  ) {
    return 'errors.provider.invalidKey'
  }
  if (statusCode === 404 || errorReason === 'model not found') {
    return 'errors.provider.modelNotFound'
  }
  if (statusCode === 429 || errorReason === 'rate-limited') {
    return 'errors.provider.rateLimited'
  }
  if (statusCode === 400 || errorReason === 'bad request') {
    return 'errors.provider.badRequest'
  }
  if (errorReason === 'offline') {
    return 'errors.provider.offline'
  }
  if (statusCode === 504 || errorReason === 'timeout') {
    return 'errors.provider.timeout'
  }
  if (statusCode !== null && statusCode >= 500) {
    return 'errors.provider.serverError'
  }
  return 'errors.provider.noProviderDescription'
}

function titleKeyFor(errorReason: string, statusCode: number | null): string {
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    errorReason === 'authentication failed' ||
    errorReason === 'forbidden'
  ) {
    return 'errors.provider.invalidKeyTitle'
  }
  if (statusCode === 400 || errorReason === 'bad request') {
    return 'errors.provider.badRequestTitle'
  }
  if (statusCode === 504 || errorReason === 'timeout') {
    return 'errors.provider.timeoutTitle'
  }
  return 'errors.provider.noProviderTitle'
}

function buildDetailText(payload: NoProviderAvailableInfo): string {
  const lines: string[] = []
  lines.push(`Provider: ${payload.provider}`)
  if (payload.statusCode) lines.push(`Status: HTTP ${payload.statusCode}`)
  lines.push(`Error: ${payload.errorReason}`)
  if (payload.errorDetail) lines.push(`Detail: ${payload.errorDetail}`)
  if (payload.retriesAttempted > 0) lines.push(`Retries: ${payload.retriesAttempted}`)
  if (payload.totalDurationMs > 0) {
    const sec = (payload.totalDurationMs / 1000).toFixed(1)
    lines.push(`Duration: ${sec}s`)
  }
  lines.push('')
  lines.push('This is an API provider issue — not a Wolffish error.')
  lines.push('The provider terminated or failed to complete the response.')
  lines.push('Try again, or pick a different Brain in settings.')
  return lines.join('\n')
}

/** Compact one-line failure summary handed to the retry continuation message. */
export function reasonLineFor(payload: NoProviderAvailableInfo): string {
  return [
    payload.provider !== 'unknown' ? payload.provider : null,
    payload.statusCode ? `HTTP ${payload.statusCode}` : null,
    payload.errorReason
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * A bare error string as a card payload — the desktop's synthetic fallback
 * for a failure that carries no structured providerErrors. The empty logo is
 * what routes the card to the generic cloud mark.
 */
export function syntheticFailure(errorReason: string): NoProviderAvailableInfo {
  return {
    provider: 'unknown',
    providerLogo: '',
    statusCode: null,
    errorReason,
    errorDetail: null,
    retriesAttempted: 0,
    totalDurationMs: 0
  }
}

function ErrorDetailBlock({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const Icon = copied ? Tick02Icon : Copy01Icon
  return (
    <View className="relative mt-2">
      {/* Forced LTR like the desktop's dir="ltr" pre — an RTL locale must not
          mangle the trace. */}
      <Text
        selectable
        style={{ writingDirection: 'ltr' }}
        className="rounded-lg bg-red-100/80 p-2 text-left font-mono text-[11px] leading-tight text-red-900 dark:bg-red-950/60 dark:text-red-100"
      >
        {text}
      </Text>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => {
          void Clipboard.setStringAsync(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="absolute bottom-1.5 right-1.5 rounded-md bg-red-200/80 p-1 dark:bg-red-800/80"
      >
        <Icon size={12} className="text-red-700 dark:text-red-200" />
      </Pressable>
    </View>
  )
}

function SingleErrorCard({
  payload,
  onTryAgain
}: {
  payload: NoProviderAvailableInfo
  onTryAgain?: (reason: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [showDetail, setShowDetail] = useState(false)
  const Logo = PROVIDER_LOGOS[payload.providerLogo] ?? CloudIcon
  const title = t(titleKeyFor(payload.errorReason, payload.statusCode))
  const description = t(descriptionKeyFor(payload.errorReason, payload.statusCode))

  return (
    <View
      accessibilityRole="alert"
      className="w-full rounded-2xl border border-red-300 bg-red-50 px-4 py-3 dark:border-red-700 dark:bg-red-900/40"
    >
      <View className="flex-row items-center gap-3">
        <Logo size={18} className="shrink-0 text-red-900 dark:text-red-100" />
        <View className="flex-1">
          <Text
            selectable
            className="font-sans-medium text-left text-xs text-red-900 dark:text-red-100"
          >
            {title}
          </Text>
          <Text
            selectable
            className="text-left font-sans text-xs text-red-900 opacity-80 dark:text-red-100"
          >
            {description}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showDetail }}
            hitSlop={8}
            onPress={() => setShowDetail((value) => !value)}
            className="mt-1 self-start"
          >
            <Text className="text-left font-sans text-[11px] text-red-900 underline opacity-60 dark:text-red-100">
              {t('errors.provider.viewDetails')}
            </Text>
          </Pressable>
        </View>
        {onTryAgain && (
          <Pressable
            accessibilityRole="button"
            onPress={() => onTryAgain(reasonLineFor(payload))}
            className="flex-row items-center gap-1.5 self-center rounded-lg bg-red-600 px-2.5 py-1.5 dark:bg-red-700"
          >
            <RefreshIcon size={12} className="text-white" />
            <Text className="font-sans-medium text-[11px] text-white">
              {t('errors.provider.tryAgain')}
            </Text>
          </Pressable>
        )}
      </View>
      {showDetail && <ErrorDetailBlock text={buildDetailText(payload)} />}
    </View>
  )
}

export const ProviderErrorCards = memo(function ProviderErrorCards({
  failures,
  onTryAgain
}: {
  failures: NoProviderAvailableInfo[]
  onTryAgain?: (reason: string) => void
}): React.JSX.Element {
  return (
    <View className="w-full max-w-[85%] flex-col gap-2 self-start">
      {failures.map((failure, index) => (
        // One retry action per turn: the button rides the first card only.
        <SingleErrorCard
          key={`${failure.provider}-${index}`}
          payload={failure}
          onTryAgain={index === 0 ? onTryAgain : undefined}
        />
      ))}
    </View>
  )
})
