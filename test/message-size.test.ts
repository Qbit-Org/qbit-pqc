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

import goldenFixture from '../fixtures/slh-dsa-golden.json'
import {
  constants,
  errorCodes,
  sign,
  signWithStats,
  verify,
  type PqcClient,
  type PqcKeyPair,
  type PqcMessageOptions,
  type PqcWasmModule,
} from '../src/index'
import { freshClient } from './fresh-client'

// Regression coverage for unbounded messages: sign and signWithStats accepted a
// msg of any length, and every FORS+C grind attempt rehashes the whole message,
// so a 1 MiB msg blocked the thread for one to two minutes. verify copied a msg
// of any length into wasm memory, and the heap it grew never shrinks. Above
// MAX_MESSAGE_SIZE (64 KiB) sign and signWithStats now throw a RangeError and
// verify returns false, before any wasm allocation, unless the caller passes
// { allowLargeMessage: true }. The options argument is validated strictly and
// read without running caller code. Native signing and verification are
// stubbed where only the wrapper's decision matters, so a long msg costs a
// copy rather than a signature; the few real signatures use messages chosen to
// need few grind attempts. All key material is synthetic.

const LIMIT = 65536
// Four times the wasm heap a fresh instance starts with (16 MiB), so copying
// an input this large would have to grow the wasm memory.
const VERY_LARGE = 64 * 1024 * 1024
// Signing these messages (messageBytes(length, nonce)) with the key from
// syntheticEntropy(0x29) needs 96 and 1,154 FORS+C grind attempts. A typical
// 64 KiB message needs tens of thousands, and up to half a minute to sign.
const CHEAP_AT_LIMIT_NONCE = 38
const CHEAP_OVER_LIMIT_NONCE = 16
// A real signature over a message this long takes about a second.
const REAL_SIGNING_TIMEOUT = 60_000

const PLAIN_OBJECT_ERROR = 'options must be undefined or a plain object'
const BOOLEAN_ERROR = 'options.allowLargeMessage must be a boolean'
const DETACHED_ERROR = /must not be a view on a detached or out-of-bounds ArrayBuffer/

function syntheticEntropy(seedByte: number): Uint8Array {
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 59) % 256)) & 0xff
  }
  return entropy
}

// A position-dependent pattern, so a copy that dropped or shifted bytes would
// not match, with `nonce` in its first two bytes.
function messageBytes(length: number, nonce = 0): Uint8Array {
  const msg = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    msg[i] = (i * 7 + 0x3d) & 0xff
  }
  if (length >= 2) {
    msg[0] = nonce & 0xff
    msg[1] = (nonce >>> 8) & 0xff
  }
  return msg
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'))
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')
}

function detach(bytes: Uint8Array): void {
  const buffer = bytes.buffer as ArrayBuffer
  structuredClone(buffer, { transfer: [buffer] })
  expect(bytes.length).toBe(0)
}

function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

function overLimitError(length: number): RangeError {
  return new RangeError(
    `msg must be at most ${LIMIT} bytes without options.allowLargeMessage, got ${length}`
  )
}

interface MessageApi {
  sign(sk: Uint8Array, msg: Uint8Array, options?: PqcMessageOptions): Uint8Array
  signWithStats(sk: Uint8Array, msg: Uint8Array, options?: PqcMessageOptions): { sig: Uint8Array }
  verify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array, options?: PqcMessageOptions): boolean
}

type Signer = (api: MessageApi, sk: Uint8Array, msg: Uint8Array, options?: unknown) => Uint8Array

const signers: Array<[string, Signer]> = [
  ['sign', (api, sk, msg, options) => api.sign(sk, msg, options as PqcMessageOptions)],
  [
    'signWithStats',
    (api, sk, msg, options) => api.signWithStats(sk, msg, options as PqcMessageOptions).sig,
  ],
]

// Options that leave the size limit in place.
const capped: Array<[string, () => unknown]> = [
  ['no options', () => undefined],
  ['{}', () => ({})],
  ['allowLargeMessage: false', () => ({ allowLargeMessage: false })],
  ['allowLargeMessage: undefined', () => ({ allowLargeMessage: undefined })],
  ['a null-prototype object', () => Object.create(null)],
]

// Options that lift it.
const optedIn: Array<[string, () => unknown]> = [
  ['allowLargeMessage: true', () => ({ allowLargeMessage: true })],
  ['a frozen object', () => Object.freeze({ allowLargeMessage: true })],
  [
    'a null-prototype object',
    () => Object.assign(Object.create(null) as object, { allowLargeMessage: true }),
  ],
  [
    'a non-enumerable property',
    () => Object.defineProperty({}, 'allowLargeMessage', { value: true }),
  ],
]

