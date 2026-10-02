import { ContextMenuPopup, type ContextMenuEntry } from '@components/core/ContextMenu'
import type { SpellcheckContextMenu } from '@preload/index'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Position = { x: number; y: number }
type Translate = (key: string) => string

// Input types that hold editable text. Non-text controls (checkbox, file,
// button, range, color, date…) are intentionally excluded — a copy/paste menu
// makes no sense there.
const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'url',
  'tel',
  'password',
  'email',
  'number'
])

type Field =
  | { kind: 'value'; el: HTMLInputElement | HTMLTextAreaElement; editable: boolean }
  | { kind: 'contenteditable'; el: HTMLElement; editable: boolean }
  // Read-only prose (chat bubbles, reasoning, any static text). `root` is the
  // nearest [data-select-root] ancestor — the block "Select all" selects — or
  // null when the right-click only has a live selection to offer Copy for.
  | { kind: 'static'; root: HTMLElement | null }

/** Resolve the editable field under the event target, or null if there isn't one. */
function resolveField(target: EventTarget | null): Field | null {
  if (!(target instanceof Element)) return null
  if (target instanceof HTMLTextAreaElement) {
    return { kind: 'value', el: target, editable: !target.disabled && !target.readOnly }
  }
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) {
    return { kind: 'value', el: target, editable: !target.disabled && !target.readOnly }
  }
  const ce = target.closest<HTMLElement>('[contenteditable]')
  if (ce) {
    return {
      kind: 'contenteditable',
      el: ce,
      editable: ce.getAttribute('contenteditable') !== 'false'
    }
  }
  return null
}

/**
 * Selection range for inputs/textareas, or null when the control doesn't expose
 * one (e.g. number/email inputs return null and may throw on access).
 */
function readRange(
  el: HTMLInputElement | HTMLTextAreaElement
): { start: number; end: number } | null {
  try {
    const { selectionStart, selectionEnd } = el
    if (selectionStart === null || selectionEnd === null) return null
    return { start: selectionStart, end: selectionEnd }
  } catch {
    return null
  }
}

/**
 * Set a value the way React expects for controlled inputs: write through the
 * native prototype setter (bypassing React's instance-level value tracker) and
 * dispatch a bubbling 'input' event so the owning component's onChange fires and
 * its state stays in sync. Plain uncontrolled inputs are updated all the same.
 */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function valueItems(
  el: HTMLInputElement | HTMLTextAreaElement,
  editable: boolean,
  t: Translate
): ContextMenuEntry[] {
  const range = readRange(el)
  const hasSelection = range ? range.start !== range.end : false
  return [
    {
      label: t('common.contextMenu.selectAll'),
      action: () => {
        el.focus()
        el.select()
      },
      disabled: !el.value
    },
    {
      label: t('common.contextMenu.copy'),
      action: () => {
        const text = hasSelection && range ? el.value.slice(range.start, range.end) : el.value
        void navigator.clipboard.writeText(text)
      },
      disabled: !el.value
    },
    {
      label: t('common.contextMenu.paste'),
      action: async () => {
        const text = await navigator.clipboard.readText()
        if (!text) return
        el.focus()
        const r = readRange(el)
        if (r) {
          setValue(el, el.value.slice(0, r.start) + text + el.value.slice(r.end))
          const caret = r.start + text.length
          el.setSelectionRange(caret, caret)
        } else {
          setValue(el, text)
        }
      },
      disabled: !editable
    },
    { separator: true as const },
    {
      label: t('common.contextMenu.clear'),
      action: () => {
        el.focus()
        setValue(el, '')
      },
      disabled: !editable || !el.value
    }
  ]
}

function staticItems(root: HTMLElement | null, t: Translate): ContextMenuEntry[] {
  const selected = window.getSelection()?.toString() ?? ''
  const content = root?.textContent ?? ''
  return [
    {
      label: t('common.contextMenu.selectAll'),
      action: () => {
        if (!root) return
        const range = document.createRange()
        range.selectNodeContents(root)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      },
      disabled: !content
    },
    {
      label: t('common.contextMenu.copy'),
      action: () => {
        // The popup's mousedown preventDefault keeps the selection alive
        // until this click handler runs, so re-reading it here is safe.
        const text = window.getSelection()?.toString() || content
        if (text) void navigator.clipboard.writeText(text)
      },
      disabled: !selected && !content
    }
  ]
}

