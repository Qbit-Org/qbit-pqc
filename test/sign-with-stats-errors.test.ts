import { beforeAll, describe, expect, it } from 'vitest'

import {
  constants,
  errorCodes,
  nativeErrorKind,
  PqcError,
  type PqcClient,
  type PqcSignStats,
  type PqcWasmModule,
} from '../src/index'
import { freshClient } from './fresh-client'

// SLH-DSA-SHA2-128s secret key layout: [SK_SEED || SK_PRF || PUB_SEED || root]
const SPX_N = 16
const MESSAGE = new Uint8Array([0x71, 0x62, 0x69, 0x74, 0x2d, 0x70, 0x71, 0x63])
// The caps the vendored library sets once signing starts
// (bitcoin_pqc_sign_stats_begin); before that the stats stay all zeros.
const FORSC_MAX_ATTEMPTS = 1835008
const WOTSC_MAX_ATTEMPTS = 0x10000

const NOT_STARTED: PqcSignStats = {
  forscAttempts: 0,
  forscMaxAttempts: 0,
  wotscAttempts: [0, 0, 0, 0, 0],
  wotscLayerCount: 0,
  wotscMaxAttempts: 0,
  wotscMaxObservedAttempts: 0,
  capExceeded: constants.SIGN_LIMITS.NONE,
}

const STARTED: PqcSignStats = {
  forscAttempts: 101957,
  forscMaxAttempts: FORSC_MAX_ATTEMPTS,
  wotscAttempts: [2227, 2137, 107, 495, 449],
  wotscLayerCount: constants.WOTSC_LAYERS,
  wotscMaxAttempts: WOTSC_MAX_ATTEMPTS,
  wotscMaxObservedAttempts: 2227,
  capExceeded: constants.SIGN_LIMITS.NONE,
}

const FORSC_CAP_HIT: PqcSignStats = {
  ...NOT_STARTED,
  forscAttempts: FORSC_MAX_ATTEMPTS,
  forscMaxAttempts: FORSC_MAX_ATTEMPTS,
  wotscMaxAttempts: WOTSC_MAX_ATTEMPTS,
  capExceeded: constants.SIGN_LIMITS.FORSC,
}

// signWithStats attaches the native stats to a PqcError only once signing has
// started. A failure before that reports all zeros, which would read as an
// attempt with caps of 0.

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

