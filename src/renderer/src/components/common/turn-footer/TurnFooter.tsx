import { cn } from '@lib/utils/cn'
import { useTranslation } from 'react-i18next'

type FooterReason = 'error'

const COLOR: Record<FooterReason, string> = {
  error: 'bg-red-500/10 text-red-600 dark:text-red-400'
}

const KEY: Record<FooterReason, string> = {
  error: 'chat.turnFooter.error'
}

export function TurnFooter({ stopReason }: { stopReason: FooterReason }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'self-start inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        COLOR[stopReason]
      )}
    >
      {t(KEY[stopReason])}
    </span>
  )
}
