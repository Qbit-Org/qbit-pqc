import { createHash } from 'node:crypto'
import fs, { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import goldenFixture from '../fixtures/slh-dsa-golden.json'
import type * as Pqc from '../src/index'
import { pinnedWasmSha256 } from '../scripts/wasm-sha256.mjs'
import createPqcModule from '../wasm/pqc.mjs'

type PqcExports = typeof Pqc
type PqcModuleOptions = Pqc.PqcWasmModuleOptions

const wasmDir = fileURLToPath(new URL('../wasm/', import.meta.url))
const pinnedWasm = readFileSync(join(wasmDir, 'pqc.wasm'))

// Copies of pqc.wasm carry this custom section, which the shipped file lacks:
// a module that compiles and runs like pqc.wasm, with another SHA-256.
const COPY_MARKER = 'qbit-pqc-test-copy'

function markedWasm(): Buffer {
  const name = Buffer.from(COPY_MARKER)
  // Section id 0 (custom), then the section size and the name length, each a
  // one-byte LEB128 value while the name is shorter than 127 bytes.
  return Buffer.concat([pinnedWasm, Uint8Array.of(0, name.length + 1, name.length), name])
}

function sha256(source: unknown): string {
  return createHash('sha256')
    .update(source as Uint8Array)
    .digest('hex')
}

const pinnedSha256 = sha256(pinnedWasm)
const markedSha256 = sha256(markedWasm())

// A copy of the package with no init() called yet, so no load is shared with
// another test.
async function freshPqc(): Promise<PqcExports> {
  vi.resetModules()
  return (await import('../src/index')) as PqcExports
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  // Not `rejects`: a client that loaded by mistake would be printed, WASM heap
  // and all.
  return promise.then(
    () => undefined,
    (reason: unknown) => reason
  )
}

// Node 20 and 22 (undici 6) compile undici's own llhttp parser with
// WebAssembly.compile when the fetch globals first load, then instantiate the
// Module; Node 24's undici builds it synchronously. Loading them here, before
// any test spies on WebAssembly, keeps that compile out of the counts below.
void Response

// Every way bytes become WebAssembly code, and the digests of the bytes each
// compiled; a streamed source, which cannot be hashed here, counts as
// 'streamed'. WebAssembly.instantiate given a Module compiles nothing new, so
// those calls are left out: only undici instantiates one, never the loader.
function spyOnCompile(): () => string[] {
  const spies = [
    vi.spyOn(WebAssembly, 'compile'),
    vi.spyOn(WebAssembly, 'instantiate'),
    vi.spyOn(WebAssembly, 'compileStreaming'),
    vi.spyOn(WebAssembly, 'instantiateStreaming'),
  ]
  const streamed = new Set<unknown>([spies[2], spies[3]])
  return () =>
    spies.flatMap(spy =>
      spy.mock.calls
        .map(([source]) => source)
        .filter(source => !(source instanceof WebAssembly.Module))
        .map(source => (streamed.has(spy) ? 'streamed' : sha256(source)))
    )
}

// What a factory was called with, copied at the call.
function recordingFactory(): { createModule: Pqc.PqcWasmModuleFactory; calls: PqcModuleOptions[] } {
  const calls: PqcModuleOptions[] = []
  return {
    calls,
    createModule: options => {
      calls.push({ ...options })
      return createPqcModule(options)
    },
  }
}

function expectGoldenKeygen(client: Pqc.PqcClient): void {
  const vector = goldenFixture.vectors[0]!
  const entropy = new Uint8Array(128)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (vector.seedByte + ((i * 37) % 256)) & 0xff
  }
  expect(Buffer.from(client.keygen(entropy).publicKey).toString('hex')).toBe(vector.publicKeyHex)
}

