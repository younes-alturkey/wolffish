/**
 * The pending bubble — a mid-turn message the agent has not read yet.
 *
 * It is the user's own bubble (the feed's UserBubble, unchanged) with one
 * quiet caption and one control. The control is the part with a rule: it
 * renders only while the message can still be taken back, never as a greyed
 * stub once it cannot.
 */
import { ThemeContext } from '@/providers/theme/useTheme'
import { fireEvent, render, screen } from '@testing-library/react-native'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@/components/chat/MessageBubbles', () => {
  const { Text } = require('react-native')
  return {
    UserBubble: ({ message }: { message: { content: string } }) => (
      <Text testID="user-bubble">{message.content}</Text>
    )
  }
})

import { PendingInterjectionBubble } from '@/components/chat/PendingInterjections'
import '@/lib/i18n'

const message = { id: 'm_1', role: 'user' as const, content: 'skip the tests', timestamp: 1 }

async function draw(onWithdraw?: () => void): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <PendingInterjectionBubble
        message={message}
        conversationId="conv-1"
        onWithdraw={onWithdraw}
      />
    </ThemeContext.Provider>
  )
}

describe('the pending bubble', () => {
  it('is the user bubble with a caption and a withdraw control', async () => {
    const onWithdraw = jest.fn()
    await draw(onWithdraw)
    expect(screen.getByTestId('user-bubble').props.children).toBe('skip the tests')
    expect(screen.getByText('Read at the next step')).toBeTruthy()
    fireEvent.press(screen.getByLabelText('Withdraw message'))
    expect(onWithdraw).toHaveBeenCalledTimes(1)
  })

  it('renders no control at all when the message cannot be taken back', async () => {
    await draw(undefined)
    expect(screen.getByText('Read at the next step')).toBeTruthy()
    expect(screen.queryByLabelText('Withdraw message')).toBeNull()
  })
})
