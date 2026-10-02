/**
 * DOM helpers over CDP for the in-app browser.
 *
 * Ported from wolffish-extension chrome-extension/src/background/cdp-dom.ts
 * (extension 0.1.66). The only change is the seam: where the source threaded a
 * Chrome `tabId` into `sendCDP(tabId, …)`, this threads a `CdpSend` bound to
 * the tab. Everything page-side — the selector resolver, the framework-safe
 * value setter, the fill recipe — is byte-for-byte the extension's, so a page
 * behaves the same under both browsers.
 *
 * No `electron` import here on purpose: the whole layer is a pure function
 * over a sender, which is what makes it testable with plain tsx.
 */
import type { CdpSend, FillKind, Rect } from '@main/browser/snapshot/types'

// ─── Remote-object plumbing ──────────────────────────────────────────────────

export interface RemoteObject {
  type: string
  subtype?: string
  value?: unknown
  description?: string
  objectId?: string
  unserializableValue?: string
}

export interface ExceptionDetails {
  text: string
  exception?: RemoteObject
  lineNumber?: number
  columnNumber?: number
}

export interface EvalResult {
  result: RemoteObject
  exceptionDetails?: ExceptionDetails
}

/** The first line of a page-side throw, minus the constructor prefix — so `throw new Error('x')` surfaces as `x`. */
export const exceptionMessage = (d: ExceptionDetails): string => {
  const raw =
    d.exception?.description ??
    (d.exception?.value !== undefined ? String(d.exception.value) : d.text)
  const first = String(raw).split('\n')[0]
  return first.replace(
    /^(Error|TypeError|RangeError|SyntaxError|ReferenceError|DOMException): /,
    ''
  )
}

export const unwrap = (res: EvalResult): unknown => {
  if (res.exceptionDetails) throw new Error(exceptionMessage(res.exceptionDetails))
  const r = res.result
  if (r.unserializableValue !== undefined) return r.unserializableValue
  if (r.value !== undefined) return r.value
  if (r.type === 'undefined' || r.subtype === 'null') return r.subtype === 'null' ? null : undefined
  return r.description
}

/** Live handle for a backend node; throws the CDP "no node" error when it is gone. */
export const resolveObjectId = async (send: CdpSend, backendNodeId: number): Promise<string> => {
  const res = (await send('DOM.resolveNode', { backendNodeId })) as { object: RemoteObject }
  if (!res.object.objectId) throw new Error('No node with given id found')
  return res.object.objectId
}

export const releaseObject = (send: CdpSend, objectId: string): void => {
  send('Runtime.releaseObject', { objectId }).catch(() => {})
}

/**
 * Run a self-contained page function with the element as its first argument.
 * The function is serialised with `toString()`, so it must not close over
 * anything.
 */
