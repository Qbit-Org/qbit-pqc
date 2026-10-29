import { beforeAll, describe, expect, it } from 'vitest'

import goldenFixture from '../fixtures/slh-dsa-golden.json'
import {
  constants,
  errorCodes,
  init,
  keygen,
  nativeErrorKind,
  nativeErrorName,
  PqcError,
  secretKeyValidate,
  sign,
  signWithStats,
  verify,
  type PqcClient,
  type PqcWasmModule,
  type PqcWasmModuleFactory,
} from '../src/index'
import { freshClient, type FreshClient } from './fresh-client'

interface GoldenFixture {
  sizes: {
    publicKeyBytes: number
    secretKeyBytes: number
    signatureBytes: number
    minEntropyBytes: number
  }
  vectors: GoldenVector[]
}

interface GoldenVector {
  name: string
  seedByte: number
  messageHex: string
  publicKeyHex: string
  secretKeyHex: string
  signatureHex: string
}

const fixture = goldenFixture as GoldenFixture

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`invalid hex length: ${hex.length}`)
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function deterministicEntropy(seedByte: number): Uint8Array {
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 37) % 256)) & 0xff
  }
  return entropy
}

function firstVector(): GoldenVector {
  const vector = fixture.vectors[0]
  if (vector === undefined) {
    throw new Error('golden fixture has no vectors')
  }
  return vector
}

function expectPqcError(run: () => unknown, kind: string): PqcError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(PqcError)
    const pqcError = error as PqcError
    expect(pqcError.kind).toBe(kind)
    return pqcError
  }
  throw new Error(`expected PqcError ${kind}`)
}

function restoreModuleFunction<K extends keyof PqcWasmModule>(
  module: PqcWasmModule,
  key: K,
  replacement: PqcWasmModule[K]
): () => void {
  const original = module[key]
  module[key] = replacement
  return () => {
    module[key] = original
  }
}

