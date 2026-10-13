import { DEFAULT_PROJECT_ICON } from '@/components/workspace/ProjectDialog'
import { cn } from '@/lib/utils/cn'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, View } from 'react-native'

/**
 * The project to bind, as a row of chips — the chat controls' picker, reused by
 * the automation and procedure editors in place of the Select they opened with.
 *
 * Chips rather than a dropdown for the reason the chat menu states: the whole
 * list is the point. The projects are few, named and emoji'd, and one tap binds
 * one — a Select hid every option behind a modal to pick from a set that fits
 * on the row itself. The row never wraps; it scrolls freely on x however many
 * projects there are, so the twentieth project costs the dialog no height.
 *
 * This one BINDS rather than enters: it is a controlled field of the draft the
 * editor autosaves, which is why it takes value/onChange instead of touching
 * project mode the way the chat menu's row does.
 */
export function ProjectChipRow({
  label,
  noneLabel,
  projects,
  value,
  disabled,
  onChange
}: {
  /** Names the field — "Project". */
  label: string
  /** The unbound chip's caption — "No project". */
  noneLabel: string
  projects: readonly { id: string; title: string; icon: string }[]
  /** The bound project's id, or '' for unbound. */
  value: string
  /** No desktop to write to — the row shows the binding but takes no tap. */
  disabled?: boolean
  onChange: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  const chips = [
    { value: '', label: noneLabel, icon: '📄' },
    ...projects.map((project) => ({
      value: project.id,
      label: project.title.trim() || t('projects.untitled'),
      icon: project.icon || DEFAULT_PROJECT_ICON
    }))
  ]
  // A binding whose project is missing from the list still needs a chip, or the
  // row would show nothing lit and the next pick would silently drop it.
  if (value && !projects.some((project) => project.id === value)) {
    chips.push({ value, label: value, icon: '📁' })
  }

  // The lit chip can start off the row's right edge — the dialog would open on
  // a row that reads as unbound. Scroll it into view the once; every later
  // change comes from a tap, which is already in view. The latch turns only on
  // a scroll that actually happened, so a chip laid out at the start before the
  // project list lands still gets carried in when the list pushes it right.
  const rowRef = useRef<ScrollView | null>(null)
  const settled = useRef(false)
  const onActiveLayout = (x: number): void => {
    if (settled.current || x <= 0) return
    settled.current = true
    rowRef.current?.scrollTo({ x: Math.max(x - 12, 0), animated: false })
  }

  return (
    <View className="flex-col gap-1.5">
      <Text className="text-muted font-sans-medium text-left text-sm">{label}</Text>
      <ScrollView
        ref={rowRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        // The visible label above is a SIBLING Text, so without this the row
        // announces only its chips, with no hint of what they choose.
        accessibilityLabel={label}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ alignItems: 'center', gap: 8 }}
      >
        {chips.map((chip) => {
          const active = chip.value === value
          return (
            <Pressable
              key={chip.value}
              accessibilityRole="tab"
              accessibilityState={{ selected: active, disabled: !!disabled }}
              disabled={disabled}
              onLayout={active ? (event) => onActiveLayout(event.nativeEvent.layout.x) : undefined}
              onPress={() => onChange(chip.value)}
              className={cn(
                'h-9 shrink-0 flex-row items-center gap-2 rounded-lg border px-3',
                active ? 'bg-primary border-primary' : 'bg-bg border-border active:bg-border-soft',
                disabled && 'opacity-60'
              )}
            >
              <Text className="text-sm">{chip.icon}</Text>
              <Text
                numberOfLines={1}
                className={cn(
                  'font-sans-medium max-w-[160px] text-xs',
                  active ? 'text-primary-fg' : 'text-fg'
                )}
              >
                {chip.label}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}