export const callOnNode = async <T>(
  send: CdpSend,
  backendNodeId: number,
  fn: (...args: never[]) => unknown,
  args: unknown[] = []
): Promise<T> => {
  const objectId = await resolveObjectId(send, backendNodeId)
  try {
    const res = (await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(...args) { return (${fn.toString()})(this, ...args); }`,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true
    })) as EvalResult
    return unwrap(res) as T
  } finally {
    releaseObject(send, objectId)
  }
}

/** Evaluate an expression in the page, by value. */
export const evaluate = async <T>(send: CdpSend, expression: string): Promise<T> => {
  const res = (await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })) as EvalResult
  return unwrap(res) as T
}

// ─── Selector → backendNodeId ────────────────────────────────────────────────

/**
 * `text=` picks the deepest visible match (exact beats substring); invalid
 * CSS throws the deterministic validation phrase. Runs in the page.
 */
const findBySelectorInPage = (sel: string): Element | null => {
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const isVisible = (e: HTMLElement): boolean => {
    if (e.offsetParent !== null) return true
    const st = getComputedStyle(e)
    return st.display !== 'none' && st.visibility !== 'hidden'
  }
  if (sel.startsWith('text=')) {
    const needle = normalize(sel.slice('text='.length).replace(/^(["'])([\s\S]*)\1$/, '$2'))
    if (!needle) return null
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'WOLFFISH-OVERLAY'])
    const exact: HTMLElement[] = []
    const partial: HTMLElement[] = []
    const all = document.body ? Array.from(document.body.getElementsByTagName('*')) : []
    for (const node of all) {
      const e = node as HTMLElement
      if (SKIP.has(e.tagName)) continue
      const t = normalize(e.textContent ?? '')
      if (!t || t.length > needle.length + 200) continue
      if (t === needle) exact.push(e)
      else if (t.includes(needle)) partial.push(e)
    }
    const pool = exact.length > 0 ? exact : partial
    const deepest = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)))
    return deepest.find(isVisible) ?? null
  }
  try {
    return document.querySelector(sel)
  } catch {
    throw new Error(
      `selector syntax is incorrect: '${sel}' is not valid CSS. Use a CSS selector, or text=<visible text> to target by text.`
    )
  }
}

export const resolveSelectorNode = async (send: CdpSend, selector: string): Promise<number> => {
  const res = (await send('Runtime.evaluate', {
    expression: `(${findBySelectorInPage.toString()})(${JSON.stringify(selector)})`,
    returnByValue: false
  })) as EvalResult
  if (res.exceptionDetails) throw new Error(exceptionMessage(res.exceptionDetails))
  const objectId = res.result.objectId
  if (!objectId || res.result.subtype === 'null') throw new Error(`Element not found: ${selector}`)
  try {
    const desc = (await send('DOM.describeNode', { objectId })) as {
      node: { backendNodeId: number }
    }
    return desc.node.backendNodeId
  } finally {
    releaseObject(send, objectId)
  }
}

// ─── Geometry ────────────────────────────────────────────────────────────────

export const quadToRect = (quad: number[]): Rect => {
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

const rectFromPage = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/**
 * Viewport-relative CSS rect. `DOM.getBoxModel` is main-frame relative even
 * for nodes inside same-origin iframes; the page-side fallback covers nodes
 * the box model refuses (display:contents, some SVG).
 */
export const nodeRect = async (send: CdpSend, backendNodeId: number): Promise<Rect> => {
  try {
    const res = (await send('DOM.getBoxModel', { backendNodeId })) as {
      model: { content: number[] }
    }
    return quadToRect(res.model.content)
  } catch {
    return callOnNode<Rect>(send, backendNodeId, rectFromPage)
  }
}

export const scrollNodeIntoView = async (send: CdpSend, backendNodeId: number): Promise<void> => {
  try {
    await send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // "Node does not have a layout object" is a hidden node, not a missing one — leave it to the caller.
    if (/no node|not found|could not find/i.test(message)) throw err
    await callOnNode(send, backendNodeId, (el: Element) =>
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
    ).catch(() => {})
  }
}

export const center = (rect: Rect): { x: number; y: number } => ({
  x: Math.round(rect.x + rect.width / 2),
  y: Math.round(rect.y + rect.height / 2)
})

// ─── Page-side element operations ────────────────────────────────────────────

export const focusInPage = (el: HTMLElement): void => el.focus()

export const nodeHrefInPage = (el: Element): string | null =>
  (el.closest('a') as HTMLAnchorElement | null)?.href || null

export const clearInPage = (el: HTMLElement): void => {
  el.focus()
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, '')
    else (el as HTMLInputElement).value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else if (el.isContentEditable) {
    document.execCommand('selectAll', false)
    document.execCommand('delete', false)
  }
}

export const getValueInPage = (el: HTMLInputElement): { value: string; type: string } => ({
  value: el.value ?? '',
  type: el.type || el.tagName.toLowerCase()
})

export const selectInPage = (el: HTMLSelectElement, value: string): { success: boolean } => {
  if (el.tagName !== 'SELECT')
    throw new Error(`Element is not a <select>: <${el.tagName.toLowerCase()}>`)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { success: true }
}

/** The framework-safe fill: native prototype setter + input + change. */
export const fillInPage = (
  el: HTMLElement,
  value: string
): { success: boolean; value: string; kind: FillKind } => {
  const tag = el.tagName
  const fire = (type: string): void => {
    el.dispatchEvent(new Event(type, { bubbles: true }))
  }
  el.focus()
  if (tag === 'SELECT') {
    const select = el as HTMLSelectElement
    const wanted = value.trim().toLowerCase()
    const option = Array.from(select.options).find(
      (o) =>
        o.value.trim().toLowerCase() === wanted ||
        (o.textContent ?? '').trim().toLowerCase() === wanted
    )
    if (!option) throw new Error(`No option matches "${value}" in the <select>.`)
    select.value = option.value
    fire('input')
    fire('change')
    return { success: true, value: option.value, kind: 'select' }
  }
  if (
    tag === 'INPUT' &&
    ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio')
  ) {
    if (value !== 'true' && value !== 'false')
      throw new Error('Checkbox/radio values must be "true" or "false".')
    const input = el as HTMLInputElement
    const kind: FillKind = input.type === 'checkbox' ? 'checkbox' : 'radio'
    if (input.checked !== (value === 'true')) {
      input.click()
      if (input.checked !== (value === 'true')) {
        input.checked = value === 'true'
        fire('input')
        fire('change')
      }
    }
    return { success: true, value, kind }
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else (el as HTMLInputElement).value = value
    fire('input')
    fire('change')
    return { success: true, value, kind: tag === 'TEXTAREA' ? 'textarea' : 'input' }
  }
  if (el.isContentEditable) {
    document.execCommand('selectAll', false)
    document.execCommand('insertText', false, value)
    fire('input')
    return { success: true, value, kind: 'contenteditable' }
  }
  throw new Error(`Element is not fillable (tag <${tag.toLowerCase()}>).`)
}

export const anchorClickInPage = (el: Element): void => {
  const anchor = el.closest('a')
  if (anchor) anchor.click()
}

/** Visible text of the page, the way a reader would get it. */
export const readTextInPage = (): { title: string; text: string } => {
  const root =
    (document.querySelector('main, article, [role="main"]') as HTMLElement | null) ?? document.body
  return { title: document.title, text: (root?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim() }
}