describe('@qbit-oss/pqc production TypeScript API', () => {
  let client: PqcClient
  // A client on a module of its own, for the tests that call or patch the
  // module directly.
  let raw: FreshClient

  beforeAll(async () => {
    raw = await freshClient()
    // Last, so the named exports use the default client.
    client = await init()
  })

  it('loads the bundled wasm and exposes expected bounded30 constants', () => {
    expect(raw.module._qbit_pqc_public_key_size()).toBe(constants.PK_SIZE)
    expect(raw.module._qbit_pqc_secret_key_size()).toBe(constants.SK_SIZE)
    expect(raw.module._qbit_pqc_signature_size()).toBe(constants.SIG_SIZE)
    expect(raw.module._qbit_pqc_keygen_entropy_min_size()).toBe(constants.MIN_ENTROPY)
    expect(constants.PK_SIZE).toBe(fixture.sizes.publicKeyBytes)
    expect(constants.SK_SIZE).toBe(fixture.sizes.secretKeyBytes)
    expect(constants.SIG_SIZE).toBe(fixture.sizes.signatureBytes)
    expect(constants.MIN_ENTROPY).toBe(fixture.sizes.minEntropyBytes)
  })

  for (const vector of fixture.vectors) {
    it(`matches ${vector.name}`, () => {
      const message = hexToBytes(vector.messageHex)
      const pair = client.keygen(deterministicEntropy(vector.seedByte))

      expect(bytesToHex(pair.publicKey)).toBe(vector.publicKeyHex)
      expect(bytesToHex(pair.secretKey)).toBe(vector.secretKeyHex)
      expect(client.secretKeyValidate(pair.secretKey)).toBe(true)

      const signature = client.sign(pair.secretKey, message)
      expect(bytesToHex(signature)).toBe(vector.signatureHex)
      expect(client.verify(pair.publicKey, message, signature)).toBe(true)

      const { sig, stats } = client.signWithStats(pair.secretKey, message)
      expect(bytesToHex(sig)).toBe(vector.signatureHex)
      expect(stats.wotscAttempts).toHaveLength(constants.WOTSC_LAYERS)
      expect(stats.wotscLayerCount).toBe(constants.WOTSC_LAYERS)
      expect(stats.capExceeded).toBe(constants.SIGN_LIMITS.NONE)
    })
  }

  it('returns signing stats without exposing wasm memory views', () => {
    const vector = firstVector()
    const message = hexToBytes(vector.messageHex)
    const pair = client.keygen(deterministicEntropy(vector.seedByte))
    const result = client.signWithStats(pair.secretKey, message)

    expect(bytesToHex(result.sig)).toBe(vector.signatureHex)
    expect(result.stats.wotscAttempts).toHaveLength(constants.WOTSC_LAYERS)
    expect(result.stats.wotscLayerCount).toBe(constants.WOTSC_LAYERS)
    expect(result.stats.capExceeded).toBe(constants.SIGN_LIMITS.NONE)

    const originalByte = result.sig[0]
    result.sig[0] ^= 0xff
    expect(result.sig[0]).not.toBe(originalByte)
    expect(client.verify(pair.publicKey, message, hexToBytes(vector.signatureHex))).toBe(true)
  })

  it('exposes initialized top-level functions', () => {
    const vector = firstVector()
    const message = hexToBytes(vector.messageHex)
    const pair = keygen(deterministicEntropy(vector.seedByte))
    const signature = sign(pair.secretKey, message)

    expect(secretKeyValidate(pair.secretKey)).toBe(true)
    expect(bytesToHex(signWithStats(pair.secretKey, message).sig)).toBe(vector.signatureHex)
    expect(verify(pair.publicKey, message, signature)).toBe(true)
  })

  it('accepts a statically supplied wasm factory for MV3 service workers', async () => {
    const loaded = (await import(new URL('../wasm/pqc.mjs', import.meta.url).href)) as {
      default: PqcWasmModuleFactory
    }
    const staticClient = await init({ createModule: loaded.default })
    const vector = firstVector()
    const message = hexToBytes(vector.messageHex)
    const pair = staticClient.keygen(deterministicEntropy(vector.seedByte))
    const signature = staticClient.sign(pair.secretKey, message)

    expect(bytesToHex(pair.publicKey)).toBe(vector.publicKeyHex)
    expect(bytesToHex(pair.secretKey)).toBe(vector.secretKeyHex)
    expect(bytesToHex(signature)).toBe(vector.signatureHex)
    expect(staticClient.verify(pair.publicKey, message, signature)).toBe(true)
  })

  it('rejects non-Uint8Array inputs', () => {
    const vector = firstVector()
    const message = hexToBytes(vector.messageHex)
    const pair = client.keygen(deterministicEntropy(vector.seedByte))

    expect(() => client.keygen(new ArrayBuffer(constants.MIN_ENTROPY) as unknown as Uint8Array)).toThrow(TypeError)
    expect(() => client.sign(pair.secretKey, 'message' as unknown as Uint8Array)).toThrow(TypeError)
    expect(() => client.verify(pair.publicKey, message, 'sig' as unknown as Uint8Array)).toThrow(TypeError)
    expect(() => client.secretKeyValidate('sk' as unknown as Uint8Array)).toThrow(TypeError)
  })

  it('rejects bad input lengths before entering native code', () => {
    const vector = firstVector()
    const message = hexToBytes(vector.messageHex)
    const pair = client.keygen(deterministicEntropy(vector.seedByte))
    const signature = client.sign(pair.secretKey, message)

    expect(() => client.keygen(new Uint8Array(constants.MIN_ENTROPY - 1))).toThrow(RangeError)
    expect(() => client.sign(pair.secretKey.slice(1), message)).toThrow(RangeError)
    expect(() => client.signWithStats(pair.secretKey.slice(1), message)).toThrow(RangeError)
    expect(() => client.secretKeyValidate(pair.secretKey.slice(1))).toThrow(RangeError)
    // verify reports a wrong-length key or signature as invalid instead.
    expect(client.verify(pair.publicKey.slice(1), message, signature)).toBe(false)
    expect(client.verify(pair.publicKey, message, signature.slice(1))).toBe(false)
  })

  it('reports tampered signatures and malformed keys as invalid', () => {
    const vector = firstVector()
    const message = hexToBytes(vector.messageHex)
    const pair = client.keygen(deterministicEntropy(vector.seedByte))
    const signature = client.sign(pair.secretKey, message)

    const tamperedSignature = new Uint8Array(signature)
    tamperedSignature[0] ^= 0xff
    expect(client.verify(pair.publicKey, message, tamperedSignature)).toBe(false)

    const malformedPublicKey = new Uint8Array(pair.publicKey)
    malformedPublicKey[0] ^= 0xff
    expect(client.verify(malformedPublicKey, message, signature)).toBe(false)

    const malformedSecretKey = new Uint8Array(pair.secretKey)
    malformedSecretKey[0] ^= 0xff
    expect(client.secretKeyValidate(malformedSecretKey)).toBe(false)
  })

  it('maps native error codes to typed PqcError values', () => {
    expect(nativeErrorName(errorCodes.BITCOIN_PQC_ERROR_SIGNING_LIMIT)).toBe('BITCOIN_PQC_ERROR_SIGNING_LIMIT')
    expect(nativeErrorKind(errorCodes.BITCOIN_PQC_ERROR_SIGNING_LIMIT)).toBe('SIGNING_LIMIT')
    expect(nativeErrorKind(12345)).toBe('UNKNOWN')

    const vector = firstVector()
    const message = hexToBytes(vector.messageHex)
    const pair = client.keygen(deterministicEntropy(vector.seedByte))
    const { client: rawClient, module } = raw
    const restore = restoreModuleFunction(module, '_qbit_pqc_sign_with_stats', ((_signatureOut, statsOut) => {
      const stats = new Uint32Array(module.HEAPU8.buffer, statsOut, constants.SIGN_STATS_WORDS)
      stats[0] = 77
      stats[10] = constants.SIGN_LIMITS.FORSC
      return errorCodes.BITCOIN_PQC_ERROR_SIGNING_LIMIT
    }) as PqcWasmModule['_qbit_pqc_sign_with_stats'])

    try {
      const error = expectPqcError(() => rawClient.signWithStats(pair.secretKey, message), 'SIGNING_LIMIT')
      expect(error.code).toBe(errorCodes.BITCOIN_PQC_ERROR_SIGNING_LIMIT)
      expect(error.nativeName).toBe('BITCOIN_PQC_ERROR_SIGNING_LIMIT')
      expect(error.stats?.forscAttempts).toBe(77)
      expect(error.stats?.capExceeded).toBe(constants.SIGN_LIMITS.FORSC)
    } finally {
      restore()
    }
  })

  it('zeroizes entropy scratch before free on keygen failure', () => {
    const { client: rawClient, module } = raw
    const entropy = deterministicEntropy(firstVector().seedByte)
    let entropyPtr = 0
    let sawEntropyCopied = false
    let sawEntropyZeroedBeforeFree = false

    const originalMalloc = module._malloc.bind(module)
    const restoreMalloc = restoreModuleFunction(module, '_malloc', (byteLength => {
      const ptr = originalMalloc(byteLength)
      if (byteLength === entropy.length && entropyPtr === 0) {
        entropyPtr = ptr
      }
      return ptr
    }) as PqcWasmModule['_malloc'])
    const originalFree = module._free.bind(module)
    const restoreFree = restoreModuleFunction(module, '_free', (ptr => {
      if (ptr === entropyPtr) {
        sawEntropyZeroedBeforeFree = module.HEAPU8.slice(ptr, ptr + entropy.length).every(byte => byte === 0)
      }
      originalFree(ptr)
    }) as PqcWasmModule['_free'])
    const restoreKeygen = restoreModuleFunction(module, '_qbit_pqc_keygen', ((
      _publicKeyOut,
      _secretKeyOut,
      entropyIn
    ) => {
      sawEntropyCopied = module.HEAPU8.slice(entropyIn, entropyIn + entropy.length).every(
        (byte, index) => byte === entropy[index]
      )
      return errorCodes.BITCOIN_PQC_ERROR_BAD_ARG
    }) as PqcWasmModule['_qbit_pqc_keygen'])

    try {
      expectPqcError(() => rawClient.keygen(entropy), 'BAD_ARG')
      expect(sawEntropyCopied).toBe(true)
      expect(sawEntropyZeroedBeforeFree).toBe(true)
    } finally {
      restoreKeygen()
      restoreFree()
      restoreMalloc()
    }
  })

  it('zeroizes secret-key scratch before free on sign failure', () => {
    const vector = firstVector()
    const message = hexToBytes(vector.messageHex)
    const pair = client.keygen(deterministicEntropy(vector.seedByte))
    const { client: rawClient, module } = raw
    let secretKeyPtr = 0
    let sawSecretKeyCopied = false
    let sawSecretKeyZeroedBeforeFree = false

    const originalMalloc = module._malloc.bind(module)
    const restoreMalloc = restoreModuleFunction(module, '_malloc', (byteLength => {
      const ptr = originalMalloc(byteLength)
      if (byteLength === constants.SK_SIZE && secretKeyPtr === 0) {
        secretKeyPtr = ptr
      }
      return ptr
    }) as PqcWasmModule['_malloc'])
    const originalFree = module._free.bind(module)
    const restoreFree = restoreModuleFunction(module, '_free', (ptr => {
      if (ptr === secretKeyPtr) {
        sawSecretKeyZeroedBeforeFree = module.HEAPU8.slice(ptr, ptr + constants.SK_SIZE).every(byte => byte === 0)
      }
      originalFree(ptr)
    }) as PqcWasmModule['_free'])
    const restoreSign = restoreModuleFunction(module, '_qbit_pqc_sign', ((_signatureOut, secretKeyIn) => {
      sawSecretKeyCopied = module.HEAPU8.slice(secretKeyIn, secretKeyIn + constants.SK_SIZE).every(
        (byte, index) => byte === pair.secretKey[index]
      )
      return errorCodes.BITCOIN_PQC_ERROR_SIGNING_LIMIT
    }) as PqcWasmModule['_qbit_pqc_sign'])

    try {
      const error = expectPqcError(() => rawClient.sign(pair.secretKey, message), 'SIGNING_LIMIT')
      expect(error.nativeName).toBe('BITCOIN_PQC_ERROR_SIGNING_LIMIT')
      expect(sawSecretKeyCopied).toBe(true)
      expect(sawSecretKeyZeroedBeforeFree).toBe(true)
    } finally {
      restoreSign()
      restoreFree()
      restoreMalloc()
    }
  })
})
