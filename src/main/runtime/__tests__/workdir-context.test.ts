/**
 * Working-folder intelligence (src/main/runtime/workdir.ts) + the cwd
 * contract the shell and filesystem plugins derive from it.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/workdir-context.test.ts
 *
 * Standalone — no vitest/jest in this repo. Builds a throwaway git repo in a
 * temp dir with manifests, a Makefile, a root AGENTS.md and a nested one, then
 * checks: git facts, toolchain/check detection, the tail block wording,
 * instruction-file discovery rules (first NAME wins, ancestors stack, nearest
 * last), lazy nested discovery, and that the shell plugin's default cwd and the
 * filesystem plugin's relative-path base both follow the injected folders.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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

async function main(): Promise<void> {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-workdir-'))
  const ROOT = fs.realpathSync(TMP)

  function write(rel: string, content: string): void {
    const p = path.join(ROOT, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }

  // ── fixture ────────────────────────────────────────────────────────────────
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ROOT })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: ROOT })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: ROOT })
  write(
    'package.json',
    JSON.stringify({
      name: 'fixture',
      scripts: {
        dev: 'vite',
        build: 'tsc -b',
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
        lint: 'eslint .'
      },
      devDependencies: { typescript: '^5', eslint: '^9', vitest: '^3' }
    })
  )
  write('tsconfig.json', '{}')
  write('package-lock.json', '{}')
  write('Makefile', 'build:\n\techo b\ncheck:\n\techo c\n.PHONY: build check\n')
  write('AGENTS.md', '# Root rules\nRun `npm run typecheck` before finishing.\n')
  write('CLAUDE.md', '# Should never load when AGENTS.md exists\n')
  write('packages/a/AGENTS.md', '# Package a rules\nUse the a-conventions.\n')
  write('packages/a/src/x.ts', 'export const x = 1\n')
  write('packages/b/src/y.ts', 'export const y = 2\n')
  execFileSync('git', ['add', 'package.json', 'tsconfig.json'], { cwd: ROOT })
  execFileSync('git', ['commit', '-q', '-m', 'init fixture'], { cwd: ROOT })

  const workdir = (await import(
    pathToFileURL(path.join(process.cwd(), 'src/main/runtime/workdir.ts')).href
  )) as typeof import('../workdir')

  // ── 1. folder facts ────────────────────────────────────────────────────────
  console.log('facts')
  {
    const facts = await workdir.describeFolder(ROOT)
    ok('folder is a code project', facts.code)
    ok('git root resolved', facts.git?.root === ROOT, facts.git)
    ok('branch is main', facts.git?.branch === 'main', facts.git)
    ok('dirty count sees untracked files', (facts.git?.dirty ?? 0) >= 5, facts.git)
    ok('last commit captured', facts.git?.lastCommit.includes('init fixture'), facts.git)
    ok(
      'toolchain names npm + TypeScript + ESLint + Vitest',
      /npm \(package\.json/.test(facts.toolchain) &&
        facts.toolchain.includes('TypeScript') &&
        facts.toolchain.includes('ESLint') &&
        facts.toolchain.includes('Vitest'),
      facts.toolchain
    )
    ok(
      'scripts listed',
      facts.toolchain.includes('scripts: dev, build, test, typecheck, lint'),
      facts.toolchain
    )
    ok(
      'Makefile targets listed',
      facts.toolchain.includes('Makefile (targets: build, check)'),
      facts.toolchain
    )
    ok(
      'check commands in narrow→broad order',
      facts.checks[0] === 'npm run typecheck' &&
        facts.checks.includes('npm run lint') &&
        facts.checks.includes('npm test') &&
        facts.checks.includes('make check'),
      facts.checks
    )
    ok('run commands detected', facts.runs.includes('npm run dev'), facts.runs)

    const block = workdir.renderFolderFacts([facts])
    ok(
      'block is tagged',
      block.startsWith('<working_folder_facts>') && block.endsWith('</working_folder_facts>'),
      block
    )
    ok(
      'block states the default cwd contract',
      block.includes(`Default cwd for shell_exec and the base for relative file paths: ${ROOT}`),
      block
    )
    ok('block shows git state', /git main, \d+ changed\/untracked, last commit/.test(block), block)
    ok(
      'block lists detected checks with the verify caveat',
      block.includes('Detected check commands (verify before relying on them): npm run typecheck;'),
      block
    )
    ok('block warns run commands need background', block.includes('use background=true'), block)

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-plain-'))
    const none = await workdir.describeFolder(plain)
    ok(
      'a folder without git or manifests is not a code project',
      !none.code && none.toolchain === ''
    )
    ok('and renders no facts block', workdir.renderFolderFacts([none]) === '')
  }

  // ── 2. instruction discovery ───────────────────────────────────────────────
  console.log('instruction files')
  {
    const rootFiles = await workdir.findInstructionFiles(ROOT, ROOT)
    ok(
      'AGENTS.md wins over CLAUDE.md in the same dir',
      rootFiles.length === 1 && rootFiles[0] === path.join(ROOT, 'AGENTS.md'),
      rootFiles
    )

    const subFiles = await workdir.findInstructionFiles(path.join(ROOT, 'packages/a'), ROOT)
    ok(
      'a subfolder stacks its ancestors, root first, nearest last',
      subFiles.length === 2 &&
        subFiles[0] === path.join(ROOT, 'AGENTS.md') &&
        subFiles[1] === path.join(ROOT, 'packages/a/AGENTS.md'),
      subFiles
    )

    fs.unlinkSync(path.join(ROOT, 'AGENTS.md'))
    const claudeOnly = await workdir.findInstructionFiles(ROOT, ROOT)
    ok(
      'CLAUDE.md is used when AGENTS.md is absent',
      claudeOnly.length === 1 && claudeOnly[0].endsWith('CLAUDE.md'),
      claudeOnly
    )
    write('AGENTS.md', '# Root rules\nRun `npm run typecheck` before finishing.\n')

    const facts = await workdir.describeFolder(ROOT)
    const overlay = await workdir.buildInstructionsOverlay([facts])
    ok(
      'overlay is wrapped and labelled',
      overlay.includes('<project_instruction_files>') &&
        overlay.includes('outrank general doctrine'),
      overlay
    )
    ok(
      'overlay inlines the root file verbatim',
      overlay.includes(`<instructions_file path="${path.join(ROOT, 'AGENTS.md')}">`) &&
        overlay.includes('Run `npm run typecheck` before finishing.'),
      overlay
    )
    ok(
      'overlay does NOT inline the nested package file (that attaches lazily)',
      !overlay.includes('a-conventions'),
      overlay
    )
    ok(
      'overlay never loads CLAUDE.md beside AGENTS.md',
      !overlay.includes('Should never load'),
      overlay
    )

    const big = 'x'.repeat(workdir.INSTRUCTION_FILE_MAX_CHARS + 500)
    write('AGENTS.md', big)
    const capped = await workdir.buildInstructionsOverlay([facts])
    ok(
      'an oversized file is truncated with a note',
      capped.includes('truncated at') && capped.length < big.length + 600,
      capped.length
    )
    write('AGENTS.md', '# Root rules\n')
  }

  // ── 3. nested discovery ────────────────────────────────────────────────────
  console.log('nested')
  {
    const nested = await workdir.findNestedInstructionFile(path.join(ROOT, 'packages/a/src/x.ts'), [
      ROOT
    ])
    ok(
      'a read under packages/a finds its AGENTS.md',
      nested === path.join(ROOT, 'packages/a/AGENTS.md'),
      nested
    )
    const none = await workdir.findNestedInstructionFile(path.join(ROOT, 'packages/b/src/y.ts'), [
      ROOT
    ])
    ok(
      'a read under packages/b finds nothing (root file is pinned, not nested)',
      none === null,
      none
    )
    const outside = await workdir.findNestedInstructionFile('/etc/hosts', [ROOT])
    ok('a read outside every working folder finds nothing', outside === null)
    const self = await workdir.findNestedInstructionFile(path.join(ROOT, 'packages/a/AGENTS.md'), [
      ROOT
    ])
    ok('reading the instruction file itself does not re-attach it', self === null, self)
    const reminder = workdir.formatNestedInstructionReminder('/x/AGENTS.md', 'body')
    ok(
      'reminder is a system-reminder naming the source',
      reminder.includes('<system-reminder>') &&
        reminder.includes('Instructions from: /x/AGENTS.md') &&
        reminder.trimEnd().endsWith('</system-reminder>'),
      reminder
    )
  }

  // ── 4. plugins follow the injected folders ─────────────────────────────────
  console.log('plugins')
  {
    const capDir = path.join(process.cwd(), 'src/defaults/workspace/brain/cerebellum')
    const shell = (await import(pathToFileURL(path.join(capDir, 'shell/plugin/index.mjs')).href))
      .default as {
      init: (ctx: unknown) => Promise<void>
      execute: (
        name: string,
        args: Record<string, unknown>
      ) => Promise<{ success: boolean; output?: string; error?: string }>
    }
    await shell.init({ sudo: null, getWorkingFolders: () => [ROOT] })
    const pwd = await shell.execute('shell_exec', { command: 'pwd' })
    ok(
      'shell default cwd is the first working folder',
      pwd.success && pwd.output?.trim() === ROOT,
      pwd
    )
    const rel = await shell.execute('shell_exec', { command: 'pwd', cwd: 'packages/a' })
    ok(
      'a relative cwd resolves against the working folder',
      rel.success && rel.output?.trim() === path.join(ROOT, 'packages/a'),
      rel
    )
    const abs = await shell.execute('shell_exec', { command: 'pwd', cwd: os.tmpdir() })
    ok(
      'an absolute cwd still wins',
      abs.success && abs.output?.trim() === fs.realpathSync(os.tmpdir()),
      abs
    )
    await shell.init({ sudo: null, getWorkingFolders: () => [] })
    const home = await shell.execute('shell_exec', { command: 'pwd' })
    ok(
      'without folders the default is home (unchanged behaviour)',
      home.success && home.output?.trim() === os.homedir(),
      home
    )

    const filesystem = (
      await import(pathToFileURL(path.join(capDir, 'filesystem/plugin/index.mjs')).href)
    ).default as {
      init: (ctx: unknown) => Promise<void>
      execute: (
        name: string,
        args: Record<string, unknown>
      ) => Promise<{ success: boolean; output?: string; error?: string }>
    }
    await filesystem.init({ getWorkingFolders: () => [ROOT] })
    const read = await filesystem.execute('file_read', { path: 'packages/a/src/x.ts' })
    ok(
      'file_read resolves a relative path against the working folder',
      read.success && (read.output ?? '').includes('export const x = 1'),
      read
    )
    const wrote = await filesystem.execute('file_write', {
      path: 'packages/a/src/z.ts',
      content: 'export const z = 3\n'
    })
    ok(
      'file_write lands in the working folder',
      wrote.success && fs.existsSync(path.join(ROOT, 'packages/a/src/z.ts')),
      wrote
    )
    await filesystem.init({ getWorkingFolders: () => [] })
    const legacy = await filesystem.execute('file_read', { path: 'definitely-missing-file.txt' })
    ok(
      'without folders a relative path still targets the Wolffish workspace',
      !legacy.success && (legacy.error ?? '').includes(path.join('.wolffish', 'workspace')),
      legacy
    )
  }

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void main()
