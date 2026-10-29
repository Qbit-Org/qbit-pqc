import { readFileSync } from 'node:fs'

import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'

import derivationFixture from '../fixtures/qbit-core-derivation.json'
import {
  constants,
  errorCodes,
  init,
  PqcError,
  type PqcClient,
  type PqcDerivedKey,
  type PqcDerivedKeyPair,
  type PqcKeyPair,
  type PqcSignWithStatsResult,
  type PqcWasmModule,
} from '../src/index'
import { freshClient } from './fresh-client'

// Regression coverage for caller code that runs during a call: argument
// validation used `value instanceof Uint8Array`, which walks the
// argument's prototype chain, so a Proxy in that chain ran its getPrototypeOf
// trap mid-call. The wrapper then built the pinned view with
// `new Uint8Array(...)`, looked up on the global object at call time, so a
// trap that replaced globalThis.Uint8Array could hand `HEAPU8.set` a view
// longer than the allocation it had just sized. Anything else the call path
// read from a global could be changed the same way: Math.max (allocation
// size), Uint32Array.BYTES_PER_ELEMENT (stats allocation size), the exported
// `constants` object (signature and key allocation sizes),
// %TypedArray%.prototype.set/fill and Symbol.species (the copies in and out,
// and the zeroing of secret copies), and DataView, Math and Number (the
// derivePQCKey hash and its uint32 checks).
//
// Validation now reads the [[TypedArrayName]] internal slot instead, so it
// never runs such a trap, and everything above is captured at module load.
// Each test patches a global after the module loaded, as code that ran
// before the call could, passes an argument whose prototype is a counting
// Proxy, restores the global before asserting, and checks that the trap never
// ran and that the result matches an unpatched call on a separate instance.
// Every victim instance runs with a red zone after each wasm allocation (see
// guardHeap), so a write past an allocation is reported even when it does not
// crash. All key material is synthetic.
//
// The derivePQCKey hash also called %TypedArray%.prototype set, fill and the
// length, buffer, byteOffset and byteLength getters, and DataView.prototype
// setUint32 and getUint32, on its own buffers. Patching any of them changed
// the derived key or kept the PRK and keygen entropy from being zeroed, and a
// patched getter ran user code mid-call, which could detach masterSeed after
// validation. Those tests run on a copy of the module that records every
// typed array it allocates (see loadRecordingCopy), check the result against
// qbit Core's derivation vectors, and check that the call zeroed every buffer
// it allocated. verify and secretKeyValidate also read the exported, mutable
// errorCodes object to tell a bad signature or key from a native failure.
// The exported `constants` and `errorCodes` objects are now frozen, so the
// tests that patched them check that each write throws and that the call
// still uses the real sizes and codes.

const RealUint8Array = Uint8Array
const RealUint32Array = Uint32Array
const RealDataView = DataView
const realUint8ArrayPrototype = Uint8Array.prototype
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const realMathCeil = Math.ceil
const realLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!
const realFill = Uint8Array.prototype.fill
const realArrayFrom = Array.from
const realArrayValues = Array.prototype.values
const arrayIteratorPrototype = Object.getPrototypeOf([].values()) as Iterator<unknown>
const realArrayIteratorNext = arrayIteratorPrototype.next

interface DerivationVector {
  name: string
  hkdf: { account: number; change: number; index: number }
  masterSeedHex: string
  publicKeyHex: string
  secretKeyHex: string
}

const derivationVectors = (derivationFixture as { vectors: DerivationVector[] }).vectors

const OVERRUN = 4096
const OVERRUN_BYTE = 0xa5
const REDZONE = 64
const REDZONE_BYTE = 0xc5
// SLH-DSA-SHA2-128s secret key layout: [SK_SEED || SK_PRF || PUB_SEED || root]
const SPX_N = 16

function syntheticEntropy(seedByte: number): Uint8Array {
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 113) % 256)) & 0xff
  }
  return entropy
}

function messageBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`qbit-pqc-captured-intrinsics:${label}`)
}

interface HeapGuard {
  readonly overflows: string[]
}

