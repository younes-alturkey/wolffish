jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The model picker without a Local/Cloud switch: a provider row, then the lit
 * provider's models. Pinned here:
 *
 * - Ollama is one chip among the providers — listed while the desktop's
 *   daemon is up, and hidden like a keyless cloud provider when it is not,
 *   unless it is the side answering (the lit provider always keeps its chip);
 * - only providers with a key get a chip, the desktop's own rule;
 * - picking Ollama sets `localOnly`; picking a cloud provider writes the brain
 *   and clears `localOnly` — the runtime is a consequence of the pick, never a
 *   thing flipped on its own;
 * - the model row follows the lit provider, and a model the desktop's list
 *   has lost still gets a chip so the row never shows nothing lit;
 * - tapping what is already lit writes nothing.
 */

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

import { ModelSwitch } from '@/components/chat/ModelSwitch'
import { setConfigValue, useDemoConfig, type DemoProvider } from '@/state/demoConfig'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import '@/lib/i18n'

jest.mock('@/state/demoConfig', () => {
  const actual = jest.requireActual('@/state/demoConfig')
  return { ...actual, setConfigValue: jest.fn(actual.setConfigValue) }
})

const setValue = setConfigValue as jest.MockedFunction<typeof setConfigValue>

const PROVIDERS: DemoProvider[] = [
  { id: 'deepseek', model: 'deepseek-v4-pro', hasKey: true, models: ['deepseek-v4-pro'] },
  { id: 'kimi', model: 'kimi-k3', hasKey: true, models: ['kimi-k3', 'kimi-k2.5'] },
  { id: 'openai', model: 'gpt-5.6', hasKey: false, models: ['gpt-5.6'] }
]

function seed(over: Partial<ReturnType<typeof useDemoConfig.getState>> = {}): void {
  useDemoConfig.setState({
    localOnly: false,
    localModel: 'gemma4:e2b',
    localModels: ['gemma4:e2b', 'qwen3.5:9b'],
    ollamaRunning: true,
    brainProvider: 'kimi',
    brainModel: 'kimi-k3',
    providers: PROVIDERS,
    ...over
  })
}

const providerChips = (): string[] =>
  within(screen.getByLabelText('Provider'))
    .getAllByRole('tab')
    .map((chip) => chip.props.accessibilityLabel)
const modelChips = (): string[] =>
  within(screen.getByLabelText('Model'))
    .getAllByRole('tab')
    .map((chip) => chip.props.accessibilityLabel)
const lit = (row: string): string | undefined =>
  within(screen.getByLabelText(row))
    .getAllByRole('tab')
    .find((chip) => chip.props.accessibilityState.selected)?.props.accessibilityLabel

afterEach(() => {
  cleanup()
  setValue.mockClear()
})

describe('ModelSwitch (provider, then model)', () => {
  it('lists Ollama beside the keyed cloud providers, the lit one marked', async () => {
    seed()
    await render(<ModelSwitch />)

    expect(providerChips()).toEqual(['Ollama', 'DeepSeek', 'Kimi'])
    expect(lit('Provider')).toBe('Kimi')
    expect(modelChips()).toEqual(['kimi-k3', 'kimi-k2.5'])
    expect(lit('Model')).toBe('kimi-k3')
  })

  it('hides Ollama while the desktop daemon is down', async () => {
    seed({ ollamaRunning: false })
    await render(<ModelSwitch />)
    expect(providerChips()).toEqual(['DeepSeek', 'Kimi'])
  })

  it('keeps Ollama listed while it is answering, daemon or not', async () => {
    seed({ ollamaRunning: false, localOnly: true })
    await render(<ModelSwitch />)
    expect(providerChips()).toEqual(['Ollama', 'DeepSeek', 'Kimi'])
    expect(lit('Provider')).toBe('Ollama')
  })

  it('picking Ollama turns localOnly on and shows the local models', async () => {
    seed()
    await render(<ModelSwitch />)

    fireEvent.press(within(screen.getByLabelText('Provider')).getByLabelText('Ollama'))
    expect(setValue).toHaveBeenCalledWith('localOnly', true)
    expect(setValue).not.toHaveBeenCalledWith('localModel', expect.anything())

    await waitFor(() => expect(lit('Provider')).toBe('Ollama'))
    expect(modelChips()).toEqual(['gemma4:e2b', 'qwen3.5:9b'])
    expect(lit('Model')).toBe('gemma4:e2b')
  })

  it('picking Ollama with no local model chosen lands on the first pulled one', async () => {
    seed({ localModel: '' })
    await render(<ModelSwitch />)

    fireEvent.press(within(screen.getByLabelText('Provider')).getByLabelText('Ollama'))
    expect(setValue).toHaveBeenCalledWith('localModel', 'gemma4:e2b')
    expect(setValue).toHaveBeenCalledWith('localOnly', true)
  })

  it('picking a local model writes only localModel', async () => {
    seed({ localOnly: true })
    await render(<ModelSwitch />)

    fireEvent.press(within(screen.getByLabelText('Model')).getByLabelText('qwen3.5:9b'))
    expect(setValue.mock.calls).toEqual([['localModel', 'qwen3.5:9b']])
    await waitFor(() => expect(lit('Model')).toBe('qwen3.5:9b'))
  })

  it('picking a cloud provider while local writes the brain and turns localOnly off', async () => {
    seed({ localOnly: true })
    await render(<ModelSwitch />)

    fireEvent.press(within(screen.getByLabelText('Provider')).getByLabelText('DeepSeek'))
    expect(setValue.mock.calls).toEqual([
      ['brainProvider', 'deepseek'],
      ['brainModel', 'deepseek-v4-pro'],
      ['localOnly', false]
    ])
    await waitFor(() => expect(lit('Provider')).toBe('DeepSeek'))
    expect(modelChips()).toEqual(['deepseek-v4-pro'])
  })

  it('picking a cloud model writes brainModel and mirrors it onto the provider', async () => {
    seed()
    await render(<ModelSwitch />)

    fireEvent.press(within(screen.getByLabelText('Model')).getByLabelText('kimi-k2.5'))
    expect(setValue).toHaveBeenCalledWith('brainModel', 'kimi-k2.5')
    expect(setValue).not.toHaveBeenCalledWith('localOnly', expect.anything())
    expect(useDemoConfig.getState().providers.find((p) => p.id === 'kimi')?.model).toBe('kimi-k2.5')
  })

  it('keeps a chip for a lit provider or model the desktop list has lost', async () => {
    seed({ brainProvider: 'anthropic', brainModel: 'claude-opus-4-8' })
    await render(<ModelSwitch />)

    expect(providerChips()).toEqual(['Ollama', 'DeepSeek', 'Kimi', 'Anthropic'])
    expect(lit('Provider')).toBe('Anthropic')
    expect(modelChips()).toEqual(['claude-opus-4-8'])
    expect(lit('Model')).toBe('claude-opus-4-8')
  })

  it('writes nothing when the lit provider is tapped again', async () => {
    seed()
    await render(<ModelSwitch />)

    fireEvent.press(within(screen.getByLabelText('Provider')).getByLabelText('Kimi'))
    expect(setValue).not.toHaveBeenCalled()
  })

  it('writes nothing when the lit model is tapped again', async () => {
    seed()
    await render(<ModelSwitch />)

    fireEvent.press(within(screen.getByLabelText('Model')).getByLabelText('kimi-k3'))
    expect(setValue).not.toHaveBeenCalled()
  })
})
