import type { ThemeTokens } from '@/lib/theme/colors'
import { Platform, Text } from 'react-native'
import {
  MarkdownIt,
  stringToTokens,
  tokensToAST,
  type ASTNode
} from 'react-native-markdown-display'

/**
 * Markdown → ONE nested <Text> tree, plus the plain text it reads as.
 *
 * This exists for the select sheet, whose body has to be a TextInput: a
 * UITextView is the only view in React Native with a real selection cursor,
 * and a TextInput can hold no Views. So the document has to lose its boxes —
 * no bordered code block, no table grid — and keep everything an attributed
 * string can carry: weight, slant, size, colour, font. Block structure becomes
 * blank lines and literal list markers instead of layout.
 *
 * That is still much closer to the bubble than the raw source is, which is the
 * point: nobody wants to select out of `**bold**` and `| a | b |`.
 *
 * iOS assembles children into one NSAttributedString for the text view
 * (BaseTextInputShadowNode calls BaseTextShadowNode::buildAttributedString
 * over them), so selection runs across the whole document regardless of how
 * many fragments it is made of.
 *
 * The plain text is accumulated in the same walk rather than derived by a
 * second pass, so the string can never drift from what is on screen — it is
 * what Copy-all puts on the clipboard.
 */

const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
const SEMIBOLD = 'IBMPlexSansArabic-SemiBold'

const HEADING_SIZE: Record<string, number> = {
  heading1: 20,
  heading2: 18,
  heading3: 16,
  heading4: 15,
  heading5: 14,
  heading6: 14
}

type Piece = { node: React.ReactNode; text: string }

/** What a list_item needs from the list around it to draw its marker. */
type ListContext = { ordered: boolean; index: number } | undefined

function join(pieces: Piece[]): Piece {
  return { node: pieces.map((p) => p.node), text: pieces.map((p) => p.text).join('') }
}

/** A literal string that is both the node and the text — separators, markers. */
function literal(text: string, key: string): Piece {
  return { node: <Text key={key}>{text}</Text>, text }
}

function walk(nodes: ASTNode[], tokens: ThemeTokens, list: ListContext): Piece {
  return join(nodes.map((node, index) => render(node, tokens, list, index)))
}

