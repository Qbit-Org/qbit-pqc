import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { validatePackedTarballListing } from './pack-policy.mjs'

function run(command, args, options = {}) {
  const cwd = options.cwd ? ` (cwd: ${options.cwd})` : ''
  const env = { ...process.env }
  delete env.npm_config_ignore_workspace
  delete env.NPM_CONFIG_IGNORE_WORKSPACE
  console.log(`+ ${command} ${args.join(' ')}${cwd}`)
  execFileSync(command, args, { stdio: 'inherit', ...options, env })
}

export function assertPackedPackageRoot({ consumerDir, packageRoot, repoRoot }) {
  const expectedPackageRoot = resolve(consumerDir, 'node_modules', '@qbit-oss', 'pqc')
  const resolvedPackageRoot = resolve(packageRoot)
  if (resolvedPackageRoot !== expectedPackageRoot) {
    throw new Error(
      `packed package root must be ${expectedPackageRoot}, received ${resolvedPackageRoot}`
    )
  }

  const relativeToRepo = relative(resolve(repoRoot), resolvedPackageRoot)
  const isInsideRepo =
    relativeToRepo === '' ||
    (relativeToRepo !== '..' &&
      !relativeToRepo.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToRepo))
  if (isInsideRepo) {
    throw new Error(`packed package root must be outside the repository: ${resolvedPackageRoot}`)
  }

  return resolvedPackageRoot
}

export function packValidatedTarball(repoRoot, stage) {
  run('npm', ['pack', repoRoot, '--pack-destination', stage, '--silent'])
  const tarballs = readdirSync(stage).filter(file => file.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`expected one packed tarball, found ${tarballs.length}`)
  }

  const tarballPath = join(stage, tarballs[0])
  const listing = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' })
  const paths = validatePackedTarballListing(listing)
  console.log(`real npm tarball contents: PASS (${paths.length} files)`)
  return { paths, tarballPath }
}

export function stagePackedConsumer(repoRoot, prefix) {
  const stage = mkdtempSync(join(tmpdir(), prefix))

  try {
    const { tarballPath } = packValidatedTarball(repoRoot, stage)

    const consumerDir = join(stage, 'consumer')
    mkdirSync(consumerDir)
    writeFileSync(
      join(consumerDir, 'package.json'),
      `${JSON.stringify(
        { name: 'qbit-pqc-consumer', private: true, version: '0.0.0', type: 'module' },
        null,
        2
      )}\n`
    )

    run('npm', ['install', '--no-audit', '--no-fund', tarballPath], { cwd: consumerDir })

    const packageRoot = assertPackedPackageRoot({
      consumerDir,
      packageRoot: join(consumerDir, 'node_modules', '@qbit-oss', 'pqc'),
      repoRoot,
    })
    const packageJsonPath = join(packageRoot, 'package.json')
    if (!existsSync(packageJsonPath)) {
      throw new Error(`installed package is missing ${packageJsonPath}`)
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    if (packageJson.name !== '@qbit-oss/pqc') {
      throw new Error(`installed unexpected package ${packageJson.name}`)
    }

    console.log(`installed packed @qbit-oss/pqc at ${packageRoot}`)
    return { consumerDir, packageRoot, stage, tarballPath }
  } catch (error) {
    console.error(`packed consumer setup failed; stage kept for inspection: ${stage}`)
    throw error
  }
}

export function removePackedConsumer(stage) {
  rmSync(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
