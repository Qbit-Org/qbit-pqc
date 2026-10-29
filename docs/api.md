# @qbit-oss/pqc API

This page details the calls the [README's API overview](../README.md#api)
shows: module format, input validation, the frozen client, `PqcError` kinds
and `verify` semantics.

The package is an ES module with no separate CommonJS build. On Node
`^20.19.0 || >=22.12.0`, its `engines` range, `require('@qbit-oss/pqc')` loads
that same module through `require(esm)`, so CommonJS and ES module callers
share one instance: `init()` through either one sets up the top-level exports
for both. The same holds for the two package entries, `@qbit-oss/pqc` and
`@qbit-oss/pqc/external-wasm` (see [Package entries](loading.md#package-entries)).

Named top-level `deriveP2mrDescriptorKey`, `derivePQCKey`, `keygen`, `sign`,
`signWithStats`, `verify`, and `secretKeyValidate` exports are also available
once an `init()` call has succeeded (see [Initialization](loading.md#initialization)).
All byte inputs must be `Uint8Array`s, and every
function except `verify` (see below) throws a `RangeError` for an input of the
wrong length, including a `msg` over the [message size](signing.md#message-size) limit.
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
`%TypedArray%.prototype` after that cannot change how many bytes the wrapper
copies, or the key `derivePQCKey` derives.
The Emscripten glue builds `HEAPU8`, the view those copies go through, when
the module is instantiated and again whenever a call grows WASM memory, and it
computes how far to grow. `init()` passes the factory, as `qbitPqcIntrinsics`,
typed-array constructors and `Math` functions the package captured when it
loaded, and `WebAssembly.Memory.prototype`'s `buffer` getter and `grow` method
captured the same way. The glue builds the views with those constructors and
sizes the growth with those `Math` functions, and before the factory resolves
it switches the memory to that getter and method and rebuilds the views
through them. That holds for the default loader, which `init()` imports only
when it runs, and for `moduleUrl` and `createModule`. So once `init()` has
settled, the views are on the memory's own buffer, and the copies, secret keys
included, reach WASM memory, whatever code that ran after the package loaded
did to the typed-array constructors, `Math` or `WebAssembly.Memory.prototype`.
It does not cover everything the glue reads: to compute how far to grow, it
reads `%TypedArray%.prototype.length` and `ArrayBuffer.prototype.byteLength`
through the prototypes, so code that patches those accessors after the package
loads can change how far a call grows memory, or make it fail.
[Qbit-Org/qbit-pqc#10](https://github.com/Qbit-Org/qbit-pqc/issues/10) tracks
these reads. A `createModule` factory
that wraps the package's should pass on the options it receives, as
`createModule: createPqcModule` does; for anything missing from them, the glue
uses the copies it took when it was imported.
Validation never runs caller code, such as a `Proxy` trap in an argument's
prototype chain, except the traps of a `Proxy` passed as `options` (see
[Message size](signing.md#message-size)). The client `init()` resolves with is frozen,
so no code can replace a method the named exports call, and it does not
expose the WASM module, whose raw exports skip the wrapper's checks and the
zeroing of its copies in WASM memory. The exported `constants` and
`errorCodes` objects are frozen too, nested objects included. Assigning to
any of them throws a `TypeError` in strict mode, which every ES module uses,
and does nothing otherwise.
Native failures from `bitcoin_pqc_*` are exposed as `PqcError`
values with typed `kind`, `code`, and `nativeName` fields. Errors from
`signWithStats` also carry the native signing stats as `stats` when signing
had started: every `SIGNING_LIMIT` error does, and so does a `BAD_SIGNATURE`
from a failed signature or self-check. When signing fails before it starts,
as with `BAD_KEY`, `OUT_OF_MEMORY`, or a `BAD_SIGNATURE` from deriving the
signing randomness, `stats` is `undefined`, as it is on errors from every
other function.
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
[Message size](signing.md#message-size)). It rejects a wrong length before allocating
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
