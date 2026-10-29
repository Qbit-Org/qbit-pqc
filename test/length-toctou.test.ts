import { beforeAll, describe, expect, it, vi } from 'vitest'

import { constants, type PqcClient, type PqcKeyPair, type PqcWasmModule } from '../src/index'
import { freshClient } from './fresh-client'

// Follow-up regression coverage for detached inputs. The entry check added
// for them ran once per argument, but each function then re-read
// `msg.length` when deciding whether to copy the message, and every copy
// trusted the overridable `.length` getter. Three ways to exploit that gap:
//
//  D1  `_malloc` may grow the wasm memory, which detaches the previous heap
//      buffer. A msg that is a view into the module's `HEAPU8` was therefore
//      detached by the first copy (sk or pk), re-read as length 0 and signed or
//      verified as the empty message. No caller-side user code is needed.
//  D2  A subclass `length` getter on another argument (sk, pk or sig) runs
//      after msg was checked and can detach msg before it is copied.
//  D3  A subclass `length` getter that lies about its length makes the wrapper
//      sign the wrong bytes (reported 0: the empty message) or copy more bytes
//      than it allocated (reported smaller than real: wasm heap overflow).
//
// The fix reads every length once through the intrinsic %TypedArray% getter
// and copies a fixed-length view, so a detach after validation surfaces as the
// same TypeError as the entry check. All key material is synthetic.

const DETACHED_ERROR = /must not be a view on a detached or out-of-bounds ArrayBuffer/
const BLOCK_BYTES = 1 << 20
const detachedDescriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')

function syntheticEntropy(seedByte: number): Uint8Array {
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 97) % 256)) & 0xff
  }
  return entropy
}

function messageBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`qbit-pqc-length-toctou:${label}`)
}

function detach(view: Uint8Array): void {
  const buffer = view.buffer as ArrayBuffer
  structuredClone(buffer, { transfer: [buffer] })
  expect(view.length).toBe(0)
}

function detachedCopy(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes)
  detach(copy)
  return copy
}

function withReportedLength(bytes: Uint8Array, reported: number): Uint8Array {
  class LyingLength extends Uint8Array {
    override get length(): number {
      return reported
    }
  }
  return new LyingLength(bytes)
}