function contentEditableItems(
  el: HTMLElement,
  editable: boolean,
  t: Translate
): ContextMenuEntry[] {
  const content = el.textContent ?? ''
  return [
    {
      label: t('common.contextMenu.selectAll'),
      action: () => {
        el.focus()
        document.execCommand('selectAll')
      },
      disabled: !content
    },
    {
      label: t('common.contextMenu.copy'),
      action: () => {
        const selected = window.getSelection()?.toString()
        void navigator.clipboard.writeText(selected || content)
      },
      disabled: !content
    },
    {
      label: t('common.contextMenu.paste'),
      action: async () => {
        const text = await navigator.clipboard.readText()
        if (!text) return
        el.focus()
        document.execCommand('insertText', false, text)
      },
      disabled: !editable
    },
    { separator: true as const },
    {
      label: t('common.contextMenu.clear'),
      action: () => {
        el.focus()
        document.execCommand('selectAll')
        document.execCommand('delete')
      },
      disabled: !editable || !content
    }
  ]
}

/**
 * Spelling correction rows, built from the payload the main process relayed off
 * Chromium's `context-menu` event. Empty when the word under the cursor isn't
 * misspelled. Each suggestion calls the native `replaceMisspelling` command (which
 * targets the word the right-click selected), then an "Add to dictionary" entry and
 * a separator above the standard Copy/Paste items.
 */
function spellingItems(params: SpellcheckContextMenu, t: Translate): ContextMenuEntry[] {
  const word = params.misspelledWord
  if (!word) return []
  const suggestions = params.dictionarySuggestions.slice(0, 6)
  const rows: ContextMenuEntry[] = suggestions.length
    ? suggestions.map((s) => ({ label: s, action: () => void window.api.spellcheck.replace(s) }))
    : [{ label: t('common.contextMenu.noSuggestions'), action: () => {}, disabled: true }]
  rows.push({
    label: t('common.contextMenu.addToDictionary'),
    action: () => void window.api.spellcheck.addToDictionary(word)
  })
  rows.push({ separator: true as const })
  return rows
}

/**
 * App-wide right-click menu (spelling corrections + Select all / Copy / Paste /
 * Clear) for every text input, textarea and contenteditable surface, plus a
 * read-only Select all / Copy menu for static text — any [data-select-root]
 * block (chat bubbles, reasoning) or any right-click while a selection exists.
 * Mounted once at the root: a single delegated listener covers the whole tree.
 *
 * Spelling suggestions exist only in the main-process `context-menu` event, and the
 * page calling preventDefault on the DOM event would suppress it — so this is
 * main-driven: the DOM 'contextmenu' event (which fires first) records WHICH field
 * and where, then the relayed spellcheck payload triggers the menu. We deliberately
 * do NOT preventDefault, so Chromium still fires its event and selects the misspelled
 * word for replaceMisspelling to act on. Surfaces that render their own menu (e.g.
 * MarkdownContent) preventDefault, which suppresses the payload, so ours never opens
 * there — and their targets aren't editable fields anyway.
 */
export function InputContextMenu(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<{ position: Position; items: ContextMenuEntry[] } | null>(null)
  const close = useCallback(() => setState(null), [])
  const pending = useRef<{ field: Field; position: Position } | null>(null)

  // Record the target on the DOM event (capture phase, before any bubble-phase
  // preventDefault). No preventDefault here — the main event must still fire.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      const position = { x: e.clientX, y: e.clientY }
      const field = resolveField(e.target)
      if (field) {
        pending.current = { field, position }
        return
      }
      // Read-only text: chat prose and other static copy get Select all + Copy.
      // Only surface a menu when there's a marked block to select or an existing
      // selection to copy — right-clicks on plain chrome stay silent.
      const root =
        e.target instanceof Element ? e.target.closest<HTMLElement>('[data-select-root]') : null
      const hasSelection = (window.getSelection()?.toString() ?? '').length > 0
      pending.current = root || hasSelection ? { field: { kind: 'static', root }, position } : null
    }
    document.addEventListener('contextmenu', onContextMenu, true)
    return () => document.removeEventListener('contextmenu', onContextMenu, true)
  }, [])

  // The relayed payload always follows its own right-click, so `pending` is fresh.
  useEffect(() => {
    return window.api.spellcheck.onContextMenu((params) => {
      const target = pending.current
      pending.current = null
      if (!target) return
      const { field, position } = target
      if (field.kind === 'static') {
        setState({ position, items: staticItems(field.root, t) })
        return
      }
      const base =
        field.kind === 'value'
          ? valueItems(field.el, field.editable, t)
          : contentEditableItems(field.el, field.editable, t)
      const items = field.editable ? [...spellingItems(params, t), ...base] : base
      setState({ position, items })
    })
  }, [t])

  if (!state) return null
  return <ContextMenuPopup items={state.items} position={state.position} onClose={close} />
}