function render(node: ASTNode, tokens: ThemeTokens, list: ListContext, index: number): Piece {
  const key = node.key ?? `n${index}`
  const kids = (context?: ListContext): Piece => walk(node.children ?? [], tokens, context)

  switch (node.type) {
    case 'text':
      return { node: <Text key={key}>{node.content}</Text>, text: node.content }

    case 'softbreak':
    case 'hardbreak':
      return literal('\n', key)

    case 'strong': {
      const inner = kids()
      return {
        node: (
          <Text key={key} style={{ fontFamily: SEMIBOLD }}>
            {inner.node}
          </Text>
        ),
        text: inner.text
      }
    }

    case 'em': {
      const inner = kids()
      return {
        node: (
          <Text key={key} style={{ fontStyle: 'italic' }}>
            {inner.node}
          </Text>
        ),
        text: inner.text
      }
    }

    case 's': {
      const inner = kids()
      return {
        node: (
          <Text key={key} style={{ textDecorationLine: 'line-through' }}>
            {inner.node}
          </Text>
        ),
        text: inner.text
      }
    }

    case 'link': {
      const inner = kids()
      // Coloured, not tappable: inside a TextInput the touch belongs to the
      // selection, which is the whole reason the reader opened this.
      return {
        node: (
          <Text key={key} style={{ color: tokens.accent, textDecorationLine: 'underline' }}>
            {inner.node}
          </Text>
        ),
        text: inner.text
      }
    }

    case 'code_inline':
      return {
        node: (
          <Text key={key} style={{ fontFamily: MONO_FONT, fontSize: 12.5 }}>
            {node.content}
          </Text>
        ),
        text: node.content
      }

    case 'fence':
    case 'code_block': {
      // Same surplus trailing newline the library's own rule trims.
      const content = node.content.endsWith('\n') ? node.content.slice(0, -1) : node.content
      return {
        node: (
          <Text key={key} style={{ fontFamily: MONO_FONT, fontSize: 12.5, color: tokens.muted }}>
            {content}
            {'\n\n'}
          </Text>
        ),
        text: `${content}\n\n`
      }
    }

    case 'heading1':
    case 'heading2':
    case 'heading3':
    case 'heading4':
    case 'heading5':
    case 'heading6': {
      const inner = kids()
      return {
        node: (
          <Text key={key} style={{ fontFamily: SEMIBOLD, fontSize: HEADING_SIZE[node.type] }}>
            {inner.node}
            {'\n\n'}
          </Text>
        ),
        text: `${inner.text}\n\n`
      }
    }

    case 'blockquote': {
      const inner = kids()
      return {
        node: (
          <Text key={key} style={{ color: tokens.muted, fontStyle: 'italic' }}>
            {inner.node}
          </Text>
        ),
        text: inner.text
      }
    }

    case 'paragraph': {
      const inner = kids(list)
      // A paragraph inside a list item is the item's own line — the item adds
      // the break, so adding one here too would double-space every list.
      const tail = list ? '' : '\n\n'
      return {
        node: (
          <Text key={key}>
            {inner.node}
            {tail}
          </Text>
        ),
        text: `${inner.text}${tail}`
      }
    }

    case 'bullet_list':
    case 'ordered_list': {
      const ordered = node.type === 'ordered_list'
      const items = (node.children ?? []).map((child, i) =>
        render(child, tokens, { ordered, index: i }, i)
      )
      const inner = join(items)
      return {
        node: (
          <Text key={key}>
            {inner.node}
            {'\n'}
          </Text>
        ),
        text: `${inner.text}\n`
      }
    }

    case 'list_item': {
      const marker = list ? (list.ordered ? `${list.index + 1}. ` : '• ') : '• '
      const inner = kids(list)
      return {
        node: (
          <Text key={key}>
            {marker}
            {inner.node}
            {'\n'}
          </Text>
        ),
        text: `${marker}${inner.text}\n`
      }
    }

    case 'hr':
      return literal('———\n\n', key)

    // A table loses its grid but keeps its reading order: cells separated on a
    // row, rows on their own lines. Better than the pipe syntax, which is what
    // the reader was trying to get away from.
    case 'tr': {
      const cells = (node.children ?? []).map((child, i) => render(child, tokens, undefined, i))
      const pieces: Piece[] = []
      cells.forEach((cell, i) => {
        if (i > 0) pieces.push(literal('   ', `${key}-sep${i}`))
        pieces.push(cell)
      })
      const inner = join(pieces)
      return {
        node: (
          <Text key={key}>
            {inner.node}
            {'\n'}
          </Text>
        ),
        text: `${inner.text}\n`
      }
    }

    case 'th': {
      const inner = kids()
      return {
        node: (
          <Text key={key} style={{ fontFamily: SEMIBOLD }}>
            {inner.node}
          </Text>
        ),
        text: inner.text
      }
    }

    case 'table': {
      const inner = kids()
      return {
        node: (
          <Text key={key}>
            {inner.node}
            {'\n'}
          </Text>
        ),
        text: `${inner.text}\n`
      }
    }

    // An image has no text of its own; its alt is the only thing worth keeping.
    case 'image': {
      const alt = typeof node.attributes?.alt === 'string' ? node.attributes.alt : ''
      if (!alt) return { node: null, text: '' }
      return {
        node: (
          <Text key={key} style={{ color: tokens.muted }}>
            {alt}
          </Text>
        ),
        text: alt
      }
    }

    // textgroup, td, thead, tbody, inline, span, body — structural only.
    default: {
      const inner = kids(list)
      return { node: <Text key={key}>{inner.node}</Text>, text: inner.text }
    }
  }
}

const md = MarkdownIt({ typographer: true })

/**
 * Parse `source` and return the styled tree to hand a TextInput as children,
 * alongside the exact plain text it renders as.
 */
export function flattenMarkdown(
  source: string,
  tokens: ThemeTokens
): { node: React.ReactNode; text: string } {
  let ast: ASTNode[] = []
  try {
    ast = tokensToAST(stringToTokens(source, md))
  } catch {
    // A document the parser chokes on is still worth reading — fall back to
    // the source itself rather than showing the reader nothing.
    return { node: <Text>{source}</Text>, text: source }
  }
  const { node, text } = walk(ast, tokens, undefined)
  // ONE root Text, always. TextInput only auto-wraps children when there is
  // more than one of them (TextInput.js), so a lone fragment would reach the
  // renderer bare and trip "Text strings must be rendered within a <Text>".
  return { node: <Text>{node}</Text>, text: text.replace(/\n+$/, '') }
}
