import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturesDir = join(packageRoot, 'fixtures')
const SIDECAR_SUFFIX = '.sha256'

function targetOf(sidecarPath: string): string {
  return sidecarPath.slice(0, -SIDECAR_SUFFIX.length)
}

interface SidecarEntry {
  digest: string
  fileName: string | undefined
}

// Accepts the single-entry `sha256sum` layouts: `<hex>  <name>` (text mode),
// `<hex> *<name>` (binary mode), or a bare `<hex>`, with at most one trailing
// newline. Anything else, including escaped `\<hex>` lines and multi-entry
// files, is rejected rather than guessed at.
function parseSha256Sidecar(text: string): SidecarEntry {
  const body = text.replace(/\r?\n$/, '')
  if (body.trim() === '') throw new Error('sidecar is empty')
  if (/[\r\n]/.test(body)) throw new Error('sidecar must contain exactly one entry')
  const match = /^([0-9a-fA-F]{64})(?: [ *](.+))?$/.exec(body)
  if (!match) throw new Error(`malformed sidecar line: ${JSON.stringify(body)}`)
  return { digest: match[1]!.toLowerCase(), fileName: match[2] }
}

// Verifies `<target>.sha256` against the bytes of `<target>`. Paths are
// package-root relative with `/` separators; a named entry must be relative and
// resolve from the package root (where `sha256sum -c` runs) to the sidecar's
// own target, so the shipped sidecar stays checkable on any machine.
function verifySidecar(sidecarPath: string, sidecarText: string, targetBytes: Uint8Array): void {
  if (!sidecarPath.endsWith(SIDECAR_SUFFIX)) throw new Error(`not a sidecar path: ${sidecarPath}`)
  const targetPath = targetOf(sidecarPath)
  const { digest, fileName } = parseSha256Sidecar(sidecarText)
  if (fileName !== undefined && isAbsolute(fileName)) {
    throw new Error(`${sidecarPath} names absolute path ${JSON.stringify(fileName)}`)
  }
  if (fileName !== undefined && resolve(packageRoot, fileName) !== resolve(packageRoot, targetPath)) {
    throw new Error(`${sidecarPath} names ${JSON.stringify(fileName)}, expected ${targetPath}`)
  }
  const actual = createHash('sha256').update(targetBytes).digest('hex')
  if (actual !== digest) {
    throw new Error(`${targetPath} sha256 ${actual} does not match ${sidecarPath} (${digest})`)
  }
}

function toPackagePath(path: string): string {
  return relative(packageRoot, path).split(sep).join('/')
}

// package.json publishes `fixtures/**/*`, so look for sidecars at any depth.
function findSidecars(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return findSidecars(path)
    return entry.name.endsWith(SIDECAR_SUFFIX) ? [toPackagePath(path)] : []
  })
}

const sidecarPaths = findSidecars(fixturesDir).sort()

const goldenSidecar = 'fixtures/slh-dsa-golden.json.sha256'

function git(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', args, { cwd: packageRoot, encoding: 'utf8' })
}

// Only a checkout of this repo has its .gitattributes; any git failure there
// must fail the test rather than skip it.
const isRepoCheckout = existsSync(join(packageRoot, '.git'))

describe('fixture SHA-256 sidecars', () => {
  it('discovers the SLH-DSA golden fixture sidecar', () => {
    expect(sidecarPaths).toContain(goldenSidecar)
  })

  it.each(sidecarPaths)('%s matches its fixture', sidecarPath => {
    const sidecarText = readFileSync(join(packageRoot, sidecarPath), 'utf8')
    const targetBytes = readFileSync(join(packageRoot, targetOf(sidecarPath)))
    expect(() => verifySidecar(sidecarPath, sidecarText, targetBytes)).not.toThrow()
  })

  // A checkout that converts line endings (Windows `core.autocrlf=true`) would
  // change the hashed bytes, so .gitattributes must mark both files `-text`.
  it.skipIf(!isRepoCheckout)('hashed fixtures and sidecars are exempt from eol conversion', () => {
    const paths = sidecarPaths.flatMap(sidecar => [targetOf(sidecar), sidecar])
    const result = git(['check-attr', '-z', 'text', '--', ...paths])
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    // -z prints unquoted `<path>\0<attribute>\0<value>\0` records.
    expect(result.stdout).toBe(paths.map(path => `${path}\0text\0unset\0`).join(''))
  })
})

