import { NEW_CHAT_PLAN_KEY, planModeFor, selectPlanMode, useChatRuntime } from '@/state/chatRuntime'

/**
 * Plan mode is a per-conversation stance held in memory. A fresh chat has no
 * id until its first send creates one on the desktop, so the stance is filed
 * under NEW_CHAT_PLAN_KEY and adopted by the conversation once it exists.
 */
describe('chatRuntime plan mode', () => {
  beforeEach(() => useChatRuntime.setState({ planModes: {} }))

  it('is off until switched on, per conversation', () => {
    expect(planModeFor('c1')).toBe(false)
    useChatRuntime.getState().setPlanMode('c1', true)
    expect(planModeFor('c1')).toBe(true)
    expect(planModeFor('c2')).toBe(false)
    expect(selectPlanMode('c1')(useChatRuntime.getState())).toBe(true)
  })

  it('files a fresh chat under the new-chat key and hands it to the created conversation', () => {
    useChatRuntime.getState().setPlanMode(null, true)
    expect(planModeFor(null)).toBe(true)
    expect(useChatRuntime.getState().planModes).toEqual({ [NEW_CHAT_PLAN_KEY]: true })
    useChatRuntime.getState().adoptPlanMode('c9')
    expect(useChatRuntime.getState().planModes).toEqual({ c9: true })
    expect(planModeFor('c9')).toBe(true)
    // The next fresh chat starts off again.
    expect(planModeFor(null)).toBe(false)
  })

  it('adopting with nothing pending changes nothing', () => {
    useChatRuntime.getState().setPlanMode('c1', true)
    const before = useChatRuntime.getState().planModes
    useChatRuntime.getState().adoptPlanMode('c2')
    expect(useChatRuntime.getState().planModes).toBe(before)
  })

  it('reset clears every stance', () => {
    useChatRuntime.getState().setPlanMode('c1', true)
    useChatRuntime.getState().reset()
    expect(useChatRuntime.getState().planModes).toEqual({})
  })
})
