import type { ChatMessage, UserContentBlock } from '@main/runtime/thalamus'

/**
 * Vision is the capability gate for multimodal content — it decides
 * whether image (and PDF document) blocks may travel to a given model.
 *
 * Maps to: the visual cortex — signals that the eyes can't process
 * never reach it.
 *
 * Text-only provider APIs hard-reject multimodal content parts. DeepSeek,
 * for example, answers HTTP 400 `This model does not support image` the
 * moment an image part appears in `messages`, which kills the entire
 * turn. There is no reliable cross-provider capability endpoint, and model
 * catalogs change faster than any exhaustive table could track — so this
 * module only recognizes the *well-known* vision families and treats
 * everything else as text-only. The asymmetry justifies the conservative
 * default: a wrongly-stripped image degrades one answer and says so in the
 * prompt; a wrongly-sent image fails the whole request.
 *
 * When a new vision model shows up as text-only here, add its family
 * pattern below — the stripped-content note in the transcript makes the
 * misclassification visible.
 */

// Vendor-agnostic name markers. Vendors consistently tag their multimodal
// models: Qwen-VL / Kimi-VL / MiniMax-VL / MiMo-VL ("vl" as a hyphenated
// token), *-vision-*, *-omni, QVQ, and the open-weight llava/pixtral
// families served through OpenRouter.
const VISION_NAME_MARKERS = /vision|omni|llava|pixtral|qvq|(^|[-/_.:])vl([-/_.:]|$)/

export function cloudModelSupportsVision(provider: string, model: string): boolean {
  const m = model.toLowerCase()
  if (VISION_NAME_MARKERS.test(m)) return true
  switch (provider) {
    case 'anthropic':
      // Every Claude chat model since Claude 3 accepts image blocks.
      return true
    case 'openai':
      return openaiSupportsVision(m)
    case 'deepseek':
      // `deepseek-flash` (= DeepSeek-V4.1-Flash, no version or `vision`
      // marker in the id) reads images — verified live 2026-09-11 with a
      // three-stripe PNG it names in order every run. The retired
      // v4-flash / chat / reasoner ids are aliases served by the same model.
      // deepseek-v4-pro is the last text-only model, and it no longer 400s
      // on an image: it answers HTTP 200 with a guess (same stripe probe,
      // different wrong colours each run), so this gate is its only guard.
      return /^deepseek-(flash|v4-flash|v4-flash-vision-exp|chat|reasoner)$/.test(m)
    case 'xai':
      // grok-2-vision and friends are caught by the markers above;
      // grok-4 onward is multimodal without a name marker.
      return /grok-[4-9]/.test(m)
    case 'stepfun':
      // step-1v / step-1.5v / step-1o are StepFun's vision lines.
      return /step-[\d.]+[vo]($|[^a-z0-9])/.test(m)
    case 'zai':
      // GLM-*V (e.g. glm-4.5v, glm-4.6v, glm-5v-turbo) are the vision
      // variants; the bare glm-* chat models are text-only — confirmed
      // live, glm-5.2 rejects image parts as "no multi-modal input".
      return /glm-[\d.]+v($|[^a-z0-9])/.test(m)
    case 'kimi':
      // kimi-k2.5 onward and kimi-k3 are natively multimodal without a
      // name marker — image_url content parts verified live (k3, k2.6,
      // k2.5 — 2026-07-17), and /models reports supports_image_in for the
      // whole k2.5+/k3 line. Bare moonshot-v1 models are text-only (their
      // -vision-preview variants carry the name marker above).
      return /^kimi-k(2\.[5-9]|[3-9])/.test(m)
    case 'qwen':
      // qwen3.8-max is natively multimodal without a name marker — image
      // parts verified live 2026-08-03 (16x16 probe answered; note DashScope
      // 400s on images under 10px, which can masquerade as a modality
      // reject). Older bare qwen3.x chat models are text-only; the vl/qvq/
      // omni variants carry name markers.
      return /^qwen3\.8/.test(m)
    case 'openrouter':
      return openrouterSupportsVision(m)
    default:
      // minimax, mimo, and any provider added later: their multimodal
      // models carry a name marker; bare chat models are text-only.
      return false
  }
}

function openaiSupportsVision(m: string): boolean {
  // Text-only members of otherwise vision-capable families.
  if (/gpt-3\.5|o1-mini|o1-preview|o3-mini|gpt-4-32k/.test(m)) return false
  // Bare gpt-4 and its dated snapshots predate vision.
  if (/^gpt-4($|-\d)/.test(m)) return false
  return /gpt-4o|gpt-4\.\d|gpt-4-turbo|gpt-5|chatgpt|^o\d/.test(m)
}

// OpenRouter ids are namespaced ("anthropic/claude-sonnet-4"); route to
// the family rules the suffix belongs to.
function openrouterSupportsVision(m: string): boolean {
  if (m.includes('claude')) return true
  // Gemini 1.5 onward is multimodal across the lineup.
  if (m.includes('gemini')) return true
  if (m.includes('grok')) return /grok-[4-9]/.test(m)
  // Same rule as the direct kimi provider: k2.5+/k3 are multimodal.
  if (m.includes('kimi')) return /kimi-k(2\.[5-9]|[3-9])/.test(m)
  if (m.includes('gpt') || /(^|\/)o\d/.test(m)) {
    return openaiSupportsVision(m.split('/').pop() ?? m)
  }
  return false
}

/**
 * Whether any message carries content a text-only model can't accept:
 * image/document blocks in user messages, or images in tool results.
 */
export function hasVisualContent(messages: ChatMessage[]): boolean {
  return messages.some((m) => messageHasVisual(m, 'all'))
}

