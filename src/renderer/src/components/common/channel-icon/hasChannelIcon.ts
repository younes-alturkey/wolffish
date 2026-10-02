import type { ConversationChannel } from '@preload/index'

/**
 * The channels ChannelIcon renders a glyph for — keep in sync with the switch
 * in ChannelIcon.tsx. In-app conversations (`electron` / absent) are omitted:
 * the app is the default, not a badge. Split out of the .tsx so it can be
 * imported without tripping react-refresh's component-only-export rule.
 */
const CHANNEL_ICON_KINDS: ReadonlySet<string> = new Set([
  'telegram',
  'whatsapp',
  'mobile',
  'cli',
  'heartbeat',
  'procedure'
])

/** Whether ChannelIcon renders anything for this channel (drives badge chrome). */
export function hasChannelIcon(channel?: ConversationChannel | string | null): boolean {
  return typeof channel === 'string' && CHANNEL_ICON_KINDS.has(channel)
}
