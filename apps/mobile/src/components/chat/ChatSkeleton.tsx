import { cn } from '@/lib/utils/cn'
import { useRef } from 'react'
import { ScrollView, View } from 'react-native'

/**
 * Placeholder feed for the frames a conversation spends being read out of
 * SQLite. Without it the chat screen has nothing to render and falls through
 * to the new-chat hero, so opening a long conversation flashes an empty chat
 * and then snaps to the messages.
 *
 * Shaped like a whole conversation instead of a stack of identical bars:
 * turns alternate, and each placeholder copies the chrome of the block it
 * stands in for — prompt bubbles, reply bubbles, a tool card, the file
 * viewers (source, sheet, PDF), the ask card, the media transports, the small
 * chips. No two of them repeat, because a repeated shape reads as one thing
 * loading N times rather than as a conversation. Same ScrollView geometry as
 * the real feed (16pt padding, 16pt gap) and the same card widths, so the
 * messages land on top of their own outline.
 *
 * Longer than a screen and scrolled to the end on mount, for the reason the
 * real feed is: a conversation opens at its last message, so the tail is what
 * the placeholder has to cover.
 *
 * Fills are solid `bg-border`, dimmed with `opacity-*` where a line should
 * recede — never `bg-border/60`. NativeWind drops `/opacity` on var() colours
 * (see global.css), so alpha-modified placeholders come out invisible.
 */

/** One placeholder line. Callers own every dimension. */
function Bar({ className }: { className: string }): React.JSX.Element {
  return <View className={cn('bg-border rounded-full', className)} />
}

/** The bordered surface the real cards share; radius and width are the caller's. */
function Card({
  className,
  children
}: {
  className: string
  children: React.ReactNode
}): React.JSX.Element {
  return <View className={cn('bg-surface border-border border', className)}>{children}</View>
}