const foreignRealm = createContext()

// Rejected whatever the message length.
const invalid: Array<[string, () => unknown, string]> = [
  ['null', () => null, PLAIN_OBJECT_ERROR],
  ['true', () => true, PLAIN_OBJECT_ERROR],
  ['a number', () => 1, PLAIN_OBJECT_ERROR],
  ['a string', () => 'allowLargeMessage', PLAIN_OBJECT_ERROR],
  ['an array', () => [true], PLAIN_OBJECT_ERROR],
  ['a function', () => Object.assign(() => true, { allowLargeMessage: true }), PLAIN_OBJECT_ERROR],
  ['a Map', () => new Map([['allowLargeMessage', true]]), PLAIN_OBJECT_ERROR],
  [
    'a class instance',
    () =>
      new (class Options {
        allowLargeMessage = true
      })(),
    PLAIN_OBJECT_ERROR,
  ],
  [
    'an object inheriting the option',
    () => Object.create({ allowLargeMessage: true }) as unknown,
    PLAIN_OBJECT_ERROR,
  ],
  [
    'an object from another realm',
    () => runInContext('({ allowLargeMessage: true })', foreignRealm),
    PLAIN_OBJECT_ERROR,
  ],
  [
    'a misspelt key',
    () => ({ allowLargeMessages: true }),
    'options must have no property other than allowLargeMessage, got allowLargeMessages',
  ],
  [
    'an extra key',
    () => ({ allowLargeMessage: true, maxMessageSize: 1 << 20 }),
    'options must have no property other than allowLargeMessage, got maxMessageSize',
  ],
  [
    'an extra non-enumerable key',
    () => Object.defineProperty({ allowLargeMessage: true }, 'hidden', { value: 1 }),
    'options must have no property other than allowLargeMessage, got hidden',
  ],
  [
    'a symbol key',
    () => ({ [Symbol('allowLargeMessage')]: true }),
    'options must have no property other than allowLargeMessage, got a symbol key',
  ],
  ["allowLargeMessage: 'true'", () => ({ allowLargeMessage: 'true' }), BOOLEAN_ERROR],
  ['allowLargeMessage: 1', () => ({ allowLargeMessage: 1 }), BOOLEAN_ERROR],
  ['allowLargeMessage: null', () => ({ allowLargeMessage: null }), BOOLEAN_ERROR],
  [
    'allowLargeMessage: new Boolean(true)',
    () => ({ allowLargeMessage: new Boolean(true) }),
    BOOLEAN_ERROR,
  ],
]

interface NativeCall {
  readonly length: number
  readonly sameBytes: boolean
}

