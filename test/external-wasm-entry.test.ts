import { createHash } from 'node:crypto'
import fs, { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as Pqc from '../src/core'
import createPqcModule from '../wasm/pqc.mjs'

type PqcExports = typeof Pqc

const wasmDir = fileURLToPath(new URL('../wasm/', import.meta.url))
const pinnedWasmSha256 = /^([0-9a-f]{64}) {2}pqc\.wasm$/m.exec(readFileSync(join(wasmDir, 'SHA256SUMS'), 'utf8'))?.[1]
const SK = new Uint8Array(64)

// Both entries of a copy of the package with no init() called yet: "." (src/index.ts, built as lib/index.mjs)
// and "./external-wasm" (src/external-wasm.ts, built as lib/external-wasm.mjs), which "." imports, each over
// src/core.ts, built as lib/core.mjs.
async function freshEntries(): Promise<{ embedded: PqcExports; external: PqcExports }> {
  vi.resetModules()
  const external = (await import('../src/external-wasm')) as PqcExports
  const embedded = (await import('../src/index')) as PqcExports
  return { embedded, external }
}

function sha256(source: unknown): string {
  return createHash('sha256')
    .update(source as Uint8Array)
    .digest('hex')
}

function wasmFilesRead(readFileSyncSpy: { mock: { calls: unknown[][] } }): string[] {
  return readFileSyncSpy.mock.calls.map(([path]) => String(path)).filter(path => path.endsWith('.wasm'))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

// Clients compared by identity, so a failure does not print two WASM heaps.
function expectSameClient(actual: unknown, expected: unknown, same = true): void {
  expect(actual === expected, same ? 'the same client' : 'another client').toBe(same)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the "." and "./external-wasm" entries', () => {
  it('export the same names, and every one but init is the same object', async () => {
    const { embedded, external } = await freshEntries()

    expect(Object.keys(embedded).sort()).toEqual(Object.keys(external).sort())
    for (const name of Object.keys(external)) {
      if (name !== 'init') {
        expect(embedded[name as keyof PqcExports], name).toBe(external[name as keyof PqcExports])
      }
    }
    expect(embedded.init).not.toBe(external.init)
  })

  it('share one published client: init() through one entry serves the named exports and ready() of the other', async () => {
    const { embedded, external } = await freshEntries()
    const waiting = external.ready()

    const client = await embedded.init()

    expect(external.isInitialized()).toBe(true)
    expectSameClient(await waiting, client)
    expectSameClient(await external.ready(), client)
    expect(external.secretKeyValidate(SK)).toBe(embedded.secretKeyValidate(SK))

    const other = await external.init({ createModule: options => createPqcModule(options) })
    expectSameClient(await embedded.ready(), other)
  })

  it('raise errors of one class: a PqcError from either entry is an instance of both', async () => {
    const { embedded, external } = await freshEntries()

    let thrown: unknown
    try {
      embedded.sign(SK, new Uint8Array(32))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(external.PqcError)
    expect(thrown).toMatchObject({ kind: 'NOT_INITIALIZED' })

    const failed = await external.init({ createModule: () => Promise.reject(new Error('no module')) }).catch(e => e)
    expect(failed).toBeInstanceOf(embedded.PqcLoadError)
    expect(failed).toBeInstanceOf(embedded.PqcError)
  })

  it('publish the newest successful call across entries, even when an earlier call settles later', async () => {
    const { embedded, external } = await freshEntries()
    const gate = deferred()
    let slowModule: Pqc.PqcWasmModule | undefined
    const slowCall = external.init({
      createModule: async options => {
        await gate.promise
        return (slowModule = await createPqcModule(options))
      },
    })
    let fastModule: Pqc.PqcWasmModule | undefined
    const fast = await embedded.init({ createModule: async options => (fastModule = await createPqcModule(options)) })
    gate.resolve()
    const slow = await slowCall
    expectSameClient(slow, fast, false)

    expectSameClient(await external.ready(), fast)
    const fastValidate = vi.spyOn(fastModule!, '_qbit_pqc_secret_key_validate')
    const slowValidate = vi.spyOn(slowModule!, '_qbit_pqc_secret_key_validate')
    external.secretKeyValidate(SK)
    embedded.secretKeyValidate(SK)
    expect(fastValidate).toHaveBeenCalledTimes(2)
    expect(slowValidate).not.toHaveBeenCalled()
  })

  it('keep the published client when a call through the other entry fails, and resolve ready() once', async () => {
    const { embedded, external } = await freshEntries()
    const waiting = embedded.ready()
    const first = await external.init({ createModule: options => createPqcModule(options) })

    const failed = await embedded.init({ createModule: () => Promise.reject(new Error('no module')) }).catch(e => e)

    expect(failed).toBeInstanceOf(external.PqcLoadError)
    expectSameClient(await waiting, first)
    expectSameClient(await embedded.ready(), first)
    expectSameClient(await external.ready(), first)
  })

  it('share a load when the options name where pqc.wasm is, and load separately when "." would use its copy', async () => {
    const { embedded, external } = await freshEntries()
    const locateFile = () => undefined

    const [viaEmbedded, viaExternal] = await Promise.all([embedded.init({ locateFile }), external.init({ locateFile })])
    expectSameClient(viaEmbedded, viaExternal)

    const defaults = await embedded.init()
    expectSameClient(await external.init(), defaults, false)
  })
})

describe('init() options', () => {
  it('are read once per call through either entry, so the shared load, the bytes and the load agree', async () => {
    const { embedded, external } = await freshEntries()
    for (const init of [embedded.init, external.init]) {
      const reads: string[] = []
      const createModule: Pqc.PqcWasmModuleFactory = options => createPqcModule(options)
      const values: Record<string, unknown> = { createModule }
      const options = {}
      for (const name of ['moduleUrl', 'createModule', 'locateFile', 'wasmBinary', 'expectedWasmSha256']) {
        Object.defineProperty(options, name, {
          enumerable: true,
          get() {
            reads.push(name)
            return values[name]
          },
        })
      }

      await init(options)

      expect(reads.sort()).toEqual(['createModule', 'expectedWasmSha256', 'locateFile', 'moduleUrl', 'wasmBinary'])
    }
  })
})

describe('a nullish wasmBinary', () => {
  it('passes no bytes: "." compiles its embedded copy and "./external-wasm" reads the file, as in 0.1.0', async () => {
    const { embedded, external } = await freshEntries()
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')

    const viaEmbedded = await embedded.init({ wasmBinary: null as never })
    expect(wasmFilesRead(readFileSyncSpy)).toEqual([])
    expectSameClient(await embedded.init({ wasmBinary: undefined }), viaEmbedded)
    const viaExternal = await external.init({ wasmBinary: null as never })
    expect(wasmFilesRead(readFileSyncSpy).map(path => fileURLToPath(path))).toEqual([join(wasmDir, 'pqc.wasm')])
    expectSameClient(viaExternal, viaEmbedded, false)

    expect(instantiate.mock.calls.map(([source]) => sha256(source))).toEqual([pinnedWasmSha256, pinnedWasmSha256])
  })
})

describe('the "./external-wasm" entry\'s init()', () => {
  it("loads the package's wasm/pqc.wasm file, the binary wasm/SHA256SUMS pins", async () => {
    const { external } = await freshEntries()
    expect(pinnedWasmSha256).toMatch(/^[0-9a-f]{64}$/)
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')

    await external.init()

    expect(instantiate.mock.calls.map(([source]) => sha256(source))).toEqual([pinnedWasmSha256])
    expect(wasmFilesRead(readFileSyncSpy).map(path => fileURLToPath(path))).toEqual([join(wasmDir, 'pqc.wasm')])
  })

  it('passes no wasmBinary to a createModule without locateFile, which loads the file', async () => {
    const { external } = await freshEntries()
    const received: Pqc.PqcWasmModuleOptions[] = []
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')

    await external.init({
      createModule: options => {
        received.push({ ...options })
        return createPqcModule(options)
      },
    })

    expect(received.map(options => options.wasmBinary)).toEqual([undefined])
    expect(wasmFilesRead(readFileSyncSpy).map(path => fileURLToPath(path))).toEqual([join(wasmDir, 'pqc.wasm')])
  })

  it('names the package file in a PqcLoadError when it cannot compile', async () => {
    const { external } = await freshEntries()
    const refused = new WebAssembly.CompileError('refused')
    vi.spyOn(WebAssembly, 'instantiate').mockRejectedValue(refused)

    const error = await external.init().catch(e => e)

    expect(error).toBeInstanceOf(external.PqcLoadError)
    expect(error).toMatchObject({ kind: 'LOAD_FAILED', status: undefined })
    expect(fileURLToPath((error as Pqc.PqcLoadError).url!)).toBe(join(wasmDir, 'pqc.wasm'))
  })
})
