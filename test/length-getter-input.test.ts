import { runInNewContext } from 'node:vm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  constants,
  deriveP2mrDescriptorKey,
  derivePQCKey,
  init,
  keygen,
  secretKeyValidate,
  sign,
  signWithStats,
  verify,
  type PqcWasmModule,
} from '../src/index'
import { freshClient } from './fresh-client'

// A Uint8Array from any realm can carry an own or inherited `length` getter. If
// the wrapper read it, the getter could report different values on different
// reads: a smaller value would shrink the malloc while the copy still moves
// every element (wasm heap overflow), 0 would turn `msg` into the empty
// message, and a larger value would make native code read past the copied
// bytes. The wrapper measures every input once through the intrinsic
// %TypedArray% getter and never invokes the argument's `length`, so each case
// below must use the real bytes without reading the getter at all. Unlike
// length-toctou.test.ts, every entry point runs on a heap-guarded module that
// also checks for writes past an allocation and for allocations freed without
// being zeroed.

// Larger than any input used here, so an overflow lands in the guard area
// instead of corrupting the allocator.
const GUARD_BYTES = 4096
const CANARY = 0xa5

interface HeapGuard {
  readonly problems: string[]
  readonly live: Map<number, number>
  allocations: number
  // Runs inside a public call, before each wrapper allocation, the way code
  // in a custom module factory could.
  beforeMalloc?: () => void
}

// Every wrapper allocation gets GUARD_BYTES of canary after it. On free, the
// canary must be intact and the allocation must have been zeroed.
async function initWithHeapGuard(): Promise<HeapGuard> {
  const { module: real } = await freshClient()
  const guard: HeapGuard = { problems: [], live: new Map(), allocations: 0 }
  const { problems, live } = guard
  const guarded = Object.create(real) as PqcWasmModule
  guarded._malloc = byteLength => {
    guard.beforeMalloc?.()
    const ptr = real._malloc(byteLength + GUARD_BYTES)
    if (ptr !== 0) {
      real.HEAPU8.fill(CANARY, ptr + byteLength, ptr + byteLength + GUARD_BYTES)
      live.set(ptr, byteLength)
      guard.allocations += 1
    }
    return ptr
  }
  guarded._free = ptr => {
    const byteLength = live.get(ptr)
    if (byteLength === undefined) {
      problems.push(`free of unknown pointer ${ptr}`)
    } else {
      const heap = real.HEAPU8
      if (heap.subarray(ptr + byteLength, ptr + byteLength + GUARD_BYTES).some(b => b !== CANARY)) {
        problems.push(`write past the end of a ${byteLength}-byte allocation`)
      }
      if (heap.subarray(ptr, ptr + byteLength).some(b => b !== 0)) {
        problems.push(`${byteLength}-byte allocation freed without being zeroed`)
      }
      live.delete(ptr)
    }
    real._free(ptr)
  }
  await init({ createModule: async () => guarded })
  return guard
}

type LengthGetterHome = 'own' | 'inherited'

// A foreign-realm Uint8Array whose `length` getter returns each of `lengths`
// in turn and then keeps returning the last one.
function lyingLength(
  bytes: Uint8Array,
  lengths: readonly number[],
  home: LengthGetterHome = 'own'
): { value: Uint8Array; reads: () => number } {
  const value = runInNewContext('Uint8Array.from(source)', {
    source: Array.from(bytes),
  }) as Uint8Array
  let reads = 0
  const length = { get: () => lengths[Math.min(reads++, lengths.length - 1)] }
  if (home === 'own') {
    Object.defineProperty(value, 'length', length)
  } else {
    Object.setPrototypeOf(value, Object.create(Object.getPrototypeOf(value) as object, { length }))
  }
  return { value, reads: () => reads }
}

function patternBytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (seed + i * 29) & 0xff)
}

interface Case {
  name: string
  input: () => Uint8Array
  call: (arg: Uint8Array) => unknown
  expected: () => unknown
}

