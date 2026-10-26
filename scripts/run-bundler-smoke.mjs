#!/usr/bin/env node
// Bundler smoke for @qbit-oss/pqc (`pnpm smoke:bundlers`).
//
// Packs the package and installs the tarball, with exact versions of webpack,
// esbuild and Vite, into throwaway projects outside the repository. Each
// bundler builds, or for Vite's dev server serves, two pages made from
// scripts/bundler-smoke.mjs, with its stock settings: no config file, loader
// or plugin. One page loads the package with the default init(), the other
// with the README's static-factory recipe, init({ createModule }) with the
// factory from @qbit-oss/pqc/wasm/pqc.mjs. The pinned Chrome for Testing loads
// every page, which must match the golden vectors without requesting
// pqc.wasm: both recipes compile the copy embedded in lib/index.mjs.
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFile,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import {
  CHROME_FOR_TESTING_INSTALL_COMMAND,
  CHROME_FOR_TESTING_VERSION,
  browserMatchesVersion,
  chromeSandboxFlags,
  findPinnedChromeForTesting,
} from './chrome-for-testing.mjs'
import {
  assertPackedPackageRoot,
  packValidatedTarball,
  removePackedConsumer,
} from './stage-packed-consumer.mjs'
import { installTerminationHandlers } from './termination-handlers.mjs'

// Exact bundler versions, installed with npm's --before so that their own
// dependencies resolve to releases published by that date: nothing newer, such
// as a freshly hijacked release, is installed. The date must follow every
// pinned release; pin releases at least 14 days old, as pnpm-workspace.yaml's
// minimumReleaseAge does for the lockfile.
export const RESOLVE_BEFORE = '2026-10-09T00:00:00Z'
export const TOOLCHAINS = {
  webpack: { webpack: '5.111.1', 'webpack-cli': '7.2.3' },
  esbuild: { esbuild: '0.28.2' },
  vite8: { vite: '8.3.4' },
  vite7: { vite: '7.3.7' },
}

// The entry of each page: the README's default init(), and its static-factory
// recipe without the MV3-only locateFile.
export const RECIPES = {
  default: [
    "import { init } from '@qbit-oss/pqc'",
    "import { runSmoke } from './smoke.js'",
    '',
    "runSmoke('default', () => init())",
  ],
  factory: [
    "import { init } from '@qbit-oss/pqc'",
    "import createPqcModule from '@qbit-oss/pqc/wasm/pqc.mjs'",
    "import { runSmoke } from './smoke.js'",
    '',
    "runSmoke('factory', () => init({ createModule: createPqcModule }))",
  ],
}

// Each target builds a recipe's page into a directory to serve, or serves the
// page itself.
export const TARGETS = [
  { name: 'webpack', toolchain: 'webpack', build: buildWithWebpack },
  {
    name: 'esbuild-esm',
    toolchain: 'esbuild',
    build: (project, recipe) => buildWithEsbuild(project, recipe, 'esm'),
  },
  {
    name: 'esbuild-iife',
    toolchain: 'esbuild',
    build: (project, recipe) => buildWithEsbuild(project, recipe, 'iife'),
  },
  { name: 'vite8-build', toolchain: 'vite8', build: buildWithVite },
  { name: 'vite8-dev', toolchain: 'vite8', serve: serveWithVite },
  { name: 'vite7-build', toolchain: 'vite7', build: buildWithVite },
  { name: 'vite7-dev', toolchain: 'vite7', serve: serveWithVite },
]

const REPORT_GLOBAL = '__QBIT_PQC_BUNDLER_SMOKE__'
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
// Child processes still running (npm, the bundlers, Vite's dev server and
// Chrome), each with a promise that settles when it exits.
const running = new Map()

function parseArgs(argv) {
  const args = { timeoutMs: 30000 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--chrome') {
      args.chrome = argv[++i]
      if (!args.chrome) throw new Error('--chrome needs a path')
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[++i])
      if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0) {
        throw new Error('--timeout-ms needs a positive integer')
      }
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// The environment stage-packed-consumer.mjs gives npm: without pnpm's
// ignore-workspace setting, which pnpm passes to scripts.
function childEnv() {
  const env = { ...process.env }
  delete env.npm_config_ignore_workspace
  delete env.NPM_CONFIG_IGNORE_WORKSPACE
  return env
}

function start(command, args, options) {
  console.log(`+ ${command} ${args.join(' ')}  (cwd: ${options.cwd})`)
  const child = spawn(command, args, {
    detached: process.platform !== 'win32',
    env: childEnv(),
    stdio: 'inherit',
    ...options,
  })
  const exited = new Promise(resolveExit => {
    child.once('error', error => resolveExit({ error }))
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  }).finally(() => running.delete(child))
  running.set(child, exited)
  return child
}

