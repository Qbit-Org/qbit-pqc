import { describe, expect, it } from 'vitest'

import {
  REQUIRED_FILES,
  packagePathsFromTarListing,
  pathsFromGitStatus,
  selectPackManifest,
  validateTrackedPackFiles,
  validatePackFiles,
  validatePackedTarballListing,
} from '../scripts/pack-policy.mjs'

const packManifest = {
  files: REQUIRED_FILES.map(path => ({ path })),
  name: '@qbit-oss/pqc',
  size: 1,
  unpackedSize: 1,
  version: '0.0.0',
}

describe('npm pack JSON compatibility', () => {
  it('selects the npm 10/11 array result', () => {
    expect(selectPackManifest([packManifest], '@qbit-oss/pqc')).toBe(packManifest)
  })

  it('selects the npm 12 package-keyed result', () => {
    expect(selectPackManifest({ '@qbit-oss/pqc': packManifest }, '@qbit-oss/pqc')).toBe(packManifest)
  })

  it('rejects missing, extra, and mismatched package results', () => {
    expect(() => selectPackManifest([], '@qbit-oss/pqc')).toThrow(/expected one npm pack result/)
    expect(() => selectPackManifest([packManifest, packManifest], '@qbit-oss/pqc')).toThrow(/received 2/)
    expect(() => selectPackManifest({ other: packManifest }, '@qbit-oss/pqc')).toThrow(/received 0/)
    expect(() => selectPackManifest({ '@qbit-oss/pqc': packManifest, other: packManifest }, '@qbit-oss/pqc')).toThrow(
      /received 2/
    )
    expect(() => selectPackManifest([{ ...packManifest, name: 'other' }], '@qbit-oss/pqc')).toThrow(
      /did not describe @qbit-oss\/pqc/
    )
  })
})

describe('npm package contents policy', () => {
  it('accepts the required release files and allowed provenance additions', () => {
    const paths = [
      ...REQUIRED_FILES,
      'vendor/libbitcoinpqc-qbit/sphincsplus/ref/sign.c',
      'docs/additional-provenance.md',
    ]

    expect(validatePackFiles(paths)).toEqual([...paths].sort())
  })

  it('reports required runtime artifacts that are missing', () => {
    const paths = REQUIRED_FILES.filter(path => path !== 'wasm/pqc.wasm')

    expect(() => validatePackFiles(paths)).toThrow(/missing required files:\n  wasm\/pqc\.wasm/)
  })

  it('requires the vendored upstream blob manifest', () => {
    const paths = REQUIRED_FILES.filter(path => path !== 'vendor/libbitcoinpqc-qbit/MANIFEST')

    expect(() => validatePackFiles(paths)).toThrow(/missing required files:\n  vendor\/libbitcoinpqc-qbit\/MANIFEST/)
  })

  it('requires the wasm factory declaration and allows no other file under types/', () => {
    const paths = REQUIRED_FILES.filter(path => path !== 'types/pqc.d.mts')

    expect(() => validatePackFiles(paths)).toThrow(/missing required files:\n  types\/pqc\.d\.mts/)
    expect(() => validatePackFiles([...REQUIRED_FILES, 'types/index.d.mts'])).toThrow(
      /files outside the release allowlist:\n  types\/index\.d\.mts/
    )
  })

  it('rejects repository-only and unrecognized files', () => {
    expect(() => validatePackFiles([...REQUIRED_FILES, 'scripts/build-wasm.sh', 'notes.txt'])).toThrow(
      /forbidden files:\n  scripts\/build-wasm\.sh/
    )
    expect(() => validatePackFiles([...REQUIRED_FILES, 'notes.txt'])).toThrow(
      /files outside the release allowlist:\n  notes\.txt/
    )
  })

  it('requires the tsup output of every entry and of lib/core.mjs', () => {
    for (const output of ['lib/index.mjs', 'lib/external-wasm.mjs', 'lib/external-wasm.d.mts', 'lib/core.mjs']) {
      const paths = REQUIRED_FILES.filter(path => path !== output)

      expect(() => validatePackFiles(paths)).toThrow(`missing required files:\n  ${output}`)
    }
  })

  it('rejects lib/ files that tsup does not build', () => {
    expect(() => validatePackFiles([...REQUIRED_FILES, 'lib/extra.mjs'])).toThrow(
      /files in lib\/ that tsup does not build:\n  lib\/extra\.mjs/
    )
    expect(() => validatePackFiles([...REQUIRED_FILES, 'lib/chunk/index.mjs'])).toThrow(
      /files in lib\/ that tsup does not build:\n  lib\/chunk\/index\.mjs/
    )
  })

  it('rejects unsafe package paths before applying allowlist prefixes', () => {
    expect(() => validatePackFiles([...REQUIRED_FILES, 'docs/../scripts/check-publish.mjs'])).toThrow(
      /unsafe package paths/
    )
    expect(() => validatePackFiles([...REQUIRED_FILES, 'docs\\publish.mjs'])).toThrow(/unsafe package paths/)
  })
})

