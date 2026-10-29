#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node:child_process'

import {
  CHROME_FOR_TESTING_INSTALL_COMMAND,
  CHROME_FOR_TESTING_VERSION,
  browserMatchesVersion,
  chromeSandboxFlags,
  findPinnedChromeForTesting,
} from './chrome-for-testing.mjs'
import { assertPackedPackageRoot, removePackedConsumer, stagePackedConsumer } from './stage-packed-consumer.mjs'
import { installTerminationHandlers } from './termination-handlers.mjs'

const ARTIFACT_SOURCE = 'installed-packed-tarball'
const MANIFEST_NAME = 'Qbit PQC MV3 Package Smoke'

function parseArgs(argv) {
  const args = {
    timeoutMs: 30000,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--chrome') args.chrome = argv[++i]
    else if (arg === '--headful') args.headful = true
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }

  return args
}

function rejectBrandedChrome(chromePath) {
  if (chromePath.includes('/Google Chrome.app/')) {
    throw new Error('branded Google Chrome is not supported for this smoke; use Chrome for Testing')
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolvePort(address.port))
    })
    server.on('error', reject)
  })
}

async function waitForChildClose(closed, timeoutMs) {
  return new Promise(resolveWait => {
    const timeout = setTimeout(() => resolveWait(false), timeoutMs)
    closed.then(() => {
      clearTimeout(timeout)
      resolveWait(true)
    })
  })
}

function signalChromeProcessTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error
      }
    }
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal)
  }
}

async function stopChrome({ browserCdp, child, closed, timeoutMs = 5000 }) {
  if (!child || !closed) {
    return
  }

  if (browserCdp) {
    browserCdp.send('Browser.close').catch(() => undefined)
    if (await waitForChildClose(closed, timeoutMs)) {
      return
    }
  }

  signalChromeProcessTree(child, 'SIGTERM')
  if (await waitForChildClose(closed, timeoutMs)) {
    return
  }

  signalChromeProcessTree(child, 'SIGKILL')
  if (!(await waitForChildClose(closed, timeoutMs))) {
    throw new Error(`Chrome process ${child.pid ?? 'unknown'} did not close`)
  }
}

