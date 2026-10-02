import { defaultSchema } from 'rehype-sanitize'

/**
 * Sanitize schema for raw HTML inside chat markdown — shared by the feed's
 * Markdown component and the PDF export so both render the same subset.
 *
 * Model replies are untrusted markup: rehype-raw parses whatever HTML they
 * contain, and this schema decides what survives. The base is GitHub's
 * allowlist (`defaultSchema`), which keeps structural/semantic tags —
 * details/summary, sub/sup, kbd, mark, abbr, br, tables — and strips
 * scripts, styles, iframes, event handlers, and javascript: URLs. Unknown
 * tags are dropped but their text children survive, so a stray pseudo-tag
 * degrades to its content instead of leaking angle brackets.
 *
 * On top of the base:
 *  - `wolffish-media:` is a valid image source (the workspace media
 *    protocol the feed already allows via urlTransform);
 *  - `open` stays on <details> so pre-expanded sections work;
 *  - `<mark>` is allowed (semantic highlight — not in GitHub's base list).
 */
export const MARKDOWN_SANITIZE_SCHEMA: typeof defaultSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'mark'],
  attributes: {
    ...defaultSchema.attributes,
    details: [...(defaultSchema.attributes?.details ?? []), 'open']
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'wolffish-media']
  }
}
