import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const PINNED_IMAGE = /EMSDK_IMAGE:-"([^"]+)"/.exec(
  readFileSync(join(repoRoot, 'scripts', 'build-wasm.sh'), 'utf8')
)[1]

// Stands in for emcc: answers --version, and otherwise copies prebuilt
// artifacts from $FAKE_EMCC_SRC (if set) to the directory of the `-o` target,
// so the scripts run without a real toolchain. Calls are logged to $FAKE_LOG.
const FAKE_EMCC = `#!/usr/bin/env bash
set -euo pipefail
echo "emcc $*" >>"$FAKE_LOG"
if [ "$1" = "--version" ]; then
  echo "emcc (fake) 4.0.10"
  echo "fake emcc license text"
  exit 0
fi
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out=$2; shift; fi
  shift
done
if [ -n "\${FAKE_EMCC_SRC:-}" ]; then
  cp "$FAKE_EMCC_SRC/pqc.mjs" "$FAKE_EMCC_SRC/pqc.wasm" "$(dirname "$out")/"
fi
`

// Stands in for docker: `run` emulates the repository bind mount by running
// the fake emcc in the host directory given to -v, and `image inspect` prints
// a fixed digest. Calls are logged to $FAKE_LOG.
const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
echo "docker $*" >>"$FAKE_LOG"
if [ "$1" = "image" ]; then
  echo "emscripten/emsdk@sha256:fake (image ID sha256:fake-id)"
  exit 0
fi
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --rm) shift ;;
    -v) src=\${2%%:*}; shift 2 ;;
    --platform | -u | -w) shift 2 ;;
    *) break ;;
  esac
