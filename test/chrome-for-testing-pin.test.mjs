import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectBrowserPlatform } from '@puppeteer/browsers'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CHROME_FOR_TESTING_INSTALL_COMMAND,
  CHROME_FOR_TESTING_VERSION,
  browserMatchesVersion,
  chromeSandboxFlags,
  findPinnedChromeForTesting,
} from '../scripts/chrome-for-testing.mjs'
import { RESOLVE_BEFORE, TOOLCHAINS } from '../scripts/run-bundler-smoke.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(join(repoRoot, path), 'utf8')
const ciYaml = read('.github/workflows/ci.yml')
const packageJson = JSON.parse(read('package.json'))

// Splits the top-level `jobs:` map of a workflow into { jobName: jobText }.
function workflowJobs(yaml) {
  const jobs = {}
  let current
  let inJobs = false
  for (const line of yaml.split('\n')) {
    if (/^\s*(#.*)?$/.test(line)) continue
    if (/^\S/.test(line)) {
      inJobs = line.startsWith('jobs:')
      current = undefined
      continue
    }
    if (!inJobs) continue
    const jobHeader = /^ {2}([\w-]+):\s*$/.exec(line)
    if (jobHeader) {
      current = jobHeader[1]
      jobs[current] = ''
    } else if (current) {
      jobs[current] += `${line}\n`
    }
  }
  return jobs
}

// Returns each step's `run:` command; block scalars (`run: |`) become one joined string.
function runCommands(jobText) {
  const commands = []
  const lines = jobText.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const run = /^(\s+)(?:-\s+)?run:\s*(.*)$/.exec(lines[i])
    if (!run) continue
    if (!/^[|>]/.test(run[2])) {
      commands.push(run[2].trim())
      continue
    }
    const body = []
    while (i + 1 < lines.length && lines[i + 1].length - lines[i + 1].trimStart().length > run[1].length) {
      body.push(lines[++i].trim())
    }
    commands.push(body.join('\n'))
  }
  return commands
}

describe('workflow parsing helpers', () => {
  it('keeps block-scalar commands and unindented comments inside a job', () => {
    const jobs = workflowJobs(
      [
        'jobs:',
        '  verify:',
        '    steps:',
        '# a column-zero comment',
        '      - run: |',
        '          pnpm exec browsers install chrome@1.2.3.4',
        '          pnpm test:mv3',
        '',
        '      - name: Test',
        '        run: pnpm test',
        '  other:',
        '    steps: []',
      ].join('\n')
    )
    expect(runCommands(jobs.verify)).toEqual(['pnpm exec browsers install chrome@1.2.3.4\npnpm test:mv3', 'pnpm test'])
  })
})

describe('CI supply-chain pins', () => {
  it('fetches nothing unpinned at run time', () => {
    expect(ciYaml).not.toMatch(/\bdlx\b/)
    expect(ciYaml).not.toMatch(/\bnpx\b/)
    expect(ciYaml).not.toMatch(/@(stable|latest|beta|dev|canary)\b/)
  })

  it('pins every action to a full commit SHA', () => {
    const uses = [...ciYaml.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(match => match[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) {
      expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/)
    }
  })

  it('pins @puppeteer/browsers to an exact devDependency version', () => {
    expect(packageJson.devDependencies['@puppeteer/browsers']).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('runs Node that satisfies @puppeteer/browsers engines (>=22.12) in every job that installs Chrome', () => {
    const browserJobs = Object.values(workflowJobs(ciYaml)).filter(job =>
      runCommands(job).some(command => /\bbrowsers install\b/.test(command))
    )
    expect(browserJobs.length).toBeGreaterThan(0)
    for (const job of browserJobs) {
      const versions = [...job.matchAll(/node-version:\s*['"]?([^'"\s#]+)/g)].map(m => m[1])
      expect(versions.length).toBeGreaterThan(0)
      for (const version of versions) {
        // A bare major resolves to the newest release of that line on setup-node.
        const [major, minor = Infinity] = version.split('.').map(Number)
        expect(major > 22 || (major === 22 && minor >= 12), version).toBe(true)
      }
    }
  })

  // node-matrix installs no browser, so it can go below the @puppeteer/browsers
  // engines, down to the floors that package.json engines accepts.
  it('runs every package.json engines floor in the node-matrix job', () => {
    const job = workflowJobs(ciYaml)['node-matrix']
    expect(job).toBeDefined()
    const floors = packageJson.engines.node
      .split('||')
      .map(range => /^\s*(?:\^|>=)(\d+\.\d+\.\d+)\s*$/.exec(range)?.[1])
    expect(floors.length).toBeGreaterThan(0)
    expect(floors).not.toContain(undefined)
    const matrix = /^ +node-version: \[(.*)\]$/m
      .exec(job)?.[1]
      .split(',')
      .map(version => version.trim().replace(/^(['"])(.*)\1$/, '$2'))
    expect(matrix).toEqual(expect.arrayContaining(floors))
    // setup-node must install the matrix entry, not a fixed version.
    expect(job).toMatch(/^ +node-version: \$\{\{ matrix\.node-version \}\}$/m)
  })

  it('keeps the integrity gates in a lockfile-only job without a browser download', () => {
    const { verify } = workflowJobs(ciYaml)
    const commands = runCommands(verify)
    expect(commands).toEqual(
      expect.arrayContaining([
        'pnpm install --frozen-lockfile',
        'pnpm build',
        'pnpm test',
        'pnpm typecheck',
        'pnpm check:wasm',
        'pnpm check:wasm:repro',
        'pnpm pack:check',
        'pnpm smoke:consumer',
      ])
    )
    for (const command of commands) {
      expect(command).not.toMatch(/browsers|chrome|test:mv3/i)
      expect(command === 'pnpm install --frozen-lockfile' || !/\binstall\b/.test(command)).toBe(true)
    }
  })

  it('installs the pinned Chrome for Testing build in the mv3-smoke job', () => {
    const jobs = workflowJobs(ciYaml)
    expect(runCommands(jobs['mv3-smoke'])).toEqual([
      'pnpm install --frozen-lockfile',
      CHROME_FOR_TESTING_INSTALL_COMMAND,
      'pnpm test:mv3',
    ])
  })

  it('installs the pinned Chrome for Testing build in the bundler-smoke job', () => {
    const jobs = workflowJobs(ciYaml)
    expect(runCommands(jobs['bundler-smoke'])).toEqual([
      'pnpm install --frozen-lockfile',
      CHROME_FOR_TESTING_INSTALL_COMMAND,
      'pnpm smoke:bundlers',
    ])
  })

  it('pins the bundler smoke to exact versions resolved as of a fixed date', () => {
    expect(RESOLVE_BEFORE).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Date.parse(RESOLVE_BEFORE)).toBeLessThan(Date.now())
    const versions = Object.values(TOOLCHAINS).flatMap(packages => Object.values(packages))
    expect(versions.length).toBeGreaterThan(0)
    for (const version of versions) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})

describe('Chrome for Testing version agreement', () => {
  it('pins an exact Chrome for Testing build', () => {
    expect(CHROME_FOR_TESTING_VERSION).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  })

  it.each([
    '.github/workflows/ci.yml',
    'docs/mv3-conformance.md',
    'scripts/run-bundler-smoke.mjs',
    'scripts/run-mv3-smoke.mjs',
  ])('%s installs only the pinned build', path => {
    const text = read(path)
    const installs = [...text.matchAll(/browsers install (\S+)/g)].map(match => match[1])
    for (const target of installs) {
      expect(target).toBe(`chrome@${CHROME_FOR_TESTING_VERSION}`)
    }
    if (path.startsWith('scripts/')) {
      expect(text).toContain('CHROME_FOR_TESTING_INSTALL_COMMAND')
    } else {
      expect(text).toContain(CHROME_FOR_TESTING_INSTALL_COMMAND)
    }
  })
})

// Where `pnpm exec browsers install` puts the executable inside
// <cache>/chrome/<platform>-<buildId>/ for each @puppeteer/browsers platform.
const INSTALL_LAYOUTS = {
  linux: 'chrome-linux64/chrome',
  linux_arm: 'chrome-linux-arm64/chrome',
  mac: 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  mac_arm: 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  win32: 'chrome-win32/chrome.exe',
  win64: 'chrome-win64/chrome.exe',
}

function installFakeChrome(root, platform, buildId = CHROME_FOR_TESTING_VERSION) {
  const executable = join(root, '.context/browsers/chrome', `${platform}-${buildId}`, INSTALL_LAYOUTS[platform])
  mkdirSync(dirname(executable), { recursive: true })
  writeFileSync(executable, '')
  return executable
}

describe('findPinnedChromeForTesting', () => {
  let root

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  it('selects the pinned build even when a newer build is installed', () => {
    root = mkdtempSync(join(tmpdir(), 'qbit-pqc-cft-'))
    installFakeChrome(root, 'linux', '999.0.0.0')
    const pinned = installFakeChrome(root, 'linux')
    installFakeChrome(root, 'linux', '1.0.0.0')
    expect(findPinnedChromeForTesting(root, { platform: 'linux' })).toBe(pinned)
  })

  it('ignores builds other than the pinned one', () => {
    root = mkdtempSync(join(tmpdir(), 'qbit-pqc-cft-'))
    installFakeChrome(root, 'linux', '999.0.0.0')
    installFakeChrome(root, 'linux', `${CHROME_FOR_TESTING_VERSION}1`)
    expect(findPinnedChromeForTesting(root, { platform: 'linux' })).toBeNull()
  })

  it.each(Object.keys(INSTALL_LAYOUTS))('finds the pinned %s build where the install command puts it', platform => {
    root = mkdtempSync(join(tmpdir(), 'qbit-pqc-cft-'))
    const pinned = installFakeChrome(root, platform)
    expect(findPinnedChromeForTesting(root, { platform })).toBe(pinned)
  })

  it('ignores a pinned build for another platform', () => {
    root = mkdtempSync(join(tmpdir(), 'qbit-pqc-cft-'))
    installFakeChrome(root, 'mac_arm')
    installFakeChrome(root, 'win64')
    expect(findPinnedChromeForTesting(root, { platform: 'linux' })).toBeNull()
  })

  it('looks for the current platform by default', () => {
    root = mkdtempSync(join(tmpdir(), 'qbit-pqc-cft-'))
    const pinned = installFakeChrome(root, detectBrowserPlatform())
    expect(findPinnedChromeForTesting(root)).toBe(pinned)
  })

  it('does not search parent directories', () => {
    root = mkdtempSync(join(tmpdir(), 'qbit-pqc-cft-'))
    installFakeChrome(root, 'linux')
    const worktree = join(root, 'workspaces', 'child')
    mkdirSync(worktree, { recursive: true })
    expect(findPinnedChromeForTesting(worktree, { platform: 'linux' })).toBeNull()
  })
})

describe('chromeSandboxFlags', () => {
  const NO_SANDBOX = ['--no-sandbox', '--disable-setuid-sandbox']

  it.each([{}, { CHROME_NO_SANDBOX: '' }, { CHROME_NO_SANDBOX: '0' }])('keeps the sandbox for %j', env => {
    expect(chromeSandboxFlags({ env, platform: 'linux' })).toEqual([])
  })

  it('turns the sandbox off for CI on Linux only', () => {
    expect(chromeSandboxFlags({ env: { CI: 'true' }, platform: 'linux' })).toEqual(NO_SANDBOX)
    expect(chromeSandboxFlags({ env: { CI: 'true' }, platform: 'darwin' })).toEqual([])
  })

  it('keeps the sandbox in CI on Linux with an explicit CHROME_NO_SANDBOX=0', () => {
    expect(chromeSandboxFlags({ env: { CI: 'true', CHROME_NO_SANDBOX: '0' }, platform: 'linux' })).toEqual([])
  })

  it.each(['linux', 'darwin', 'win32'])('turns the sandbox off on %s with CHROME_NO_SANDBOX=1', platform => {
    expect(chromeSandboxFlags({ env: { CHROME_NO_SANDBOX: '1' }, platform })).toEqual(NO_SANDBOX)
  })

  it.each(['true', 'yes', ' 1', '2'])('rejects CHROME_NO_SANDBOX=%j', value => {
    expect(() => chromeSandboxFlags({ env: { CHROME_NO_SANDBOX: value }, platform: 'linux' })).toThrow(
      `CHROME_NO_SANDBOX must be 1 or 0, got ${JSON.stringify(value)}`
    )
  })
})

// Runs the real smoke entry point from a copy of the scripts whose repository
// root has no Chrome install, while its parent directory has the pinned build
// for this platform. Both cases must fail at startup, before anything is packed.
describe('run-mv3-smoke.mjs startup', () => {
  let root

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  function runStartup(env) {
    root = mkdtempSync(join(tmpdir(), 'qbit-pqc-mv3-startup-'))
    const repo = join(root, 'repo')
    mkdirSync(repo)
    cpSync(join(repoRoot, 'scripts'), join(repo, 'scripts'), { recursive: true })
    symlinkSync(join(repoRoot, 'node_modules'), join(repo, 'node_modules'))
    installFakeChrome(root, detectBrowserPlatform())
    // Keeps any stage a regressed startup creates inside `root`.
    const tmp = join(root, 'tmp')
    mkdirSync(tmp)

    const inherited = { ...process.env }
    for (const name of ['CHROME_FOR_TESTING_PATH', 'CHROME_NO_SANDBOX', 'CI']) delete inherited[name]
    return spawnSync(process.execPath, [join(repo, 'scripts', 'run-mv3-smoke.mjs')], {
      encoding: 'utf8',
      env: { ...inherited, TMPDIR: tmp, ...env },
      timeout: 30000,
    })
  }

  it('asks for the pinned build instead of using one outside the repository', () => {
    const result = runStartup({})
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`Install it with \`${CHROME_FOR_TESTING_INSTALL_COMMAND}\``)
    expect(result.stdout).not.toContain('npm pack')
  })

  it('rejects a malformed CHROME_NO_SANDBOX', () => {
    const result = runStartup({ CHROME_NO_SANDBOX: 'yes' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('CHROME_NO_SANDBOX must be 1 or 0, got "yes"')
    expect(result.stdout).not.toContain('npm pack')
  })
})

describe('browserMatchesVersion', () => {
  it('matches the /json/version Browser field exactly', () => {
    expect(browserMatchesVersion(`HeadlessChrome/${CHROME_FOR_TESTING_VERSION}`)).toBe(true)
    expect(browserMatchesVersion(`Chrome/${CHROME_FOR_TESTING_VERSION}`)).toBe(true)
    expect(browserMatchesVersion('HeadlessChrome/156.0.8078.4')).toBe(false)
    expect(browserMatchesVersion('HeadlessChrome/999.0.0.0')).toBe(false)
    expect(browserMatchesVersion(undefined)).toBe(false)
  })
})
