export type ModelFamily = 'gemma' | 'qwen' | 'llama' | 'deepseek' | 'kimi'
export type SizeKey = 'nano' | 'mini' | 'compact' | 'standard' | 'pro' | 'ultra' | 'max' | 'extreme'

export type ModelEntry = {
  family: ModelFamily
  sizeKey: SizeKey
  ollamaName: string
  sizeBytes: number
  ramBytes: number
  paramsBillions?: number
  releaseDate?: string
}

const GB = 1024 ** 3

// Predictive RAM heuristics for pre-install UI gating — the catalog is
// consumed before download, so we can't read `ollama ps`. Factors estimate
// runtime RAM from on-disk size by architecture family. Real RAM varies
// ±15% across user hardware, context length, and concurrent workload.
//
// - multimodal (1.10): vision/audio models. Calibrated against measured
//   gemma4:e2b on Q4_K_M, 100% GPU: 7.7 GB @ 4k ctx, 7.9 GB @ 32k ctx.
// - moe        (1.15): Mixture-of-Experts. Sparse activation keeps
//   working-set RAM below total-param estimates (e.g. gemma4:26b is
//   25.2B total / 3.8B active per token).
// - dense      (1.20): text-only dense models.
//
// To recalibrate: pull the model, `ollama run <tag> ""`, then `ollama ps`
// reports SIZE as the real loaded RAM. Adjust the relevant factor here.
const RAM_FACTOR = { multimodal: 1.1, dense: 1.2, moe: 1.15 } as const
type RamKind = keyof typeof RAM_FACTOR
const ram = (size: number, kind: RamKind = 'dense'): number => Math.round(size * RAM_FACTOR[kind])

