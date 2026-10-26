# @qbit-oss/pqc

Production TypeScript API for the qbit SLH-DSA-SHA2-128s-bounded30 WASM
package.

The source repository contains the pinned C inventory, C shim, reproducible
baseline Emscripten build, and artifact hash checks. The npm package adds the
compiled runtime, audit-oriented source inventory, and a TypeScript API for
deterministic PQC derivation, key generation, signing, signing diagnostics,
verification, and secret-key validation. Seed phrase, descriptor parsing, and
BIP32 path walking remain above this package layer.

## qbit Wallet Derivation

Seed phrase and descriptor handling live above this package. For qbit P2MR
wallet compatibility, derive the private BIP32 leaf at
`m/87h/{coin_type}h/0h/{path_change}/{index}`, then call
`deriveP2mrDescriptorKey(leafPrivateKey, index)`. It returns the key qbit
Core's descriptor wallet derives at that position of
`mr(pk(pqc(<xprv>/87h/{coin_type}h/0h/{path_change}/*)))`, so importing the
descriptor into Core finds the same addresses. It accepts only what Core can
produce: the 32-byte leaf key with any leading zero bytes kept (not the 33-byte
`00 || key` form inside an xprv, and not a BIP39 seed) and a non-hardened
index from `0` to `0x7fffffff`. For a non-ranged `pqc(...)` descriptor, pass
index `0` whatever the leaf's path: Core derives those keys with HKDF index 0.

`derivePQCKey(masterSeed, hkdfAccount, hkdfChange, hkdfIndex)` is the
low-level primitive underneath. It mirrors Core's HKDF-SHA256 extract/expand
layout and passes the resulting 128 bytes to bounded30 SLH-DSA keygen. Its
numbers are HKDF fields, not BIP32 path fields: Core's wallet derives
`(0, 0, index)` on both branches and carries receive/change separation in the
leaf path. Any other seed or tuple, such as HKDF change `1` for change
addresses or a hardened index, derives a key Core never generates; Core accepts
HKDF change `1` only when matching pubkeys it already knows.

The contract and fixture vectors are documented in
[`docs/derivation.md`](docs/derivation.md). The committed fixture is
`fixtures/qbit-core-derivation.json`.

## API

```ts
import { init } from '@qbit-oss/pqc'

const pqc = await init()
const { pk32, sk64 } = pqc.deriveP2mrDescriptorKey(leafPrivateKey, index)
const { publicKey, secretKey } = pqc.keygen(entropy)
const signature = pqc.sign(secretKey, message)
const { sig: diagnosticSignature, stats } = pqc.signWithStats(secretKey, message)
const valid = pqc.verify(publicKey, message, signature)
const secretKeyOk = pqc.secretKeyValidate(secretKey)
```

The package is an ES module with no separate CommonJS build. On Node
`^20.19.0 || >=22.12.0`, its `engines` range, `require('@qbit-oss/pqc')` loads
that same module through `require(esm)`, so CommonJS and ES module callers
share one instance: `init()` through either one sets up the top-level exports
for both.

