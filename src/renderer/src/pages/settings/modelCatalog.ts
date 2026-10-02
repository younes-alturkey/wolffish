import {
  AnthropicLogo,
  DeepSeekLogo,
  KimiLogo,
  MiniMaxLogo,
  MimoLogo,
  OpenAILogo,
  OpenRouterLogo,
  QwenLogo,
  StepfunLogo,
  XAILogo,
  ZaiLogo
} from '@components/core/ProviderLogos'
import type { CloudProviderConfig } from '@preload/index'
import type { ComponentType } from 'react'
import type { IconType } from 'react-icons'

// Shared model-metadata catalog: per-provider model specs (context, pricing,
// capability badges), provider logos, and the OpenRouter sort/filter helpers.
// Defined here once so both the provider connection panels and the Brain page
// render from a single source of truth.
type ProviderId = CloudProviderConfig['id']

export const PROVIDER_LOGOS: Record<
  ProviderId,
  IconType | ComponentType<{ size?: number; className?: string }>
> = {
  anthropic: AnthropicLogo,
  openai: OpenAILogo,
  openrouter: OpenRouterLogo,
  deepseek: DeepSeekLogo,
  mimo: MimoLogo,
  kimi: KimiLogo,
  minimax: MiniMaxLogo,
  xai: XAILogo,
  qwen: QwenLogo,
  stepfun: StepfunLogo,
  zai: ZaiLogo
}

export type BadgeKind = 'frontier' | 'vision' | 'reasoning' | 'code' | 'fast' | 'voice'

/** Display order for provider groups (chat model picker, settings sub-tabs). */
export const PROVIDER_ORDER: ProviderId[] = [
  'deepseek',
  'zai',
  'qwen',
  'kimi',
  'minimax',
  'mimo',
  'stepfun',
  'anthropic',
  'openai',
  'xai',
  'openrouter'
]

/**
 * The model auto-selected when a provider first connects (when the user hasn't
 * already picked one). Each is the provider's current flagship; if it isn't in
 * the freshly fetched catalogue the connect flow falls back to the first
 * selectable model. Purely a sensible default — the user can change it any time
 * from the chat composer's model picker.
 */
export const DEFAULT_MODEL: Partial<Record<ProviderId, string>> = {
  deepseek: 'deepseek-flash',
  zai: 'glm-5.2',
  qwen: 'qwen3.8-max',
  kimi: 'kimi-k3',
  minimax: 'MiniMax-M3',
  mimo: 'mimo-v2.5-pro',
  stepfun: 'step-3.7-flash',
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-5.5',
  xai: 'grok-4.6',
  openrouter: 'deepseek/deepseek-v4-pro'
}

export type ModelSpec = {
  name: string
  context: string
  input: string
  output: string
  cached: string | null
  badges?: BadgeKind[]
  /** Thinking mode keys available for this model (translation keys under chat.thinkingMode). */
  modes?: string[]
}

