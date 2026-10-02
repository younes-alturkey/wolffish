import { CopyButton } from '@components/core/CopyButton'
import { cn } from '@lib/utils/cn'
import hljs from 'highlight.js/lib/common'
import { useMemo } from 'react'

export function CodeBlock({
  content,
  language,
  tone = 'default',
  maxH = 'max-h-32',
  showCopy = true,
  className
}: {
  content: string
  language?: string
  tone?: 'default' | 'error'
  maxH?: string
  showCopy?: boolean
  className?: string
}): React.JSX.Element {
  const html = useMemo(() => {
    // Only highlight when the language is known. hljs.highlightAuto runs every
    // registered grammar to guess the language and is by far the dominant cost
    // when a conversation opens — tool outputs pass no language, so each one
    // would pay a full multi-grammar scan synchronously during render. When the
    // language is unknown we fall through to the plain <pre> below: far cheaper,
    // and visually fine (the .hljs container styling is kept either way).
    if (!language || !hljs.getLanguage(language)) return null
    try {
      return hljs.highlight(content, { language, ignoreIllegals: true }).value || null
    } catch {
      return null
    }
  }, [content, language])

  const preClasses = cn(
    'hljs border-border bg-bg overflow-y-auto rounded-md border px-3 py-2 text-left text-xs whitespace-pre-wrap wrap-break-word font-mono',
    showCopy && 'pe-12',
    tone === 'error' && 'border-red-500/40',
    maxH
  )

  return (
    <div className={cn('group/code relative', className)}>
      {html ? (
        <pre dir="ltr" className={preClasses} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre
          dir="ltr"
          className={cn(preClasses, tone === 'error' && 'text-red-600 dark:text-red-400')}
        >
          {content}
        </pre>
      )}
      {showCopy && (
        <CopyButton
          text={content}
          variant="overlay"
          ariaLabelKey="chat.copy"
          className="absolute inset-e-1.5 top-1.5 opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100"
        />
      )}
    </div>
  )
}
