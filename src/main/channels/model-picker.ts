import type { CloudProviderConfig } from '@main/workspace/workspace'

/**
 * Shared helpers behind the channel `/model` command (WhatsApp + Telegram).
 *
 * A "model option" is one connected provider paired with one of its model
 * ids. The shape is structurally identical to Thalamus's `BrainSelection`, so
 * an option passes straight into `setBrain()` / `thalamus.setBrain()` with no
 * conversion — the whole point of keeping the key named `providerId`.
 */
export type ModelOption = { providerId: CloudProviderConfig['id']; model: string }

/**
 * Max models a channel lists at once. A phone chat is a poor place to scroll
 * a 300-entry OpenRouter catalog, so the picker caps the list and tells the
 * user to narrow it with `/model <query>` (or the in-app picker) instead.
 */
export const MODEL_LIST_CAP = 20

/**
 * Flatten connected providers into an ordered, deduped list of selectable
 * models. Providers arrive already filtered to the connected ones
 * (`thalamus.getCloudProviders()` drops any without apiKey+model); each is
 * expanded into its fetched catalog (`models`), falling back to the single
 * configured `model` when the catalog hasn't been fetched yet. Order follows
 * the user's own provider arrangement in config.
 */
export function collectModelOptions(providers: CloudProviderConfig[]): ModelOption[] {
  const seen = new Set<string>()
  const options: ModelOption[] = []
  for (const p of providers) {
    const ids = p.models && p.models.length > 0 ? p.models : p.model ? [p.model] : []
    for (const model of ids) {
      // Generation-only models must never become the Brain via `/model`
      // (this picker has no other filter): MiniMax video models (H3,
      // Hailuo) chat through no completions endpoint — the `video`
      // capability is their surface. Defensive: the provider fetch filter
      // already keeps them out of `models`.
      if (/^minimax-(h\d|hailuo)/i.test(model)) continue
      const key = `${p.id}/${model}`
      if (seen.has(key)) continue
      seen.add(key)
      options.push({ providerId: p.id, model })
    }
  }
  return options
}

/**
 * Case-insensitive substring filter over provider id and model id — powers
 * `/model opus`-style quick select. An empty query returns everything.
 */
export function filterModelOptions(options: ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter(
    (o) => o.model.toLowerCase().includes(q) || o.providerId.toLowerCase().includes(q)
  )
}
