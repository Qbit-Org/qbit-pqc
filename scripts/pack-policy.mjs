const REQUIRED_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'RELEASE.md',
  'RELEASING.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES',
  'docs/derivation.md',
  'docs/mv3-conformance.md',
  'fixtures/qbit-core-binary-derivation.json',
  'fixtures/qbit-core-derivation.json',
  'fixtures/slh-dsa-golden.json',
  'fixtures/qbit-core-signature-vectors.json',
  'fixtures/slh-dsa-golden.json.sha256',
  'lib/index.d.mts',
  'lib/index.mjs',
  'lib/index.mjs.map',
  'package.json',
  'src/index.ts',
  'types/pqc.d.mts',
  'vendor/libbitcoinpqc-qbit/LICENSE',
  'vendor/libbitcoinpqc-qbit/MANIFEST',
  'vendor/libbitcoinpqc-qbit/UPSTREAM.md',
  'vendor/libbitcoinpqc-qbit/include/libbitcoinpqc/bitcoinpqc.h',
  'vendor/libbitcoinpqc-qbit/sphincsplus/LICENSE',
  'vendor/libbitcoinpqc-qbit/sphincsplus/LICENSES/CC0-1.0.txt',
  'vendor/libbitcoinpqc-qbit/sphincsplus/LICENSES/MIT.txt',
  'vendor/libbitcoinpqc-qbit/src/bitcoinpqc.c',
  'wasm/SHA256SUMS',
  'wasm/pqc.mjs',
  'wasm/pqc.wasm',
]

const ALLOWED_FILES = new Set([
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'RELEASE.md',
  'RELEASING.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES',
  'package.json',
  'types/pqc.d.mts',
])
const ALLOWED_PREFIXES = [
  'docs/',
  'fixtures/',
  'lib/',
  'src/',
  'vendor/libbitcoinpqc-qbit/',
  'wasm/',
]

const FORBIDDEN_FILES = new Set([
  '.gitignore',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsup.config.ts',
  'vitest.config.ts',
])
const FORBIDDEN_PREFIXES = ['.context/', '.github/', 'native/', 'node_modules/', 'scripts/', 'test/']

// Everything tsup writes (tsup.config.ts). lib/ is git-ignored and rebuilt by
// prepack, so these are the only packed paths that git does not track.
const BUILD_DIR = 'lib/'
const BUILD_OUTPUTS = new Set(['lib/index.d.mts', 'lib/index.mjs', 'lib/index.mjs.map'])

function isAllowed(path) {
  return ALLOWED_FILES.has(path) || ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix))
}

function isForbidden(path) {
  return FORBIDDEN_FILES.has(path) || FORBIDDEN_PREFIXES.some(prefix => path.startsWith(prefix))
}

export function isSafePackagePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\\') &&
    path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
  )
}

export function selectPackManifest(packResult, expectedName) {
  let manifests

  if (Array.isArray(packResult)) {
    manifests = packResult
  } else if (packResult !== null && typeof packResult === 'object') {
    const entries = Object.entries(packResult)
    if (entries.length === 1 && entries[0][0] === expectedName) {
      manifests = [entries[0][1]]
    } else if (entries.length === 1) {
      manifests = []
    } else {
      manifests = entries.map(([, manifest]) => manifest)
    }
  } else {
    manifests = []
  }

  if (manifests.length !== 1) {
    throw new Error(`expected one npm pack result for ${expectedName}, received ${manifests.length}`)
  }

  const manifest = manifests[0]
  if (manifest === null || typeof manifest !== 'object' || manifest.name !== expectedName) {
    throw new Error(`npm pack result did not describe ${expectedName}`)
  }

  return manifest
}

