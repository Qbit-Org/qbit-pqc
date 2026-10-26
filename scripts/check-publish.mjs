#!/usr/bin/env node
// Refuses to publish unless the package files are committed, the version is a
// release version, and the WASM artifacts verify. npm runs this as
// `prepublishOnly`, before `prepack` rebuilds lib/, and the publish workflow's
// build job runs it before packing the tarball it publishes:
//   node scripts/check-publish.mjs
//
// Outside CI it also runs `pnpm check:wasm:repro`. The publish workflow's
// smoke job runs that rebuild, so CI skips it here.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isSafePackagePath, pathsFromGitStatus } from './pack-policy.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$/

// The npm dist-tag for a release version (see RELEASING.md): `candidate` for
// X.Y.Z-rc.N and `latest` for X.Y.Z. Every other form is refused, including
// ones npm would normalize to a release version, such as `v1.0.0`.
export function distTagForVersion(version) {
  const match = typeof version === 'string' ? RELEASE_VERSION.exec(version) : null
  if (match === null) {
    throw new Error(`version ${JSON.stringify(version)} is not X.Y.Z or X.Y.Z-rc.N`)
  }
  if (match[1] === '0' && match[2] === '0' && match[3] === '0') {
    throw new Error(`version ${version}: 0.0.0 is never published`)
  }
  return match[4] === undefined ? 'latest' : 'candidate'
}

// git pathspecs for package.json `files`, plus package.json itself, which npm
// always packs. `:(glob)` gives `**` the any-depth meaning npm gives it.
export function packageFilePathspecs(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('package.json must list the published files in "files"')
  }
  for (const entry of files) {
    if (!isSafePackagePath(entry) || entry.startsWith('!')) {
      throw new Error(`unsupported package.json "files" entry: ${JSON.stringify(entry)}`)
    }
  }
  return [...files, 'package.json'].map(entry => `:(glob)${entry}`)
}

// Package files with staged, unstaged or untracked changes. lib/ is ignored
// by git, so tsup's output never appears. npm does not read the user's global
// git excludes, so neither does this check. Other ignored files that npm would
// still pack are left to `pnpm pack:check`, which requires every packed file
// to be tracked.
export function uncommittedPackageFiles(root, files) {
  const output = execFileSync(
    'git',
    [
      '-c',
      'core.excludesFile=/dev/null',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      ...packageFilePathspecs(files),
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  return [...new Set(pathsFromGitStatus(output))].sort()
}

// GitHub Actions sets CI=true. Any other value gets the full local checks.
function isCI(env) {
  return env.CI === 'true'
}

function runPnpmScript(root, script) {
  console.log(`+ pnpm ${script}`)
  const result = spawnSync('pnpm', [script], { cwd: root, stdio: 'inherit' })
  if (result.error) {
    console.error(`could not run pnpm ${script}: ${result.error.message}`)
  }
  return result.status === 0
}

// Returns the reasons not to publish the package at `root`. `runScript(name)`
// runs a package script and returns whether it passed.
export function checkPublish(
  root,
  { env = process.env, runScript = script => runPnpmScript(root, script) } = {}
) {
  const errors = []
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  try {
    distTagForVersion(manifest.version)
  } catch (error) {
    errors.push(error.message)
  }

  try {
    const uncommitted = uncommittedPackageFiles(root, manifest.files)
    if (uncommitted.length > 0) {
      errors.push(`uncommitted changes to package files:\n  ${uncommitted.join('\n  ')}`)
    }
  } catch (error) {
    errors.push(error.message)
  }

  if (!runScript('check:wasm')) {
    errors.push('pnpm check:wasm failed')
  }

  // The rebuild takes minutes, so it runs only once everything else passed.
  if (errors.length === 0) {
    if (isCI(env)) {
      console.log("CI=true: pnpm check:wasm:repro is left to the publish workflow's smoke job")
    } else if (!runScript('check:wasm:repro')) {
      errors.push('pnpm check:wasm:repro failed')
    }
  }

  return errors
}

function main() {
  if (process.argv.length > 2) {
    throw new Error(`takes no arguments, received: ${process.argv.slice(2).join(' ')}`)
  }

  const errors = checkPublish(packageRoot)
  if (errors.length > 0) {
    console.error('refusing to publish:')
    for (const error of errors) console.error(error.replace(/^/gm, '  '))
    process.exit(1)
  }
  console.log('publish checks: PASS')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`check-publish: ${error.message}`)
    process.exit(1)
  }
}