Named top-level `deriveP2mrDescriptorKey`, `derivePQCKey`, `keygen`, `sign`,
`signWithStats`, `verify`, and `secretKeyValidate` exports are also available
once an `init()` call has succeeded (see [Initialization](#initialization)).
All byte inputs must be `Uint8Array`s, and every
function except `verify` (see below) throws a `RangeError` for an input of the
wrong length, including a `msg` over the [message size](#message-size) limit.
Subclasses such as Node's `Buffer` and arrays from another realm (an iframe,
worker or `node:vm` context) are accepted, because the check reads the
array's internal type instead of using `instanceof`.
`deriveP2mrDescriptorKey` rejects a leaf key that is not exactly 32 bytes or is
not a secp256k1 private key (zero, or not below the curve order), and an index
outside `0` to `0x7fffffff`; `derivePQCKey` rejects empty master seeds
and non-uint32 HKDF fields. A
zero-length `msg` (`new Uint8Array(0)`) is a valid message for `sign`,
`signWithStats`, and `verify`. It is distinct from a view whose `ArrayBuffer`
has been detached (for example after `postMessage(..., [buffer])`,
`structuredClone(..., { transfer })`, or `ArrayBuffer.prototype.transfer()`):
such views also report `length === 0`, so every entry point rejects them with a
`TypeError` instead of silently signing or verifying the empty message. Views
pushed out of bounds by shrinking a resizable `ArrayBuffer` are rejected the
same way. Validation consults only intrinsic `%TypedArray%` accessors captured
when the module loads (subclass overrides of `length`, `buffer` and friends are
ignored, never invoked), and a view that becomes detached after that check but
before its bytes are copied into WASM memory, for example a `msg` that aliases
the `HEAPU8` of a module the caller built for `createModule` when a call grows
the WASM memory, throws the same `TypeError`. Allocation sizes and the copies
into and out of WASM memory likewise use constructors, methods and sizes
captured when the module loads,
so code that replaces `globalThis.Uint8Array` or patches
`%TypedArray%.prototype` after that cannot change how many bytes are written,
or the key `derivePQCKey` derives.
Validation never runs caller code, such as a `Proxy` trap in an argument's
prototype chain, except the traps of a `Proxy` passed as `options` (see
[Message size](#message-size)). The client `init()` resolves with is frozen,
so no code can replace a method the named exports call, and it does not
expose the WASM module, whose raw exports skip the wrapper's checks and the
zeroing of its copies in WASM memory. The exported `constants` and
`errorCodes` objects are frozen too, nested objects included. Assigning to
any of them throws a `TypeError` in strict mode, which every ES module uses,
and does nothing otherwise.
Native failures from `bitcoin_pqc_*` are exposed as `PqcError`
values with typed `kind`, `code`, and `nativeName` fields; `SIGNING_LIMIT`
errors from `signWithStats` also carry the native signing stats.
`sign` and `signWithStats` reject a secret key whose stored root does not
match its seeds with `kind === 'BAD_KEY'`, the same verdict
`secretKeyValidate` gives for those bytes; `BAD_SIGNATURE` from signing means
the signing operation itself failed. An allocation failure inside the native
library (the key or signature buffers, or the keygen seed-derivation buffer)
surfaces as `OUT_OF_MEMORY`; a failed WASM heap allocation by the wrapper
itself still throws a plain `Error`.

`verify` returns `true` only for a valid signature. It returns `false` for any
other bytes, including a `pk` that is not `constants.PK_SIZE` (32) bytes or a
`sig` that is not `constants.SIG_SIZE` (3680) bytes, as qbit Core's
`CPQCPubKey::Verify` does, and a `msg` longer than
`constants.MAX_MESSAGE_SIZE` (65536) bytes unless the caller opts in (see
[Message size](#message-size)). It rejects a wrong length before allocating
any WASM memory, so a key, signature or message from an untrusted party can be
passed in whatever its length. `verify` throws only:

- a `TypeError` when an argument is not a `Uint8Array`, or is (or becomes
  during the call) a view on a detached or out-of-bounds `ArrayBuffer`, or
  when `options` is invalid. This is checked before the lengths, so it applies
  whatever they are;
- a `PqcError` when the native library fails with anything other than
  `BAD_SIGNATURE`;
- a plain `Error` when the wrapper cannot allocate WASM memory for the inputs,
  for example for a `msg` passed with `allowLargeMessage` that is too large
  for the WASM heap.

To tell a malformed key or signature, or an oversized message, from one that
does not verify, compare its length with `constants.PK_SIZE`,
`constants.SIG_SIZE` or `constants.MAX_MESSAGE_SIZE` before calling `verify`.

## Initialization

`init()` loads the WASM module and resolves with a client, which it also
publishes for the named exports. Calls with the same options share one load:
they return distinct promises that resolve to the same client, so calling
`init()` wherever the package is used does not instantiate another 17 MB
module each time. Options are the same when `moduleUrl` has the same string
form (a `URL` matches its `href`) and `createModule`, `locateFile` and
`wasmBinary` are the same objects; `init()`, `init(undefined)` and `init({})`
are the same. A call with other options loads a new module, so keep the
promise from one `init()` call, or pass the same functions, instead of new
closures on each call.

The named exports use the client of the newest `init()` call that succeeded.
An earlier call that settles later does not replace it, and a call that fails
never unpublishes: after a failed re-init, the named exports keep using the
previous client. Until a call succeeds, they throw a `PqcError` with
`kind: 'NOT_INITIALIZED'` and `code` 0. `isInitialized()` tells whether a
client is published, and `ready()` resolves with it as soon as one is,
waiting until then; it does not start a load. Code that turns any thrown
error into `false`, such as a message-proof check, should `await ready()`
first.

When `init()` cannot load the WASM module, it rejects with a `PqcLoadError`
(`kind: 'LOAD_FAILED'`, `code` 0). That covers a loader that cannot be
imported or exports no factory, a `pqc.wasm` that cannot be fetched, compiled
or instantiated (as when a CSP without `'wasm-unsafe-eval'` blocks compiling
the embedded copy), a module that does not match this version of the package,
and a `createModule` factory that fails. Its `cause` is the original error.
Its `url` names the file that failed, when `init()` knows it: the `moduleUrl`
loader, when that cannot be imported or exports no factory, or the location
the loader asked for `pqc.wasm` at. Otherwise it is undefined, as when the
loader had the bytes (the embedded copy, or `wasmBinary`) and fetched nothing.
The message names both.
Emscripten's own error names neither the URL nor the HTTP status, so in a
browser `init()` requests an `http(s)` or `chrome-extension:` `url` once more,
waiting at most 10 s, only to report the status of an error response as
`status`.

## Loading

By default, `init()` imports the Emscripten loader `wasm/pqc.mjs` and compiles
a copy of `wasm/pqc.wasm` that the build embeds in `lib/index.mjs` as base64.
The copy is the binary that `wasm/SHA256SUMS` pins, and the package's tests
check it against that hash. Because `init()` fetches no `pqc.wasm` file and
imports the loader by a literal path, bundlers need no configuration for
either: `pnpm smoke:bundlers` checks the default `init()` and the
static-factory recipe below in pages built with the stock settings of webpack
5, esbuild (`--platform=browser`, ESM and IIFE output) and Vite 7 and 8 (both
the production build and the dev server). The embedded copy adds about 70 KB
to `lib/index.mjs` (25 KB gzipped).

Only on Node does the loader import Node's `module` builtin. The package's
`browser` field maps that import to an empty module, so browser builds need no
fallback for it. webpack and Vite still emit `pqc.wasm` as an asset, because
the package refers to the file, but the default `init()` does not request it.

`init()` fetches `pqc.wasm` only when told where it is, through `moduleUrl` or
`locateFile`, for example to cache the file separately or to check its hash
where you deploy it. To serve the loader and `pqc.wasm` with your app, copy
both from the same package version and pass the loader's URL as `moduleUrl`;
`pqc.wasm` is then loaded from the loader's directory:

```ts
const pqc = await init({ moduleUrl: new URL('/pqc/pqc.mjs', location.href) })
```

When the loader's URL has no directory, such as a `blob:` or `data:` URL, the
package's own `pqc.wasm` file is loaded. `locateFile(path, prefix)` overrides
where `pqc.wasm` comes from: it is called with `'pqc.wasm'` and the loader's
directory (a URL, or a file path in Node) and returns the URL or path to load,
or `undefined` to keep the default: beside `moduleUrl` when it is set, the
package's `pqc.wasm` file otherwise.
`wasmBinary` passes the WASM bytes instead, and no file is loaded.

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

With `createModule`, `moduleUrl` is ignored. With `locateFile`, as here,
`pqc.wasm` is loaded from the extension. Without `locateFile` or `wasmBinary`,
`init()` compiles the embedded copy, so the extension need not ship
`pqc.wasm`; that form, `init({ createModule: createPqcModule })`, is the
static-factory recipe the bundler smoke checks.

The factory subpath ships its own type declarations, so this snippet
type-checks under `tsc --strict` with `node16` or `bundler` module resolution.
See [`docs/mv3-conformance.md`](docs/mv3-conformance.md) for the required MV3 CSP, local WASM
packaging rules, Chrome for Testing smoke command, and security checklist.

### Service workers

Call `init()` when the service worker starts, at the top level of its module
rather than in an event handler, and have handlers wait for it with
`await ready()` or the promise `init()` returned. The client does not survive
a restart: Chrome stops an idle MV3 service worker and starts it again for the
next event with fresh module state, so `init()` runs again and the client from
before the restart is gone.

Signing is synchronous. `sign` and `signWithStats` take about 0.6 s per
signature and block the thread they run on, so an MV3 service worker handles
no other event while it signs (`verify` takes a few milliseconds). To sign off
that thread, create an offscreen document (`chrome.offscreen.createDocument`
with the `WORKERS` reason) that starts a dedicated module `Worker`, call
`init()` and sign in that worker, and relay each request from the service
worker to the offscreen document with `chrome.runtime.sendMessage` and from
there to the worker with `postMessage`. A dedicated worker allows `import()`,
so the default `init()` works there.

## Message size

Sign a 32-byte digest of your data, as qbit Core does with its sighashes, not
the data itself. Every FORS+C grind attempt hashes the whole message, and a
signature takes tens of thousands of attempts, so signing time grows with the
message length times the number of attempts. `sign` and `signWithStats` are
synchronous and block their thread for that long. Measured in Node 24 and a
Chrome MV3 service worker, and varying with the attempts each message needs:

| Message | Signing time |
| --- | --- |
| 32 bytes | 0.6 s |
| 4 KiB | 0.7–2.5 s |
| 64 KiB | 3.5–7.5 s |
| 256 KiB | 25–80 s |
| 1 MiB | 60–80 s, and 105 s in an MV3 service worker |

The `SIGNING_LIMIT` cap on grind attempts (see [Usage bound](#usage-bound))
does not bound this time: at 1 MiB, about an hour would pass before it fired.
Verifying stays fast, about 2.5 ms at 1 MiB, but copying a message into WASM
memory grows the heap, which never shrinks.

So `sign` and `signWithStats` throw a `RangeError` for a `msg` longer than
`constants.MAX_MESSAGE_SIZE` (65536 bytes), and `verify` returns `false` for
one, before allocating any WASM memory. To sign or verify a longer message,
pass `{ allowLargeMessage: true }` as the last argument:

```ts
const signature = pqc.sign(secretKey, payload, { allowLargeMessage: true })
const valid = pqc.verify(publicKey, payload, signature, { allowLargeMessage: true })
```

`options` must be `undefined` or a plain object (an object literal or
`Object.create(null)`, from the same realm as the package) with no property
other than `allowLargeMessage`, which must be a boolean or `undefined`.
Anything else throws a `TypeError`, whatever the message length. Only the
object's own data properties are read, through functions captured when the
module loads, so a getter is rejected without being called. JavaScript cannot
inspect a `Proxy` without running its traps, so a `Proxy` passed as `options`
runs them, before any other argument is read.

## Usage bound

An SLH-DSA-SHA2-128s-bounded30 key is designed for at most 2^30 signatures.
This package keeps no counter and does not stop at that bound, so callers must
persist a signature counter for each public key and stop signing with a key
once its counter reaches 2^30. qbit Core refuses to sign past the bound.

Re-signing the same `(secretKey, message)` bytes is deterministic: it returns
the same signature, so it reveals nothing new. That holds only while the stored
key is intact. `secretKeyValidate` and signing check the stored root against
the seeds but not the PRF key `SK.prf` (bytes 16–31), so a key corrupted there
still validates and signs the same message differently. Store a checksum with
each key and check it before signing, or count every signature, re-signs
included.

`SIGNING_LIMIT` is a separate cap, on the grind attempts for one message, not
on signatures per key. Retrying the same bytes hits the same limit, so change
the message or transaction bytes before signing again. A `SIGNING_LIMIT` error
from `signWithStats` carries the signing stats, whose `capExceeded` holds the
caps that were hit as bit flags from `constants.SIGN_LIMITS`.

## Upstream

The vendored C inventory is pinned to
`Qbit-Org/qbit-libbitcoinpqc@70008b9362f4f35f3be94283173fb41d28badb38`.
See `vendor/libbitcoinpqc-qbit/UPSTREAM.md` for the copied inventory and
license notes.

## Build

```sh
pnpm build:wasm
pnpm check:wasm
pnpm check:wasm:repro
pnpm build
pnpm smoke:load
pnpm test
pnpm typecheck
pnpm test:mv3
pnpm smoke:bundlers
pnpm pack:check
pnpm smoke:consumer
```

The committed SLH-DSA golden fixture is in `fixtures/slh-dsa-golden.json`, with
a SHA-256 sidecar in `fixtures/slh-dsa-golden.json.sha256`. The fixture's
`source` block records its provenance: the upstream repository and commit, the
Rust test file path, and that file's git blob and SHA-256.

`build:wasm` uses this pinned Emscripten Docker image, `emscripten/emsdk:4.0.10`,
by default:

```text
emscripten/emsdk@sha256:90b757eb11fa9a0e3ce4d2d9f76d932a56018e4accc37b5a28b2783751e60eb7
```

For local-only development, set `USE_LOCAL_EMCC=1` to use `emcc` from `PATH`.
`pnpm check:wasm:repro` refuses to run with `USE_LOCAL_EMCC=1`, `EMSDK_IMAGE`
or `OUT_DIR` set, because its pass is meant to show that the pinned image
rebuilds the committed files; add `QBIT_PQC_REPRO_ALLOW_OVERRIDES=1` to run it
with them anyway. The checked-in `wasm/SHA256SUMS` file records the expected
`pqc.mjs` and `pqc.wasm` hashes; the package exports it as
`@qbit-oss/pqc/wasm/SHA256SUMS`.

The npm tarball keeps the TypeScript source, public fixtures, and pinned
vendored C inventory for auditability while excluding repository-only build,
test, and CI files. See [`RELEASE.md`](RELEASE.md) for the enforced package
policy and release checklist.
Versioning, release branches and tags are described in
[`RELEASING.md`](RELEASING.md); changes are listed in [`CHANGELOG.md`](CHANGELOG.md).