// Pads every wasm allocation the wrapper makes with a red zone and reports, on
// free, any allocation whose red zone was overwritten. The wrapper calls
// `module._malloc`/`module._free` through the module object, so replacing them
// there sees every allocation. Uses only indexed access, never a global or a
// prototype method that a trap below patches.
function guardHeap(module: PqcWasmModule): HeapGuard {
  const malloc = module._malloc
  const free = module._free
  const sizes = new Map<number, number>()
  const overflows: string[] = []
  module._malloc = size => {
    const ptr = malloc(size + REDZONE)
    if (ptr !== 0) {
      const heap = module.HEAPU8
      for (let i = 0; i < REDZONE; i += 1) {
        heap[ptr + size + i] = REDZONE_BYTE
      }
      sizes.set(ptr, size)
    }
    return ptr
  }
  module._free = ptr => {
    const size = sizes.get(ptr)
    if (size !== undefined) {
      sizes.delete(ptr)
      const heap = module.HEAPU8
      for (let i = 0; i < REDZONE; i += 1) {
        if (heap[ptr + size + i] !== REDZONE_BYTE) {
          overflows.push(`write past the ${size}-byte allocation at ${ptr}`)
          break
        }
      }
    }
    free(ptr)
  }
  return { overflows }
}

interface Outcome<T> {
  value?: T
  error?: unknown
  trapCalls: number
}

type Install = () => () => void
type Trap = (bytes: Uint8Array) => Uint8Array

// Runs `install`, then `call` with `trap`, which returns a copy of its bytes
// whose prototype is a Proxy of Uint8Array.prototype. `instanceof Uint8Array`
// would reach the Proxy's getPrototypeOf trap, which counts its calls and
// answers Uint8Array.prototype. Whatever `install` patched is restored before
// this returns, whether the call returned or threw.
function underTrap<T>(install: Install, call: (trap: Trap) => T): Outcome<T> {
  let trapCalls = 0
  const trap: Trap = bytes => {
    const view = new RealUint8Array(bytes)
    Object.setPrototypeOf(
      view,
      new Proxy(realUint8ArrayPrototype, {
        getPrototypeOf() {
          trapCalls += 1
          return realUint8ArrayPrototype
        },
      })
    )
    return view
  }
  const uninstall = install()
  try {
    const value = call(trap)
    return { value, trapCalls }
  } catch (error) {
    return { error, trapCalls }
  } finally {
    uninstall()
  }
}

function patchProperty(target: object, key: PropertyKey, value: unknown): () => void {
  return patchDescriptor(target, key, { writable: true, value })
}

function patchAccessor(
  target: object,
  key: PropertyKey,
  accessor: { get?: () => unknown; set?: (value: unknown) => void }
): () => void {
  return patchDescriptor(target, key, accessor)
}

function patchDescriptor(target: object, key: PropertyKey, patch: PropertyDescriptor): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    ...patch,
  })
  return () => {
    if (descriptor === undefined) {
      delete (target as Record<PropertyKey, unknown>)[key]
    } else {
      Object.defineProperty(target, key, descriptor)
    }
  }
}

function combine(...installs: Install[]): Install {
  return () => {
    const uninstalls = installs.map(install => install())
    return () => {
      for (const uninstall of uninstalls.reverse()) {
        uninstall()
      }
    }
  }
}

let fakeUint8ArrayConstructions = 0

// Replaces globalThis.Uint8Array with a constructor that returns an array
// OVERRUN bytes longer than requested, filled with OVERRUN_BYTE. It keeps the
// real prototype, so `instanceof` checks against the global still pass.
const swapGlobalUint8Array: Install = () => {
  function OverlongUint8Array(...args: unknown[]): Uint8Array {
    fakeUint8ArrayConstructions += 1
    const requested = Reflect.construct(RealUint8Array, args) as Uint8Array
    return new RealUint8Array(requested.length + OVERRUN).fill(OVERRUN_BYTE)
  }
  OverlongUint8Array.prototype = realUint8ArrayPrototype
  Object.setPrototypeOf(OverlongUint8Array, RealUint8Array)
  return patchProperty(globalThis, 'Uint8Array', OverlongUint8Array)
}

