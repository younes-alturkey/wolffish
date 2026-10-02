import { describe, expect, test } from 'bun:test'
import { KeyEvent } from '@opentui/core'
import { DEFINITIONS, Keymap, parseBindings, type ActionName } from '../tui/keymap'

function key(
  name: string,
  mods: Partial<{ ctrl: boolean; shift: boolean; meta: boolean }> = {}
): KeyEvent {
  return new KeyEvent({
    name,
    ctrl: !!mods.ctrl,
    shift: !!mods.shift,
    meta: !!mods.meta,
    option: false,
    sequence: name,
    number: false,
    raw: name,
    eventType: 'press',
    source: 'kitty'
  } as never)
}

describe('keymap', () => {
  test('every default parses to at least one chord unless "none"', () => {
    for (const [name, def] of Object.entries(DEFINITIONS)) {
      const chords = parseBindings(def.default)
      if ((def.default as string) !== 'none') expect(chords.length, name).toBeGreaterThan(0)
    }
  })

  test('shift+enter is newline, plain enter is submit', () => {
    const km = new Keymap()
    const candidates: ActionName[] = ['input_submit', 'input_newline']
    expect(km.resolve(key('return'), candidates)).toBe('input_submit')
    expect(km.resolve(key('return', { shift: true }), candidates)).toBe('input_newline')
    expect(km.resolve(key('return', { ctrl: true }), candidates)).toBe('input_newline')
    expect(km.resolve(key('return', { meta: true }), candidates)).toBe('input_newline')
    expect(km.resolve(key('j', { ctrl: true }), candidates)).toBe('input_newline')
  })

  test('leader sequences resolve across two events', () => {
    const km = new Keymap()
    const candidates: ActionName[] = ['model_list', 'session_list', 'app_exit']
    expect(km.resolve(key('x', { ctrl: true }), candidates)).toBe('pending')
    expect(km.resolve(key('m'), candidates)).toBe('model_list')
    expect(km.resolve(key('x', { ctrl: true }), candidates)).toBe('pending')
    expect(km.resolve(key('q'), candidates)).toBe('app_exit')
  })

  test('a dead-end sequence falls through', () => {
    const km = new Keymap()
    expect(km.resolve(key('x', { ctrl: true }), ['model_list'])).toBe('pending')
    expect(km.resolve(key('z'), ['model_list'])).toBe(null)
    expect(km.leaderPending).toBe(false)
  })

  test('overrides replace defaults and "none" unbinds', () => {
    const km = new Keymap({ model_list: 'f5', session_list: 'none' })
    expect(km.label('model_list')).toBe('f5')
    expect(km.label('session_list')).toBe('')
    expect(km.resolve(key('f5'), ['model_list'])).toBe('model_list')
  })

  test('labels are human', () => {
    const km = new Keymap()
    expect(km.label('command_palette')).toBe('ctrl+p')
    expect(km.label('model_list')).toBe('ctrl+x m')
    expect(km.label('input_newline')).toBe('shift+enter')
  })
})
