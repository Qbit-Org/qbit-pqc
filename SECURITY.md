# Security

## Reporting a vulnerability

Do not report security vulnerabilities in public issues, pull requests or
discussions.

Report them privately through GitHub private vulnerability reporting: open
this repository's security tab on GitHub and choose **Report a
vulnerability**. Only you and the maintainers can see the report, and the
maintainers follow up there.

Include:

- the package version, or the commit you tested;
- steps or code that reproduce the issue;
- the impact: what an attacker can do, and under which conditions.

## Scope

`@qbit-oss/pqc` is in scope: the TypeScript wrapper, the WASM build in `wasm/`,
and the vendored C sources in `vendor/libbitcoinpqc-qbit` as this package
builds them. `Qbit-Org/qbit-libbitcoinpqc` has no security policy of its own,
so report issues in the vendored C code here. Report issues in qbit Core as its
[security policy](https://github.com/Qbit-Org/qbit/blob/main/SECURITY.md)
describes.

## Supported versions

The latest published release line is supported: currently 0.1.x, first
published to npm as 0.1.0 on 2026-10-26. A fix ships as a patch release on that
line, or as the next minor release when it changes behaviour that
[RELEASING.md](RELEASING.md) counts as a breaking change below 1.0.

## Audit status

This package has not had an independent security audit. No review of side
channels or constant-time behaviour has been done for its WASM build,
including the vendored C code as this package compiles it.

## Security boundaries

This package ships local WebAssembly for qbit PQC primitives. The WASM module is
not a security boundary against compromised JavaScript in the same execution
context. Applications remain responsible for protecting seed phrases, private
keys, messages, and signatures in their own storage and UI layers.

The wrapper zeroes every WASM allocation a call makes, the copies of its inputs
and the native outputs, before freeing it, whether the call succeeds or fails.
Only a module from a custom `createModule` factory whose `HEAPU8` view went
stale when memory grew can make zeroing fail; the call then still frees every
allocation and throws, but cannot zero them.
`derivePQCKey` and `deriveP2mrDescriptorKey` also zero the JavaScript buffers
of the derivation: the seed copy, every intermediate hash buffer and the keygen
entropy. Native
code zeroes its own secret intermediates, and after key generation, signing and
secret-key validation it overwrites 4 KiB of the stack the call released. The
package cannot wipe what belongs to the caller: the keys and signatures it
returns, and inputs such as a master seed or secret key, stay in memory until
the application overwrites them. The WASM heap grows as needed and never
shrinks, so freed memory is zeroed but stays part of the module.

Signing in a worker with `@qbit-oss/pqc/worker` moves bytes between threads.
The client copies each byte argument into a fresh buffer and transfers it, so
the caller's buffers are not detached; the worker zeroes its copies when the
call returns or throws, and transfers the keys and signatures it returns back,
zeroing them if it cannot send them. Besides the caller's own buffers and
results, the package cannot wipe: the parts of each message that are cloned
rather than transferred (the method name, HKDF fields, range index and
`allowLargeMessage` flag); whatever an application relays outside the
package, such as the JSON of `chrome.runtime` messages between an MV3 service
worker and its offscreen document; the memory of a worker that crashes or is
terminated during a call; the answers to calls a client stopped waiting for
with a second `close()` or `close({ force: true })`; and the results of a
custom client served with `servePqcWorker` that are views on part of a buffer
or on a `SharedArrayBuffer`, which are cloned. [Signing in a worker](docs/worker.md#arguments-and-buffers)
details each.

An SLH-DSA-SHA2-128s-bounded30 key is designed for at most 2^30 signatures.
This package does not count signatures. qbit Core refuses to sign past that
bound, and applications that sign with these keys must enforce it as well.

By default, `init()` compiles a copy of `wasm/pqc.wasm` that the build embeds
in `lib/index.mjs`: the same binary, pinned by `wasm/SHA256SUMS`, and the
package's tests check it against that hash. It fetches `pqc.wasm` only when
`moduleUrl` or `locateFile` says where the file is. The
`@qbit-oss/pqc/external-wasm` entry embeds no copy and always loads the file,
unless `wasmBinary` passes the bytes. Do not load `pqc.wasm` from
a CDN or mutable backend URL. Package and serve the checked-in `wasm/pqc.mjs`,
`wasm/pqc.wasm`, and `wasm/SHA256SUMS` artifacts with the consuming app or
extension, together with `LICENSE` and `THIRD_PARTY_NOTICES`
(`@qbit-oss/pqc/LICENSE`, `@qbit-oss/pqc/THIRD_PARTY_NOTICES`), which carry the
notices for the code in those artifacts.

`wasm/SHA256SUMS` is release evidence: the package's checks compare
`wasm/pqc.mjs`, `wasm/pqc.wasm` and the embedded copy with it before a
release. To check the copies you ship, compare them with `wasm/SHA256SUMS` when
you build. `init()` hashes the WASM it compiles only when asked to:
`init({ expectedWasmSha256: constants.WASM_SHA256 })` rejects bytes with any
other SHA-256 before compiling them, whether embedded, loaded from a file, or
passed as `wasmBinary`. That runtime check does not cover the loader
`pqc.mjs` or a `createModule` factory, which run unchecked, a factory that
ignores `wasmBinary`, or code that runs earlier in the same JavaScript
context. [Checking pqc.wasm](docs/loading.md#checking-pqcwasm) describes it.
