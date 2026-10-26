import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Published files and directories whose prose must stand on its own for
// external readers. lib/ and wasm/ are build output (lib/ is built from src/),
// and vendor/ is upstream code apart from this repository's UPSTREAM.md.
const SCANNED_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'RELEASE.md',
  'RELEASING.md',
  'SECURITY.md',
  'vendor/libbitcoinpqc-qbit/UPSTREAM.md',
]
const SCANNED_DIRS = ['docs', 'fixtures', 'src']

// Details of a developer's machine, and wording that points at what an
// external reader cannot see.
const FORBIDDEN = [
  { rule: 'non-public reference', pattern: /non-public/gi },
  { rule: 'machine model', pattern: /\bMac\d+,\d+\b/g },
  { rule: 'machine-local home path', pattern: /\/(?:Users|home)\/[\w.-]+\//g },
]

// `.context/` is this repository's git-ignored scratch directory. The only
// documented use is the Chrome for Testing install target that
// scripts/run-mv3-smoke.mjs searches; any other path, such as a local upstream
// checkout under `.context/repos/`, cannot be followed by an external reader.
const CONTEXT_PATH = /\.context\/[^\s`'")\]]*/g
const ALLOWED_CONTEXT_DIRS = ['.context/browsers']

function findLeftovers(text) {
  const findings = []
  const lines = text.split(/\r?\n/)

  lines.forEach((line, index) => {
    for (const { rule, pattern } of FORBIDDEN) {
      for (const match of line.matchAll(pattern)) {
        findings.push({ line: index + 1, rule, match: match[0] })
      }
    }
    for (const match of line.matchAll(CONTEXT_PATH)) {
      // Sentence punctuation after a path is not part of it.
      const path = match[0].replace(/[.,;:!?]+$/, '')
      const allowed = ALLOWED_CONTEXT_DIRS.some(dir => path === dir || path.startsWith(`${dir}/`))
      if (!allowed) {
        findings.push({ line: index + 1, rule: 'machine-local .context path', match: path })
      }
    }
  })

  return findings
}

function walk(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap(name => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? walk(path) : [path]
    })
}

function scannedPaths() {
  return [
    ...SCANNED_FILES.map(file => join(repoRoot, file)),
    ...SCANNED_DIRS.flatMap(dir => walk(join(repoRoot, dir))),
  ].map(path => relative(repoRoot, path))
}

describe('leftover reference scanner', () => {
  it('flags machine-local references and .context paths', () => {
    const sample = [
      'cc .context/repos/libbitcoinpqc-qbit/src/bitcoinpqc.c',
      'at the non-public pin',
      '| Machine | Mac16,6 |',
      'open /Users/someone/src/qbit',
      'scratch in `.context/scratch/node.json`',
    ].join('\n')

    expect(findLeftovers(sample).map(finding => finding.line)).toEqual([1, 2, 3, 4, 5])
  })

  it('allows only the documented .context scratch-dir usage', () => {
    expect(
      findLeftovers(
        [
          'pnpm dlx @puppeteer/browsers install chrome@stable --path .context/browsers',
          'includes `.github`, `.context`, `native`, `scripts`, `test`',
          'Qbit-Org/qbit-libbitcoinpqc at the pinned commit',
        ].join('\n')
      )
    ).toEqual([])

    expect(findLeftovers('rm -rf .context/repro')).toEqual([
      { line: 1, rule: 'machine-local .context path', match: '.context/repro' },
    ])
    expect(findLeftovers('--path .context/browsers-old/chrome')).toEqual([
      { line: 1, rule: 'machine-local .context path', match: '.context/browsers-old/chrome' },
    ])
    expect(findLeftovers('chrome at .context/browsers/chrome/linux')).toEqual([])
    expect(findLeftovers('Install it under .context/browsers. Then run it.')).toEqual([])
    expect(findLeftovers('(see .context/browsers/, or pass --chrome)')).toEqual([])
    expect(findLeftovers('cache in .context/repro.')).toEqual([
      { line: 1, rule: 'machine-local .context path', match: '.context/repro' },
    ])
    expect(findLeftovers('"coreReference": ".context/repos/qbit/src/crypto/pqc.cpp:137-199"')).toEqual(
      [{ line: 1, rule: 'machine-local .context path', match: '.context/repos/qbit/src/crypto/pqc.cpp:137-199' }]
    )
  })
})

describe('published docs and fixtures', () => {
  // package.json is published too: its metadata names the published package
  // and the public repository.
  it('keeps package.json on the published name and repository', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

    expect(manifest.name).toBe('@qbit-oss/pqc')
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/Qbit-Org/qbit-pqc.git',
    })
    expect(manifest.bugs).toEqual({ url: 'https://github.com/Qbit-Org/qbit-pqc/issues' })
    expect(manifest.homepage).toBe('https://github.com/Qbit-Org/qbit-pqc#readme')
  })

  it('scans every published doc and fixture', () => {
    expect(scannedPaths()).toEqual(
      expect.arrayContaining([
        'README.md',
        'RELEASE.md',
        'SECURITY.md',
        'docs/derivation.md',
        'docs/mv3-conformance.md',
        'fixtures/qbit-core-derivation.json',
        'fixtures/slh-dsa-golden.json',
        'src/index.ts',
        'vendor/libbitcoinpqc-qbit/UPSTREAM.md',
      ])
    )
  })

  it('contain no machine-local leftovers', () => {
    const leftovers = scannedPaths().flatMap(path =>
      findLeftovers(readFileSync(join(repoRoot, path), 'utf8')).map(
        finding => `${path}:${finding.line}: ${finding.rule}: ${finding.match}`
      )
    )

    expect(leftovers).toEqual([])
  })

  it('pins the qbit Core reference to the fixture source commit', () => {
    const { source } = JSON.parse(
      readFileSync(join(repoRoot, 'fixtures/qbit-core-derivation.json'), 'utf8')
    )
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([0-9a-f]{40})\/(\S+)#L(\d+)-L(\d+)$/.exec(
      source.coreReference
    )

    expect(match).not.toBeNull()
    const [, repository, commit, path, firstLine, lastLine] = match
    expect(repository).toBe(source.repository)
    expect(commit).toBe(source.commit)
    expect(source.files).toContain(path)
    expect(Number(firstLine)).toBeGreaterThan(0)
    expect(Number(lastLine)).toBeGreaterThanOrEqual(Number(firstLine))
  })
})
