import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { InitOptions, PqcClient, PqcKeyPair } from '../src/index'
import createPqcModule from '../wasm/pqc.mjs'
import { freshClient } from './fresh-client'

// Regression coverage for Qbit-Org/qbit-pqc#4. The Emscripten glue built HEAPU8
// and its other heap views, when the module was instantiated and again whenever
// a call grew memory, with the typed-array constructors that were global at
// that moment, and computed how far to grow with the global Math. The wrapper
// copies inputs, secret keys included, into and out of WASM memory through
// whatever HEAPU8 the glue built, so code that replaced those globals after the
// package loaded chose that view, and how much memory a call grew.
//
// Each test loads a fresh copy of the package, replaces the ten typed-array
// constructors and Math either before init() or between init() and the first
// call, and restores them in `finally`. The replacements behave like the real
// ones until armed. Armed, each records its call, a constructor given an
// ArrayBuffer (as updateMemoryViews passes it the memory's) builds its view on
// a decoy buffer of the same size instead, and Math.ceil rounds one too high,
// which makes the glue grow memory by an extra 64 KiB page. They are armed only
// around the calls below, which run synchronously, so nothing else sees them
// armed: not the test runner's module loading while init() runs, for one.
//
// The calls are keygen with entropy larger than the initial heap, which grows
// memory while copying the entropy in and again inside native keygen before
// the keys are copied out, then sign with a secret key from elsewhere, copied
// in through the grown heap. Each result, and the heap size after each call,
// must match the same calls on an untouched module. All key material is
// synthetic.

const RealArrayBuffer = ArrayBuffer
const RealUint8Array = Uint8Array
const realMath = Math
const { ceil: realCeil, max: realMax, min: realMin } = Math

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

interface Replacements {
  armed: boolean
  // Every call an armed replacement received.
  readonly calls: string[]
}

function patchGlobal(key: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  return () => {
    if (descriptor === undefined) {
      delete (globalThis as Record<string, unknown>)[key]
    } else {
      Object.defineProperty(globalThis, key, descriptor)
    }
  }
}

function replaceGlobals(): { replacements: Replacements; restore: () => void } {
  const replacements: Replacements = { armed: false, calls: [] }
  const restores: Array<() => void> = []
  try {
    for (const name of TYPED_ARRAYS) {
      const Real = globalThis[name] as unknown as new (...args: unknown[]) => object
      const replaced = new Proxy(Real, {
        construct(target, args: unknown[], newTarget) {
          if (replacements.armed) {
            replacements.calls.push(`new ${name}`)
            const [source, ...rest] = args
            if (source instanceof RealArrayBuffer) {
              return Reflect.construct(target, [new RealArrayBuffer(source.byteLength), ...rest], newTarget)
            }
          }
          return Reflect.construct(target, args, newTarget)
        },
      })
      restores.push(patchGlobal(name, replaced))
    }
    const record = (member: string): boolean => {
      if (replacements.armed) {
        replacements.calls.push(`Math.${member}`)
      }
      return replacements.armed
    }
    const replacedMath = Object.create(realMath, {
      ceil: { value: (value: number) => realCeil(value) + (record('ceil') ? 1 : 0) },
      max: { value: (...values: number[]) => (record('max'), realMax(...values)) },
      min: { value: (...values: number[]) => (record('min'), realMin(...values)) },
    }) as Math
    restores.push(patchGlobal('Math', replacedMath))
  } catch (error) {
    restoreAll(restores)
    throw error
  }
  return { replacements, restore: () => restoreAll(restores) }
}

function restoreAll(restores: Array<() => void>): void {
  for (const restore of restores.reverse()) {
    restore()
  }
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

function syntheticBytes(length: number, seedByte: number): Uint8Array {
  const bytes = new RealUint8Array(length)
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (seedByte + ((i * 113) % 251)) & 0xff
  }
  return bytes
}

const message = syntheticBytes(32, 0x51)