function expectMismatch(
  pqc: PqcExports,
  error: unknown,
  { url, actual, expected }: { url: string | undefined; actual: string; expected: string }
): void {
  expect(error).toBeInstanceOf(pqc.PqcLoadError)
  expect(error).toMatchObject({
    name: 'PqcLoadError',
    kind: 'LOAD_FAILED',
    code: 0,
    url,
    status: undefined,
    message:
      `init() could not load ${url ?? 'the WASM module'}: ` +
      `SHA-256 ${actual} does not match expectedWasmSha256 ${expected}`,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('constants.WASM_SHA256', () => {
  it('is the pqc.wasm digest that wasm/SHA256SUMS pins', async () => {
    const { constants } = await freshPqc()
    const sums = readFileSync(join(wasmDir, 'SHA256SUMS'), 'utf8')

    expect(constants.WASM_SHA256).toBe(/^([0-9a-f]{64}) {2}pqc\.wasm$/m.exec(sums)?.[1])
    expect(constants.WASM_SHA256).toBe(pinnedSha256)
  })

  describe('as the build reads it from wasm/SHA256SUMS', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'qbit-pqc-sha256sums-'))
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    function files(sums: string, wasm: Uint8Array): URL {
      writeFileSync(join(dir, 'SHA256SUMS'), sums)
      writeFileSync(join(dir, 'pqc.wasm'), wasm)
      return pathToFileURL(`${dir}/`)
    }

    it('is the pqc.wasm line, which must match wasm/pqc.wasm', () => {
      expect(pinnedWasmSha256()).toBe(pinnedSha256)
    })

    it('takes the directory as a path or a URL, with or without a trailing slash', () => {
      files(`${pinnedSha256}  pqc.wasm\n`, pinnedWasm)
      for (const form of [dir, `${dir}/`, pathToFileURL(dir), pathToFileURL(`${dir}/`)]) {
        expect(pinnedWasmSha256(form)).toBe(pinnedSha256)
      }
    })

    it("accepts CRLF line endings and sha256sum's binary mode", () => {
      expect(pinnedWasmSha256(files(`${'0'.repeat(64)}  pqc.mjs\r\n${pinnedSha256} *pqc.wasm\r\n`, pinnedWasm))).toBe(
        pinnedSha256
      )
    })

    it('fails without a pqc.wasm line', () => {
      expect(() => pinnedWasmSha256(files(`${pinnedSha256}  pqc.mjs\n`, pinnedWasm))).toThrow(
        `${join(dir, 'SHA256SUMS')} has no pqc.wasm line`
      )
    })

    it('fails when pqc.wasm has another digest', () => {
      expect(() => pinnedWasmSha256(files(`${pinnedSha256}  pqc.wasm\n`, markedWasm()))).toThrow(
        `${join(dir, 'pqc.wasm')} has SHA-256 ${markedSha256}, but ${join(dir, 'SHA256SUMS')} pins ${pinnedSha256}`
      )
    })
  })
})

