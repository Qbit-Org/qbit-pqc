# Changelog

Notable changes to `@qbit-oss/pqc`. Versions follow SemVer (see
[RELEASING.md](RELEASING.md)). Below 1.0, breaking changes bump MINOR.

## 0.1.1 (unreleased)

### API

- A `PqcError` from `signWithStats` carries `stats` only when signing had
  started: every `SIGNING_LIMIT` error, and a `BAD_SIGNATURE` from a failed
  signature or self-check. Before, every native failure carried a `stats`
  object, all zeros when signing failed before it started, which read like an
  attempt with caps of 0. The wrapper also zeroes the stats buffer before the
  native call, so a failure that returns without writing the stats can no
  longer report leftover WASM heap bytes.

  **Compatibility:** `stats` is now `undefined` on `BAD_KEY` (for example a
  secret key whose stored root does not match its seeds), `OUT_OF_MEMORY`, a
  `BAD_SIGNATURE` from deriving the signing randomness, and any other failure
  before signing starts, so code that reads `error.stats.<field>`
  unconditionally must check for `undefined` first. `SIGNING_LIMIT` errors,
  the only ones documented to carry stats, keep them, and maintainers chose to
  ship this in a patch release.
- `derivePQCKey` and `deriveP2mrDescriptorKey`, on the client and as named
  exports, also read the key pair as `publicKey` and `secretKey`, the names
  `keygen` uses: non-enumerable getters, with no setter, that return whatever
  the result's `pk32` and `sk64`, which stay, hold when read. They are the
  same `Uint8Array`s, not copies, so zeroing either name zeroes both. Both
  functions now return the new type `PqcDerivedKeyPair`, which extends the
  unchanged `PqcDerivedKey` with the two read-only fields.
  **Compatibility:** the result's runtime shape, enumeration and serialization
  are unchanged from 0.1.0: `Object.keys`, `JSON.stringify` and deep equality
  see only `{ pk32, sk64 }`. A spread, `Object.assign` or
  `structuredClone`/`postMessage` copy of a derived key has only `pk32` and
  `sk64`, although TypeScript still types the copy as having `publicKey` and
  `secretKey`, so read the aliases from the original result or copy `pk32` and
  `sk64`. TypeScript code that implements `PqcClient` itself, such as a fake
  client, must now return the aliases from its derive methods; the maintainers
  chose to ship this in a patch release.
- New `./fixtures/*` export: the conformance fixtures the package already
  ships resolve by name, such as
  `@qbit-oss/pqc/fixtures/qbit-core-signature-vectors.json` and the
  `slh-dsa-golden.json.sha256` sidecar, so tests can check keys and signatures
  against the recorded vectors. Before, resolving one threw
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. The pattern reaches only files in
  `fixtures/`.
- The Emscripten glue builds `HEAPU8` and its other heap views, when the
  module is instantiated and whenever a call grows WASM memory, with
  typed-array constructors captured when the package loads, and computes how
  far to grow with captured `Math` functions. It used the globals of that
  moment, so code that replaced `globalThis.Uint8Array` or `Math` after the
  package loaded chose the view the wrapper copies inputs and secret keys
  into and out of, and how much memory a call grew. `init()` passes the
  package's copies to the factory for the default loader, `moduleUrl` and
  `createModule`; a factory called without them uses copies the glue takes
  when it is imported. Keys, signatures and the module's exports are
  unchanged.

### Native library

- The vendored `libbitcoinpqc` is pinned to `Qbit-Org/qbit-libbitcoinpqc` at
  `edcea6cb` (previously `70008b93`). Four vendored files change: `sha2.c` and
  `sha2.h` gain test-only helpers that the WASM build does not compile, and
  `hash_sha2.c` and `sign.c` rewrite a zeroing loop so that its counter does
  not wrap past zero. Keys, signatures and verification results are
  unchanged; the golden vectors and qbit Core's signatures still match byte
  for byte.
- `qbit_pqc_sign_with_stats` zeroes `stats_out` before it rejects its
  arguments with `BAD_ARG`, so every return writes the stats. The typed API
  always passes valid arguments, so nothing it returns changes.