export function validatePackFiles(paths) {
  if (!Array.isArray(paths)) {
    throw new Error('package file paths must be an array')
  }

  const uniquePaths = new Set(paths)
  const uniquePathList = [...uniquePaths]
  const errors = []

  if (uniquePaths.size !== paths.length) {
    errors.push('npm reported duplicate tarball paths')
  }

  const unsafe = uniquePathList.filter(path => !isSafePackagePath(path)).sort()
  const safePaths = uniquePathList.filter(isSafePackagePath)
  if (unsafe.length > 0) {
    errors.push(`unsafe package paths:\n  ${unsafe.join('\n  ')}`)
  }

  const missing = REQUIRED_FILES.filter(path => !uniquePaths.has(path))
  if (missing.length > 0) {
    errors.push(`missing required files:\n  ${missing.join('\n  ')}`)
  }

  const forbidden = safePaths.filter(isForbidden).sort()
  if (forbidden.length > 0) {
    errors.push(`forbidden files:\n  ${forbidden.join('\n  ')}`)
  }

  const unexpected = safePaths.filter(path => !isAllowed(path)).sort()
  if (unexpected.length > 0) {
    errors.push(`files outside the release allowlist:\n  ${unexpected.join('\n  ')}`)
  }

  const unbuilt = safePaths
    .filter(path => path.startsWith(BUILD_DIR) && !BUILD_OUTPUTS.has(path))
    .sort()
  if (unbuilt.length > 0) {
    errors.push(`files in ${BUILD_DIR} that tsup does not build:\n  ${unbuilt.join('\n  ')}`)
  }

  if (errors.length > 0) {
    throw new Error(`npm package contents failed policy:\n${errors.join('\n')}`)
  }

  return safePaths.sort()
}

// Every packed path except tsup's output must be tracked by git (`tracked`,
// from `git ls-files`), so no local or ignored file ships. Returns the packed
// paths with staged or unstaged changes (`changed`, from `git status`): they
// are fine while editing, and the prepublishOnly guard refuses to publish them.
export function validateTrackedPackFiles(paths, { tracked, changed }) {
  const versioned = paths.filter(path => !BUILD_OUTPUTS.has(path))
  const untracked = versioned.filter(path => !tracked.has(path)).sort()
  if (untracked.length > 0) {
    throw new Error(
      `npm package contents include files not tracked by git:\n  ${untracked.join('\n  ')}`
    )
  }

  return versioned.filter(path => changed.has(path)).sort()
}

// Every path named by `git status --porcelain=v1 -z` output. A rename or copy
// record is followed by the path it came from, which is included too.
export function pathsFromGitStatus(output) {
  if (typeof output !== 'string') {
    throw new Error('git status output must be a string')
  }

  const records = output.split('\0')
  if (records.pop() !== '') {
    throw new Error('git status output must end with NUL')
  }

  const paths = []
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (!/^[ MTADRCU?!]{2} ./s.test(record)) {
      throw new Error(`unexpected git status record: ${JSON.stringify(record)}`)
    }
    paths.push(record.slice(3))

    if (/[RC]/.test(record.slice(0, 2))) {
      i += 1
      if (records[i] === undefined || records[i] === '') {
        throw new Error(`git status rename record has no source path: ${JSON.stringify(record)}`)
      }
      paths.push(records[i])
    }
  }
  return paths
}

export function packagePathsFromTarListing(listing) {
  if (typeof listing !== 'string') {
    throw new Error('tar listing must be a string')
  }

  const paths = []
  for (const entry of listing.split(/\r?\n/).filter(Boolean)) {
    if (!entry.startsWith('package/')) {
      throw new Error(`tarball entry must be rooted at package/: ${entry}`)
    }

    const path = entry.slice('package/'.length)
    if (path.length === 0 || path.endsWith('/')) {
      continue
    }
    paths.push(path)
  }

  if (paths.length === 0) {
    throw new Error('tarball did not contain package files')
  }
  return paths
}

export function validatePackedTarballListing(listing) {
  return validatePackFiles(packagePathsFromTarListing(listing))
}

export { REQUIRED_FILES }
