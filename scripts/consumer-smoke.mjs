// Consumer smoke for @qbit-oss/pqc. Run by scripts/run-consumer-smoke.mjs from
// inside a clean temp project that has installed the packed tarball. Imports
// the package BY NAME (never by relative path), exercising the public API,
// require(), subpath exports, and Node wasm auto-resolution exactly as an
// external consumer would.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { checkLib, ENTRY_EXPORTS, filesEmbeddingWasm, reachableFrom } from './package-surface.mjs'
import { pinnedSha256, pinnedWasmSha256 } from './wasm-sha256.mjs'

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
// pins the installed factory and binary: read as the build reads it, by
// scripts/wasm-sha256.mjs, which the harness copies next to this file and
// which throws when a file does not have its pinned digest
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const sumsDir = dirname(require.resolve('@qbit-oss/pqc/wasm/SHA256SUMS'))
assert.equal(pinnedSha256(sumsDir, 'pqc.mjs'), sha256(wasmFactoryPath), 'wasm/SHA256SUMS pins the installed pqc.mjs')
assert.equal(pinnedWasmSha256(sumsDir), sha256(wasmBinaryPath), 'wasm/SHA256SUMS pins the installed pqc.wasm')
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
// The import-attribute form the docs also show loads the same fixture, with no
// ExperimentalWarning on any supported Node version (CI's node-matrix runs this
// on the engines floors). Node emits a warning on a later tick, hence the wait.
const warnings = []
const onWarning = warning => warnings.push(`${warning.name}: ${warning.message}`)
process.on('warning', onWarning)
const { default: importedVectors } = await import('@qbit-oss/pqc/fixtures/qbit-core-signature-vectors.json', {
  with: { type: 'json' },
})
await new Promise(resolve => setImmediate(resolve))
process.off('warning', onWarning)
assert.deepEqual(importedVectors, signatureVectors, 'import with { type: json } loads the fixture require() loads')
assert.deepEqual(warnings, [], 'importing a JSON fixture emits no warning')
assert.ok(signatureVectors.accept.length > 0, 'signature fixture has accept vectors')
for (const vector of signatureVectors.accept) {
  const hex = value => Buffer.from(value, 'hex')
  const vectorKey = hex(signatureVectors.keys[vector.key].publicKey)
  assert.equal(verify(vectorKey, hex(vector.message), hex(vector.signature)), true, `fixture signature ${vector.name}`)
}
// (10) init({ expectedWasmSha256 }) reads the installed pqc.wasm itself, through
// locateFile, and compiles it only when it has the digest the package pins;
// with any other digest it compiles nothing
assert.equal(constants.WASM_SHA256, sha256(wasmBinaryPath), 'constants.WASM_SHA256 is the installed pqc.wasm digest')
const checkedCompiles = []
WebAssembly.instantiate = (source, imports) => {
  checkedCompiles.push(createHash('sha256').update(source).digest('hex'))
  return instantiate(source, imports)
}
const wrongDigest = '0'.repeat(64)
let checkedError
try {
  const checked = await init({ locateFile: () => wasmBinaryPath, expectedWasmSha256: constants.WASM_SHA256 })
  assert.deepEqual(Array.from(checked.keygen(entropy).publicKey), Array.from(publicKey), 'checked init keygen matches')
  await init({ locateFile: () => wasmBinaryPath, expectedWasmSha256: wrongDigest }).catch(error => {
    checkedError = error
  })
} finally {
  WebAssembly.instantiate = instantiate
}
assert.deepEqual(checkedCompiles, [constants.WASM_SHA256], 'init() compiled the checked pqc.wasm, and nothing else')
assert.equal(checkedError?.name, 'PqcLoadError', 'a wrong expectedWasmSha256 rejects with a PqcLoadError')
assert.equal(checkedError.kind, 'LOAD_FAILED', 'kind LOAD_FAILED')
assert.equal(checkedError.url, wasmBinaryPath, 'the PqcLoadError names the file read')
assert.ok(
  checkedError.message.includes(constants.WASM_SHA256) && checkedError.message.includes(wrongDigest),
  'the message names the actual and expected digests'
)