- `wasm/pqc.mjs` and `wasm/pqc.wasm`, and the copy of `pqc.wasm` embedded in
  `lib/index.mjs`, are rebuilt with these changes and the glue change above.
  Their SHA-256 values in `wasm/SHA256SUMS` are now
  `091449fc10219a553c551bc41821888d66d640a3c6bf772c906e150ea79b8279` for
  `pqc.mjs` (previously `4c9f9d9d…`) and
  `f7bbbf8ce9cc7d039c1083ddebfd8fdd176864d2bae61b2021eb7f391dd678aa` for
  `pqc.wasm` (previously `8696a3a4…`). Integrators who pin these hashes, as
  qbit-wallet does in `scripts/security/sdk-package-pins.json`, must update
  them.

## 0.1.0 (2026-10-26)

This was the first release, and nothing had been published before it. Changes
are listed against version `0.0.0`, the unreleased state before the
pre-release review. **Breaking** marks a change that can make existing
caller code fail or behave differently.

### API

- **Breaking:** a byte input (`entropy`, `masterSeed`, `sk`, `pk`, `msg` or
  `sig`) whose `ArrayBuffer` has been detached, or that a shrunk resizable
  buffer has pushed out of bounds, is rejected with a `TypeError`. Before, such
  a view read as empty, so `sign` signed the empty message and `verify` could
  accept a signature over the empty message.
- **Breaking:** `sign` and `signWithStats` reject a secret key whose stored
  root does not match its seeds with `kind: 'BAD_KEY'` instead of
  `'BAD_SIGNATURE'`; `secretKeyValidate` returns `false` for the same bytes. An
  allocation failure inside the native library throws the new kind
  `'OUT_OF_MEMORY'` (code `-6`). `PqcErrorKind` and `PqcNativeErrorCode` gain
  these members, so an exhaustive `switch` over them needs a new case.
- **Breaking:** `verify` returns `false` instead of throwing a `RangeError`
  when `pk` is not 32 bytes or `sig` is not 3680 bytes, as qbit Core's
  `CPQCPubKey::Verify` does. It decides this before allocating any WASM
  memory, so a key or signature of the wrong length, however long, neither
  throws nor costs a copy. It still throws a `TypeError` for an argument that
  is not a `Uint8Array` or is detached or out of bounds, and a `PqcError` for
  a native failure other than `BAD_SIGNATURE`. Code that caught the
  `RangeError` to report malformed input can compare the lengths with
  `constants.PK_SIZE` and `constants.SIG_SIZE` first.
- **Breaking:** `sign` and `signWithStats` throw a `RangeError` for a `msg`
  longer than 64 KiB (65536 bytes, the new `constants.MAX_MESSAGE_SIZE`), and
  `verify` returns `false` for one, unless the caller passes a new optional
  last argument, `{ allowLargeMessage: true }`. Every grind attempt rehashes
  the whole message, so signing 1 MiB took one to two minutes, and verifying a
  large message grew the WASM heap for the instance's lifetime; qbit Core signs
  and verifies only 32-byte sighashes. Both decide before allocating any WASM
  memory. Signatures and verification results for messages up to 64 KiB are
  unchanged. The new argument must be `undefined` or a plain object whose only
  property, if any, is a boolean `allowLargeMessage`; any other value in that
  position, which used to be ignored, throws a `TypeError`.
- **Breaking:** `init({ moduleUrl })` loads `pqc.wasm` from the directory of
  the `pqc.mjs` that `moduleUrl` points at. Before, it always loaded the
  package's own `wasm/pqc.wasm`, so serving both files from another directory
  needed `locateFile` or `wasmBinary`, and a `pqc.mjs` copied without its
  `pqc.wasm` still loaded; that now fails. A custom `locateFile` that returns
  `undefined` or `null` defers to that same default: beside `moduleUrl` when
  it is set, the package's copy otherwise. Calls without `moduleUrl`, or with
  `wasmBinary` or `createModule`, behave as before.