/** A message and the bits that hang off it, at the feed's intra-message gap. */
function Group({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <View className="flex-col gap-1.5">{children}</View>
}

/** Copy button + relative time under a finished message. */
function MessageFooter({ align }: { align: 'start' | 'end' }): React.JSX.Element {
  return (
    <View
      className={cn('flex-row items-center gap-2', align === 'end' ? 'self-end' : 'self-start')}
    >
      <View className="bg-border h-3 w-3 rounded opacity-60" />
      <Bar className="h-2 w-10 opacity-60" />
    </View>
  )
}

/* ── User turns ─────────────────────────────────────────────────────────────
   Solid blocks, because the real prompt bubble is a solid primary fill. Width
   and height are the only thing that varies, exactly as they do in the feed. */

function PromptOneLine(): React.JSX.Element {
  return <View className="bg-border h-10 w-[46%] self-end rounded-2xl" />
}

function PromptTwoLines(): React.JSX.Element {
  return <View className="bg-border h-16 w-[72%] self-end rounded-2xl" />
}

function PromptTerse(): React.JSX.Element {
  return <View className="bg-border h-10 w-[34%] self-end rounded-2xl" />
}

function PromptThreeLines(): React.JSX.Element {
  return <View className="bg-border h-20 w-[64%] self-end rounded-2xl" />
}

function PromptFollowUp(): React.JSX.Element {
  return <View className="bg-border h-10 w-[56%] self-end rounded-2xl" />
}

/* ── Agent replies ──────────────────────────────────────────────────────── */

/** Opening reply: three lines with the ragged last one. */
function ReplyParagraph(): React.JSX.Element {
  return (
    <Card className="w-[85%] flex-col gap-2.5 self-start rounded-2xl px-4 py-3">
      <Bar className="h-3 w-full" />
      <Bar className="h-3 w-[92%] opacity-60" />
      <Bar className="h-3 w-[58%] opacity-60" />
    </Card>
  )
}

/** A reply that answers in a list — lead-in plus two bulleted items. */
function ReplyBullets(): React.JSX.Element {
  return (
    <Card className="w-[85%] flex-col gap-2.5 self-start rounded-2xl px-4 py-3">
      <Bar className="h-3 w-[76%]" />
      <View className="flex-row items-center gap-2">
        <View className="bg-border h-1.5 w-1.5 rounded-full" />
        <Bar className="h-2.5 flex-1 opacity-60" />
      </View>
      <View className="flex-row items-center gap-2">
        <View className="bg-border h-1.5 w-1.5 rounded-full" />
        <Bar className="h-2.5 w-[64%] opacity-60" />
      </View>
    </Card>
  )
}

/** A reply with a fenced code block inside it. */
function ReplyWithCode(): React.JSX.Element {
  return (
    <Card className="w-[85%] flex-col gap-2.5 self-start rounded-2xl px-4 py-3">
      <Bar className="h-3 w-[62%]" />
      <View className="bg-bg border-border flex-col gap-2 rounded-md border p-2.5">
        <Bar className="h-2 w-[82%] opacity-60" />
        <Bar className="h-2 w-[54%] opacity-60" />
        <Bar className="h-2 w-[68%] opacity-60" />
      </View>
      <Bar className="h-3 w-[44%] opacity-60" />
    </Card>
  )
}

/** Closing reply: the longest block, and the one the feed opens on. */
function ReplyClosing(): React.JSX.Element {
  return (
    <Card className="w-[85%] flex-col gap-2.5 self-start rounded-2xl px-4 py-3">
      <Bar className="h-3 w-[88%]" />
      <Bar className="h-3 w-full opacity-60" />
      <Bar className="h-3 w-[94%] opacity-60" />
      <Bar className="h-3 w-[40%] opacity-60" />
    </Card>
  )
}

/* ── Verbose-feed chrome ────────────────────────────────────────────────── */

/** provider/model pill. */
function ModelChip(): React.JSX.Element {
  return (
    <Card className="flex-row items-center gap-1.5 self-start rounded-full px-2.5 py-1">
      <View className="bg-border h-1.5 w-1.5 rounded-full" />
      <Bar className="h-2 w-24 opacity-60" />
    </Card>
  )
}

/** Tool card: status pill, tool name, elapsed, chevron, headline code strip. */
function ToolRunCard(): React.JSX.Element {
  return (
    <Card className="w-[85%] flex-col gap-2 self-start rounded-xl px-3 py-2.5">
      <View className="flex-row items-center gap-2">
        <Bar className="h-4 w-14" />
        <Bar className="h-3 w-24 opacity-60" />
        <View className="flex-1" />
        <Bar className="h-2.5 w-6 opacity-60" />
        <View className="bg-border h-3 w-3 rounded opacity-60" />
      </View>
      <View className="bg-bg border-border flex-col gap-2 rounded-md border p-2.5">
        <Bar className="h-2 w-[86%] opacity-60" />
        <Bar className="h-2 w-[46%] opacity-60" />
      </View>
    </Card>
  )
}

/** Workflow summary: title line over a wrapped row of outlined phase pills. */
function WorkflowCard(): React.JSX.Element {
  return (
    <Card className="w-[85%] flex-col gap-2 self-start rounded-xl px-3 py-2.5">
      <Bar className="h-3 w-[74%]" />
      <View className="flex-row flex-wrap gap-1.5">
        <View className="border-border h-5 w-16 rounded-full border" />
        <View className="border-border h-5 w-20 rounded-full border" />
        <View className="border-border h-5 w-12 rounded-full border" />
        <View className="border-border h-5 w-14 rounded-full border" />
      </View>
    </Card>
  )
}

/** Compaction notice — a lone pill, the smallest thing in the feed. */
function CompactionPill(): React.JSX.Element {
  return <View className="bg-border h-5 w-40 self-start rounded-full opacity-60" />
}

/** Path card: content-width, one line of mono text. */
function PathCard(): React.JSX.Element {
  return (
    <Card className="max-w-[85%] self-start rounded-xl px-4 py-3">
      <Bar className="h-2.5 w-52 opacity-60" />
    </Card>
  )
}

/* ── Files ──────────────────────────────────────────────────────────────────
   All at CardShell's w-[85%], so a file going missing — or a file card being
   swapped for the one the message actually carries — never shifts the feed. */

/** Shared file-card head: icon · name · size. */
function FileHeader({ nameWidth }: { nameWidth: string }): React.JSX.Element {
  return (
    <View className="flex-row items-center gap-2 px-3 py-2">
      <View className="bg-border h-4 w-4 rounded" />
      <Bar className={cn('h-3', nameWidth)} />
      <View className="flex-1" />
      <Bar className="h-2.5 w-8 opacity-60" />
    </View>
  )
}

/** Shared file-card foot: caption on the leading edge, actions trailing. */
function FileFooter({ actions }: { actions: number }): React.JSX.Element {
  return (
    <View className="border-border flex-row items-center gap-1 border-t px-3 py-2">
      <Bar className="h-2 w-16 opacity-60" />
      <View className="flex-1" />
      {Array.from({ length: actions }, (_, index) => (
        <View key={index} className="bg-border h-3.5 w-3.5 rounded opacity-60" />
      ))}
    </View>
  )
}

/** Line widths for the source viewer — ragged like real code. */
const SOURCE_LINES = ['w-[68%]', 'w-[86%]', 'w-[44%]', 'w-[74%]', 'w-[56%]', 'w-[38%]'] as const

/** Code viewer: gutter of line numbers beside the source. */
function SourceFileCard(): React.JSX.Element {
  return (
    <Card className="w-[85%] flex-col self-start overflow-hidden rounded-2xl">
      <FileHeader nameWidth="w-28" />
      <View className="border-border bg-bg flex-row gap-3 border-t px-3 py-3">
        <View className="flex-col gap-2.5">
          {SOURCE_LINES.map((_, index) => (
            <Bar key={index} className="h-2 w-3 opacity-40" />
          ))}
        </View>
        <View className="flex-1 flex-col gap-2.5">
          {SOURCE_LINES.map((width, index) => (
            <Bar key={index} className={cn('h-2 opacity-60', width)} />
          ))}
        </View>
      </View>
      <FileFooter actions={3} />
    </Card>
  )
}

/** Spreadsheet viewer: a header band over three body rows of cells. */
function SheetFileCard(): React.JSX.Element {
  return (
    <Card className="w-[85%] flex-col self-start overflow-hidden rounded-2xl">
      <FileHeader nameWidth="w-20" />
      <View className="border-border bg-bg flex-row gap-2 border-t border-b px-3 py-2">
        <Bar className="h-2.5 w-8" />
        <Bar className="h-2.5 flex-1" />
        <Bar className="h-2.5 flex-1" />
        <Bar className="h-2.5 w-10" />
      </View>
      {[0, 1, 2].map((row) => (
        <View
          key={row}
          className={cn(
            'flex-row items-center gap-2 px-3 py-2',
            row > 0 && 'border-border border-t'
          )}
        >
          <Bar className="h-2 w-8 opacity-60" />
          <Bar className="h-2 flex-1 opacity-40" />
          <Bar className="h-2 flex-1 opacity-40" />
          <Bar className="h-2 w-10 opacity-60" />
        </View>
      ))}
      <FileFooter actions={2} />
    </Card>
  )
}

/** PDF viewer: a page, inset and lighter than the card around it. */
function PdfFileCard(): React.JSX.Element {
  return (
    <Card className="w-[85%] flex-col self-end overflow-hidden rounded-2xl">
      <FileHeader nameWidth="w-24" />
      <View className="border-border bg-bg items-center border-t py-4">
        <Card className="h-44 w-[58%] flex-col gap-2 rounded-sm p-3">
          <Bar className="h-2 w-[66%]" />
          <Bar className="h-1.5 w-full opacity-40" />
          <Bar className="h-1.5 w-full opacity-40" />
          <Bar className="h-1.5 w-[84%] opacity-40" />
          <Bar className="h-1.5 w-[92%] opacity-40" />
          <Bar className="h-1.5 w-[48%] opacity-40" />
        </Card>
      </View>
      <FileFooter actions={2} />
    </Card>
  )
}

/** Image: no chrome at all — the thumbnail is the card. Matches ImageBlock. */
function ImageThumb(): React.JSX.Element {
  return <View className="bg-border self-start rounded-2xl" style={{ width: 260, height: 200 }} />
}

/** Video: a 16:9 stage with a play badge, name row beneath. */
function VideoCard(): React.JSX.Element {
  return (
    <Card className="w-[85%] flex-col self-start overflow-hidden rounded-xl">
      <View className="bg-bg h-40 items-center justify-center">
        <View className="bg-border h-12 w-12 rounded-full opacity-60" />
      </View>
      <View className="flex-row items-center gap-2 px-3 py-2">
        <Bar className="h-2.5 w-24 opacity-60" />
        <View className="flex-1" />
        <View className="bg-border h-3.5 w-3.5 rounded opacity-60" />
      </View>
    </Card>
  )
}

/** Audio: the transport row — play button, title, scrub track, elapsed. */
function AudioCard(): React.JSX.Element {
  return (
    <Card className="w-[85%] flex-row items-center gap-3 self-start rounded-xl px-3 py-2.5">
      <View className="bg-border h-9 w-9 rounded-full" />
      <View className="flex-1 flex-col gap-1.5">
        <Bar className="h-2.5 w-[52%]" />
        <Bar className="h-1 w-full opacity-40" />
        <Bar className="h-2 w-12 opacity-60" />
      </View>
      <View className="bg-border h-3.5 w-3.5 rounded opacity-60" />
    </Card>
  )
}

/** ask_user card: question, details, and the answered row with its tick. */
function AskCard(): React.JSX.Element {
  return (
    <Card className="w-full flex-col gap-3 self-start rounded-2xl p-4">
      <Bar className="h-3.5 w-[70%]" />
      <Bar className="h-2.5 w-full opacity-60" />
      <Bar className="h-2.5 w-[84%] opacity-60" />
      <View className="flex-row items-center gap-2 pt-1">
        <View className="bg-border h-3.5 w-3.5 rounded-full" />
        <Bar className="h-3 w-[46%]" />
      </View>
    </Card>
  )
}

export function ChatSkeleton(): React.JSX.Element {
  const listRef = useRef<ScrollView>(null)
  return (
    <ScrollView
      ref={listRef}
      onContentSizeChange={() => {
        listRef.current?.scrollToEnd({ animated: false })
      }}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16 }}
    >
      {/* One pulse for the whole feed: 20-odd cards each driving their own
          opacity animation is both costlier and visually noisier. */}
      <View className="animate-pulse flex-col gap-4">
        {/* Turn 1 — a question, answered in prose. */}
        <PromptOneLine />
        <ModelChip />
        <Group>
          <ReplyParagraph />
          <MessageFooter align="start" />
        </Group>

        {/* Turn 2 — a prompt with a PDF attached; agent works, then answers. */}
        <Group>
          <PromptTwoLines />
          <PdfFileCard />
        </Group>
        <ToolRunCard />
        <SourceFileCard />
        <Group>
          <ReplyBullets />
          <MessageFooter align="start" />
        </Group>

        {/* Turn 3 — the agent asks back. */}
        <PromptTerse />
        <AskCard />

        {/* Turn 4 — a workflow run that delivers files. */}
        <PromptThreeLines />
        <WorkflowCard />
        <PathCard />
        <SheetFileCard />
        <ImageThumb />
        <Group>
          <ReplyWithCode />
          <MessageFooter align="start" />
        </Group>

        {/* Turn 5 — media, a compaction along the way, and the last reply. */}
        <PromptFollowUp />
        <AudioCard />
        <VideoCard />
        <CompactionPill />
        <Group>
          <ReplyClosing />
          <MessageFooter align="start" />
        </Group>
      </View>
    </ScrollView>
  )
}
