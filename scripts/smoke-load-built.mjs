#!/usr/bin/env node
import { init, constants } from '../lib/index.mjs'
import createPqcModule from '../wasm/pqc.mjs'

// The client does not expose its WASM module, so this script builds the
// module itself and passes it to init().
let module
await init({ createModule: async options => (module = await createPqcModule(options)) })

const actual = {
  publicKey: module._qbit_pqc_public_key_size(),
  secretKey: module._qbit_pqc_secret_key_size(),
  signature: module._qbit_pqc_signature_size(),
  minEntropy: module._qbit_pqc_keygen_entropy_min_size(),
}

const expected = {
  publicKey: constants.PK_SIZE,
  secretKey: constants.SK_SIZE,
  signature: constants.SIG_SIZE,
  minEntropy: constants.MIN_ENTROPY,
}

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`unexpected WASM constants: ${JSON.stringify(actual)}`)
}

console.log(JSON.stringify({ ok: true, actual }))
