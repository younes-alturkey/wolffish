import wordmark from '../../../assets/wolffish-wordmark.svg?raw'
import { useTranslation } from 'react-i18next'

/**
 * The start page's branding, as React: for the browser sheet while it has no
 * page to raise over its stage (the same mark, chip and line the start page
 * itself draws, so an empty browser never looks blank).
 */
export function StartPanel(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="text-accent flex items-center gap-3">
        <span
          aria-hidden
          className="w-[min(240px,62vw)] [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: wordmark }}
        />
        <span className="rounded-full border-[1.5px] border-current px-2.5 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap">
          {t('chat.browser.startChip')}
        </span>
      </div>
      <p className="text-muted text-sm">{t('chat.browser.startTagline')}</p>
    </div>
  )
}
