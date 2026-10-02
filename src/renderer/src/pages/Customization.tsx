import { CodeEditor } from '@components/core/CodeEditor'
import { CopyButton } from '@components/core/CopyButton'
import { useToast } from '@components/core/toast/useToast'
import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { pageTopPadding } from '@lib/utils/platform'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import { useTheme } from '@providers/theme/useTheme'
import {
  AngelIcon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  FloppyDiskIcon,
  Refresh01Icon,
  Robot01Icon,
  UserIcon
} from 'hugeicons-react'
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The three hand-written documents that shape the agent. Kept in step with
 * CUSTOMIZATION_DOCS in main/channels/mobile/snapshot.ts, which is what the
 * phone reads and writes — the renderer cannot import from main, so the paths
 * are spelled twice on purpose and must stay identical.
 */
type Doc = 'soul' | 'user' | 'agents'

const DOCS: {
  key: Doc
  path: string
  fileName: string
  icon: ComponentType<{ size?: number }>
}[] = [
  { key: 'soul', path: 'brain/identity/soul.md', fileName: 'soul.md', icon: AngelIcon },
  { key: 'user', path: 'brain/identity/user.md', fileName: 'user.md', icon: UserIcon },
  { key: 'agents', path: 'brain/prefrontal/agents.md', fileName: 'agents.md', icon: Robot01Icon }
]

/**
 * One document's editing state. `original` is the text on disk as this page
 * last saw it — the dirty test, and the gate on adopting someone else's write.
 */
type DocState = { content: string; original: string; loading: boolean }

const BLANK: DocState = { content: '', original: '', loading: true }

/**
 * Customization — Soul, User and Agents as one page with three tabs.
 *
 * They were three sidebar destinations rendering the same editor over three
 * files, which made "adjust how the agent behaves" a question of remembering
 * which of three near-identical pages held the paragraph you meant. The phone
 * collapsed them into one Customization screen; this is the desktop's version
 * of that move, with tabs where the Changelog page puts its version chip — the
 * back button leads, the tabs sit beside it, and the editor fills the rest.
 *
 * All three documents load on mount rather than on first visit to their tab.
 * That is three small local reads for a page that then switches instantly, and
 * it is what lets an inactive tab carry an honest unsaved-changes dot: a draft
 * you left in Soul is still there when you come back from Agents, which was
 * never true when the three were separate pages.
 */