async function fetchJson(url, timeoutMs = 30000, options = {}) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, options)
      if (response.ok) {
        return response.json()
      }
      lastError = new Error(`${url} returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw lastError ?? new Error(`timed out fetching ${url}`)
}

async function findServiceWorkerTarget(port, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 5000)
    const target = targets.find(
      candidate =>
        candidate.type === 'service_worker' &&
        candidate.url.startsWith('chrome-extension://') &&
        candidate.url.endsWith('/background.mjs')
    )
    if (target) {
      return target
    }
    await delay(250)
  }
  throw new Error('timed out waiting for MV3 service worker target')
}

async function findExtensionId(profileDir, extensionDir, timeoutMs) {
  const prefsPaths = [join(profileDir, 'Default', 'Secure Preferences'), join(profileDir, 'Default', 'Preferences')]
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    for (const prefsPath of prefsPaths) {
      try {
        const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'))
        const settings = prefs.extensions?.settings ?? {}
        for (const [id, setting] of Object.entries(settings)) {
          const extensionPath = typeof setting.path === 'string' ? resolve(dirname(prefsPath), setting.path) : ''
          if (
            setting.path === extensionDir ||
            extensionPath === extensionDir ||
            setting.manifest?.name === MANIFEST_NAME
          ) {
            return id
          }
        }
      } catch {
        // Chrome may not have flushed this profile file yet.
      }
    }
    await delay(250)
  }
  throw new Error('timed out waiting for unpacked extension ID in Chrome profile')
}

async function openExtensionRunner(port, extensionId) {
  const runnerUrl = `chrome-extension://${extensionId}/runner.html`
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(runnerUrl)}`
  try {
    await fetchJson(endpoint, 5000, { method: 'PUT' })
  } catch {
    try {
      await fetchJson(endpoint, 5000)
    } catch {
      // Loading the runner is only a nudge to start the service worker.
    }
  }
}

function cdpConnect(webSocketDebuggerUrl) {
  if (typeof WebSocket !== 'function') {
    throw new Error('this Node version does not expose global WebSocket')
  }

  const ws = new WebSocket(webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()

  const rejectPending = error => {
    for (const entry of pending.values()) {
      entry.reject(error)
    }
    pending.clear()
  }

  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (!message.id) {
      return
    }
    const entry = pending.get(message.id)
    if (!entry) {
      return
    }
    pending.delete(message.id)
    if (message.error) {
      entry.reject(new Error(`${entry.method} failed: ${message.error.message}: ${message.error.data ?? ''}`))
    } else {
      entry.resolve(message.result)
    }
  })

  const open = new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', event => rejectOpen(event.error ?? new Error('CDP WebSocket failed to open')), {
      once: true,
    })
    ws.addEventListener('close', () => rejectOpen(new Error('CDP WebSocket closed before opening')), { once: true })
  })

  ws.addEventListener('error', event => {
    rejectPending(event.error ?? new Error('CDP WebSocket error'))
  })
  ws.addEventListener('close', () => {
    rejectPending(new Error('CDP WebSocket closed'))
  })

  return {
    async send(method, params = {}) {
      await open
      const id = nextId
      nextId += 1
      ws.send(JSON.stringify({ id, method, params }))
      return new Promise((resolveSend, rejectSend) => {
        pending.set(id, { method, resolve: resolveSend, reject: rejectSend })
      })
    },
    close() {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
    },
  }
}

async function waitForHarness(cdp, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'globalThis.__QBIT_PQC_MV3_READY__ === true',
      returnByValue: true,
    })
    if (result.result?.value === true) {
      return
    }
    await delay(250)
  }
  throw new Error('timed out waiting for @qbit-oss/pqc MV3 harness readiness')
}

function writeGoldenFixtureModule(packageRoot, extensionDir) {
  const fixturePath = join(packageRoot, 'fixtures/slh-dsa-golden.json')
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  writeFileSync(
    join(extensionDir, 'golden-fixture.mjs'),
    `export const fixture = ${JSON.stringify(fixture, null, 2)};\n`
  )
}

function prepareExtension({ extensionDir, packageRoot }) {
  mkdirSync(join(extensionDir, 'lib'), { recursive: true })
  mkdirSync(join(extensionDir, 'wasm'), { recursive: true })

  const artifacts = [
    ['lib/index.mjs', 'lib/index.mjs'],
    ['wasm/pqc.mjs', 'wasm/pqc.mjs'],
    ['wasm/pqc.wasm', 'wasm/pqc.wasm'],
  ]
  for (const [from, to] of artifacts) {
    const source = join(packageRoot, from)
    if (!existsSync(source)) {
      throw new Error(`missing ${source}; run pnpm build first`)
    }
    copyFileSync(source, join(extensionDir, to))
  }

  writeGoldenFixtureModule(packageRoot, extensionDir)
  writeFileSync(join(extensionDir, 'background.mjs'), backgroundSource(ARTIFACT_SOURCE))
  writeFileSync(
    join(extensionDir, 'runner.html'),
    '<!doctype html><meta charset="utf-8"><title>Qbit PQC MV3 Smoke</title><script type="module" src="./runner.mjs"></script>\n'
  )
  writeFileSync(
    join(extensionDir, 'runner.mjs'),
    "chrome.runtime.sendMessage({ type: 'qbit-pqc-mv3-ping' }, response => { document.body.textContent = response?.ok ? 'ready' : 'error'; });\n"
  )
  writeFileSync(
    join(extensionDir, 'manifest.json'),
    `${JSON.stringify(
      {
        manifest_version: 3,
        name: MANIFEST_NAME,
        version: '0.0.1',
        background: {
          service_worker: 'background.mjs',
          type: 'module',
        },
        content_security_policy: {
          extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
        },
      },
      null,
      2
    )}\n`
  )

  return extensionDir
}

function backgroundSource(artifactSource) {
  return `import createPqcModule from './wasm/pqc.mjs';
import { constants, init } from './lib/index.mjs';
import { fixture } from './golden-fixture.mjs';

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) {
    throw new Error('invalid fixture hex length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function deterministicEntropy(seedByte) {
  const entropy = new Uint8Array(constants.MIN_ENTROPY);
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 37) % 256)) & 0xff;
  }
  return entropy;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label);
  }
}

