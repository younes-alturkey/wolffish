/**
 * The in-app display switches' defaults and upgrade path, plus the run pool's
 * family classifier.
 *
 * What is checked here is the part that fails silently. A default that read as
 * `undefined` instead of its real value would still coerce today and flip the
 * moment someone wrote `?? true` somewhere; a setter that rebuilt its config
 * section would quietly reset the neighbouring switch; and the family
 * classifier is what the Automations pages on both devices use to skip
 * procedure runs when gating their play buttons — get it wrong and a heading
 * lights up as running for somebody else's job.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/inapp-config-defaults.test.ts
 */
import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-inapp-config-'))
process.env.HOME = SANDBOX

// Shim `electron` so the workspace module loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => SANDBOX,
        getVersion: () => '0.0.0-test'
      }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const {
    ensureWorkspace,
    getInAppConfig,
    setInAppConfig,
    getCompactionConfig,
    getReflectionConfig,
    setReflectionConfig,
    patchConfig
  } = await import('@main/workspace/workspace')
  const { runFamily } = await import('@main/runtime/brainstem')

  await ensureWorkspace()

  console.log('\nfresh defaults')
  {
    const inapp = await getInAppConfig()
    ok('the feed is clean by default', inapp.verbose === false)
    // The one switch here that ships ON. `=== true`, not `!!x`: `undefined`
    // would render the card today (the surfaces read `!== false`) and stop
    // rendering it the moment someone wrote `?? false` somewhere.
    ok('a fresh workspace shows the thinking card', inapp.reasoning === true)
  }

  console.log('\na config written before a switch existed reads as its default')
  {
    // The real upgrade path: sections that predate these fields entirely, and
    // sections that still carry the retired `cards` switch.
    await patchConfig((c) => ({
      ...c,
      inapp: { verbose: true, runCards: true } as never,
      compaction: { dailyHour: 4, weeklyDay: 2, weeklyHour: 5, cards: true } as never,
      reflection: { hour: 2, quietHours: 6, cards: true } as never
    }))
    const inapp = await getInAppConfig()
    const compaction = await getCompactionConfig()
    const reflection = await getReflectionConfig()
    ok('an older in-app section keeps its verbose value', inapp.verbose === true)
    // A section written before `reasoning` existed has no such key, and it
    // must read as ON rather than inheriting the absence as off.
    ok('an older in-app section still shows the thinking card', inapp.reasoning === true)
    ok('an older compaction section keeps its schedule', compaction.dailyHour === 4)
    ok('an older reflection section keeps its hour', reflection.hour === 2)
    // Reflection rebuilds its section field by field, so the retired switch
    // is dropped on the next read rather than carried forward.
    ok('a retired reflection switch is dropped', !('cards' in reflection))
  }

  console.log('\neach switch moves alone')
  {
    await setReflectionConfig({ quietHours: 8 })
    const afterQuiet = await getReflectionConfig()
    ok('a quiet-gate write writes what it was asked to', afterQuiet.quietHours === 8)
    ok('a quiet-gate write leaves the hour alone', afterQuiet.hour === 2)

    // Turning an ON-by-default switch off is the case a `??` chain gets wrong:
    // the stored `false` must survive both the read and a neighbouring write.
    await setInAppConfig({ reasoning: false })
    ok('the thinking card can be switched off', (await getInAppConfig()).reasoning === false)
    await setInAppConfig({ verbose: false })
    ok('a neighbouring write leaves it off', (await getInAppConfig()).reasoning === false)
    ok(
      'a neighbouring write writes what it was asked to',
      (await getInAppConfig()).verbose === false
    )
  }

  console.log('\nthe family a job id names')
  {
    // These ids are the scheduler's own (registerCompaction / registerReflection),
    // and both Automations pages skip `procedure` by what this returns.
    ok('the daily compaction is compaction', runFamily('compaction-daily') === 'compaction')
    ok('the weekly consolidation is compaction', runFamily('compaction-weekly') === 'compaction')
    ok('the nightly review is reflection', runFamily('reflection-nightly') === 'reflection')
    ok('the deep clean is reflection', runFamily('reflection-deepclean') === 'reflection')
    ok('a procedure run is a procedure', runFamily('procedure:abc123') === 'procedure')
    // Anything from a heading in heartbeat.md — including a label that merely
    // starts with the word, which must not be mistaken for a built-in.
    ok('a heartbeat job is an automation', runFamily('Daily sweep') === 'automation')
    ok('"compaction notes" is still an automation', runFamily('compaction notes') === 'automation')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