type MutableConstants = { -readonly [K in keyof typeof constants]: (typeof constants)[K] }

// constants and errorCodes are frozen, and this file runs in strict mode, so
// these writes throw and leave nothing to restore.
function patchConstant(key: 'PK_SIZE' | 'SK_SIZE' | 'SIG_SIZE', value: number): Install {
  return () => {
    const mutable = constants as MutableConstants
    expect(() => {
      mutable[key] = value as never
    }).toThrow(TypeError)
    return () => undefined
  }
}

type MutableErrorCodes = { -readonly [K in keyof typeof errorCodes]: number }

function patchErrorCode(key: keyof typeof errorCodes, value: number): Install {
  return () => {
    const mutable = errorCodes as MutableErrorCodes
    expect(() => {
      mutable[key] = value
    }).toThrow(TypeError)
    return () => undefined
  }
}

function scanHeap(module: PqcWasmModule, needle: Uint8Array): number[] {
  const heap = Buffer.from(module.HEAPU8.buffer, module.HEAPU8.byteOffset, module.HEAPU8.byteLength)
  const target = Buffer.from(needle)
  const offsets: number[] = []
  for (let found = heap.indexOf(target); found !== -1; found = heap.indexOf(target, found + 1)) {
    offsets.push(found)
  }
  return offsets
}

function flipByte(bytes: Uint8Array, offset: number): Uint8Array {
  const copy = new RealUint8Array(bytes)
  copy[offset] ^= 0x80
  return copy
}

function hexBytes(hex: string): Uint8Array {
  return new RealUint8Array(Buffer.from(hex, 'hex'))
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

interface RecordingCopy {
  init: typeof init
  // Every Uint8Array and Uint32Array the copy has constructed.
  readonly created: Array<Uint8Array | Uint32Array>
}

// A second copy of src/index.ts, evaluated while globalThis.Uint8Array and
// Uint32Array are Proxies of the real constructors that record each array
// they construct. The copy captures those Proxies as its intrinsics, so every
// typed array it allocates is a genuine one that is also recorded, and a test
// can check afterwards which of them still hold a non-zero byte.
async function loadRecordingCopy(): Promise<RecordingCopy> {
  const created: Array<Uint8Array | Uint32Array> = []
  const recording = <C extends typeof RealUint8Array | typeof RealUint32Array>(real: C): C =>
    new Proxy(real, {
      construct(target, args, newTarget) {
        const array = Reflect.construct(target, args, newTarget) as Uint8Array | Uint32Array
        created.push(array)
        return array
      },
    })
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  // The trailing comment keeps this copy's data: URL apart from any other
  // copy's, so the import evaluates it afresh.
  const { outputText } = ts.transpileModule(`${source}\n// recording copy\n`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  })
  const url = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
  const uninstall = combine(
    () => patchProperty(globalThis, 'Uint8Array', recording(RealUint8Array)),
    () => patchProperty(globalThis, 'Uint32Array', recording(RealUint32Array))
  )()
  try {
    const copy = (await import(/* @vite-ignore */ url)) as { init: typeof init }
    return { init: copy.init, created }
  } finally {
    uninstall()
  }
}

// One patched member of %TypedArray%.prototype or DataView.prototype that the
// derivePQCKey hash used. Each counts its calls through `called`.
type HashPatch = [name: string, patch: (called: () => void) => Install]

