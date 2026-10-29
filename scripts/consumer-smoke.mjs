// Consumer smoke for @qbit-oss/pqc. Run by scripts/run-consumer-smoke.mjs from
// inside a clean temp project that has installed the packed tarball. Imports
// the package BY NAME (never by relative path), exercising the public API,
// require(), subpath exports, and Node wasm auto-resolution exactly as an
// external consumer would.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const log = (...a) => console.log('[pqc-consumer]', ...a)

// (1) main entry resolves by package name, through require() too: the
// "default" condition loads the same ESM file (require(esm)), so both share one
// module instance and its active client instead of loading a second copy
const required = require('@qbit-oss/pqc')
const { init, constants, keygen, sign, verify, derivePQCKey, secretKeyValidate } = await import('@qbit-oss/pqc')
assert.equal(typeof init, 'function', 'init export present')
assert.equal(required.init, init, 'require() and import() share one module instance')
assert.equal(constants.ALGORITHM, 'SLH-DSA-SHA2-128s-bounded30', 'constants.ALGORITHM')

// (2) subpath exports resolve (MV3 static-import factory, wasm asset and its
// SHA256SUMS, package.json)
const wasmFactoryPath = require.resolve('@qbit-oss/pqc/wasm/pqc.mjs')
const wasmBinaryPath = require.resolve('@qbit-oss/pqc/wasm/pqc.wasm')
log('resolved factory:', wasmFactoryPath)
log('resolved wasm:   ', wasmBinaryPath)
assert.ok(readFileSync(wasmBinaryPath).length > 0, 'wasm binary non-empty')
// SHA256SUMS, which integrators ship with the wasm artifacts (SECURITY.md),
// lists the installed factory and binary
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
assert.deepEqual(
  readFileSync(require.resolve('@qbit-oss/pqc/wasm/SHA256SUMS'), 'utf8').trim().split(/\r?\n/),
  [`${sha256(wasmFactoryPath)}  pqc.mjs`, `${sha256(wasmBinaryPath)}  pqc.wasm`],
  'wasm/SHA256SUMS matches the installed artifacts'
)
assert.equal(require('@qbit-oss/pqc/package.json').name, '@qbit-oss/pqc', './package.json export')
// License files integrators must ship with the wasm artifacts (SECURITY.md)
for (const [notice, marker] of [
  ['@qbit-oss/pqc/LICENSE', 'MIT License'],
  ['@qbit-oss/pqc/THIRD_PARTY_NOTICES', 'Third-party notices for this package'],
]) {
  assert.ok(readFileSync(require.resolve(notice), 'utf8').includes(marker), `${notice} resolves to the notice`)
}

// (3) default init() compiles the copy of pqc.wasm embedded in the installed
// lib/index.mjs, which must be the binary wasm/SHA256SUMS pins
const instantiate = WebAssembly.instantiate
const compiled = []
WebAssembly.instantiate = (source, imports) => {
  compiled.push(createHash('sha256').update(source).digest('hex'))
  return instantiate(source, imports)
}
let pqc
try {
  pqc = await init()
} finally {
  WebAssembly.instantiate = instantiate
}
assert.deepEqual(compiled, [sha256(wasmBinaryPath)], 'init() compiles the pinned pqc.wasm')
// init() checks the wasm sizes against constants itself. The client is frozen
// and exposes no raw wasm module, and constants is frozen throughout
assert.ok(Object.isFrozen(pqc), 'client is frozen')
assert.equal('module' in pqc, false, 'client exposes no wasm module')
for (const frozen of [constants, constants.SIGN_LIMITS, constants.ERROR_CODES]) {
  assert.ok(Object.isFrozen(frozen), 'constants is frozen')
}

// (4) keygen
const entropy = new Uint8Array(constants.MIN_ENTROPY)
for (let i = 0; i < entropy.length; i++) entropy[i] = (i * 7 + 1) & 0xff
const { publicKey, secretKey } = pqc.keygen(entropy)
assert.equal(publicKey.length, constants.PK_SIZE, 'publicKey length')
assert.equal(secretKey.length, constants.SK_SIZE, 'secretKey length')
assert.equal(pqc.secretKeyValidate(secretKey), true, 'secretKeyValidate(secretKey)')

// (5) sign + verify roundtrip (+ negative case)
const msg = new TextEncoder().encode('qbit fresh-consumer smoke')
const sig = pqc.sign(secretKey, msg)
assert.equal(sig.length, constants.SIG_SIZE, 'signature length')
assert.equal(pqc.verify(publicKey, msg, sig), true, 'verify(valid) === true')
const tampered = new TextEncoder().encode('qbit fresh-consumer smoke!')
assert.equal(pqc.verify(publicKey, tampered, sig), false, 'verify(tampered) === false')

// (6) top-level named exports use the post-init singleton + deterministic signing
const sigTop = sign(secretKey, msg)
assert.equal(verify(publicKey, msg, sigTop), true, 'top-level verify')
assert.deepEqual(Array.from(sigTop), Array.from(sig), 'signing is deterministic')
assert.equal(secretKeyValidate(secretKey), true, 'top-level secretKeyValidate')
void keygen // exported

// (7) derivePQCKey determinism, shape, usability, and empty-seed rejection
const seed = new Uint8Array(32)
for (let i = 0; i < seed.length; i++) seed[i] = (i + 3) & 0xff
const d1 = pqc.derivePQCKey(seed, 0, 0, 5)
const d2 = pqc.derivePQCKey(seed, 0, 0, 5)
assert.equal(d1.pk32.length, 32, 'derived pk32 length')
assert.equal(d1.sk64.length, 64, 'derived sk64 length')
assert.deepEqual(Array.from(d1.pk32), Array.from(d2.pk32), 'derive deterministic (pk)')
assert.deepEqual(Array.from(d1.sk64), Array.from(d2.sk64), 'derive deterministic (sk)')
const dsig = pqc.sign(d1.sk64, msg)
assert.equal(pqc.verify(d1.pk32, msg, dsig), true, 'derived key signs+verifies')
assert.throws(() => pqc.derivePQCKey(new Uint8Array(0), 0, 0, 0), 'empty seed rejected')

// (8) explicit MV3-style init via the subpath factory export
const { default: createModule } = await import('@qbit-oss/pqc/wasm/pqc.mjs')
const pqc2 = await init({ createModule })
const e2 = pqc2.keygen(entropy)
assert.deepEqual(Array.from(e2.publicKey), Array.from(publicKey), 'MV3-factory init keygen matches')

log('ALL CHECKS PASSED')
console.log(JSON.stringify({ ok: true, pkg: '@qbit-oss/pqc' }))
