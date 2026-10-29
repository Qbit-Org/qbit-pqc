#!/usr/bin/env node
// Fresh-consumer install smoke harness.
//
// Packs @qbit-oss/pqc into a tarball, installs that tarball into a clean throwaway
// project OUTSIDE this repo (so workspace/monorepo resolution can never leak
// in), and runs scripts/consumer-smoke.mjs against the installed package, then
// every examples/*.mjs, checking that each prints what its comments promise.
// This validates the published artifact end to end: the `files` whitelist, the
// `exports` map (including the wasm subpaths), Node wasm resolution, and that
// the package works when consumed by name — the class of bug that in-repo
// tests and submodule consumption both hide.
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkExampleOutput, listExamples, promisedOutput } from './examples.mjs'
import { removePackedConsumer, stagePackedConsumer } from './stage-packed-consumer.mjs'
import { installTerminationHandlers } from './termination-handlers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

let child
let childClosed

// Asynchronous so that a SIGINT or SIGTERM reaches the termination handler
// while the child runs, rather than after it exits. With captureStdout, the
// child's stdout is still echoed, and the promise resolves with it.
function run(cmd, args, { captureStdout = false, ...opts } = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}${opts.cwd ? `  (cwd: ${opts.cwd})` : ''}`)
  child = spawn(cmd, args, { stdio: captureStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit', ...opts })
  let stdout = ''
  if (captureStdout) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      process.stdout.write(chunk)
    })
  }
  childClosed = new Promise(resolveClose => child.once('close', resolveClose))
  return new Promise((resolveRun, rejectRun) => {
    child.once('error', rejectRun)
    child.once('close', (code, signal) => {
      if (code === 0) resolveRun(stdout)
      else rejectRun(new Error(`${cmd} ${args.join(' ')} failed (code ${code}, signal ${signal})`))
    })
  })
}

function waitForChildClose(timeoutMs) {
  return new Promise(resolveWait => {
    const timeout = setTimeout(() => resolveWait(false), timeoutMs)
    childClosed.then(() => {
      clearTimeout(timeout)
      resolveWait(true)
    })
  })
}

async function stopChild(timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    child.kill(signal)
    if (await waitForChildClose(timeoutMs)) {
      return
    }
  }
  throw new Error(`consumer smoke process ${child.pid} did not exit`)
}

let packed
const terminationHandlers = installTerminationHandlers({
  cleanup: stopChild,
  onCleanupError: (signal, error) => {
    console.error(`consumer install smoke: ${signal} cleanup failed: ${error.message}`)
  },
  onSignal: signal => {
    const stage = packed ? `; stage kept for inspection: ${packed.stage}` : ''
    console.error(`consumer install smoke: interrupted by ${signal}${stage}`)
  },
})

packed = stagePackedConsumer(repoRoot, 'qbit-pqc-consumer-')
let passed = false
let failure
try {
  for (const script of ['consumer-smoke.mjs', 'consumer-worker.mjs', 'package-surface.mjs', 'wasm-sha256.mjs']) {
    copyFileSync(join(here, script), join(packed.consumerDir, script))
  }
  await run('node', ['consumer-smoke.mjs'], { cwd: packed.consumerDir })

  // TypeScript's node10 resolution reads no exports map, so the types of each
  // subpath must resolve through typesVersions. Checked with the repository's
  // TypeScript against the installed package.
  const typesDir = join(packed.consumerDir, 'types-node10')
  mkdirSync(typesDir)
  for (const file of ['entries.ts', 'tsconfig.json']) {
    copyFileSync(join(repoRoot, 'test/types/node10', file), join(typesDir, file))
  }
  await run(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', typesDir], {
    cwd: packed.consumerDir,
  })
  console.log('node10 type resolution: PASS')

  // Each example runs as a reader runs it: from a project that installed the
  // tarball, importing the package by name.
  mkdirSync(join(packed.consumerDir, 'examples'))
  for (const name of listExamples(join(repoRoot, 'examples'))) {
    const file = `examples/${name}`
    const promised = promisedOutput(readFileSync(join(repoRoot, file), 'utf8'), file)
    copyFileSync(join(repoRoot, file), join(packed.consumerDir, file))
    checkExampleOutput(file, promised, await run('node', [file], { cwd: packed.consumerDir, captureStdout: true }))
    console.log(`${file}: PASS`)
  }
  passed = true
} catch (error) {
  failure = error
} finally {
  const interrupted = terminationHandlers.signal !== undefined
  if (!interrupted && passed) {
    removePackedConsumer(packed.stage)
    console.log('consumer install smoke: PASS')
  } else {
    console.error(`consumer install smoke: FAIL (stage kept for inspection: ${packed.stage})`)
  }

  terminationHandlers.remove()
  if (interrupted) {
    // The signal handler owns the conventional 130/143 exit after stopping the child.
  } else if (failure) {
    throw failure
  }
}
