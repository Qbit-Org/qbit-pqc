// Consumer smoke for @qbit-oss/pqc. Run by scripts/run-consumer-smoke.mjs from
// inside a clean temp project that has installed the packed tarball. Imports
// the package BY NAME (never by relative path), exercising the public API,
// require(), subpath exports, and Node wasm auto-resolution exactly as an
// external consumer would.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const log = (...a) => console.log('[pqc-consumer]', ...a)

// (1) main entry resolves by package name, through require() too: the
// "default" condition loads the same ESM file (require(esm)), so both share one
// module instance and its active client instead of loading a second copy
const required = require('@qbit-oss/pqc')
const { init, constants, keygen, sign, verify, derivePQCKey, deriveP2mrDescriptorKey, secretKeyValidate } =
  await import('@qbit-oss/pqc')
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
// Every shipped fixture resolves by name through "./fixtures/*", which reaches
// nothing outside fixtures/, and the golden fixture matches its sidecar
const fixturesDir = join(dirname(require.resolve('@qbit-oss/pqc/package.json')), 'fixtures')
const fixtureFiles = readdirSync(fixturesDir).sort()
assert.ok(fixtureFiles.includes('slh-dsa-golden.json.sha256'), 'fixtures ship with the golden sidecar')
for (const file of fixtureFiles) {
  const resolved = require.resolve(`@qbit-oss/pqc/fixtures/${file}`)
  assert.equal(resolved, join(fixturesDir, file), `@qbit-oss/pqc/fixtures/${file} resolves`)
  log('resolved fixture:', resolved)
}
// Node rejects a pattern match with a "." or ".." segment, encoded or not, and
// any path no export names, so a widened pattern fails here
for (const [outside, code] of [
  ['fixtures/../package.json', 'ERR_INVALID_MODULE_SPECIFIER'],
  ['fixtures/../lib/index.mjs', 'ERR_INVALID_MODULE_SPECIFIER'],
  ['fixtures/%2e%2e/package.json', 'ERR_INVALID_MODULE_SPECIFIER'],
  ['fixtures', 'ERR_PACKAGE_PATH_NOT_EXPORTED'],
  ['src/index.ts', 'ERR_PACKAGE_PATH_NOT_EXPORTED'],
  ['vendor/libbitcoinpqc-qbit/UPSTREAM.md', 'ERR_PACKAGE_PATH_NOT_EXPORTED'],
]) {
  assert.throws(() => require.resolve(`@qbit-oss/pqc/${outside}`), { code }, `@qbit-oss/pqc/${outside} is not exported`)
  log('not exported:    ', `@qbit-oss/pqc/${outside}`, code)
}
const goldenSidecar = readFileSync(require.resolve('@qbit-oss/pqc/fixtures/slh-dsa-golden.json.sha256'), 'utf8')
const [goldenSum, goldenName] = goldenSidecar.trim().split(/\s+/)
assert.equal(basename(goldenName), 'slh-dsa-golden.json', 'the sidecar names the golden fixture')
assert.equal(sha256(require.resolve('@qbit-oss/pqc/fixtures/slh-dsa-golden.json')), goldenSum, 'golden fixture sha256')

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
// Derived keys also read their keys under keygen's names, through
// non-enumerable getters over the same arrays: the result still enumerates and
// serializes as { pk32, sk64 }, and zeroing pk32 and sk64, as wallet code does
// after use, leaves no copy behind under publicKey or secretKey
for (const [name, derive] of [
  ['client derivePQCKey', () => pqc.derivePQCKey(seed, 0, 0, 5)],
  ['named derivePQCKey', () => derivePQCKey(seed, 0, 0, 5)],
  ['client deriveP2mrDescriptorKey', () => pqc.deriveP2mrDescriptorKey(seed, 5)],
  ['named deriveP2mrDescriptorKey', () => deriveP2mrDescriptorKey(seed, 5)],
]) {
  const derived = derive()
  assert.equal(derived.publicKey, derived.pk32, `${name}: publicKey is pk32`)
  assert.equal(derived.secretKey, derived.sk64, `${name}: secretKey is sk64`)
  assert.deepEqual(Object.keys(derived), ['pk32', 'sk64'], `${name}: enumerates as { pk32, sk64 }`)
  assert.equal(JSON.stringify(derived), JSON.stringify({ pk32: derived.pk32, sk64: derived.sk64 }), `${name}: JSON`)
  assert.deepEqual(Array.from(derived.pk32), Array.from(d1.pk32), `${name}: derives the same key`)
  derived.pk32.fill(0)
  derived.sk64.fill(0)
  assert.deepEqual(derived.publicKey, new Uint8Array(constants.PK_SIZE), `${name}: zeroing pk32 zeroes publicKey`)
  assert.deepEqual(derived.secretKey, new Uint8Array(constants.SK_SIZE), `${name}: zeroing sk64 zeroes secretKey`)
}
assert.throws(() => pqc.derivePQCKey(new Uint8Array(0), 0, 0, 0), 'empty seed rejected')

// (8) explicit MV3-style init via the subpath factory export
const { default: createModule } = await import('@qbit-oss/pqc/wasm/pqc.mjs')
const pqc2 = await init({ createModule })
const e2 = pqc2.keygen(entropy)
assert.deepEqual(Array.from(e2.publicKey), Array.from(publicKey), 'MV3-factory init keygen matches')

// (9) a JSON fixture loads by name with require(), the form the docs recommend
// for every supported Node version, and the qbit Core signatures it records
// verify with the installed package
const signatureVectors = require('@qbit-oss/pqc/fixtures/qbit-core-signature-vectors.json')
assert.ok(signatureVectors.accept.length > 0, 'signature fixture has accept vectors')
for (const vector of signatureVectors.accept) {
  const hex = value => Buffer.from(value, 'hex')
  const vectorKey = hex(signatureVectors.keys[vector.key].publicKey)
  assert.equal(verify(vectorKey, hex(vector.message), hex(vector.signature)), true, `fixture signature ${vector.name}`)
}

log('ALL CHECKS PASSED')
console.log(JSON.stringify({ ok: true, pkg: '@qbit-oss/pqc' }))
