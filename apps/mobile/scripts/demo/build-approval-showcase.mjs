#!/usr/bin/env node
/**
 * Build the approval-card conversation into demo/.
 *
 * The desktop flags a dangerous tool call and parks the turn until the user
 * decides; the decision is then persisted ON the assistant message, as
 * `approvals[toolCallId]`, and replayed from the transcript forever after. That
 * replay is what this conversation exercises — demo mode has no desktop to park
 * a live turn, so a stored, decided card is the only honest way to show the
 * feature, and it is also the state a real user sees for all but a few seconds
 * of an approval's life.
 *
 *   node scripts/demo/build-approval-showcase.mjs   # writes into demo/
 *   node scripts/demo/build-demo-bundle.mjs         # pack for the CDN
 *
 * Both outcomes are covered — two approved, one denied — because the card is a
 * different thing in each: the denied one is followed by a tool_result the
 * plugin never ran, which is exactly what a refusal looks like downstream.
 *
 * The titles and impact lines are deliberately strings that exist in the
 * `chat.approval.phrases` table, so an Arabic build renders the cards in
 * Arabic rather than falling back to English (see localizeApproval.ts).
 *
 * Timestamps anchor off conv-file-showcase so the showcases keep a fixed order
 * at the top of the list; re-run this whenever that one is regenerated.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const DEMO = process.env.DEMO_OUT ?? path.join(ROOT, 'demo')
const CONV_ID = 'approval-showcase'
/** Hours above the file showcase — see the header, and build-chart-showcase. */
const ANCHOR_OFFSET_H = 24

const MODEL = 'claude-opus-4-8'

/**
 * One flagged call: the approval record the desktop persists, plus the tool
 * call it guards and the result that call produced (or did not, when denied).
 */
const FLAGGED = [
  {
    toolCallId: 'call_release_push',
    tool: 'shell_exec',
    args: { command: 'git push --force-with-lease origin release/1.0.18', cwd: '~/dev/wolffish' },
    reason: 'Rewrites history on a shared branch',
    level: 'destructive',
    decision: 'approved',
    description: {
      title: 'Push commits to remote',
      description: 'Pushes the rebased release branch over the copy on origin.',
      command: 'git push --force-with-lease origin release/1.0.18',
      impact: 'Force-pushes the branch — may overwrite remote history.',
      risk: 'high'
    },
    output:
      'To github.com:younes-alturkey/wolffish.git\n' +
      ' + 9c1a4f2...41e7b83 release/1.0.18 -> release/1.0.18 (forced update)',
    // What the shell plugin attaches to every run (desktop ToolResultMeta):
    // the compact row on the clean feed draws its label, exit code and time
    // from this. The label is the desktop's describeCommand for the command.
    meta: {
      label: 'Push commits to remote',
      cwd: '/Users/younes/dev/wolffish',
      durationMs: 2_140,
      exitCode: 0,
      truncated: false
    }
  },
  {
    toolCallId: 'call_purge_cache',
    tool: 'file_delete',
    args: { path: '~/Library/Caches/wolffish/downloads', recursive: true },
    reason: 'Recursive delete outside the workspace',
    level: 'destructive',
    decision: 'denied',
    description: {
      title: 'Delete files',
      description: 'Removes the cached downloads directory and everything under it.',
      command: 'rm -rf ~/Library/Caches/wolffish/downloads',
      impact: 'Permanently deletes files. This cannot be undone.',
      risk: 'high'
    },
    // A denied call still gets a result — the refusal itself, which is what the
    // model reads and reasons about in the next iteration.
    denied: 'Denied by the user. Nothing was deleted.'
  },
  {
    toolCallId: 'call_install_ffmpeg',
    tool: 'shell_exec',
    args: { command: 'brew install ffmpeg' },
    reason: 'Installs software on this machine',
    level: 'confirm',
    decision: 'approved',
    description: {
      title: 'Run shell command',
      description: 'Installs the FFmpeg multimedia framework via your system package manager',
      command: 'brew install ffmpeg',
      impact: 'Downloads and installs the package. May require admin access on some systems.',
      risk: 'medium'
    },
    output:
      '==> Pouring ffmpeg--7.1.1.arm64_sequoia.bottle.tar.gz\n🍺  /opt/homebrew/Cellar/ffmpeg/7.1.1: 296 files, 51.4MB',
    meta: {
      label: 'Install with Homebrew',
      cwd: '/Users/younes',
      durationMs: 38_600,
      exitCode: 0,
      truncated: false
    }
  }
]

/** Prose between the cards, so the turn reads as work rather than a gallery. */
const LEAD_IN = {
  call_release_push:
    'Rebased cleanly — 3 commits on top of `main`, no conflicts. The remote still has the ' +
    'pre-rebase tip, so this needs a force push.',
  call_purge_cache:
    'Next: the cache. 4.2 GB under `~/Library/Caches/wolffish/downloads`, oldest entry from ' +
    'March. None of it is referenced by the workspace index.',
  call_install_ffmpeg:
    'Understood — leaving the cache alone.\n\nThe last thing blocking the build is FFmpeg: ' +
    '`ffmpeg -version` exits 127, so the media tests skip rather than fail.'
}

