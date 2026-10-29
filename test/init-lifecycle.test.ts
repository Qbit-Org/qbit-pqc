import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Pqc from '../src/index'
import createPqcModule from '../wasm/pqc.mjs'
import { freshClient } from './fresh-client'

type PqcExports = typeof Pqc
type PqcModuleOptions = Pqc.PqcWasmModuleOptions

const wasmDir = fileURLToPath(new URL('../wasm/', import.meta.url))
const SK = new Uint8Array(64)

// A copy of the package's "." entry with no init() called yet: each test
// starts with no client published and no load to share.
async function freshPqc(): Promise<PqcExports> {
  vi.resetModules()
  return (await import('../src/index')) as PqcExports
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  // Not `rejects`: a client that loaded by mistake would be printed, WASM heap
  // and all.
  return promise.then(
    () => undefined,
    (reason: unknown) => reason
  )
}

const failingFactory = (): Promise<Pqc.PqcWasmModule> => Promise.reject(new Error('no module'))

// What init() rejects with when a factory fails without fetching pqc.wasm: a
// PqcLoadError with no file to name, whose cause is the factory's error.
function expectFactoryFailure(pqc: PqcExports, error: unknown, message = 'no module'): void {
  expect(error).toBeInstanceOf(pqc.PqcLoadError)
  expect(error).toMatchObject({
    kind: 'LOAD_FAILED',
    url: undefined,
    status: undefined,
    message: `init() could not load the WASM module: ${message}`,
  })
  expect((error as Pqc.PqcLoadError).cause).toEqual(new Error(message))
}

// Clients compared by identity, so a failure does not print two WASM heaps.
function expectSameClient(actual: unknown, expected: unknown, same = true): void {
  expect(actual === expected, same ? 'the same client' : 'another client').toBe(same)
}

// Which module a named export ran on.
function spyOnValidate(...modules: Pqc.PqcWasmModule[]) {
  return modules.map(module => vi.spyOn(module, '_qbit_pqc_secret_key_validate'))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('init() publication', () => {
  it('binds the named exports to the newest call, even when an earlier call settles later', async () => {
    const pqc = await freshPqc()
    const gate = deferred()
    const slowModule = await createPqcModule()
    const slowCall = pqc.init({
      createModule: async () => {
        await gate.promise
        return slowModule
      },
    })
    const fast = await freshClient(pqc.init)
    gate.resolve()
    const slow = await slowCall
    expectSameClient(slow, fast.client, false)

    const [fastValidate, slowValidate] = spyOnValidate(fast.module, slowModule)
    pqc.secretKeyValidate(SK)
    expect(fastValidate).toHaveBeenCalledTimes(1)
    expect(slowValidate).not.toHaveBeenCalled()
  })

  it('keeps the published client when a later call fails', async () => {
    const pqc = await freshPqc()
    const first = await freshClient(pqc.init)

    expectFactoryFailure(pqc, await rejection(pqc.init({ createModule: failingFactory })))

    expect(pqc.isInitialized()).toBe(true)
    expectSameClient(await pqc.ready(), first.client)
    const [validate] = spyOnValidate(first.module)
    pqc.secretKeyValidate(SK)
    expect(validate).toHaveBeenCalledTimes(1)
  })

  it('publishes an earlier call that succeeds when the newer call fails', async () => {
    const pqc = await freshPqc()
    const gate = deferred()
    const slowCall = pqc.init({
      createModule: async options => {
        await gate.promise
        return createPqcModule(options)
      },
    })
    expectFactoryFailure(pqc, await rejection(pqc.init({ createModule: failingFactory })))
    expect(pqc.isInitialized()).toBe(false)

    gate.resolve()
    const slow = await slowCall
    expectSameClient(await pqc.ready(), slow)
  })
})

describe('init() with the same options', () => {
  let dir: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'qbit-pqc-init-lifecycle-')))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('shares one load: distinct promises for the same client, and another for other options', async () => {
    const pqc = await freshPqc()
    const createModule = vi.fn((options?: PqcModuleOptions) => createPqcModule(options))
    const calls = [pqc.init({ createModule }), pqc.init({ createModule })]
    expect(calls[1] === calls[0]).toBe(false)

    const [first, second] = await Promise.all(calls)
    expectSameClient(second, first)
    expectSameClient(await pqc.init({ createModule }), first)
    expect(createModule).toHaveBeenCalledTimes(1)

    const firstModule = await createModule.mock.results[0]!.value
    const other = await freshClient(pqc.init)
    expectSameClient(other.client, first, false)
    expect(other.module === firstModule).toBe(false)
    const wasmBinary = readFileSync(join(wasmDir, 'pqc.wasm'))
    const fromBytes = await pqc.init({ wasmBinary })
    expectSameClient(fromBytes, other.client, false)
    expectSameClient(await pqc.init({ wasmBinary }), fromBytes)
    expectSameClient(await pqc.init({ wasmBinary: readFileSync(join(wasmDir, 'pqc.wasm')) }), fromBytes, false)
  })

  it('treats init(), init(undefined) and init({}) as the same options', async () => {
    const pqc = await freshPqc()
    const client = await pqc.init()

    expectSameClient(await pqc.init(undefined), client)
    expectSameClient(await pqc.init({}), client)
  })

  it('treats a moduleUrl given as a URL and as a string as the same', async () => {
    copyFileSync(join(wasmDir, 'pqc.mjs'), join(dir, 'pqc.mjs'))
    copyFileSync(join(wasmDir, 'pqc.wasm'), join(dir, 'pqc.wasm'))
    const moduleUrl = pathToFileURL(join(dir, 'pqc.mjs'))
    const pqc = await freshPqc()
    const client = await pqc.init({ moduleUrl })

    expectSameClient(await pqc.init({ moduleUrl: moduleUrl.href }), client)
  })
})

