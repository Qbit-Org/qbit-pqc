#!/usr/bin/env node
// Verifies that every vendored libbitcoinpqc file is blob-equal to the
// upstream pin recorded in vendor/libbitcoinpqc-qbit/MANIFEST.
//
// Check against MANIFEST alone (no git binary or network needed):
//   node scripts/check-vendor.mjs [--vendor-dir <dir>]
//
// Also verify MANIFEST itself against an upstream checkout that contains the
// pinned commit (CI runs this mode on a shallow fetch of the pin):
//   node scripts/check-vendor.mjs --upstream <qbit-libbitcoinpqc checkout>
//
// Regenerate MANIFEST from such a checkout (written only if the check passes):
//   node scripts/check-vendor.mjs --write-from <qbit-libbitcoinpqc checkout>
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isSafePackagePath } from './pack-policy.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')

export const DEFAULT_VENDOR_DIR = join(packageRoot, 'vendor', 'libbitcoinpqc-qbit')
export const UPSTREAM_FILE = 'UPSTREAM.md'
export const MANIFEST_FILE = 'MANIFEST'
const UNLISTED_FILES = new Set([UPSTREAM_FILE, MANIFEST_FILE])

const OBJECT_ID = /^[0-9a-f]{40}$/
const COMMIT_LINE = /^commit ([0-9a-f]{40})$/
const ENTRY_LINE = /^([0-9a-f]{40}) {2}(\S+)$/
const PIN_LINE = /^Pinned commit: `([^`]*)`$/gm
const INVENTORY_LINE = /^- `([^`]+)`$/gm

const MANIFEST_HEADER = [
  '# Git blob SHA-1 of every vendored file at the pinned upstream commit.',
  '# Verify:     pnpm check:vendor',
  '# Regenerate: node scripts/check-vendor.mjs --write-from <qbit-libbitcoinpqc checkout>',
]

export function gitBlobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

// Manifest lines separate SHA and path with whitespace, so paths may not
// contain any.
function isManifestPath(path) {
  return isSafePackagePath(path) && /^\S+$/.test(path) && !UNLISTED_FILES.has(path)
}

export function parseUpstreamPin(text) {
  const matches = [...text.matchAll(PIN_LINE)]
  if (matches.length !== 1) {
    throw new Error(
      `${UPSTREAM_FILE} must contain exactly one "Pinned commit: \`<sha>\`" line, found ${matches.length}`
    )
  }
  const commit = matches[0][1]
  if (!OBJECT_ID.test(commit)) {
    throw new Error(`${UPSTREAM_FILE} pinned commit is not a full 40-hex SHA-1: ${JSON.stringify(commit)}`)
  }
  return commit
}

// The "- `path`" bullets that document the copied inventory.
export function parseUpstreamInventory(text) {
  const paths = [...text.matchAll(INVENTORY_LINE)].map(match => match[1])
  if (paths.length === 0) throw new Error(`${UPSTREAM_FILE} lists no copied files`)
  const inventory = new Set(paths)
  if (inventory.size !== paths.length) throw new Error(`${UPSTREAM_FILE} lists a file twice`)
  return inventory
}

export function parseManifest(text) {
  if (!text.endsWith('\n')) {
    throw new Error(`${MANIFEST_FILE} must end with a newline`)
  }

  let commit = null
  const entries = new Map()
  const lines = text.slice(0, -1).split('\n')

  lines.forEach((line, index) => {
    const where = `${MANIFEST_FILE}:${index + 1}`
    if (line.startsWith('#')) return

    const commitMatch = COMMIT_LINE.exec(line)
    if (commitMatch) {
      if (commit !== null) throw new Error(`${where}: duplicate commit line`)
      commit = commitMatch[1]
      return
    }

    const entryMatch = ENTRY_LINE.exec(line)
    if (!entryMatch) throw new Error(`${where}: malformed line: ${JSON.stringify(line)}`)

    const [, sha, path] = entryMatch
    if (!isManifestPath(path)) throw new Error(`${where}: path not allowed: ${path}`)
    if (entries.has(path)) throw new Error(`${where}: duplicate path: ${path}`)
    entries.set(path, sha)
  })

  if (commit === null) throw new Error(`${MANIFEST_FILE} has no "commit <sha>" line`)
  if (entries.size === 0) throw new Error(`${MANIFEST_FILE} lists no files`)
  return { commit, entries }
}

export function formatManifest({ commit, entries }) {
  const paths = [...entries.keys()].sort()
  return [...MANIFEST_HEADER, `commit ${commit}`, ...paths.map(path => `${entries.get(path)}  ${path}`), ''].join('\n')
}

// Returns every path under `root` (POSIX separators). Anything that is not a
// regular file or directory is reported, because git would hash a symlink's
// target path rather than the bytes the build reads.
export function listVendorFiles(root) {
  const files = []
  const irregular = []

  const walk = relative => {
    const absolute = relative ? join(root, relative) : root
    for (const name of readdirSync(absolute).sort()) {
      const path = relative ? `${relative}/${name}` : name
      const stat = lstatSync(join(root, path))
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) files.push(path)
      else irregular.push(path)
    }
  }

  walk('')
  return { files, irregular }
}

function compareSets(label, actual, expected) {
  const errors = []
  for (const path of expected) if (!actual.has(path)) errors.push(`${label} omits: ${path}`)
  for (const path of actual) if (!expected.has(path)) errors.push(`${label} lists extra: ${path}`)
  return errors.sort()
}

// Verifies the vendored tree and UPSTREAM.md against a parsed manifest.
export function verifyVendorTree(vendorDir, manifest) {
  const errors = []
  const upstreamText = readFileSync(join(vendorDir, UPSTREAM_FILE), 'utf8')
  const pin = parseUpstreamPin(upstreamText)

  if (manifest.commit !== pin) {
    errors.push(`${MANIFEST_FILE} commit ${manifest.commit} does not match ${UPSTREAM_FILE} pin ${pin}`)
  }

  const listed = new Set(manifest.entries.keys())
  errors.push(...compareSets(`${UPSTREAM_FILE} inventory`, parseUpstreamInventory(upstreamText), listed))

  const { files, irregular } = listVendorFiles(vendorDir)
  for (const path of irregular) errors.push(`not a regular file: ${path}`)

  const present = new Set(files)
  for (const [path, expected] of manifest.entries) {
    if (!present.has(path)) {
      errors.push(`missing: ${path}`)
      continue
    }
    const actual = gitBlobSha(readFileSync(join(vendorDir, path)))
    if (actual !== expected) {
      errors.push(`mismatch: ${path} (expected ${expected}, actual ${actual})`)
    }
  }

  for (const path of files) {
    if (!UNLISTED_FILES.has(path) && !listed.has(path)) errors.push(`unlisted: ${path}`)
  }

  return errors
}

export function readManifest(vendorDir) {
  return parseManifest(readFileSync(join(vendorDir, MANIFEST_FILE), 'utf8'))
}

export function checkVendor(vendorDir) {
  const manifest = readManifest(vendorDir)
  return { manifest, errors: verifyVendorTree(vendorDir, manifest) }
}

// Parses `git ls-tree -r -z --full-tree <commit>` output into path -> object.
export function parseLsTree(output) {
  const objects = new Map()
  for (const record of output.split('\0')) {
    if (record === '') continue
    const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(record)
    if (!match) throw new Error(`unexpected git ls-tree record: ${JSON.stringify(record)}`)
    const [, mode, type, sha, path] = match
    objects.set(path, { mode, type, sha })
  }
  return objects
}

// Builds manifest entries for `paths` from the upstream tree listing; each
// path must be a regular-file blob upstream.
export function manifestEntriesFromTree(tree, paths) {
  const entries = new Map()
  const errors = []
  for (const path of paths) {
    const object = tree.get(path)
    if (!isManifestPath(path)) errors.push(`path not allowed in ${MANIFEST_FILE}: ${path}`)
    else if (!object) errors.push(`not present upstream: ${path}`)
    else if (object.type !== 'blob' || !['100644', '100755'].includes(object.mode)) {
      errors.push(`not a regular file upstream (mode ${object.mode} ${object.type}): ${path}`)
    } else if (!OBJECT_ID.test(object.sha)) errors.push(`unexpected object id for ${path}: ${object.sha}`)
    else entries.set(path, object.sha)
  }
  if (errors.length > 0) {
    throw new Error(`cannot derive ${MANIFEST_FILE} from upstream:\n  ${errors.join('\n  ')}`)
  }
  return entries
}

function git(upstreamDir, args) {
  return execFileSync('git', ['-C', upstreamDir, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// Derives the manifest for the files present in `vendorDir` from the upstream
// git tree at the UPSTREAM.md pin; local file contents are never trusted here.
export function manifestFromUpstream(vendorDir, upstreamDir) {
  const pin = parseUpstreamPin(readFileSync(join(vendorDir, UPSTREAM_FILE), 'utf8'))
  const resolved = git(upstreamDir, ['rev-parse', '--verify', '--end-of-options', `${pin}^{commit}`]).trim()
  if (resolved !== pin) throw new Error(`upstream checkout resolved ${pin} to ${resolved}`)

  const { files } = listVendorFiles(vendorDir)
  const tree = parseLsTree(git(upstreamDir, ['ls-tree', '-r', '-z', '--full-tree', pin]))
  const paths = files.filter(path => !UNLISTED_FILES.has(path))
  return { commit: pin, entries: manifestEntriesFromTree(tree, paths) }
}

function compareManifests(committed, upstream) {
  const errors = []
  if (committed.commit !== upstream.commit) {
    errors.push(`${MANIFEST_FILE} commit ${committed.commit} is not upstream pin ${upstream.commit}`)
  }
  for (const [path, sha] of upstream.entries) {
    const recorded = committed.entries.get(path)
    if (recorded !== undefined && recorded !== sha) {
      errors.push(`${MANIFEST_FILE} records ${recorded} for ${path}, upstream has ${sha}`)
    }
  }
  return errors
}

export function parseArgs(argv) {
  const args = { vendorDir: DEFAULT_VENDOR_DIR, upstream: null, write: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg !== '--vendor-dir' && arg !== '--upstream' && arg !== '--write-from') {
      throw new Error(`unknown argument: ${arg}`)
    }
    const value = argv[++i]
    if (value === undefined || value === '') throw new Error(`${arg} requires a directory`)
    if (arg === '--vendor-dir') {
      args.vendorDir = resolve(value)
      continue
    }
    if (args.upstream !== null) throw new Error('--upstream and --write-from may be given once')
    args.upstream = resolve(value)
    args.write = arg === '--write-from'
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  let manifest
  let errors

  if (args.write) {
    manifest = manifestFromUpstream(args.vendorDir, args.upstream)
    errors = verifyVendorTree(args.vendorDir, manifest)
    if (errors.length === 0) {
      const manifestPath = join(args.vendorDir, MANIFEST_FILE)
      writeFileSync(manifestPath, formatManifest(manifest))
      console.log(`wrote ${manifestPath}`)
    }
  } else {
    ;({ manifest, errors } = checkVendor(args.vendorDir))
    if (args.upstream !== null) {
      errors.push(...compareManifests(manifest, manifestFromUpstream(args.vendorDir, args.upstream)))
    }
  }

  if (errors.length > 0) {
    console.error(`vendored files in ${args.vendorDir} do not match upstream ${manifest.commit}:`)
    for (const error of errors) console.error(`  ${error}`)
    if (args.write) console.error(`${MANIFEST_FILE} was not written`)
    process.exit(1)
  }
  const scope = args.upstream === null ? MANIFEST_FILE : `${MANIFEST_FILE} and the upstream checkout`
  console.log(
    `${manifest.entries.size} vendored files are blob-equal to upstream ${manifest.commit} (checked against ${scope})`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`check-vendor: ${error.message}`)
    process.exit(1)
  }
}