function errorFrom(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

// --- D1 helpers -------------------------------------------------------------
//
// dlmalloc is deterministic for an identical allocation sequence on a fresh
// instance, so the number of allocations a fresh module accepts before growing
// is measured once on throwaway instances and replayed on the instance under
// test. Large blocks get close to the growth point quickly; the exact size the
// wrapper's first copyIn will request finishes the job.

function allocate(module: PqcWasmModule, count: number, size: number): number {
  let first = 0
  for (let i = 0; i < count; i += 1) {
    const ptr = module._malloc(size)
    expect(ptr).not.toBe(0)
    if (i === 0) {
      first = ptr
    }
  }
  return first
}

function countMallocsBeforeGrowth(module: PqcWasmModule, size: number): number {
  const buffer = module.HEAPU8.buffer
  let count = 0
  while (module.HEAPU8.buffer === buffer) {
    expect(module._malloc(size)).not.toBe(0)
    count += 1
  }
  // The last allocation is the one that grew the memory.
  return count - 1
}

let blocksBeforeGrowth: Promise<number> | undefined
const fillsBeforeGrowth = new Map<number, Promise<number>>()

function calibrateGrowth(size: number): Promise<{ blocks: number; fills: number }> {
  blocksBeforeGrowth ??= freshClient().then(probe => countMallocsBeforeGrowth(probe.module, BLOCK_BYTES))
  let fills = fillsBeforeGrowth.get(size)
  if (fills === undefined) {
    fills = (async () => {
      const { module: probe } = await freshClient()
      allocate(probe, await blocksBeforeGrowth!, BLOCK_BYTES)
      return countMallocsBeforeGrowth(probe, size)
    })()
    fillsBeforeGrowth.set(size, fills)
  }
  return Promise.all([blocksBeforeGrowth, fills]).then(([blocks, fills]) => ({ blocks, fills }))
}

interface GrowthFixture {
  client: PqcClient
  module: PqcWasmModule
  // A msg view into the module's own heap, attached when returned.
  msg: Uint8Array
  plain: Uint8Array
}

// Returns a fresh client whose next `_malloc(nextMallocSize)` grows the wasm
// memory (detaching every existing view into its module's `HEAPU8`), plus a
// message stored inside that heap.
async function clientWhoseNextMallocGrows(nextMallocSize: number, label: string): Promise<GrowthFixture> {
  const { blocks, fills } = await calibrateGrowth(nextMallocSize)
  expect(blocks).toBeGreaterThan(0)
  const { client, module } = await freshClient()
  const buffer = module.HEAPU8.buffer
  const scratch = allocate(module, blocks, BLOCK_BYTES)
  allocate(module, fills, nextMallocSize)
  expect(module.HEAPU8.buffer).toBe(buffer)

  const plain = messageBytes(label)
  module.HEAPU8.set(plain, scratch)
  const msg = module.HEAPU8.subarray(scratch, scratch + plain.length)
  expect(msg.buffer).toBe(buffer)
  expect(msg).toEqual(plain)
  return { client, module, msg, plain }
}

describe('length re-reads after validation (TOCTOU)', () => {
  let client: PqcClient
  let module: PqcWasmModule
  let pair: PqcKeyPair
  let emptyMessageSignature: Uint8Array

  beforeAll(async () => {
    ;({ client, module } = await freshClient())
    pair = client.keygen(syntheticEntropy(0x71))
    emptyMessageSignature = client.sign(pair.secretKey, new Uint8Array(0))
  })

  describe('D1: msg is a view into the wasm heap that memory growth detaches mid-call', () => {
    it('verify throws instead of accepting an empty-message signature', async () => {
      // verify's first copy is pk, so its malloc(PK_SIZE) is the one that grows.
      const { client: victim, msg, plain } = await clientWhoseNextMallocGrows(constants.PK_SIZE, 'verify')
      const heapBefore = victim.wasmHeapBytes()

      const error = errorFrom(() => victim.verify(pair.publicKey, msg, emptyMessageSignature))

      expect(victim.wasmHeapBytes()).toBeGreaterThan(heapBefore)
      expect(msg.length).toBe(0)
      expect(error).toBeInstanceOf(TypeError)
      expect((error as TypeError).message).toMatch(DETACHED_ERROR)
      // The instance is still usable after the failed call released its allocations.
      const signature = client.sign(pair.secretKey, plain)
      expect(victim.verify(pair.publicKey, plain, signature)).toBe(true)
      expect(victim.verify(pair.publicKey, plain, emptyMessageSignature)).toBe(false)
    })

    it('sign throws instead of signing the empty message', async () => {
      // sign's first copy is sk, so its malloc(SK_SIZE) is the one that grows.
      const { client: victim, msg, plain } = await clientWhoseNextMallocGrows(constants.SK_SIZE, 'sign')

      const error = errorFrom(() => victim.sign(pair.secretKey, msg))

      expect(msg.length).toBe(0)
      expect(error).toBeInstanceOf(TypeError)
      expect((error as TypeError).message).toMatch(DETACHED_ERROR)
      expect(victim.sign(pair.secretKey, plain)).toEqual(client.sign(pair.secretKey, plain))
    })

    it('signWithStats throws instead of signing the empty message', async () => {
      const { client: victim, msg } = await clientWhoseNextMallocGrows(constants.SK_SIZE, 'signWithStats')

      const error = errorFrom(() => victim.signWithStats(pair.secretKey, msg))

      expect(msg.length).toBe(0)
      expect(error).toBeInstanceOf(TypeError)
      expect((error as TypeError).message).toMatch(DETACHED_ERROR)
    })

    it('keygen throws when its entropy lives in the heap it grows', async () => {
      const { client: victim, module, msg: scratch } = await clientWhoseNextMallocGrows(constants.MIN_ENTROPY, 'keygen')
      // Overwrite the fixture's message with the entropy; same heap, same growth.
      const start = scratch.byteOffset
      module.HEAPU8.set(syntheticEntropy(0x19), start)
      const entropy = module.HEAPU8.subarray(start, start + constants.MIN_ENTROPY)

      const error = errorFrom(() => victim.keygen(entropy))

      expect(entropy.length).toBe(0)
      expect(error).toBeInstanceOf(TypeError)
      expect((error as TypeError).message).toMatch(DETACHED_ERROR)
    })
  })

  describe('D2: another argument runs user code that detaches msg after it was checked', () => {
    it('never consults a subclass length getter, so sig/sk getters cannot detach msg', () => {
      const plain = messageBytes('d2-length-getter')
      const msg = new Uint8Array(plain)
      let getterCalls = 0
      class DetachingLength extends Uint8Array {
        override get length(): number {
          getterCalls += 1
          detach(msg)
          return super.length
        }
      }
      const realSignature = client.sign(pair.secretKey, plain)

      expect(client.verify(pair.publicKey, msg, new DetachingLength(emptyMessageSignature))).toBe(false)
      expect(client.verify(pair.publicKey, msg, new DetachingLength(realSignature))).toBe(true)
      expect(client.verify(new DetachingLength(pair.publicKey), msg, realSignature)).toBe(true)
      expect(client.sign(new DetachingLength(pair.secretKey), msg)).toEqual(realSignature)
      expect(client.signWithStats(new DetachingLength(pair.secretKey), msg).sig).toEqual(realSignature)
      expect(getterCalls).toBe(0)
      expect(msg.length).toBe(plain.length)
    })

    it('never consults buffer or detached accessors, so they cannot detach msg either', () => {
      const plain = messageBytes('d2-buffer-getter')
      const msg = new Uint8Array(plain)
      let accessorCalls = 0
      class DetachingBufferGetter extends Uint8Array {
        override get buffer(): ArrayBuffer {
          accessorCalls += 1
          detach(msg)
          return { detached: true } as unknown as ArrayBuffer
        }
      }
      class DetachingDetachedGetter extends ArrayBuffer {
        get detached(): boolean {
          accessorCalls += 1
          detach(msg)
          return false
        }
      }
      const realSignature = client.sign(pair.secretKey, plain)
      const sigOverGetter = new DetachingBufferGetter(emptyMessageSignature)
      const sigOverSubclassBuffer = new Uint8Array(new DetachingDetachedGetter(constants.SIG_SIZE))
      sigOverSubclassBuffer.set(emptyMessageSignature)

      expect(client.verify(pair.publicKey, msg, sigOverGetter)).toBe(false)
      expect(client.verify(pair.publicKey, msg, sigOverSubclassBuffer)).toBe(false)
      expect(client.verify(pair.publicKey, msg, new DetachingBufferGetter(realSignature))).toBe(true)
      expect(accessorCalls).toBe(0)
      expect(msg.length).toBe(plain.length)
    })
  })

  describe('D3: the overridable length getter is not trusted', () => {
    it('sign and verify use the real msg length when the getter reports 0', () => {
      const plain = messageBytes('d3-zero')
      const realSignature = client.sign(pair.secretKey, plain)

      const signature = client.sign(pair.secretKey, withReportedLength(plain, 0))

      expect(signature).toEqual(realSignature)
      expect(signature).not.toEqual(emptyMessageSignature)
      expect(client.signWithStats(pair.secretKey, withReportedLength(plain, 0)).sig).toEqual(realSignature)
      expect(client.verify(pair.publicKey, withReportedLength(plain, 0), emptyMessageSignature)).toBe(false)
      expect(client.verify(pair.publicKey, withReportedLength(plain, 0), realSignature)).toBe(true)
    })

    it('copies the real msg length when the getter under-reports it', async () => {
      const plain = new Uint8Array(64)
      plain.set(messageBytes('d3-under'))
      const realSignature = client.sign(pair.secretKey, plain)
      // Own instance: before the fix this overflowed the 1-byte wasm allocation.
      const { client: victim } = await freshClient()

      expect(victim.sign(pair.secretKey, withReportedLength(plain, 1))).toEqual(realSignature)
      expect(victim.verify(pair.publicKey, withReportedLength(plain, 1), realSignature)).toBe(true)
      expect(victim.verify(pair.publicKey, plain, realSignature)).toBe(true)
    })

    it('signs the real msg when the getter over-reports its length', () => {
      const plain = messageBytes('d3-over')

      expect(client.sign(pair.secretKey, withReportedLength(plain, plain.length + 100))).toEqual(
        client.sign(pair.secretKey, plain)
      )
    })

    it('rejects keys, signatures and entropy whose getter over-reports their length', () => {
      const msg = messageBytes('d3-keys')
      const signature = client.sign(pair.secretKey, msg)
      const shortSk = withReportedLength(pair.secretKey.subarray(0, 10), constants.SK_SIZE)
      const shortPk = withReportedLength(pair.publicKey.subarray(0, 10), constants.PK_SIZE)
      const shortSig = withReportedLength(signature.subarray(0, 10), constants.SIG_SIZE)
      const shortEntropy = withReportedLength(new Uint8Array(10), constants.MIN_ENTROPY)

      expect(() => client.sign(shortSk, msg)).toThrow(RangeError)
      expect(() => client.sign(shortSk, msg)).toThrow('sk must be 64 bytes, got 10')
      expect(() => client.signWithStats(shortSk, msg)).toThrow(RangeError)
      expect(() => client.secretKeyValidate(shortSk)).toThrow(RangeError)
      expect(() => client.keygen(shortEntropy)).toThrow(RangeError)

      // verify answers false for a wrong-length key or signature. It must
      // decide that from the real length, before allocating any wasm memory.
      const malloc = vi.spyOn(module, '_malloc')
      try {
        expect(client.verify(shortPk, msg, signature)).toBe(false)
        expect(client.verify(pair.publicKey, msg, shortSig)).toBe(false)
        expect(malloc).not.toHaveBeenCalled()
      } finally {
        malloc.mockRestore()
      }
    })

    it('derivePQCKey uses the real masterSeed length', () => {
      const seed = messageBytes('d3-seed')
      const expected = client.derivePQCKey(seed, 0, 0, 0)

      expect(client.derivePQCKey(withReportedLength(seed, 0), 0, 0, 0)).toEqual(expected)
      expect(client.derivePQCKey(withReportedLength(seed, seed.length + 100), 0, 0, 0)).toEqual(expected)
      expect(() => client.derivePQCKey(withReportedLength(new Uint8Array(0), 5), 0, 0, 0)).toThrow(RangeError)
    })

    it('deriveP2mrDescriptorKey checks the real leafPrivateKey length', () => {
      const leaf = syntheticEntropy(0x2b).subarray(0, 32)
      const expected = client.deriveP2mrDescriptorKey(leaf, 0)
      const shortLeaf = withReportedLength(leaf.subarray(1), 32)

      expect(client.deriveP2mrDescriptorKey(withReportedLength(leaf, 31), 0)).toEqual(expected)
      expect(() => client.deriveP2mrDescriptorKey(shortLeaf, 0)).toThrow(RangeError)
      expect(() => client.deriveP2mrDescriptorKey(shortLeaf, 0)).toThrow('leafPrivateKey must be 32 bytes, got 31')
    })
  })

  describe('the attachment probe consults only the intrinsic captured at module load', () => {
    it('accepts attached views whose buffer accessor or buffer spoofs detached: true', () => {
      const plain = messageBytes('spoofed-detached')
      class SpoofedBuffer extends Uint8Array {
        override get buffer(): ArrayBuffer {
          return { detached: true } as unknown as ArrayBuffer
        }
      }
      const spoofedGetter = new SpoofedBuffer(plain)
      const ownProperty = new Uint8Array(plain)
      Object.defineProperty(ownProperty.buffer, 'detached', { value: true })
      expect((ownProperty.buffer as { detached?: unknown }).detached).toBe(true)

      const signature = client.sign(pair.secretKey, plain)
      expect(client.sign(pair.secretKey, spoofedGetter)).toEqual(signature)
      expect(client.sign(pair.secretKey, ownProperty)).toEqual(signature)
      expect(client.verify(pair.publicKey, spoofedGetter, signature)).toBe(true)
      expect(client.verify(pair.publicKey, ownProperty, signature)).toBe(true)
      expect(client.verify(pair.publicKey, ownProperty, emptyMessageSignature)).toBe(false)
    })

    it('still rejects detached views after %TypedArray%.prototype.values is patched', () => {
      const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as {
        values: () => IterableIterator<number>
      }
      const values = vi
        .spyOn(typedArrayPrototype, 'values')
        .mockReturnValue([][Symbol.iterator]() as IterableIterator<number>)
      // Pre-ES2024 runtimes have no ArrayBuffer.prototype.detached; where it
      // exists it is hidden too, so only the captured probe can reject the view.
      const detached =
        detachedDescriptor === undefined
          ? undefined
          : vi.spyOn(ArrayBuffer.prototype, 'detached', 'get').mockReturnValue(undefined as unknown as boolean)
      try {
        const msg = detachedCopy(messageBytes('patched-values'))
        expect(() => new Uint8Array(1).values()).not.toThrow()

        expect(() => client.sign(pair.secretKey, msg)).toThrow(DETACHED_ERROR)
        expect(() => client.verify(pair.publicKey, msg, emptyMessageSignature)).toThrow(DETACHED_ERROR)
      } finally {
        values.mockRestore()
        detached?.mockRestore()
      }
    })
  })
})