const hashPatches: HashPatch[] = [
  [
    '%TypedArray%.prototype.set (a no-op)',
    called => () =>
      patchProperty(typedArrayPrototype, 'set', () => {
        called()
      }),
  ],
  [
    '%TypedArray%.prototype.fill (a no-op)',
    called => () =>
      patchProperty(typedArrayPrototype, 'fill', function (this: Uint8Array) {
        called()
        return this
      }),
  ],
  [
    '%TypedArray%.prototype.fill (skips zeroing only)',
    called => () =>
      patchProperty(typedArrayPrototype, 'fill', function (this: Uint8Array, value: number, ...range: number[]) {
        called()
        return value === 0 ? this : realFill.call(this, value, ...range)
      }),
  ],
  [
    'the %TypedArray%.prototype.length getter (always 0)',
    called => () =>
      patchAccessor(typedArrayPrototype, 'length', {
        get() {
          called()
          return 0
        },
      }),
  ],
  [
    'the %TypedArray%.prototype.buffer getter (a scratch buffer)',
    called => () =>
      patchAccessor(typedArrayPrototype, 'buffer', {
        get() {
          called()
          return new ArrayBuffer(256)
        },
      }),
  ],
  [
    'the %TypedArray%.prototype.byteOffset getter (always 1)',
    called => () =>
      patchAccessor(typedArrayPrototype, 'byteOffset', {
        get() {
          called()
          return 1
        },
      }),
  ],
  [
    'the %TypedArray%.prototype.byteLength getter (always 0)',
    called => () =>
      patchAccessor(typedArrayPrototype, 'byteLength', {
        get() {
          called()
          return 0
        },
      }),
  ],
  [
    'DataView.prototype.setUint32 (a no-op)',
    called => () =>
      patchProperty(RealDataView.prototype, 'setUint32', () => {
        called()
      }),
  ],
  [
    'DataView.prototype.getUint32 (always 0)',
    called => () =>
      patchProperty(RealDataView.prototype, 'getUint32', () => {
        called()
        return 0
      }),
  ],
]

