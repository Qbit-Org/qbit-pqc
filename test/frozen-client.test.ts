import { beforeAll, describe, expect, it } from 'vitest'

import {
  constants,
  errorCodes,
  errors,
  init,
  nativeErrorKind,
  nativeErrorName,
  PqcError,
  verify,
  type PqcClient,
  type PqcKeyPair,
  type PqcNativeErrorName,
} from '../src/index'
import { freshClient } from './fresh-client'

// Regression coverage for a mutable client and mutable exports. init()
// resolved with a plain object, so `client.verify = () => true` made every
// named verify in the realm return true, as an unrestored test spy could, and
// `client.module` handed out the raw WASM exports, which skip the wrapper's
// checks and zeroing (`client.module._qbit_pqc_verify = () => 0` had the same
// effect). `constants` and `errorCodes` were read-only in their types only,
// and the native error lookups read inherited keys, so
// `nativeErrorKind('constructor')` returned undefined. The client is now
// frozen and has no module, `constants` and `errorCodes` are frozen with
// every object they hold, and the lookup tables have no prototype. This file
// runs in strict mode, where a write to a frozen object throws; sloppyAssign
// makes the same write in sloppy mode, where it is ignored. All key material
// is synthetic.

// A Function body is sloppy unless it opts into strict mode.
const sloppyAssign = new Function('target', 'key', 'value', 'target[key] = value') as (
  target: object,
  key: PropertyKey,
  value: unknown
) => void

// Every key of the client, sorted.
const CLIENT_KEYS = [
  'constants',
  'deriveP2mrDescriptorKey',
  'derivePQCKey',
  'keygen',
  'secretKeyValidate',
  'sign',
  'signWithStats',
  'verify',
  'wasmHeapBytes',
]

const CONSTANTS = {
  ALGORITHM: 'SLH-DSA-SHA2-128s-bounded30',
  PK_SIZE: 32,
  SK_SIZE: 64,
  SIG_SIZE: 3680,
  MIN_ENTROPY: 128,
  MAX_MESSAGE_SIZE: 65536,
  SIGN_STATS_WORDS: 11,
  WOTSC_LAYERS: 5,
  SIGN_LIMITS: { NONE: 0, FORSC: 1, WOTSC: 2 },
  ERROR_CODES: {
    BITCOIN_PQC_OK: 0,
    BITCOIN_PQC_ERROR_BAD_ARG: -1,
    BITCOIN_PQC_ERROR_BAD_KEY: -2,
    BITCOIN_PQC_ERROR_BAD_SIGNATURE: -3,
    BITCOIN_PQC_ERROR_NOT_IMPLEMENTED: -4,
    BITCOIN_PQC_ERROR_SIGNING_LIMIT: -5,
    BITCOIN_PQC_ERROR_OUT_OF_MEMORY: -6,
  },
  // test/expected-wasm-sha256.test.ts checks the value against wasm/SHA256SUMS.
  WASM_SHA256: expect.stringMatching(/^[0-9a-f]{64}$/),
}

// SLH-DSA-SHA2-128s secret key layout: [SK_SEED || SK_PRF || PUB_SEED || root]
const SPX_N = 16
const MESSAGE = new TextEncoder().encode('qbit-pqc-frozen-client')

function syntheticEntropy(seedByte: number): Uint8Array {
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 67) % 256)) & 0xff
  }
  return entropy
}

function flipByte(bytes: Uint8Array, offset: number): Uint8Array {
  const copy = new Uint8Array(bytes)
  copy[offset] ^= 0x80
  return copy
}

// Paths of the objects reachable from `value`, itself included, that are not
// frozen.
function unfrozen(value: unknown, path: string): string[] {
  if (typeof value !== 'object' || value === null) {
    return []
  }
  return [
    ...(Object.isFrozen(value) ? [] : [path]),
    ...Object.entries(value).flatMap(([key, child]) => unfrozen(child, `${path}.${key}`)),
  ]
}

// Writes `value` to `key` of `target` in strict mode, which must throw a
// TypeError, then in sloppy mode.
function attemptWrite(target: object, key: PropertyKey, value: unknown): void {
  expect(() => {
    ;(target as Record<PropertyKey, unknown>)[key] = value
  }, String(key)).toThrow(TypeError)
  sloppyAssign(target, key, value)
}

