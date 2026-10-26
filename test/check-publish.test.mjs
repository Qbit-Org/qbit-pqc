import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  checkPublish,
  distTagForVersion,
  packageFilePathspecs,
} from '../scripts/check-publish.mjs'

const scriptsDir = fileURLToPath(new URL('../scripts/', import.meta.url))

// A throwaway package repository, isolated from the developer's git config.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim()
}

function writePackageJson(root, version) {
  const manifest = { name: 'fixture', version, files: ['docs/**/*', 'lib/**/*', 'README.md'] }
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

// Stands in for pnpm: records each script it is asked to run and fails the one
// named by $FAKE_PNPM_FAIL, so the guard runs without the real WASM checks.
const FAKE_PNPM = `#!/bin/sh
echo "$1" >> "$FAKE_PNPM_LOG"
[ "$1" != "$FAKE_PNPM_FAIL" ]
`

describe('publish guard', () => {
  let work
  let root
  let calls

  // Records the scripts the guard asks for; `failing` names the ones that fail.
  const runScripts =
    (...failing) =>
    script => {
      calls.push(script)
      return !failing.includes(script)
    }

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'qbit-pqc-publish-'))
    root = join(work, 'package')
    calls = []

    mkdirSync(join(root, 'docs'), { recursive: true })
    writePackageJson(root, '0.1.0-rc.0')
    writeFileSync(join(root, '.gitignore'), 'lib/\n')
    writeFileSync(join(root, 'README.md'), 'readme\n')
    writeFileSync(join(root, 'docs', 'guide.md'), 'guide\n')
    git(root, 'init', '-q')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'fixture')

    // tsup's output is git-ignored and rebuilt by prepack.
    mkdirSync(join(root, 'lib'))
    writeFileSync(join(root, 'lib', 'index.mjs'), 'export {}\n')
  })

  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('passes a committed release and runs both WASM checks outside CI', () => {
    expect(checkPublish(root, { env: {}, runScript: runScripts() })).toEqual([])
    expect(calls).toEqual(['check:wasm', 'check:wasm:repro'])
  })

  it('leaves the reproducible rebuild to the publish workflow in CI', () => {
    expect(checkPublish(root, { env: { CI: 'true' }, runScript: runScripts() })).toEqual([])
    expect(calls).toEqual(['check:wasm'])
  })

  it('runs the reproducible rebuild for any CI value other than true', () => {
    for (const CI of ['', '1', 'false', 'TRUE']) {
      calls = []
      expect(checkPublish(root, { env: { CI }, runScript: runScripts() })).toEqual([])
      expect(calls).toEqual(['check:wasm', 'check:wasm:repro'])
    }
  })

  it('refuses version 0.0.0', () => {
    writePackageJson(root, '0.0.0')
    git(root, 'commit', '-q', '-am', 'placeholder version')

    expect(checkPublish(root, { env: {}, runScript: runScripts() })).toEqual([
      'version 0.0.0: 0.0.0 is never published',
    ])
    expect(calls).toEqual(['check:wasm'])
  })

  it('refuses tracked and untracked changes to package files', () => {
    appendFileSync(join(root, 'README.md'), 'edited\n')
    writeFileSync(join(root, 'docs', 'local-notes.md'), 'notes\n')
    mkdirSync(join(root, 'docs', 'tmp'))
    writeFileSync(join(root, 'docs', 'tmp', 'dump.json'), '{}\n')

    expect(checkPublish(root, { env: { CI: 'true' }, runScript: runScripts() })).toEqual([
      'uncommitted changes to package files:\n  README.md\n  docs/local-notes.md\n  docs/tmp/dump.json',
    ])
    expect(calls).toEqual(['check:wasm'])
  })

  it('refuses staged changes, deletions and an edited package.json', () => {
    writeFileSync(join(root, 'docs', 'staged.md'), 'staged\n')
    git(root, 'add', 'docs/staged.md')
    unlinkSync(join(root, 'docs', 'guide.md'))
    writePackageJson(root, '0.1.0')

    expect(checkPublish(root, { env: {}, runScript: runScripts() })).toEqual([
      'uncommitted changes to package files:\n  docs/guide.md\n  docs/staged.md\n  package.json',
    ])
  })

  it('ignores changes outside the package files', () => {
    appendFileSync(join(root, '.gitignore'), 'coverage/\n')
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'scratch.mjs'), '\n')
    writeFileSync(join(root, 'notes.txt'), 'notes\n')

    expect(checkPublish(root, { env: {}, runScript: runScripts() })).toEqual([])
  })

  it('refuses a failing WASM hash check or reproducible rebuild', () => {
    expect(checkPublish(root, { env: {}, runScript: runScripts('check:wasm') })).toEqual([
      'pnpm check:wasm failed',
    ])
    expect(calls).toEqual(['check:wasm'])

    calls = []
    expect(checkPublish(root, { env: {}, runScript: runScripts('check:wasm:repro') })).toEqual([
      'pnpm check:wasm:repro failed',
    ])
    expect(calls).toEqual(['check:wasm', 'check:wasm:repro'])
  })

  it('refuses a package outside a git checkout', () => {
    rmSync(join(root, '.git'), { recursive: true, force: true })

    const errors = checkPublish(root, { env: { CI: 'true' }, runScript: runScripts() })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/git -c core\.excludesFile=\/dev\/null status[^]*not a git repository/)
  })

  describe('from the command line', () => {
    let env
    let log

    beforeEach(() => {
      mkdirSync(join(root, 'scripts'))
      for (const script of ['check-publish.mjs', 'pack-policy.mjs']) {
        cpSync(join(scriptsDir, script), join(root, 'scripts', script))
      }

      const bin = join(work, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'pnpm'), FAKE_PNPM)
      chmodSync(join(bin, 'pnpm'), 0o755)

      log = join(work, 'pnpm.log')
      env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_PNPM_LOG: log, CI: '' }
    })

    function runGuard(extraEnv = {}, args = []) {
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-publish.mjs'), ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...env, ...extraEnv },
      })
      let scripts = []
      try {
        scripts = readFileSync(log, 'utf8').trim().split('\n')
      } catch {}
      return { status: result.status, output: `${result.stdout}${result.stderr}`, scripts }
    }

    it('passes a committed release', () => {
      const { status, output, scripts } = runGuard()
      expect(output).toContain('publish checks: PASS')
      expect(status).toBe(0)
      expect(scripts).toEqual(['check:wasm', 'check:wasm:repro'])
    })

    it('exits non-zero with every reason not to publish', () => {
      writePackageJson(root, '0.0.0')
      writeFileSync(join(root, 'docs', 'local-notes.md'), 'notes\n')

      const { status, output, scripts } = runGuard({ FAKE_PNPM_FAIL: 'check:wasm' })
      expect(status).toBe(1)
      expect(output).toContain(
        [
          'refusing to publish:',
          '  version 0.0.0: 0.0.0 is never published',
          '  uncommitted changes to package files:',
          '    docs/local-notes.md',
          '    package.json',
          '  pnpm check:wasm failed',
        ].join('\n')
      )
      expect(scripts).toEqual(['check:wasm'])
    })

    it("reports untracked files that the user's global git excludes hide", () => {
      const excludes = join(work, 'global-excludes')
      writeFileSync(excludes, '*.md\n')
      const config = join(work, 'global-gitconfig')
      writeFileSync(config, `[core]\n\texcludesFile = ${excludes}\n`)
      writeFileSync(join(root, 'docs', 'local-notes.md'), 'notes\n')

      // Plain git status hides the file; npm would still pack it.
      expect(
        execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
          cwd: root,
          encoding: 'utf8',
          env: { ...env, GIT_CONFIG_GLOBAL: config },
        })
      ).not.toContain('local-notes.md')

      const { status, output } = runGuard({ GIT_CONFIG_GLOBAL: config })
      expect(status).toBe(1)
      expect(output).toContain('uncommitted changes to package files:\n    docs/local-notes.md')
    })

    it('rejects arguments rather than ignoring them', () => {
      const { status, output, scripts } = runGuard({}, ['--skip-repro'])
      expect(status).toBe(1)
      expect(output).toMatch(/takes no arguments, received: --skip-repro/)
      expect(scripts).toEqual([])
    })
  })
})

