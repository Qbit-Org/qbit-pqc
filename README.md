# @qbit-oss/pqc

`@qbit-oss/pqc` is the TypeScript API for qbit's post-quantum signature
scheme, SLH-DSA-SHA2-128s-bounded30, compiled to WebAssembly for Node and
browsers. It is for wallets, browser extensions and services that derive keys,
sign and verify as qbit Core does; seed phrases, descriptor parsing and BIP32
path walking stay with the caller. The npm package ships its TypeScript source
and pinned C inventory beside the runtime, so the implementation can be
audited.

## Install

```sh
npm install @qbit-oss/pqc
```

With pnpm or Yarn, run `pnpm add @qbit-oss/pqc` or `yarn add @qbit-oss/pqc`.

The package supports Node `^20.19.0 || >=22.12.0`, its `engines` range, and
browsers (see [Supported runtimes](#supported-runtimes)). It is an ES module with no CommonJS build;
on those Node versions, `require('@qbit-oss/pqc')` loads the same module
through `require(esm)`.

## Quick start

In a project with the package installed, save this as `quickstart.mjs` and run
`node quickstart.mjs`:

<!-- snippet: examples/quick-start.mjs -->
```js
import { constants, init, keygen, sign, verify } from '@qbit-oss/pqc'

await init()

const entropy = crypto.getRandomValues(new Uint8Array(constants.MIN_ENTROPY))
const { publicKey, secretKey } = keygen(entropy)

const message = new TextEncoder().encode('hello, qbit')
const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message))
const signature = sign(secretKey, digest)

console.log(verify(publicKey, digest, signature)) // true

const tampered = signature.slice()
tampered[0] ^= 1
console.log(verify(publicKey, digest, tampered)) // false
```

`keygen` needs at least `constants.MIN_ENTROPY` (128) bytes of entropy and
throws a `RangeError` for fewer; longer input is accepted, and all of it is
hashed into the key seed. The same entropy always gives the same key pair, so
draw it from a cryptographically secure generator such as
`crypto.getRandomValues` and keep it as secret as the key. Each `sign` call
takes about 0.6 s and blocks its thread (see [Message size](#message-size)),
and a key is designed for at most 2^30 signatures (see
[Usage bound](#usage-bound)). For wallet keys that qbit Core finds from a
descriptor, use `deriveP2mrDescriptorKey` instead of `keygen` (see
[qbit Wallet Derivation](#qbit-wallet-derivation)).

## qbit Wallet Derivation

Seed phrase and descriptor handling live above this package. For qbit P2MR
wallet compatibility, derive the private BIP32 leaf at
`m/87h/{coin_type}h/0h/{path_change}/{index}`, then call
`deriveP2mrDescriptorKey(leafPrivateKey, index)`: it returns the key qbit
Core's descriptor wallet derives at that position of
`mr(pk(pqc(<xprv>/87h/{coin_type}h/0h/{path_change}/*)))`. It accepts only the
32-byte leaf key, with any leading zero bytes kept, and a non-hardened index
from `0` to `0x7fffffff`. `derivePQCKey` is the low-level HKDF primitive
underneath; any other seed or HKDF tuple derives a key Core never generates.
The [derivation contract](docs/derivation.md) gives the full rules and the
fixture vectors in `fixtures/qbit-core-derivation.json`. The result holds the
keys as `pk32` and `sk64`; `publicKey` and `secretKey`, the names `keygen`
uses, are getters over the same arrays, so in
`const { publicKey, secretKey } = deriveP2mrDescriptorKey(leafPrivateKey, index)`
zeroing `secretKey` zeroes `sk64` too, and the result still enumerates and
serializes as `{ pk32, sk64 }`. The fixtures ship in the package as public,
semver-covered API and load by name on every supported Node version with
`createRequire(import.meta.url)('@qbit-oss/pqc/fixtures/qbit-core-derivation.json')`.
`import ... with { type: 'json' }` also works in bundlers and on every
supported Node version, but TypeScript accepts it only with `module` set to
`node18`, `nodenext`, `esnext` or `preserve`.

## API

<!-- snippet: test/types/readme-api.mts -->
```ts
import { init } from '@qbit-oss/pqc'

declare const leafPrivateKey: Uint8Array // 32-byte BIP32 leaf private key
declare const index: number // descriptor range position, 0 to 0x7fffffff
declare const message: Uint8Array // 32-byte digest of the data to sign

const pqc = await init()
const entropy = crypto.getRandomValues(new Uint8Array(pqc.constants.MIN_ENTROPY))
const { pk32, sk64 } = pqc.deriveP2mrDescriptorKey(leafPrivateKey, index)
const { publicKey, secretKey } = pqc.keygen(entropy)
const signature = pqc.sign(secretKey, message)
const { sig: diagnosticSignature, stats } = pqc.signWithStats(secretKey, message)
const valid = pqc.verify(publicKey, message, signature)
const secretKeyOk = pqc.secretKeyValidate(secretKey)
```

The same functions, and `derivePQCKey`, are also named top-level exports once
an `init()` call has succeeded. Byte inputs are `Uint8Array`s; every function
except `verify` throws a `RangeError` for an input of the wrong length, and
native failures throw a `PqcError` with a typed `kind`. `verify` returns
`false` for any bytes that are not a valid signature, wrong lengths included.
[API details](docs/api.md) covers input validation, the frozen client, error
kinds, and exactly when `verify` throws.

## Initialization

`init()` loads the WASM module and resolves with a frozen client, which it
also publishes for the named exports; calls with the same options share one
load. Until a call succeeds, the named exports throw a `PqcError` with
`kind: 'NOT_INITIALIZED'`; `isInitialized()` tells whether a client is
published, and `await ready()` waits for one without starting a load. When the
module cannot load, `init()` rejects with a `PqcLoadError`
(`kind: 'LOAD_FAILED'`).
[Initialization details](docs/loading.md#initialization) cover which options
share a load, re-initialization, and load errors.

## Loading

By default, `init()` compiles a copy of `pqc.wasm` that the build embeds in
`lib/index.mjs`, so it fetches no file, and webpack, esbuild and Vite need no
configuration. `moduleUrl`, `locateFile` and `wasmBinary` load the WASM from
your own location or bytes instead. [Loading options](docs/loading.md#loading)
describes each one, and [MV3 conformance](docs/mv3-conformance.md) gives the
CSP and packaging rules for Chrome extensions. With
`expectedWasmSha256: constants.WASM_SHA256`, `init()` refuses WASM bytes with
any other SHA-256 before compiling them ([Checking pqc.wasm](docs/loading.md#checking-pqcwasm)).

When you serve or package `pqc.wasm` yourself, import from
`@qbit-oss/pqc/external-wasm` instead: the same API without the embedded copy,
which keeps about 70 KB out of your bundle. Its `init()` loads `pqc.wasm` from
`locateFile`, beside `moduleUrl`, or the package's `wasm/pqc.wasm` file. Both
entries share one module instance, so a client that `init()` publishes through
either one serves the named exports of both.
[Package entries](docs/loading.md#package-entries) compares them.

### Service workers

Service workers, Chrome MV3 extension service workers included, do not allow
`import()`, which `init()` uses for the loader, so they should statically
import the Emscripten factory and pass it to `init()`:

<!-- snippet: test/types/mv3-wasm-import.mts -->
```ts
import { init } from '@qbit-oss/pqc/external-wasm'
import createPqcModule from '@qbit-oss/pqc/wasm/pqc.mjs'

const pqc = await init({
  createModule: createPqcModule,
  locateFile: path => chrome.runtime.getURL(`wasm/${path}`),
})
```

The extension packages `pqc.wasm` at `wasm/pqc.wasm`, and its service worker
bundle carries no second copy. With `createModule`, `moduleUrl` is ignored. To
ship no `pqc.wasm` file instead, import `init` from `@qbit-oss/pqc` and leave
out `locateFile`: the static-factory recipe
`init({ createModule: createPqcModule })` compiles the embedded copy. Call
`init()` at the top level of the service worker, because the client does not
survive a restart, and sign off its thread, because each signature blocks it
for about 0.6 s (see [Signing in a worker](#signing-in-a-worker)).
[Service worker details](docs/loading.md#service-workers) explain both.

## Signing in a worker

`@qbit-oss/pqc/worker` runs the client methods in a dedicated worker, so a
signature does not block the calling thread for 0.6 s. The worker serves a
client with `servePqcWorker` from `@qbit-oss/pqc/worker/handler`, and the
other side calls it through `createPqcWorkerClient`, whose methods return
promises:

<!-- snippet: test/types/docs-worker-browser.mts -->
```ts
// pqc-worker.js
import { init } from '@qbit-oss/pqc'
import { servePqcWorker } from '@qbit-oss/pqc/worker/handler'

servePqcWorker({ client: init() })
```

<!-- snippet: test/types/docs-worker-browser.mts -->
```ts
import { createPqcWorkerClient } from '@qbit-oss/pqc/worker'

const worker = new Worker(new URL('./pqc-worker.js', import.meta.url), { type: 'module' })
const pqc = createPqcWorkerClient(worker)

const signature = await pqc.sign(secretKey, digest)
```

The client copies byte arguments into buffers it transfers, so the caller's
buffers are never detached, and `PqcError` and `PqcLoadError` keep their
classes and fields. The calling side loads no WASM. An MV3 service worker
cannot start a worker, so an offscreen document starts it and relays the
service worker's requests. [Signing in a worker](docs/worker.md) covers Node,
the MV3 relay, the copies the worker zeroes and the ones it cannot, and
closing.

## Supported runtimes

Node `^20.19.0 || >=22.12.0`, browsers with WebAssembly, Chrome MV3
extensions (the service worker, an offscreen document and a dedicated worker),
and the versions of webpack, esbuild and Vite the bundler smoke builds with.
React Native is not supported: the package needs a global `WebAssembly`.
[Supported runtimes](docs/runtimes.md) lists what CI checks in each, and how
to supply a module built or instantiated differently through `createModule`.

## Message size

Sign a 32-byte digest of your data, as qbit Core does with its sighashes, not
the data itself. Signing time grows with the message length, from about 0.6 s
at 32 bytes to several seconds at 64 KiB, and signing blocks its thread
throughout.
`sign` and `signWithStats` throw a `RangeError` for a `msg` longer than
`constants.MAX_MESSAGE_SIZE` (65536 bytes), and `verify` returns `false` for
one, unless the last argument is `{ allowLargeMessage: true }`.
[Message size details](docs/signing.md#message-size) give measured signing
times and the rules for `options`.

## Usage bound

An SLH-DSA-SHA2-128s-bounded30 key is designed for at most 2^30 signatures.
This package keeps no counter and does not stop at that bound, so callers must
persist a signature counter for each public key and stop signing with a key
once its counter reaches 2^30. qbit Core refuses to sign past the bound.

Re-signing the same `(secretKey, message)` bytes returns the same signature
only while the stored key is intact, and `SIGNING_LIMIT` caps the grind
attempts for one message, not the signatures per key.
[Usage bound details](docs/signing.md#usage-bound) explain how to detect a
corrupted key and what to change after a `SIGNING_LIMIT` error.

## Documentation

- [API details](docs/api.md): module format, input validation, the frozen
  client, `PqcError` kinds and `verify` semantics.
- [Initialization and loading](docs/loading.md): sharing and re-initializing a
  client, load errors, loading options, bundlers and service workers.
- [Signing: message size and usage bound](docs/signing.md): measured signing
  times, the 64 KiB cap and its `options`, and the 2^30-signature bound.
- [Signing in a worker](docs/worker.md): the worker client and handler, the
  MV3 offscreen-document relay, buffers, errors and closing.
- [Supported runtimes](docs/runtimes.md): Node, browsers, Chrome MV3,
  bundlers, React Native, and modules built or instantiated differently.
- [Derivation contract](docs/derivation.md): how qbit wallet keys are derived,
  with the fixture vectors.
- [MV3 conformance](docs/mv3-conformance.md): CSP, WASM packaging, smoke test
  and security checklist for Chrome MV3 extensions.
- [Using qbit-js](docs/qbit-js.md): message proofs and PSBT signing with
  qbit-js's `@qbit-oss/protocol`.
- [Security policy](SECURITY.md): reporting vulnerabilities, supported
  versions, audit status and security boundaries.
- [Release checklist](RELEASE.md), [release process](RELEASING.md) and
  [changelog](CHANGELOG.md).

## Upstream

The vendored C inventory is pinned to
`Qbit-Org/qbit-libbitcoinpqc@edcea6cb89941fd60c8919eee74ec490ec914489`.
See `vendor/libbitcoinpqc-qbit/UPSTREAM.md` for the copied inventory and
license notes.

## Development

Building and testing from a clone of the repository is described in
[`CONTRIBUTING.md`](CONTRIBUTING.md). [`RELEASE.md`](RELEASE.md) is the release
checklist, [`RELEASING.md`](RELEASING.md) covers versioning, branches and tags,
and [`CHANGELOG.md`](CHANGELOG.md) lists the changes.