describe('the glue builds its heap views and sizes memory growth with captured intrinsics', () => {
  let signingKey: PqcKeyPair
  let entropy: Uint8Array
  let initialHeap: number
  let expected: Observed

  // keygen with `entropy`, then sign with signingKey, arming `replacements`
  // around both calls.
  function exercise(client: PqcClient, replacements?: Replacements): Outcome {
    if (replacements !== undefined) {
      replacements.armed = true
    }
    try {
      const keyPair = client.keygen(entropy)
      const heapAfterKeygen = client.wasmHeapBytes()
      const signature = client.sign(signingKey.secretKey, message)
      const heapAfterSign = client.wasmHeapBytes()
      return { observed: { keyPair, signature, heapAfterKeygen, heapAfterSign } }
    } catch (error) {
      return { error }
    } finally {
      if (replacements !== undefined) {
        replacements.armed = false
      }
    }
  }

  beforeAll(async () => {
    signingKey = (await freshClient()).client.keygen(syntheticBytes(128, 0x2a))
    const { client: reference } = await freshClient()
    initialHeap = reference.wasmHeapBytes()
    entropy = syntheticBytes(initialHeap, 0x3c)
    const outcome = exercise(reference)
    expect(outcome.error).toBeUndefined()
    expected = outcome.observed!
    // Control: both calls grow memory, so updateMemoryViews and
    // _emscripten_resize_heap run during them.
    expect(expected.heapAfterKeygen).toBeGreaterThan(initialHeap)
  })

  // No replacement ran while armed, so every heap view the glue built during
  // the calls came from captured constructors, and the copies through them,
  // the secret keys' included, reached WASM memory: the keys, the signature
  // and the heap sizes match the untouched module's.
  function expectUnaffected(replacements: Replacements, outcome: Outcome, client: PqcClient): void {
    expect(replacements.calls).toEqual([])
    expect(outcome.error).toBeUndefined()
    const observed = outcome.observed!
    expect(observed.keyPair).toEqual(expected.keyPair)
    expect(observed.signature).toEqual(expected.signature)
    expect(observed.heapAfterKeygen).toBe(expected.heapAfterKeygen)
    expect(observed.heapAfterSign).toBe(expected.heapAfterSign)
    expect(client.wasmHeapBytes()).toBe(expected.heapAfterSign)
  }

  let moduleDir: string | undefined

  afterEach(() => {
    if (moduleDir !== undefined) {
      rmSync(moduleDir, { recursive: true, force: true })
      moduleDir = undefined
    }
  })

  // A copy of the loader and pqc.wasm at a URL of its own, so init() imports
  // it afresh.
  function copiedModuleUrl(): URL {
    moduleDir = realpathSync(mkdtempSync(join(tmpdir(), 'qbit-pqc-glue-intrinsics-')))
    const wasmDir = fileURLToPath(new URL('../wasm/', import.meta.url))
    copyFileSync(join(wasmDir, 'pqc.mjs'), join(moduleDir, 'pqc.mjs'))
    copyFileSync(join(wasmDir, 'pqc.wasm'), join(moduleDir, 'pqc.wasm'))
    return pathToFileURL(join(moduleDir, 'pqc.mjs'))
  }

  const wasmBinary = readFileSync(new URL('../wasm/pqc.wasm', import.meta.url))

  // How init() gets the glue: the default loader and moduleUrl import it when
  // init() runs; createModule hands over a factory imported earlier, here when
  // this file loaded, as an MV3 service worker imports it statically.
  const loadPaths: Array<[name: string, options: () => InitOptions]> = [
    ['the default loader', () => ({})],
    ['moduleUrl', () => ({ moduleUrl: copiedModuleUrl() })],
    ['createModule', () => ({ createModule: createPqcModule })],
    // A factory that calls the glue without the options init() passed it, so
    // the glue falls back to the copies it took when it was evaluated.
    ['a createModule factory that drops the options', () => ({ createModule: () => createPqcModule({ wasmBinary }) })],
  ]

  // A copy of the package of its own, loaded after this file: its init() and
  // its default loader's import of the glue start from nothing.
  async function loadPackage(): Promise<typeof import('../src/index')> {
    vi.resetModules()
    return import('../src/index')
  }

  describe.each(loadPaths)('through %s', (name, options) => {
    it('globals replaced after the package loads, before init()', async () => {
      const pkg = await loadPackage()
      const initOptions = options()
      const { replacements, restore } = replaceGlobals()
      let client: PqcClient
      let outcome: Outcome
      try {
        client = await pkg.init(initOptions)
        outcome = exercise(client, replacements)
      } finally {
        restore()
      }

      expectUnaffected(replacements, outcome, client)
      if (name === 'the default loader') {
        // Control: the loader init() imported was evaluated afresh, after the
        // globals were replaced, not the copy this file imported.
        expect((await import('../wasm/pqc.mjs')).default).not.toBe(createPqcModule)
      }
    })

    it('globals replaced between init() and the first call', async () => {
      const pkg = await loadPackage()
      const client = await pkg.init(options())
      const { replacements, restore } = replaceGlobals()
      let outcome: Outcome
      try {
        outcome = exercise(client, replacements)
      } finally {
        restore()
      }

      expectUnaffected(replacements, outcome, client)
    })
  })
})

describe('the glue binds what it uses to the captured copies', () => {
  const glue = readFileSync(new URL('../wasm/pqc.mjs', import.meta.url), 'utf8')
  const factory = glue.slice(glue.indexOf('async function(moduleArg'))

  it('uses no Math member that the captured Math lacks', () => {
    const used = new Set([...factory.matchAll(/\bMath\.(\w+)/g)].map(match => match[1]))
    expect([...used].filter(member => !(MATH_MEMBERS as readonly string[]).includes(member!))).toEqual([])
    expect(factory.includes('var Math=qbitPqcIntrinsics.Math;'), 'Math bound').toBe(true)
  })

  it('binds every typed-array constructor it calls', () => {
    const used = new Set([...factory.matchAll(/\bnew (\w+Array)\b/g)].map(match => match[1]!))
    expect([...used].filter(name => !(TYPED_ARRAYS as readonly string[]).includes(name))).toEqual([])
    for (const name of TYPED_ARRAYS) {
      expect(factory.includes(`var ${name}=qbitPqcIntrinsics.${name};`), `${name} bound`).toBe(true)
    }
  })
})
