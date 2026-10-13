/**
 * heartbeat.md parsing and splicing.
 *
 * This module writes a workspace file the desktop's SCHEDULER parses and the
 * desktop's own page edits, so a wrong splice does not merely look wrong on this
 * phone — it changes what runs on that machine, or silently un-comments the
 * examples block, or duplicates a marker on every save. The failure mode is
 * invisible until an automation fires (or stops firing), which is why the whole
 * grammar is pinned here rather than sampled.
 */

import {
  attachJobs,
  chipSchedule,
  chipStateOf,
  deleteBlock,
  escapePromptBody,
  findBlock,
  nextCronMs,
  orderAutomations,
  parseAutomations,
  parseSchedule,
  setBlockMode,
  stripLeadingSettings,
  toggleBlock,
  writeDraft
} from '@/lib/automations/heartbeat'

/**
 * A file in the shape the desktop actually ships: two live automations, one
 * switched off, and the commented-out examples block at the end. That last part
 * is the trap — it is a raw comment, not an automation, and every operation here
 * has to leave it alone.
 */
const FILE = [
  '# Heartbeat',
  '',
  '## Daily (09:00)',
  '',
  'project: proj-1',
  'icon: 📊',
  '',
  'Summarize yesterday.',
  '',
  '## Every (30m)',
  '',
  'mode: workflow',
  'icon: 🔁',
  '',
  'Check the inbox.',
  'Reply to anything urgent.',
  '',
  '<!-- ## Weekly (Monday 09:30)',
  '',
  'icon: 📅',
  '',
  'Plan the week.',
  '-->',
  '',
  '<!--',
  '## Nightly (23:00)',
  'An example nobody enabled.',
  '-->',
  ''
].join('\n')

describe('parseSchedule', () => {
  it.each([
    ['Startup', 'startup', null],
    ['Every (30m)', 'every', '*/30 * * * *'],
    ['Every (2h)', 'every', '0 */2 * * *'],
    ['Hourly (15)', 'hourly', '15 * * * *'],
    ['Daily (08:00)', 'daily', '0 8 * * *'],
    ['Nightly (23:00)', 'daily', '0 23 * * *'],
    ['Weekday (09:00)', 'weekday', '0 9 * * 1-5'],
    ['Weekly (Monday 09:30)', 'weekly', '30 9 * * 1'],
    ['Monthly (1 09:00)', 'monthly', '0 9 1 * *'],
    ['Cron (0 9 * * 1,3,5)', 'cron', '0 9 * * 1,3,5'],
    // Lists: several times a day / week / month in ONE heading. Times sharing
    // a minute fold into one expression; distinct minutes join with " ; ".
    ['Daily (08:00, 14:00, 20:00)', 'daily', '0 8,14,20 * * *'],
    ['Daily (08:00, 12:30, 18:00)', 'daily', '0 8,18 * * * ; 30 12 * * *'],
    ['Weekday (09:00, 17:00)', 'weekday', '0 9,17 * * 1-5'],
    ['Weekly (Monday, Wednesday, Friday 09:00)', 'weekly', '0 9 * * 1,3,5'],
    ['Weekly (Mon, wed, FRI 09:00, 17:00)', 'weekly', '0 9,17 * * 1,3,5'],
    ['Monthly (1, 15 09:00)', 'monthly', '0 9 1,15 * *'],
    ['Cron (0 8 * * * ;30 12 * * *)', 'cron', '0 8 * * * ; 30 12 * * *']
  ])('reads %s', (heading, type, cron) => {
    expect(parseSchedule(heading)).toMatchObject({ type, cron })
  })

  it('reads a Once heading as an absolute local moment', () => {
    const parsed = parseSchedule('Once (2026-08-01 15:00)')
    expect(parsed?.type).toBe('once')
    expect(parsed?.atMs).toBe(new Date(2026, 7, 1, 15, 0, 0, 0).getTime())
  })

  it('refuses a Once date that does not exist, as the engine does', () => {
    // The round-trip guard: Date would roll month 13 into next January and
    // register a job the user never asked for.
    expect(parseSchedule('Once (2026-13-01 15:00)')).toBeNull()
    expect(parseSchedule('Once (2026-02-30 15:00)')).toBeNull()
    expect(parseSchedule('Once (2026-08-01 25:99)')).toBeNull()
  })

  it('is not a schedule', () => {
    expect(parseSchedule('Notes')).toBeNull()
    expect(parseSchedule('Daily')).toBeNull()
    expect(parseSchedule('Daily ()')).toBeNull()
    expect(parseSchedule('Weekly (Monday 09:00) x')).toBeNull()
  })
})