- **Breaking:** when zeroing a WASM allocation fails while a call cleans up,
  as it does once a module from a custom `createModule` factory keeps a
  `HEAPU8` view that went stale when WASM memory grew, the rest of the cleanup
  still runs, so every allocation is freed, and the call throws its own
  error, such as the `PqcError` of a failed native call or the `TypeError`
  for an input detached during the call. Before, the first failure skipped
  the rest of the cleanup, leaking those allocations, and its `TypeError`
  replaced the call's error. A call that had otherwise succeeded still throws
  the cleanup's error, now after freeing everything.
- **Breaking:** `init()` loads a `pqc.wasm` file only when told where it is.
  The default `init()`, and `init({ createModule })` without `locateFile` or
  `wasmBinary`, compile a copy of `wasm/pqc.wasm` that the build embeds in
  `lib/index.mjs` as base64: the same binary `wasm/SHA256SUMS` pins, which a
  test and `pnpm smoke:consumer` check. Before, they fetched the package's
  `wasm/pqc.wasm` (in Node, read it from disk), so a page now makes no request
  for it. `moduleUrl`, `locateFile` and `wasmBinary` work as before, and only
  `moduleUrl` and `locateFile` make `init()` load the file. `lib/index.mjs`
  grows by about 70 KB (25 KB gzipped).
- **Breaking:** `PqcErrorKind` gains `'NOT_INITIALIZED'` and `'LOAD_FAILED'`,
  so an exhaustive `switch` over it needs new cases. A named export called
  before any `init()` call has succeeded, including after a failed first
  `init()`, throws a `PqcError` with `kind: 'NOT_INITIALIZED'` and `code` 0
  instead of a plain `Error`; the message is unchanged. Code that turns any
  thrown error from `verify` into `false` can `await ready()` first.
- **Breaking:** when `init()` cannot load the WASM module, it rejects with
  the new `PqcLoadError` (`kind: 'LOAD_FAILED'`, `operation: 'init'`,
  `code` 0). That covers a loader that cannot be imported or exports no
  factory, a `pqc.wasm` that cannot be fetched, compiled or instantiated (the
  embedded copy included, as under a CSP without `'wasm-unsafe-eval'`), a
  module that does not match this version of the package, and a failing
  `createModule`. Its `cause` is the error `init()` rejected with before:
  Emscripten's abort (`RuntimeError: Aborted(...)`), the import error, the
  factory's error, or the package's own `TypeError` or `Error`. Its `url`
  names the `moduleUrl` loader or the location the loader asked for
  `pqc.wasm` at, and is undefined when there is no file to name; the message
  names both. In a browser,
  `init()` requests an `http(s)` or `chrome-extension:` `url` once more,
  within 10 s, only to report the HTTP status of an error response as
  `status`.
- **Breaking:** `init()` calls with the same options share one load and
  resolve to the same client; before, every call instantiated a new 17 MB
  module. Options are the same when `moduleUrl` has the same string form and
  `createModule`, `locateFile` and `wasmBinary` are the same objects, and a
  failed load is not shared. The named exports use the client of the newest
  call that succeeded; before, an older call that settled last replaced it. A
  failed call still leaves the published client in place. Code that needs a
  module of its own can pass a new `createModule` function.
- **Breaking:** the client `init()` resolves with is frozen and has no
  `module` property. Assigning to one of its methods throws a `TypeError` in
  strict mode and does nothing otherwise, and spying on one with a test
  framework fails the same way. Before, `client.verify = () => true`, or a
  spy left in place, made every named `verify` in the realm return `true`,
  and `client.module` handed out the raw WASM exports, which skip the
  wrapper's input checks and the zeroing of its copies in WASM memory. Code
  that needs the module, such as a test that instruments it, can build it
  with the factory `@qbit-oss/pqc/wasm/pqc.mjs` exports, pass that through
  `init({ createModule })` and keep its own reference. `constants`,
  `errorCodes` and its alias `errors` are frozen, nested objects included, so
  a write to them throws in strict mode instead of changing what other code
  reads. `nativeErrorName` and `nativeErrorKind` no longer read inherited
  keys: `nativeErrorKind('constructor')` returns `'UNKNOWN'` instead of
  `undefined`.
