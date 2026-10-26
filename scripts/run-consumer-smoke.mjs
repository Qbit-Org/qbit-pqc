#!/usr/bin/env node
// Fresh-consumer install smoke harness.
//
// Packs @qbit-oss/pqc into a tarball, installs that tarball into a clean throwaway
// project OUTSIDE this repo (so workspace/monorepo resolution can never leak
// in), and runs scripts/consumer-smoke.mjs against the installed package. This
// validates the published artifact end to end: the `files` whitelist, the
// `exports` map (including the wasm subpaths), Node wasm resolution, and that
// the package works when consumed by name — the class of bug that in-repo
// tests and submodule consumption both hide.
import { spawn } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { removePackedConsumer, stagePackedConsumer } from './stage-packed-consumer.mjs'
import { installTerminationHandlers } from './termination-handlers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

let child
let childClosed

// Asynchronous so that a SIGINT or SIGTERM reaches the termination handler
// while the child runs, rather than after it exits.
function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}${opts.cwd ? `  (cwd: ${opts.cwd})` : ''}`)
  child = spawn(cmd, args, { stdio: 'inherit', ...opts })
  childClosed = new Promise(resolveClose => child.once('close', resolveClose))
  return new Promise((resolveRun, rejectRun) => {
    child.once('error', rejectRun)
    child.once('close', (code, signal) => {
      if (code === 0) resolveRun()
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
  copyFileSync(join(here, 'consumer-smoke.mjs'), join(packed.consumerDir, 'consumer-smoke.mjs'))
  await run('node', ['consumer-smoke.mjs'], { cwd: packed.consumerDir })
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