// (10) with expectedWasmSha256, a bare moduleUrl is resolved as import()
// resolves it, here to the package's own loader by name, and init() reads and
// checks the pqc.wasm beside it
const fs = require('node:fs')
const fsReadFileSync = fs.readFileSync
const bareReads = []
const bareCompiles = []
// Paths compared as the file system resolves them, so separators and file:
// URLs do not matter (Windows)
const resolvedPath = path => (String(path).startsWith('file:') ? fileURLToPath(path) : resolve(String(path)))
fs.readFileSync = (path, ...rest) => {
  if (String(path).endsWith('.wasm')) bareReads.push(resolvedPath(path))
  return fsReadFileSync(path, ...rest)
}
WebAssembly.instantiate = (source, imports) => {
  bareCompiles.push(createHash('sha256').update(source).digest('hex'))
  return instantiate(source, imports)
}
try {
  const bare = await init({ moduleUrl: '@qbit-oss/pqc/wasm/pqc.mjs', expectedWasmSha256: constants.WASM_SHA256 })
  assert.deepEqual(Array.from(bare.keygen(entropy).publicKey), Array.from(publicKey), 'bare moduleUrl keygen matches')
} finally {
  fs.readFileSync = fsReadFileSync
  WebAssembly.instantiate = instantiate
}
assert.deepEqual(
  bareReads,
  [resolvedPath(wasmBinaryPath)],
  'a bare moduleUrl reads the pqc.wasm beside the loader it names'
)
assert.deepEqual(bareCompiles, [constants.WASM_SHA256], 'init() compiled that pqc.wasm once, after checking it')

