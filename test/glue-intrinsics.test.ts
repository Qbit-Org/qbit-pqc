import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { InitOptions, PqcClient, PqcKeyPair, PqcWasmModule, PqcWasmModuleFactory } from '../src/index'
import createPqcModule from '../wasm/pqc.mjs'
import { freshClient } from './fresh-client'

// Regression coverage for Qbit-Org/qbit-pqc#4. The Emscripten glue built HEAPU8
// and its other heap views, when the module was instantiated and again whenever
// a call grew memory, with the typed-array constructors that were global at
// that moment, sized the growth with the global Math, and read the memory's
// buffer and grew it through WebAssembly.Memory.prototype. The wrapper copies
// inputs, secret keys included, into and out of WASM memory through whatever
// HEAPU8 the glue built, so code that replaced those after the package loaded
// chose that view, and how much memory a call grew.
//
// Each test loads a fresh copy of the package while the ten typed-array
// constructors, Math.ceil, max and min, and WebAssembly.Memory.prototype's
// buffer getter and grow method are markers: replacements that behave like
// the real ones and log their calls. The copy captures the markers, so the log
// shows whether the glue used what init() passed it. The test then replaces
// the same names again with subverting versions, either before init() or
// between init() and the first call, and restores them in `finally`. Those
// log their calls too, and a constructor given an ArrayBuffer (as
// updateMemoryViews passes it the memory's) builds its view on a decoy buffer
// of the same size instead, the buffer getter returns a decoy, and Math.ceil
// and grow each make the memory grow by an extra 64 KiB page. Both log only
// while armed, and only the subverting versions misbehave, only while armed:
// around the calls below, which run synchronously, so nothing else sees them
// armed (not the test runner's module loading while init() runs, for one).
//
// The calls are keygen with entropy larger than the initial heap, which grows
// memory while copying the entropy in and again inside native keygen before
// the keys are copied out, then sign with a secret key from elsewhere, during
// which the first allocation first grows memory, so the secret key is copied
// in, and the signature out, through views built during the sign call. Each
// result, and the heap size after each call, must match the same calls on an
// untouched module. All key material is synthetic.

const RealArrayBuffer = ArrayBuffer
const RealUint8Array = Uint8Array
const realMath = Math
const { ceil: realCeil, max: realMax, min: realMin } = Math
const memoryPrototype = WebAssembly.Memory.prototype
const realMemoryBuffer = Object.getOwnPropertyDescriptor(memoryPrototype, 'buffer')!.get!
const realMemoryGrow = memoryPrototype.grow

const TYPED_ARRAYS = [
  'Int8Array',
  'Uint8Array',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
] as const

const MATH_MEMBERS = ['ceil', 'max', 'min'] as const

// Every call the glue makes during the calls under test through what
// qbitPqcIntrinsics supplies, named as the replacements log them.
const GLUE_USES = [
  ...TYPED_ARRAYS.map(name => `new ${name}`),
  ...MATH_MEMBERS.map(member => `Math.${member}`),
  'Memory.buffer',
  'Memory.grow',
].sort()
// The wrapper itself constructs Uint8Array and Uint32Array views, through
// the same captured constructors.
const GLUE_ONLY_USES = GLUE_USES.filter(name => name !== 'new Uint8Array' && name !== 'new Uint32Array')

let armed = false

function patchDescriptor(target: object, key: string, patch: PropertyDescriptor): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, ...patch })
  return () => {
    if (descriptor === undefined) {
      delete (target as Record<string, unknown>)[key]
    } else {
      Object.defineProperty(target, key, descriptor)
    }
  }
}

