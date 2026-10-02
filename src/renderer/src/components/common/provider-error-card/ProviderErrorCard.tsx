import {
  AnthropicLogo,
  DeepSeekLogo,
  KimiLogo,
  MiniMaxLogo,
  MimoLogo,
  OllamaLogo,
  OpenAILogo,
  OpenRouterLogo,
  XAILogo,
  QwenLogo,
  StepfunLogo,
  ZaiLogo
} from '@components/core/ProviderLogos'
import { cn } from '@lib/utils/cn'
import { CloudIcon, Copy01Icon, RefreshIcon, Tick02Icon } from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IconType } from 'react-icons'

type Logo =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'mimo'
  | 'kimi'
  | 'minimax'
  | 'xai'
  | 'qwen'
  | 'stepfun'
  | 'zai'
  | 'ollama'

const LOGO: Record<Logo, IconType | React.ComponentType<{ size?: number; className?: string }>> = {
  anthropic: AnthropicLogo,
  openai: OpenAILogo,
  openrouter: OpenRouterLogo,
  deepseek: DeepSeekLogo,
  mimo: MimoLogo,
  kimi: KimiLogo,
  minimax: MiniMaxLogo,
  xai: XAILogo,
  qwen: QwenLogo,
  stepfun: StepfunLogo,
  zai: ZaiLogo,
  ollama: OllamaLogo
}

export type NoProviderAvailablePayload = {
  provider: string
  providerLogo: string
  statusCode: number | null
  errorReason: string
  errorDetail: string | null
  retriesAttempted: number
  totalDurationMs: number
}

/** The stall watchdog's reason (thalamus STREAM_STALL_REASON): the card offers Continue, not Try again. */
export const STALLED_REASON = 'stalled'

function descriptionKeyFor(errorReason: string, statusCode: number | null): string {
  if (errorReason === STALLED_REASON) return 'errors.provider.stalled'
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
  if (errorReason === STALLED_REASON) return 'errors.provider.stalledTitle'
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

export function ErrorDetailBlock({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be unavailable */
    }
  }

  return (
    <div className="group/detail relative mt-2">
      <pre
        dir="ltr"
        className={cn(
          'rounded-lg p-2 text-[11px] leading-tight font-mono',
          'bg-red-100/80 dark:bg-red-950/60',
          'overflow-x-auto whitespace-pre-wrap break-all',
          'text-left'
        )}
      >
        {text}
      </pre>
      <button
        type="button"
        onClick={() => void onCopy()}
        className={cn(
          'absolute bottom-1.5 right-1.5 p-1 rounded-md cursor-pointer',
          'bg-red-200/80 text-red-700 hover:bg-red-300/80',
          'dark:bg-red-800/80 dark:text-red-200 dark:hover:bg-red-700/80',
          'opacity-0 group-hover/detail:opacity-100',
          copied && 'opacity-100'
        )}
      >
        {copied ? <Tick02Icon size={12} /> : <Copy01Icon size={12} />}
      </button>
    </div>
  )
}

function buildDetailText(payload: NoProviderAvailablePayload): string {
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
function reasonLineFor(payload: NoProviderAvailablePayload): string {
  return [
    payload.provider !== 'unknown' ? payload.provider : null,
    payload.statusCode ? `HTTP ${payload.statusCode}` : null,
    payload.errorReason
  ]
    .filter(Boolean)
    .join(' · ')
}

function SingleErrorCard({
  payload,
  onTryAgain,
  onContinue
}: {
  payload: NoProviderAvailablePayload
  onTryAgain?: (reason: string) => void
  /** Stalled calls only: resume the conversation with a system aside instead of re-asking. */
  onContinue?: () => void
}): React.JSX.Element {
  const stalled = payload.errorReason === STALLED_REASON
  const { t } = useTranslation()
  const [showDetail, setShowDetail] = useState(false)
  const Logo = LOGO[payload.providerLogo as Logo] ?? CloudIcon
  const title = t(titleKeyFor(payload.errorReason, payload.statusCode))
  const description = t(descriptionKeyFor(payload.errorReason, payload.statusCode))

  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        'border-red-300 bg-red-50 text-red-900',
        'dark:border-red-700 dark:bg-red-900/40 dark:text-red-100',
        'w-full rounded-2xl border px-4 py-3 text-sm'
      )}
    >
      <div className="flex items-center gap-3">
        <Logo size={18} className="shrink-0" aria-hidden />
        <div className="flex-1 text-xs">
          <p className="font-medium">{title}</p>
          <p className="opacity-80">{description}</p>
          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            className={cn(
              'mt-1 text-[11px] underline underline-offset-2 opacity-60',
              'hover:opacity-90'
            )}
          >
            {t('errors.provider.viewDetails')}
          </button>
        </div>
        {stalled && onContinue && (
          <button
            type="button"
            onClick={onContinue}
            className={cn(
              'flex shrink-0 items-center gap-1.5 self-center rounded-lg px-2.5 py-1.5',
              'text-[11px] font-medium cursor-pointer',
              'bg-red-600 text-white hover:bg-red-700',
              'dark:bg-red-700 dark:hover:bg-red-600'
            )}
          >
            <RefreshIcon size={12} aria-hidden />
            {t('errors.provider.continue')}
          </button>
        )}
        {!stalled && onTryAgain && (
          <button
            type="button"
            onClick={() => onTryAgain(reasonLineFor(payload))}
            className={cn(
              'flex shrink-0 items-center gap-1.5 self-center rounded-lg px-2.5 py-1.5',
              'text-[11px] font-medium cursor-pointer',
              'bg-red-600 text-white hover:bg-red-700',
              'dark:bg-red-700 dark:hover:bg-red-600'
            )}
          >
            <RefreshIcon size={12} aria-hidden />
            {t('errors.provider.tryAgain')}
          </button>
        )}
      </div>
      {showDetail && <ErrorDetailBlock text={buildDetailText(payload)} />}
    </div>
  )
}

export function ProviderErrorCards({
  failures,
  onTryAgain,
  onContinue
}: {
  failures: NoProviderAvailablePayload[]
  onTryAgain?: (reason: string) => void
  onContinue?: () => void
}): React.JSX.Element {
  return (
    <div className="flex w-full max-w-[85%] flex-col gap-2 self-start">
      {failures.map((f, i) => (
        // One retry action per turn: the button rides the first card only.
        <SingleErrorCard
          key={`${f.provider}-${i}`}
          payload={f}
          onTryAgain={i === 0 ? onTryAgain : undefined}
          onContinue={i === 0 ? onContinue : undefined}
        />
      ))}
    </div>
  )
}
