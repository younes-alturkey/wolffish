import {
  Activity04Icon,
  ComputerTerminal01Icon,
  PlayIcon,
  SmartPhone01Icon,
  TelegramLogo,
  WhatsAppLogo
} from '@/components/core/icons'
import type { ConversationChannel } from '@/lib/conversations/types'
import { Text } from 'react-native'

/**
 * Where a conversation came from, as one glyph — the desktop's ChannelIcon,
 * under the desktop's precedence: a source emoji (a project's icon, an
 * automation's) wins outright, because it says something the row cannot say
 * twice over. The channel badge is the fallback, and `mobile` and `cli` sit in
 * it with the rest — a conversation started on the phone shows a phone, one
 * started in a terminal shows a terminal, unless either has an emoji of its own
 * to show instead. In-app conversations show nothing: the app is the default,
 * not a badge.
 *
 * Shared by every surface that lists conversations (History, the conversations
 * sheet) so one origin can never read as two different things.
 */
export function ChannelBadge({
  icon,
  channel,
  size = 14
}: {
  /** The conversation's source emoji, if it has one. */
  icon?: string | null
  channel?: ConversationChannel | null
  /** Glyph size in points — the emoji tracks it through fontSize. */
  size?: number
}): React.JSX.Element | null {
  if (icon) {
    return (
      <Text className="text-left" style={{ fontSize: size, lineHeight: size + 2 }}>
        {icon}
      </Text>
    )
  }
  switch (channel) {
    case 'telegram':
      return <TelegramLogo size={size} className="text-muted" />
    case 'whatsapp':
      return <WhatsAppLogo size={size} className="text-muted" />
    case 'mobile':
      return <SmartPhone01Icon size={size} className="text-muted" />
    case 'cli':
      return <ComputerTerminal01Icon size={size} className="text-muted" />
    case 'heartbeat':
      return <Activity04Icon size={size} className="text-muted" />
    case 'procedure':
      return <PlayIcon size={size} className="text-muted" />
    default:
      return null
  }
}