describe('a failed init()', () => {
  it('is not shared: the next call with the same options loads again', async () => {
    const pqc = await freshPqc()
    let attempts = 0
    const createModule = vi.fn((options?: PqcModuleOptions) => {
      attempts += 1
      return attempts === 1 ? failingFactory() : createPqcModule(options)
    })

    expectFactoryFailure(pqc, await rejection(pqc.init({ createModule })))
    const second = await pqc.init({ createModule })
    expectSameClient(await pqc.init({ createModule }), second)
    expect(createModule).toHaveBeenCalledTimes(2)
  })

  it("leaves a newer call's load shared", async () => {
    const pqc = await freshPqc()
    const gate = deferred()
    const failing = pqc.init({
      createModule: async () => {
        await gate.promise
        throw new Error('late failure')
      },
    })
    const createModule = vi.fn((options?: PqcModuleOptions) => createPqcModule(options))
    const newer = await pqc.init({ createModule })

    gate.resolve()
    expectFactoryFailure(pqc, await rejection(failing), 'late failure')
    expectSameClient(await pqc.init({ createModule }), newer)
    expect(createModule).toHaveBeenCalledTimes(1)
  })
})

describe('the named exports before a client is published', () => {
  function expectNotInitialized(pqc: PqcExports, operation: string, call: () => unknown): void {
    let error: unknown
    try {
      call()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(pqc.PqcError)
    expect(error).toMatchObject({
      name: 'PqcError',
      kind: 'NOT_INITIALIZED',
      operation,
      code: 0,
      nativeName: undefined,
      message: `@qbit-oss/pqc init() must be awaited before calling ${operation}()`,
    })
  }

  function expectEveryExportNotInitialized(pqc: PqcExports): void {
    const bytes = new Uint8Array(32)
    expectNotInitialized(pqc, 'keygen', () => pqc.keygen(new Uint8Array(128)))
    expectNotInitialized(pqc, 'derivePQCKey', () => pqc.derivePQCKey(bytes, 0, 0, 0))
    expectNotInitialized(pqc, 'deriveP2mrDescriptorKey', () => pqc.deriveP2mrDescriptorKey(bytes, 0))
    expectNotInitialized(pqc, 'sign', () => pqc.sign(SK, bytes))
    expectNotInitialized(pqc, 'signWithStats', () => pqc.signWithStats(SK, bytes))
    expectNotInitialized(pqc, 'verify', () => pqc.verify(bytes, bytes, bytes))
    expectNotInitialized(pqc, 'secretKeyValidate', () => pqc.secretKeyValidate(SK))
  }

  it("throw a PqcError of kind 'NOT_INITIALIZED' before init()", async () => {
    const pqc = await freshPqc()
    expectEveryExportNotInitialized(pqc)
  })

  it('still throw it after a failed first init()', async () => {
    const pqc = await freshPqc()
    expectFactoryFailure(pqc, await rejection(pqc.init({ createModule: failingFactory })))
    expectEveryExportNotInitialized(pqc)
  })
})

describe('isInitialized() and ready()', () => {
  it('wait for the first published client, across a failed init()', async () => {
    const pqc = await freshPqc()
    expect(pqc.isInitialized()).toBe(false)
    let settled = false
    const waiting = pqc.ready().then(client => {
      settled = true
      return client
    })

    expectFactoryFailure(pqc, await rejection(pqc.init({ createModule: failingFactory })))
    await new Promise(resolveTick => setTimeout(resolveTick, 0))
    expect(settled).toBe(false)
    expect(pqc.isInitialized()).toBe(false)

    const client = await pqc.init()
    expect(pqc.isInitialized()).toBe(true)
    expectSameClient(await waiting, client)
  })

  it('ready() resolves with the client published last', async () => {
    const pqc = await freshPqc()
    await pqc.init()
    const newer = await pqc.init({ createModule: options => createPqcModule(options) })

    expectSameClient(await pqc.ready(), newer)
  })
})

describe('a load failure in Node', () => {
  let dir: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'qbit-pqc-init-lifecycle-')))
    copyFileSync(join(wasmDir, 'pqc.mjs'), join(dir, 'pqc.mjs'))
    // Emscripten logs the failure before it rejects.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects with a PqcLoadError naming the missing pqc.wasm', async () => {
    const pqc = await freshPqc()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const error = await rejection(pqc.init({ moduleUrl: pathToFileURL(join(dir, 'pqc.mjs')) }))

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toBeInstanceOf(pqc.PqcError)
    expect(error).toMatchObject({
      name: 'PqcLoadError',
      kind: 'LOAD_FAILED',
      operation: 'init',
      code: 0,
      nativeName: undefined,
      url: `${dir}/pqc.wasm`,
      status: undefined,
    })
    // The original failure: Emscripten's abort, which names the file only in
    // its message. The PqcLoadError's message repeats it.
    const { cause } = error as Pqc.PqcLoadError
    expect(cause).toBeInstanceOf(Error)
    expect(String(cause)).toContain(`${dir}/pqc.wasm`)
    expect((error as Error).message).toBe(`init() could not load ${dir}/pqc.wasm: ${(cause as Error).message}`)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects with a PqcLoadError naming a moduleUrl that cannot be imported', async () => {
    const pqc = await freshPqc()
    const moduleUrl = pathToFileURL(join(dir, 'missing.mjs'))

    const error = await rejection(pqc.init({ moduleUrl }))

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({ kind: 'LOAD_FAILED', url: moduleUrl.href, status: undefined })
    expect((error as Pqc.PqcLoadError).cause).toBeInstanceOf(Error)
  })

  it('rejects with a PqcLoadError naming a moduleUrl that exports no factory', async () => {
    writeFileSync(join(dir, 'other.mjs'), 'export default 42\n')
    const pqc = await freshPqc()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const moduleUrl = pathToFileURL(join(dir, 'other.mjs'))

    const error = await rejection(pqc.init({ moduleUrl }))

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({
      kind: 'LOAD_FAILED',
      url: moduleUrl.href,
      status: undefined,
      message: `init() could not load ${moduleUrl.href}: pqc wasm module did not export an Emscripten factory`,
    })
    expect((error as Pqc.PqcLoadError).cause).toBeInstanceOf(TypeError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not request an http(s) URL again for its status', async () => {
    const pqc = await freshPqc()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const url = 'https://cdn.example/pqc/pqc.wasm'

    const error = await rejection(pqc.init({ locateFile: () => url }))

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({ url, status: undefined })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('a load failure with no file to name', () => {
  beforeEach(() => {
    // Emscripten logs the failure before it rejects.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.doUnmock('../wasm/pqc.mjs')
  })

  it('rejects the default init() with a PqcLoadError when the embedded copy cannot compile', async () => {
    const pqc = await freshPqc()
    // How a browser refuses to compile under a CSP without 'wasm-unsafe-eval'.
    const refused = new WebAssembly.CompileError(
      'WebAssembly.instantiate(): Refused to compile or instantiate WebAssembly module ' +
        "because 'unsafe-eval' is not an allowed source of script"
    )
    const instantiate = vi.spyOn(WebAssembly, 'instantiate').mockRejectedValue(refused)

    const error = await rejection(pqc.init())

    expect(instantiate).toHaveBeenCalledTimes(1)
    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({
      name: 'PqcLoadError',
      kind: 'LOAD_FAILED',
      operation: 'init',
      code: 0,
      url: undefined,
      status: undefined,
    })
    // Emscripten's abort, which names the refusal.
    const { cause } = error as Pqc.PqcLoadError
    expect(String(cause)).toContain('Refused to compile')
    expect((error as Error).message).toBe(`init() could not load the WASM module: ${(cause as Error).message}`)
  })

  it("rejects the default init() with a PqcLoadError when the package's loader cannot be imported", async () => {
    // As when a bundler's chunk for the loader is gone.
    vi.doMock('../wasm/pqc.mjs', () => {
      throw new Error('loader chunk missing')
    })
    const pqc = await freshPqc()

    const error = await rejection(pqc.init())

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({ kind: 'LOAD_FAILED', url: undefined, status: undefined })
    // The import's error, which vitest may wrap in one of its own.
    const cause = (error as Pqc.PqcLoadError).cause as Error
    expect((error as Error).message).toBe(`init() could not load the WASM module: ${cause.message}`)
    expect(String(cause.cause ?? cause)).toContain('loader chunk missing')
  })

  it('names a thrown string, or an error from another realm, in the message', async () => {
    const pqc = await freshPqc()
    const foreign: unknown = runInNewContext('new Error("not from this realm")')
    expect(foreign instanceof Error).toBe(false)

    for (const [thrown, reason] of [
      ['no wasm here', 'no wasm here'],
      [foreign, 'not from this realm'],
    ]) {
      const error = await rejection(pqc.init({ createModule: () => Promise.reject(thrown) }))
      expect(error).toBeInstanceOf(pqc.PqcLoadError)
      expect((error as Error).message).toBe(`init() could not load the WASM module: ${reason}`)
      expect((error as Pqc.PqcLoadError).cause).toBe(thrown)
    }
  })

  it('rejects with a PqcLoadError when the module does not match this version of the package', async () => {
    const pqc = await freshPqc()
    const module = await createPqcModule()
    vi.spyOn(module, '_qbit_pqc_public_key_size').mockReturnValue(0)

    const error = await rejection(pqc.init({ createModule: async () => module }))

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({
      url: undefined,
      message:
        'init() could not load the WASM module: ' + 'pqc wasm public-key size does not match TypeScript constants',
    })
    expect(pqc.isInitialized()).toBe(false)
  })

  it('passes a PqcLoadError from the factory through unchanged', async () => {
    const pqc = await freshPqc()
    const inner = new pqc.PqcLoadError('https://cdn.example/pqc/pqc.wasm', 404)

    expect(await rejection(pqc.init({ createModule: () => Promise.reject(inner) }))).toBe(inner)
  })
})

// Outside Node, init() requests a failed http(s) or chrome-extension: URL once
// more, only to read an error status. These tests evaluate src/core.ts again
// with `process` shadowed in the module, so it takes that path, and with fetch
// stubbed.
describe('the status of a failed load outside Node', () => {
  let copies = 0

  async function browserPqc(): Promise<
    PqcExports & { errorResponseStatus(url: string, base?: string): Promise<number | undefined> }
  > {
    const source = readFileSync(new URL('../src/core.ts', import.meta.url), 'utf8')
    copies += 1
    const { outputText } = ts.transpileModule(
      `const process = undefined\n${source}\nexport { errorResponseStatus }\n// copy ${copies}\n`,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }
    )
    const url = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
    return import(/* @vite-ignore */ url)
  }

  // A factory that fails the way Emscripten's does when it cannot load the
  // pqc.wasm its locateFile names.
  function failingLoad(prefix: string, cause: Error): Pqc.PqcWasmModuleFactory {
    return async options => {
      options?.locateFile?.('pqc.wasm', prefix)
      throw cause
    }
  }

  const cause = new Error('Aborted(both async and sync fetching of the wasm failed)')
  const located = (path: string, prefix: string) => prefix + path

  it('reports the HTTP status of an error response, from one GET', async () => {
    const fetchStub = vi.fn(async () => new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', fetchStub)
    const pqc = await browserPqc()

    const error = await rejection(
      pqc.init({ createModule: failingLoad('https://cdn.example/pqc/', cause), locateFile: located })
    )

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({
      kind: 'LOAD_FAILED',
      url: 'https://cdn.example/pqc/pqc.wasm',
      status: 404,
      message:
        'init() could not load https://cdn.example/pqc/pqc.wasm (HTTP 404): ' +
        'Aborted(both async and sync fetching of the wasm failed)',
    })
    expect((error as Pqc.PqcLoadError).cause).toBe(cause)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [target, request] = fetchStub.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(target)).toBe('https://cdn.example/pqc/pqc.wasm')
    expect(request.credentials).toBe('same-origin')
    expect(request.method).toBeUndefined()
    expect(request.signal).toBeInstanceOf(AbortSignal)
  })

  it('leaves the status undefined for a 2xx response, and cancels its body', async () => {
    const cancel = vi.fn()
    const fetchStub = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const pqc = await browserPqc()

    const error = await rejection(
      pqc.init({ createModule: failingLoad('https://cdn.example/pqc/', cause), locateFile: located })
    )

    expect(error).toMatchObject({ kind: 'LOAD_FAILED', status: undefined })
    expect((error as Pqc.PqcLoadError).cause).toBe(cause)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('gives up on a request that hangs after 10 s, keeping the original error', async () => {
    const pqc = await browserPqc()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchStub = vi.fn(
      (_target: URL, request: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason))
        })
    )
    vi.stubGlobal('fetch', fetchStub)

    let settled: unknown
    const failed = pqc.init({ createModule: failingLoad('https://cdn.example/pqc/', cause), locateFile: located }).then(
      () => undefined,
      (reason: unknown) => {
        settled = reason
      }
    )
    await vi.advanceTimersByTimeAsync(9999)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(settled).toBeInstanceOf(pqc.PqcLoadError)
    expect(settled).toMatchObject({ status: undefined })
    expect((settled as Pqc.PqcLoadError).cause).toBe(cause)
  })

  it('asks only http(s) and chrome-extension: URLs', async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetchStub)
    const pqc = await browserPqc()

    expect(await pqc.errorResponseStatus('file:///srv/pqc/pqc.wasm')).toBeUndefined()
    // A path, with no page to resolve it against.
    expect(await pqc.errorResponseStatus('/srv/pqc/pqc.wasm')).toBeUndefined()
    expect(await pqc.errorResponseStatus('data:application/wasm;base64,AGFzbQ==')).toBeUndefined()
    expect(fetchStub).not.toHaveBeenCalled()

    expect(await pqc.errorResponseStatus('http://localhost:8080/pqc.wasm')).toBe(403)
    expect(await pqc.errorResponseStatus('chrome-extension://abcdef/wasm/pqc.wasm')).toBe(403)
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })

  it('resolves a relative pqc.wasm location against the page, as the loader does', async () => {
    const fetchStub = vi.fn(async () => new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('location', { href: 'https://app.example/wallet/index.html' })
    const pqc = await browserPqc()

    const error = await rejection(
      pqc.init({ createModule: failingLoad('', cause), locateFile: () => '/nope/pqc.wasm' })
    )

    expect(error).toMatchObject({ url: '/nope/pqc.wasm', status: 404 })
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(String((fetchStub.mock.calls[0] as unknown as [URL])[0])).toBe('https://app.example/nope/pqc.wasm')
  })

  it('requests nothing when the loader had the bytes and they failed to compile', async () => {
    const fetchStub = vi.fn(async () => new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', fetchStub)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const pqc = await browserPqc()

    // The loader asks where pqc.wasm is even with the bytes, but loads nothing.
    const error = await rejection(
      pqc.init({
        createModule: createPqcModule,
        wasmBinary: new Uint8Array([0, 1, 2, 3]),
        locateFile: () => 'https://cdn.example/pqc/pqc.wasm',
      })
    )

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({ kind: 'LOAD_FAILED', url: undefined, status: undefined })
    expect(String((error as Pqc.PqcLoadError).cause)).toContain('CompileError')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('asks for an absolute moduleUrl that failed to import, never a relative one', async () => {
    const fetchStub = vi.fn(async () => new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('location', { href: 'https://app.example/wallet/index.html' })
    const pqc = await browserPqc()

    // import() resolves this against the module, not the page, so a request
    // for it against the page could report another file's status.
    const relative = await rejection(pqc.init({ moduleUrl: './missing/pqc.mjs' }))
    expect(relative).toBeInstanceOf(pqc.PqcLoadError)
    expect(relative).toMatchObject({ url: './missing/pqc.mjs', status: undefined })
    expect(fetchStub).not.toHaveBeenCalled()

    const absolute = await rejection(pqc.init({ moduleUrl: 'https://cdn.example/missing/pqc.mjs' }))
    expect(absolute).toMatchObject({ url: 'https://cdn.example/missing/pqc.mjs', status: 404 })
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('leaves the status undefined when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
    )
    const pqc = await browserPqc()

    expect(await pqc.errorResponseStatus('chrome-extension://abcdef/wasm/pqc.wasm')).toBeUndefined()
  })
})
