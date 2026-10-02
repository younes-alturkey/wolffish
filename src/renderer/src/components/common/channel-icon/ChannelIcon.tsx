import { TelegramLogo, WhatsAppLogo } from '@components/core/ProviderLogos'
import type { ConversationChannel } from '@preload/index'
import { Activity04Icon, ComputerTerminal01Icon, PlayIcon, SmartPhone01Icon } from 'hugeicons-react'

/**
 * The origin glyph for a conversation — Telegram / WhatsApp / the phone / the
 * terminal / an automation (heartbeat) / a procedure run. In-app conversations
 * (`electron`, or the absent legacy value) show nothing: the app is the
 * default, not a badge worth calling out. One mapping, shared by the History
 * list and the conversations rail so the two can never drift.
 *
 * `channel` is typed loosely because the live run-status broadcast carries it
 * as a bare string; an unrecognized value simply renders nothing.
 */
export function ChannelIcon({
  channel,
  size = 12,
  className
}: {
  channel?: ConversationChannel | string | null
  size?: number
  className?: string
}): React.JSX.Element | null {
  switch (channel) {
    case 'heartbeat':
      return <Activity04Icon size={size} className={className} aria-label="Automated" />
    case 'procedure':
      return <PlayIcon size={size} className={className} aria-label="Procedure" />
    case 'telegram':
      return <TelegramLogo size={size} className={className} aria-label="Telegram" />
    case 'whatsapp':
      return <WhatsAppLogo size={size} className={className} aria-label="WhatsApp" />
    case 'mobile':
      return <SmartPhone01Icon size={size} className={className} aria-label="Phone" />
    case 'cli':
      return <ComputerTerminal01Icon size={size} className={className} aria-label="Terminal" />
    default:
      return null
  }
}