function messageHasVisual(m: ChatMessage, scope: VisualStripScope): boolean {
  if (scope === 'all' && m.role === 'user' && typeof m.content !== 'string') {
    return m.content.some((b) => b.type === 'image' || b.type === 'document')
  }
  if (m.role === 'tool') return (m.images?.length ?? 0) > 0
  return false
}

export const TEXT_ONLY_STRIP_REASON = 'the active model is text-only and cannot view them'

/** Stage 1: only tool-result images were removed. User attachments stay. */
export const TOOL_RESULT_MODALITY_STRIP_REASON =
  'this provider rejected image parts inside a tool result'

/** Stage 2: every remaining visual was removed after stage 1 also rejected. */
export const REQUEST_MODALITY_STRIP_REASON = 'this provider rejected image parts in this request'

export type VisualStripScope = 'tool' | 'all'

/**
 * Same predicate the live harness uses to decide "this 400/422 is a
 * modality reject, not an auth/model-id failure." One regex so the two
 * cannot drift.
 */
export const MODALITY_REJECT_PATTERN = /image|multimodal|content part|unknown variant/i

export function isModalityReject(message: string): boolean {
  return MODALITY_REJECT_PATTERN.test(message)
}

/**
 * Replace visual content with a text note explaining what was removed
 * and where the original files live, so the model can reach for file
 * tools instead of hallucinating what it "saw". Returns the input array
 * unchanged (same reference) when there is nothing to strip.
 *
 * `reason` is interpolated into the notes for whatever this call removes.
 * `scope` `'tool'` strips only tool-result images (user attachments stay);
 * `'all'` (default) strips user-message images/PDFs as well.
 */
export function stripVisualContent(
  messages: ChatMessage[],
  reason: string = TEXT_ONLY_STRIP_REASON,
  scope: VisualStripScope = 'all'
): ChatMessage[] {
  if (!messages.some((m) => messageHasVisual(m, scope))) return messages
  return messages.map((m) => {
    if (scope === 'all' && m.role === 'user' && typeof m.content !== 'string') {
      let images = 0
      let documents = 0
      const kept: UserContentBlock[] = []
      for (const block of m.content) {
        if (block.type === 'image') images++
        else if (block.type === 'document') documents++
        else kept.push(block)
      }
      if (images === 0 && documents === 0) return m
      kept.push({ type: 'text', text: omittedNote(images, documents, reason) })
      return { ...m, content: kept }
    }
    if (m.role === 'tool' && m.images && m.images.length > 0) {
      const count = m.images.length
      // The imperative matters: a blind model that is merely informed its
      // screenshot was removed will happily keep clicking from imagination
      // (observed live with DeepSeek driving computer_screenshot). Telling
      // it what to do instead turns silent flailing into an actionable stop.
      const note =
        `\n[${count} image${count === 1 ? '' : 's'} from this tool result omitted — ${reason}. ` +
        `You cannot see this image, so do not guess at its contents. If the task depends on seeing it ` +
        `(screenshots, screen control, visual checks), stop that part now and tell the user to switch ` +
        `to a vision-capable model.]`
      return { ...m, images: undefined, content: m.content + note }
    }
    return m
  })
}

/** Newest tool-result images kept in full once pruning starts. */
export const TOOL_IMAGES_KEEP = 6

/**
 * Older images are dropped in batches of this size, not one per turn: each
 * drop rewrites an early message and breaks the provider prompt-cache
 * prefix, so amortizing the damage to one rewrite per BATCH new images
 * keeps long computer-use sessions cacheable.
 */
export const TOOL_IMAGES_PRUNE_BATCH = 4

/**
 * Keep only the newest tool-result images in the request; older ones are
 * replaced by a text note. Two reasons, both observed in long screen-control
 * sessions: dozens of near-identical screenshots make the model ground its
 * next click on a stale frame, and they dominate token cost. User-attached
 * images are never touched. Deterministic over message order, so identical
 * histories encode identically. Returns the input array unchanged (same
 * reference) when nothing is pruned.
 */
export function limitToolResultImages(
  messages: ChatMessage[],
  keep: number = TOOL_IMAGES_KEEP,
  batch: number = TOOL_IMAGES_PRUNE_BATCH
): ChatMessage[] {
  let total = 0
  for (const m of messages) {
    if (m.role === 'tool') total += m.images?.length ?? 0
  }
  const droppable = total - keep
  if (droppable < batch) return messages
  let toDrop = Math.floor(droppable / batch) * batch
  return messages.map((m) => {
    if (toDrop <= 0 || m.role !== 'tool' || !m.images || m.images.length === 0) return m
    const n = Math.min(toDrop, m.images.length)
    toDrop -= n
    const kept = m.images.slice(n)
    const note =
      `\n[${n} older image${n === 1 ? '' : 's'} from this tool result omitted to keep context lean — ` +
      `only the newest images in the conversation are retained. The screen has changed since; ` +
      `take a fresh screenshot (or re-view the file) instead of acting from memory of this image.]`
    return { ...m, images: kept.length > 0 ? kept : undefined, content: m.content + note }
  })
}

function omittedNote(images: number, documents: number, reason: string): string {
  const parts: string[] = []
  if (images > 0) parts.push(`${images} image${images === 1 ? '' : 's'}`)
  if (documents > 0) parts.push(`${documents} PDF document${documents === 1 ? '' : 's'}`)
  return `[${parts.join(' and ')} omitted — ${reason}. The original files are on disk; their paths are listed in the <attachments> block of this message. Use file tools if the task needs their contents.]`
}