describe('nextCronMs', () => {
  // Friday 2026-09-11 09:00.
  const now = new Date(2026, 8, 11, 9, 0).getTime()

  it('takes the earliest part of a multi-expression cron', () => {
    expect(nextCronMs('0 8,18 * * * ; 30 12 * * *', now)).toBe(
      new Date(2026, 8, 11, 12, 30).getTime()
    )
  })

  it('resolves day lists', () => {
    expect(nextCronMs('0 9 * * 1,3,5', now)).toBe(new Date(2026, 8, 14, 9, 0).getTime())
    expect(nextCronMs('0 9 1,15 * *', now)).toBe(new Date(2026, 8, 15, 9, 0).getTime())
  })
})

describe('parseAutomations', () => {
  const blocks = parseAutomations(FILE)

  it('finds every automation, active and inactive, in file order', () => {
    expect(blocks.map((b) => [b.label, b.active])).toEqual([
      ['Daily (09:00)', true],
      ['Every (30m)', true],
      ['Weekly (Monday 09:30)', false]
    ])
  })

  it('never reads the examples comment as an automation', () => {
    // `## Nightly (23:00)` lives inside a raw comment block. Reading it as a
    // switched-off automation would put a card on screen for something that is
    // documentation, and toggling that card would un-comment the examples.
    expect(blocks.some((b) => b.label === 'Nightly (23:00)')).toBe(false)
  })

  it('captures the markers and keeps them out of the prompt', () => {
    expect(blocks[0]).toMatchObject({ project: 'proj-1', icon: '📊', mode: null })
    expect(blocks[0].body).toBe('Summarize yesterday.')
    expect(blocks[1]).toMatchObject({ mode: 'workflow', icon: '🔁', project: null })
    expect(blocks[1].body).toBe('Check the inbox.\nReply to anything urgent.')
  })

  it('reads the markers of a switched-off automation too', () => {
    // The scheduler never sees this one, so the file is the only source for it.
    expect(blocks[2]).toMatchObject({ icon: '📅', active: false })
    expect(blocks[2].body).toBe('Plan the week.')
  })

  it('ends an inactive block at its closing marker', () => {
    const lines = FILE.split('\n')
    expect(lines[blocks[2].lineIndex]).toBe('<!-- ## Weekly (Monday 09:30)')
    expect(lines[blocks[2].endLineIndex]).toBe('-->')
  })

  it('reads a body-less one-line disabled automation', () => {
    const blocks = parseAutomations('<!-- ## Startup -->\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ label: 'Startup', active: false, body: '' })
  })
})

describe('stripLeadingSettings', () => {
  it('drops leading markers and the blanks between them', () => {
    expect(stripLeadingSettings('mode: single\n\nicon: 🫀\n\nDo the thing.')).toBe('Do the thing.')
  })

  it('leaves a marker-looking line that is not leading', () => {
    // Past the first real content the engine treats these as prose, so must we.
    expect(stripLeadingSettings('Do it.\nicon: 🫀')).toBe('Do it.\nicon: 🫀')
  })
})

describe('escapePromptBody', () => {
  it('respells the lines the block grammar would eat, and only those', () => {
    const pasted = [
      '# Title',
      '## Prompt',
      '##No space is not a heading',
      'Plain line.',
      '---',
      '### Deeper headings are already safe'
    ].join('\n')
    expect(escapePromptBody(pasted)).toBe(
      [
        '# Title',
        ' ## Prompt',
        '##No space is not a heading',
        'Plain line.',
        ' ---',
        '### Deeper headings are already safe'
      ].join('\n')
    )
  })

  it('defuses comment tokens anywhere — the engine strips them position-blind', () => {
    expect(escapePromptBody('keep <!-- this --> visible')).toBe('keep < !-- this -- > visible')
    expect(escapePromptBody('<!--\nalone\n-->')).toBe('< !--\nalone\n-- >')
  })

  it('is idempotent, so re-saving a parsed body never grows', () => {
    const once = escapePromptBody('## Prompt\n---\n<!-- x -->')
    expect(escapePromptBody(once)).toBe(once)
  })
})

describe('writeDraft with a prompt full of markdown structure', () => {
  /** The shape that bit for real: a pasted doc with its own `## ` sections. */
  const PASTED = [
    '# Automation — Daily Quiz',
    '',
    '**Schedule:** every day at 07:00',
    '',
    '## Prompt',
    '',
    'You are running unattended. Build the quiz and send it.',
    '',
    '---',
    '',
    '## When he replies',
    '',
    'Grade cold. <!-- no praise -->'
  ].join('\n')

  it('round-trips the whole prompt — nothing truncates at its `## ` sections', () => {
    const { markdown } = writeDraft(FILE, null, {
      schedule: 'Daily (07:00)',
      prompt: PASTED,
      icon: '🩺',
      projectId: ''
    })
    const blocks = parseAutomations(markdown)
    const added = blocks.find((b) => b.label === 'Daily (07:00)')
    // Every section survives, in the escaped spelling; the sibling automations
    // and the examples comment are untouched.
    expect(added?.body).toBe(escapePromptBody(PASTED))
    expect(added?.body).toContain('## When he replies')
    expect(added?.body).toContain('Grade cold.')
    expect(blocks).toHaveLength(4)
    expect(markdown).toContain('<!--\n## Nightly (23:00)')
  })

  it('keeps the block replaceable across saves — no orphaned tail accumulates', () => {
    let markdown = FILE
    let bound: { label: string; active: boolean } | null = null
    for (let i = 0; i < 3; i++) {
      const result = writeDraft(markdown, bound, {
        schedule: 'Daily (07:00)',
        prompt: PASTED,
        icon: '🩺',
        projectId: ''
      })
      markdown = result.markdown
      bound = result.bound
    }
    expect(markdown.match(/## When he replies/g)).toHaveLength(1)
    expect(parseAutomations(markdown)).toHaveLength(4)
  })

  it('survives being switched off and back on with its body intact', () => {
    const { markdown } = writeDraft(FILE, null, {
      schedule: 'Daily (07:00)',
      prompt: PASTED,
      icon: '🩺',
      projectId: ''
    })
    const off = toggleBlock(
      markdown,
      findBlock(markdown, { label: 'Daily (07:00)', active: true })!
    )
    const offBlock = parseAutomations(off).find((b) => b.label === 'Daily (07:00)')
    expect(offBlock).toMatchObject({ active: false, body: escapePromptBody(PASTED) })
    const on = toggleBlock(off, offBlock!)
    const onBlock = parseAutomations(on).find((b) => b.label === 'Daily (07:00)')
    expect(onBlock).toMatchObject({ active: true, body: escapePromptBody(PASTED) })
  })
})

describe('writeDraft', () => {
  it('inserts a new automation before the examples comment', () => {
    const { markdown, bound } = writeDraft(FILE, null, {
      schedule: 'Hourly (5)',
      prompt: 'Ping.',
      icon: '🔔',
      projectId: ''
    })
    const blocks = parseAutomations(markdown)
    const added = blocks.find((b) => b.label === 'Hourly (5)')
    expect(added).toMatchObject({ active: true, icon: '🔔', body: 'Ping.', project: null })
    expect(bound).toEqual({ label: 'Hourly (5)', active: true })
    // The examples block survives, still commented out.
    expect(markdown).toContain('<!--\n## Nightly (23:00)')
    expect(parseAutomations(markdown)).toHaveLength(4)
  })

  it('always writes an icon marker, so every automation has an emoji', () => {
    const { markdown } = writeDraft('', null, {
      schedule: 'Startup',
      prompt: 'Wake up.',
      icon: '',
      projectId: ''
    })
    expect(parseAutomations(markdown)[0].icon).toBe('🫀')
  })

  it('replaces the bound block in place, keeping its mode and its state', () => {
    const { markdown } = writeDraft(
      FILE,
      { label: 'Every (30m)', active: true },
      {
        schedule: 'Every (45m)',
        prompt: 'Check the inbox only.',
        icon: '🔁',
        projectId: 'proj-2'
      }
    )
    const blocks = parseAutomations(markdown)
    expect(blocks.map((b) => b.label)).toEqual([
      'Daily (09:00)',
      'Every (45m)',
      'Weekly (Monday 09:30)'
    ])
    // The mode marker was the card's, not the editor's — rewriting the block
    // must not silently drop it.
    expect(blocks[1]).toMatchObject({
      mode: 'workflow',
      project: 'proj-2',
      icon: '🔁',
      body: 'Check the inbox only.',
      active: true
    })
  })

  it('keeps a switched-off automation switched off', () => {
    const { markdown } = writeDraft(
      FILE,
      { label: 'Weekly (Monday 09:30)', active: false },
      {
        schedule: 'Weekly (Tuesday 09:30)',
        prompt: 'Plan the week, properly.',
        icon: '📅',
        projectId: ''
      }
    )
    const block = parseAutomations(markdown).find((b) => b.label === 'Weekly (Tuesday 09:30)')
    expect(block).toMatchObject({ active: false, body: 'Plan the week, properly.' })
  })

  it('does not duplicate the marker block over repeated saves', () => {
    // The bug this guards: the previous save's markers arrive back in the prompt
    // and fresh ones get composed on top, so the block grows a marker pair on
    // every keystroke burst.
    let markdown = FILE
    let bound: { label: string; active: boolean } | null = {
      label: 'Daily (09:00)',
      active: true
    }
    for (let i = 0; i < 3; i++) {
      const result = writeDraft(markdown, bound, {
        schedule: 'Daily (09:00)',
        prompt: `Summarize yesterday. (${i})`,
        icon: '📊',
        projectId: 'proj-1'
      })
      markdown = result.markdown
      bound = result.bound
    }
    expect(markdown.match(/icon: 📊/g)).toHaveLength(1)
    expect(markdown.match(/project: proj-1/g)).toHaveLength(1)
    expect(parseAutomations(markdown)[0].body).toBe('Summarize yesterday. (2)')
  })

  it('inserts rather than losing work when the bound block has vanished', () => {
    const { markdown } = writeDraft(
      FILE,
      { label: 'Gone (00:00)', active: true },
      {
        schedule: 'Daily (07:00)',
        prompt: 'Kept.',
        icon: '🫀',
        projectId: ''
      }
    )
    expect(parseAutomations(markdown).some((b) => b.body === 'Kept.')).toBe(true)
  })
})

describe('toggleBlock', () => {
  it('comments a live automation out and back in, unchanged', () => {
    const blocks = parseAutomations(FILE)
    const off = toggleBlock(FILE, blocks[0])
    const offBlock = parseAutomations(off).find((b) => b.label === 'Daily (09:00)')!
    expect(offBlock.active).toBe(false)
    expect(offBlock).toMatchObject({ project: 'proj-1', icon: '📊', body: 'Summarize yesterday.' })

    const back = toggleBlock(off, offBlock)
    expect(back).toBe(FILE)
  })

  it('switches an inactive block on', () => {
    const blocks = parseAutomations(FILE)
    const on = parseAutomations(toggleBlock(FILE, blocks[2])).find(
      (b) => b.label === 'Weekly (Monday 09:30)'
    )
    expect(on).toMatchObject({ active: true, body: 'Plan the week.', icon: '📅' })
  })

  it('leaves the examples comment intact when the last automation is switched off', () => {
    const blocks = parseAutomations(FILE)
    const off = toggleBlock(FILE, blocks[1])
    expect(off).toContain('<!--\n## Nightly (23:00)')
    expect(parseAutomations(off).some((b) => b.label === 'Nightly (23:00)')).toBe(false)
  })

  it('handles the one-line disabled form', () => {
    const on = toggleBlock('<!-- ## Startup -->\n', parseAutomations('<!-- ## Startup -->\n')[0])
    expect(parseAutomations(on)[0]).toMatchObject({ label: 'Startup', active: true })
  })
})

describe('setBlockMode', () => {
  it('rewrites an existing marker', () => {
    const blocks = parseAutomations(FILE)
    const next = setBlockMode(FILE, blocks[1], 'single')
    expect(parseAutomations(next)[1].mode).toBe('single')
    expect(next.match(/^mode: /gm)).toHaveLength(1)
  })

  it('inserts a marker where there is none', () => {
    const blocks = parseAutomations(FILE)
    const next = setBlockMode(FILE, blocks[0], 'workflow')
    const block = parseAutomations(next).find((b) => b.label === 'Daily (09:00)')!
    expect(block.mode).toBe('workflow')
    // The other markers and the prompt survive.
    expect(block).toMatchObject({ project: 'proj-1', icon: '📊', body: 'Summarize yesterday.' })
  })

  it('converts a one-line disabled automation to the block form', () => {
    // Splicing the marker after the one-liner would put it OUTSIDE the comment,
    // where the engine folds it into the previous automation's instructions.
    const file = '## Daily (09:00)\n\nFirst.\n\n<!-- ## Startup -->\n'
    const startup = parseAutomations(file).find((b) => b.label === 'Startup')!
    const next = setBlockMode(file, startup, 'single')
    const blocks = parseAutomations(next)
    expect(blocks.find((b) => b.label === 'Startup')).toMatchObject({
      mode: 'single',
      active: false
    })
    // And the marker did not leak into the automation above it.
    expect(blocks.find((b) => b.label === 'Daily (09:00)')!.body).toBe('First.')
  })
})

describe('deleteBlock', () => {
  it('removes the automation and nothing else', () => {
    const blocks = parseAutomations(FILE)
    const next = deleteBlock(FILE, blocks[1])
    expect(parseAutomations(next).map((b) => b.label)).toEqual([
      'Daily (09:00)',
      'Weekly (Monday 09:30)'
    ])
    expect(next).toContain('<!--\n## Nightly (23:00)')
  })

  it('does not accumulate blank lines', () => {
    const blocks = parseAutomations(FILE)
    const next = deleteBlock(FILE, blocks[0])
    expect(next).not.toMatch(/\n\n\n/)
  })
})

describe('findBlock', () => {
  it('prefers the exact label+state match, then falls back to the label', () => {
    expect(findBlock(FILE, { label: 'Daily (09:00)', active: true })?.lineIndex).toBe(2)
    // A block that was switched off elsewhere is still found by label, which is
    // what keeps an open editor writing to the right block.
    expect(findBlock(FILE, { label: 'Weekly (Monday 09:30)', active: true })?.active).toBe(false)
    expect(findBlock(FILE, { label: 'Nope', active: true })).toBeNull()
  })
})

describe('attachJobs', () => {
  it('takes the cron and next fire from the scheduler, never the body', () => {
    const blocks = parseAutomations(FILE)
    const merged = attachJobs(blocks, [
      { label: 'Daily (09:00)', cron: '0 9 * * *', nextRunMs: 1_700_000_000_000 }
    ])
    expect(merged[0]).toMatchObject({ cron: '0 9 * * *', nextRunMs: 1_700_000_000_000 })
    expect(merged[0].body).toBe('Summarize yesterday.')
    // An automation the scheduler does not know keeps what the file says.
    expect(merged[2].nextRunMs).toBeNull()
  })
})

describe('orderAutomations', () => {
  it('sorts by fire order, with unschedulable then inactive last', () => {
    const rows = orderAutomations([
      { label: 'inactive', active: false, nextRunMs: 1 },
      { label: 'no-moment', active: true, nextRunMs: null },
      { label: 'later', active: true, nextRunMs: 3_000 },
      { label: 'soon', active: true, nextRunMs: 2_000 }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any)
    expect(rows.map((r) => r.label)).toEqual(['soon', 'later', 'no-moment', 'inactive'])
  })
})

describe('nextCronMs', () => {
  // Fixed instant: Thursday 2026-08-06 10:20 local.
  const now = new Date(2026, 7, 6, 10, 20).getTime()

  it('resolves the forms the schedule chips produce', () => {
    expect(nextCronMs('0 9 * * *', now)).toBe(new Date(2026, 7, 7, 9, 0).getTime())
    expect(nextCronMs('*/30 * * * *', now)).toBe(new Date(2026, 7, 6, 10, 30).getTime())
    expect(nextCronMs('15 * * * *', now)).toBe(new Date(2026, 7, 6, 11, 15).getTime())
    // Weekly and monthly are the two the desktop's old shortcut resolver could
    // not answer at all, which is why this one scans days.
    expect(nextCronMs('30 9 * * 1', now)).toBe(new Date(2026, 7, 10, 9, 30).getTime())
    expect(nextCronMs('0 9 1 * *', now)).toBe(new Date(2026, 8, 1, 9, 0).getTime())
    expect(nextCronMs('0 9 * * 1-5', now)).toBe(new Date(2026, 7, 7, 9, 0).getTime())
  })

  it('answers nothing for an expression it cannot read', () => {
    expect(nextCronMs('not a cron', now)).toBeNull()
    expect(nextCronMs('0 9 * *', now)).toBeNull()
    expect(nextCronMs('99 9 * * *', now)).toBeNull()
  })
})

describe('chipSchedule', () => {
  // Wednesday 2026-08-05 14:07 → the anchor rounds up to 14:10.
  const now = new Date(2026, 7, 5, 14, 7).getTime()

  it('produces a schedule the parser accepts, starting about now', () => {
    expect(chipSchedule('hourly', now)).toBe('Hourly (10)')
    expect(chipSchedule('daily', now)).toBe('Daily (14:10)')
    expect(chipSchedule('weekly', now)).toBe('Weekly (Wednesday 14:10)')
    expect(chipSchedule('monthly', now)).toBe('Monthly (5 14:10)')
    for (const kind of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
      expect(parseSchedule(chipSchedule(kind, now))).not.toBeNull()
    }
  })

  it('spreads several runs evenly across the period, the first on the anchor', () => {
    expect(chipSchedule('hourly', now, 3)).toBe('Every (20m)')
    expect(chipSchedule('daily', now, 2)).toBe('Daily (02:10, 14:10)')
    expect(chipSchedule('daily', now, 3)).toBe('Daily (06:10, 14:10, 22:10)')
    expect(chipSchedule('weekly', now, 2)).toBe('Weekly (Wednesday, Saturday 14:10)')
    expect(chipSchedule('weekly', now, 3)).toBe('Weekly (Sunday, Wednesday, Friday 14:10)')
    expect(chipSchedule('monthly', now, 2)).toBe('Monthly (5, 19 14:10)')
    expect(chipSchedule('monthly', now, 4)).toBe('Monthly (5, 12, 19, 26 14:10)')
    expect(chipSchedule('hourly', now, 5)).toBe('Every (12m)')
    expect(chipSchedule('daily', now, 5)).toBe('Daily (04:10, 09:10, 14:10, 18:10, 23:10)')
    for (const kind of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
      for (const times of [1, 2, 3, 4, 5] as const) {
        const heading = chipSchedule(kind, now, times)
        const parsed = parseSchedule(heading)
        expect(parsed?.cron && nextCronMs(parsed.cron, now)).not.toBeNull()
        // The pills read their lit state back off the heading they built.
        expect(chipStateOf(heading)).toEqual({ kind, times })
      }
    }
  })

  it('lights the pills from the heading text, whoever wrote it', () => {
    expect(chipStateOf('Daily (08:00, 12:30, 18:00)')).toEqual({ kind: 'daily', times: 3 })
    expect(chipStateOf('Weekly (Mon, Fri 09:00, 17:00)')).toEqual({ kind: 'weekly', times: 4 })
    expect(chipStateOf('Monthly (1 09:00)')).toEqual({ kind: 'monthly', times: 1 })
    expect(chipStateOf('Hourly (30)')).toEqual({ kind: 'hourly', times: 1 })
    expect(chipStateOf('Every (30m)')).toEqual({ kind: 'hourly', times: 2 })
    // Beyond the pills: the period lights, no count does.
    expect(chipStateOf('Daily (01:00, 02:00, 03:00, 04:00, 05:00, 06:00)')).toEqual({
      kind: 'daily',
      times: null
    })
    // Not a chip form at all.
    expect(chipStateOf('Every (7m)')).toBeNull()
    expect(chipStateOf('Every (2h)')).toBeNull()
    expect(chipStateOf('Weekday (09:00)')).toBeNull()
    expect(chipStateOf('Cron (0 9 * * 1)')).toBeNull()
  })

  it('clamps the monthly day to 28 so no month is skipped', () => {
    // 09:00 anchors to 09:05: the round-up is unconditional, so a chip's first
    // run is always minutes away rather than possibly right now.
    expect(chipSchedule('monthly', new Date(2026, 0, 31, 9, 0).getTime())).toBe(
      'Monthly (28 09:05)'
    )
    expect(chipSchedule('monthly', new Date(2026, 0, 31, 9, 0).getTime(), 3)).toBe(
      'Monthly (9, 18, 28 09:05)'
    )
  })
})
