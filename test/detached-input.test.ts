import { beforeAll, describe, expect, it, vi } from 'vitest'

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
  type PqcClient,
  type PqcKeyPair,
} from '../src/index'

// Regression coverage for detached inputs: once an ArrayBuffer is
// transferred (postMessage transfer lists, structuredClone, ArrayBuffer
// .prototype.transfer) every view on it is detached and reports length 0
// without throwing. The wrapper used to pass that through as the empty
// message, so sign() returned a signature over "" and verify() accepted any
// empty-message signature for whatever message the caller meant to check.
// All key material here is synthetic and derived from fixed test entropy.

const DETACHED_ERROR = /must not be a view on a detached or out-of-bounds ArrayBuffer/

function syntheticEntropy(seedByte: number): Uint8Array {
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 61) % 256)) & 0xff
  }
  return entropy
}

function messageBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`qbit-pqc-detached-input:${label}`)
}

// Returns a copy of `bytes` whose backing buffer is then detached by a
// structured-clone transfer, exactly as postMessage(..., [buffer]) would do.
function detachedCopy(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes)
  const buffer = copy.buffer as ArrayBuffer
  structuredClone(buffer, { transfer: [buffer] })
  expect(copy.length).toBe(0)
  return copy
}

function sharedCopy(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(new SharedArrayBuffer(bytes.length))
  copy.set(bytes)
  return copy
}

type ResizableArrayBufferCtor = new (
  byteLength: number,
  options: { maxByteLength: number }
) => ArrayBuffer & { resize(byteLength: number): void }

const ResizableArrayBuffer = ArrayBuffer as unknown as ResizableArrayBufferCtor
const supportsResizableBuffers = typeof (ArrayBuffer.prototype as { resize?: unknown }).resize === 'function'

const detachedDescriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')