// Replaces the typed-array constructors, Math and WebAssembly.Memory's buffer
// getter and grow method with versions that log each call to `calls` while
// armed, and, when `subvert` is set, misbehave while armed. Returns a function
// that restores the originals.
function replaceIntrinsics(calls: string[], subvert: boolean): () => void {
  const restores: Array<() => void> = []
  const log = (name: string): boolean => {
    if (armed) {
      calls.push(name)
    }
    return armed && subvert
  }
  try {
    for (const name of TYPED_ARRAYS) {
      const Real = globalThis[name] as unknown as new (...args: unknown[]) => object
      const replaced = new Proxy(Real, {
        construct(target, args: unknown[], newTarget) {
          const [source, ...rest] = args
          if (log(`new ${name}`) && source instanceof RealArrayBuffer) {
            return Reflect.construct(target, [new RealArrayBuffer(source.byteLength), ...rest], newTarget)
          }
          return Reflect.construct(target, args, newTarget)
        },
      })
      restores.push(patchDescriptor(globalThis, name, { writable: true, value: replaced }))
    }
    const replacedMath = Object.create(realMath, {
      ceil: { value: (value: number) => realCeil(value) + (log('Math.ceil') ? 1 : 0) },
      max: { value: (...values: number[]) => (log('Math.max'), realMax(...values)) },
      min: { value: (...values: number[]) => (log('Math.min'), realMin(...values)) },
    }) as Math
    restores.push(patchDescriptor(globalThis, 'Math', { writable: true, value: replacedMath }))
    restores.push(
      patchDescriptor(memoryPrototype, 'buffer', {
        get(this: WebAssembly.Memory) {
          const buffer = realMemoryBuffer.call(this) as ArrayBuffer
          return log('Memory.buffer') ? new RealArrayBuffer(buffer.byteLength) : buffer
        },
      }),
      patchDescriptor(memoryPrototype, 'grow', {
        writable: true,
        value(this: WebAssembly.Memory, pages: number) {
          return realMemoryGrow.call(this, pages + (log('Memory.grow') ? 1 : 0))
        },
      })
    )
  } catch (error) {
    restoreAll(restores)
    throw error
  }
  return () => restoreAll(restores)
}

function restoreAll(restores: Array<() => void>): void {
  for (const restore of restores.reverse()) {
    restore()
  }
}

// The names in `calls` that the glue could only have made through
// qbitPqcIntrinsics, or through `names`.
function usesAmong(calls: readonly string[], names: readonly string[]): string[] {
  return [...new Set(calls.filter(call => names.includes(call)))].sort()
}

// A fresh copy of the package, loaded after this file and while the markers
// are in place, so it captures them: its init() and its default loader's
// import of the glue start from nothing.
async function loadMarkedPackage(markerCalls: string[]): Promise<typeof import('../src/index')> {
  vi.resetModules()
  const restore = replaceIntrinsics(markerCalls, false)
  try {
    return await import('../src/index')
  } finally {
    restore()
  }
}

// The client does not expose its module. Each load path hands the module its
// factory built to this, so a test can grow memory during a call.
const MODULE = Symbol.for('qbit-pqc-test:glue-intrinsics-module')

function capturing(factory: PqcWasmModuleFactory): PqcWasmModuleFactory {
  return async options => {
    const module = await factory(options)
    ;(globalThis as Record<symbol, unknown>)[MODULE] = module
    return module
  }
}

function takeModule(): PqcWasmModule {
  const store = globalThis as Record<symbol, unknown>
  const module = store[MODULE] as PqcWasmModule | undefined
  delete store[MODULE]
  if (module === undefined) {
    throw new Error('the factory did not hand over its module')
  }
  return module
}

// Makes the next allocation through `module._malloc` first allocate and free
// as many bytes as the heap holds, so memory grows right there.
function growOnNextMalloc(module: PqcWasmModule): void {
  const malloc = module._malloc
  module._malloc = byteLength => {
    module._malloc = malloc
    module._free(malloc(module.HEAPU8.byteLength))
    return malloc(byteLength)
  }
}

function syntheticBytes(length: number, seedByte: number): Uint8Array {
  const bytes = new RealUint8Array(length)
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (seedByte + ((i * 113) % 251)) & 0xff
  }
  return bytes
}

interface Observed {
  keyPair: PqcKeyPair
  signature: Uint8Array
  heapAfterKeygen: number
  heapAfterSign: number
}

interface Outcome {
  observed?: Observed
  error?: unknown
}

const message = syntheticBytes(32, 0x51)
const wasmBinary = readFileSync(new URL('../wasm/pqc.wasm', import.meta.url))

