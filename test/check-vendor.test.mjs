import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_VENDOR_DIR,
  formatManifest,
  gitBlobSha,
  manifestEntriesFromTree,
  parseArgs,
  parseLsTree,
  parseManifest,
  parseUpstreamInventory,
  parseUpstreamPin,
} from '../scripts/check-vendor.mjs'

const script = fileURLToPath(new URL('../scripts/check-vendor.mjs', import.meta.url))
// Read from the vendored tree, so re-vendoring only touches UPSTREAM.md and
// MANIFEST.
const UPSTREAM_TEXT = readFileSync(join(DEFAULT_VENDOR_DIR, 'UPSTREAM.md'), 'utf8')
const PIN = parseUpstreamPin(UPSTREAM_TEXT)
const FILE_COUNT = parseUpstreamInventory(UPSTREAM_TEXT).size
const OTHER = '0123456789abcdef0123456789abcdef01234567'
const SHA = 'ce013625030ba8dba906f756967f9e9ca394464a'

function runChecker(vendorDir, ...extra) {
  const result = spawnSync(process.execPath, [script, '--vendor-dir', vendorDir, ...extra], {
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

// A throwaway upstream repository, isolated from the developer's git config.
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

describe('check-vendor against a copy of the vendored tree', () => {
  let tmp
  let vendor

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qbit-pqc-vendor-'))
    vendor = join(tmp, 'libbitcoinpqc-qbit')
    cpSync(DEFAULT_VENDOR_DIR, vendor, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true })
  })

  it('passes for the pristine tree', () => {
    const { status, output } = runChecker(vendor)
    expect(output).toMatch(new RegExp(`${FILE_COUNT} vendored files are blob-equal to upstream ${PIN}`))
    expect(status).toBe(0)
  })

  it('fails when one vendored byte changes', () => {
    const path = join(vendor, 'src/slh_dsa/keygen.c')
    const bytes = readFileSync(path)
    bytes[0] ^= 1
    writeFileSync(path, bytes)

    const { status, output } = runChecker(vendor)
    expect(status).toBe(1)
    expect(output).toMatch(/mismatch: src\/slh_dsa\/keygen\.c \(expected [0-9a-f]{40}, actual/)
  })

  it('fails when bytes are appended to a vendored file', () => {
    appendFileSync(join(vendor, 'sphincsplus/ref/randombytes_custom.c'), '\n')

    const { status, output } = runChecker(vendor)
    expect(status).toBe(1)
    expect(output).toMatch(/mismatch: sphincsplus\/ref\/randombytes_custom\.c/)
  })

  it('fails when an unlisted file is added', () => {
    writeFileSync(join(vendor, 'sphincsplus/ref/extra.c'), 'int extra;\n')

    const { status, output } = runChecker(vendor)
    expect(status).toBe(1)
    expect(output).toMatch(/unlisted: sphincsplus\/ref\/extra\.c/)
  })

  it('fails when a vendored path is a symlink', () => {
    const path = join(vendor, 'src/secure_zero.h')
    unlinkSync(path)
    symlinkSync(join(DEFAULT_VENDOR_DIR, 'src/secure_zero.h'), path)

    const { status, output } = runChecker(vendor)
    expect(status).toBe(1)
    expect(output).toMatch(/not a regular file: src\/secure_zero\.h/)
    expect(output).toMatch(/missing: src\/secure_zero\.h/)
  })

  it('fails when a listed file is removed', () => {
    unlinkSync(join(vendor, 'sphincsplus/ref/sign.c'))

    const { status, output } = runChecker(vendor)
    expect(status).toBe(1)
    expect(output).toMatch(/missing: sphincsplus\/ref\/sign\.c/)
  })

  it('fails when the manifest commit differs from the UPSTREAM.md pin', () => {
    const upstream = join(vendor, 'UPSTREAM.md')
    writeFileSync(upstream, readFileSync(upstream, 'utf8').replace(PIN, OTHER))

    const { status, output } = runChecker(vendor)
    expect(status).toBe(1)
    expect(output).toMatch(
      new RegExp(`MANIFEST commit ${PIN} does not match UPSTREAM.md pin ${OTHER}`)
    )
  })

  it('fails when the UPSTREAM.md inventory drifts from MANIFEST', () => {
    const upstream = join(vendor, 'UPSTREAM.md')
    writeFileSync(
      upstream,
      readFileSync(upstream, 'utf8')
        .replace('- `src/slh_dsa/verify.c`\n', '')
        .replace('- `src/bitcoinpqc.c`\n', '- `src/bitcoinpqc.c`\n- `src/extra.c`\n')
    )

    const { status, output } = runChecker(vendor)
    expect(status).toBe(1)
    expect(output).toMatch(/UPSTREAM\.md inventory omits: src\/slh_dsa\/verify\.c/)
    expect(output).toMatch(/UPSTREAM\.md inventory lists extra: src\/extra\.c/)
  })

  it('fails when MANIFEST is missing', () => {
    unlinkSync(join(vendor, 'MANIFEST'))

    const { status, output } = runChecker(vendor)
    expect(status).toBe(1)
    expect(output).toMatch(/check-vendor: .*MANIFEST/)
  })
})

describe('git blob hashing', () => {
  it('matches git hash-object for known blobs', () => {
    expect(gitBlobSha(Buffer.alloc(0))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
    expect(gitBlobSha(Buffer.from('hello\n'))).toBe(SHA)
  })
})

describe('UPSTREAM.md pin parsing', () => {
  it('reads exactly one full-length pin', () => {
    expect(parseUpstreamPin(`# x\n\nPinned commit: \`${PIN}\`\n`)).toBe(PIN)
  })

  it('rejects missing, duplicate, abbreviated, and uppercase pins', () => {
    expect(() => parseUpstreamPin('no pin here\n')).toThrow(/found 0/)
    expect(() =>
      parseUpstreamPin(`Pinned commit: \`${PIN}\`\nPinned commit: \`${OTHER}\`\n`)
    ).toThrow(/found 2/)
    expect(() => parseUpstreamPin('Pinned commit: `d165da6a`\n')).toThrow(/full 40-hex/)
    expect(() => parseUpstreamPin(`Pinned commit: \`${PIN.toUpperCase()}\`\n`)).toThrow(
      /full 40-hex/
    )
  })
})

describe('MANIFEST parsing', () => {
  it('round-trips the generated format', () => {
    const entries = new Map([
      ['src/b.c', OTHER],
      ['LICENSE', SHA],
    ])
    const text = formatManifest({ commit: PIN, entries })
    expect(text).toMatch(new RegExp(`\ncommit ${PIN}\n${SHA}  LICENSE\n${OTHER}  src/b.c\n$`))
    expect(parseManifest(text)).toEqual({ commit: PIN, entries })
  })

  it('rejects malformed manifests', () => {
    const entry = `${SHA}  LICENSE\n`
    expect(() => parseManifest(`commit ${PIN}\n${SHA}  LICENSE`)).toThrow(/end with a newline/)
    expect(() => parseManifest(entry)).toThrow(/no "commit <sha>" line/)
    expect(() => parseManifest(`commit ${PIN}\n`)).toThrow(/lists no files/)
    expect(() => parseManifest(`commit ${PIN}\ncommit ${PIN}\n${entry}`)).toThrow(
      /duplicate commit line/
    )
    expect(() => parseManifest(`commit ${PIN}\n${entry}${entry}`)).toThrow(/duplicate path/)
    expect(() => parseManifest(`commit ${PIN}\n${SHA} LICENSE\n`)).toThrow(/malformed line/)
    expect(() => parseManifest(`commit ${PIN}\n${SHA.slice(1)}  LICENSE\n`)).toThrow(
      /malformed line/
    )
    expect(() => parseManifest(`commit ${PIN}\n${entry}\n`)).toThrow(/MANIFEST:3: malformed/)
    expect(() => parseManifest(`commit ${PIN}\n${SHA}  ../LICENSE\n`)).toThrow(/not allowed/)
    expect(() => parseManifest(`commit ${PIN}\n${SHA}  /LICENSE\n`)).toThrow(/not allowed/)
    expect(() => parseManifest(`commit ${PIN}\n${SHA}  UPSTREAM.md\n`)).toThrow(/not allowed/)
  })
})

describe('manifest generation from an upstream tree', () => {
  const listing = [
    `100644 blob ${SHA}\tLICENSE`,
    `100755 blob ${OTHER}\tsrc/run.sh`,
    `120000 blob ${SHA}\tsrc/link.h`,
    `160000 commit ${OTHER}\tsphincsplus`,
    '',
  ].join('\0')

  it('takes blob SHAs from the upstream tree', () => {
    const tree = parseLsTree(listing)
    expect(manifestEntriesFromTree(tree, ['LICENSE', 'src/run.sh'])).toEqual(
      new Map([
        ['LICENSE', SHA],
        ['src/run.sh', OTHER],
      ])
    )
  })

  it('rejects paths absent upstream or not regular files upstream', () => {
    const tree = parseLsTree(listing)
    expect(() => manifestEntriesFromTree(tree, ['src/local-only.c'])).toThrow(
      /not present upstream: src\/local-only\.c/
    )
    expect(() => manifestEntriesFromTree(tree, ['src/link.h'])).toThrow(/mode 120000/)
    expect(() => manifestEntriesFromTree(tree, ['sphincsplus'])).toThrow(/mode 160000 commit/)
  })

  it('rejects paths the manifest format cannot represent', () => {
    const tree = parseLsTree(`100644 blob ${SHA}\tLICENSES/Public Domain.txt\0`)
    expect(() => manifestEntriesFromTree(tree, ['LICENSES/Public Domain.txt'])).toThrow(
      /path not allowed in MANIFEST: LICENSES\/Public Domain\.txt/
    )
  })

  it('rejects unparseable ls-tree records', () => {
    expect(() => parseLsTree('garbage\0')).toThrow(/unexpected git ls-tree record/)
  })
})

describe('command-line arguments', () => {
  it('rejects unknown and valueless arguments', () => {
    expect(parseArgs([])).toEqual({ vendorDir: DEFAULT_VENDOR_DIR, upstream: null, write: false })
    expect(() => parseArgs(['--verbose'])).toThrow(/unknown argument/)
    expect(() => parseArgs(['--write-from'])).toThrow(/requires a directory/)
    expect(() => parseArgs(['--vendor-dir', ''])).toThrow(/requires a directory/)
    expect(() => parseArgs(['--upstream', 'a', '--write-from', 'b'])).toThrow(/given once/)
  })
})

describe('check-vendor against an upstream checkout', () => {
  let tmp
  let vendor
  let upstream
  let commit

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qbit-pqc-upstream-'))
    vendor = join(tmp, 'vendor')
    upstream = join(tmp, 'upstream')
    cpSync(DEFAULT_VENDOR_DIR, vendor, { recursive: true })
    cpSync(DEFAULT_VENDOR_DIR, upstream, { recursive: true })
    rmSync(join(upstream, 'UPSTREAM.md'))
    rmSync(join(upstream, 'MANIFEST'))
    writeFileSync(join(upstream, 'README.md'), 'upstream-only file\n')
    git(upstream, 'init', '-q')
    git(upstream, 'add', '-A')
    git(upstream, 'commit', '-q', '-m', 'fixture')
    commit = git(upstream, 'rev-parse', 'HEAD')

    for (const name of ['UPSTREAM.md', 'MANIFEST']) {
      const path = join(vendor, name)
      writeFileSync(path, readFileSync(path, 'utf8').replace(PIN, commit))
    }
  })

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true })
  })

  it('confirms a manifest that matches the upstream tree', () => {
    const { status, output } = runChecker(vendor, '--upstream', upstream)
    expect(output).toMatch(new RegExp(`${FILE_COUNT} vendored files are blob-equal .* and the upstream checkout`))
    expect(status).toBe(0)
  })

  it('catches a vendored edit whose manifest entry was rewritten to match', () => {
    const path = join(vendor, 'src/slh_dsa/sign.c')
    appendFileSync(path, '/* local patch */\n')
    const localSha = gitBlobSha(readFileSync(path))
    const manifest = join(vendor, 'MANIFEST')
    const original = readFileSync(manifest, 'utf8')
    const upstreamSha = /([0-9a-f]{40}) {2}src\/slh_dsa\/sign\.c/.exec(original)[1]
    writeFileSync(manifest, original.replace(upstreamSha, localSha))

    expect(runChecker(vendor).status).toBe(0)
    const { status, output } = runChecker(vendor, '--upstream', upstream)
    expect(status).toBe(1)
    expect(output).toMatch(
      new RegExp(`records ${localSha} for src/slh_dsa/sign\\.c, upstream has ${upstreamSha}`)
    )
  })

  it('regenerates the manifest from upstream blobs', () => {
    const manifest = join(vendor, 'MANIFEST')
    const expected = readFileSync(manifest, 'utf8')
    writeFileSync(manifest, 'stale\n')

    const { status, output } = runChecker(vendor, '--write-from', upstream)
    expect(output).toMatch(/wrote .*MANIFEST/)
    expect(status).toBe(0)
    expect(readFileSync(manifest, 'utf8')).toBe(expected)
  })

  it('does not write a manifest that blesses a locally modified file', () => {
    const manifest = join(vendor, 'MANIFEST')
    const before = readFileSync(manifest, 'utf8')
    appendFileSync(join(vendor, 'src/bitcoinpqc.c'), '\n')

    const { status, output } = runChecker(vendor, '--write-from', upstream)
    expect(status).toBe(1)
    expect(output).toMatch(/mismatch: src\/bitcoinpqc\.c/)
    expect(output).toMatch(/MANIFEST was not written/)
    expect(readFileSync(manifest, 'utf8')).toBe(before)
  })

  it('refuses to generate entries for files absent upstream', () => {
    writeFileSync(join(vendor, 'src/local-only.c'), 'int x;\n')

    const { status, output } = runChecker(vendor, '--write-from', upstream)
    expect(status).toBe(1)
    expect(output).toMatch(/not present upstream: src\/local-only\.c/)
  })

  it('fails when the checkout does not contain the pinned commit', () => {
    const upstreamFile = join(vendor, 'UPSTREAM.md')
    writeFileSync(upstreamFile, readFileSync(upstreamFile, 'utf8').replace(commit, OTHER))

    const { status, output } = runChecker(vendor, '--write-from', upstream)
    expect(status).toBe(1)
    expect(output).toMatch(/check-vendor: Command failed: git .* rev-parse/)
  })
})