describe('release versions', () => {
  it('maps release candidates to candidate and releases to latest', () => {
    expect(distTagForVersion('0.1.0-rc.0')).toBe('candidate')
    expect(distTagForVersion('1.20.3-rc.12')).toBe('candidate')
    expect(distTagForVersion('0.1.0')).toBe('latest')
    expect(distTagForVersion('10.0.1')).toBe('latest')
  })

  it('refuses the 0.0.0 placeholder', () => {
    expect(() => distTagForVersion('0.0.0')).toThrow(/0\.0\.0 is never published/)
    expect(() => distTagForVersion('0.0.0-rc.0')).toThrow(/0\.0\.0 is never published/)
  })

  it('refuses versions that are not exactly X.Y.Z or X.Y.Z-rc.N', () => {
    // npm would clean several of these (`v0.0.0`, ` 0.0.0`, `0.0.0+build`) to 0.0.0.
    for (const version of [
      'v0.0.0',
      '=0.0.0',
      ' 0.0.0',
      '0.0.0+build',
      'v0.1.0',
      '0.1.0-beta.0',
      '0.1.0-rc',
      '0.1.0-rc.01',
      '0.1.0-rc.0.1',
      '01.0.0',
      '1.0',
      '1.0.0\n',
      '',
      undefined,
      1,
    ]) {
      expect(() => distTagForVersion(version), JSON.stringify(version)).toThrow(
        /is not X\.Y\.Z or X\.Y\.Z-rc\.N/
      )
    }
  })
})

describe('package file pathspecs', () => {
  it('matches npm files globs at any depth, plus package.json', () => {
    expect(packageFilePathspecs(['docs/**/*', 'README.md'])).toEqual([
      ':(glob)docs/**/*',
      ':(glob)README.md',
      ':(glob)package.json',
    ])
  })

  it('refuses a missing, empty or unsupported files list', () => {
    expect(() => packageFilePathspecs(undefined)).toThrow(/must list the published files/)
    expect(() => packageFilePathspecs([])).toThrow(/must list the published files/)
    for (const entry of ['', '/abs', '../docs/**/*', 'docs/../src', 'docs\\a.md', '!docs/a.md', 1]) {
      expect(() => packageFilePathspecs([entry]), JSON.stringify(entry)).toThrow(
        /unsupported package\.json "files" entry/
      )
    }
  })
})
