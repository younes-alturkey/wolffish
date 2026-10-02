import { Markdown } from '@components/core/Markdown'
import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { pageTopPadding } from '@lib/utils/platform'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import { ArrowLeft02Icon, ArrowRight02Icon } from 'hugeicons-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

function formatMonth(key: string, locale: string): string {
  const [year, month] = key.split('-')
  const date = new Date(Number(year), Number(month) - 1)
  return date.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
}

export function Changelog(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const isRtl = RTL_LOCALES.has(locale)
  const BackIcon = isRtl ? ArrowRight02Icon : ArrowLeft02Icon
  const { goTo, returnTo } = useFlow()

  const [appVersion, setAppVersion] = useState('')
  const [months, setMonths] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)

  useEffect(() => {
    void window.api.updater.getVersion().then(setAppVersion)
  }, [])

  useEffect(() => {
    void window.api.updater.listChangelogMonths().then((list) => {
      setMonths(list)
      if (list.length > 0) setSelected((prev) => prev ?? list[0])
    })
  }, [])

  useEffect(() => {
    if (!selected) return
    let stale = false
    void window.api.updater.readChangelog(selected, locale).then((md) => {
      if (!stale) setContent(md)
    })
    return () => {
      stale = true
    }
  }, [selected, locale])

  const handleSelect = useCallback((month: string) => {
    setSelected(month)
  }, [])

  return (
    <main className={cn('bg-bg flex h-full w-full flex-col', pageTopPadding)}>
      <header className="border-border flex items-center gap-2 border-b px-3 py-3">
        <button
          type="button"
          onClick={() => goTo(returnTo ?? 'chat')}
          aria-label={t('common.back', 'Back')}
          className={cn(
            'text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-2 text-sm',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
          )}
        >
          <BackIcon size={16} />
          <span>{t('common.back', 'Back')}</span>
        </button>
        {appVersion && (
          <code className="bg-border/50 text-fg rounded px-2 py-0.5 text-xs font-mono">
            v{appVersion}
          </code>
        )}
      </header>

      {months.length === 0 ? (
        <div className="text-muted flex flex-1 items-center justify-center text-sm">
          {t('changelog.empty', 'No changelog entries yet.')}
        </div>
      ) : (
        <div dir="ltr" className="flex min-h-0 flex-1">
          <aside
            dir={isRtl ? 'rtl' : 'ltr'}
            className="border-border w-48 shrink-0 overflow-y-auto border-r p-3"
          >
            <ul className="flex flex-col gap-0.5">
              {months.map((month) => (
                <li key={month}>
                  <button
                    type="button"
                    onClick={() => handleSelect(month)}
                    className={cn(
                      'w-full rounded-md px-3 py-2 text-start text-sm cursor-pointer',
                      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      selected === month
                        ? 'bg-primary text-primary-fg'
                        : 'text-muted hover:text-fg hover:bg-border/40'
                    )}
                  >
                    {formatMonth(month, locale)}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-6 py-6">
            <div className="mx-auto w-full max-w-2xl">
              {content ? (
                <article dir={isRtl ? 'rtl' : 'ltr'} className="prose-sm">
                  <Markdown content={content} />
                </article>
              ) : (
                <div className="text-muted flex items-center justify-center py-20 text-sm">
                  {t('common.loading', 'Loading...')}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
