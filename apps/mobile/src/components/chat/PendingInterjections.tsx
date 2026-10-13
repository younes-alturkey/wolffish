import { CancelCircleIcon, Clock01Icon } from '@/components/core/icons'
import { UserBubble } from '@/components/chat/MessageBubbles'
import type { ConversationMessage } from '@/lib/conversations/types'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

/**
 * A message sent while a turn was running, waiting for the agent to read it.
 *
 * It is NOT a queue row. The message has already left the phone — it is
 * parked in the desktop's turn runner and the agent reads it at its next
 * stop point, the way a colleague reads a note slid under the door between
 * two tasks. So it is drawn where a sent message is drawn: as the user's own
 * bubble, in the feed, after the assistant row whose turn it is steering —
 * with one quiet line saying it has not been read yet, and the one control
 * that still applies: taking it back before it is.
 *
 * Once the agent reads it the desktop mirrors a `user_message` segment under
 * the same id, the feed drops this row (conversations/feed.ts), and the same
 * bubble appears INSIDE the assistant card at the point it was read.
 */
export function PendingInterjectionBubble({
  message,
  conversationId,
  onWithdraw
}: {
  message: ConversationMessage
  conversationId?: string
  /** Take the message back. Absent once it can no longer be taken back. */
  onWithdraw?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <View className="flex-col gap-1" testID="pending-interjection">
      <UserBubble message={message} conversationId={conversationId} />
      <View className="flex-row items-center gap-1.5 self-end">
        <Clock01Icon size={11} className="text-muted" />
        <Text className="text-muted font-sans text-[10px]">{t('chat.interject.pending')}</Text>
        {onWithdraw && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.interject.withdraw')}
            hitSlop={8}
            onPress={onWithdraw}
            className="p-1"
          >
            <CancelCircleIcon size={13} className="text-muted" />
          </Pressable>
        )}
      </View>
    </View>
  )
}