describe('Uint8Array inputs whose length getter changes between reads', () => {
  let guard: HeapGuard

  const entropy = patternBytes(constants.MIN_ENTROPY, 7)
  const masterSeed = patternBytes(64, 11)
  const leafPrivateKey = patternBytes(32, 13)
  const message = patternBytes(48, 3)
  let pair: { publicKey: Uint8Array; secretKey: Uint8Array }
  let signature: Uint8Array
  let withStats: unknown
  let derived: unknown
  let descriptorKey: unknown

  beforeAll(async () => {
    guard = await initWithHeapGuard()
    pair = keygen(entropy)
    signature = sign(pair.secretKey, message)
    withStats = signWithStats(pair.secretKey, message)
    derived = derivePQCKey(masterSeed, 0, 1, 2)
    descriptorKey = deriveP2mrDescriptorKey(leafPrivateKey, 2)
  })

  beforeEach(() => {
    guard.problems.length = 0
  })

  function expectCleanHeap(): void {
    expect(guard.problems).toEqual([])
    expect(guard.live.size).toBe(0)
  }

  const cases: Case[] = [
    { name: 'keygen entropy', input: () => entropy, call: x => keygen(x), expected: () => pair },
    {
      name: 'derivePQCKey masterSeed',
      input: () => masterSeed,
      call: x => derivePQCKey(x, 0, 1, 2),
      expected: () => derived,
    },
    {
      name: 'deriveP2mrDescriptorKey leafPrivateKey',
      input: () => leafPrivateKey,
      call: x => deriveP2mrDescriptorKey(x, 2),
      expected: () => descriptorKey,
    },
    {
      name: 'sign sk',
      input: () => pair.secretKey,
      call: x => sign(x, message),
      expected: () => signature,
    },
    {
      name: 'sign msg',
      input: () => message,
      call: x => sign(pair.secretKey, x),
      expected: () => signature,
    },
    {
      name: 'signWithStats sk',
      input: () => pair.secretKey,
      call: x => signWithStats(x, message),
      expected: () => withStats,
    },
    {
      name: 'signWithStats msg',
      input: () => message,
      call: x => signWithStats(pair.secretKey, x),
      expected: () => withStats,
    },
    {
      name: 'verify pk',
      input: () => pair.publicKey,
      call: x => verify(x, message, signature),
      expected: () => true,
    },
    {
      name: 'verify msg',
      input: () => message,
      call: x => verify(pair.publicKey, x, signature),
      expected: () => true,
    },
    {
      name: 'verify sig',
      input: () => signature,
      call: x => verify(pair.publicKey, message, x),
      expected: () => true,
    },
    {
      name: 'secretKeyValidate sk',
      input: () => pair.secretKey,
      call: x => secretKeyValidate(x),
      expected: () => true,
    },
  ]

  // Whatever the getter would report, honest on the first read or not, the
  // wrapper never asks it.
  const lies: Array<[string, (real: number) => number[]]> = [
    ['real, then 1 (the Codex 128 -> 1 case)', real => [real, 1]],
    ['real twice, then 1 (past the size checks)', real => [real, real, 1]],
    ['real, then 0', real => [real, 0]],
    ['real twice, then larger', real => [real, real, real + 64]],
    ['0, then real', real => [0, real]],
    ['real - 1, then real', real => [real - 1, real]],
  ]

  describe.each(cases)('$name', ({ input, call, expected }) => {
    it.each(lies)(
      'uses the real bytes when the getter returns %s',
      (_label, lengths) => {
        const bytes = input()
        const liar = lyingLength(bytes, lengths(bytes.length))
        let outcome: unknown
        try {
          outcome = call(liar.value)
        } catch (error) {
          outcome = error
        }
        expectCleanHeap()
        expect(outcome).toEqual(expected())
        expect(liar.reads()).toBe(0)
      },
      15_000
    )
  })

  it('applies to an inherited length getter too', () => {
    const msg = lyingLength(message, [message.length, 1], 'inherited')
    expect(sign(pair.secretKey, msg.value)).toEqual(signature)
    expect(msg.reads()).toBe(0)

    const sig = lyingLength(signature, [signature.length, signature.length, 1], 'inherited')
    expect(verify(pair.publicKey, message, sig.value)).toBe(true)
    expect(sig.reads()).toBe(0)
    expectCleanHeap()
  }, 15_000)

  it('zeroes and frees earlier copies when an input is detached before it is copied', () => {
    const msg = message.slice()
    // Validation runs no caller code, so detach msg from inside the module's
    // allocator instead: pk has been copied in, and msg's allocation is the
    // second one.
    let mallocs = 0
    guard.beforeMalloc = () => {
      mallocs += 1
      if (mallocs === 2) structuredClone(msg.buffer, { transfer: [msg.buffer] })
    }
    const allocations = guard.allocations
    try {
      expect(() => verify(pair.publicKey, msg, signature)).toThrow(TypeError)
    } finally {
      guard.beforeMalloc = undefined
    }
    expect(msg.length).toBe(0)
    // pk was copied and msg's allocation was made before its copy failed.
    expect(guard.allocations - allocations).toBe(2)
    expectCleanHeap()
  })

  it('does not accept the empty-message signature for a message whose length drops to 0', () => {
    const emptySignature = sign(pair.secretKey, new Uint8Array(0))
    const msg = lyingLength(message, [message.length, 0])
    expect(verify(pair.publicKey, msg.value, emptySignature)).toBe(false)
    expectCleanHeap()
  }, 15_000)
})