describe('the glue builds its heap views and grows memory with captured intrinsics', () => {
  let signingKey: PqcKeyPair
  let entropy: Uint8Array
  let initialHeap: number
  let expected: Observed

  // keygen with `entropy`, then sign with signingKey, growing memory at the
  // start of the sign call, with the replacements armed around both calls.
  function exercise(client: PqcClient, module: PqcWasmModule): Outcome {
    armed = true
    try {
      const keyPair = client.keygen(entropy)
      const heapAfterKeygen = client.wasmHeapBytes()
      growOnNextMalloc(module)
      const signature = client.sign(signingKey.secretKey, message)
      const heapAfterSign = client.wasmHeapBytes()
      return { observed: { keyPair, signature, heapAfterKeygen, heapAfterSign } }
    } catch (error) {
      return { error }
    } finally {
      armed = false
    }
  }

  beforeAll(async () => {
    signingKey = (await freshClient()).client.keygen(syntheticBytes(128, 0x2a))
    const reference = await freshClient()
    initialHeap = reference.client.wasmHeapBytes()
    entropy = syntheticBytes(initialHeap, 0x3c)
    const outcome = exercise(reference.client, reference.module)
    expect(outcome.error).toBeUndefined()
    expected = outcome.observed!
    // Control: each call grows memory, so updateMemoryViews and
    // _emscripten_resize_heap run during both.
    expect(expected.heapAfterKeygen).toBeGreaterThan(initialHeap)
    expect(expected.heapAfterSign).toBeGreaterThan(expected.heapAfterKeygen)
  })

  let moduleDir: string | undefined

  afterEach(() => {
    vi.doUnmock('../wasm/pqc.mjs')
    if (moduleDir !== undefined) {
      rmSync(moduleDir, { recursive: true, force: true })
      moduleDir = undefined
    }
  })

  // How init() gets the glue, and which of its uses go through the markers the
  // package captured: all of them when init()'s qbitPqcIntrinsics reaches the
  // glue. The default loader and moduleUrl import the glue when init() runs;
  // createModule hands over a factory imported earlier, here when this file
  // loaded, as an MV3 service worker imports it statically.
  interface LoadPath {
    name: string
    options: () => InitOptions
    marked: readonly string[]
  }

  const loadPaths: LoadPath[] = [
    {
      name: 'the default loader',
      options: () => {
        vi.doMock('../wasm/pqc.mjs', async () => {
          const actual = await vi.importActual<{ default: PqcWasmModuleFactory }>('../wasm/pqc.mjs')
          return { default: capturing(actual.default) }
        })
        return {}
      },
      marked: GLUE_USES,
    },
    {
      name: 'moduleUrl',
      options: () => {
        // A copy of the loader and pqc.wasm at a URL of their own, so init()
        // imports them afresh, behind a loader that hands over the module.
        moduleDir = realpathSync(mkdtempSync(join(tmpdir(), 'qbit-pqc-glue-intrinsics-')))
        const wasmDir = fileURLToPath(new URL('../wasm/', import.meta.url))
        copyFileSync(join(wasmDir, 'pqc.mjs'), join(moduleDir, 'pqc.mjs'))
        copyFileSync(join(wasmDir, 'pqc.wasm'), join(moduleDir, 'pqc.wasm'))
        writeFileSync(
          join(moduleDir, 'loader.mjs'),
          [
            "import createPqcModule from './pqc.mjs'",
            'export default async options => {',
            '  const module = await createPqcModule(options)',
            `  globalThis[Symbol.for(${JSON.stringify(MODULE.description)})] = module`,
            '  return module',
            '}',
            '',
          ].join('\n')
        )
        return { moduleUrl: pathToFileURL(join(moduleDir, 'loader.mjs')) }
      },
      marked: GLUE_USES,
    },
    {
      name: 'createModule',
      options: () => ({ createModule: capturing(createPqcModule) }),
      marked: GLUE_USES,
    },
    {
      // Calls the glue without the options init() passed, so the glue falls
      // back to the copies it took when this file imported it.
      name: 'a createModule factory that drops the options',
      options: () => ({ createModule: () => capturing(createPqcModule)({ wasmBinary }) }),
      marked: [],
    },
  ]

  // Validation in native/glue-intrinsics.pre.js: an entry that is not a
  // function falls back to the glue's own copy instead of leaving the name it
  // shadows undefined.
  const malformedPaths: LoadPath[] = [
    {
      name: 'a createModule factory that passes qbitPqcIntrinsics: {}',
      options: () => ({
        createModule: options => capturing(createPqcModule)({ ...options, qbitPqcIntrinsics: {} }),
      }),
      marked: [],
    },
    {
      name: 'a createModule factory that passes a qbitPqcIntrinsics whose mathMax is not a function',
      options: () => ({
        createModule: options =>
          capturing(createPqcModule)({
            ...options,
            qbitPqcIntrinsics: { ...options?.qbitPqcIntrinsics, mathMax: 'max' },
          }),
      }),
      marked: GLUE_USES.filter(name => name !== 'Math.max'),
    },
  ]

  function expectUnaffected(path: LoadPath, markerCalls: string[], subverted: string[], outcome: Outcome): void {
    // The glue used exactly what init() passed it, and nothing a replacement
    // installed after the package loaded.
    expect(subverted).toEqual([])
    expect(usesAmong(markerCalls, path.marked.length === 0 ? GLUE_ONLY_USES : GLUE_USES)).toEqual(path.marked)
    // So the copies through the views it built, the secret keys' included,
    // reached WASM memory, and it grew memory as far as an untouched module.
    expect(outcome.error).toBeUndefined()
    const observed = outcome.observed!
    expect(observed.keyPair).toEqual(expected.keyPair)
    expect(observed.signature).toEqual(expected.signature)
    expect(observed.heapAfterKeygen).toBe(expected.heapAfterKeygen)
    expect(observed.heapAfterSign).toBe(expected.heapAfterSign)
  }

  async function replacedBeforeInit(path: LoadPath): Promise<void> {
    const markerCalls: string[] = []
    const pkg = await loadMarkedPackage(markerCalls)
    const options = path.options()
    const subverted: string[] = []
    const restore = replaceIntrinsics(subverted, true)
    let outcome: Outcome
    try {
      const client = await pkg.init(options)
      outcome = exercise(client, takeModule())
    } finally {
      restore()
    }
    expectUnaffected(path, markerCalls, subverted, outcome)
  }

  describe.each(loadPaths.map(path => [path.name, path] as const))('through %s', (_name, path) => {
    it('globals and WebAssembly.Memory.prototype replaced after the package loads, before init()', async () => {
      await replacedBeforeInit(path)
    })

    // With the glue imported before the replacements, its own copies are the
    // originals too, so only the marker check fails here when init() does not
    // pass qbitPqcIntrinsics.
    it('globals and WebAssembly.Memory.prototype replaced between init() and the first call', async () => {
      const markerCalls: string[] = []
      const pkg = await loadMarkedPackage(markerCalls)
      const client = await pkg.init(path.options())
      const module = takeModule()
      const subverted: string[] = []
      const restore = replaceIntrinsics(subverted, true)
      let outcome: Outcome
      try {
        outcome = exercise(client, module)
      } finally {
        restore()
      }
      expectUnaffected(path, markerCalls, subverted, outcome)
    })
  })

  it.each(malformedPaths.map(path => [path.name, path] as const))('through %s', async (_name, path) => {
    await replacedBeforeInit(path)
  })
})