// Runs `command` to completion; `name` labels its failure.
async function run(name, command, args, options) {
  const { code, signal, error } = await running.get(start(command, args, options))
  if (error || code !== 0) {
    throw new Error(`${name} failed (${error ? error.message : `code ${code}, signal ${signal}`})`)
  }
}

// The script a package declares as its `binName` binary, run with this Node.
function binScript(project, packageName, binName) {
  const packageDir = join(project, 'node_modules', packageName)
  const { bin } = readJson(join(packageDir, 'package.json'))
  const path = typeof bin === 'string' ? bin : bin?.[binName]
  if (typeof path !== 'string') {
    throw new Error(`${packageName} declares no ${binName} binary`)
  }
  return join(packageDir, path)
}

function signalProcessTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
}

async function stopProcess(child, exited, timeoutMs = 5000) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (child.exitCode !== null || child.signalCode !== null) return
    signalProcessTree(child, signal)
    const stopped = await Promise.race([exited.then(() => true), delay(timeoutMs, false)])
    if (stopped) return
  }
  throw new Error(`process ${child.pid} did not exit`)
}

async function stopRunning() {
  const errors = []
  for (const [child, exited] of running) {
    await stopProcess(child, exited).catch(error => errors.push(error))
  }
  if (errors.length > 0) throw new AggregateError(errors, 'could not stop every child process')
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
    server.on('error', reject)
  })
}

// Retries until `url` answers with a 2xx status, and returns that response.
async function fetchOk(url, timeoutMs, options = {}) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, options)
      if (response.ok) return response
      lastError = new Error(`${url} returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw lastError ?? new Error(`timed out fetching ${url}`)
}

async function fetchJson(url, timeoutMs, options = {}) {
  return (await fetchOk(url, timeoutMs, options)).json()
}

function pageHtml(script, type) {
  const typeAttribute = type === 'module' ? ' type="module"' : ''
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<link rel="icon" href="data:,">',
    '<title>qbit-pqc bundler smoke</title>',
    `<script${typeAttribute} src="${script}"></script>`,
    '',
  ].join('\n')
}

// A throwaway project with one toolchain and the packed package installed, and
// a directory per recipe holding its page: index.html (Vite's entry), main.js,
// smoke.js and golden-fixture.js.
async function prepareProject(stage, toolchain, tarballPath) {
  const project = join(stage, toolchain)
  mkdirSync(project)
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify(
      { name: `qbit-pqc-bundler-smoke-${toolchain}`, private: true, version: '0.0.0', type: 'module' },
      null,
      2
    )}\n`
  )

  const packages = Object.entries(TOOLCHAINS[toolchain])
  await run(
    'npm install',
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      `--before=${RESOLVE_BEFORE}`,
      tarballPath,
      ...packages.map(([name, version]) => `${name}@${version}`),
    ],
    { cwd: project }
  )
  for (const [name, version] of packages) {
    const installed = readJson(join(project, 'node_modules', name, 'package.json')).version
    if (installed !== version) {
      throw new Error(`${toolchain}: installed ${name}@${installed}, expected ${version}`)
    }
  }

  const packageRoot = assertPackedPackageRoot({
    consumerDir: project,
    packageRoot: join(project, 'node_modules', '@qbit-oss', 'pqc'),
    repoRoot,
  })
  const fixture = readJson(join(packageRoot, 'fixtures/slh-dsa-golden.json'))
  for (const [recipe, lines] of Object.entries(RECIPES)) {
    const page = join(project, recipe)
    mkdirSync(page)
    writeFileSync(join(page, 'index.html'), pageHtml('./main.js', 'module'))
    writeFileSync(join(page, 'main.js'), `${lines.join('\n')}\n`)
    copyFileSync(join(scriptDir, 'bundler-smoke.mjs'), join(page, 'smoke.js'))
    writeFileSync(
      join(page, 'golden-fixture.js'),
      `export const fixture = ${JSON.stringify(fixture, null, 2)}\n`
    )
  }
  return { dir: project, vectorCount: fixture.vectors.length }
}

// webpack's CLI with an entry, an output directory and production mode.
async function buildWithWebpack(project, recipe) {
  const outDir = join(project, 'dist', 'webpack', recipe)
  await run(
    'webpack',
    process.execPath,
    [
      binScript(project, 'webpack', 'webpack'),
      '--mode',
      'production',
      '--entry',
      `./${recipe}/main.js`,
      '--output-path',
      outDir,
    ],
    { cwd: project }
  )
  writeFileSync(join(outDir, 'index.html'), pageHtml('main.js', 'classic'))
  return outDir
}