describe('verifySidecar', () => {
  let goldenSidecarText = ''
  let goldenBytes = Buffer.alloc(0)

  beforeAll(() => {
    goldenSidecarText = readFileSync(join(packageRoot, goldenSidecar), 'utf8')
    goldenBytes = readFileSync(join(packageRoot, 'fixtures/slh-dsa-golden.json'))
  })

  it('fails when only the fixture is edited', () => {
    const edited = Buffer.from(goldenBytes)
    edited[edited.length - 2] ^= 0x01
    expect(() => verifySidecar(goldenSidecar, goldenSidecarText, edited)).toThrow(/does not match/)
    expect(() => verifySidecar(goldenSidecar, goldenSidecarText, Buffer.concat([goldenBytes, Buffer.from('\n')]))).toThrow(
      /does not match/,
    )
  })

  it('fails when only the sidecar digest is edited', () => {
    const flipped = goldenSidecarText[0] === '0' ? '1' : '0'
    const edited = flipped + goldenSidecarText.slice(1)
    expect(() => verifySidecar(goldenSidecar, edited, goldenBytes)).toThrow(/does not match/)
  })

  it('fails when the sidecar names a different file', () => {
    const edited = goldenSidecarText.replace('slh-dsa-golden.json', 'qbit-core-derivation.json')
    expect(() => verifySidecar(goldenSidecar, edited, goldenBytes)).toThrow(/names "fixtures\/qbit-core-derivation.json"/)
  })

  it('fails when the sidecar names an absolute path', () => {
    const edited = goldenSidecarText.replace('fixtures/', `${packageRoot}/fixtures/`)
    expect(() => verifySidecar(goldenSidecar, edited, goldenBytes)).toThrow(/absolute path/)
  })

  it('accepts the bare, binary-mode, uppercase and CRLF sidecar forms', () => {
    const digest = createHash('sha256').update(goldenBytes).digest('hex')
    for (const text of [
      digest,
      `${digest}\n`,
      `${digest.toUpperCase()}  fixtures/slh-dsa-golden.json\n`,
      `${digest} *fixtures/slh-dsa-golden.json\n`,
      `${digest}  ./fixtures/slh-dsa-golden.json\r\n`,
    ]) {
      expect(() => verifySidecar(goldenSidecar, text, goldenBytes)).not.toThrow()
    }
  })

  it.each([
    ['empty', ''],
    ['blank', '\n'],
    ['short digest', `${'a'.repeat(63)}  fixtures/slh-dsa-golden.json\n`],
    ['long digest', `${'a'.repeat(65)}\n`],
    ['non-hex digest', `${'g'.repeat(64)}\n`],
    ['single-space separator', `${'a'.repeat(64)} fixtures/slh-dsa-golden.json\n`],
    ['missing name after separator', `${'a'.repeat(64)}  \n`],
    ['leading whitespace', ` ${'a'.repeat(64)}\n`],
    ['escaped sha256sum line', `\\${'a'.repeat(64)}  fixtures/slh-dsa-golden.json\n`],
    ['two entries', `${'a'.repeat(64)}  a\n${'b'.repeat(64)}  b\n`],
    ['extra trailing newline', `${'a'.repeat(64)}\n\n`],
  ])('rejects a malformed sidecar (%s)', (_label, text) => {
    expect(() => parseSha256Sidecar(text)).toThrow(/sidecar/)
  })
})
