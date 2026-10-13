import { MarkdownView } from '@/components/chat/MarkdownView'
import { SegmentedTabs } from '@/components/core/SegmentedTabs'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import {
  CHANGELOG_MONTHS,
  formatChangelogMonth,
  readChangelog,
  readDesktopChangelog
} from '@/lib/changelog'
import { cn } from '@/lib/utils/cn'
import { useLocale } from '@/providers/locale/useLocale'
import { useDesktopChangelogMonths } from '@/state/demoConfig'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, View } from 'react-native'

/**
 * What's new — release notes for both ends of the pairing, one screen.
 *
 * Two sources behind one full-width switch (the LanguageToggle's segmented
 * dress), mirroring the Updates screen's two cards:
 * THIS APP's notes are bundled with the binary (readChangelog — the page
 * works on a plane), the DESKTOP's are its own months synced in the config
 * snapshot with bodies fetched over the tunnel on open and rendered verbatim
 * (readDesktopChangelog). Each source keeps the desktop app's month-by-month
 * navigation, reduced to chips because a phone has no room for a sidebar.
 */

type Source = 'mobile' | 'desktop'

/**
 * The source switch — This app | Desktop — on the shared segmented track. Two
 * fixed sources are a switch; the months below stay a scrolling chip row,
 * because a dozen months are a list, not a toggle.
 */
function SourceSwitch({
  source,
  onChange
}: {
  source: Source
  onChange: (next: Source) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const options: readonly { value: Source; label: string }[] = [
    { value: 'mobile', label: t('settings.updates.thisAppTitle') },
    { value: 'desktop', label: t('settings.updates.desktopTitle') }
  ]
  return <SegmentedTabs value={source} options={options} onChange={onChange} />
}

/** One chip in a row of choices — the months. */
function Chip({
  label,
  active,
  onPress
}: {
  label: string
  active: boolean
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={cn(
        'border-border rounded-lg border px-3 py-1.5',
        active ? 'bg-primary border-primary' : 'bg-surface active:bg-border-soft'
      )}
    >
      <Text className={cn('font-sans-medium text-xs', active ? 'text-primary-fg' : 'text-muted')}>
        {label}
      </Text>
    </Pressable>
  )
}

/** One placeholder line. Callers own every dimension. */
function Bar({ className }: { className: string }): React.JSX.Element {
  return <View className={cn('bg-border rounded-full', className)} />
}

/**
 * A month page's worth of placeholder blocks, shaped the way a real month
 * reads: version header, a titled change, a paragraph of prose. Widths vary
 * because a column of identical bars reads as one line loading nine times.
 */
const SKELETON_BLOCKS = [
  {
    version: 'w-44',
    title: 'w-56',
    lines: ['w-full', 'w-full', 'w-[93%]', 'w-full', 'w-[71%]']
  },
  {
    version: 'w-40',
    title: 'w-36',
    lines: ['w-full', 'w-[96%]', 'w-full', 'w-[88%]', 'w-full', 'w-[42%]']
  },
  {
    version: 'w-44',
    title: 'w-48',
    lines: ['w-full', 'w-[90%]', 'w-[57%]']
  },
  {
    version: 'w-40',
    title: 'w-52',
    lines: ['w-full', 'w-[87%]', 'w-full', 'w-[64%]']
  },
  {
    version: 'w-44',
    title: 'w-40',
    lines: ['w-full', 'w-full', 'w-[95%]', 'w-full', 'w-[91%]', 'w-full', 'w-[35%]']
  },
  {
    version: 'w-40',
    title: 'w-56',
    lines: ['w-[98%]', 'w-full', 'w-[85%]', 'w-full', 'w-[49%]']
  },
  {
    version: 'w-44',
    title: 'w-44',
    lines: ['w-full', 'w-[92%]', 'w-full', 'w-[76%]']
  }
] as const

/**
 * The page while its markdown is on the way — the real page's rhythm in bars
 * (MarkdownView's own metrics: 21px body lines, 8px paragraph gaps, heading
 * blocks with their margins), so real text lands as a fill, not a reflow.
 * Bars are solid `bg-border` dimmed with `opacity-*`, never `bg-border/60` —
 * NativeWind drops `/opacity` on var() colours (see HistorySkeleton).
 */
function PageSkeleton(): React.JSX.Element {
  return (
    // One pulse for the whole page rather than one per bar, and hidden from
    // the screen reader — it is picture, not content.
    <View accessibilityElementsHidden className="animate-pulse flex-col">
      {SKELETON_BLOCKS.map((block, blockIndex) => (
        <View key={blockIndex} className="flex-col">
          <View className="my-[8px] h-[25px] justify-center">
            <Bar className={cn('h-3.5', block.version)} />
          </View>
          <View className="my-[6px] h-[22px] justify-center">
            <Bar className={cn('h-3', block.title)} />
          </View>
          <View className="mb-[8px] flex-col">
            {block.lines.map((width, lineIndex) => (
              <View key={lineIndex} className="h-[21px] justify-center">
                <Bar className={cn('h-3 opacity-60', width)} />
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  )
}

export default function ChangelogScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const desktopMonths = useDesktopChangelogMonths()
  const [source, setSource] = useState<Source>('mobile')
  const [month, setMonth] = useState<string | null>(CHANGELOG_MONTHS[0] ?? null)
  // Loading is its own flag rather than a null body: an unreadable page is
  // also null, and would otherwise spin forever instead of saying so.
  const [page, setPage] = useState<{ text: string | null; loading: boolean }>({
    text: null,
    loading: true
  })

  const months = source === 'desktop' ? desktopMonths : CHANGELOG_MONTHS
  // The chosen month, guarded against the list moving underneath it — a
  // snapshot refresh can drop or add desktop months while this screen is up.
  const activeMonth = month && months.includes(month) ? month : (months[0] ?? null)

  useEffect(() => {
    if (!activeMonth) {
      // Nothing to read (the desktop tab before any sync) — clear whatever
      // the other source rendered, or its text would sit under this tab.
      setPage({ text: null, loading: false })
      return
    }
    let alive = true
    setPage({ text: null, loading: true })
    const read = source === 'desktop' ? readDesktopChangelog : readChangelog
    void read(activeMonth, locale).then((text) => {
      if (alive) setPage({ text, loading: false })
    })
    return () => {
      alive = false
    }
  }, [source, activeMonth, locale])

  const switchSource = (next: Source): void => {
    if (next === source) return
    setSource(next)
    setMonth(next === 'desktop' ? (desktopMonths[0] ?? null) : (CHANGELOG_MONTHS[0] ?? null))
  }

  // The desktop tab's empty text doubles for both of its dead ends — no
  // months known yet (never synced) and a body the tunnel cannot serve right
  // now. Both resolve the same way: connect to the desktop.
  const emptyText =
    source === 'desktop' ? t('settings.changelog.desktopEmpty') : t('settings.changelog.empty')

  return (
    <PanelScreen title={t('settings.changelog.title')} subtitle={t('settings.changelog.subtitle')}>
      <SourceSwitch source={source} onChange={switchSource} />

      {months.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {months.map((key) => (
            <Chip
              key={key}
              label={formatChangelogMonth(key, locale)}
              active={key === activeMonth}
              onPress={() => setMonth(key)}
            />
          ))}
        </ScrollView>
      ) : null}

      <Section>
        {activeMonth && page.loading ? (
          <PageSkeleton />
        ) : page.text ? (
          <MarkdownView>{page.text}</MarkdownView>
        ) : (
          <Text className="text-muted text-left font-sans text-sm">{emptyText}</Text>
        )}
      </Section>
    </PanelScreen>
  )
}
