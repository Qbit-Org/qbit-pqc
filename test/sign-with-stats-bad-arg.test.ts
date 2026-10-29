import { describe, expect, it } from 'vitest'

import { constants, errorCodes } from '../src/index'
import { freshClient } from './fresh-client'

// qbit_pqc_sign_with_stats returned BAD_ARG before writing stats_out, which
// then held whatever its allocation held (Qbit-Org/qbit-pqc#5). The typed API
// always passes valid arguments, so these call the export directly.

const STATS_BYTES = constants.SIGN_STATS_WORDS * Uint32Array.BYTES_PER_ELEMENT
const FILL = 0xa5

describe('qbit_pqc_sign_with_stats', () => {
  it.each([
    ['signature_out is null', { signature: false, secretKey: true, messageLength: 0 }],
    ['secret_key is null', { signature: true, secretKey: false, messageLength: 0 }],
    ['message is null with a nonzero length', { signature: true, secretKey: true, messageLength: 32 }],
  ])('zeroes stats_out when %s', async (_name, args) => {
    const { module } = await freshClient()
    const statsPtr = module._malloc(STATS_BYTES)
    const signaturePtr = module._malloc(constants.SIG_SIZE)
    const secretKeyPtr = module._malloc(constants.SK_SIZE)
    try {
      module.HEAPU8.fill(FILL, statsPtr, statsPtr + STATS_BYTES)

      const rc = module._qbit_pqc_sign_with_stats(
        args.signature ? signaturePtr : 0,
        statsPtr,
        args.secretKey ? secretKeyPtr : 0,
        0,
        args.messageLength
      )

      expect(rc).toBe(errorCodes.BITCOIN_PQC_ERROR_BAD_ARG)
      expect([...module.HEAPU8.subarray(statsPtr, statsPtr + STATS_BYTES)]).toEqual(Array(STATS_BYTES).fill(0))
    } finally {
      module._free(secretKeyPtr)
      module._free(signaturePtr)
      module._free(statsPtr)
    }
  })
})
