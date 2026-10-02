import { cn } from '@lib/utils/cn'
import type { WaitSnapshot, WaitStatus } from '@preload/index'
import { Clock01Icon, SentIcon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The blocking-wait card. Fully DETERMINISTIC: the reason, the deadline and
 * the state all come from WaitManager's snapshot — the model narrates
 * nothing. One card per wait: snapshots replace each other by waitId
 * upstream (upsertWaitSegment), so live and reloaded conversations render
 * identically, at the position in the transcript where the wait began.
 *
 * While it waits the card carries an input. Sending from it is NOT a private
 * channel to the wait — it posts an ordinary mid-turn message into the
 * running turn (the same call the composer makes), which wakes the agent and
 * is delivered as the user's next words. So the wait ends and the message is
 * answered, with one copy of it in the transcript.
 *
 * The clock is derived locally from endsAt at 1 Hz; main pushes state
 * transitions only, never ticks — a four-hour wait costs two segments. In
 * its terminal states the card is a one-line record: no clock, no input
 * (a control that cannot act renders nothing).
 */

const STATUS_COLOR: Record<WaitStatus, string> = {
  waiting: 'bg-accent/10 text-accent',
  elapsed: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  interrupted: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  canceled: 'bg-muted/20 text-muted'
}

/** "4h 12m" / "12m 30s" / "45s" — the same shape the tool reports. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  if (s < 60) return `${s}s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const rem = s % 60
    return rem ? `${m}m ${rem}s` : `${m}m`
  }
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return m ? `${h}h ${m}m` : `${h}h`
}

export function WaitCard({ snapshot }: { snapshot: WaitSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const live = snapshot.status === 'waiting'
  const [now, setNow] = useState<number>(() => Date.now())
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])

  const totalMs = Math.max(1, snapshot.endsAt - snapshot.startedAt)
  const remainingMs = live ? Math.max(0, snapshot.endsAt - now) : 0
  // Fills as the wait runs down, so the card reads as progress toward waking
  // rather than as something draining away.
  const percent = live ? Math.max(0, Math.min(100, ((totalMs - remainingMs) / totalMs) * 100)) : 100

  const endedAt = snapshot.endedAt ? new Date(snapshot.endedAt) : null
  const endedLabel = endedAt
    ? endedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : ''
  const spentSeconds = snapshot.endedAt
    ? (snapshot.endedAt - snapshot.startedAt) / 1000
    : snapshot.seconds

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending || !snapshot.conversationId) return
    setSending(true)
    try {
      // The pending bubble is drawn by Chat.tsx's `chat:interjection`
      // listener when main echoes this back — no optimistic copy here, or
      // the message would appear twice.
      const { status } = await window.api.chat.interject({
        conversationId: snapshot.conversationId,
        messageId: crypto.randomUUID(),
        text,
        attachments: []
      })
      // A run that ended behind a stale card refuses the message, and nothing
      // echoes back — so clearing the draft here would delete what they typed
      // and show nothing for it. The composer drops its optimistic bubble on
      // the same verdict; this card has none, so it keeps the text instead.
      if (status === 'no_live_turn') return
      setDraft('')
    } catch {
      // A failed post leaves the draft in place to try again; the wait runs on.
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="border-border bg-surface flex w-full max-w-[85%] flex-col gap-2 self-start rounded-2xl border px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Clock01Icon size={15} className="text-muted shrink-0" aria-hidden />
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
              STATUS_COLOR[snapshot.status]
            )}
          >
            {t(`chat.wait.status.${snapshot.status}`)}
          </span>
          <span dir="auto" className="text-fg truncate font-medium">
            {snapshot.reason}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {live ? (
            <span dir="ltr" className="text-muted text-xs tabular-nums" aria-live="polite">
              {t('chat.wait.remaining', { duration: formatDuration(remainingMs / 1000) })}
            </span>
          ) : (
            endedLabel && (
              <span dir="ltr" className="text-muted text-xs tabular-nums">
                {endedLabel}
              </span>
            )
          )}
        </div>
      </div>

      {live && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="bg-bg border-border h-1.5 w-full overflow-hidden rounded-full border"
        >
          <div
            className="bg-accent h-full rounded-full transition-[width] duration-1000 ease-linear"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      <div className="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span dir="auto">
          {snapshot.status === 'waiting'
            ? t('chat.wait.waitingHint', { duration: formatDuration(snapshot.seconds) })
            : snapshot.status === 'elapsed'
              ? t('chat.wait.elapsedHint', { duration: formatDuration(snapshot.seconds) })
              : snapshot.status === 'interrupted'
                ? t('chat.wait.interruptedHint', { duration: formatDuration(spentSeconds) })
                : t('chat.wait.canceledHint', { duration: formatDuration(spentSeconds) })}
        </span>
      </div>

      {live && snapshot.conversationId && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <input
            dir="auto"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('chat.wait.inputPlaceholder')}
            aria-label={t('chat.wait.inputPlaceholder')}
            className={cn(
              'border-border bg-bg text-fg placeholder:text-muted h-9 min-w-0 flex-1 rounded-lg border px-3 text-xs',
              'focus-visible:ring-accent focus-visible:ring-2 focus-visible:outline-none'
            )}
          />
          {/* No greyed stub: with nothing to send there is nothing to press. */}
          {draft.trim().length > 0 && (
            <button
              type="submit"
              disabled={sending}
              aria-label={t('chat.wait.send')}
              title={t('chat.wait.send')}
              className="bg-primary text-primary-fg flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg enabled:hover:brightness-110 disabled:cursor-not-allowed"
            >
              <SentIcon size={16} aria-hidden />
            </button>
          )}
        </form>
      )}
    </div>
  )
}