- New `isInitialized()` and `ready()`: whether a client is published, and a
  promise for it that resolves as soon as one is.
- `init()` imports `wasm/pqc.mjs` by a literal relative path instead of a URL
  computed at run time, so bundlers include the loader. With the embedded
  copy, the default `init()` and the static-factory recipe work with no bundler
  configuration in webpack 5, esbuild (`--platform=browser`, ESM and IIFE
  output) and Vite (production build and dev server). Before, webpack and
  esbuild failed to build the recipe on the loader's `import("module")`, the
  default `init()` threw at run time in their bundles, and Vite's dev server
  requested `/node_modules/.vite/deps/undefined` for both. When `init()` has
  the WASM bytes, its default `locateFile` no longer reads `import.meta.url`,
  so `init({ wasmBinary })` also works where a bundle leaves `import.meta`
  empty, as an esbuild IIFE bundle does.
- Byte inputs are recognized and measured through `%TypedArray%` accessors
  captured when the module loads. A `length` getter that changed between reads
  could make `sign` sign different bytes from the caller's and write past a
  WASM heap allocation; an overridden `length`, a replaced prototype or a
  `Proxy` trap can no longer change how many bytes are signed, verified or
  copied, and validation runs no caller code. `Uint8Array`s from another realm
  (an iframe, a worker or a `node:vm` context) are now accepted.
- `derivePQCKey` and `deriveP2mrDescriptorKey` hash a copy of the seed taken
  right after validation, and their SHA-256, HMAC-SHA-256 and HKDF call only
  `%TypedArray%` and `DataView` methods and getters captured when the module
  loads. Patching those prototypes can no longer change the derived key, keep
  the PRK and keygen entropy from being zeroed, or run code during the hash.
  Derived keys are unchanged.
- New `deriveP2mrDescriptorKey(leafPrivateKey, rangeIndex)`, exported and on
  the client from `init()`, returns the P2MR key qbit Core's descriptor wallet
  derives (`P2MRPubkeyProvider::GetPubKey`): `derivePQCKey(leafPrivateKey, 0,
  0, rangeIndex)` for a 32-byte BIP32 leaf private key and a non-hardened range
  index (`0` to `0x7fffffff`). A leaf of any other length (a 31-byte unpadded
  key, a 33-byte xprv-style key, a 64-byte BIP39 seed), a leaf that is zero or
  not below secp256k1's group order (for example a wiped buffer), or a hardened
  index throws instead of deriving a key Core never generates. `derivePQCKey`
  remains the low-level primitive, and its parameters are renamed
  `hkdfAccount`, `hkdfChange` and `hkdfIndex`: they are HKDF fields, not BIP32
  path fields. Its behavior is unchanged.

### Native library

- The vendored `libbitcoinpqc` is pinned to `Qbit-Org/qbit-libbitcoinpqc` at
  `70008b93` (previously `d165da6a`). The new pin adds the `BAD_KEY` and
  `OUT_OF_MEMORY` reporting above and clears the signature buffer when the
  low-level `slh_dsa_sign` rejects its arguments. Keys, signatures and
  verification results are unchanged; the golden vectors and qbit Core's
  signatures still match byte for byte.

### Packaging and docs

- The package is published as `@qbit-oss/pqc`, with the `wasm/pqc.mjs` and
  `wasm/pqc.wasm` subpaths. `repository`, `bugs` and `homepage` point at the
  Qbit-Org repository, and `publishConfig` requires npm provenance.
- **Breaking:** `engines.node` is `^20.19.0 || >=22.12.0`, the releases where
  `require()` loads ES modules by default. Package managers that enforce
  `engines`, such as Yarn 1 or npm with `engine-strict`, refuse to install the
  package on older Node versions.
