/**
 * "Allow for this conversation" (amygdala.ts): an approved_session decision
 * records a rule scoped to the request's sessionKey and auto-approves later
 * calls with the same rule; the rule for shell_exec is the command head
 * (plus the subcommand for git/npm-style heads); other conversations and
 * other commands still prompt; block-level calls never reach approval.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/session-allow.test.ts
 */
import { Amygdala, sessionAllowRule, type ApprovalDecision } from '../amygdala'

let passed = 0
let failed = 0
function ok(name: string, cond: unknown, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
    if (detail !== undefined)
      console.log('    ', typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}

type Call = { id: string; name: string; args: Record<string, unknown> }
const call = (name: string, args: Record<string, unknown>): Call => ({
  id: `c_${Math.random()}`,
  name,
  args
})

async function main(): Promise<void> {
  console.log('rules')
  ok(
    'shell rule keys on the command head',
    sessionAllowRule(call('shell_exec', { command: 'ls -la /tmp' })) === 'shell_exec:ls'
  )
  ok(
    'git keeps its subcommand',
    sessionAllowRule(call('shell_exec', { command: 'git push origin main' })) ===
      'shell_exec:git push'
  )
  ok(
    'npm install and npm run are different rules',
    sessionAllowRule(call('shell_exec', { command: 'npm install foo' })) !==
      sessionAllowRule(call('shell_exec', { command: 'npm run build' }))
  )
  ok(
    'sudo and env prefixes are stripped',
    sessionAllowRule(call('shell_exec', { command: 'sudo FOO=1 apt-get install x' })) ===
      'shell_exec:apt-get install'
  )
  ok(
    'every command of a chain keys the rule',
    sessionAllowRule(call('shell_exec', { command: 'npm install && rm -rf dist' })) ===
      'shell_exec:npm install && rm'
  )
  ok(
    'a chain never matches a grant made for its first command alone',
    sessionAllowRule(call('shell_exec', { command: 'npm install' })) !==
      sessionAllowRule(call('shell_exec', { command: 'npm install && rm -rf ~/Documents' }))
  )
  // Every other way a second command hides on one line. `&&` was the obvious
  // one; each of these reached the same rule as the plain command and so rode
  // a grant made for it.
  {
    const plain = sessionAllowRule(call('shell_exec', { command: 'npm install' }))
    const hidden = [
      'npm install\nrm -rf ~/Documents',
      'npm install & rm -rf ~/Documents',
      'npm install; rm -rf ~/Documents',
      'npm install | tee /tmp/log',
      'npm install $(rm -rf ~/Documents)',
      'npm install `rm -rf ~/Documents`'
    ]
    for (const command of hidden) {
      ok(
        `a second command behind ${JSON.stringify(command.slice(12, 20))} does not ride the grant`,
        sessionAllowRule(call('shell_exec', { command })) !== plain,
        sessionAllowRule(call('shell_exec', { command }))
      )
    }
  }
  ok(
    'a write redirect does not ride a plain grant',
    sessionAllowRule(call('shell_exec', { command: 'npm install > ~/.zshrc' })) !==
      sessionAllowRule(call('shell_exec', { command: 'npm install' }))
  )
  ok(
    'a redirect is not a second command',
    sessionAllowRule(call('shell_exec', { command: 'npm test 2>&1' })) ===
      sessionAllowRule(call('shell_exec', { command: 'npm test' }))
  )
  ok(
    'a flag is not a subcommand',
    sessionAllowRule(call('shell_exec', { command: 'git --version' })) === 'shell_exec:git'
  )
  ok(
    'non-shell tools key on the tool name',
    sessionAllowRule(call('file_write', { path: '/etc/hosts' })) === 'file_write'
  )

  console.log('flow')
  const decisions: ApprovalDecision[] = []
  const prompts: string[] = []
  const amygdala = new Amygdala({
    approvalBridge: async (req) => {
      prompts.push(
        req.toolCall.name + ':' + String(req.toolCall.args.command ?? req.toolCall.args.path ?? '')
      )
      return decisions.shift() ?? 'denied'
    }
  })
  const ask = (c: ReturnType<typeof call>, sessionKey: string): Promise<ApprovalDecision> =>
    amygdala.requestApproval({ toolCall: c, level: 'confirm', reason: 'test', sessionKey })

  decisions.push('approved_session')
  const first = await ask(call('shell_exec', { command: 'npm install left-pad' }), 'conv-a')
  ok('approved_session resolves as approved for the current call', first === 'approved', first)
  ok(
    'the rule is recorded for the conversation',
    amygdala.sessionAllowRules('conv-a').includes('shell_exec:npm install'),
    amygdala.sessionAllowRules('conv-a')
  )

  const second = await ask(call('shell_exec', { command: 'npm install other-pkg' }), 'conv-a')
  ok(
    'a later matching call auto-approves without prompting',
    second === 'approved' && prompts.length === 1,
    { second, prompts }
  )

  decisions.push('denied')
  const other = await ask(call('shell_exec', { command: 'npm run build' }), 'conv-a')
  ok('a different subcommand still prompts', other === 'denied' && prompts.length === 2, {
    other,
    prompts
  })

  decisions.push('denied')
  const elsewhere = await ask(call('shell_exec', { command: 'npm install x' }), 'conv-b')
  ok('another conversation still prompts', elsewhere === 'denied' && prompts.length === 3, {
    elsewhere,
    prompts
  })

  decisions.push('approved')
  const plain = await ask(call('shell_exec', { command: 'git push' }), 'conv-a')
  ok(
    'a plain approve records nothing',
    plain === 'approved' && !amygdala.sessionAllowRules('conv-a').includes('shell_exec:git push')
  )

  amygdala.clearSessionAllow('conv-a')
  ok('clearing drops the rules', amygdala.sessionAllowRules('conv-a').length === 0)

  const noKey = await (async () => {
    decisions.push('approved_session')
    return amygdala.requestApproval({
      toolCall: call('file_write', { path: '/etc/x' }),
      level: 'confirm',
      reason: 't'
    })
  })()
  ok('approved_session without a session key still approves once', noKey === 'approved')

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void main()