async function buildWithEsbuild(project, recipe, format) {
  const outDir = join(project, 'dist', `esbuild-${format}`, recipe)
  await run(
    'esbuild',
    process.execPath,
    [
      binScript(project, 'esbuild', 'esbuild'),
      `${recipe}/main.js`,
      '--bundle',
      '--platform=browser',
      `--format=${format}`,
      `--outfile=${join(outDir, 'main.js')}`,
    ],
    { cwd: project }
  )
  writeFileSync(join(outDir, 'index.html'), pageHtml('main.js', format === 'esm' ? 'module' : 'classic'))
  return outDir
}

// Builds the page's index.html into <page>/dist.
async function buildWithVite(project, recipe) {
  await run('vite build', process.execPath, [binScript(project, 'vite', 'vite'), 'build', recipe], {
    cwd: project,
  })
  return join(project, recipe, 'dist')
}

// Vite's dev server, which pre-bundles the package into node_modules/.vite.
async function serveWithVite(project, recipe, timeoutMs) {
  rmSync(join(project, 'node_modules', '.vite'), { recursive: true, force: true })
  const port = await freePort()
  const server = start(
    process.execPath,
    [
      binScript(project, 'vite', 'vite'),
      recipe,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
      '--clearScreen',
      'false',
    ],
    { cwd: project }
  )
  const exited = running.get(server)
  const url = `http://127.0.0.1:${port}/`
  try {
    await Promise.race([
      fetchOk(url, timeoutMs),
      exited.then(({ code, signal }) => {
        throw new Error(`vite exited before serving (code ${code}, signal ${signal})`)
      }),
    ])
  } catch (error) {
    await stopProcess(server, exited)
    throw error
  }
  return { url, close: () => stopProcess(server, exited) }
}

// Serves a built page from 127.0.0.1.
async function serveDirectory(root) {
  const server = createServer((request, response) => {
    let file
    try {
      const { pathname } = new URL(request.url, 'http://localhost')
      file = resolve(root, `.${decodeURIComponent(pathname)}`)
    } catch {
      response.writeHead(400).end()
      return
    }
    if (file === root) file = join(root, 'index.html')
    if (!file.startsWith(`${root}${sep}`)) {
      response.writeHead(404).end()
      return
    }
    readFile(file, (error, body) => {
      if (error) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      })
      response.end(body)
    })
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () =>
      new Promise(resolveClose => {
        server.closeAllConnections()
        server.close(() => resolveClose())
      }),
  }
}

async function launchChrome(chromePath, profileDir, timeoutMs) {
  const port = await freePort()
  console.log(`+ ${chromePath} --headless=new --remote-debugging-port=${port} ...`)
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      ...chromeSandboxFlags(),
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] }
  )
  const exited = new Promise(resolveExit => child.once('close', () => resolveExit())).finally(() =>
    running.delete(child)
  )
  running.set(child, exited)
  const chrome = { port, stderr: '' }
  child.stderr.on('data', chunk => {
    chrome.stderr += chunk.toString()
  })

  const version = await Promise.race([
    fetchJson(`http://127.0.0.1:${port}/json/version`, timeoutMs),
    new Promise((_, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) =>
        reject(new Error(`Chrome exited before startup (code ${code}, signal ${signal})`))
      )
    }),
  ])
  chrome.browser = version.Browser
  return chrome
}

function cdpConnect(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()

  const rejectPending = error => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params)
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(`${entry.method} failed: ${message.error.message}`))
    else entry.resolve(message.result)
  })

  const open = new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', () => rejectOpen(new Error('CDP WebSocket failed to open')), {
      once: true,
    })
  })
  ws.addEventListener('close', () => rejectPending(new Error('CDP WebSocket closed')))

  return {
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener])
    },
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
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close()
    },
  }
}

// Loads `url` in a new tab and waits for the page's report. Throws unless it
// passed every golden vector without requesting a .wasm file.
async function runPage(chrome, url, recipe, vectorCount, timeoutMs) {
  const tab = await fetchJson(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, 5000, {
    method: 'PUT',
  })
  const cdp = cdpConnect(tab.webSocketDebuggerUrl)
  const requests = new Map()
  const problems = []
  cdp.on('Network.requestWillBeSent', ({ requestId, request }) => requests.set(requestId, request.url))
  cdp.on('Network.responseReceived', ({ response }) => {
    if (response.status >= 400) problems.push(`HTTP ${response.status} for ${response.url}`)
  })
  cdp.on('Network.loadingFailed', ({ requestId, errorText }) => {
    problems.push(`${errorText} for ${requests.get(requestId)}`)
  })
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    problems.push(exceptionDetails.exception?.description ?? exceptionDetails.text)
  })

  try {
    await cdp.send('Network.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url })
    const started = Date.now()
    let report
    while (report === undefined) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timed out waiting for the page to report: ${problems.join('; ') || 'no errors'}`)
      }
      await delay(250)
      // Fails while the page replaces about:blank; the next poll retries.
      const evaluated = await cdp
        .send('Runtime.evaluate', { expression: `globalThis.${REPORT_GLOBAL}`, returnByValue: true })
        .catch(() => undefined)
      report = evaluated?.result?.value
    }

    if (!report.ok) throw new Error(report.error)
    if (report.recipe !== recipe) throw new Error(`page ran the ${report.recipe} recipe`)
    if (report.vectorNames.length !== vectorCount) {
      throw new Error(`page checked ${report.vectorNames.length} of ${vectorCount} vectors`)
    }
    const wasmRequests = [...requests.values()].filter(requested => /\.wasm(?:[?#]|$)/.test(requested))
    if (wasmRequests.length > 0) {
      throw new Error(`page requested ${wasmRequests.join(', ')} instead of the embedded copy`)
    }
    return report.vectorNames
  } finally {
    cdp.close()
    await fetch(`http://127.0.0.1:${chrome.port}/json/close/${tab.id}`).catch(() => undefined)
  }
}