const CLOSING =
  'Done.\n\n' +
  '- **Release branch** pushed — `release/1.0.18` now matches your local rebase.\n' +
  '- **Cache** untouched, as you asked. It is still 4.2 GB if you change your mind.\n' +
  '- **FFmpeg** 7.1.1 installed; the media tests run again.\n\n' +
  'One thing I did not check: whether CI had already started a build against the old tip. ' +
  'If it had, that run is now testing commits that no longer exist — re-run it before ' +
  'reading the result.'

async function main() {
  await fs.mkdir(path.join(DEMO, 'conversations'), { recursive: true })

  const showcaseRaw = await fs.readFile(
    path.join(DEMO, 'conversations', 'conv-file-showcase.json'),
    'utf8'
  )
  const anchor = JSON.parse(showcaseRaw).updatedAt
  if (typeof anchor !== 'number') throw new Error('conv-file-showcase.json has no updatedAt')
  const updatedAt = anchor + ANCHOR_OFFSET_H * 3600_000
  const createdAt = updatedAt - 11 * 60_000

  const segments = []
  const approvals = {}
  const toolTimings = {}
  let step = 0

  segments.push({
    kind: 'active_model',
    turnId: 't1',
    segmentId: `s${step++}`,
    provider: 'anthropic',
    model: MODEL
  })

  for (const flagged of FLAGGED) {
    segments.push({
      kind: 'text',
      turnId: 't1',
      segmentId: `s${step++}`,
      delta: `${LEAD_IN[flagged.toolCallId]}\n`
    })
    segments.push({
      kind: 'tool_call',
      turnId: 't1',
      segmentId: `s${step++}`,
      toolCallId: flagged.toolCallId,
      name: flagged.tool,
      args: flagged.args
    })
    segments.push({
      kind: 'tool_result',
      turnId: 't1',
      segmentId: `s${step++}`,
      toolCallId: flagged.toolCallId,
      status: flagged.decision === 'denied' ? 'denied' : 'success',
      output: flagged.decision === 'denied' ? flagged.denied : flagged.output,
      ...(flagged.meta ? { meta: flagged.meta } : {})
    })
    // The record the card is replayed from. `decision` is what makes it a
    // settled card rather than a control with dead buttons.
    approvals[flagged.toolCallId] = {
      approvalId: `apr_${flagged.toolCallId}`,
      toolCallId: flagged.toolCallId,
      tool: flagged.tool,
      args: flagged.args,
      reason: flagged.reason,
      level: flagged.level,
      description: flagged.description,
      decision: flagged.decision
    }
    // A parked call is slow by construction — the clock runs while the user
    // decides, which is most of what these numbers are.
    const startedAt = createdAt + step * 4_000
    toolTimings[flagged.toolCallId] = { startedAt, endedAt: startedAt + 26_000 }
  }

  segments.push({ kind: 'text', turnId: 't1', segmentId: `s${step++}`, delta: CLOSING })
  segments.push({
    kind: 'turn_end',
    turnId: 't1',
    segmentId: `s${step++}`,
    stopReason: 'end_turn',
    iterationCount: 4
  })

  const conversation = {
    id: CONV_ID,
    title: 'Cut the 1.0.18 release branch',
    model: MODEL,
    channel: 'electron',
    createdAt,
    updatedAt,
    messages: [
      {
        id: 'm_approval_user',
        role: 'user',
        content:
          'Rebase the release branch onto main and push it, clear the download cache, and get ' +
          'ffmpeg installed so the media tests stop skipping.',
        timestamp: createdAt
      },
      {
        id: 'm_approval_assistant',
        role: 'assistant',
        content: '',
        timestamp: updatedAt,
        segments,
        approvals,
        toolTimings,
        stopReason: 'end_turn'
      }
    ],
    stats: {
      allTime: {
        turns: 1,
        toolCalls: FLAGGED.length,
        apiCalls: 4,
        inputTokens: 18_432,
        outputTokens: 1_206,
        cost: 0.0921,
        provider: 'anthropic',
        model: MODEL,
        elapsedMs: 11 * 60_000,
        endedAt: updatedAt
      },
      meter: { contextTokens: 19_638, contextBudget: 200_000, model: MODEL }
    },
    // One 0-10 score, so the rating bar opens on a turn that already has a vote
    // rather than only on an unrated one.
    ratings: [
      { messageId: 'm_approval_assistant', score: 9, at: updatedAt + 40_000, source: 'inapp' }
    ]
  }

  await fs.writeFile(
    path.join(DEMO, 'conversations', `conv-${CONV_ID}.json`),
    JSON.stringify(conversation)
  )

  const approved = FLAGGED.filter((f) => f.decision === 'approved').length
  console.log(`approvals:    ${approved} approved, ${FLAGGED.length - approved} denied`)
  console.log(`sorts above file showcase: updatedAt ${new Date(updatedAt).toISOString()}`)
  console.log(`conversation: demo/conversations/conv-${CONV_ID}.json`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