describe('the glue binds what it uses to the captured copies', () => {
  const glue = readFileSync(new URL('../wasm/pqc.mjs', import.meta.url), 'utf8')
  const factory = glue.slice(glue.indexOf('async function(moduleArg'))

  it('uses no Math member that the captured Math lacks', () => {
    const used = new Set([...factory.matchAll(/\bMath\.(\w+)/g)].map(match => match[1]))
    expect([...used].filter(member => !(MATH_MEMBERS as readonly string[]).includes(member!))).toEqual([])
    const binding =
      'var Math={ceil:qbitPqcIntrinsic("mathCeil"),max:qbitPqcIntrinsic("mathMax"),min:qbitPqcIntrinsic("mathMin")};'
    expect(factory.includes(binding), 'Math bound').toBe(true)
  })

  it('binds every typed-array constructor it calls', () => {
    const used = new Set([...factory.matchAll(/\bnew (\w+Array)\b/g)].map(match => match[1]!))
    expect([...used].filter(name => !(TYPED_ARRAYS as readonly string[]).includes(name))).toEqual([])
    for (const name of TYPED_ARRAYS) {
      expect(factory.includes(`var ${name}=qbitPqcIntrinsic("${name}");`), `${name} bound`).toBe(true)
    }
  })

  it('shadows the memory buffer getter and grow method before the factory resolves', () => {
    const shadow = factory.indexOf('Object.defineProperties(qbitPqcMemory,{buffer:')
    expect(shadow, 'own buffer and grow on the memory').toBeGreaterThan(factory.indexOf('run();'))
    expect(shadow).toBeLessThan(factory.indexOf('moduleRtn=Module'))
  })
})
