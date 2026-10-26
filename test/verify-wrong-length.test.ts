import { createContext, runInContext } from 'node:vm'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

import {
  constants,
  errorCodes,
  PqcError,
  verify,
  type PqcClient,
  type PqcKeyPair,
  type PqcWasmModule,
} from '../src/index'
import { freshClient } from './fresh-client'

// Regression coverage for wrong-length keys and signatures: verify threw a
// RangeError when pk was not PK_SIZE bytes or sig was not SIG_SIZE bytes. A
// server usually takes both from an untrusted client, so a truncated or empty
// signature became an exception (a failed request, or an uncaught error in a
// callback) instead of an invalid signature. qbit Core's CPQCPubKey::Verify
// returns false for the same input, and verify now does too, before it
// allocates any wasm memory. Each wrong-length input starts with the bytes of
// a key or signature that does verify, so only its length makes it invalid:
// an implementation that ignored trailing bytes would return true. All key
// material is synthetic.

// Four times the wasm heap a fresh instance starts with (16 MiB), so copying
// an input this large would have to grow the wasm memory.
const VERY_LARGE = 64 * 1024 * 1024
const DETACHED_ERROR = /must not be a view on a detached or out-of-bounds ArrayBuffer/

type VerifyFn = (pk: Uint8Array, msg: Uint8Array, sig: Uint8Array) => boolean
type MakeBytes = (bytes: Uint8Array, length: number) => Uint8Array

function syntheticEntropy(seedByte: number): Uint8Array {
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 41) % 256)) & 0xff
  }
  return entropy
}

function messageBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`qbit-pqc-verify-wrong-length:${label}`)
}

// `bytes` truncated or zero-padded to `length`.
const sameRealm: MakeBytes = (bytes, length) => {
  const out = new Uint8Array(length)
  out.set(bytes.subarray(0, length))
  return out
}

// The same, as a Uint8Array from a separate realm (as an iframe or worker
// would hand it over), for which `instanceof Uint8Array` is false.
const foreignRealm = createContext()
const otherRealm: MakeBytes = (bytes, length) => {
  const out = runInContext(`new Uint8Array(${length})`, foreignRealm) as Uint8Array
  expect(out instanceof Uint8Array).toBe(false)
  out.set(bytes.subarray(0, length))
  return out
}

function detachedCopy(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes)
  const buffer = copy.buffer as ArrayBuffer
  structuredClone(buffer, { transfer: [buffer] })
  expect(copy.length).toBe(0)
  return copy
}

const pkLengths: Array<[string, number]> = [
  ['empty', 0],
  ['one byte short', constants.PK_SIZE - 1],
  ['one byte long', constants.PK_SIZE + 1],
  ['very large', VERY_LARGE],
]

const sigLengths: Array<[string, number]> = [
  ['empty', 0],
  ['one byte short', constants.SIG_SIZE - 1],
  ['one byte long', constants.SIG_SIZE + 1],
  ['very large', VERY_LARGE],
]

