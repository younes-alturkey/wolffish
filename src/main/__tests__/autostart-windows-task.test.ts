/**
 * The Windows task definition Wolffish registers: the exact PowerShell Task
 * Scheduler will be handed, asserted structurally — it must restart the
 * process on failure, start at logon, never time the run out, and quote a
 * path with spaces so the Execute argument survives.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/__tests__/autostart-windows-task.test.ts
 */
process.env.WOLFFISH_AUTOSTART_DRY_RUN = '1'

export {}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

async function run(): Promise<void> {
  const { windowsTaskScript } = await import('@main/autostart/autostart')
  const script = windowsTaskScript('C:\\Program Files\\Wolffish\\Wolffish.exe', [
    '--headless',
    '--no-sandbox'
  ])
  ok(
    'registers through Register-ScheduledTask',
    script.includes('Register-ScheduledTask -TaskName')
  )
  ok('named Wolffish', script.includes("-TaskName 'Wolffish'"))
  ok(
    'executes the quoted binary',
    script.includes("-Execute 'C:\\Program Files\\Wolffish\\Wolffish.exe'")
  )
  ok('passes the headless arguments', script.includes("-Argument '--headless --no-sandbox'"))
  ok('starts at logon', script.includes('New-ScheduledTaskTrigger -AtLogOn'))
  ok('restarts on failure, often', /-RestartCount 999/.test(script))
  ok('a minute between restarts', /-RestartInterval \(New-TimeSpan -Minutes 1\)/.test(script))
  ok('no execution time limit', /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/.test(script))
  ok('starts late if the trigger was missed', script.includes('-StartWhenAvailable'))
  ok('runs without elevation', script.includes('-RunLevel Limited'))
  ok('replaces an older task', script.includes('-Force'))
  ok(
    'single quotes in a path are doubled',
    windowsTaskScript("C:\\It's\\w.exe", []).includes("'C:\\It''s\\w.exe'")
  )
  console.log(`autostart-windows-task: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void run().catch((err) => {
  console.error(err)
  process.exit(1)
})