// The words qbit_pqc_sign_with_stats writes, in its order.
function statsWords(stats: PqcSignStats): number[] {
  return [
    stats.forscAttempts,
    stats.forscMaxAttempts,
    ...stats.wotscAttempts,
    stats.wotscLayerCount,
    stats.wotscMaxAttempts,
    stats.wotscMaxObservedAttempts,
    stats.capExceeded,
  ]
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

describe('signWithStats error stats', () => {
  let client: PqcClient
  let module: PqcWasmModule
  let publicKey: Uint8Array
  let secretKey: Uint8Array

  beforeAll(async () => {
    ;({ client, module } = await freshClient())
    ;({ publicKey, secretKey } = client.keygen(syntheticEntropy(0x3c)))
  })

  // Replaces the native signer with one that writes `stats` to its stats
  // output, as the shim does on every result, and returns `rc`.
  function withNativeResult(rc: number, stats: PqcSignStats, run: () => void): void {
    const original = module._qbit_pqc_sign_with_stats
    module._qbit_pqc_sign_with_stats = ((_signatureOut, statsOut) => {
      new Uint32Array(module.HEAPU8.buffer, module.HEAPU8.byteOffset + statsOut, constants.SIGN_STATS_WORDS).set(
        statsWords(stats)
      )
      return rc
    }) as PqcWasmModule['_qbit_pqc_sign_with_stats']
    try {
      run()
    } finally {
      module._qbit_pqc_sign_with_stats = original
    }
  }

  it('leaves stats undefined for a secret key whose stored root does not match its seeds', () => {
    const corrupted = flipByte(secretKey, 3 * SPX_N)

    const error = expectPqcError(() => client.signWithStats(corrupted, MESSAGE), 'BAD_KEY')
    expect(error.operation).toBe('signWithStats')
    expect(error.code).toBe(errorCodes.BITCOIN_PQC_ERROR_BAD_KEY)
    expect(error.stats).toBeUndefined()
  })

  it('returns the stats, caps included, from a successful signature', () => {
    const { sig, stats } = client.signWithStats(secretKey, MESSAGE)

    expect(client.verify(publicKey, MESSAGE, sig)).toBe(true)
    expect(stats.forscMaxAttempts).toBe(FORSC_MAX_ATTEMPTS)
    expect(stats.wotscMaxAttempts).toBe(WOTSC_MAX_ATTEMPTS)
    expect(stats.forscAttempts).toBeGreaterThan(0)
    expect(stats.wotscLayerCount).toBe(constants.WOTSC_LAYERS)
    expect(stats.capExceeded).toBe(constants.SIGN_LIMITS.NONE)
  })

  const cases = [
    {
      label: 'SIGNING_LIMIT',
      rc: errorCodes.BITCOIN_PQC_ERROR_SIGNING_LIMIT,
      native: FORSC_CAP_HIT,
      expected: FORSC_CAP_HIT,
    },
    {
      label: 'BAD_SIGNATURE from a failed signature or self-check',
      rc: errorCodes.BITCOIN_PQC_ERROR_BAD_SIGNATURE,
      native: STARTED,
      expected: STARTED,
    },
    {
      label: 'BAD_SIGNATURE from failing to derive the signing randomness',
      rc: errorCodes.BITCOIN_PQC_ERROR_BAD_SIGNATURE,
      native: NOT_STARTED,
      expected: undefined,
    },
    {
      label: 'OUT_OF_MEMORY',
      rc: errorCodes.BITCOIN_PQC_ERROR_OUT_OF_MEMORY,
      native: NOT_STARTED,
      expected: undefined,
    },
    {
      label: 'BAD_KEY',
      rc: errorCodes.BITCOIN_PQC_ERROR_BAD_KEY,
      native: NOT_STARTED,
      expected: undefined,
    },
  ]

  for (const { label, rc, native, expected } of cases) {
    it(`${expected === undefined ? 'leaves stats undefined for' : 'attaches stats to'} ${label}`, () => {
      withNativeResult(rc, native, () => {
        const error = expectPqcError(() => client.signWithStats(secretKey, MESSAGE), nativeErrorKind(rc))
        expect(error.code).toBe(rc)
        expect(error.stats).toEqual(expected)
      })
    })
  }

  // The shim's BAD_ARG early return leaves its stats output unwritten. Fill
  // the stats allocation with bytes whose caps word is not 0, as a reused heap
  // block can hold, and return without writing it.
  for (const { label, rc } of [
    { label: 'BAD_ARG', rc: errorCodes.BITCOIN_PQC_ERROR_BAD_ARG },
    { label: 'an unknown code', rc: -99 },
  ]) {
    it(`leaves stats undefined for ${label} that does not write the stats`, () => {
      const originalMalloc = module._malloc
      const originalSign = module._qbit_pqc_sign_with_stats
      let filled = false
      module._malloc = (byteLength => {
        const ptr = originalMalloc(byteLength)
        if (byteLength === constants.SIGN_STATS_WORDS * Uint32Array.BYTES_PER_ELEMENT) {
          module.HEAPU8.fill(0xa5, ptr, ptr + byteLength)
          filled = true
        }
        return ptr
      }) as PqcWasmModule['_malloc']
      module._qbit_pqc_sign_with_stats = (() => rc) as PqcWasmModule['_qbit_pqc_sign_with_stats']
      try {
        const error = expectPqcError(() => client.signWithStats(secretKey, MESSAGE), nativeErrorKind(rc))
        expect(filled).toBe(true)
        expect(error.code).toBe(rc)
        expect(error.stats).toBeUndefined()
      } finally {
        module._qbit_pqc_sign_with_stats = originalSign
        module._malloc = originalMalloc
      }
    })
  }
})