describe('message size limit for sign, signWithStats and verify', () => {
  let client: PqcClient
  let module: PqcWasmModule
  let pair: PqcKeyPair
  let smallMessage: Uint8Array
  let smallSignature: Uint8Array
  let malloc: MockInstance<PqcWasmModule['_malloc']>
  const messages = new Map<number, Uint8Array>()

  function messageOfLength(length: number): Uint8Array {
    let msg = messages.get(length)
    if (msg === undefined) {
      msg = messageBytes(length)
      messages.set(length, msg)
    }
    return msg
  }

  // Replaces the native signers and verifier with stubs that succeed without
  // signing, recording the length each was handed and whether the bytes
  // copied into wasm memory are exactly `expected`. Tests that expect no
  // native call install them too, since without the limit those calls sign.
  function stubNative(expected = new Uint8Array(0)): NativeCall[] {
    const calls: NativeCall[] = []
    const record = (ptr: number, length: number): number => {
      const copied = Buffer.from(module.HEAPU8.buffer, module.HEAPU8.byteOffset + ptr, length)
      calls.push({ length, sameBytes: copied.equals(expected) })
      return errorCodes.BITCOIN_PQC_OK
    }
    vi.spyOn(module, '_qbit_pqc_sign').mockImplementation((_sig, _sk, msg, length) =>
      record(msg, length)
    )
    vi.spyOn(module, '_qbit_pqc_sign_with_stats').mockImplementation(
      (_sig, _stats, _sk, msg, length) => record(msg, length)
    )
    vi.spyOn(module, '_qbit_pqc_verify').mockImplementation((_pk, msg, length) =>
      record(msg, length)
    )
    return calls
  }

  beforeAll(async () => {
    // The only init() in this file, so the named exports use this client too.
    ;({ client, module } = await freshClient())
    pair = client.keygen(syntheticEntropy(0x29))
    smallMessage = messageBytes(32)
    smallSignature = client.sign(pair.secretKey, smallMessage)
  })

  beforeEach(() => {
    malloc = vi.spyOn(module, '_malloc')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports the limit as constants.MAX_MESSAGE_SIZE', () => {
    expect(constants.MAX_MESSAGE_SIZE).toBe(LIMIT)
  })

  it('keeps the limit when code writes to constants.MAX_MESSAGE_SIZE', () => {
    const mutable = constants as { MAX_MESSAGE_SIZE: number }
    const overLimit = messageOfLength(LIMIT + 1)
    const atLimit = messageOfLength(LIMIT)
    const calls = stubNative(atLimit)

    // constants is frozen, so in strict mode, as here, each write throws.
    expect(() => {
      mutable.MAX_MESSAGE_SIZE = 2 ** 31
    }).toThrow(TypeError)
    expect(thrownBy(() => sign(pair.secretKey, overLimit))).toEqual(overLimitError(LIMIT + 1))

    expect(() => {
      mutable.MAX_MESSAGE_SIZE = 0
    }).toThrow(TypeError)
    sign(pair.secretKey, atLimit)
    expect(calls).toEqual([{ length: LIMIT, sameBytes: true }])
    expect(constants.MAX_MESSAGE_SIZE).toBe(LIMIT)
  })

  const entryPoints: Array<[string, () => MessageApi]> = [
    ['the named exports', () => ({ sign, signWithStats, verify })],
    ['a client', () => client],
  ]

  describe.each(entryPoints)('through %s', (_entryPoint, entry) => {
    describe.each(signers)('%s', (_signer, run) => {
      it.each([LIMIT - 1, LIMIT])('passes a %i-byte msg to native code whole', length => {
        const msg = messageOfLength(length)
        const calls = stubNative(msg)

        expect(run(entry(), pair.secretKey, msg)).toHaveLength(constants.SIG_SIZE)
        expect(calls).toEqual([{ length, sameBytes: true }])
        expect(malloc).toHaveBeenCalledWith(length)
      })

      it.each([LIMIT + 1, VERY_LARGE])(
        'throws a RangeError for a %i-byte msg before any wasm allocation',
        length => {
          const msg = messageOfLength(length)
          const calls = stubNative(msg)
          const heapBytes = client.wasmHeapBytes()

          for (const [, options] of capped) {
            expect(() => run(entry(), pair.secretKey, msg, options())).toThrow(
              overLimitError(length)
            )
          }
          expect(calls).toEqual([])
          expect(malloc).not.toHaveBeenCalled()
          expect(client.wasmHeapBytes()).toBe(heapBytes)
        }
      )

      it.each([LIMIT + 1, VERY_LARGE])(
        'passes a %i-byte msg to native code whole only with allowLargeMessage',
        length => {
          const msg = messageOfLength(length)
          const calls = stubNative(msg)

          expect(() => run(entry(), pair.secretKey, msg)).toThrow(overLimitError(length))
          for (const [, options] of optedIn) {
            expect(run(entry(), pair.secretKey, msg, options())).toHaveLength(constants.SIG_SIZE)
          }
          expect(calls).toEqual(optedIn.map(() => ({ length, sameBytes: true })))
        }
      )

      it.each(invalid)('throws a TypeError for %s as options', (_label, options, message) => {
        const calls = stubNative()

        for (const msg of [smallMessage, messageOfLength(LIMIT + 1)]) {
          expect(() => run(entry(), pair.secretKey, msg, options())).toThrow(new TypeError(message))
        }
        expect(calls).toEqual([])
        expect(malloc).not.toHaveBeenCalled()
      })
    })

    describe('verify', () => {
      it.each([LIMIT - 1, LIMIT])('passes a %i-byte msg to native code whole', length => {
        const msg = messageOfLength(length)
        const calls = stubNative(msg)

        expect(entry().verify(pair.publicKey, msg, smallSignature)).toBe(true)
        expect(calls).toEqual([{ length, sameBytes: true }])
        expect(malloc).toHaveBeenCalledWith(length)
      })

      // The stub accepts every signature, so only the size check can make
      // these return false.
      it.each([LIMIT + 1, VERY_LARGE])(
        'returns false for a %i-byte msg before any wasm allocation',
        length => {
          const msg = messageOfLength(length)
          const calls = stubNative(msg)
          const heapBytes = client.wasmHeapBytes()

          for (const [, options] of capped) {
            expect(
              entry().verify(pair.publicKey, msg, smallSignature, options() as PqcMessageOptions)
            ).toBe(false)
          }
          expect(calls).toEqual([])
          expect(malloc).not.toHaveBeenCalled()
          expect(client.wasmHeapBytes()).toBe(heapBytes)
        }
      )

      it.each([LIMIT + 1, VERY_LARGE])(
        'passes a %i-byte msg to native code whole only with allowLargeMessage',
        length => {
          const msg = messageOfLength(length)
          const calls = stubNative(msg)

          expect(entry().verify(pair.publicKey, msg, smallSignature)).toBe(false)
          for (const [, options] of optedIn) {
            expect(
              entry().verify(pair.publicKey, msg, smallSignature, options() as PqcMessageOptions)
            ).toBe(true)
          }
          expect(calls).toEqual(optedIn.map(() => ({ length, sameBytes: true })))
        }
      )

      it.each(invalid)('throws a TypeError for %s as options', (_label, options, message) => {
        const calls = stubNative()

        for (const msg of [smallMessage, messageOfLength(LIMIT + 1)]) {
          expect(() =>
            entry().verify(pair.publicKey, msg, smallSignature, options() as PqcMessageOptions)
          ).toThrow(new TypeError(message))
        }
        expect(calls).toEqual([])
        expect(malloc).not.toHaveBeenCalled()
      })
    })

    it('rejects an allowLargeMessage getter without calling it', () => {
      const api = entry()
      const calls = stubNative()
      let getterCalls = 0
      const options = Object.defineProperty({}, 'allowLargeMessage', {
        enumerable: true,
        get() {
          getterCalls += 1
          return true
        },
      }) as PqcMessageOptions

      expect(() => api.sign(pair.secretKey, smallMessage, options)).toThrow(
        new TypeError(BOOLEAN_ERROR)
      )
      expect(() => api.signWithStats(pair.secretKey, smallMessage, options)).toThrow(
        new TypeError(BOOLEAN_ERROR)
      )
      expect(() => api.verify(pair.publicKey, smallMessage, smallSignature, options)).toThrow(
        new TypeError(BOOLEAN_ERROR)
      )
      expect(getterCalls).toBe(0)
      expect(calls).toEqual([])
      expect(malloc).not.toHaveBeenCalled()
    })

    it('ignores an allowLargeMessage inherited from Object.prototype', () => {
      const api = entry()
      const msg = messageOfLength(LIMIT + 1)
      const calls = stubNative(msg)
      let getterCalls = 0
      Object.defineProperty(Object.prototype, 'allowLargeMessage', {
        configurable: true,
        get() {
          getterCalls += 1
          return true
        },
      })
      const outcomes: unknown[] = []
      try {
        outcomes.push(thrownBy(() => api.sign(pair.secretKey, msg, {})))
        outcomes.push(thrownBy(() => api.signWithStats(pair.secretKey, msg)))
        outcomes.push(api.verify(pair.publicKey, msg, smallSignature, {}))
      } finally {
        delete (Object.prototype as { allowLargeMessage?: unknown }).allowLargeMessage
      }

      expect(outcomes).toEqual([overLimitError(LIMIT + 1), overLimitError(LIMIT + 1), false])
      expect(getterCalls).toBe(0)
      expect(calls).toEqual([])
      expect(malloc).not.toHaveBeenCalled()
    })

    // A Proxy cannot be inspected without running its traps. They run before
    // any byte argument is pinned, so one that detaches an argument makes the
    // call reject it instead of using it.
    it('reads a Proxy passed as options before the byte arguments', () => {
      const api = entry()
      const calls = stubNative()
      const detachingOptions = (victim: Uint8Array): PqcMessageOptions =>
        new Proxy(
          {},
          {
            ownKeys(target) {
              detach(victim)
              return Reflect.ownKeys(target)
            },
          }
        )

      const msg = new Uint8Array(smallMessage)
      expect(() => api.sign(pair.secretKey, msg, detachingOptions(msg))).toThrow(DETACHED_ERROR)
      const statsMsg = new Uint8Array(smallMessage)
      expect(() => api.signWithStats(pair.secretKey, statsMsg, detachingOptions(statsMsg))).toThrow(
        DETACHED_ERROR
      )
      const sig = new Uint8Array(smallSignature)
      expect(() => api.verify(pair.publicKey, smallMessage, sig, detachingOptions(sig))).toThrow(
        DETACHED_ERROR
      )
      expect(calls).toEqual([])
      expect(malloc).not.toHaveBeenCalled()
    })
  })

  it('reads options through intrinsics captured at module load', () => {
    const msg = messageOfLength(LIMIT + 1)
    const calls = stubNative(msg)
    let getterCalls = 0
    const getterOptions = Object.defineProperty({}, 'allowLargeMessage', {
      get() {
        getterCalls += 1
        return true
      },
    })
    const patches: Array<[object, PropertyKey, unknown]> = [
      [Object, 'getPrototypeOf', () => Object.prototype],
      [Object, 'getOwnPropertyDescriptor', () => ({ value: true, writable: true })],
      [Reflect, 'ownKeys', () => []],
      [Object.prototype, 'hasOwnProperty', () => true],
    ]
    const originals = patches.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key)!)
    const outcomes: unknown[] = []
    for (const [target, key, value] of patches) {
      Object.defineProperty(target, key, { configurable: true, writable: true, value })
    }
    try {
      outcomes.push(thrownBy(() => sign(pair.secretKey, msg, new Map() as PqcMessageOptions)))
      outcomes.push(
        thrownBy(() => sign(pair.secretKey, msg, { allowLargeMessages: true } as PqcMessageOptions))
      )
      outcomes.push(thrownBy(() => signWithStats(pair.secretKey, msg, getterOptions)))
      outcomes.push(thrownBy(() => sign(pair.secretKey, msg, {})))
      outcomes.push(verify(pair.publicKey, msg, smallSignature, {}))
    } finally {
      patches.forEach(([target, key], index) => {
        Object.defineProperty(target, key, originals[index]!)
      })
    }

    expect(outcomes).toEqual([
      new TypeError(PLAIN_OBJECT_ERROR),
      new TypeError(
        'options must have no property other than allowLargeMessage, got allowLargeMessages'
      ),
      new TypeError(BOOLEAN_ERROR),
      overLimitError(LIMIT + 1),
      false,
    ])
    expect(getterCalls).toBe(0)
    expect(calls).toEqual([])
    expect(malloc).not.toHaveBeenCalled()
  })

  describe('real signatures', () => {
    it(
      'signs and verifies a 65536-byte msg without allowLargeMessage',
      () => {
        const msg = messageBytes(LIMIT, CHEAP_AT_LIMIT_NONCE)
        const signature = client.sign(pair.secretKey, msg)

        expect(signWithStats(pair.secretKey, msg).sig).toEqual(signature)
        expect(verify(pair.publicKey, msg, signature)).toBe(true)
        expect(client.verify(pair.publicKey, msg, signature)).toBe(true)
        expect(client.verify(pair.publicKey, msg.subarray(1), signature)).toBe(false)
      },
      REAL_SIGNING_TIMEOUT
    )

    it(
      'signs and verifies a 65537-byte msg only with allowLargeMessage',
      () => {
        const msg = messageBytes(LIMIT + 1, CHEAP_OVER_LIMIT_NONCE)
        const optIn = { allowLargeMessage: true }

        expect(() => sign(pair.secretKey, msg)).toThrow(overLimitError(LIMIT + 1))
        expect(() => client.signWithStats(pair.secretKey, msg)).toThrow(overLimitError(LIMIT + 1))
        const signature = sign(pair.secretKey, msg, optIn)
        expect(client.signWithStats(pair.secretKey, msg, optIn).sig).toEqual(signature)

        // A valid signature, reported as invalid without the opt-in.
        expect(verify(pair.publicKey, msg, signature)).toBe(false)
        expect(client.verify(pair.publicKey, msg, signature, { allowLargeMessage: false })).toBe(
          false
        )
        expect(verify(pair.publicKey, msg, signature, optIn)).toBe(true)
        expect(client.verify(pair.publicKey, msg, signature, optIn)).toBe(true)
      },
      REAL_SIGNING_TIMEOUT
    )

    for (const vector of goldenFixture.vectors) {
      it(
        `still matches ${vector.name} with options`,
        () => {
          const entropy = new Uint8Array(constants.MIN_ENTROPY)
          for (let i = 0; i < entropy.length; i += 1) {
            entropy[i] = (vector.seedByte + ((i * 37) % 256)) & 0xff
          }
          const golden = client.keygen(entropy)
          const msg = hexToBytes(vector.messageHex)
          const signature = hexToBytes(vector.signatureHex)

          expect(bytesToHex(golden.publicKey)).toBe(vector.publicKeyHex)
          expect(bytesToHex(golden.secretKey)).toBe(vector.secretKeyHex)
          expect(bytesToHex(sign(golden.secretKey, msg, { allowLargeMessage: true }))).toBe(
            vector.signatureHex
          )
          expect(bytesToHex(client.signWithStats(golden.secretKey, msg, {}).sig)).toBe(
            vector.signatureHex
          )
          expect(verify(golden.publicKey, msg, signature, { allowLargeMessage: false })).toBe(true)
          expect(client.verify(golden.publicKey, msg, signature, Object.create(null))).toBe(true)
        },
        REAL_SIGNING_TIMEOUT
      )
    }
  })
})