done
shift 2
cd "$src"
exec emcc "$@"
`

// The scripts read these from the environment; every run starts without them.
const BUILD_ENV = ['EMSDK_IMAGE', 'USE_LOCAL_EMCC', 'OUT_DIR', 'QBIT_PQC_REPRO_ALLOW_OVERRIDES']

let work

function stageRepo() {
  const root = join(work, 'repo')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const script of ['check-wasm-repro.sh', 'build-wasm.sh', 'check-wasm-hash.mjs']) {
    cpSync(join(repoRoot, 'scripts', script), join(root, 'scripts', script))
  }
  cpSync(join(repoRoot, 'wasm'), join(root, 'wasm'), { recursive: true })

  const bin = join(work, 'bin')
  mkdirSync(bin)
  for (const [name, source] of [
    ['emcc', FAKE_EMCC],
    ['docker', FAKE_DOCKER],
  ]) {
    writeFileSync(join(bin, name), source)
    chmodSync(join(bin, name), 0o755)
  }

  const tmp = join(work, 'tmp')
  mkdirSync(tmp)
  const log = join(work, 'calls.log')
  writeFileSync(log, '')
  return { root, bin, tmp, log, committed: join(root, 'wasm') }
}

function runScript(repo, script, env = {}) {
  const inherited = { ...process.env }
  for (const name of BUILD_ENV) delete inherited[name]
  return spawnSync(join(repo.root, 'scripts', script), script === 'build-wasm.sh' ? ['baseline'] : [], {
    encoding: 'utf8',
    env: {
      ...inherited,
      PATH: `${repo.bin}:${process.env.PATH}`,
      TMPDIR: repo.tmp,
      FAKE_LOG: repo.log,
      ...env,
    },
  })
}

const runRepro = (repo, env) => runScript(repo, 'check-wasm-repro.sh', env)
const runBuild = (repo, env) => runScript(repo, 'build-wasm.sh', env)
const calls = (repo) => readFileSync(repo.log, 'utf8')

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'qbit-pqc-repro-test-'))
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('check-wasm-repro.sh', () => {
  it('rebuilds with the pinned image by default and records its emcc version and digest', () => {
    const repo = stageRepo()
    const result = runRepro(repo, { FAKE_EMCC_SRC: repo.committed })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('emcc (fake) 4.0.10\n')
    expect(result.stdout).not.toContain('fake emcc license text')
    expect(result.stdout).toContain(
      `emsdk image ${PINNED_IMAGE} -> emscripten/emsdk@sha256:fake (image ID sha256:fake-id)\n`
    )
    expect(result.stdout).toMatch(/reproducible WASM hash check passed\n$/)
    const inspections = calls(repo)
      .split('\n')
      .filter((line) => line.startsWith('docker image inspect '))
    expect(inspections).toHaveLength(1)
    expect(inspections[0].endsWith(` ${PINNED_IMAGE}`)).toBe(true)
  })

  it.each([
    ['EMSDK_IMAGE', 'emscripten/emsdk:4.0.10'],
    ['USE_LOCAL_EMCC', '1'],
    ['OUT_DIR', 'wasm'],
  ])('refuses to run while %s is set', (name, value) => {
    const repo = stageRepo()
    const result = runRepro(repo, { [name]: value, FAKE_EMCC_SRC: repo.committed })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`refusing to run with ${name}=${value}`)
    expect(result.stderr).toContain('QBIT_PQC_REPRO_ALLOW_OVERRIDES=1')
    expect(result.stdout).not.toContain('passed')
    expect(calls(repo)).toBe('')
    expect(existsSync(join(repo.root, '.context'))).toBe(false)
  })

  it.each(['', '0', 'true'])('keeps refusing when QBIT_PQC_REPRO_ALLOW_OVERRIDES is %j', (optIn) => {
    const repo = stageRepo()
    const result = runRepro(repo, {
      USE_LOCAL_EMCC: '1',
      QBIT_PQC_REPRO_ALLOW_OVERRIDES: optIn,
      FAKE_EMCC_SRC: repo.committed,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to run with USE_LOCAL_EMCC=1')
    expect(calls(repo)).toBe('')
  })

  it('treats USE_LOCAL_EMCC=0 as the Docker build it selects', () => {
    const repo = stageRepo()
    const result = runRepro(repo, { USE_LOCAL_EMCC: '0', FAKE_EMCC_SRC: repo.committed })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/reproducible WASM hash check passed\n$/)
    expect(calls(repo)).toMatch(/^docker run /)
  })

  it('passes with an allowed local emcc, says so, and removes its private temp dir', () => {
    const repo = stageRepo()
    const result = runRepro(repo, {
      USE_LOCAL_EMCC: '1',
      QBIT_PQC_REPRO_ALLOW_OVERRIDES: '1',
      FAKE_EMCC_SRC: repo.committed,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('emcc (fake) 4.0.10\n')
    expect(result.stdout).toContain(
      'reproducible WASM hash check passed with build overrides: USE_LOCAL_EMCC=1\n'
    )
    expect(calls(repo)).not.toContain('docker')
    expect(readdirSync(repo.tmp)).toEqual([])
  })

  it('never rebuilds into OUT_DIR, even when overrides are allowed', () => {
    const repo = stageRepo()
    const prebuilt = join(work, 'prebuilt')
    cpSync(repo.committed, prebuilt, { recursive: true })

    const result = runRepro(repo, {
      OUT_DIR: 'wasm',
      QBIT_PQC_REPRO_ALLOW_OVERRIDES: '1',
      FAKE_EMCC_SRC: prebuilt,
    })

    // A rebuild into wasm/ would compare the committed files with themselves.
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('ignoring OUT_DIR; the rebuild always goes to .context/repro/wasm\n')
    expect(calls(repo)).toContain(' -o .context/repro/wasm/.build-stage/pqc.mjs\n')
    expect(calls(repo)).not.toContain(' -o wasm/')
  })

  it('fails on a hash mismatch, diffs files under a private TMPDIR dir, and still cleans up', () => {
    const repo = stageRepo()
    const drifted = join(work, 'drifted')
    cpSync(repo.committed, drifted, { recursive: true })
    writeFileSync(join(drifted, 'pqc.wasm'), 'not the checked-in wasm')

    const result = runRepro(repo, { FAKE_EMCC_SRC: drifted })

    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('reproducible WASM hash check passed')
    const headers = result.stdout.split('\n').filter((line) => /^(---|\+\+\+) /.test(line))
    expect(headers).toHaveLength(2)
    const tmpPrefix = repo.tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const header of headers) {
      expect(header.slice(4)).toMatch(new RegExp(`^${tmpPrefix}/qbit-pqc-repro\\.[^/]+/(expected|actual)\\.txt\\t`))
    }
    expect(readdirSync(repo.tmp)).toEqual([])
  })
})

describe('build-wasm.sh', () => {
  it.each([
    ['an absolute path outside the repository', () => join(work, 'outside')],
    ['a relative path that climbs out', () => '../outside'],
    ['a path that climbs out partway', () => 'wasm/../../outside'],
  ])('rejects %s as the Docker build OUT_DIR', (_case, outDir) => {
    const repo = stageRepo()
    const result = runBuild(repo, { OUT_DIR: outDir(), FAKE_EMCC_SRC: repo.committed })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('OUT_DIR must be inside the repository for the Docker build')
    expect(calls(repo)).toBe('')
    expect(existsSync(join(work, 'outside'))).toBe(false)
  })

  it('rejects a Docker build OUT_DIR that leaves the repository through a symlink', () => {
    const repo = stageRepo()
    mkdirSync(join(work, 'outside'))
    symlinkSync(join(work, 'outside'), join(repo.root, 'link'))

    const result = runBuild(repo, { OUT_DIR: 'link/wasm', FAKE_EMCC_SRC: repo.committed })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('OUT_DIR must be inside the repository for the Docker build')
    expect(calls(repo)).toBe('')
  })

  it('builds into an OUT_DIR outside the repository with a local emcc', () => {
    const repo = stageRepo()
    const outside = join(work, 'outside')

    const result = runBuild(repo, { OUT_DIR: outside, USE_LOCAL_EMCC: '1', FAKE_EMCC_SRC: repo.committed })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(outside, 'SHA256SUMS'), 'utf8')).toBe(
      readFileSync(join(repo.committed, 'SHA256SUMS'), 'utf8')
    )
  })

  it('compiles into a staging directory, so a compile that writes nothing fails and keeps the old outputs', () => {
    const repo = stageRepo()
    const out = join(repo.root, 'out')
    cpSync(repo.committed, out, { recursive: true })
    const before = Object.fromEntries(
      readdirSync(out).map(name => [name, readFileSync(join(out, name), 'utf8')])
    )

    const result = runBuild(repo, { OUT_DIR: 'out' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('emcc did not write both pqc.mjs and pqc.wasm')
    expect(calls(repo)).toContain(' -o out/.build-stage/pqc.mjs\n')
    // The previous outputs are untouched and the staging directory is gone.
    expect(readdirSync(out).sort()).toEqual(Object.keys(before).sort())
    for (const [name, contents] of Object.entries(before)) {
      expect(readFileSync(join(out, name), 'utf8')).toBe(contents)
    }
  })
})