describe('the client from init()', () => {
  let client: PqcClient
  let pair: PqcKeyPair
  let signature: Uint8Array
  let tampered: Uint8Array

  beforeAll(async () => {
    // The only client this file publishes, so the named exports use it.
    client = await init()
    pair = client.keygen(syntheticEntropy(0x41))
    signature = client.sign(pair.secretKey, MESSAGE)
    tampered = flipByte(signature, 100)
  })

  function expectFrozenWithoutModule(candidate: PqcClient): void {
    expect(Object.isFrozen(candidate)).toBe(true)
    expect(Object.keys(candidate).sort()).toEqual(CLIENT_KEYS)
    expect('module' in candidate).toBe(false)
    expect((candidate as { module?: unknown }).module).toBeUndefined()
    attemptWrite(candidate, 'module', {})
    expect('module' in candidate).toBe(false)
    expect(candidate.constants).toBe(constants)
  }

  it('is frozen and has no module', () => {
    expectFrozenWithoutModule(client)
  })

  it.each(CLIENT_KEYS)('keeps its %s when code assigns to it or redefines it', key => {
    const original = (client as unknown as Record<string, unknown>)[key]
    const replacement = () => true

    attemptWrite(client, key, replacement)
    expect(() => Object.defineProperty(client, key, { value: replacement })).toThrow(TypeError)
    expect(() => delete (client as unknown as Record<string, unknown>)[key]).toThrow(TypeError)

    expect((client as unknown as Record<string, unknown>)[key]).toBe(original)
  })

  it('still rejects a tampered signature, through the client and the named verify', () => {
    attemptWrite(client, 'verify', () => true)

    expect(client.verify(pair.publicKey, MESSAGE, tampered)).toBe(false)
    expect(verify(pair.publicKey, MESSAGE, tampered)).toBe(false)
    expect(verify(pair.publicKey, MESSAGE, signature)).toBe(true)
  })

  // Last: it publishes another client.
  it('is frozen and has no module with createModule too', async () => {
    const { client: own } = await freshClient()
    expectFrozenWithoutModule(own)
  })
})

describe('constants and errorCodes', () => {
  let client: PqcClient
  let pair: PqcKeyPair

  beforeAll(async () => {
    client = await init()
    pair = client.keygen(syntheticEntropy(0x42))
  })

  it('are frozen with every object they hold', () => {
    expect(unfrozen(constants, 'constants')).toEqual([])
    expect(unfrozen(errorCodes, 'errorCodes')).toEqual([])
    expect(constants.ERROR_CODES).toBe(errorCodes)
    expect(errors).toBe(errorCodes)
  })

  it('ignore writes, and the wrapper keeps the real sizes and codes', () => {
    for (const [name, target] of [
      ['constants', constants],
      ['constants.SIGN_LIMITS', constants.SIGN_LIMITS],
      ['errorCodes', errorCodes],
    ] as const) {
      for (const key of [...Object.keys(target), 'ADDED']) {
        attemptWrite(target, key, 1)
      }
      expect(Object.isExtensible(target), name).toBe(false)
    }

    expect(constants).toEqual(CONSTANTS)
    const signature = client.sign(pair.secretKey, MESSAGE)
    expect(signature).toHaveLength(CONSTANTS.SIG_SIZE)
    expect(client.signWithStats(pair.secretKey, MESSAGE).sig).toEqual(signature)
    expect(client.verify(pair.publicKey, MESSAGE, signature)).toBe(true)
    // BAD_SIGNATURE from native verify still reads as an invalid signature,
    // and BAD_KEY from native validation as an invalid key.
    expect(client.verify(pair.publicKey, MESSAGE, flipByte(signature, 100))).toBe(false)
    expect(client.secretKeyValidate(flipByte(pair.secretKey, 4 * SPX_N - 1))).toBe(false)
  })
})

describe('nativeErrorName and nativeErrorKind', () => {
  // Keys of Object.prototype that a JavaScript caller can pass as a code.
  const inherited = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']

  it('map every native error code to its name and kind', () => {
    const kinds: Record<PqcNativeErrorName, string> = {
      BITCOIN_PQC_ERROR_BAD_ARG: 'BAD_ARG',
      BITCOIN_PQC_ERROR_BAD_KEY: 'BAD_KEY',
      BITCOIN_PQC_ERROR_BAD_SIGNATURE: 'BAD_SIGNATURE',
      BITCOIN_PQC_ERROR_NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
      BITCOIN_PQC_ERROR_SIGNING_LIMIT: 'SIGNING_LIMIT',
      BITCOIN_PQC_ERROR_OUT_OF_MEMORY: 'OUT_OF_MEMORY',
    }
    for (const [name, kind] of Object.entries(kinds)) {
      const code = errorCodes[name as PqcNativeErrorName]
      expect(nativeErrorName(code), name).toBe(name)
      expect(nativeErrorKind(code), name).toBe(kind)
    }
    expect(nativeErrorName(errorCodes.BITCOIN_PQC_OK)).toBeUndefined()
    expect(nativeErrorKind(errorCodes.BITCOIN_PQC_OK)).toBe('UNKNOWN')
  })

  it.each(inherited)("report %s as no native error, of kind 'UNKNOWN'", key => {
    const code = key as unknown as number
    expect(nativeErrorName(code)).toBeUndefined()
    expect(nativeErrorKind(code)).toBe('UNKNOWN')

    const error = new PqcError('verify', code)
    expect(error.nativeName).toBeUndefined()
    expect(error.kind).toBe('UNKNOWN')
  })

  it('ignore a code added to Object.prototype', () => {
    const prototype = Object.prototype as Record<number, unknown>
    prototype[-7] = 'BITCOIN_PQC_ERROR_BAD_ARG'
    try {
      expect(nativeErrorName(-7)).toBeUndefined()
      expect(nativeErrorKind(-7)).toBe('UNKNOWN')
    } finally {
      delete prototype[-7]
    }
  })
})
