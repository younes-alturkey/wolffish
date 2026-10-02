import { CopyButton } from '@components/core/CopyButton'
import { MARKDOWN_SANITIZE_SCHEMA } from '@lib/markdown/sanitize'
import { cn } from '@lib/utils/cn'
import { Download01Icon, FolderOpenIcon } from 'hugeicons-react'
import { createContext, memo, useContext, type ReactNode } from 'react'
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
  type Options
} from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

/**
 * True while rendering the children of a fenced block. A fence with no language
 * tag yields a <code> with no `language-` class, so class sniffing alone would
 * style it as inline code and paint a second, content-width background inside
 * the <pre> (visible as a darker inner box in light mode). Position, not class,
 * decides block-ness.
 */
const InPreContext = createContext(false)

function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props
    return props ? extractText(props.children) : ''
  }
  return ''
}

/**
 * A `<code>` — a block when it sits inside a fence (position, via
 * InPreContext) or carries a `language-` class, an inline chip otherwise.
 * Declared as a named component rather than inline in the map below because
 * the context hook may only be read from one.
 */
function CodeElement({
  children,
  className,
  ...rest
}: React.ComponentProps<'code'> & ExtraProps): React.JSX.Element {
  const isBlock = useContext(InPreContext) || /\blanguage-/.test(className ?? '')
  if (isBlock) {
    return (
      <code dir="ltr" className={cn('font-mono', className)} {...rest}>
        {children}
      </code>
    )
  }
  return (
    <code
      dir="ltr"
      className="bg-border/40 text-fg inline-block max-w-full rounded px-1 py-0.5 font-mono text-[0.85em] wrap-anywhere"
      {...rest}
    >
      {children}
    </code>
  )
}

const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0 leading-relaxed">{children}</p>,
  h1: ({ children }) => (
    <h1 className="text-fg mt-4 mb-2 text-xl font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-fg mt-4 mb-2 text-lg font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-fg mt-3 mb-2 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-fg mt-3 mb-2 text-sm font-semibold first:mt-0">{children}</h4>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 ps-6 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 ps-6 first:mt-0 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline underline-offset-2 hover:brightness-110"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-border text-muted my-2 border-s-2 ps-3 italic first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border/60 my-3" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table className="border-border w-full border-collapse border text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-bg/50">{children}</thead>,
  th: ({ children }) => (
    <th className="border-border min-w-28 border px-2 py-1 text-start font-semibold whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-border min-w-28 border px-2 py-1 align-top wrap-anywhere">{children}</td>
  ),
  pre: ({ children, className }) => {
    const text = extractText(children).replace(/\n$/, '')
    return (
      <div dir="ltr" className="group relative my-2 text-left first:mt-0 last:mb-0">
        <CopyButton
          text={text}
          variant="overlay"
          ariaLabelKey="chat.copyCode"
          className="absolute inset-e-2 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        />
        <pre
          dir="ltr"
          className={cn(
            'bg-bg border-border text-fg overflow-x-auto rounded-lg border p-3 text-[0.85em] leading-relaxed text-left',
            className
          )}
        >
          <InPreContext.Provider value={true}>{children}</InPreContext.Provider>
        </pre>
      </div>
    )
  },
  code: CodeElement,
  img: ({ src, alt }) => {
    if (!src) return null
    const relativePath = src.startsWith('wolffish-media://')
      ? src.slice('wolffish-media://'.length)
      : null
    return (
      <span className="group relative block w-fit max-w-full leading-none">
        <img src={src} alt={alt ?? ''} className="block max-w-full rounded-2xl" loading="lazy" />
        {relativePath && (
          <span
            className={cn(
              'absolute inset-e-2 top-2 flex items-center gap-1',
              'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
            )}
          >
            <button
              type="button"
              onClick={() => void window.api.upload.revealInFolder(relativePath)}
              aria-label="Reveal in folder"
              className={cn(
                'flex h-7 w-7 cursor-pointer items-center justify-center',
                'rounded-md bg-bg/80 text-fg shadow-sm backdrop-blur-sm',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-transparent'
              )}
            >
              <FolderOpenIcon size={14} />
            </button>
            <button
              type="button"
              onClick={() => void window.api.upload.download(relativePath)}
              aria-label="Download"
              className={cn(
                'flex h-7 w-7 cursor-pointer items-center justify-center',
                'rounded-md bg-bg/80 text-fg shadow-sm backdrop-blur-sm',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-transparent'
              )}
            >
              <Download01Icon size={14} />
            </button>
          </span>
        )}
      </span>
    )
  },
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  // Raw-HTML disclosure sections (rehype-raw + sanitize keep these) — the
  // one collapsible primitive replies can use.
  details: ({ children, open }) => (
    <details
      open={open}
      className="border-border bg-bg/40 my-2 rounded-xl border px-3 py-2 first:mt-0 last:mb-0"
    >
      {children}
    </details>
  ),
  summary: ({ children }) => (
    <summary className="text-fg cursor-pointer font-medium select-none">{children}</summary>
  )
}

/**
 * Raw HTML in replies is parsed (rehype-raw) then reduced to a safe subset
 * (rehype-sanitize with the shared schema) — collapsible details/summary,
 * sub/sup/kbd/mark and friends render; scripts, iframes, styles, and event
 * handlers are stripped, and unknown tags degrade to their text content.
 * Highlight runs AFTER sanitize so its hljs- span classes survive.
 */
const rehypePlugins: Options['rehypePlugins'] = [
  rehypeRaw,
  [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA],
  [rehypeHighlight, { detect: false, ignoreMissing: true }]
]

function urlTransform(url: string): string {
  if (url.startsWith('wolffish-media://')) return url
  return defaultUrlTransform(url)
}

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      components={components}
      urlTransform={urlTransform}
    >
      {content}
    </ReactMarkdown>
  )
})