describe('intrinsics used after user code can run are captured at module load', () => {
  let reference: PqcClient
  let pair: PqcKeyPair
  let victim: PqcClient
  let victimModule: PqcWasmModule
  let guard: HeapGuard

  beforeAll(async () => {
    reference = await init()
    pair = reference.keygen(syntheticEntropy(0x3c))
  })

  // A fresh instance per test: before the fix several of these corrupt the
  // heap, and the red zones are only valid for allocations made after
  // guardHeap.
  async function freshVictim(): Promise<PqcClient> {
    ;({ client: victim, module: victimModule } = await freshClient())
    guard = guardHeap(victimModule)
    fakeUint8ArrayConstructions = 0
    return victim
  }

  function expectClean<T>(outcome: Outcome<T>): T {
    expect(outcome.trapCalls).toBe(0)
    expect(outcome.error).toBeUndefined()
    expect(guard.overflows).toEqual([])
    return outcome.value as T
  }

  describe('globalThis.Uint8Array replaced after the module loaded', () => {
    it('sign copies exactly the pinned msg bytes', async () => {
      await freshVictim()
      const plain = messageBytes('sign')

      const outcome = underTrap(swapGlobalUint8Array, trap => victim.sign(pair.secretKey, trap(plain)))

      expect(expectClean(outcome)).toEqual(reference.sign(pair.secretKey, plain))
      expect(fakeUint8ArrayConstructions).toBe(0)
      expect(globalThis.Uint8Array).toBe(RealUint8Array)
    })

    it('signWithStats copies exactly the pinned msg bytes', async () => {
      await freshVictim()
      const plain = messageBytes('signWithStats')

      const outcome = underTrap(swapGlobalUint8Array, trap => victim.signWithStats(pair.secretKey, trap(plain)))

      expect(expectClean(outcome)).toEqual(reference.signWithStats(pair.secretKey, plain))
      expect(fakeUint8ArrayConstructions).toBe(0)
    })

    it('verify copies exactly the pinned msg and sig bytes', async () => {
      await freshVictim()
      const plain = messageBytes('verify')
      const signature = reference.sign(pair.secretKey, plain)
      const emptyMessageSignature = reference.sign(pair.secretKey, new Uint8Array(0))

      const accepted = underTrap(swapGlobalUint8Array, trap => victim.verify(trap(pair.publicKey), plain, signature))
      expect(expectClean(accepted)).toBe(true)

      const rejected = underTrap(swapGlobalUint8Array, trap =>
        victim.verify(trap(pair.publicKey), plain, emptyMessageSignature)
      )
      expect(expectClean(rejected)).toBe(false)
      expect(fakeUint8ArrayConstructions).toBe(0)
    })

    it('keygen copies exactly the pinned entropy bytes', async () => {
      await freshVictim()
      const entropy = syntheticEntropy(0x4d)

      const outcome = underTrap(swapGlobalUint8Array, trap => victim.keygen(trap(entropy)))

      expect(expectClean(outcome)).toEqual(reference.keygen(entropy))
      expect(fakeUint8ArrayConstructions).toBe(0)
    })

    it('derivePQCKey hashes exactly the pinned masterSeed bytes', async () => {
      await freshVictim()
      const seed = syntheticEntropy(0x5e).slice(0, 64)

      const outcome = underTrap(swapGlobalUint8Array, trap => victim.derivePQCKey(trap(seed), 1, 0, 7))

      expect(expectClean(outcome)).toEqual(reference.derivePQCKey(seed, 1, 0, 7))
      expect(fakeUint8ArrayConstructions).toBe(0)
    })

    it('deriveP2mrDescriptorKey hashes exactly the pinned leafPrivateKey bytes', async () => {
      await freshVictim()
      const leaf = syntheticEntropy(0x5f).slice(0, 32)

      const outcome = underTrap(swapGlobalUint8Array, trap => victim.deriveP2mrDescriptorKey(trap(leaf), 7))

      expect(expectClean(outcome)).toEqual(reference.deriveP2mrDescriptorKey(leaf, 7))
      expect(fakeUint8ArrayConstructions).toBe(0)
    })
  })

  describe('other globals and shared state patched after the module loaded', () => {
    it('allocation sizes do not depend on Math.max', async () => {
      await freshVictim()
      const plain = messageBytes('math-max')

      const outcome = underTrap(
        () => patchProperty(Math, 'max', () => 1),
        trap => victim.sign(pair.secretKey, trap(plain))
      )

      expect(expectClean(outcome)).toEqual(reference.sign(pair.secretKey, plain))
    })

    it('the stats allocation does not depend on Uint32Array.BYTES_PER_ELEMENT', async () => {
      await freshVictim()
      const plain = messageBytes('bytes-per-element')
      class OneBytePerElement extends RealUint32Array {}
      Object.defineProperty(OneBytePerElement, 'BYTES_PER_ELEMENT', { value: 1 })

      const outcome = underTrap(
        () => patchProperty(globalThis, 'Uint32Array', OneBytePerElement),
        trap => victim.signWithStats(pair.secretKey, trap(plain))
      )

      expect(expectClean(outcome)).toEqual(reference.signWithStats(pair.secretKey, plain))
    })

    it('signature and key sizes do not depend on the exported constants object', async () => {
      await freshVictim()
      const plain = messageBytes('constants')
      const entropy = syntheticEntropy(0x6f)

      const signed = underTrap(patchConstant('SIG_SIZE', 16), trap => victim.sign(pair.secretKey, trap(plain)))
      expect(expectClean(signed)).toEqual(reference.sign(pair.secretKey, plain))

      const withStats = underTrap(patchConstant('SIG_SIZE', 16), trap =>
        victim.signWithStats(pair.secretKey, trap(plain))
      )
      expect(expectClean(withStats)).toEqual(reference.signWithStats(pair.secretKey, plain))

      const generated = underTrap(combine(patchConstant('PK_SIZE', 1), patchConstant('SK_SIZE', 1)), trap =>
        victim.keygen(trap(entropy))
      )
      expect(expectClean(generated)).toEqual(reference.keygen(entropy))
      expect(constants.SIG_SIZE).toBe(3680)
    })

    it('derivePQCKey does not depend on the DataView or Math.ceil globals', async () => {
      await freshVictim()
      const seed = syntheticEntropy(0x70).slice(0, 48)
      class IgnoresWrites extends RealDataView {
        override setUint32(): void {}
      }

      const outcome = underTrap(
        combine(
          () => patchProperty(globalThis, 'DataView', IgnoresWrites),
          () => patchProperty(Math, 'ceil', (value: number) => realMathCeil(value) + 1)
        ),
        trap => victim.derivePQCKey(trap(seed), 2, 1, 3)
      )

      expect(expectClean(outcome)).toEqual(reference.derivePQCKey(seed, 2, 1, 3))
    })

    it('derived-key aliases do not depend on Object.defineProperties or Object.prototype', async () => {
      await freshVictim()
      const leaf = syntheticEntropy(0x71).slice(0, 32)
      let patchCalls = 0
      const outcome = underTrap(
        combine(
          () =>
            patchProperty(Object, 'defineProperties', () => {
              patchCalls += 1
              throw new Error('patched Object.defineProperties')
            }),
          // An inherited `set` would give an alias descriptor with a prototype
          // a setter that sees every assignment.
          () =>
            patchAccessor(Object.prototype, 'set', {
              get: () => {
                patchCalls += 1
                return () => undefined
              },
            })
        ),
        trap => victim.deriveP2mrDescriptorKey(trap(leaf), 7)
      )

      const derived = expectClean<PqcDerivedKeyPair>(outcome)
      expect(patchCalls).toBe(0)
      expect(derived).toEqual(reference.deriveP2mrDescriptorKey(leaf, 7))
      expect(derived.secretKey).toBe(derived.sk64)
      expect(Object.getOwnPropertyDescriptor(derived, 'secretKey')?.set).toBeUndefined()
    })

    it('derivePQCKey still rejects non-integer path fields after Number is patched', async () => {
      await freshVictim()
      const seed = syntheticEntropy(0x71).slice(0, 32)

      const outcome = underTrap(
        combine(
          () => patchProperty(Number, 'isFinite', () => true),
          () => patchProperty(Number, 'isInteger', () => true)
        ),
        trap => victim.derivePQCKey(trap(seed), 1.5, 0, 0)
      )

      expect(outcome.trapCalls).toBe(0)
      expect(outcome.error).toBeInstanceOf(TypeError)
      expect((outcome.error as TypeError).message).toBe('account must be a uint32 integer')
    })

    it('deriveP2mrDescriptorKey rejects rangeIndex 1.5 after Number is patched', async () => {
      await freshVictim()
      const leaf = syntheticEntropy(0x72).slice(0, 32)

      const outcome = underTrap(
        combine(
          () => patchProperty(Number, 'isFinite', () => true),
          () => patchProperty(Number, 'isInteger', () => true)
        ),
        trap => victim.deriveP2mrDescriptorKey(trap(leaf), 1.5)
      )

      expect(outcome.trapCalls).toBe(0)
      expect(outcome.error).toBeInstanceOf(TypeError)
      expect((outcome.error as TypeError).message).toBe('rangeIndex must be a uint32 integer')
    })

    it('verify does not depend on the exported errorCodes object', async () => {
      await freshVictim()
      const plain = messageBytes('error-codes-verify')
      const signature = reference.sign(pair.secretKey, plain)
      const tampered = flipByte(signature, 100)
      const badArg = errorCodes.BITCOIN_PQC_ERROR_BAD_ARG
      const badSignatureReadsAsBadArg = patchErrorCode('BITCOIN_PQC_ERROR_BAD_SIGNATURE', badArg)

      const rejected = underTrap(badSignatureReadsAsBadArg, trap =>
        victim.verify(trap(pair.publicKey), plain, tampered)
      )
      expect(expectClean(rejected)).toBe(false)

      // A native BAD_ARG still throws rather than reading as a bad signature.
      victimModule._qbit_pqc_verify = () => badArg
      const failed = underTrap(badSignatureReadsAsBadArg, trap => victim.verify(trap(pair.publicKey), plain, signature))
      expect(failed.trapCalls).toBe(0)
      expect(failed.error).toBeInstanceOf(PqcError)
      expect((failed.error as PqcError).kind).toBe('BAD_ARG')
      expect(errorCodes.BITCOIN_PQC_ERROR_BAD_SIGNATURE).toBe(-3)
    })

    it('secretKeyValidate does not depend on the exported errorCodes object', async () => {
      await freshVictim()
      // The last byte of the stored root, which then no longer matches the seeds.
      const inconsistentKey = flipByte(pair.secretKey, 4 * SPX_N - 1)
      const badArg = errorCodes.BITCOIN_PQC_ERROR_BAD_ARG
      const badKeyReadsAsBadArg = patchErrorCode('BITCOIN_PQC_ERROR_BAD_KEY', badArg)

      const rejected = underTrap(badKeyReadsAsBadArg, trap => victim.secretKeyValidate(trap(inconsistentKey)))
      expect(expectClean(rejected)).toBe(false)

      // A native BAD_ARG still throws rather than reading as a bad key.
      victimModule._qbit_pqc_secret_key_validate = () => badArg
      const failed = underTrap(badKeyReadsAsBadArg, trap => victim.secretKeyValidate(trap(pair.secretKey)))
      expect(failed.trapCalls).toBe(0)
      expect(failed.error).toBeInstanceOf(PqcError)
      expect((failed.error as PqcError).kind).toBe('BAD_ARG')
      expect(errorCodes.BITCOIN_PQC_ERROR_BAD_KEY).toBe(-2)
    })

    it('signWithStats builds wotscAttempts without the array iterator or Array.prototype setters', async () => {
      await freshVictim()
      const plain = messageBytes('array-iteration')
      let calls = 0
      let callsDuringSign: number | undefined
      const counted = (): undefined => {
        calls += 1
        return undefined
      }

      const outcome = underTrap(
        combine(
          () => patchProperty(Array, 'from', counted),
          () =>
            patchProperty(Array.prototype, Symbol.iterator, function (this: unknown[]) {
              counted()
              return realArrayValues.call(this)
            }),
          () =>
            patchProperty(arrayIteratorPrototype, 'next', function (this: Iterator<unknown>) {
              counted()
              return realArrayIteratorNext.call(this)
            }),
          ...realArrayFrom(
            { length: constants.WOTSC_LAYERS },
            (_, index) => () => patchAccessor(Array.prototype, index, { get: counted, set: counted })
          )
        ),
        trap => {
          const result = victim.signWithStats(pair.secretKey, trap(plain))
          // Restoring the patches iterates an array, so count only up to here.
          callsDuringSign = calls
          return result
        }
      )

      const result = expectClean<PqcSignWithStatsResult>(outcome)
      expect(callsDuringSign).toBe(0)
      expect(result).toEqual(reference.signWithStats(pair.secretKey, plain))
      expect(Object.getPrototypeOf(result.stats.wotscAttempts)).toBe(Array.prototype)
      expect(result.stats.wotscAttempts).toHaveLength(constants.WOTSC_LAYERS)
    })
  })

  describe('%TypedArray%.prototype methods patched after the module loaded', () => {
    it('copying into wasm memory does not depend on set', async () => {
      await freshVictim()
      const plain = messageBytes('patched-set')

      const outcome = underTrap(
        () => patchProperty(typedArrayPrototype, 'set', () => undefined),
        trap => victim.sign(pair.secretKey, trap(plain))
      )

      expect(expectClean(outcome)).toEqual(reference.sign(pair.secretKey, plain))
    })

    it('copying out of wasm memory does not depend on Symbol.species', async () => {
      await freshVictim()
      const plain = messageBytes('patched-species')
      class OneByteLonger extends RealUint8Array {
        constructor(length: number) {
          super(length + 1)
        }
      }

      const outcome = underTrap(
        () => patchProperty(RealUint8Array, Symbol.species, OneByteLonger),
        trap => victim.signWithStats(pair.secretKey, trap(plain))
      )

      const result = expectClean<PqcSignWithStatsResult>(outcome)
      expect(result.sig).toEqual(reference.sign(pair.secretKey, plain))
      expect(Object.getPrototypeOf(result.sig)).toBe(realUint8ArrayPrototype)
    })

    it('wasm copies of the secret key are zeroed without depending on fill', async () => {
      await freshVictim()
      const plain = messageBytes('patched-fill')
      const skPrf = pair.secretKey.slice(SPX_N, 2 * SPX_N)

      const outcome = underTrap(
        () => patchProperty(typedArrayPrototype, 'fill', () => undefined),
        trap => victim.sign(pair.secretKey, trap(plain))
      )

      expect(expectClean(outcome)).toEqual(reference.sign(pair.secretKey, plain))
      expect(scanHeap(victimModule, skPrf)).toEqual([])
    })
  })

  describe('%TypedArray% and DataView prototype members patched around the derivePQCKey hash', () => {
    let copy: RecordingCopy
    const wasmBinary = readFileSync(new URL('../wasm/pqc.wasm', import.meta.url))

    beforeAll(async () => {
      copy = await loadRecordingCopy()
    })

    // A client of the recording copy, on a fresh heap-guarded module. The copy
    // runs from a data: URL, where its import of the embedded pqc.wasm cannot
    // resolve, so it is given the bytes.
    async function recordingVictim(): Promise<PqcClient> {
      const { module } = await freshClient()
      guard = guardHeap(module)
      victim = await copy.init({ createModule: async () => module, wasmBinary })
      victimModule = module
      return victim
    }

    // Derives every qbit Core vector with `install` in place and masterSeed
    // behind a counting Proxy. Checks each key, and that the call left no
    // non-zero byte in any array it allocated other than the key it returned
    // and views on the caller's masterSeed or on wasm memory (which the
    // secret-residue tests cover).
    function deriveCoreVectors(install: Install, beforeCall?: (masterSeed: Uint8Array) => void): void {
      for (const vector of derivationVectors) {
        const { account, change, index } = vector.hkdf
        const seed = hexBytes(vector.masterSeedHex)
        let masterSeed: Uint8Array | undefined
        copy.created.length = 0

        const outcome = underTrap(install, trap => {
          masterSeed = trap(seed)
          beforeCall?.(masterSeed)
          return victim.derivePQCKey(masterSeed, account, change, index)
        })

        const derived = expectClean<PqcDerivedKey>(outcome)
        expect(hex(derived.pk32), vector.name).toBe(vector.publicKeyHex)
        expect(hex(derived.sk64), vector.name).toBe(vector.secretKeyHex)
        const kept = [masterSeed!.buffer, victimModule.HEAPU8.buffer]
        const leftovers = copy.created.filter(
          array =>
            array !== derived.pk32 &&
            array !== derived.sk64 &&
            !kept.includes(array.buffer) &&
            array.some(value => value !== 0)
        )
        expect(
          leftovers.map(array => `${array.constructor.name}(${array.length})`),
          vector.name
        ).toEqual([])
        // Control: the recorded arrays include the entropy derived for keygen.
        expect(
          copy.created.some(array => array.length === constants.MIN_ENTROPY),
          vector.name
        ).toBe(true)
      }
    }

    it.each(hashPatches)('derives qbit Core keys and zeroes its buffers with %s patched', async (_name, patch) => {
      await recordingVictim()
      let calls = 0

      deriveCoreVectors(
        patch(() => {
          calls += 1
        })
      )

      expect(calls).toBe(0)
    })

    it('never runs a length getter that would detach masterSeed and patch the hash mid-call', async () => {
      await recordingVictim()
      let masterSeed: Uint8Array | undefined
      let getterCalls = 0
      const install: Install = () => {
        const nested: Array<() => void> = []
        const uninstallLength = patchAccessor(typedArrayPrototype, 'length', {
          get(this: Uint8Array) {
            getterCalls += 1
            if (getterCalls === 1) {
              // Runs inside the call: detach the caller's masterSeed after
              // validation, then patch the rest of what the hash used.
              const buffer = masterSeed!.buffer
              structuredClone(buffer, { transfer: [buffer] })
              nested.push(
                patchProperty(typedArrayPrototype, 'set', () => undefined),
                patchProperty(typedArrayPrototype, 'fill', function (this: Uint8Array) {
                  return this
                }),
                patchProperty(RealDataView.prototype, 'setUint32', () => undefined),
                patchProperty(RealDataView.prototype, 'getUint32', () => 0)
              )
            }
            return realLengthGetter.call(this) as number
          },
        })
        return () => {
          for (const uninstall of nested.reverse()) {
            uninstall()
          }
          uninstallLength()
        }
      }

      deriveCoreVectors(install, seed => {
        masterSeed = seed
      })

      expect(getterCalls).toBe(0)
    })
  })
})
