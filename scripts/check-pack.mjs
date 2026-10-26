#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  pathsFromGitStatus,
  selectPackManifest,
  validateTrackedPackFiles,
  validatePackFiles,
} from './pack-policy.mjs'
import { packValidatedTarball, removePackedConsumer } from './stage-packed-consumer.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const packageName = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).name

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

execFileSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit' })

// Lifecycle output is not part of npm's JSON contract. Build explicitly and
// suppress lifecycle scripts for this dry run; real tarball smokes exercise
// the package's prepack hook.
const output = execFileSync(
  'npm',
  ['pack', '--json', '--dry-run', '--ignore-scripts', '--silent'],
  {
    cwd: repoRoot,
    encoding: 'utf8',
  }
)

let packResult
try {
  packResult = JSON.parse(output)
} catch (error) {
  throw new Error(`npm pack did not return JSON: ${error.message}\n${output}`)
}

const manifest = selectPackManifest(packResult, packageName)
if (!Array.isArray(manifest.files)) {
  throw new Error('npm pack result did not contain a files array')
}

const paths = validatePackFiles(manifest.files.map(file => file.path))
// git names paths from the top of the checkout and npm from the package root,
// so the two must be the same directory.
if (git(['rev-parse', '--show-prefix']).trim() !== '') {
  throw new Error(`${repoRoot} is not the top of its git checkout`)
}
const uncommitted = validateTrackedPackFiles(paths, {
  tracked: new Set(git(['ls-files', '-z']).split('\0').filter(Boolean)),
  changed: new Set(pathsFromGitStatus(git(['status', '--porcelain=v1', '-z', '--untracked-files=no']))),
})
const stage = mkdtempSync(join(tmpdir(), 'qbit-pqc-pack-check-'))
try {
  const packed = packValidatedTarball(repoRoot, stage)
  if (JSON.stringify(packed.paths) !== JSON.stringify(paths)) {
    const onlyInDryRun = paths.filter(path => !packed.paths.includes(path))
    const onlyInTarball = packed.paths.filter(path => !paths.includes(path))
    throw new Error(
      `real tarball contents differed from npm's dry run:\n` +
        `  only in dry run: ${onlyInDryRun.join(', ') || '(none)'}\n` +
        `  only in tarball: ${onlyInTarball.join(', ') || '(none)'}`
    )
  }

  if (uncommitted.length > 0) {
    console.warn(
      'warning: packed files with uncommitted changes, which prepublishOnly refuses to publish:\n' +
        `  ${uncommitted.join('\n  ')}`
    )
  }
  console.log(
    `npm package contents: PASS (${paths.length} files, ${manifest.size} bytes packed, ${manifest.unpackedSize} bytes unpacked)`
  )
  // Recorded for the release, to compare with the registry's dist.integrity
  // after publishing: npm pack is reproducible for the same files and npm.
  const tarball = readFileSync(packed.tarballPath)
  console.log(
    `${basename(packed.tarballPath)}: sha256 ${createHash('sha256').update(tarball).digest('hex')}, ` +
      `integrity sha512-${createHash('sha512').update(tarball).digest('base64')}`
  )
} finally {
  removePackedConsumer(stage)
}
