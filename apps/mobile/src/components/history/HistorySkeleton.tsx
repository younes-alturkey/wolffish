import { cn } from '@/lib/utils/cn'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * Placeholder list for the frames the conversation index spends being read out
 * of SQLite. Without it the screen has nothing to render and falls through to
 * the "no conversations yet" copy, so opening History flashes an empty state
 * and then snaps to the list.
 *
 * Each placeholder is a whole row rather than a plain block — recency chip,
 * channel badge, title, timestamp, delete — inside the real row's chrome, and
 * grouped under recency headers like the SectionList is. Titles run every
 * length a real index has and only some rows carry a badge, because a column
 * of identical bars reads as one row loading twelve times instead of as a list
 * of conversations.
 *
 * Sizes are measured against the real thing, not guessed: a rendered Row is
 * 169px on a 3x device (h-16 = 4rem = 168px — NativeWind's rem is 14, not the
 * web's 16), the separator is h-2, and a section header's text box is h-5 over
 * its pb-1.5. The real row is single-line by construction (numberOfLines={1}),
 * so those heights never vary and the list does not reflow when data lands.
 *
 * Fills are solid `bg-border`, dimmed with `opacity-*` where a line should
 * recede — never `bg-border/60`. NativeWind drops `/opacity` on var() colours
 * (see global.css), which left the old placeholder rows invisible.
 */

/** One placeholder line. Callers own every dimension. */
function Bar({ className }: { className: string }): React.JSX.Element {
  return <View className={cn('bg-border rounded-full', className)} />
}

/** Per-row shape: does it carry a channel badge, how long is the title, how
 *  wide is the relative time ("1d" against "12mo"). No two rows repeat. */
const GROUPS = [
  {
    label: 'w-12',
    rows: [
      { badge: false, title: 'w-[34%]', time: 'w-5' },
      { badge: false, title: 'w-[52%]', time: 'w-6' },
      { badge: true, title: 'w-[68%]', time: 'w-5' },
      { badge: true, title: 'w-[44%]', time: 'w-8' }
    ]
  },
  {
    label: 'w-20',
    rows: [
      { badge: false, title: 'w-[76%]', time: 'w-5' },
      { badge: true, title: 'w-[30%]', time: 'w-7' },
      { badge: false, title: 'w-[58%]', time: 'w-6' }
    ]
  },
  {
    label: 'w-28',
    rows: [
      { badge: false, title: 'w-[84%]', time: 'w-5' },
      { badge: true, title: 'w-[40%]', time: 'w-6' },
      { badge: false, title: 'w-[64%]', time: 'w-8' },
      { badge: true, title: 'w-[48%]', time: 'w-5' },
      { badge: true, title: 'w-[72%]', time: 'w-6' }
    ]
  }
] as const

export function HistorySkeleton(): React.JSX.Element {
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }}
    >
      {/* One pulse for the whole list: a dozen rows each driving their own
          opacity animation is both costlier and visually noisier. */}
      <View className="animate-pulse flex-col">
        {GROUPS.map((group, groupIndex) => (
          <View key={groupIndex} className="flex-col">
            {/* Recency header — h-5 is the text box it stands in for, and only
                later groups carry the pt-5 that separates them from the rows
                above, exactly as renderSectionHeader does. */}
            <View className={cn('px-1 pb-1.5', groupIndex > 0 && 'pt-5')}>
              <View className="h-5 justify-center">
                <Bar className={cn('h-2 opacity-60', group.label)} />
              </View>
            </View>
            <View className="flex-col gap-2">
              {group.rows.map((row, rowIndex) => (
                <View
                  key={rowIndex}
                  className="bg-surface border-border h-16 flex-row items-center gap-3 rounded-xl border px-4"
                >
                  {/* Recency chip — outlined circle around its number. */}
                  <View className="border-border h-6 w-6 items-center justify-center rounded-full border">
                    <Bar className="h-1.5 w-2 opacity-60" />
                  </View>
                  <View className="flex-1 flex-col gap-0.5">
                    <View className="h-5 flex-row items-center gap-1.5">
                      {row.badge ? <View className="bg-border h-3.5 w-3.5 rounded" /> : null}
                      <Bar className={cn('h-3', row.title)} />
                    </View>
                    <View className="h-4 justify-center">
                      <Bar className={cn('h-2 opacity-60', row.time)} />
                    </View>
                  </View>
                  {/* Delete affordance, at its real touch-target size. */}
                  <View className="h-8 w-8 items-center justify-center">
                    <View className="bg-border h-4 w-4 rounded opacity-60" />
                  </View>
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  )
}