export const MODEL_SPECS: Record<ProviderId, ModelSpec[]> = {
  anthropic: [
    {
      name: 'claude-fable-5',
      context: '1M',
      input: '$10.00',
      output: '$50.00',
      cached: '$1.00',
      badges: ['frontier', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'claude-opus-4-8',
      context: '1M',
      input: '$5.00',
      output: '$25.00',
      cached: '$0.50',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'claude-opus-4-7',
      context: '1M',
      input: '$5.00',
      output: '$25.00',
      cached: '$0.50',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'claude-sonnet-4-6',
      context: '1M',
      input: '$3.00',
      output: '$15.00',
      cached: '$0.30',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'claude-opus-4-6',
      context: '1M',
      input: '$5.00',
      output: '$25.00',
      cached: '$0.50',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'claude-opus-4-5-20251101',
      context: '200K',
      input: '$5.00',
      output: '$25.00',
      cached: '$0.50',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'claude-sonnet-4-5-20250929',
      context: '200K',
      input: '$3.00',
      output: '$15.00',
      cached: '$0.30',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'claude-haiku-4-5-20251001',
      context: '200K',
      input: '$1.00',
      output: '$5.00',
      cached: '$0.10',
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'claude-opus-4-1-20250805',
      context: '200K',
      input: '$15.00',
      output: '$75.00',
      cached: '$1.50',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    }
  ],
  openai: [
    {
      name: 'gpt-5.5',
      context: '1M',
      input: '$5.00',
      output: '$30.00',
      cached: '$0.50',
      badges: ['frontier', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'gpt-5.4',
      context: '1M',
      input: '$2.50',
      output: '$15.00',
      cached: '$0.25',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'gpt-5.4-mini',
      context: '1M',
      input: '$0.75',
      output: '$4.50',
      cached: '$0.08',
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'gpt-5.4-nano',
      context: '1M',
      input: '$0.20',
      output: '$1.25',
      cached: '$0.02',
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'gpt-5.2',
      context: '1M',
      input: '—',
      output: '—',
      cached: null,
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'gpt-5.1',
      context: '1M',
      input: '—',
      output: '—',
      cached: null,
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'gpt-5',
      context: '1M',
      input: '$2.50',
      output: '$10.00',
      cached: '$1.25',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'gpt-5-mini',
      context: '1M',
      input: '$0.25',
      output: '$2.00',
      cached: '$0.03',
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'gpt-5-nano',
      context: '1M',
      input: '$0.05',
      output: '$0.40',
      cached: '$0.01',
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'o3',
      context: '200K',
      input: '$10.00',
      output: '$40.00',
      cached: '$5.00',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'o4-mini',
      context: '200K',
      input: '$1.10',
      output: '$4.40',
      cached: '$0.55',
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'o3-mini',
      context: '200K',
      input: '$1.10',
      output: '$4.40',
      cached: '$0.55',
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'o1',
      context: '200K',
      input: '$15.00',
      output: '$60.00',
      cached: '$7.50',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'gpt-4.1',
      context: '1M',
      input: '$2.00',
      output: '$8.00',
      cached: '$0.50'
    },
    {
      name: 'gpt-4.1-mini',
      context: '1M',
      input: '$0.40',
      output: '$1.60',
      cached: '$0.10',
      badges: ['fast']
    },
    {
      name: 'gpt-4.1-nano',
      context: '1M',
      input: '$0.10',
      output: '$0.40',
      cached: '$0.03',
      badges: ['fast']
    },
    {
      name: 'gpt-4o',
      context: '128K',
      input: '$2.50',
      output: '$10.00',
      cached: '$1.25'
    },
    {
      name: 'gpt-4o-mini',
      context: '128K',
      input: '$0.15',
      output: '$0.60',
      cached: '$0.08',
      badges: ['fast']
    },
    {
      name: 'gpt-4-turbo',
      context: '128K',
      input: '$10.00',
      output: '$30.00',
      cached: null
    },
    {
      name: 'gpt-4',
      context: '8K',
      input: '$30.00',
      output: '$60.00',
      cached: null
    }
  ],
  zai: [
    {
      name: 'glm-5.2',
      context: '1M',
      input: '$1.40',
      output: '$4.40',
      cached: '$0.26',
      badges: ['frontier', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'glm-5.1',
      context: '200K',
      input: '$1.40',
      output: '$4.40',
      cached: '$0.26',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'glm-5-turbo',
      context: '200K',
      input: '$1.20',
      output: '$4.00',
      cached: '$0.24',
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'glm-5',
      context: '200K',
      input: '$1.00',
      output: '$3.20',
      cached: '$0.20',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'glm-4.7',
      context: '200K',
      input: '$0.60',
      output: '$2.20',
      cached: '$0.11',
      badges: ['reasoning'],
      modes: ['none', 'on']
    },
    {
      name: 'glm-4.6',
      context: '200K',
      input: '$0.60',
      output: '$2.20',
      cached: '$0.11',
      badges: ['reasoning'],
      modes: ['none', 'on']
    },
    {
      name: 'glm-4.5',
      context: '128K',
      input: '$0.60',
      output: '$2.20',
      cached: '$0.11',
      badges: ['reasoning'],
      modes: ['none', 'on']
    },
    {
      name: 'glm-4.5-air',
      context: '128K',
      input: '$0.20',
      output: '$1.10',
      cached: '$0.03',
      badges: ['fast', 'reasoning'],
      modes: ['none', 'on']
    }
  ],
  // DeepSeek bills peak/off-peak since 2026-08-16 (peak 01:00-04:00 and
  // 06:00-10:00 UTC Mon-Fri; off-peak is half) — shown as ranges, low end
  // first. `deepseek-flash` is DeepSeek-V4.1-Flash (the id carries no version
  // number); it replaced the whole v4-flash line on 2026-09-11 — the old ids
  // still resolve to it — and sees images. deepseek-v4-pro stays listed at its
  // own prices; from 2026-09-14 DeepSeek routes it to V4.1-Flash and bills the
  // Flash rate, so re-check this row after that date (until a V4.1 Pro ships).
  deepseek: [
    {
      name: 'deepseek-flash',
      context: '1M',
      input: '$0.15–0.30',
      output: '$0.60–1.20',
      cached: '$0.003–0.006',
      badges: ['fast', 'vision', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'deepseek-v4-pro',
      context: '1M',
      input: '$0.66–1.32',
      output: '$1.98–3.96',
      cached: '$0.022–0.044',
      badges: ['frontier', 'reasoning'],
      modes: ['none', 'high', 'max']
    }
  ],
  mimo: [
    {
      name: 'mimo-v2.5-pro',
      context: '1M',
      input: '$0.20',
      output: '$2.00',
      cached: 'Free',
      badges: ['frontier', 'reasoning'],
      modes: ['none', 'on']
    },
    {
      name: 'mimo-v2.5',
      context: '1M',
      input: '$0.08',
      output: '$0.80',
      cached: 'Free',
      badges: ['reasoning'],
      modes: ['none', 'on']
    },
    {
      name: 'mimo-v2-pro',
      context: '256K',
      input: '$0.20',
      output: '$2.00',
      cached: 'Free',
      badges: ['reasoning'],
      modes: ['none', 'on']
    },
    {
      name: 'mimo-v2-omni',
      context: '256K',
      input: '$0.08',
      output: '$0.80',
      cached: 'Free',
      badges: ['vision', 'reasoning'],
      modes: ['none', 'on']
    },
    {
      name: 'mimo-v2-flash',
      context: '256K',
      input: '$0.01',
      output: '$0.30',
      cached: null,
      badges: ['fast', 'reasoning'],
      modes: ['none', 'on']
    }
  ],
  kimi: [
    {
      name: 'kimi-k3',
      context: '1M',
      input: '$3.00',
      output: '$15.00',
      cached: '$0.30',
      badges: ['frontier', 'vision', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'kimi-k2.6',
      context: '256K',
      input: '$0.95',
      output: '$4.00',
      cached: '$0.16',
      badges: ['vision', 'reasoning'],
      modes: ['none', 'on']
    },
    {
      name: 'kimi-k2.5',
      context: '256K',
      input: '$0.60',
      output: '$3.00',
      cached: '$0.10',
      badges: ['vision', 'reasoning'],
      modes: ['none', 'on']
    },
    {
      name: 'kimi-k2.7-code',
      context: '256K',
      input: '—',
      output: '—',
      cached: null,
      badges: ['code', 'reasoning'],
      modes: ['on']
    },
    {
      name: 'kimi-k2.7-code-highspeed',
      context: '256K',
      input: '—',
      output: '—',
      cached: null,
      badges: ['code', 'fast', 'reasoning'],
      modes: ['on']
    },
    { name: 'moonshot-v1-auto', context: '128K', input: '$1.00', output: '$3.00', cached: null },
    { name: 'moonshot-v1-128k', context: '128K', input: '$2.00', output: '$5.00', cached: null },
    { name: 'moonshot-v1-32k', context: '32K', input: '$1.00', output: '$3.00', cached: null },
    { name: 'moonshot-v1-8k', context: '8K', input: '$0.20', output: '$2.00', cached: null }
  ],
  minimax: [
    {
      name: 'MiniMax-M3',
      context: '1M',
      input: '$0.30',
      output: '$1.20',
      cached: '$0.06',
      badges: ['frontier', 'reasoning'],
      modes: ['none', 'on']
    },
    {
      name: 'MiniMax-M2.7',
      context: '200K',
      input: '$0.30',
      output: '$1.20',
      cached: '$0.06',
      badges: ['reasoning'],
      modes: ['on']
    },
    {
      name: 'MiniMax-M2.7-highspeed',
      context: '200K',
      input: '$0.60',
      output: '$2.40',
      cached: '$0.06',
      badges: ['fast', 'reasoning'],
      modes: ['on']
    },
    {
      name: 'MiniMax-M2.5',
      context: '200K',
      input: '$0.30',
      output: '$1.20',
      cached: '$0.03',
      badges: ['code', 'reasoning'],
      modes: ['on']
    },
    {
      name: 'MiniMax-M2.5-highspeed',
      context: '200K',
      input: '$0.60',
      output: '$2.40',
      cached: '$0.03',
      badges: ['code', 'fast', 'reasoning'],
      modes: ['on']
    },
    {
      name: 'MiniMax-M2.1',
      context: '200K',
      input: '$0.30',
      output: '$1.20',
      cached: '$0.03',
      badges: ['reasoning'],
      modes: ['on']
    },
    {
      name: 'MiniMax-M2.1-highspeed',
      context: '200K',
      input: '$0.60',
      output: '$2.40',
      cached: '$0.03',
      badges: ['fast', 'reasoning'],
      modes: ['on']
    },
    {
      name: 'MiniMax-M2',
      context: '200K',
      input: '$0.30',
      output: '$1.20',
      cached: '$0.03',
      badges: ['reasoning'],
      modes: ['on']
    }
  ],
  xai: [
    {
      name: 'grok-4.6',
      context: '500K',
      input: '$2.00',
      output: '$6.00',
      cached: '$0.50',
      badges: ['frontier', 'vision', 'reasoning'],
      modes: ['on', 'high', 'max']
    },
    {
      name: 'grok-4.5',
      context: '500K',
      input: '$2.00',
      output: '$6.00',
      cached: '$0.30',
      badges: ['vision', 'reasoning'],
      modes: ['on', 'high', 'max']
    },
    {
      name: 'grok-4.3',
      context: '1M',
      input: '$1.25',
      output: '$2.50',
      cached: '$0.20',
      badges: ['vision', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'grok-4.20-0309-reasoning',
      context: '1M',
      input: '$1.25',
      output: '$2.50',
      cached: '$0.20',
      badges: ['vision', 'reasoning'],
      modes: ['on']
    },
    {
      name: 'grok-4.20-0309-non-reasoning',
      context: '1M',
      input: '$1.25',
      output: '$2.50',
      cached: '$0.20',
      badges: ['vision']
    },
    {
      name: 'grok-build-0.1',
      context: '256K',
      input: '$1.00',
      output: '$2.00',
      cached: '$0.20',
      badges: ['code', 'reasoning'],
      modes: ['on']
    }
  ],
  qwen: [
    {
      name: 'qwen3.8-max',
      context: '1M',
      input: '$2.00',
      output: '$6.00',
      cached: '$0.25',
      badges: ['frontier', 'vision', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'qwen3.7-max',
      context: '1M',
      input: '$2.50',
      output: '$7.50',
      cached: '$0.25',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'qwen3.7-plus',
      context: '1M',
      input: '$0.40',
      output: '$1.60',
      cached: '$0.064',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'qwen3.6-plus',
      context: '1M',
      input: '$0.40',
      output: '$1.60',
      cached: '$0.04',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'qwen3.6-flash',
      context: '1M',
      input: '$0.25',
      output: '$1.50',
      cached: '$0.025',
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'qwen3.5-plus',
      context: '1M',
      input: '$0.40',
      output: '$1.60',
      cached: '$0.04',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'qwen3.5-flash',
      context: '1M',
      input: '$0.06',
      output: '$0.24',
      cached: '$0.006',
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'qwen3-max',
      context: '131K',
      input: '$1.60',
      output: '$6.40',
      cached: '$0.40',
      badges: ['reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'qwen3-coder-plus',
      context: '131K',
      input: '$0.40',
      output: '$1.60',
      cached: '$0.04',
      badges: ['code', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'qwen3-coder-flash',
      context: '131K',
      input: '$0.40',
      output: '$1.60',
      cached: '$0.04',
      badges: ['code', 'fast', 'reasoning'],
      modes: ['none', 'high', 'max']
    },
    {
      name: 'qwq-plus',
      context: '131K',
      input: '$0.40',
      output: '$1.60',
      cached: '$0.04',
      badges: ['reasoning'],
      modes: ['on']
    },
    {
      name: 'qvq-max',
      context: '131K',
      input: '$1.60',
      output: '$6.40',
      cached: '$0.16',
      badges: ['vision', 'reasoning'],
      modes: ['on']
    },
    {
      name: 'qwen-max',
      context: '131K',
      input: '$1.60',
      output: '$6.40',
      cached: '$0.16'
    },
    {
      name: 'qwen-plus',
      context: '131K',
      input: '$0.40',
      output: '$1.60',
      cached: '$0.04',
      badges: ['fast']
    },
    {
      name: 'qwen-turbo',
      context: '1M',
      input: '$0.30',
      output: '$0.60',
      cached: '$0.03',
      badges: ['fast']
    },
    {
      name: 'qwen-flash',
      context: '1M',
      input: '$0.06',
      output: '$0.24',
      cached: '$0.006',
      badges: ['fast']
    }
  ],
  stepfun: [
    {
      name: 'step-3.7-flash',
      context: '128K',
      input: '$0.83',
      output: '$6.94',
      cached: null,
      badges: ['frontier', 'reasoning'],
      modes: ['on']
    },
    {
      name: 'step-3.5-flash',
      context: '128K',
      input: '$0.83',
      output: '$6.94',
      cached: null,
      badges: ['fast', 'reasoning'],
      modes: ['on']
    }
  ],
  openrouter: [
    {
      name: 'anthropic/claude-opus-4.1',
      context: '200K',
      input: '$15.00',
      output: '$75.00',
      cached: null,
      badges: ['reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'anthropic/claude-sonnet-4.5',
      context: '1M',
      input: '$3.00',
      output: '$15.00',
      cached: null,
      badges: ['reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'openai/gpt-5',
      context: '400K',
      input: '$1.25',
      output: '$10.00',
      cached: null,
      badges: ['reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'openai/gpt-5-mini',
      context: '400K',
      input: '$0.25',
      output: '$2.00',
      cached: null,
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'openai/o3',
      context: '200K',
      input: '$2.00',
      output: '$8.00',
      cached: null,
      badges: ['reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'openai/o4-mini',
      context: '200K',
      input: '$1.10',
      output: '$4.40',
      cached: null,
      badges: ['fast', 'reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'openai/gpt-4o',
      context: '128K',
      input: '$2.50',
      output: '$10.00',
      cached: null,
      badges: ['vision']
    },
    {
      name: 'openai/gpt-4.1',
      context: '1M',
      input: '$2.00',
      output: '$8.00',
      cached: null
    },
    {
      name: 'google/gemini-2.5-pro',
      context: '1M',
      input: '$1.25',
      output: '$10.00',
      cached: null,
      badges: ['vision', 'reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'google/gemini-2.5-flash',
      context: '1M',
      input: '$0.30',
      output: '$2.50',
      cached: null,
      badges: ['fast', 'vision', 'reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'deepseek/deepseek-r1',
      context: '164K',
      input: '$0.70',
      output: '$2.50',
      cached: null,
      badges: ['reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'deepseek/deepseek-chat-v3.1',
      context: '164K',
      input: '$0.21',
      output: '$0.79',
      cached: null,
      badges: ['reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'x-ai/grok-4.6',
      context: '500K',
      input: '$2.00',
      output: '$6.00',
      cached: null,
      badges: ['vision', 'reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'x-ai/grok-4.5',
      context: '500K',
      input: '$2.00',
      output: '$6.00',
      cached: null,
      badges: ['vision', 'reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'x-ai/grok-4.3',
      context: '1M',
      input: '$1.25',
      output: '$2.50',
      cached: null,
      badges: ['vision', 'reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'qwen/qwen3-235b-a22b',
      context: '131K',
      input: '$0.45',
      output: '$1.82',
      cached: null,
      badges: ['reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'z-ai/glm-4.6',
      context: '203K',
      input: '$0.43',
      output: '$1.74',
      cached: null,
      badges: ['reasoning'],
      modes: ['none', 'high']
    },
    {
      name: 'meta-llama/llama-4-maverick',
      context: '1M',
      input: '$0.15',
      output: '$0.60',
      cached: null,
      badges: ['fast']
    },
    {
      name: 'meta-llama/llama-3.3-70b-instruct',
      context: '131K',
      input: '$0.10',
      output: '$0.32',
      cached: null,
      badges: ['fast']
    },
    {
      name: 'mistralai/mistral-large',
      context: '128K',
      input: '$2.00',
      output: '$6.00',
      cached: null
    },
    {
      name: 'mistralai/mistral-medium-3',
      context: '131K',
      input: '$0.40',
      output: '$2.00',
      cached: null,
      badges: ['fast']
    },
    {
      name: 'moonshotai/kimi-k3',
      context: '1M',
      input: '$3.00',
      output: '$15.00',
      cached: null,
      badges: ['reasoning'],
      modes: ['none', 'high']
    }
  ]
}

/** Look up a model's rich metadata by provider + model id. Null when absent. */
/**
 * Compact display name for a model id — fits composer pills and tight rows.
 * Keeps the last path segment (OpenRouter ids are vendor/model) and strips
 * date stamps and -latest/-preview suffixes. Conservative: never rewrites
 * the family/version part, so the name stays recognizable.
 */
export function shortModelName(id: string): string {
  let name = id.split('/').pop() ?? id
  name = name.replace(/[-_.](20\d{6}|20\d{2}-\d{2}-\d{2})$/, '')
  name = name.replace(/-(latest|preview)$/i, '')
  return name
}

export function findModelSpec(provider: ProviderId, modelId: string): ModelSpec | null {
  return MODEL_SPECS[provider]?.find((m) => m.name === modelId) ?? null
}

// ── OpenRouter model sorting ──────────────────────────────────────────
// Tier 0: US frontier labs, Tier 1: Chinese labs, Tier 2: everything else.
// Tier 0: providers wolffish supports directly (sorted first)
// Tier 1: other US frontier labs
// Tier 2: other Chinese labs
// Tier 3: European / rest (fallback for unknown slugs)
const OPENROUTER_PROVIDER_TIER: Record<string, number> = {
  anthropic: 0,
  openai: 0,
  deepseek: 0,
  qwen: 0,
  xiaomi: 0,
  moonshotai: 0,
  minimax: 0,
  stepfun: 0,
  'z-ai': 0,
  google: 1,
  'x-ai': 1,
  'meta-llama': 1,
  perplexity: 1,
  amazon: 1,
  mistralai: 2,
  cohere: 2,
  microsoft: 2,
  nousresearch: 2
}

function openRouterProviderSlug(modelId: string): string {
  const slash = modelId.indexOf('/')
  return slash > 0 ? modelId.slice(0, slash) : ''
}

export function sortOpenRouterModels<T extends { name: string; badges?: BadgeKind[] }>(
  items: T[]
): T[] {
  return items.slice().sort((a, b) => {
    const slugA = openRouterProviderSlug(a.name)
    const slugB = openRouterProviderSlug(b.name)
    const tierA = OPENROUTER_PROVIDER_TIER[slugA] ?? 3
    const tierB = OPENROUTER_PROVIDER_TIER[slugB] ?? 3
    if (tierA !== tierB) return tierA - tierB
    if (slugA !== slugB) return slugA.localeCompare(slugB)
    const fA = a.badges?.includes('frontier') ? 0 : 1
    const fB = b.badges?.includes('frontier') ? 0 : 1
    return fA - fB
  })
}

export function sortOpenRouterModelIds(ids: readonly string[]): string[] {
  return ids.slice().sort((a, b) => {
    const disA = isModelDisabled(a) ? 1 : 0
    const disB = isModelDisabled(b) ? 1 : 0
    if (disA !== disB) return disA - disB
    const slugA = openRouterProviderSlug(a)
    const slugB = openRouterProviderSlug(b)
    const tierA = OPENROUTER_PROVIDER_TIER[slugA] ?? 3
    const tierB = OPENROUTER_PROVIDER_TIER[slugB] ?? 3
    if (tierA !== tierB) return tierA - tierB
    if (slugA !== slugB) return slugA.localeCompare(slugB)
    return a.localeCompare(b)
  })
}

export const BADGE_STYLES: Record<BadgeKind, string> = {
  frontier: 'bg-accent/15 text-accent',
  vision: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  reasoning: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  code: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  fast: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  voice: 'bg-pink-500/15 text-pink-600 dark:text-pink-400'
}

export function isModelDisabled(id: string): boolean {
  if (/tts|voiceclone|voicedesign/.test(id)) return true
  if (/^(gpt-5[\d.]*-(pro|codex)|o\d+-pro)/.test(id)) return true
  if (/(-image|-audio|lyria)/i.test(id)) return true
  // MiniMax video models (H3, Hailuo): generation models, not chat brains —
  // the `video` capability is their surface. The main-side fetch filter
  // (isMiniMaxChatModel) already drops them; this is the defensive twin in
  // case one ever lands in a stored models list.
  if (/^minimax-(h\d|hailuo)/i.test(id)) return true
  return false
}
