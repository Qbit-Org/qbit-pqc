import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { installTerminationHandlers } from '../scripts/termination-handlers.mjs'

const moduleUrl = new URL('../scripts/termination-handlers.mjs', import.meta.url).href

function waitForOutput(child, output, pattern, timeoutMs = 5000) {
  return new Promise((resolveWait, rejectWait) => {
    const timeout = setTimeout(() => {
      child.stdout.off('data', inspect)
      rejectWait(new Error(`timed out waiting for ${pattern}: ${output.value}`))
    }, timeoutMs)
    const inspect = () => {
      if (pattern.test(output.value)) {
        clearTimeout(timeout)
        child.stdout.off('data', inspect)
        resolveWait()
      }
    }
    child.stdout.on('data', inspect)
    inspect()
  })
}

function waitForClose(child, timeoutMs = 5000) {
  return new Promise((resolveClose, rejectClose) => {
    const timeout = setTimeout(() => {
      child.off('close', onClose)
      rejectClose(new Error('timed out waiting for signal test child to close'))
    }, timeoutMs)
    const onClose = (code, signal) => {
      clearTimeout(timeout)
      resolveClose({ code, signal })
    }
    child.once('close', onClose)
  })
}

async function runSignalCase(firstSignal, secondSignal, expectedCode) {
  const source = `
    import { setTimeout as delay } from 'node:timers/promises';
    import { installTerminationHandlers } from ${JSON.stringify(moduleUrl)};
    let cleanupCount = 0;
    installTerminationHandlers({
      cleanup: async () => {
        cleanupCount += 1;
        process.stdout.write('cleanup:start:' + cleanupCount + '\\n');
        await delay(50);
        process.stdout.write('cleanup:end:' + cleanupCount + '\\n');
      },
    });
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = { value: '' }
  child.stdout.on('data', chunk => {
    output.value += chunk.toString()
  })
  child.stderr.on('data', chunk => {
    output.value += chunk.toString()
  })

  try {
    await waitForOutput(child, output, /ready/)
    child.kill(firstSignal)
    await waitForOutput(child, output, /cleanup:start:1/)
    child.kill(secondSignal)
    const result = await waitForClose(child)

    expect(result).toEqual({ code: expectedCode, signal: null })
    expect(output.value).toContain('cleanup:end:1')
    expect(output.value).not.toContain('cleanup:start:2')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
}

async function runInFlightCleanupCase(signal, expectedCode) {
  const source = `
    import { installTerminationHandlers } from ${JSON.stringify(moduleUrl)};
    let cleanupCount = 0;
    let rejectCleanup;
    let cleanupPromise;
    function ensureCleanup() {
      if (!cleanupPromise) {
        cleanupCount += 1;
        process.stdout.write('cleanup:start:' + cleanupCount + '\\n');
        cleanupPromise = new Promise((_, reject) => { rejectCleanup = reject; });
      }
      return cleanupPromise;
    }
    installTerminationHandlers({
      cleanup: ensureCleanup,
      onCleanupError: (receivedSignal, error) => {
        process.stdout.write('cleanup:error:' + receivedSignal + ':' + error.message + '\\n');
      },
      onSignal: () => {
        setTimeout(() => rejectCleanup(new Error('cleanup exploded')), 25);
      },
    });
    ensureCleanup().catch(error => {
      process.stdout.write('normal:error:' + error.message + '\\n');
    });
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = { value: '' }
  child.stdout.on('data', chunk => {
    output.value += chunk.toString()
  })
  child.stderr.on('data', chunk => {
    output.value += chunk.toString()
  })

  try {
    await waitForOutput(child, output, /ready/)
    child.kill(signal)
    const result = await waitForClose(child)

    expect(result).toEqual({ code: expectedCode, signal: null })
    expect(output.value).toContain(`cleanup:error:${signal}:cleanup exploded`)
    expect(output.value).toContain('normal:error:cleanup exploded')
    expect(output.value).not.toContain('cleanup:start:2')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
}

describe.skipIf(process.platform === 'win32')('termination handlers', () => {
  it('cleans up once and preserves SIGINT exit semantics', async () => {
    await runSignalCase('SIGINT', 'SIGTERM', 130)
  })

  it('cleans up once and preserves SIGTERM exit semantics', async () => {
    await runSignalCase('SIGTERM', 'SIGINT', 143)
  })

  it('coalesces repeated SIGINT while cleanup is running', async () => {
    await runSignalCase('SIGINT', 'SIGINT', 130)
  })

  it('coalesces repeated SIGTERM while cleanup is running', async () => {
    await runSignalCase('SIGTERM', 'SIGTERM', 143)
  })

  it('reuses an in-flight cleanup and reports its failure before signal exit', async () => {
    await runInFlightCleanupCase('SIGINT', 130)
  })

  it('removes both signal listeners after normal finalization', () => {
    const processRef = new EventEmitter()
    const handlers = installTerminationHandlers({
      cleanup: () => undefined,
      exit: () => undefined,
      processRef,
    })

    expect(processRef.listenerCount('SIGINT')).toBe(1)
    expect(processRef.listenerCount('SIGTERM')).toBe(1)
    handlers.remove()
    expect(processRef.listenerCount('SIGINT')).toBe(0)
    expect(processRef.listenerCount('SIGTERM')).toBe(0)
  })
})
