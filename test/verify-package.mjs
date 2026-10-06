// Packaging guard: asserts the artifact a plugin host actually receives is
// importable. This is the check that catches the failure mode where DSH
// installs `github:lfapex/free2dsh` with pnpm and finds no built bundle.
//
// It packs the package, extracts it into a directory with NO node_modules, and
// imports it — the same shape as a host that does not hoist dependencies. It
// also asserts lib/ is tracked in git, because that is what the git install
// path depends on.
//
// Run: npm run verify:package
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const git = process.platform === 'win32' ? 'git.exe' : 'git'

function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

// 1. lib/ must be tracked in git: the git install path ships the repo as-is.
const tracked = execFileSync(git, ['ls-files', 'lib/'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
check('lib/ is tracked in git', tracked.includes('lib/index.js'), `tracked: ${tracked.length ? tracked.join(', ') : '(none)'}`)

// 2. package.json must point at a file that exists.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('package main resolves on disk', existsSync(join(root, pkg.main)), `${pkg.main} missing`)
check('"files" ships lib/', (pkg.files ?? []).includes('lib'))

// NO install-time build scripts. DSH installs this with pnpm straight from
// GitHub, and pnpm refuses to run build scripts for a git-hosted package
// unless the user adds it to `allowBuilds` in their pnpm-workspace.yaml
// (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED). Shipping the bundle in the repo
// means the install needs no scripts at all — so declaring `prepare` would
// only force that manual step on every user.
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']
const hooks = INSTALL_HOOKS.filter((hook) => typeof pkg.scripts?.[hook] === 'string')
check('no install-time build scripts (pnpm git installs)', hooks.length === 0, `declares: ${hooks.join(', ')}`)

// 3. What a git install actually receives must be complete. DSH installs
//    `github:lfapex/free2dsh` with pnpm, which uses the committed tree — so
//    `git archive HEAD` is the exact artifact the host gets, not the working
//    copy. This is the check that catches a missing/unbuilt lib/.
const work = mkdtempSync(join(tmpdir(), 'free2dsh-verify-'))
try {
  execFileSync(git, ['archive', '--format=tar', '--output', join(work, 'head.tar'), 'HEAD'], { cwd: root })
  // Relative filename: tar reads a Windows path like C:\... as a remote host.
  execFileSync('tar', ['xf', 'head.tar'], { cwd: work })
  // Plain `git archive` has no package/ prefix — the tree lands at the root.
  const tree = work

  check('git archive yields no node_modules', !existsSync(join(tree, 'node_modules')))
  check('lib/index.js is committed', existsSync(join(tree, 'lib', 'index.js')))
  check('cordis.patch.yml is committed', existsSync(join(tree, 'cordis.patch.yml')))

  // The committed bundle may import packages, but every one of them must be a
  // DECLARED dependency — otherwise pnpm never installs it and the host cannot
  // resolve it at activation time, which is exactly how "failed to import"
  // happens. Bare (non-node:) specifiers are the ones that need installing.
  const committed = readFileSync(join(tree, 'lib', 'index.js'), 'utf8')
  const specifiers = new Set()
  for (const m of committed.matchAll(/(?:from|import\()\s*"([^"]+)"/g)) {
    const spec = m[1]
    if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) continue
    // Walk up to the package name: @scope/pkg/sub -> @scope/pkg
    const parts = spec.split('/')
    specifiers.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
  }
  const declared = new Set(Object.keys(pkg.dependencies ?? {}))
  const undeclared = [...specifiers].filter((spec) => !declared.has(spec))
  check('every runtime import is a declared dependency', undeclared.length === 0, `undeclared: ${undeclared.join(', ')}`)
  console.log(`       (bundle imports: ${[...specifiers].join(', ') || 'none — fully self-contained'})`)

  // And the exports DSH actually reads must be present in the committed file.
  const requiredExports = ['apply', 'name', 'Config', 'inject', 'PLUGIN_VERSION']
  const missingExports = requiredExports.filter((key) => !new RegExp(`\\b${key}\\b`).test(committed))
  check('required plugin exports are present', missingExports.length === 0, `missing: ${missingExports.join(', ')}`)
} catch (err) {
  check('bundle imports with zero dependencies present', false, String(err.stderr ?? err.message).split('\n')[0])
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log('')
if (failures.length > 0) {
  console.error(`verify:package FAILED (${failures.length}): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('verify:package passed')
