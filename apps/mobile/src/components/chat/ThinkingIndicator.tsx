import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/**
 * The desktop's "thinking" bubble: shuffled thinking-words typed
 * character-by-character (50ms/char), each held ~2s before the next.
 */

const TYPE_TICK_MS = 50
const HOLD_MS = 2000

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function ThinkingIndicator(): React.JSX.Element {
  const { t } = useTranslation()
  const words = useMemo(() => {
    const list = t('chat.thinkingWords', { returnObjects: true })
    return shuffled(Array.isArray(list) ? (list as string[]) : [t('chat.thinking')])
  }, [t])
  const [text, setText] = useState('')
  const wordIndex = useRef(0)
  const charIndex = useRef(0)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = (): void => {
      const word = words[wordIndex.current % words.length]
      if (charIndex.current < word.length) {
        charIndex.current += 1
        setText(word.slice(0, charIndex.current))
        timer = setTimeout(tick, TYPE_TICK_MS)
      } else {
        timer = setTimeout(() => {
          wordIndex.current += 1
          charIndex.current = 0
          setText('')
          tick()
        }, HOLD_MS)
      }
    }
    tick()
    return () => clearTimeout(timer)
  }, [words])

  return (
    <View className="bg-surface border-border max-w-[85%] self-start rounded-2xl border px-4 py-2.5">
      <Text className="text-muted text-left font-sans text-sm">{text || ' '}…</Text>
    </View>
  )
}