async function runTarget(chrome, target, project, recipe, timeoutMs) {
  const label = `${target.name} ${recipe}`
  let page
  try {
    if (target.build) {
      page = await serveDirectory(await target.build(project.dir, recipe))
    } else {
      page = await target.serve(project.dir, recipe, timeoutMs)
    }
    const vectorNames = await runPage(chrome, page.url, recipe, project.vectorCount, timeoutMs)
    console.log(`bundler smoke: PASS ${label} (${vectorNames.length} vectors)`)
    return { label, ok: true }
  } catch (error) {
    console.error(`bundler smoke: FAIL ${label}: ${error.message}`)
    return { label, ok: false, error: error.message }
  } finally {
    await page?.close()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  // An explicit binary is a deliberate override; a discovered one must be the
  // pinned build, with no fallback to a system install (as in run-mv3-smoke).
  const explicitChromePath = args.chrome ?? (process.env.CHROME_FOR_TESTING_PATH || undefined)
  const chromePath = explicitChromePath ?? findPinnedChromeForTesting(repoRoot)
  if (!chromePath) {
    throw new Error(
      `Chrome for Testing ${CHROME_FOR_TESTING_VERSION} is required. Install it with \`${CHROME_FOR_TESTING_INSTALL_COMMAND}\`, pass \`--chrome\`, or set CHROME_FOR_TESTING_PATH.`
    )
  }

  const stage = mkdtempSync(join(tmpdir(), 'qbit-pqc-bundler-smoke-'))
  const results = []
  let chrome
  let failure
  const terminationHandlers = installTerminationHandlers({
    cleanup: stopRunning,
    onCleanupError: (signal, error) => {
      console.error(`bundler smoke: ${signal} cleanup failed: ${error.message}`)
    },
    onSignal: signal => {
      console.error(`bundler smoke: interrupted by ${signal}; stage kept for inspection: ${stage}`)
    },
  })

  try {
    const { tarballPath } = packValidatedTarball(repoRoot, stage)
    const projects = {}
    for (const toolchain of Object.keys(TOOLCHAINS)) {
      projects[toolchain] = await prepareProject(stage, toolchain, tarballPath)
    }

    chrome = await launchChrome(chromePath, join(stage, 'chrome-profile'), args.timeoutMs)
    if (explicitChromePath === undefined && !browserMatchesVersion(chrome.browser)) {
      throw new Error(
        `${chromePath} reports ${chrome.browser}, expected pinned Chrome for Testing ${CHROME_FOR_TESTING_VERSION}`
      )
    }
    console.log(`bundler smoke: running pages in ${chrome.browser}`)

    for (const target of TARGETS) {
      for (const recipe of Object.keys(RECIPES)) {
        results.push(await runTarget(chrome, target, projects[target.toolchain], recipe, args.timeoutMs))
      }
    }
  } catch (error) {
    failure = chrome ? new Error(`${error.message}\nChrome stderr:\n${chrome.stderr}`) : error
  }

  let cleanupError
  try {
    await stopRunning()
  } catch (error) {
    cleanupError = error
  }
  terminationHandlers.remove()
  if (terminationHandlers.signal !== undefined) {
    // The signal handler owns the conventional 130/143 exit after cleanup.
    return
  }

  const failed = results.filter(result => !result.ok)
  console.log('bundler smoke results:')
  for (const result of results) {
    const detail = result.ok ? '' : `: ${result.error.split('\n')[0]}`
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${detail}`)
  }
  if (failure || failed.length > 0 || cleanupError) {
    console.error(`bundler smoke: FAIL (stage kept for inspection: ${stage})`)
    throw failure ?? cleanupError ?? new Error(`${failed.length} of ${results.length} pages failed`)
  }
  removePackedConsumer(stage)
  console.log(`bundler smoke: PASS (${results.length} pages)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