describe('detached and out-of-bounds byte inputs', () => {
  let client: PqcClient
  let pair: PqcKeyPair
  let emptyMessageSignature: Uint8Array

  beforeAll(async () => {
    client = await init()
    pair = client.keygen(syntheticEntropy(0x3c))
    emptyMessageSignature = client.sign(pair.secretKey, new Uint8Array(0))
  })

  it('sign rejects a detached msg instead of signing the empty message', () => {
    const msg = detachedCopy(messageBytes('sign'))

    expect(() => client.sign(pair.secretKey, msg)).toThrow(TypeError)
    expect(() => client.sign(pair.secretKey, msg)).toThrow(DETACHED_ERROR)
    expect(() => sign(pair.secretKey, msg)).toThrow(TypeError)
  })

  it('signWithStats rejects a detached msg', () => {
    const msg = detachedCopy(messageBytes('signWithStats'))

    expect(() => client.signWithStats(pair.secretKey, msg)).toThrow(TypeError)
    expect(() => signWithStats(pair.secretKey, msg)).toThrow(TypeError)
  })

  it('verify throws for a detached msg instead of accepting an empty-message signature', () => {
    const msg = detachedCopy(messageBytes('verify'))

    expect(() => client.verify(pair.publicKey, msg, emptyMessageSignature)).toThrow(TypeError)
    expect(() => verify(pair.publicKey, msg, emptyMessageSignature)).toThrow(TypeError)
  })

  it('rejects detached sk, pk and sig with a TypeError', () => {
    const msg = messageBytes('keys')
    const signature = client.sign(pair.secretKey, msg)

    expect(() => client.sign(detachedCopy(pair.secretKey), msg)).toThrow(TypeError)
    expect(() => client.signWithStats(detachedCopy(pair.secretKey), msg)).toThrow(TypeError)
    expect(() => client.verify(detachedCopy(pair.publicKey), msg, signature)).toThrow(TypeError)
    expect(() => client.verify(pair.publicKey, msg, detachedCopy(signature))).toThrow(TypeError)
    expect(() => client.secretKeyValidate(detachedCopy(pair.secretKey))).toThrow(TypeError)
    expect(() => secretKeyValidate(detachedCopy(pair.secretKey))).toThrow(TypeError)
  })

  it('keygen rejects detached entropy', () => {
    const entropy = detachedCopy(syntheticEntropy(0x5e))

    expect(() => client.keygen(entropy)).toThrow(TypeError)
    expect(() => keygen(entropy)).toThrow(TypeError)
  })

  it('derivePQCKey rejects a detached masterSeed', () => {
    const masterSeed = detachedCopy(messageBytes('masterSeed'))

    expect(() => client.derivePQCKey(masterSeed, 0, 0, 0)).toThrow(TypeError)
    expect(() => derivePQCKey(masterSeed, 0, 0, 0)).toThrow(TypeError)
  })

  it('deriveP2mrDescriptorKey rejects a detached leafPrivateKey instead of a wrong length', () => {
    const leafPrivateKey = detachedCopy(syntheticEntropy(0x2b).slice(0, 32))

    expect(() => client.deriveP2mrDescriptorKey(leafPrivateKey, 0)).toThrow(DETACHED_ERROR)
    expect(() => deriveP2mrDescriptorKey(leafPrivateKey, 0)).toThrow(TypeError)
  })

  it('still signs and verifies an explicit zero-length msg', () => {
    const signature = client.sign(pair.secretKey, new Uint8Array(0))

    expect(signature).toHaveLength(constants.SIG_SIZE)
    expect(signature).toEqual(emptyMessageSignature)
    expect(client.verify(pair.publicKey, new Uint8Array(0), signature)).toBe(true)
    expect(client.verify(pair.publicKey, new Uint8Array(1), signature)).toBe(false)
    expect(client.signWithStats(pair.secretKey, new Uint8Array(0)).sig).toEqual(signature)
  })

  it('accepts SharedArrayBuffer-backed views', () => {
    const msg = sharedCopy(messageBytes('shared'))
    const signature = client.sign(sharedCopy(pair.secretKey), msg)

    expect(client.verify(sharedCopy(pair.publicKey), msg, sharedCopy(signature))).toBe(true)
    expect(client.secretKeyValidate(sharedCopy(pair.secretKey))).toBe(true)
  })

  it.runIf(supportsResizableBuffers)('accepts in-bounds views on a resizable ArrayBuffer', () => {
    const plain = messageBytes('resizable')
    const buffer = new ResizableArrayBuffer(plain.length, { maxByteLength: plain.length * 2 })
    const msg = new Uint8Array(buffer)
    msg.set(plain)

    const signature = client.sign(pair.secretKey, msg)
    expect(client.verify(pair.publicKey, msg, signature)).toBe(true)
    expect(client.verify(pair.publicKey, plain, signature)).toBe(true)
  })

  it.runIf(supportsResizableBuffers)('rejects a view pushed out of bounds by shrinking a resizable ArrayBuffer', () => {
    const plain = messageBytes('shrunk')
    const buffer = new ResizableArrayBuffer(plain.length + 8, { maxByteLength: plain.length + 8 })
    const msg = new Uint8Array(buffer, 8, plain.length)
    msg.set(plain)
    buffer.resize(4)
    expect(msg.length).toBe(0)

    expect(() => client.sign(pair.secretKey, msg)).toThrow(TypeError)
    expect(() => client.sign(pair.secretKey, msg)).toThrow(DETACHED_ERROR)
    expect(() => client.verify(pair.publicKey, msg, emptyMessageSignature)).toThrow(TypeError)
  })

  it('rejects detached and out-of-bounds Node Buffer views despite Buffer.prototype.slice', () => {
    const plain = messageBytes('buffer')
    // Buffer.from(bytes) would share Node's untransferable pool, so give it its own ArrayBuffer.
    const backing = new ArrayBuffer(plain.length)
    const detachedBuffer = Buffer.from(backing)
    detachedBuffer.set(plain)
    structuredClone(backing, { transfer: [backing] })
    expect(detachedBuffer.length).toBe(0)

    expect(() => client.sign(pair.secretKey, detachedBuffer)).toThrow(TypeError)
    expect(() => client.verify(pair.publicKey, detachedBuffer, emptyMessageSignature)).toThrow(TypeError)

    if (supportsResizableBuffers) {
      const resizable = new ResizableArrayBuffer(plain.length + 8, { maxByteLength: plain.length + 8 })
      const shrunk = Buffer.from(resizable, 8, plain.length)
      shrunk.set(plain)
      resizable.resize(4)
      expect(shrunk.length).toBe(0)
      // Buffer.prototype.slice is subarray-based and does not validate its receiver.
      expect(() => shrunk.slice(0, 0)).not.toThrow()

      expect(() => client.sign(pair.secretKey, shrunk)).toThrow(TypeError)
      expect(() => client.verify(pair.publicKey, shrunk, emptyMessageSignature)).toThrow(TypeError)
    }
  })

  it('accepts attached views of a Uint8Array subclass with a throwing Symbol.species', () => {
    class HostileSpecies extends Uint8Array {
      static override get [Symbol.species](): Uint8ArrayConstructor {
        return function () {
          throw new Error('species constructor must not run')
        } as unknown as Uint8ArrayConstructor
      }
    }
    const msg = new HostileSpecies(messageBytes('species'))
    expect(() => msg.slice(0, 0)).toThrow('species constructor must not run')

    const signature = client.sign(pair.secretKey, msg)
    expect(client.verify(pair.publicKey, msg, signature)).toBe(true)
    expect(client.verify(pair.publicKey, messageBytes('species'), signature)).toBe(true)
  })

  it.runIf(detachedDescriptor !== undefined)(
    'still rejects detached views when ArrayBuffer.prototype.detached is unavailable',
    () => {
      const getter = vi.spyOn(ArrayBuffer.prototype, 'detached', 'get').mockReturnValue(undefined)
      try {
        const msg = detachedCopy(messageBytes('legacy-runtime'))
        expect((msg.buffer as { detached?: unknown }).detached).toBeUndefined()

        expect(() => client.sign(pair.secretKey, msg)).toThrow(TypeError)
        expect(() => client.verify(pair.publicKey, msg, emptyMessageSignature)).toThrow(TypeError)
        expect(client.verify(pair.publicKey, new Uint8Array(0), emptyMessageSignature)).toBe(true)
      } finally {
        getter.mockRestore()
      }
      expect((new ArrayBuffer(0) as { detached?: unknown }).detached).toBe(false)
    }
  )
})