describe('tracked package contents', () => {
  // lib/ is git-ignored build output; everything else in the tarball is tracked.
  const tracked = new Set(REQUIRED_FILES.filter(path => !path.startsWith('lib/')))

  it('accepts tracked files and the untracked tsup output', () => {
    expect(validateTrackedPackFiles(REQUIRED_FILES, { tracked, changed: new Set() })).toEqual([])
  })

  it('rejects an untracked file under docs/', () => {
    expect(() =>
      validateTrackedPackFiles([...REQUIRED_FILES, 'docs/local-notes.md'], {
        tracked,
        changed: new Set(),
      })
    ).toThrow(/include files not tracked by git:\n  docs\/local-notes\.md$/)
  })

  it('returns packed files with staged or unstaged changes instead of failing', () => {
    expect(
      validateTrackedPackFiles(REQUIRED_FILES, {
        tracked,
        changed: new Set(['wasm/pqc.mjs', 'wasm/SHA256SUMS', 'scripts/build-wasm.sh']),
      })
    ).toEqual(['wasm/SHA256SUMS', 'wasm/pqc.mjs'])
  })

  it('exempts only the exact tsup outputs from the git check', () => {
    expect(() =>
      validateTrackedPackFiles([...REQUIRED_FILES, 'lib/extra.mjs'], { tracked, changed: new Set() })
    ).toThrow(/include files not tracked by git:\n  lib\/extra\.mjs$/)
  })
})

describe('git status parsing', () => {
  it('reads every path from porcelain v1 -z records, including rename sources', () => {
    const output = [
      ' M README.md',
      'D  docs/derivation.md',
      'A  docs/new.md',
      'R  docs/renamed.md',
      'docs/old.md',
      '?? fixtures/with space.json',
      '',
    ].join('\0')

    expect(pathsFromGitStatus(output)).toEqual([
      'README.md',
      'docs/derivation.md',
      'docs/new.md',
      'docs/renamed.md',
      'docs/old.md',
      'fixtures/with space.json',
    ])
    expect(pathsFromGitStatus('')).toEqual([])
  })

  it('rejects output it cannot parse', () => {
    expect(() => pathsFromGitStatus(' M README.md')).toThrow(/must end with NUL/)
    expect(() => pathsFromGitStatus(' M README.md\n?? notes.md\n')).toThrow(/must end with NUL/)
    expect(() => pathsFromGitStatus('README.md\0')).toThrow(/unexpected git status record/)
    expect(() => pathsFromGitStatus('R  docs/renamed.md\0')).toThrow(/no source path/)
    expect(() => pathsFromGitStatus(undefined)).toThrow(/must be a string/)
  })
})

describe('real tarball listing normalization', () => {
  it('strips npm tarballs package root and ignores directory entries', () => {
    expect(
      packagePathsFromTarListing(
        ['package/', 'package/docs/', 'package/README.md', 'package/docs/derivation.md', ''].join('\n')
      )
    ).toEqual(['README.md', 'docs/derivation.md'])
  })

  it('rejects entries outside npm tarballs package root and empty archives', () => {
    expect(() => packagePathsFromTarListing('README.md\n')).toThrow(/rooted at package/)
    expect(() => packagePathsFromTarListing('package/\npackage/docs/\n')).toThrow(/did not contain package files/)
  })

  it('applies the closed package policy to the exact archive listing', () => {
    const listing = REQUIRED_FILES.map(path => `package/${path}`).join('\n')
    expect(validatePackedTarballListing(listing)).toEqual([...REQUIRED_FILES].sort())
    expect(() => validatePackedTarballListing(`${listing}\npackage/scripts/postpack.mjs\n`)).toThrow(
      /forbidden files:\n  scripts\/postpack\.mjs/
    )
    expect(() => validatePackedTarballListing(`${listing}\npackage/postpack.txt\n`)).toThrow(
      /files outside the release allowlist:\n  postpack\.txt/
    )
  })
})
