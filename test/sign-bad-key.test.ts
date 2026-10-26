import { beforeAll, describe, expect, it } from 'vitest'

import {
  constants,
  errorCodes,
  nativeErrorKind,
  nativeErrorName,
  PqcError,
  type PqcClient,
  type PqcWasmModule,
} from '../src/index'
import { freshClient } from './fresh-client'

// SLH-DSA-SHA2-128s secret key layout: [SK_SEED || SK_PRF || PUB_SEED || root]
const SPX_N = 16
const MESSAGE = new Uint8Array([0x71, 0x62, 0x69, 0x74, 0x2d, 0x70, 0x71, 0x63])

// Regression coverage for inconsistent secret keys: signing with a secret key
// whose stored root does not match its seeds surfaced as BAD_SIGNATURE while
// secretKeyValidate reported BAD_KEY for the same bytes. Callers that branch
// on `kind` need the same verdict from both. All key material here is
// synthetic and derived from fixed test entropy.

function syntheticEntropy(seedByte: number): Uint8Array {
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 53) % 256)) & 0xff
  }
  return entropy
}

function flipByte(bytes: Uint8Array, offset: number): Uint8Array {
  const copy = new Uint8Array(bytes)
  copy[offset] ^= 0x80
  return copy
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

describe('sign with an inconsistent secret key', () => {
  let client: PqcClient
  let module: PqcWasmModule
  let publicKey: Uint8Array
  let secretKey: Uint8Array

  beforeAll(async () => {
    ;({ client, module } = await freshClient())
    const pair = client.keygen(syntheticEntropy(0x3c))
    publicKey = pair.publicKey
    secretKey = pair.secretKey
    expect(secretKey).toHaveLength(4 * SPX_N)
  })

  const rejectedRegions = [
    { label: 'SK_SEED', offset: 0 },
    { label: 'PUB_SEED', offset: 2 * SPX_N },
    { label: 'root', offset: 3 * SPX_N },
    { label: 'last root', offset: 4 * SPX_N - 1 },
  ]

  for (const { label, offset } of rejectedRegions) {
    it(`reports a flipped ${label} byte as BAD_KEY from sign, signWithStats, and validate`, () => {
      const corrupted = flipByte(secretKey, offset)

      expect(client.secretKeyValidate(corrupted)).toBe(false)

      const error = expectPqcError(() => client.sign(corrupted, MESSAGE), 'BAD_KEY')
      expect(error.operation).toBe('sign')
      expect(error.code).toBe(errorCodes.BITCOIN_PQC_ERROR_BAD_KEY)
      expect(error.nativeName).toBe('BITCOIN_PQC_ERROR_BAD_KEY')

      const statsError = expectPqcError(
        () => client.signWithStats(corrupted, MESSAGE),
        'BAD_KEY'
      )
      expect(statsError.operation).toBe('signWithStats')
      expect(statsError.code).toBe(errorCodes.BITCOIN_PQC_ERROR_BAD_KEY)
    })
  }

  it('control: a flipped SK_PRF byte still validates, signs, and verifies', () => {
    const prfOnly = flipByte(secretKey, SPX_N)

    expect(client.secretKeyValidate(prfOnly)).toBe(true)
    const signature = client.sign(prfOnly, MESSAGE)
    expect(client.verify(publicKey, MESSAGE, signature)).toBe(true)
  })

  it('control: the untouched key still signs and verifies', () => {
    const signature = client.sign(secretKey, MESSAGE)
    expect(client.verify(publicKey, MESSAGE, signature)).toBe(true)
  })

  it('reports a failed native keygen seed allocation as OUT_OF_MEMORY', () => {
    // The vendored keygen hashes the entropy through a heap buffer that grows
    // with the entropy length. A length this close to the 32-bit SIZE_MAX
    // passes the overflow check but asks the WASM allocator for more than the
    // linear memory can ever hold, so malloc fails before any entropy byte is
    // read. The previous vendored library reported that failure as BAD_KEY.
    // This assumes the pinned wasm32 build in scripts/build-wasm.sh, where the
    // C-internal malloc returns NULL on an impossible request instead of
    // aborting; a build that aborts would fail this test loudly, not pass it.
    const entropy = syntheticEntropy(0x5a)
    const entropyPtr = module._malloc(entropy.length)
    const publicKeyPtr = module._malloc(constants.PK_SIZE)
    const secretKeyPtr = module._malloc(constants.SK_SIZE)
    try {
      module.HEAPU8.set(entropy, entropyPtr)
      const rc = module._qbit_pqc_keygen(publicKeyPtr, secretKeyPtr, entropyPtr, 0xffff_fc00)
      expect(rc).toBe(errorCodes.BITCOIN_PQC_ERROR_OUT_OF_MEMORY)
      expect(nativeErrorKind(rc)).toBe('OUT_OF_MEMORY')
    } finally {
      module._free(entropyPtr)
      module._free(publicKeyPtr)
      module._free(secretKeyPtr)
    }
  })

  it('maps BITCOIN_PQC_ERROR_OUT_OF_MEMORY to the OUT_OF_MEMORY kind', () => {
    expect(errorCodes.BITCOIN_PQC_ERROR_OUT_OF_MEMORY).toBe(-6)
    expect(nativeErrorName(errorCodes.BITCOIN_PQC_ERROR_OUT_OF_MEMORY)).toBe(
      'BITCOIN_PQC_ERROR_OUT_OF_MEMORY'
    )
    expect(nativeErrorKind(errorCodes.BITCOIN_PQC_ERROR_OUT_OF_MEMORY)).toBe('OUT_OF_MEMORY')

    const originalSign = module._qbit_pqc_sign
    module._qbit_pqc_sign = (() =>
      errorCodes.BITCOIN_PQC_ERROR_OUT_OF_MEMORY) as PqcWasmModule['_qbit_pqc_sign']
    try {
      const error = expectPqcError(() => client.sign(secretKey, MESSAGE), 'OUT_OF_MEMORY')
      expect(error.code).toBe(errorCodes.BITCOIN_PQC_ERROR_OUT_OF_MEMORY)
      expect(error.nativeName).toBe('BITCOIN_PQC_ERROR_OUT_OF_MEMORY')
      expect(error.message).toBe('sign failed with BITCOIN_PQC_ERROR_OUT_OF_MEMORY (-6)')
    } finally {
      module._qbit_pqc_sign = originalSign
    }
  })
})