// Full catalog of local Ollama model families, ordered smallest → largest
// within each series. Sizes are on-disk values from ollama.com/library.
export const MODEL_CATALOG: readonly ModelEntry[] = [
  // ── gemma ──────────────────────────────────────────────────────────────

  // gemma4
  {
    family: 'gemma',
    sizeKey: 'mini',
    ollamaName: 'gemma4:e2b',
    sizeBytes: Math.round(7.2 * GB),
    ramBytes: ram(7.2 * GB, 'multimodal'),
    paramsBillions: 2
  },
  {
    family: 'gemma',
    sizeKey: 'compact',
    ollamaName: 'gemma4:e4b',
    sizeBytes: Math.round(9.6 * GB),
    ramBytes: ram(9.6 * GB, 'multimodal'),
    paramsBillions: 4
  },
  {
    family: 'gemma',
    sizeKey: 'pro',
    ollamaName: 'gemma4:26b',
    sizeBytes: 18 * GB,
    ramBytes: ram(18 * GB, 'moe'),
    paramsBillions: 26
  },
  {
    family: 'gemma',
    sizeKey: 'pro',
    ollamaName: 'gemma4:31b',
    sizeBytes: 20 * GB,
    ramBytes: ram(20 * GB, 'dense'),
    paramsBillions: 31
  },
  // gemma3
  {
    family: 'gemma',
    sizeKey: 'nano',
    ollamaName: 'gemma3:270m',
    sizeBytes: Math.round(0.3 * GB),
    ramBytes: ram(0.3 * GB, 'multimodal'),
    paramsBillions: 0.27
  },
  {
    family: 'gemma',
    sizeKey: 'nano',
    ollamaName: 'gemma3:1b',
    sizeBytes: 1 * GB,
    ramBytes: ram(1 * GB, 'multimodal'),
    paramsBillions: 1
  },
  {
    family: 'gemma',
    sizeKey: 'compact',
    ollamaName: 'gemma3:4b',
    sizeBytes: Math.round(3.3 * GB),
    ramBytes: ram(3.3 * GB, 'multimodal'),
    paramsBillions: 4
  },
  {
    family: 'gemma',
    sizeKey: 'standard',
    ollamaName: 'gemma3:12b',
    sizeBytes: Math.round(8.1 * GB),
    ramBytes: ram(8.1 * GB, 'multimodal'),
    paramsBillions: 12
  },
  {
    family: 'gemma',
    sizeKey: 'pro',
    ollamaName: 'gemma3:27b',
    sizeBytes: 17 * GB,
    ramBytes: ram(17 * GB, 'multimodal'),
    paramsBillions: 27
  },
  // gemma3n
  {
    family: 'gemma',
    sizeKey: 'mini',
    ollamaName: 'gemma3n:e2b',
    sizeBytes: Math.round(1.6 * GB),
    ramBytes: ram(1.6 * GB, 'dense'),
    paramsBillions: 2
  },
  {
    family: 'gemma',
    sizeKey: 'compact',
    ollamaName: 'gemma3n:e4b',
    sizeBytes: Math.round(2.5 * GB),
    ramBytes: ram(2.5 * GB, 'dense'),
    paramsBillions: 4
  },
  // gemma2
  {
    family: 'gemma',
    sizeKey: 'mini',
    ollamaName: 'gemma2:2b',
    sizeBytes: Math.round(1.6 * GB),
    ramBytes: ram(1.6 * GB, 'dense'),
    paramsBillions: 2
  },
  {
    family: 'gemma',
    sizeKey: 'compact',
    ollamaName: 'gemma2:9b',
    sizeBytes: Math.round(5.4 * GB),
    ramBytes: ram(5.4 * GB, 'dense'),
    paramsBillions: 9
  },
  {
    family: 'gemma',
    sizeKey: 'pro',
    ollamaName: 'gemma2:27b',
    sizeBytes: 16 * GB,
    ramBytes: ram(16 * GB, 'dense'),
    paramsBillions: 27
  },
  // gemma (v1.1)
  {
    family: 'gemma',
    sizeKey: 'mini',
    ollamaName: 'gemma:2b',
    sizeBytes: Math.round(1.7 * GB),
    ramBytes: ram(1.7 * GB, 'dense'),
    paramsBillions: 2
  },
  {
    family: 'gemma',
    sizeKey: 'compact',
    ollamaName: 'gemma:7b',
    sizeBytes: 5 * GB,
    ramBytes: ram(5 * GB, 'dense'),
    paramsBillions: 7
  },
  // codegemma
  {
    family: 'gemma',
    sizeKey: 'mini',
    ollamaName: 'codegemma:2b',
    sizeBytes: Math.round(1.7 * GB),
    ramBytes: ram(1.7 * GB, 'dense'),
    paramsBillions: 2
  },
  {
    family: 'gemma',
    sizeKey: 'compact',
    ollamaName: 'codegemma:7b',
    sizeBytes: 5 * GB,
    ramBytes: ram(5 * GB, 'dense'),
    paramsBillions: 7
  },
  // translategemma
  {
    family: 'gemma',
    sizeKey: 'compact',
    ollamaName: 'translategemma:4b',
    sizeBytes: Math.round(3.3 * GB),
    ramBytes: ram(3.3 * GB, 'multimodal'),
    paramsBillions: 4
  },
  {
    family: 'gemma',
    sizeKey: 'standard',
    ollamaName: 'translategemma:12b',
    sizeBytes: Math.round(8.1 * GB),
    ramBytes: ram(8.1 * GB, 'multimodal'),
    paramsBillions: 12
  },
  {
    family: 'gemma',
    sizeKey: 'pro',
    ollamaName: 'translategemma:27b',
    sizeBytes: 17 * GB,
    ramBytes: ram(17 * GB, 'multimodal'),
    paramsBillions: 27
  },
  // functiongemma
  {
    family: 'gemma',
    sizeKey: 'nano',
    ollamaName: 'functiongemma:270m',
    sizeBytes: Math.round(0.3 * GB),
    ramBytes: ram(0.3 * GB, 'dense'),
    paramsBillions: 0.27
  },
  // shieldgemma
  {
    family: 'gemma',
    sizeKey: 'mini',
    ollamaName: 'shieldgemma:2b',
    sizeBytes: Math.round(1.6 * GB),
    ramBytes: ram(1.6 * GB, 'dense'),
    paramsBillions: 2
  },
  {
    family: 'gemma',
    sizeKey: 'compact',
    ollamaName: 'shieldgemma:9b',
    sizeBytes: Math.round(5.4 * GB),
    ramBytes: ram(5.4 * GB, 'dense'),
    paramsBillions: 9
  },
  {
    family: 'gemma',
    sizeKey: 'pro',
    ollamaName: 'shieldgemma:27b',
    sizeBytes: 16 * GB,
    ramBytes: ram(16 * GB, 'dense'),
    paramsBillions: 27
  },
  // embeddinggemma
  {
    family: 'gemma',
    sizeKey: 'nano',
    ollamaName: 'embeddinggemma:300m',
    sizeBytes: Math.round(0.2 * GB),
    ramBytes: ram(0.2 * GB, 'dense'),
    paramsBillions: 0.3
  },
  // medgemma
  {
    family: 'gemma',
    sizeKey: 'compact',
    ollamaName: 'medgemma:4b',
    sizeBytes: Math.round(3.3 * GB),
    ramBytes: ram(3.3 * GB, 'multimodal'),
    paramsBillions: 4
  },
  {
    family: 'gemma',
    sizeKey: 'pro',
    ollamaName: 'medgemma:27b',
    sizeBytes: 17 * GB,
    ramBytes: ram(17 * GB, 'multimodal'),
    paramsBillions: 27
  },
  // medgemma1.5
  {
    family: 'gemma',
    sizeKey: 'compact',
    ollamaName: 'medgemma1.5:4b',
    sizeBytes: Math.round(3.3 * GB),
    ramBytes: ram(3.3 * GB, 'multimodal'),
    paramsBillions: 4
  },

  // ── qwen ───────────────────────────────────────────────────────────────

  // qwen3.6
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen3.6:27b',
    sizeBytes: 17 * GB,
    ramBytes: ram(17 * GB, 'multimodal'),
    paramsBillions: 27
  },
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen3.6:35b',
    sizeBytes: 24 * GB,
    ramBytes: ram(24 * GB, 'multimodal'),
    paramsBillions: 35
  },
  // qwen3.5
  {
    family: 'qwen',
    sizeKey: 'nano',
    ollamaName: 'qwen3.5:0.8b',
    sizeBytes: 1 * GB,
    ramBytes: ram(1 * GB, 'dense'),
    paramsBillions: 0.8
  },
  {
    family: 'qwen',
    sizeKey: 'mini',
    ollamaName: 'qwen3.5:2b',
    sizeBytes: Math.round(2.7 * GB),
    ramBytes: ram(2.7 * GB, 'dense'),
    paramsBillions: 2
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen3.5:4b',
    sizeBytes: Math.round(3.4 * GB),
    ramBytes: ram(3.4 * GB, 'dense'),
    paramsBillions: 4
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen3.5:9b',
    sizeBytes: Math.round(6.6 * GB),
    ramBytes: ram(6.6 * GB, 'dense'),
    paramsBillions: 9
  },
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen3.5:27b',
    sizeBytes: 17 * GB,
    ramBytes: ram(17 * GB, 'dense'),
    paramsBillions: 27
  },
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen3.5:35b',
    sizeBytes: 24 * GB,
    ramBytes: ram(24 * GB, 'dense'),
    paramsBillions: 35
  },
  {
    family: 'qwen',
    sizeKey: 'max',
    ollamaName: 'qwen3.5:122b',
    sizeBytes: 81 * GB,
    ramBytes: ram(81 * GB, 'moe'),
    paramsBillions: 122
  },
  // qwen3-coder
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen3-coder:30b',
    sizeBytes: 19 * GB,
    ramBytes: ram(19 * GB, 'dense'),
    paramsBillions: 30
  },
  {
    family: 'qwen',
    sizeKey: 'extreme',
    ollamaName: 'qwen3-coder:480b',
    sizeBytes: 288 * GB,
    ramBytes: ram(288 * GB, 'moe'),
    paramsBillions: 480
  },
  // qwen3-vl
  {
    family: 'qwen',
    sizeKey: 'mini',
    ollamaName: 'qwen3-vl:2b',
    sizeBytes: Math.round(2.0 * GB),
    ramBytes: ram(2.0 * GB, 'multimodal'),
    paramsBillions: 2
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen3-vl:4b',
    sizeBytes: Math.round(3.3 * GB),
    ramBytes: ram(3.3 * GB, 'multimodal'),
    paramsBillions: 4
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen3-vl:8b',
    sizeBytes: Math.round(5.5 * GB),
    ramBytes: ram(5.5 * GB, 'multimodal'),
    paramsBillions: 8
  },
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen3-vl:30b',
    sizeBytes: 19 * GB,
    ramBytes: ram(19 * GB, 'multimodal'),
    paramsBillions: 30
  },
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen3-vl:32b',
    sizeBytes: 20 * GB,
    ramBytes: ram(20 * GB, 'multimodal'),
    paramsBillions: 32
  },
  {
    family: 'qwen',
    sizeKey: 'extreme',
    ollamaName: 'qwen3-vl:235b',
    sizeBytes: 142 * GB,
    ramBytes: ram(142 * GB, 'moe'),
    paramsBillions: 235
  },
  // qwen3
  {
    family: 'qwen',
    sizeKey: 'nano',
    ollamaName: 'qwen3:0.6b',
    sizeBytes: Math.round(0.5 * GB),
    ramBytes: ram(0.5 * GB, 'dense'),
    paramsBillions: 0.6
  },
  {
    family: 'qwen',
    sizeKey: 'mini',
    ollamaName: 'qwen3:1.7b',
    sizeBytes: Math.round(1.3 * GB),
    ramBytes: ram(1.3 * GB, 'dense'),
    paramsBillions: 1.7
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen3:4b',
    sizeBytes: Math.round(2.6 * GB),
    ramBytes: ram(2.6 * GB, 'dense'),
    paramsBillions: 4
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen3:8b',
    sizeBytes: Math.round(5.2 * GB),
    ramBytes: ram(5.2 * GB, 'dense'),
    paramsBillions: 8
  },
  {
    family: 'qwen',
    sizeKey: 'standard',
    ollamaName: 'qwen3:14b',
    sizeBytes: Math.round(9.4 * GB),
    ramBytes: ram(9.4 * GB, 'dense'),
    paramsBillions: 14
  },
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen3:30b',
    sizeBytes: 19 * GB,
    ramBytes: ram(19 * GB, 'moe'),
    paramsBillions: 30
  },
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen3:32b',
    sizeBytes: 20 * GB,
    ramBytes: ram(20 * GB, 'dense'),
    paramsBillions: 32
  },
  {
    family: 'qwen',
    sizeKey: 'extreme',
    ollamaName: 'qwen3:235b',
    sizeBytes: 142 * GB,
    ramBytes: ram(142 * GB, 'moe'),
    paramsBillions: 235
  },
  // qwen3-embedding
  {
    family: 'qwen',
    sizeKey: 'nano',
    ollamaName: 'qwen3-embedding:0.6b',
    sizeBytes: Math.round(0.4 * GB),
    ramBytes: ram(0.4 * GB, 'dense'),
    paramsBillions: 0.6
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen3-embedding:4b',
    sizeBytes: Math.round(2.5 * GB),
    ramBytes: ram(2.5 * GB, 'dense'),
    paramsBillions: 4
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen3-embedding:8b',
    sizeBytes: 5 * GB,
    ramBytes: ram(5 * GB, 'dense'),
    paramsBillions: 8
  },
  // qwen2.5
  {
    family: 'qwen',
    sizeKey: 'nano',
    ollamaName: 'qwen2.5:0.5b',
    sizeBytes: Math.round(0.4 * GB),
    ramBytes: ram(0.4 * GB, 'dense'),
    paramsBillions: 0.5
  },
  {
    family: 'qwen',
    sizeKey: 'nano',
    ollamaName: 'qwen2.5:1.5b',
    sizeBytes: 1 * GB,
    ramBytes: ram(1 * GB, 'dense'),
    paramsBillions: 1.5
  },
  {
    family: 'qwen',
    sizeKey: 'mini',
    ollamaName: 'qwen2.5:3b',
    sizeBytes: 2 * GB,
    ramBytes: ram(2 * GB, 'dense'),
    paramsBillions: 3
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen2.5:7b',
    sizeBytes: Math.round(4.7 * GB),
    ramBytes: ram(4.7 * GB, 'dense'),
    paramsBillions: 7
  },
  {
    family: 'qwen',
    sizeKey: 'standard',
    ollamaName: 'qwen2.5:14b',
    sizeBytes: 9 * GB,
    ramBytes: ram(9 * GB, 'dense'),
    paramsBillions: 14
  },
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen2.5:32b',
    sizeBytes: 20 * GB,
    ramBytes: ram(20 * GB, 'dense'),
    paramsBillions: 32
  },
  {
    family: 'qwen',
    sizeKey: 'ultra',
    ollamaName: 'qwen2.5:72b',
    sizeBytes: 47 * GB,
    ramBytes: ram(47 * GB, 'dense'),
    paramsBillions: 72
  },
  // qwen2.5-coder
  {
    family: 'qwen',
    sizeKey: 'nano',
    ollamaName: 'qwen2.5-coder:0.5b',
    sizeBytes: Math.round(0.4 * GB),
    ramBytes: ram(0.4 * GB, 'dense'),
    paramsBillions: 0.5
  },
  {
    family: 'qwen',
    sizeKey: 'nano',
    ollamaName: 'qwen2.5-coder:1.5b',
    sizeBytes: 1 * GB,
    ramBytes: ram(1 * GB, 'dense'),
    paramsBillions: 1.5
  },
  {
    family: 'qwen',
    sizeKey: 'mini',
    ollamaName: 'qwen2.5-coder:3b',
    sizeBytes: 2 * GB,
    ramBytes: ram(2 * GB, 'dense'),
    paramsBillions: 3
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen2.5-coder:7b',
    sizeBytes: Math.round(4.7 * GB),
    ramBytes: ram(4.7 * GB, 'dense'),
    paramsBillions: 7
  },
  {
    family: 'qwen',
    sizeKey: 'standard',
    ollamaName: 'qwen2.5-coder:14b',
    sizeBytes: 9 * GB,
    ramBytes: ram(9 * GB, 'dense'),
    paramsBillions: 14
  },
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen2.5-coder:32b',
    sizeBytes: 20 * GB,
    ramBytes: ram(20 * GB, 'dense'),
    paramsBillions: 32
  },
  // qwen2.5vl
  {
    family: 'qwen',
    sizeKey: 'mini',
    ollamaName: 'qwen2.5vl:3b',
    sizeBytes: Math.round(2.5 * GB),
    ramBytes: ram(2.5 * GB, 'multimodal'),
    paramsBillions: 3
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen2.5vl:7b',
    sizeBytes: 5 * GB,
    ramBytes: ram(5 * GB, 'multimodal'),
    paramsBillions: 7
  },
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen2.5vl:32b',
    sizeBytes: 21 * GB,
    ramBytes: ram(21 * GB, 'multimodal'),
    paramsBillions: 32
  },
  {
    family: 'qwen',
    sizeKey: 'ultra',
    ollamaName: 'qwen2.5vl:72b',
    sizeBytes: 47 * GB,
    ramBytes: ram(47 * GB, 'multimodal'),
    paramsBillions: 72
  },
  // qwen2
  {
    family: 'qwen',
    sizeKey: 'nano',
    ollamaName: 'qwen2:0.5b',
    sizeBytes: Math.round(0.4 * GB),
    ramBytes: ram(0.4 * GB, 'dense'),
    paramsBillions: 0.5
  },
  {
    family: 'qwen',
    sizeKey: 'nano',
    ollamaName: 'qwen2:1.5b',
    sizeBytes: 1 * GB,
    ramBytes: ram(1 * GB, 'dense'),
    paramsBillions: 1.5
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen2:7b',
    sizeBytes: Math.round(4.4 * GB),
    ramBytes: ram(4.4 * GB, 'dense'),
    paramsBillions: 7
  },
  {
    family: 'qwen',
    sizeKey: 'ultra',
    ollamaName: 'qwen2:72b',
    sizeBytes: 44 * GB,
    ramBytes: ram(44 * GB, 'dense'),
    paramsBillions: 72
  },
  // qwen2-math
  {
    family: 'qwen',
    sizeKey: 'nano',
    ollamaName: 'qwen2-math:1.5b',
    sizeBytes: 1 * GB,
    ramBytes: ram(1 * GB, 'dense'),
    paramsBillions: 1.5
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen2-math:7b',
    sizeBytes: Math.round(4.4 * GB),
    ramBytes: ram(4.4 * GB, 'dense'),
    paramsBillions: 7
  },
  {
    family: 'qwen',
    sizeKey: 'ultra',
    ollamaName: 'qwen2-math:72b',
    sizeBytes: 44 * GB,
    ramBytes: ram(44 * GB, 'dense'),
    paramsBillions: 72
  },
  // qwen (v1.5)
  {
    family: 'qwen',
    sizeKey: 'nano',
    ollamaName: 'qwen:0.5b',
    sizeBytes: Math.round(0.4 * GB),
    ramBytes: ram(0.4 * GB, 'dense'),
    paramsBillions: 0.5
  },
  {
    family: 'qwen',
    sizeKey: 'mini',
    ollamaName: 'qwen:1.8b',
    sizeBytes: Math.round(1.2 * GB),
    ramBytes: ram(1.2 * GB, 'dense'),
    paramsBillions: 1.8
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen:4b',
    sizeBytes: Math.round(2.5 * GB),
    ramBytes: ram(2.5 * GB, 'dense'),
    paramsBillions: 4
  },
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'qwen:7b',
    sizeBytes: Math.round(4.4 * GB),
    ramBytes: ram(4.4 * GB, 'dense'),
    paramsBillions: 7
  },
  {
    family: 'qwen',
    sizeKey: 'standard',
    ollamaName: 'qwen:14b',
    sizeBytes: 9 * GB,
    ramBytes: ram(9 * GB, 'dense'),
    paramsBillions: 14
  },
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwen:32b',
    sizeBytes: 20 * GB,
    ramBytes: ram(20 * GB, 'dense'),
    paramsBillions: 32
  },
  {
    family: 'qwen',
    sizeKey: 'ultra',
    ollamaName: 'qwen:72b',
    sizeBytes: 44 * GB,
    ramBytes: ram(44 * GB, 'dense'),
    paramsBillions: 72
  },
  {
    family: 'qwen',
    sizeKey: 'max',
    ollamaName: 'qwen:110b',
    sizeBytes: 67 * GB,
    ramBytes: ram(67 * GB, 'dense'),
    paramsBillions: 110
  },
  // codeqwen
  {
    family: 'qwen',
    sizeKey: 'compact',
    ollamaName: 'codeqwen:7b',
    sizeBytes: Math.round(4.4 * GB),
    ramBytes: ram(4.4 * GB, 'dense'),
    paramsBillions: 7
  },
  // qwq
  {
    family: 'qwen',
    sizeKey: 'pro',
    ollamaName: 'qwq:32b',
    sizeBytes: 20 * GB,
    ramBytes: ram(20 * GB, 'dense'),
    paramsBillions: 32
  },

  // ── llama ──────────────────────────────────────────────────────────────

  // llama4 (Meta, MoE)
  {
    family: 'llama',
    sizeKey: 'max',
    ollamaName: 'llama4:16x17b',
    sizeBytes: 60 * GB,
    ramBytes: ram(60 * GB, 'moe'),
    paramsBillions: 109
  },
  {
    family: 'llama',
    sizeKey: 'extreme',
    ollamaName: 'llama4:128x17b',
    sizeBytes: 300 * GB,
    ramBytes: ram(300 * GB, 'moe'),
    paramsBillions: 400
  },
  // llama3.3
  {
    family: 'llama',
    sizeKey: 'ultra',
    ollamaName: 'llama3.3:70b',
    sizeBytes: 43 * GB,
    ramBytes: ram(43 * GB, 'dense'),
    paramsBillions: 70.6,
    releaseDate: '2024-12-06'
  },
  // llama3.2
  {
    family: 'llama',
    sizeKey: 'nano',
    ollamaName: 'llama3.2:1b',
    sizeBytes: Math.round(1.3 * GB),
    ramBytes: ram(1.3 * GB, 'dense'),
    paramsBillions: 1.24,
    releaseDate: '2024-09-25'
  },
  {
    family: 'llama',
    sizeKey: 'mini',
    ollamaName: 'llama3.2:3b',
    sizeBytes: 2 * GB,
    ramBytes: ram(2 * GB, 'dense'),
    paramsBillions: 3.21,
    releaseDate: '2024-09-25'
  },
  // llama3.2-vision
  {
    family: 'llama',
    sizeKey: 'standard',
    ollamaName: 'llama3.2-vision:11b',
    sizeBytes: Math.round(7.9 * GB),
    ramBytes: ram(7.9 * GB, 'multimodal'),
    paramsBillions: 11
  },
  {
    family: 'llama',
    sizeKey: 'max',
    ollamaName: 'llama3.2-vision:90b',
    sizeBytes: 55 * GB,
    ramBytes: ram(55 * GB, 'multimodal'),
    paramsBillions: 90
  },
  // llama3.1
  {
    family: 'llama',
    sizeKey: 'compact',
    ollamaName: 'llama3.1:8b',
    sizeBytes: Math.round(4.7 * GB),
    ramBytes: ram(4.7 * GB, 'dense'),
    paramsBillions: 8.03,
    releaseDate: '2024-07-23'
  },
  {
    family: 'llama',
    sizeKey: 'ultra',
    ollamaName: 'llama3.1:70b',
    sizeBytes: 43 * GB,
    ramBytes: ram(43 * GB, 'dense'),
    paramsBillions: 70.6,
    releaseDate: '2024-07-23'
  },
  {
    family: 'llama',
    sizeKey: 'extreme',
    ollamaName: 'llama3.1:405b',
    sizeBytes: 243 * GB,
    ramBytes: ram(243 * GB, 'dense'),
    paramsBillions: 405,
    releaseDate: '2024-07-23'
  },
  // llama3
  {
    family: 'llama',
    sizeKey: 'compact',
    ollamaName: 'llama3:8b',
    sizeBytes: Math.round(4.7 * GB),
    ramBytes: ram(4.7 * GB, 'dense'),
    paramsBillions: 8
  },
  {
    family: 'llama',
    sizeKey: 'ultra',
    ollamaName: 'llama3:70b',
    sizeBytes: 40 * GB,
    ramBytes: ram(40 * GB, 'dense'),
    paramsBillions: 70
  },
  // llama3-gradient
  {
    family: 'llama',
    sizeKey: 'compact',
    ollamaName: 'llama3-gradient:8b',
    sizeBytes: Math.round(4.7 * GB),
    ramBytes: ram(4.7 * GB, 'dense'),
    paramsBillions: 8
  },
  {
    family: 'llama',
    sizeKey: 'ultra',
    ollamaName: 'llama3-gradient:70b',
    sizeBytes: 40 * GB,
    ramBytes: ram(40 * GB, 'dense'),
    paramsBillions: 70
  },
  // llama3-chatqa
  {
    family: 'llama',
    sizeKey: 'compact',
    ollamaName: 'llama3-chatqa:8b',
    sizeBytes: Math.round(4.7 * GB),
    ramBytes: ram(4.7 * GB, 'dense'),
    paramsBillions: 8
  },
  {
    family: 'llama',
    sizeKey: 'ultra',
    ollamaName: 'llama3-chatqa:70b',
    sizeBytes: 40 * GB,
    ramBytes: ram(40 * GB, 'dense'),
    paramsBillions: 70
  },
  // llama3-groq-tool-use
  {
    family: 'llama',
    sizeKey: 'compact',
    ollamaName: 'llama3-groq-tool-use:8b',
    sizeBytes: Math.round(4.7 * GB),
    ramBytes: ram(4.7 * GB, 'dense'),
    paramsBillions: 8
  },
  {
    family: 'llama',
    sizeKey: 'ultra',
    ollamaName: 'llama3-groq-tool-use:70b',
    sizeBytes: 40 * GB,
    ramBytes: ram(40 * GB, 'dense'),
    paramsBillions: 70
  },
  // llama-guard3
  {
    family: 'llama',
    sizeKey: 'nano',
    ollamaName: 'llama-guard3:1b',
    sizeBytes: Math.round(0.8 * GB),
    ramBytes: ram(0.8 * GB, 'dense'),
    paramsBillions: 1
  },
  {
    family: 'llama',
    sizeKey: 'compact',
    ollamaName: 'llama-guard3:8b',
    sizeBytes: Math.round(4.7 * GB),
    ramBytes: ram(4.7 * GB, 'dense'),
    paramsBillions: 8
  },
  // llama-pro
  {
    family: 'llama',
    sizeKey: 'compact',
    ollamaName: 'llama-pro',
    sizeBytes: Math.round(4.7 * GB),
    ramBytes: ram(4.7 * GB, 'dense'),
    paramsBillions: 8
  },
  // llama2
  {
    family: 'llama',
    sizeKey: 'compact',
    ollamaName: 'llama2:7b',
    sizeBytes: Math.round(3.8 * GB),
    ramBytes: ram(3.8 * GB, 'dense'),
    paramsBillions: 7
  },
  {
    family: 'llama',
    sizeKey: 'standard',
    ollamaName: 'llama2:13b',
    sizeBytes: Math.round(7.4 * GB),
    ramBytes: ram(7.4 * GB, 'dense'),
    paramsBillions: 13
  },
  {
    family: 'llama',
    sizeKey: 'ultra',
    ollamaName: 'llama2:70b',
    sizeBytes: 39 * GB,
    ramBytes: ram(39 * GB, 'dense'),
    paramsBillions: 70
  },
  // llama2-uncensored
  {
    family: 'llama',
    sizeKey: 'compact',
    ollamaName: 'llama2-uncensored:7b',
    sizeBytes: Math.round(3.8 * GB),
    ramBytes: ram(3.8 * GB, 'dense'),
    paramsBillions: 7
  },
  {
    family: 'llama',
    sizeKey: 'ultra',
    ollamaName: 'llama2-uncensored:70b',
    sizeBytes: 39 * GB,
    ramBytes: ram(39 * GB, 'dense'),
    paramsBillions: 70
  },
  // llama2-chinese
  {
    family: 'llama',
    sizeKey: 'compact',
    ollamaName: 'llama2-chinese:7b',
    sizeBytes: Math.round(3.8 * GB),
    ramBytes: ram(3.8 * GB, 'dense'),
    paramsBillions: 7
  },
  {
    family: 'llama',
    sizeKey: 'standard',
    ollamaName: 'llama2-chinese:13b',
    sizeBytes: Math.round(7.4 * GB),
    ramBytes: ram(7.4 * GB, 'dense'),
    paramsBillions: 13
  },
  // tinyllama
  {
    family: 'llama',
    sizeKey: 'nano',
    ollamaName: 'tinyllama:1.1b',
    sizeBytes: Math.round(0.7 * GB),
    ramBytes: ram(0.7 * GB, 'dense'),
    paramsBillions: 1.1
  },
  // codellama
  {
    family: 'llama',
    sizeKey: 'compact',
    ollamaName: 'codellama:7b',
    sizeBytes: Math.round(3.8 * GB),
    ramBytes: ram(3.8 * GB, 'dense'),
    paramsBillions: 7
  },
  {
    family: 'llama',
    sizeKey: 'standard',
    ollamaName: 'codellama:13b',
    sizeBytes: Math.round(7.4 * GB),
    ramBytes: ram(7.4 * GB, 'dense'),
    paramsBillions: 13
  },
  {
    family: 'llama',
    sizeKey: 'pro',
    ollamaName: 'codellama:34b',
    sizeBytes: 19 * GB,
    ramBytes: ram(19 * GB, 'dense'),
    paramsBillions: 34
  },
  {
    family: 'llama',
    sizeKey: 'ultra',
    ollamaName: 'codellama:70b',
    sizeBytes: 39 * GB,
    ramBytes: ram(39 * GB, 'dense'),
    paramsBillions: 70
  },

  // ── deepseek ───────────────────────────────────────────────────────────

  // deepseek-r1
  {
    family: 'deepseek',
    sizeKey: 'mini',
    ollamaName: 'deepseek-r1:1.5b',
    sizeBytes: Math.round(1.1 * GB),
    ramBytes: ram(1.1 * GB, 'dense'),
    paramsBillions: 1.78,
    releaseDate: '2025-01-20'
  },
  {
    family: 'deepseek',
    sizeKey: 'compact',
    ollamaName: 'deepseek-r1:7b',
    sizeBytes: Math.round(4.7 * GB),
    ramBytes: ram(4.7 * GB, 'dense'),
    paramsBillions: 7,
    releaseDate: '2025-01-20'
  },
  {
    family: 'deepseek',
    sizeKey: 'compact',
    ollamaName: 'deepseek-r1:8b',
    sizeBytes: Math.round(5.2 * GB),
    ramBytes: ram(5.2 * GB, 'dense'),
    paramsBillions: 8.03,
    releaseDate: '2025-01-20'
  },
  {
    family: 'deepseek',
    sizeKey: 'standard',
    ollamaName: 'deepseek-r1:14b',
    sizeBytes: 9 * GB,
    ramBytes: ram(9 * GB, 'dense'),
    paramsBillions: 14.8,
    releaseDate: '2025-01-20'
  },
  {
    family: 'deepseek',
    sizeKey: 'pro',
    ollamaName: 'deepseek-r1:32b',
    sizeBytes: 20 * GB,
    ramBytes: ram(20 * GB, 'dense'),
    paramsBillions: 32.8,
    releaseDate: '2025-01-20'
  },
  {
    family: 'deepseek',
    sizeKey: 'ultra',
    ollamaName: 'deepseek-r1:70b',
    sizeBytes: 43 * GB,
    ramBytes: ram(43 * GB, 'dense'),
    paramsBillions: 70.6,
    releaseDate: '2025-01-20'
  },
  {
    family: 'deepseek',
    sizeKey: 'extreme',
    ollamaName: 'deepseek-r1:671b',
    sizeBytes: 404 * GB,
    ramBytes: ram(404 * GB, 'moe'),
    paramsBillions: 671,
    releaseDate: '2025-01-20'
  },
  // deepseek-v3
  {
    family: 'deepseek',
    sizeKey: 'extreme',
    ollamaName: 'deepseek-v3:671b',
    sizeBytes: 404 * GB,
    ramBytes: ram(404 * GB, 'moe'),
    paramsBillions: 671
  },
  // deepseek-v2.5
  {
    family: 'deepseek',
    sizeKey: 'extreme',
    ollamaName: 'deepseek-v2.5:236b',
    sizeBytes: 142 * GB,
    ramBytes: ram(142 * GB, 'moe'),
    paramsBillions: 236
  },
  // deepseek-v2
  {
    family: 'deepseek',
    sizeKey: 'standard',
    ollamaName: 'deepseek-v2:16b',
    sizeBytes: 10 * GB,
    ramBytes: ram(10 * GB, 'moe'),
    paramsBillions: 16
  },
  {
    family: 'deepseek',
    sizeKey: 'extreme',
    ollamaName: 'deepseek-v2:236b',
    sizeBytes: 142 * GB,
    ramBytes: ram(142 * GB, 'moe'),
    paramsBillions: 236
  },
  // deepseek-coder-v2
  {
    family: 'deepseek',
    sizeKey: 'standard',
    ollamaName: 'deepseek-coder-v2:16b',
    sizeBytes: 10 * GB,
    ramBytes: ram(10 * GB, 'moe'),
    paramsBillions: 16
  },
  {
    family: 'deepseek',
    sizeKey: 'extreme',
    ollamaName: 'deepseek-coder-v2:236b',
    sizeBytes: 142 * GB,
    ramBytes: ram(142 * GB, 'moe'),
    paramsBillions: 236
  },
  // deepseek-coder
  {
    family: 'deepseek',
    sizeKey: 'nano',
    ollamaName: 'deepseek-coder:1.3b',
    sizeBytes: Math.round(0.8 * GB),
    ramBytes: ram(0.8 * GB, 'dense'),
    paramsBillions: 1.3
  },
  {
    family: 'deepseek',
    sizeKey: 'compact',
    ollamaName: 'deepseek-coder:6.7b',
    sizeBytes: Math.round(3.8 * GB),
    ramBytes: ram(3.8 * GB, 'dense'),
    paramsBillions: 6.7
  },
  {
    family: 'deepseek',
    sizeKey: 'pro',
    ollamaName: 'deepseek-coder:33b',
    sizeBytes: 19 * GB,
    ramBytes: ram(19 * GB, 'dense'),
    paramsBillions: 33
  },
  // deepseek-llm
  {
    family: 'deepseek',
    sizeKey: 'compact',
    ollamaName: 'deepseek-llm:7b',
    sizeBytes: Math.round(4.4 * GB),
    ramBytes: ram(4.4 * GB, 'dense'),
    paramsBillions: 7
  },
  {
    family: 'deepseek',
    sizeKey: 'ultra',
    ollamaName: 'deepseek-llm:67b',
    sizeBytes: 40 * GB,
    ramBytes: ram(40 * GB, 'dense'),
    paramsBillions: 67
  },
  // deepseek-ocr
  {
    family: 'deepseek',
    sizeKey: 'mini',
    ollamaName: 'deepseek-ocr:3b',
    sizeBytes: Math.round(6.7 * GB),
    ramBytes: ram(6.7 * GB, 'multimodal'),
    paramsBillions: 3
  }
] as const

export function modelByName(name: string): ModelEntry | undefined {
  return MODEL_CATALOG.find((m) => m.ollamaName === name)
}

export function isKnownModelName(name: string | null | undefined): name is string {
  if (!name) return false
  return MODEL_CATALOG.some((m) => m.ollamaName === name)
}