async function runSmoke() {
  const client = await init({
    createModule: createPqcModule,
    locateFile: path => chrome.runtime.getURL(\`wasm/\${path}\`),
  });

  assertEqual(constants.PK_SIZE, fixture.sizes.publicKeyBytes, 'public key size mismatch');
  assertEqual(constants.SK_SIZE, fixture.sizes.secretKeyBytes, 'secret key size mismatch');
  assertEqual(constants.SIG_SIZE, fixture.sizes.signatureBytes, 'signature size mismatch');
  assertEqual(constants.MIN_ENTROPY, fixture.sizes.minEntropyBytes, 'entropy size mismatch');

  const vectorNames = [];
  for (const vector of fixture.vectors) {
    const message = hexToBytes(vector.messageHex);
    const pair = client.keygen(deterministicEntropy(vector.seedByte));
    assertEqual(bytesToHex(pair.publicKey), vector.publicKeyHex, \`\${vector.name} public key mismatch\`);
    assertEqual(bytesToHex(pair.secretKey), vector.secretKeyHex, \`\${vector.name} secret key mismatch\`);
    if (!client.secretKeyValidate(pair.secretKey)) {
      throw new Error(\`\${vector.name} secret key validation failed\`);
    }

    const signature = client.sign(pair.secretKey, message);
    assertEqual(bytesToHex(signature), vector.signatureHex, \`\${vector.name} signature mismatch\`);
    if (!client.verify(pair.publicKey, message, signature)) {
      throw new Error(\`\${vector.name} signature verification failed\`);
    }

    const tampered = new Uint8Array(signature);
    tampered[0] ^= 0xff;
    if (client.verify(pair.publicKey, message, tampered)) {
      throw new Error(\`\${vector.name} tampered signature verified\`);
    }
    vectorNames.push(vector.name);
  }

  return {
    ok: true,
    artifactSource: ${JSON.stringify(artifactSource)},
    env: 'chrome-mv3-service-worker',
    package: '@qbit-oss/pqc',
    algorithm: fixture.algorithm,
    vectorCount: vectorNames.length,
    vectorNames,
    wasmHeapBytes: client.wasmHeapBytes(),
  };
}

globalThis.__QBIT_PQC_MV3_SMOKE__ = { run: runSmoke };
globalThis.__QBIT_PQC_MV3_READY__ = true;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'qbit-pqc-mv3-ping') {
    return false;
  }
  sendResponse({ ok: true, ready: globalThis.__QBIT_PQC_MV3_READY__ === true });
  return false;
});
`
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const args = parseArgs(process.argv.slice(2))
const sandboxFlags = chromeSandboxFlags()
// An explicit binary is a deliberate override; a discovered binary must be the pinned build.
// There is no fallback to a system install: it would be checked only after launch,
// and an auto-updated one soon stops matching the pin.
const explicitChromePath = args.chrome || process.env.CHROME_FOR_TESTING_PATH || undefined
const chromePath = explicitChromePath ?? findPinnedChromeForTesting(repoRoot)

if (!chromePath) {
  throw new Error(
    `Chrome for Testing ${CHROME_FOR_TESTING_VERSION} is required. Install it with \`${CHROME_FOR_TESTING_INSTALL_COMMAND}\`, pass \`--chrome\`, or set CHROME_FOR_TESTING_PATH.`
  )
}
rejectBrandedChrome(chromePath)

const outPath = resolve(repoRoot, args.out ?? '.context/qbit-pqc-mv3-smoke/result.json')
let packed
let chrome
let chromeClosed
let stderr = ''
let cdp
let browserCdp
let passed = false
let failure
let chromeShutdown
let terminationHandlers

function ensureChromeStopped() {
  if (!chromeShutdown) {
    chromeShutdown = stopChrome({ browserCdp, child: chrome, closed: chromeClosed })
  }
  return chromeShutdown
}

terminationHandlers = installTerminationHandlers({
  cleanup: ensureChromeStopped,
  onCleanupError: (signal, error) => {
    console.error(`packed-tarball MV3 smoke: ${signal} Chrome cleanup failed: ${error.message}`)
  },
  onSignal: signal => {
    const stage = packed?.stage ? `; stage kept for inspection: ${packed.stage}` : ''
    console.error(`packed-tarball MV3 smoke: interrupted by ${signal}${stage}`)
  },
})

try {
  packed = stagePackedConsumer(repoRoot, 'qbit-pqc-mv3-consumer-')
  const packageRoot = assertPackedPackageRoot({
    consumerDir: packed.consumerDir,
    packageRoot: packed.packageRoot,
    repoRoot,
  })
  const extensionDir = prepareExtension({
    extensionDir: join(packed.stage, 'extension'),
    packageRoot,
  })
  const profileDir = join(packed.stage, 'chrome-profile')
  const port = await freePort()

  mkdirSync(profileDir, { recursive: true })

  chrome = spawn(
    chromePath,
    [
      ...(args.headful ? [] : ['--headless=new']),
      ...sandboxFlags,
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      'about:blank',
    ],
    {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  )
  chromeClosed = new Promise(resolveClose => {
    chrome.once('close', resolveClose)
  })
  const chromeUnavailable = new Promise((_, rejectUnavailable) => {
    chrome.once('error', rejectUnavailable)
    chrome.once('exit', (code, signal) => {
      rejectUnavailable(new Error(`Chrome exited before startup completed (code ${code}, signal ${signal})`))
    })
  })
  chrome.stderr.on('data', chunk => {
    stderr += chunk.toString()
  })

  const browserVersion = await Promise.race([
    fetchJson(`http://127.0.0.1:${port}/json/version`, args.timeoutMs),
    chromeUnavailable,
  ])
  if (explicitChromePath === undefined && !browserMatchesVersion(browserVersion.Browser)) {
    throw new Error(
      `${chromePath} reports ${browserVersion.Browser}, expected pinned Chrome for Testing ${CHROME_FOR_TESTING_VERSION}`
    )
  }
  browserCdp = cdpConnect(browserVersion.webSocketDebuggerUrl)
  let target = await findServiceWorkerTarget(port, 5000).catch(() => undefined)
  if (target === undefined) {
    const extensionId = await findExtensionId(profileDir, extensionDir, args.timeoutMs)
    await openExtensionRunner(port, extensionId)
    target = await findServiceWorkerTarget(port, args.timeoutMs)
  }
  cdp = cdpConnect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await waitForHarness(cdp, args.timeoutMs)

  const evaluated = await cdp.send('Runtime.evaluate', {
    expression: 'globalThis.__QBIT_PQC_MV3_SMOKE__.run()',
    awaitPromise: true,
    returnByValue: true,
  })
  if (evaluated.exceptionDetails) {
    throw new Error(JSON.stringify(evaluated.exceptionDetails, null, 2))
  }

  const result = evaluated.result?.value
  if (!result?.ok) {
    throw new Error(`MV3 smoke failed: ${JSON.stringify(result)}`)
  }
  if (result.artifactSource !== ARTIFACT_SOURCE) {
    throw new Error(`MV3 smoke reported unexpected artifact source: ${result.artifactSource}`)
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ outPath, browser: browserVersion.Browser, ...result }, null, 2))
  passed = true
} catch (error) {
  failure = new Error(`${error.message}\nChrome stderr:\n${stderr}`, { cause: error })
} finally {
  const cleanupErrors = []
  let chromeStopped = false
  let stageRemoved = false

  try {
    if (cdp) cdp.close()
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await ensureChromeStopped()
    chromeStopped = true
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    if (browserCdp) browserCdp.close()
  } catch (error) {
    cleanupErrors.push(error)
  }

  const interrupted = terminationHandlers?.signal !== undefined
  if (!interrupted && passed && packed && chromeStopped) {
    try {
      removePackedConsumer(packed.stage)
      stageRemoved = true
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (!interrupted && passed && cleanupErrors.length === 0) {
    console.log('packed-tarball MV3 smoke: PASS')
  } else if (packed) {
    const stageStatus = stageRemoved
      ? 'stage removed after Chrome shutdown'
      : `stage kept for inspection: ${packed.stage}`
    console.error(`packed-tarball MV3 smoke: FAIL (${stageStatus})`)
  }

  terminationHandlers?.remove()
  if (interrupted) {
    // The signal handler owns the conventional 130/143 exit after shared cleanup.
  } else if (failure && cleanupErrors.length > 0) {
    throw new AggregateError([failure, ...cleanupErrors], 'packed-tarball MV3 smoke and cleanup both failed')
  } else if (failure) {
    throw failure
  } else if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'packed-tarball MV3 smoke cleanup failed')
  }
}