- The package ships `THIRD_PARTY_NOTICES` for the code linked into `pqc.wasm`
  (libbitcoinpqc, SPHINCS+, Emscripten, musl and dlmalloc) and exports
  `./LICENSE` and `./THIRD_PARTY_NOTICES`. Redistribute both with the WASM
  artifacts.
- `require('@qbit-oss/pqc')` works: `.` gains a `default` condition that loads
  the ES module entry through `require(esm)`, so CommonJS and ES module callers
  share one instance, and `init()` through either sets up the top-level exports
  for both. There is no separate CommonJS build. `exports` also adds
  `./package.json`, `./wasm/SHA256SUMS` and type declarations for
  `./wasm/pqc.mjs` (`types/pqc.d.mts`), so the README's MV3 snippet
  type-checks under `tsc --strict` without a local declaration shim.
- The README's initialization section covers sharing, publication, the new
  errors, `isInitialized()` and `ready()`. A service-worker section says to call
  `init()` when the worker starts, that the client does not survive a restart,
  that signing blocks the thread for about 0.6 s, and how to sign in a Worker
  started by an offscreen document. `SECURITY.md` states that
  `wasm/SHA256SUMS` is release evidence, not a runtime check.
- `package.json` has a `browser` field that maps `module`, the Node builtin
  that only the loader's Node branch imports, to an empty module, so browser
  builds with webpack and esbuild no longer fail to resolve it and Vite no
  longer warns about it.
- The README's loading section describes the embedded default, when
  `pqc.wasm` is still loaded as a file (`moduleUrl`, `locateFile`), and why
  service workers need the static-factory recipe. `SECURITY.md` and
  `docs/mv3-conformance.md` state that the embedded copy is the pinned binary.
- The README documents the 2^30-signature usage bound of a bounded30 key, which
  this package does not enforce, when re-signing reveals nothing new, and how
  the bound differs from `SIGNING_LIMIT`.
- The README says to sign 32-byte digests and gives measured signing times by
  message length. `docs/derivation.md` explains that the cost comes from
  FORS+C grinding over `H_msg` and cannot change without a consensus change.
- `docs/derivation.md` states that this package does not compute qbit's P2MR
  signing preimage.