describe('verify with a wrong-length pk or sig', () => {
  let client: PqcClient
  let module: PqcWasmModule
  let pair: PqcKeyPair
  let message: Uint8Array
  let signature: Uint8Array
  let malloc: MockInstance<PqcWasmModule['_malloc']>

  beforeAll(async () => {
    // The only init() in this file, so the named exports use this client too.
    ;({ client, module } = await freshClient())
    pair = client.keygen(syntheticEntropy(0x2b))
    message = messageBytes('signed')
    signature = client.sign(pair.secretKey, message)
  })

  beforeEach(() => {
    malloc = vi.spyOn(module, '_malloc')
  })

  afterEach(() => {
    malloc.mockRestore()
  })

  const entryPoints: Array<[string, () => VerifyFn]> = [
    ['the named export', () => verify],
    ['a client', () => client.verify],
  ]

  const realms: Array<[string, MakeBytes]> = [
    ['this realm', sameRealm],
    ['another realm', otherRealm],
  ]

  describe.each(entryPoints)('through %s', (_entryPoint, entry) => {
    describe.each(realms)('with arrays from %s', (_realm, make) => {
      // pk, msg and sig built by `make`, with pk and sig resized.
      function verifyResized(pkLength: number, sigLength: number): boolean {
        return entry()(
          make(pair.publicKey, pkLength),
          make(message, message.length),
          make(signature, sigLength)
        )
      }

      it('control: verifies the full-length pk and sig, copying them into wasm memory', () => {
        expect(verifyResized(constants.PK_SIZE, constants.SIG_SIZE)).toBe(true)
        expect(malloc).toHaveBeenCalledTimes(3)
      })

      it.each(pkLengths)('returns false for a pk that is %s (%i bytes)', (_label, length) => {
        const heapBytes = client.wasmHeapBytes()

        expect(verifyResized(length, constants.SIG_SIZE)).toBe(false)
        expect(malloc).not.toHaveBeenCalled()
        expect(client.wasmHeapBytes()).toBe(heapBytes)
      })

      it.each(sigLengths)('returns false for a sig that is %s (%i bytes)', (_label, length) => {
        const heapBytes = client.wasmHeapBytes()

        expect(verifyResized(constants.PK_SIZE, length)).toBe(false)
        expect(malloc).not.toHaveBeenCalled()
        expect(client.wasmHeapBytes()).toBe(heapBytes)
      })
    })
  })

  it('returns false when both pk and sig have the wrong length', () => {
    const longPk = sameRealm(pair.publicKey, constants.PK_SIZE + 1)
    const shortSig = sameRealm(signature, constants.SIG_SIZE - 1)

    expect(verify(new Uint8Array(0), message, new Uint8Array(0))).toBe(false)
    expect(client.verify(longPk, message, shortSig)).toBe(false)
    expect(malloc).not.toHaveBeenCalled()
  })

  it('decides a wrong length before native code runs', () => {
    const nativeVerify = vi.spyOn(module, '_qbit_pqc_verify')
    try {
      const longSig = sameRealm(signature, constants.SIG_SIZE + 1)
      const shortPk = sameRealm(pair.publicKey, constants.PK_SIZE - 1)

      expect(client.verify(pair.publicKey, message, longSig)).toBe(false)
      expect(client.verify(shortPk, message, signature)).toBe(false)
      expect(nativeVerify).not.toHaveBeenCalled()
    } finally {
      nativeVerify.mockRestore()
    }
  })

  // An argument that is not a Uint8Array, or no longer addresses its buffer,
  // is a caller bug rather than untrusted bytes. It is checked before the
  // lengths, so it still throws whatever the lengths of the others are.
  it('still throws TypeError for a non-Uint8Array or detached argument', () => {
    const shortPk = sameRealm(pair.publicKey, constants.PK_SIZE - 1)
    const longSig = sameRealm(signature, constants.SIG_SIZE + 1)
    const int8Pk = new Int8Array(constants.PK_SIZE) as unknown as Uint8Array
    const arraySig = Array.from(signature) as unknown as Uint8Array

    for (const call of [verify, client.verify]) {
      expect(() => call(shortPk, 'msg' as unknown as Uint8Array, longSig)).toThrow(
        new TypeError('msg must be a Uint8Array')
      )
      expect(() => call(shortPk, message, arraySig)).toThrow(
        new TypeError('sig must be a Uint8Array')
      )
      expect(() => call(int8Pk, message, longSig)).toThrow(new TypeError('pk must be a Uint8Array'))
      // A detached view reads as length 0, but it is not an empty input.
      expect(() => call(detachedCopy(pair.publicKey), message, signature)).toThrow(DETACHED_ERROR)
      expect(() => call(shortPk, message, detachedCopy(signature))).toThrow(DETACHED_ERROR)
    }
    expect(malloc).not.toHaveBeenCalled()
  })

  it.each([
    ['BAD_ARG', errorCodes.BITCOIN_PQC_ERROR_BAD_ARG],
    ['BAD_KEY', errorCodes.BITCOIN_PQC_ERROR_BAD_KEY],
    ['OUT_OF_MEMORY', errorCodes.BITCOIN_PQC_ERROR_OUT_OF_MEMORY],
    ['UNKNOWN', 12345],
  ])('still throws PqcError for a native %s failure on full-length inputs', (kind, code) => {
    const nativeVerify = vi.spyOn(module, '_qbit_pqc_verify').mockReturnValue(code)
    try {
      for (const call of [verify, client.verify]) {
        let thrown: unknown
        try {
          call(pair.publicKey, message, signature)
        } catch (error) {
          thrown = error
        }
        expect(thrown).toBeInstanceOf(PqcError)
        expect(thrown).toMatchObject({ operation: 'verify', code, kind })
      }
      expect(nativeVerify).toHaveBeenCalledTimes(2)
    } finally {
      nativeVerify.mockRestore()
    }
  })

  it('still returns false for a full-length pk or sig that does not verify', () => {
    const tamperedSignature = new Uint8Array(signature)
    tamperedSignature[0] ^= 0xff
    const otherKey = new Uint8Array(pair.publicKey)
    otherKey[constants.PK_SIZE - 1] ^= 0x01

    for (const call of [verify, client.verify]) {
      expect(call(pair.publicKey, message, tamperedSignature)).toBe(false)
      expect(call(otherKey, message, signature)).toBe(false)
      expect(call(pair.publicKey, messageBytes('other'), signature)).toBe(false)
      expect(call(pair.publicKey, message, signature)).toBe(true)
    }
    // Each of those eight calls copied pk, msg and sig into wasm memory.
    expect(malloc).toHaveBeenCalledTimes(8 * 3)
  })
})
