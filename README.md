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
browsers (see [Loading](#loading)). It is an ES module with no CommonJS build;
on those Node versions, `require('@qbit-oss/pqc')` loads the same module
through `require(esm)`.

## Quick start

In a project with the package installed, save this as `quickstart.mjs` and run
`node quickstart.mjs`:

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
fixture vectors in `fixtures/qbit-core-derivation.json`.

## API

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
CSP and packaging rules for Chrome extensions.

### Service workers

Service workers, Chrome MV3 extension service workers included, do not allow
`import()`, which `init()` uses for the loader, so they should statically
import the Emscripten factory and pass it to `init()`:

```ts
import { init } from '@qbit-oss/pqc'
import createPqcModule from '@qbit-oss/pqc/wasm/pqc.mjs'

const pqc = await init({
  createModule: createPqcModule,
  locateFile: path => chrome.runtime.getURL(`wasm/${path}`),
})
```

With `createModule`, `moduleUrl` is ignored. Without `locateFile`, the
static-factory recipe `init({ createModule: createPqcModule })` compiles the
embedded copy, so the extension need not ship `pqc.wasm`. Call `init()` at the top level of the
service worker, because the client does not survive a restart, and sign off
its thread, because each signature blocks it for about 0.6 s.
[Service worker details](docs/loading.md#service-workers) explain both.

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
- [Derivation contract](docs/derivation.md): how qbit wallet keys are derived,
  with the fixture vectors.
- [MV3 conformance](docs/mv3-conformance.md): CSP, WASM packaging, smoke test
  and security checklist for Chrome MV3 extensions.
- [Security policy](SECURITY.md): reporting vulnerabilities, supported
  versions, audit status and security boundaries.
- [Release checklist](RELEASE.md), [release process](RELEASING.md) and
  [changelog](CHANGELOG.md).

## Upstream

The vendored C inventory is pinned to
`Qbit-Org/qbit-libbitcoinpqc@70008b9362f4f35f3be94283173fb41d28badb38`.
See `vendor/libbitcoinpqc-qbit/UPSTREAM.md` for the copied inventory and
license notes.

## Development

Building and testing from a clone of the repository is described in
[`CONTRIBUTING.md`](CONTRIBUTING.md). [`RELEASE.md`](RELEASE.md) is the release
checklist, [`RELEASING.md`](RELEASING.md) covers versioning, branches and tags,
and [`CHANGELOG.md`](CHANGELOG.md) lists the changes.