- `SECURITY.md` lists what the package zeroes (every WASM allocation, the
  derivation's JavaScript buffers, native intermediates and released stack)
  and what it cannot: returned keys and signatures, and the caller's inputs.
- `SECURITY.md` states that the package has not had an independent security
  audit, and that no review of side channels or constant-time behaviour has
  been done for its WASM build.
- `docs/derivation.md` states that qbit Core derives a non-ranged `pqc(...)`
  descriptor's key with HKDF index `0` whatever the leaf's path, and that the
  path's change field never enters the HKDF tuple.
- A publish workflow publishes each `vX.Y.Z-rc.N` or `vX.Y.Z` tag on
  `release/X.Y` whose version has a CHANGELOG section, under the dist-tag
  `candidate` or `latest`, with npm provenance, after the same checks as CI.
  Its `build` job packs the tarball running only code the lockfile pins, its
  `smoke` job runs the checks that fetch data or run code outside the
  lockfile, and only its `publish` job, which a maintainer approves, can
  publish: it runs no repository or dependency code, publishes `build`'s
  tarball only if it matches the SHA-256 sum `build` recorded, and on a
  re-run skips a version npm already holds with the same bytes and fails on
  different ones. `scripts/check-publish.mjs`, which `build` runs and
  `npm publish` runs as `prepublishOnly`, refuses package files that differ
  from the commit, WASM that fails `check:wasm` or, outside CI,
  `check:wasm:repro`, and a version that is `0.0.0` or not of those two
  forms. `pnpm pack:check` requires every packed file except tsup's three
  `lib/` outputs to be tracked by git, and warns about uncommitted changes.

### Development

- CI checks that every vendored C file is blob-equal to the pinned upstream
  commit, against both `MANIFEST` and a fetch of that commit.
- Tests pin qbit Core's own SLH-DSA signatures and the key derivations of a
  qbit Core release binary, and check fixtures against their SHA-256 sidecars.
- After every operation, on its success and error paths, tests search all of
  WASM linear memory for fragments of the secret key, the keygen entropy,
  `derivePQCKey`'s master seed and derived entropy, and the seed signing
  derives from the key. They also paint the stack and check that no native
  call taking a secret writes below the 4 KiB of stack the library zeroes
  before returning.
- Tests compare the SHA-256, HMAC-SHA-256 and HKDF that `derivePQCKey`
  implements in TypeScript with `node:crypto`, for inputs of 0 to 200 bytes
  and one over 64 KiB and for HMAC keys longer than a block, and check
  `derivePQCKey` itself at every seed length that lands on a SHA-256 padding
  boundary.
- Tests patch each `%TypedArray%` and `DataView` prototype member the
  derivation hash used, or install a `length` getter that would detach
  `masterSeed` mid-call, and check `derivePQCKey` against qbit Core's vectors
  and that it zeroes every buffer it allocates. Others make zeroing fail
  during cleanup and check that each call frees everything and throws its own
  error.
- Tests cover `init()` ordering, sharing, failed loads, `NOT_INITIALIZED`,
  `isInitialized()`, `ready()` and `PqcLoadError`, including a compile
  failure of the embedded copy and the status request outside Node with a
  stubbed `fetch` and fake timers. Tests that need
  a module of their own get one from `test/fresh-client.ts`.
- Tests check that the client, `constants` and `errorCodes` are frozen, that
  writes to them throw in strict mode and change nothing the wrapper does, and
  that the client has no `module`. Tests that call or patch the WASM module
  directly build it and pass it to `init({ createModule })`:
  `test/fresh-client.ts` returns that module with the client, and
  `pnpm smoke:load` builds its own.
- `pnpm smoke:bundlers` packs the package, installs the tarball with exact
  versions of webpack, esbuild, Vite 7 and Vite 8 into throwaway projects,
  with npm's `--before` holding their dependencies to releases published by a
  fixed date, and builds pages with each bundler's stock settings. The pinned
  Chrome for Testing runs every page, which must match the golden vectors
  through the default `init()` and through `init({ createModule })` without
  requesting `pqc.wasm`. It runs as its own CI job, `bundler-smoke`, because
  it downloads the bundlers.
- The MV3 smoke runs as its own CI job against a pinned Chrome for Testing
  (`156.0.8078.47`). Unless `--chrome` or `CHROME_FOR_TESTING_PATH` names a
  binary, `pnpm test:mv3` uses only that build for the current platform in the
  repository's `.context/browsers`: it no longer falls back to a system install
  or searches parent directories. `CHROME_NO_SANDBOX=1` runs Chrome without its
  sandbox on hosts that block unprivileged user namespaces.
- `pnpm check:wasm:repro` refuses to run with `USE_LOCAL_EMCC=1`,
  `EMSDK_IMAGE` or `OUT_DIR` set unless `QBIT_PQC_REPRO_ALLOW_OVERRIDES=1` is
  also set, and its pass message then lists them. The WASM build prints the
  `emcc` version and the Docker image digest, rejects an `OUT_DIR` outside the
  repository for the Docker build, and deletes the old `pqc.mjs` and
  `pqc.wasm` before compiling. Its `-fstack-protector-strong` flag is now
  documented as not a security control in WASM; it stays because removing it
  changes `pqc.wasm`.
- `pnpm smoke:consumer` handles SIGINT and SIGTERM: it stops the consumer
  process, reports where it kept the stage directory, and exits with 130 or
  143.
- pnpm 10.34.6, which CI reads from `packageManager`, with vitest 3 and tsup 8.
- Release process: `RELEASING.md`, this changelog, and CI on `release/**`
  branches.
- `pnpm typecheck` also checks the README's MV3 snippet against the package's
  own `exports` map under `node16` and `bundler` resolution, building `lib/`
  first for it. `pnpm smoke:consumer` checks `require()`,
  `./package.json`, and that `./wasm/SHA256SUMS` matches the installed
  artifacts.