export function Customization(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const { isDark } = useTheme()
  const isRtl = RTL_LOCALES.has(locale)
  const BackIcon = isRtl ? ArrowRight02Icon : ArrowLeft02Icon
  const { goTo } = useFlow()
  const toast = useToast()

  const [active, setActive] = useState<Doc>('soul')
  const [docs, setDocs] = useState<Record<Doc, DocState>>({
    soul: BLANK,
    user: BLANK,
    agents: BLANK
  })
  const [saving, setSaving] = useState(false)

  const activeDoc = DOCS.find((d) => d.key === active) ?? DOCS[0]
  const state = docs[active]
  const isDirty = state.content !== state.original

  useEffect(() => {
    let cancelled = false
    for (const doc of DOCS) {
      window.api.viewer
        .readFile(doc.path)
        .then((raw) => {
          if (cancelled) return
          setDocs((prev) => ({
            ...prev,
            [doc.key]: { content: raw, original: raw, loading: false }
          }))
        })
        .catch(() => {
          if (cancelled) return
          setDocs((prev) => ({ ...prev, [doc.key]: { ...prev[doc.key], loading: false } }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [])

  const handleChange = useCallback(
    (value: string) => {
      setDocs((prev) => ({ ...prev, [active]: { ...prev[active], content: value } }))
    },
    [active]
  )

  const handleSave = useCallback(async (): Promise<void> => {
    if (saving) return
    const saved = state.content
    setSaving(true)
    try {
      await window.api.viewer.writeFile(activeDoc.path, saved)
      // Stamp what actually went to disk, not whatever is in the box now: a
      // keystroke landing during the write should leave the tab dirty, not
      // pretend it was included in the save.
      setDocs((prev) => ({ ...prev, [active]: { ...prev[active], original: saved } }))
      toast.show({ tone: 'success', message: t('workspace.saved') })
    } catch {
      toast.show({ tone: 'error', message: t('workspace.saveError') })
    } finally {
      setSaving(false)
    }
  }, [active, activeDoc.path, saving, state.content, t, toast])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSave])

  /**
   * Someone else wrote one of these files — another window, or the paired
   * phone's Customization screen. Adopt it silently so the two devices never
   * sit on different text, but ONLY while that document is clean: an unsaved
   * draft is work in progress, and replacing it under the cursor would lose
   * keystrokes that exist nowhere else. A dirty tab keeps its draft, and its
   * Save then wins on both screens the way the last write always does.
   *
   * One subscription for all three, because the page now holds all three — the
   * tab you are not looking at gets the same courtesy refresh the open one
   * does. The dirty check reads a ref rather than state so the subscription
   * survives every keystroke: resubscribing per character would drop the
   * notification that arrives between the unsubscribe and the next attach.
   */
  const liveRef = useRef(docs)
  useEffect(() => {
    liveRef.current = docs
  }, [docs])

  useEffect(
    () =>
      window.api.viewer.onCustomizationChanged((payload) => {
        const doc = DOCS.find((d) => d.key === payload?.doc || d.path === payload?.path)
        if (!doc) return
        const before = liveRef.current[doc.key]
        if (before.content !== before.original) return
        window.api.viewer
          .readFile(doc.path)
          .then((raw) => {
            // Re-checked on arrival: typing may have started while the read
            // was in flight, and this is a courtesy refresh, not a demand.
            const now = liveRef.current[doc.key]
            if (now.content !== now.original) return
            setDocs((prev) => ({
              ...prev,
              [doc.key]: { content: raw, original: raw, loading: false }
            }))
          })
          .catch(() => {})
      }),
    []
  )

  const handleRefresh = useCallback(async (): Promise<void> => {
    try {
      const raw = await window.api.viewer.readFile(activeDoc.path)
      setDocs((prev) => ({
        ...prev,
        [active]: { content: raw, original: raw, loading: false }
      }))
      toast.show({ tone: 'success', message: t('workspace.resynced') })
    } catch {
      toast.show({ tone: 'error', message: t('workspace.resyncError') })
    }
  }, [active, activeDoc.path, t, toast])

  return (
    <main className={cn('bg-bg flex h-full w-full flex-col', pageTopPadding)}>
      <header className="border-border flex items-center gap-2 border-b px-3 py-3">
        <button
          type="button"
          onClick={() => goTo('chat')}
          aria-label={t('common.back')}
          className={cn(
            'text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-2 text-sm',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
          )}
        >
          <BackIcon size={16} />
          <span>{t('common.back')}</span>
        </button>

        {/* Where the Changelog page puts its version chip. Laid out with the
            document flow, so in Arabic the tabs run right-to-left from the
            back button without a single mirrored class here. */}
        <div
          role="tablist"
          aria-label={t('customization.title')}
          className="border-border bg-surface inline-flex items-center rounded-lg border p-0.5"
        >
          {DOCS.map(({ key, icon: Icon }) => {
            const selected = key === active
            const dirty = docs[key].content !== docs[key].original
            return (
              <button
                key={key}
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => setActive(key)}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  selected ? 'bg-primary text-primary-fg' : 'text-muted hover:text-fg'
                )}
              >
                <Icon size={14} />
                <span>{t(`chat.${key}`)}</span>
                {/* The unsaved mark, on the tab rather than only in the row
                    below — a draft left in a tab you navigated away from is
                    exactly the one you can no longer see. */}
                {dirty ? (
                  <span
                    aria-hidden
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      selected ? 'bg-primary-fg' : 'bg-accent'
                    )}
                  />
                ) : null}
              </button>
            )
          })}
        </div>
      </header>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              {/* A path, so it reads left-to-right in every locale. */}
              <span dir="ltr" className="text-fg font-mono text-sm font-medium">
                {activeDoc.fileName}
              </span>
              {isDirty ? (
                <span className="text-muted text-xs italic">{t('customization.unsaved')}</span>
              ) : null}
            </div>
            {/* What this document is FOR. The page name no longer says it — the
                tab is one word — so the sentence the three separate pages never
                had earns its line here. */}
            <p className="text-muted truncate text-xs">
              {t(`customization.docs.${active}.description`)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={state.loading}
              className={cn(
                'text-muted hover:text-fg inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs',
                'disabled:cursor-not-allowed disabled:opacity-40'
              )}
            >
              <Refresh01Icon size={14} />
              <span>{t('workspace.resync')}</span>
            </button>
            <CopyButton text={state.content} variant="inline" />
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!isDirty || saving}
              aria-label={t('workspace.save')}
              title={t('workspace.save')}
              className={cn(
                'text-muted hover:text-fg hover:bg-border/40 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted'
              )}
            >
              <FloppyDiskIcon size={16} />
            </button>
          </div>
        </div>
        {state.loading ? (
          <div className="text-muted flex flex-1 items-center justify-center text-sm">
            {t('common.loading')}
          </div>
        ) : (
          /* `dir="auto"` rather than inheriting the app's direction: these are
             documents, not chrome. An English soul.md stays flush-left while
             the page around it is Arabic, and one written in Arabic gets the
             right-to-left editor it deserves.

             Keyed by document so a tab switch builds a fresh editor. The text
             itself survives the switch (it lives up here), but the undo
             history must not: a Cmd+Z after switching tabs should never reach
             back into another document's edits. */
          <div dir="auto" className="min-h-0 w-full flex-1">
            <CodeEditor
              key={active}
              value={state.content}
              language="markdown"
              isDark={isDark}
              readOnly={false}
              onChange={handleChange}
              className="h-full w-full"
              spellcheck
            />
          </div>
        )}
      </section>
    </main>
  )
}