describe('init({ expectedWasmSha256 })', () => {
  let dir: string

  beforeEach(() => {
    // Resolve symlinks (macOS's /var -> /private/var) so paths compare as the
    // loader reports them.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'qbit-pqc-expected-wasm-sha256-')))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // A directory with the loader and the given pqc.wasm, as an app serves them.
  function servedCopy(wasm: Uint8Array): { moduleUrl: URL; wasmPath: string } {
    copyFileSync(join(wasmDir, 'pqc.mjs'), join(dir, 'pqc.mjs'))
    writeFileSync(join(dir, 'pqc.wasm'), wasm)
    return { moduleUrl: pathToFileURL(join(dir, 'pqc.mjs')), wasmPath: join(dir, 'pqc.wasm') }
  }

  // Each way init() gets the bytes, given pqc.wasm, the bytes that the caller
  // passes or that are served, and the location of the file, if one is read.
  // `embedded` loads the copy in the package, whatever the bytes.
  const paths: {
    name: string
    embedded?: boolean
    options(wasm: Buffer): { options: Pqc.InitOptions; url?: string }
  }[] = [
    { name: 'the embedded copy', embedded: true, options: () => ({ options: {} }) },
    { name: 'wasmBinary as a Uint8Array', options: wasm => ({ options: { wasmBinary: wasm } }) },
    {
      name: 'wasmBinary as an ArrayBuffer',
      options: wasm => ({ options: { wasmBinary: new Uint8Array(wasm).buffer } }),
    },
    {
      name: 'wasmBinary as a view at an offset',
      options: wasm => {
        const padded = new Uint8Array(wasm.length + 16)
        padded.set(wasm, 8)
        return { options: { wasmBinary: padded.subarray(8, 8 + wasm.length) } }
      },
    },
    {
      name: 'moduleUrl',
      options: wasm => {
        const { moduleUrl, wasmPath } = servedCopy(wasm)
        return { options: { moduleUrl }, url: wasmPath }
      },
    },
    {
      name: 'locateFile returning a path',
      options: wasm => {
        const { wasmPath } = servedCopy(wasm)
        return { options: { locateFile: () => wasmPath }, url: wasmPath }
      },
    },
    {
      name: 'locateFile returning a file: URL',
      options: wasm => {
        const url = pathToFileURL(servedCopy(wasm).wasmPath).href
        return { options: { locateFile: () => url }, url }
      },
    },
    {
      name: 'createModule and locateFile, as in an MV3 service worker',
      options: wasm => {
        const { wasmPath } = servedCopy(wasm)
        return { options: { createModule: createPqcModule, locateFile: () => wasmPath }, url: wasmPath }
      },
    },
    {
      name: 'createModule without locateFile',
      embedded: true,
      options: () => ({ options: { createModule: createPqcModule } }),
    },
  ]

  describe.each(paths)('through $name', ({ embedded = false, options }) => {
    it('compiles the bytes when they have the digest', async () => {
      const pqc = await freshPqc()
      const compiled = spyOnCompile()
      const load = options(pinnedWasm)

      expectGoldenKeygen(await pqc.init({ ...load.options, expectedWasmSha256: pqc.constants.WASM_SHA256 }))

      expect(compiled()).toEqual([pinnedSha256])
    })

    it('rejects other bytes before compiling them', async () => {
      const pqc = await freshPqc()
      const compiled = spyOnCompile()
      const load = options(markedWasm())
      // The embedded copy cannot be swapped here, so it is checked against
      // another digest instead.
      const expected = embedded ? markedSha256 : pinnedSha256
      const actual = embedded ? pinnedSha256 : markedSha256

      const error = await rejection(pqc.init({ ...load.options, expectedWasmSha256: expected }))

      expectMismatch(pqc, error, { url: load.url, actual, expected })
      expect(compiled()).toEqual([])
      expect(pqc.isInitialized()).toBe(false)
    })
  })

  it('follows a symlinked moduleUrl to the real loader, and reads the pqc.wasm beside that', async () => {
    const pqc = await freshPqc()
    // A copy with another digest beside the symlink, which the real loader
    // never looks at.
    symlinkSync(join(wasmDir, 'pqc.mjs'), join(dir, 'pqc.mjs'))
    writeFileSync(join(dir, 'pqc.wasm'), markedWasm())
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')
    const compiled = spyOnCompile()

    expectGoldenKeygen(
      await pqc.init({ moduleUrl: pathToFileURL(join(dir, 'pqc.mjs')), expectedWasmSha256: pinnedSha256 })
    )

    const wasmReads = readFileSyncSpy.mock.calls.map(([path]) => String(path)).filter(path => path.endsWith('.wasm'))
    expect(wasmReads).toEqual([join(dirname(realpathSync(join(wasmDir, 'pqc.mjs'))), 'pqc.wasm')])
    expect(compiled()).toEqual([pinnedSha256])
  })

  it('reads a located file once, and passes the factory its bytes', async () => {
    const pqc = await freshPqc()
    const { moduleUrl } = servedCopy(pinnedWasm)
    const elsewhere = join(dir, 'elsewhere.wasm')
    writeFileSync(elsewhere, pinnedWasm)
    const locateFile = vi.fn((_path: string, _prefix: string) => elsewhere)
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')
    const compiled = spyOnCompile()

    await pqc.init({ moduleUrl, locateFile, expectedWasmSha256: pqc.constants.WASM_SHA256 })

    // With the prefix the loader would pass, the directory of moduleUrl, as
    // without the option.
    expect(locateFile.mock.calls).toEqual([['pqc.wasm', `${dir}/`]])
    const wasmReads = readFileSyncSpy.mock.calls.map(([path]) => String(path)).filter(path => path.endsWith('.wasm'))
    expect(wasmReads).toEqual([elsewhere])
    expect(compiled()).toEqual([pinnedSha256])
  })

  it("calls createModule once with the checked bytes, and locateFile with the package's wasm directory", async () => {
    const pqc = await freshPqc()
    const { wasmPath } = servedCopy(pinnedWasm)
    const { createModule, calls } = recordingFactory()
    const locateFile = vi.fn((_path: string, _prefix: string) => wasmPath)

    await pqc.init({ createModule, locateFile, expectedWasmSha256: pqc.constants.WASM_SHA256 })

    expect(locateFile.mock.calls).toEqual([['pqc.wasm', wasmDir]])
    expect(calls.map(options => options.wasmBinary && sha256(options.wasmBinary))).toEqual([pinnedSha256])

    // The same glue intrinsics as a load without the option.
    const unchecked = recordingFactory()
    await pqc.init({ createModule: unchecked.createModule })
    expect(calls[0]?.qbitPqcIntrinsics).toBeTypeOf('object')
    expect(calls[0]?.qbitPqcIntrinsics).toBe(unchecked.calls[0]?.qbitPqcIntrinsics)
  })

  it("answers the factory's locateFile for pqc.wasm with the file read, and for another file as before", async () => {
    const pqc = await freshPqc()
    const { wasmPath } = servedCopy(pinnedWasm)
    const locateFile = vi.fn((path: string, _prefix: string) => (path === 'pqc.wasm' ? wasmPath : undefined))
    const answers: unknown[] = []

    await pqc.init({
      createModule: options => {
        answers.push(options?.locateFile?.('pqc.wasm', 'ignored/'), options?.locateFile?.('pqc.data', 'loader/'))
        return createPqcModule(options)
      },
      locateFile,
      expectedWasmSha256: pinnedSha256,
    })

    // Without the option, a locateFile that returns undefined defers to the
    // package's directory.
    expect(answers).toEqual([wasmPath, pathToFileURL(join(wasmDir, 'pqc.data')).href])
    expect(locateFile.mock.calls).toEqual([
      ['pqc.wasm', wasmDir],
      ['pqc.data', 'loader/'],
    ])
  })

  it('does not call the factory when other bytes were passed', async () => {
    const pqc = await freshPqc()
    const { createModule, calls } = recordingFactory()

    const error = await rejection(
      pqc.init({ createModule, wasmBinary: markedWasm(), expectedWasmSha256: pqc.constants.WASM_SHA256 })
    )

    expectMismatch(pqc, error, { url: undefined, actual: markedSha256, expected: pinnedSha256 })
    expect(calls).toEqual([])
  })

  it('compiles the bytes it checked, even when the caller changes its buffer after the check', async () => {
    const pqc = await freshPqc()
    const wasmBinary = new Uint8Array(pinnedWasm).buffer
    const compiled = spyOnCompile()

    const client = await pqc.init({
      createModule: options => {
        new Uint8Array(wasmBinary).fill(0)
        return createPqcModule(options)
      },
      wasmBinary,
      expectedWasmSha256: pqc.constants.WASM_SHA256,
    })

    expectGoldenKeygen(client)
    expect(compiled()).toEqual([pinnedSha256])
  })

  it('names a located file that cannot be read, and compiles nothing', async () => {
    const pqc = await freshPqc()
    const missing = join(dir, 'missing.wasm')
    const compiled = spyOnCompile()

    const error = await rejection(pqc.init({ locateFile: () => missing, expectedWasmSha256: pinnedSha256 }))

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({ kind: 'LOAD_FAILED', url: missing, status: undefined })
    expect((error as Pqc.PqcLoadError).cause).toMatchObject({ code: 'ENOENT' })
    expect(compiled()).toEqual([])
  })

  it.each([
    ['an https: URL', 'https://cdn.example/pqc/pqc.wasm', 'https:'],
    ['a data: URL', 'data:application/wasm;base64,AGFzbQEAAAA=', 'data:'],
  ])('refuses %s in Node, naming its scheme', async (_name, url, scheme) => {
    const pqc = await freshPqc()
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')
    const compiled = spyOnCompile()

    const error = await rejection(pqc.init({ locateFile: () => url, expectedWasmSha256: pinnedSha256 }))

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    const reason = `URL scheme ${scheme} is not supported: in Node, init() reads pqc.wasm from a path or a file:// URL`
    expect(error).toMatchObject({
      kind: 'LOAD_FAILED',
      url,
      status: undefined,
      message: `init() could not load ${url}: ${reason}`,
    })
    expect((error as Pqc.PqcLoadError).cause).toEqual(new TypeError(reason))
    expect(readFileSyncSpy.mock.calls.filter(([path]) => String(path) === url)).toEqual([])
    expect(compiled()).toEqual([])
  })

  it('reads a relative path with a colon in its first segment as a path in Node', async () => {
    const pqc = await freshPqc()
    const path = 'build:v2/pqc.wasm'
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')

    const error = await rejection(pqc.init({ locateFile: () => path, expectedWasmSha256: pinnedSha256 }))

    // Tried as a path, relative to the working directory, which has no such file.
    expect(readFileSyncSpy.mock.calls.map(([target]) => target)).toContain(path)
    expect(error).toMatchObject({ url: path })
    expect((error as Pqc.PqcLoadError).cause).toMatchObject({ code: 'ENOENT' })
  })

  it('leaves url undefined when bytes it read and checked fail to compile', async () => {
    // Emscripten logs the failure before it rejects.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const pqc = await freshPqc()
    const notWasm = Buffer.from('not a WebAssembly module')
    const { wasmPath } = servedCopy(notWasm)

    const error = await rejection(pqc.init({ locateFile: () => wasmPath, expectedWasmSha256: sha256(notWasm) }))

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({ kind: 'LOAD_FAILED', url: undefined, status: undefined })
    expect(String((error as Pqc.PqcLoadError).cause)).toContain('CompileError')
  })

  // Factories that would load a file of their own, a copy with another digest,
  // if init() asked them where pqc.wasm is before it had checked the bytes.
  const wayward: [string, (markedPath: string) => Pqc.PqcWasmModuleFactory][] = [
    [
      'catches errors from locateFile',
      markedPath => options =>
        createPqcModule({
          ...options,
          locateFile: (path, prefix) => {
            try {
              return options?.locateFile?.(path, prefix) ?? markedPath
            } catch {
              return markedPath
            }
          },
        }),
    ],
    [
      'never calls locateFile',
      markedPath => options =>
        createPqcModule({
          locateFile: () => markedPath,
          ...(options?.wasmBinary === undefined ? {} : { wasmBinary: options.wasmBinary }),
        }),
    ],
    [
      'falls back on errors',
      markedPath => async options => {
        try {
          return await createPqcModule(options)
        } catch {
          return createPqcModule({ locateFile: () => markedPath })
        }
      },
    ],
  ]

  describe.each(wayward)('with a factory that %s', (_name, wayward) => {
    it('calls it once, with the checked bytes, and compiles nothing else', async () => {
      const pqc = await freshPqc()
      const { wasmPath } = servedCopy(pinnedWasm)
      const markedPath = join(dir, 'marked.wasm')
      writeFileSync(markedPath, markedWasm())
      const received: PqcModuleOptions[] = []
      const factory = wayward(markedPath)
      const createModule: Pqc.PqcWasmModuleFactory = options => {
        received.push({ ...options })
        return factory(options)
      }
      const compiled = spyOnCompile()

      expectGoldenKeygen(await pqc.init({ createModule, locateFile: () => wasmPath, expectedWasmSha256: pinnedSha256 }))

      expect(compiled()).toEqual([pinnedSha256])
      expect(received.map(options => options.wasmBinary && sha256(options.wasmBinary))).toEqual([pinnedSha256])
    })

    it('does not call it when the located file has another digest', async () => {
      const pqc = await freshPqc()
      const markedPath = join(dir, 'marked.wasm')
      writeFileSync(markedPath, markedWasm())
      const createModule = vi.fn(wayward(markedPath))
      const compiled = spyOnCompile()

      const error = await rejection(
        pqc.init({ createModule, locateFile: () => markedPath, expectedWasmSha256: pinnedSha256 })
      )

      expectMismatch(pqc, error, { url: markedPath, actual: markedSha256, expected: pinnedSha256 })
      expect(createModule).not.toHaveBeenCalled()
      expect(compiled()).toEqual([])
    })
  })

  it('reads the option once', async () => {
    const pqc = await freshPqc()
    let reads = 0
    const options = {
      wasmBinary: markedWasm(),
      get expectedWasmSha256() {
        reads += 1
        return reads === 1 ? pinnedSha256 : undefined
      },
    }

    const error = await rejection(pqc.init(options))

    expectMismatch(pqc, error, { url: undefined, actual: markedSha256, expected: pinnedSha256 })
    expect(reads).toBe(1)
  })
})

describe('an expectedWasmSha256 that is not 64 lowercase hex characters', () => {
  const invalid: [string, unknown][] = [
    ['an empty string', ''],
    ['uppercase hex', pinnedSha256.toUpperCase()],
    ['63 characters', pinnedSha256.slice(1)],
    ['65 characters', `${pinnedSha256}0`],
    ['a trailing newline', `${pinnedSha256}\n`],
    ['surrounding spaces', ` ${pinnedSha256.slice(2)} `],
    ['a non-hex character', `${pinnedSha256.slice(1)}g`],
    ['a 0x prefix', `0x${pinnedSha256.slice(2)}`],
    ['null', null],
    ['a number', 0],
    ['a String object', new String(pinnedSha256)],
    ['an array', [pinnedSha256]],
    ['an object that converts to the digest', { toString: () => pinnedSha256 }],
    ['the digest bytes', Buffer.from(pinnedSha256, 'hex')],
  ]

  it.each(invalid)('rejects %s with a TypeError before anything loads', async (_name, value) => {
    const pqc = await freshPqc()
    const createModule = vi.fn((options?: PqcModuleOptions) => createPqcModule(options))
    const compiled = spyOnCompile()

    for (const options of [{ createModule }, { moduleUrl: 'file:///nonexistent/pqc.mjs' }, {}]) {
      const error = await rejection(pqc.init({ ...options, expectedWasmSha256: value as string }))
      expect(error).toBeInstanceOf(TypeError)
      expect(error).toEqual(
        new TypeError('options.expectedWasmSha256 must be a SHA-256 digest in 64 lowercase hex characters')
      )
    }
    expect(createModule).not.toHaveBeenCalled()
    expect(compiled()).toEqual([])
    expect(pqc.isInitialized()).toBe(false)
  })
})

describe('init() with expectedWasmSha256 and otherwise the same options', () => {
  // Clients compared by identity, so a failure does not print two WASM heaps.
  function expectSameClient(actual: unknown, expected: unknown, same = true): void {
    expect(actual === expected, same ? 'the same client' : 'another client').toBe(same)
  }

  it('shares a load only with calls that pass the same digest', async () => {
    const pqc = await freshPqc()
    const createModule = vi.fn((options?: PqcModuleOptions) => createPqcModule(options))
    const checked = { createModule, expectedWasmSha256: pinnedSha256 }

    const first = await pqc.init(checked)
    expectSameClient(await pqc.init({ ...checked }), first)
    expect(createModule).toHaveBeenCalledTimes(1)

    expectSameClient(await pqc.init({ createModule }), first, false)
    expect(createModule).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a load made without the digest, or with another one', async () => {
    const pqc = await freshPqc()
    const createModule = vi.fn((options?: PqcModuleOptions) => createPqcModule(options))
    const wasmBinary = markedWasm()

    // Still loading when the checked calls start, and loaded by the time they
    // settle.
    const unchecked = pqc.init({ createModule, wasmBinary })
    const withPinned = rejection(pqc.init({ createModule, wasmBinary, expectedWasmSha256: pinnedSha256 }))
    expectGoldenKeygen(await unchecked)
    expectMismatch(pqc, await withPinned, { url: undefined, actual: markedSha256, expected: pinnedSha256 })

    const withMarked = await pqc.init({ createModule, wasmBinary, expectedWasmSha256: markedSha256 })
    expectSameClient(withMarked, await unchecked, false)
    const otherDigest = '0'.repeat(64)
    expectMismatch(pqc, await rejection(pqc.init({ createModule, wasmBinary, expectedWasmSha256: otherDigest })), {
      url: undefined,
      actual: markedSha256,
      expected: otherDigest,
    })
    // The unchecked load and the one with the matching digest.
    expect(createModule).toHaveBeenCalledTimes(2)
  })
})

describe('init() without expectedWasmSha256', () => {
  it('leaves loading pqc.wasm to the factory, and passes wasmBinary through as before', async () => {
    const pqc = await freshPqc()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')
    const wasmPath = join(wasmDir, 'pqc.wasm')
    const located = recordingFactory()

    await pqc.init({ createModule: located.createModule, locateFile: () => wasmPath })

    expect(located.calls).toHaveLength(1)
    expect(located.calls[0]).not.toHaveProperty('wasmBinary')
    const wasmReads = readFileSyncSpy.mock.calls.filter(([path]) => String(path).endsWith('.wasm'))
    expect(wasmReads).toHaveLength(1)

    const given = recordingFactory()
    const wasmBinary = markedWasm()
    await pqc.init({ createModule: given.createModule, wasmBinary })

    expect(given.calls.map(options => options.wasmBinary === wasmBinary)).toEqual([true])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// Outside Node, init() fetches a located pqc.wasm itself. These tests evaluate
// src/index.ts again with `process` shadowed in the module, as
// test/init-lifecycle.test.ts does, so it takes that path, and with fetch
// stubbed. The factory still runs in Node, with the fetched bytes.
let copies = 0

// src/index.ts evaluated again from a data: URL, which also exports
// loaderDirectory; outside Node, with `process` shadowed in the module. With
// `stubResolve`, import.meta.resolve is globalThis.__pqcTestResolve instead,
// and with `stubImport`, the import() of a moduleUrl loader is
// globalThis.__pqcTestImport: a data: module can resolve neither a bare nor a
// relative specifier. Both are textual replacements in the source, so they
// break silently if src/index.ts stops spelling these expressions exactly so;
// the assertions that the stubs were called guard against that.
async function transpiledPqc({
  browser,
  stubResolve = false,
  stubImport = false,
}: {
  browser: boolean
  stubResolve?: boolean
  stubImport?: boolean
}): Promise<PqcExports & { loaderDirectory(moduleUrl: string | URL | undefined): string }> {
  let source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  if (stubResolve) {
    // Code only: the error messages name import.meta.resolve too.
    source = source.replace(/import\.meta\.resolve(?=[ (])/g, 'globalThis.__pqcTestResolve')
  }
  if (stubImport) {
    source = source.replace('import(/* webpackIgnore: true */ url)', 'globalThis.__pqcTestImport(url)')
  }
  copies += 1
  const shadow = browser ? 'const process = undefined\n' : ''
  const { outputText } = ts.transpileModule(`${shadow}${source}\nexport { loaderDirectory }\n// copy ${copies}\n`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  })
  const url = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
  return import(/* @vite-ignore */ url)
}

// The prefix init() passes to locateFile with expectedWasmSha256 is the one
// Emscripten's factory passes: the directory of the loader's URL, as a path in
// Node, or '' when it has none. (A data: loader cannot run in Node, so these
// cases are not loaded end to end.)
describe('the directory of the moduleUrl loader', () => {
  // The package's loader, and its directory as Node's module resolution sees
  // it: the real path, symlinks followed.
  const loader = join(wasmDir, 'pqc.mjs')
  const loaderDir = `${dirname(realpathSync(loader))}/`

  it('is a file path in Node, and empty for a URL with no file directory', async () => {
    const { loaderDirectory } = await transpiledPqc({ browser: false })

    expect(loaderDirectory(pathToFileURL(loader))).toBe(loaderDir)
    expect(loaderDirectory(pathToFileURL(loader).href)).toBe(loaderDir)
    // A single-slash file: URL is absolute, not a bare specifier.
    expect(loaderDirectory(`file:${loader}`)).toBe(loaderDir)
    expect(loaderDirectory('data:text/javascript,export default 0')).toBe('')
    expect(loaderDirectory('https://cdn.example/pqc/pqc.mjs')).toBe('')
  })

  describe('through a symlink in Node', () => {
    let dir: string

    beforeEach(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'qbit-pqc-loader-symlink-')))
      symlinkSync(loader, join(dir, 'pqc.mjs'))
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it("is the real file's directory, as Node resolves the import", async () => {
      const { loaderDirectory } = await transpiledPqc({ browser: false })

      expect(loaderDirectory(pathToFileURL(join(dir, 'pqc.mjs')))).toBe(loaderDir)
    })

    it("is the symlink's directory under --preserve-symlinks", async () => {
      vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=4096 --preserve-symlinks')
      const { loaderDirectory } = await transpiledPqc({ browser: false })

      expect(loaderDirectory(pathToFileURL(join(dir, 'pqc.mjs')))).toBe(`${dir}/`)
    })

    it("is the symlink's directory under NODE_PRESERVE_SYMLINKS=1", async () => {
      vi.stubEnv('NODE_PRESERVE_SYMLINKS', '1')
      const { loaderDirectory } = await transpiledPqc({ browser: false })

      expect(loaderDirectory(pathToFileURL(join(dir, 'pqc.mjs')))).toBe(`${dir}/`)
    })

    it('rejects a loader whose real path cannot be found, naming it', async () => {
      const { loaderDirectory } = await transpiledPqc({ browser: false })
      const missing = pathToFileURL(join(dir, 'missing.mjs'))

      expect(() => loaderDirectory(missing)).toThrow(
        `init() could not load ${missing.href}: moduleUrl cannot be resolved (ENOENT`
      )
    })
  })

  it('is a URL outside Node, and empty for a blob: or data: URL', async () => {
    const { loaderDirectory } = await transpiledPqc({ browser: true })

    expect(loaderDirectory('https://cdn.example/pqc/pqc.mjs')).toBe('https://cdn.example/pqc/')
    expect(loaderDirectory(new URL('chrome-extension://abcdef/wasm/pqc.mjs'))).toBe('chrome-extension://abcdef/wasm/')
    expect(loaderDirectory('blob:https://app.example/0f5c2c1e-0000-4000-8000-000000000000')).toBe('')
    expect(loaderDirectory('data:text/javascript,export default 0')).toBe('')
  })

  it('resolves a bare specifier with import.meta.resolve, and nothing else', async () => {
    const resolve = vi.fn((_specifier: string) => pathToFileURL(loader).href)
    vi.stubGlobal('__pqcTestResolve', resolve)
    const { loaderDirectory } = await transpiledPqc({ browser: false, stubResolve: true })

    expect(loaderDirectory('@qbit-oss/pqc/wasm/pqc.mjs')).toBe(loaderDir)
    expect(loaderDirectory('pqc-loader')).toBe(loaderDir)
    expect(loaderDirectory(pathToFileURL(loader).href)).toBe(loaderDir)
    // Paths, resolved against this copy's data: URL, which cannot resolve them.
    for (const path of ['/srv/pqc/pqc.mjs', './pqc.mjs', '../pqc.mjs']) {
      expect(() => loaderDirectory(path)).toThrow(`init() could not load ${path}: moduleUrl cannot be resolved`)
    }
    expect(resolve.mock.calls).toEqual([['@qbit-oss/pqc/wasm/pqc.mjs'], ['pqc-loader']])
  })

  it('rejects a moduleUrl it cannot resolve, naming it', async () => {
    vi.stubGlobal('__pqcTestResolve', (specifier: string) => {
      throw new TypeError(`Cannot find package '${specifier}'`)
    })
    const pqc = await transpiledPqc({ browser: false, stubResolve: true })

    let error: unknown
    try {
      pqc.loaderDirectory('pqc-loader')
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({
      kind: 'LOAD_FAILED',
      url: 'pqc-loader',
      status: undefined,
      message:
        "init() could not load pqc-loader: moduleUrl cannot be resolved (Cannot find package 'pqc-loader') " +
        'to find the pqc.wasm beside it: pass an absolute URL',
    })
  })

  it('rejects a bare specifier without import.meta.resolve, asking for an absolute URL', async () => {
    vi.stubGlobal('__pqcTestResolve', undefined)
    const { loaderDirectory } = await transpiledPqc({ browser: true, stubResolve: true })

    expect(() => loaderDirectory('@qbit-oss/pqc/wasm/pqc.mjs')).toThrow(
      'init() could not load @qbit-oss/pqc/wasm/pqc.mjs: a bare moduleUrl needs import.meta.resolve, ' +
        'which this runtime or bundle lacks, to find the pqc.wasm beside it: pass an absolute URL'
    )
  })

  // init() itself, with a loader that imports: it rejects before reading or
  // compiling anything, and never falls back to the package's own pqc.wasm.
  it.each([
    [
      'import.meta.resolve throws',
      () => {
        throw new TypeError('no such package')
      },
      'moduleUrl cannot be resolved (no such package) to find the pqc.wasm beside it: pass an absolute URL',
    ],
    [
      'import.meta.resolve is missing',
      undefined,
      'a bare moduleUrl needs import.meta.resolve, which this runtime or bundle lacks, ' +
        'to find the pqc.wasm beside it: pass an absolute URL',
    ],
  ])('init() rejects a bare moduleUrl when %s', async (_name, resolve, reason) => {
    const importLoader = vi.fn(async () => ({ default: createPqcModule }))
    vi.stubGlobal('__pqcTestImport', importLoader)
    vi.stubGlobal('__pqcTestResolve', resolve)
    const pqc = await transpiledPqc({ browser: false, stubResolve: true, stubImport: true })
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')
    const compiled = spyOnCompile()

    const error = await rejection(pqc.init({ moduleUrl: 'pqc-loader', expectedWasmSha256: pinnedSha256 }))

    expect(importLoader.mock.calls).toEqual([['pqc-loader']])
    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({ url: 'pqc-loader', message: `init() could not load pqc-loader: ${reason}` })
    expect(readFileSyncSpy.mock.calls.filter(([path]) => String(path).endsWith('.wasm'))).toEqual([])
    expect(compiled()).toEqual([])
  })
})

describe('init({ expectedWasmSha256 }) outside Node', () => {
  const browserPqc = () => transpiledPqc({ browser: true })

  const url = 'https://cdn.example/pqc/pqc.wasm'

  it('fetches the located file once, and compiles it when it has the digest', async () => {
    const fetchStub = vi.fn(async () => new Response(new Uint8Array(pinnedWasm)))
    vi.stubGlobal('fetch', fetchStub)
    const pqc = await browserPqc()
    const { createModule, calls } = recordingFactory()
    const compiled = spyOnCompile()

    const client = await pqc.init({ createModule, locateFile: () => url, expectedWasmSha256: pinnedSha256 })

    expectGoldenKeygen(client)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [target, request] = fetchStub.mock.calls[0] as unknown as [string, RequestInit]
    expect(target).toBe(url)
    expect(request.credentials).toBe('same-origin')
    expect(calls.map(options => options.wasmBinary === undefined)).toEqual([false])
    expect(compiled()).toEqual([pinnedSha256])
  })

  it('rejects other bytes with the URL, before compiling them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(markedWasm())))
    )
    const pqc = await browserPqc()
    const { createModule, calls } = recordingFactory()
    const compiled = spyOnCompile()

    const error = await rejection(pqc.init({ createModule, locateFile: () => url, expectedWasmSha256: pinnedSha256 }))

    expectMismatch(pqc, error, { url, actual: markedSha256, expected: pinnedSha256 })
    expect(calls).toEqual([])
    expect(compiled()).toEqual([])
  })

  it('reports the HTTP status of an error response, without asking again', async () => {
    const fetchStub = vi.fn(async () => new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', fetchStub)
    const pqc = await browserPqc()

    const error = await rejection(
      pqc.init({ createModule: createPqcModule, locateFile: () => url, expectedWasmSha256: pinnedSha256 })
    )

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({
      kind: 'LOAD_FAILED',
      url,
      status: 404,
      message: `init() could not load ${url} (HTTP 404)`,
    })
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('names the URL of a request that fails', async () => {
    const failure = new TypeError('Failed to fetch')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw failure
      })
    )
    const pqc = await browserPqc()

    const error = await rejection(
      pqc.init({ createModule: createPqcModule, locateFile: () => url, expectedWasmSha256: pinnedSha256 })
    )

    expect(error).toBeInstanceOf(pqc.PqcLoadError)
    expect(error).toMatchObject({ url, status: undefined, message: `init() could not load ${url}: Failed to fetch` })
    expect((error as Pqc.PqcLoadError).cause).toBe(failure)
  })
})
