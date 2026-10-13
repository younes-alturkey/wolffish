/**
 * Every string the Projects, Procedures and Automations screens can put on
 * screen, in both locales.
 *
 * i18next answers a MISSING key with the key itself, so a gap does not throw —
 * it renders `heartbeat.editor.duplicate` inside a red error line, or a button
 * labelled `projects.addFiles`. These three screens were ported from the desktop
 * key by key, which is exactly the operation where one gets dropped, and the
 * Arabic half is the one nobody notices.
 */

import ar from '@/lib/i18n/locales/ar.json'
import en from '@/lib/i18n/locales/en.json'
import { CHIP_KINDS, GUIDE_ROWS } from '@/lib/automations/heartbeat'

const LOCALES = { en, ar } as Record<string, Record<string, unknown>>

function lookup(bundle: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      bundle
    )
}

/** Every schedule kind parseSchedule can return — each needs a type chip. */
const SCHEDULE_KINDS = [
  'startup',
  'once',
  'every',
  'hourly',
  'daily',
  'weekday',
  'weekly',
  'monthly',
  'cron'
]

const KEYS = [
  // The nav rows that reach the three screens.
  'settings.tabs.projects',
  'settings.tabs.procedures',
  'settings.tabs.automations',
  // Projects
  'projects.title',
  'projects.subtitle',
  'projects.new',
  'projects.untitled',
  'projects.empty',
  'projects.editedAt',
  'projects.usedAt',
  'projects.conversationCount',
  'projects.fileCount',
  'projects.edit',
  'projects.editTitle',
  'projects.titlePlaceholder',
  'projects.titleRequired',
  'projects.instructions',
  'projects.instructionsPlaceholder',
  'projects.noInstructions',
  'projects.addInstructions',
  'projects.editInstructions',
  'projects.pickIcon',
  'projects.emojiSearch',
  'projects.emojiNoResults',
  'projects.files',
  'projects.addFiles',
  'projects.copyingFiles',
  'projects.copyingCount',
  'projects.removeFile',
  'projects.newConversation',
  'projects.exit',
  'projects.autosaveHint',
  'projects.view.project',
  'projects.view.controls',
  'projects.readOnly',
  'projects.done',
  'projects.delete',
  'projects.deleteTitle',
  'projects.deleteWarning',
  'projects.deleteConfirm',
  'projects.deleteCancel',
  'projects.deleteSuccess',
  'projects.saveError',
  // Procedures
  'procedures.title',
  'procedures.subtitle',
  'procedures.new',
  'procedures.untitled',
  'procedures.empty',
  'procedures.editedAt',
  'procedures.run',
  'procedures.runEmptyHint',
  'procedures.edit',
  'procedures.editTitle',
  'procedures.titlePlaceholder',
  'procedures.titleRequired',
  'procedures.pickIcon',
  'procedures.project',
  'procedures.projectNone',
  'procedures.projectIcon',
  'procedures.promptPlaceholder',
  'procedures.addPrompt',
  'procedures.editPrompt',
  'procedures.autosaveHint',
  'procedures.done',
  'procedures.delete',
  'procedures.deleteTitle',
  'procedures.deleteWarning',
  'procedures.deleteConfirm',
  'procedures.deleteCancel',
  'procedures.deleteSuccess',
  'procedures.saveError',
  'procedures.modeAria',
  // Automations
  'heartbeat.title',
  'heartbeat.subtitle',
  'heartbeat.new',
  'heartbeat.empty',
  'heartbeat.editedAt',
  'heartbeat.nextRun',
  'heartbeat.onLaunch',
  'heartbeat.promptEmpty',
  'heartbeat.edit',
  'heartbeat.active',
  'heartbeat.inactive',
  'heartbeat.run',
  'heartbeat.runStarted',
  'heartbeat.runQueued',
  'heartbeat.noteRunning',
  'heartbeat.noteQueued',
  'heartbeat.runError',
  'heartbeat.delete',
  'heartbeat.deleteTitle',
  'heartbeat.deleteWarning',
  'heartbeat.deleteConfirm',
  'heartbeat.deleteCancel',
  'heartbeat.deleteSuccess',
  'heartbeat.editor.createTitle',
  'heartbeat.editor.editTitle',
  'heartbeat.editor.schedule',
  'heartbeat.editor.pickIcon',
  'heartbeat.editor.project',
  'heartbeat.editor.projectNone',
  'heartbeat.editor.projectIcon',
  'heartbeat.editor.invalid',
  'heartbeat.editor.duplicate',
  'heartbeat.editor.pastOnce',
  'heartbeat.editor.cronUnknown',
  'heartbeat.editor.prompt',
  'heartbeat.editor.promptPlaceholder',
  'heartbeat.editor.autosaveHint',
  'heartbeat.editor.done',
  'heartbeat.editor.guideButton',
  'heartbeat.guide.title',
  'heartbeat.guide.intro',
  'heartbeat.guide.localTime',
  'heartbeat.guide.chipsTip',
  // Shared chrome these screens borrow.
  'common.done',
  'common.loading',
  'workspace.saveError',
  'relative.inShort',
  'relative.agoShort',
  'settings.toggle.on',
  'settings.toggle.off',
  'settings.chatModes.single',
  'settings.chatModes.workflow',
  'chat.menu.title',
  // Both derived sets, so adding a schedule form or a chip cannot ship unlabelled.
  ...SCHEDULE_KINDS.map((kind) => `heartbeat.type.${kind}`),
  ...GUIDE_ROWS.map((row) => `heartbeat.guide.${row.key}`),
  ...CHIP_KINDS.map((kind) => `heartbeat.editor.chips.${kind}`)
]

describe.each(Object.keys(LOCALES))('%s', (locale) => {
  it.each(KEYS)('has real text for %s', (key) => {
    const value = lookup(LOCALES[locale], key)
    expect(typeof value).toBe('string')
    expect(value).not.toBe('')
    expect(value).not.toBe(key)
  })
})