// (11) the ./external-wasm entry resolves by name, through require() too, and
// shares the main entry's module instance: one published client, and the same
// classes, constants and functions, everything but init()
const externalPath = require.resolve('@qbit-oss/pqc/external-wasm')
log('resolved external-wasm:', externalPath)
const external = await import('@qbit-oss/pqc/external-wasm')
const main = await import('@qbit-oss/pqc')
assert.equal(require('@qbit-oss/pqc/external-wasm').ready, external.ready, 'require() shares ./external-wasm')
// each entry exports exactly its public API (package-surface.mjs): 0.1.0's
// names and the documented additions, none of the helpers lib/core.mjs keeps
for (const [entry, names] of Object.entries(ENTRY_EXPORTS)) {
  assert.deepEqual(Object.keys(await import(entry)).sort(), [...names].sort(), `${entry} exports its public API`)
}
// lib/core.mjs alone holds the implementation, and every file imports the
// others as package-surface.mjs lists, so no entry carries a second copy
assert.deepEqual(checkLib(dirname(require.resolve('@qbit-oss/pqc'))), [], 'the built lib/ graph')
for (const name of Object.keys(external).filter(name => name !== 'init')) {
  assert.equal(external[name], main[name], `${name} is shared by both entries`)
}
assert.notEqual(external.init, main.init, 'each entry has its own init()')
// no script it reaches embeds pqc.wasm or imports it as a module, while the
// main entry still embeds it
const externalLib = dirname(externalPath)
const externalReach = reachableFrom(externalLib, 'external-wasm.mjs').filter(file => file.endsWith('.mjs'))
assert.deepEqual(
  externalReach,
  ['../wasm/pqc.mjs', './core.mjs', './external-wasm.mjs', './shared.mjs'],
  'lib/external-wasm.mjs reach'
)
assert.deepEqual(filesEmbeddingWasm(externalLib, externalReach), [], 'lib/external-wasm.mjs reaches no base64 WASM')
for (const file of externalReach) {
  assert.doesNotMatch(
    readFileSync(join(externalLib, file), 'utf8'),
    /(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*pqc\.wasm["']/,
    `${file} does not import pqc.wasm`
  )
}
assert.deepEqual(filesEmbeddingWasm(externalLib, ['index.mjs']), ['index.mjs'], 'lib/index.mjs embeds pqc.wasm')

// (12) its default init() reads the installed wasm/pqc.wasm file and compiles
// the binary wasm/SHA256SUMS pins, and publishes the client for both entries
const compiledExternal = []
const wasmFilesRead = []
const readFile = fs.readFileSync
fs.readFileSync = (path, ...rest) => {
  const name = String(path)
  if (name.endsWith('.wasm')) wasmFilesRead.push(name.startsWith('file:') ? fileURLToPath(name) : name)
  return readFile(path, ...rest)
}
WebAssembly.instantiate = (source, imports) => {
  compiledExternal.push(createHash('sha256').update(source).digest('hex'))
  return instantiate(source, imports)
}
let pqc3
try {
  pqc3 = await external.init()
} finally {
  WebAssembly.instantiate = instantiate
  fs.readFileSync = readFile
}
assert.deepEqual(wasmFilesRead, [wasmBinaryPath], 'external init() reads the installed wasm/pqc.wasm')
assert.deepEqual(compiledExternal, [sha256(wasmBinaryPath)], 'external init() compiles the pinned pqc.wasm')
assert.equal(await main.ready(), pqc3, 'the main entry uses the client external init() published')
const sig3 = main.sign(secretKey, msg)
assert.equal(external.verify(publicKey, msg, sig3), true, 'sign and verify across entries')

// (12) the worker entries resolve by name. Everything the client's file
// reaches, through static and dynamic imports and new URL(..., import.meta.url),
// is itself and lib/shared.mjs: never lib/core.mjs, the Emscripten loader or
// pqc.wasm, and no file it reaches embeds WASM
const workerClientPath = require.resolve('@qbit-oss/pqc/worker')
log('resolved worker client: ', workerClientPath)
log('resolved worker handler:', require.resolve('@qbit-oss/pqc/worker/handler'))
const libDir = dirname(workerClientPath)
const clientGraph = reachableFrom(libDir, 'worker.mjs')
assert.deepEqual(clientGraph, ['./shared.mjs', './worker.mjs'], 'lib/worker.mjs reaches only lib/shared.mjs')
for (const file of clientGraph) {
  assert.equal(readFileSync(join(libDir, file), 'utf8').includes('AGFzbQ'), false, `${file} embeds no base64 WASM`)
}

// (13) a sign/verify round trip through a worker_threads worker that serves
// the installed package (consumer-worker.mjs). Its errors are the package's
// classes, and the caller's buffers stay attached
const { createPqcWorkerClient } = await import('@qbit-oss/pqc/worker')
assert.equal(require('@qbit-oss/pqc/worker').createPqcWorkerClient, createPqcWorkerClient, 'require() shares ./worker')
const worker = new Worker(new URL('./consumer-worker.mjs', import.meta.url))
const workerClient = createPqcWorkerClient(worker)
try {
  assert.equal(workerClient.constants, constants, 'the worker client has the package constants')
  const workerSig = await workerClient.sign(secretKey, msg)
  assert.deepEqual(Array.from(workerSig), Array.from(sig), 'the worker signs as this thread does')
  assert.equal(await workerClient.verify(publicKey, msg, workerSig), true, 'the worker verifies its signature')
  assert.equal(secretKey.length, constants.SK_SIZE, "the caller's secret key is not detached")
  const badKey = new Uint8Array(secretKey)
  badKey[constants.SK_SIZE - 1] ^= 0x80
  const failure = await workerClient.sign(badKey, msg).then(
    () => assert.fail('sign with a bad key resolved'),
    error => error
  )
  assert.ok(failure instanceof main.PqcError, 'a worker PqcError is an instance of the package class')
  assert.equal(failure.kind, 'BAD_KEY', 'the rebuilt PqcError keeps its kind')
} finally {
  workerClient.close()
  await worker.terminate()
}

log('ALL CHECKS PASSED')
console.log(JSON.stringify({ ok: true, pkg: '@qbit-oss/pqc' }))
