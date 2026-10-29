// Intrinsics captured when the module loads. Code that runs after that can
// replace globals (Uint8Array, Math, ...) or patch %TypedArray%.prototype. So
// nothing that measures, sizes, builds, copies or zeroes the bytes a call hands
// to wasm looks up a global or an overridable method: it uses these references,
// those src/shared.ts captures when it loads, just before this module, and the
// module-private sizes and codes below. Argument validation reads internal
// slots only (see assertUint8Array in src/shared.ts), so it runs no caller code
// either. The options argument is read through the captured Object and Reflect
// functions, from own data properties only (see readAllowLargeMessage), so no
// getter runs; only a Proxy passed as options runs code, its traps, and that
// happens before any other argument is read. The key-derivation hash (JS memory
// only) works on a module-owned copy of the seed with the same captured
// constructors, getters and methods, plus the DataView methods, Math and
// Number, so a patched prototype can neither change the derived key nor keep
// it from zeroing its buffers. Error constructors are still looked up when
// thrown; whatever they resolve to, the call throws. The Emscripten glue builds
// HEAPU8, the view every copy goes through, and grows memory with what
// GLUE_INTRINSICS below holds, except for the reads of
// %TypedArray%.prototype.length and ArrayBuffer.prototype.byteLength when it
// computes how far to grow. This covers the calls on a client, not loading:
// init() and the Emscripten loader look up globals such as WebAssembly, fetch
// and atob while init() runs, so code that runs before it settles can change
// the module it loads.
import {
  assertAttached,
  assertUint8Array,
  causeReason,
  constants,
  errorCodes,
  isUint8Array,
  PqcError,
  PqcLoadError,
  readAllowLargeMessage,
  TYPED_ARRAY_INTRINSICS,
  withDerivedKeyAliases,
  type PqcErrorDetails,
  type PqcSignStats,
} from './shared'

export {
  constants,
  errorCodes,
  errors,
  nativeErrorKind,
  nativeErrorName,
  PqcError,
  PqcLoadError,
  type PqcErrorDetails,
  type PqcErrorKind,
  type PqcNativeErrorCode,
  type PqcNativeErrorName,
  type PqcSignStats,
} from './shared'

const {
  Uint8Array: IntrinsicUint8Array,
  typedArrayLength,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayByteLength,
  typedArraySet,
  typedArrayFill,
} = TYPED_ARRAY_INTRINSICS
const IntrinsicUint32Array = Uint32Array
const IntrinsicDataView = DataView
const { from: arrayFrom } = Array
const { ceil: mathCeil, floor: mathFloor, max: mathMax, min: mathMin } = Math
const { isFinite: numberIsFinite, isInteger: numberIsInteger } = Number
// Passed to the Emscripten factory as `qbitPqcIntrinsics`. Its glue uses the
// constructors and Math functions in place of the globals of the same names
// (native/glue-intrinsics.pre.js) to build its heap views, at instantiation and
// whenever a call grows memory, and to compute how far to grow, and the memory
// getter and method in place of WebAssembly.Memory.prototype's from just
// before the factory resolves, when it also rebuilds the views built during
// instantiation (native/glue-intrinsics.post.js). init() imports the
// package's glue only when it runs, so copies the glue took itself could
// already be replaced ones. Where there is no WebAssembly the memory entries
// are undefined, and init() cannot load the module there anyway.
const wasmMemoryPrototype: WebAssembly.Memory | undefined =
  typeof WebAssembly === 'object' ? WebAssembly.Memory?.prototype : undefined
const wasmMemoryBuffer = wasmMemoryPrototype && Object.getOwnPropertyDescriptor(wasmMemoryPrototype, 'buffer')?.get
const wasmMemoryGrow = wasmMemoryPrototype?.grow
const GLUE_INTRINSICS = Object.freeze({
  Int8Array,
  Uint8Array: IntrinsicUint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array: IntrinsicUint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  mathCeil,
  mathMax,
  mathMin,
  memoryBuffer: wasmMemoryBuffer && Function.prototype.call.bind(wasmMemoryBuffer),
  memoryGrow: wasmMemoryGrow && Function.prototype.call.bind(wasmMemoryGrow),
})

// Module-private copies of the frozen errorCodes and constants.
const {
  BITCOIN_PQC_OK: OK,
  BITCOIN_PQC_ERROR_BAD_KEY: ERROR_BAD_KEY,
  BITCOIN_PQC_ERROR_BAD_SIGNATURE: ERROR_BAD_SIGNATURE,
  BITCOIN_PQC_ERROR_SIGNING_LIMIT: ERROR_SIGNING_LIMIT,
} = errorCodes
const { PK_SIZE, SK_SIZE, SIG_SIZE, MIN_ENTROPY, MAX_MESSAGE_SIZE, WOTSC_LAYERS, SIGN_STATS_WORDS } = constants
const SIGN_STATS_BYTES = SIGN_STATS_WORDS * IntrinsicUint32Array.BYTES_PER_ELEMENT
// Where qbit_pqc_sign_with_stats writes its words: two for FORS+C, one attempt
// count per WOTS+C layer, then four WOTS+C totals.
const SIGN_STATS_WOTSC_ATTEMPTS = 2
const SIGN_STATS_WOTSC_TOTALS = SIGN_STATS_WOTSC_ATTEMPTS + WOTSC_LAYERS
const UINT32_MAX = 0xffffffff
const SHA256_BLOCK_BYTES = 64
const SHA256_BYTES = 32
const DERIVE_PQC_ENTROPY_BYTES = 128
const DERIVE_PQC_HKDF_BLOCKS = 4
const DERIVE_PQC_HKDF_SALT = asciiBytes('qbit-sphincs-v1')
const DERIVE_PQC_HKDF_INFO_PREFIX = asciiBytes('qbit/sphincs+/1')
const P2MR_LEAF_KEY_SIZE = 32
const P2MR_RANGE_INDEX_MAX = 0x7fffffff
// secp256k1's group order n, big-endian.
const SECP256K1_ORDER = new IntrinsicUint8Array([
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc,
  0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
])

const SHA256_INITIAL_STATE = new IntrinsicUint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const SHA256_K = new IntrinsicUint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])

const dataViewGetUint32 = uncurryDataViewMethod<[byteOffset: number, littleEndian: boolean], number>('getUint32')
const dataViewSetUint32 = uncurryDataViewMethod<[byteOffset: number, value: number, littleEndian: boolean], undefined>(
  'setUint32'
)

function uncurryDataViewMethod<A extends unknown[], R>(
  key: 'getUint32' | 'setUint32'
): (view: DataView, ...args: A) => R {
  const method = Object.getOwnPropertyDescriptor(IntrinsicDataView.prototype, key)?.value
  if (typeof method !== 'function') {
    throw new TypeError(`DataView.prototype.${key} is unavailable`)
  }
  return Function.prototype.call.bind(method) as (view: DataView, ...args: A) => R
}

/** A key pair, as {@link keygen} returns it. */
export interface PqcKeyPair {
  /** The public key, `constants.PK_SIZE` (32) bytes. */
  publicKey: Uint8Array
  /** The secret key, `constants.SK_SIZE` (64) bytes. */
  secretKey: Uint8Array
}

/**
 * A derived key pair: the pair `keygen` gives for 128 bytes of entropy derived
 * with HKDF-SHA256, as qbit Core derives them. {@link deriveP2mrDescriptorKey}
 * and {@link derivePQCKey} return it as a {@link PqcDerivedKeyPair}, which also
 * reads the keys under `keygen`'s names.
 */
export interface PqcDerivedKey {
  /** The public key, `constants.PK_SIZE` (32) bytes. */
  pk32: Uint8Array
  /** The secret key, `constants.SK_SIZE` (64) bytes. */
  sk64: Uint8Array
}

/**
 * What {@link deriveP2mrDescriptorKey} and {@link derivePQCKey} return: a
 * {@link PqcDerivedKey} that also reads its keys under the names
 * {@link PqcKeyPair} uses. `publicKey` and `secretKey` are non-enumerable
 * getters, with no setter, that return whatever the object's `pk32` and `sk64`
 * hold when read: the same arrays, not copies, so zeroing either name zeroes
 * both. After `pk32` or `sk64` is reassigned, its alias returns the new value,
 * and after it is deleted, undefined. `Object.keys`, `JSON.stringify` and deep
 * equality see only
 * `pk32` and `sk64`, as in 0.1.0, so the secret key is never serialized twice.
 * A spread, `Object.assign` or `structuredClone` (or `postMessage`) copy has
 * only `pk32` and `sk64`, although TypeScript types it with the aliases, so
 * read them from the original result, or copy `pk32` and `sk64`.
 */
export interface PqcDerivedKeyPair extends PqcDerivedKey {
  /** The object's current `pk32`, under {@link PqcKeyPair}'s name. */
  readonly publicKey: Uint8Array
  /**
   * The object's current `sk64`, under {@link PqcKeyPair}'s name: the same
   * Uint8Array, so zeroing either zeroes both.
   */
  readonly secretKey: Uint8Array
}

/** What {@link PqcClient.signWithStats} returns. */
export interface PqcSignWithStatsResult {
  /** The signature, `constants.SIG_SIZE` (3680) bytes. */
  sig: Uint8Array
  /** The native grind statistics of this signature. */
  stats: PqcSignStats
}

/**
 * Options for {@link PqcClient.sign}, {@link PqcClient.signWithStats} and
 * {@link PqcClient.verify}. Pass `undefined` or a plain object (an object
 * literal or `Object.create(null)`, from the same realm as the package) with no
 * property other than `allowLargeMessage`; anything else throws a TypeError.
 */
export interface PqcMessageOptions {
  /**
   * Accept a `msg` longer than `constants.MAX_MESSAGE_SIZE` (65536) bytes,
   * which `sign` and `signWithStats` otherwise reject with a RangeError and
   * `verify` reports as invalid. Signing time grows with the message length.
   */
  allowLargeMessage?: boolean
}

/**
 * The raw Emscripten module of `pqc.wasm`, which a {@link PqcWasmModuleFactory}
 * resolves with: the type exported for `createModule`. Its exports skip the
 * wrapper's checks and the zeroing of its copies in WASM memory, and the client
 * `init()` builds on it does not expose it. Pointers are byte offsets into
 * `HEAPU8`.
 */
export interface PqcWasmModule {
  /** The module's WASM memory, as bytes. Growing the memory, as `_malloc` may, detaches the previous buffer. */
  HEAPU8: Uint8Array
  /** Allocates `byteLength` bytes of WASM memory and returns a pointer to them. */
  _malloc(byteLength: number): number
  /** Frees memory that `_malloc` allocated. */
  _free(pointer: number): void
  /** The public key size in bytes; `init()` requires `constants.PK_SIZE` (32). */
  _qbit_pqc_public_key_size(): number
  /** The secret key size in bytes; `init()` requires `constants.SK_SIZE` (64). */
  _qbit_pqc_secret_key_size(): number
  /** The signature size in bytes; `init()` requires `constants.SIG_SIZE` (3680). */
  _qbit_pqc_signature_size(): number
  /** The fewest keygen entropy bytes; `init()` requires `constants.MIN_ENTROPY` (128). */
  _qbit_pqc_keygen_entropy_min_size(): number
  /**
   * Generates a key pair from the `entropyLength` bytes at `entropy` and writes
   * its public and secret keys at `publicKeyOut` and `secretKeyOut`. Returns an
   * {@link errorCodes} value.
   */
  _qbit_pqc_keygen(publicKeyOut: number, secretKeyOut: number, entropy: number, entropyLength: number): number
  /**
   * Checks the secret key at `secretKey` as {@link PqcClient.secretKeyValidate}
   * does. Returns an {@link errorCodes} value: `BITCOIN_PQC_OK` for a
   * consistent key, `BITCOIN_PQC_ERROR_BAD_KEY` for a wrong-size or
   * inconsistent one.
   */
  _qbit_pqc_secret_key_validate(secretKey: number, secretKeyLength: number): number
  /**
   * Signs the `messageLength` bytes at `message` with the secret key at
   * `secretKey` and writes the signature at `signatureOut`. Returns an
   * {@link errorCodes} value.
   */
  _qbit_pqc_sign(signatureOut: number, secretKey: number, message: number, messageLength: number): number
  /**
   * `_qbit_pqc_sign`, also writing `constants.SIGN_STATS_WORDS` uint32 words of
   * signing stats at `statsOut`, when signing fails too. A NULL pointer
   * argument, or a NULL `message` with a nonzero `messageLength`, returns
   * `BITCOIN_PQC_ERROR_BAD_ARG` with the words zeroed, or unwritten when
   * `statsOut` itself is NULL.
   */
  _qbit_pqc_sign_with_stats(
    signatureOut: number,
    statsOut: number,
    secretKey: number,
    message: number,
    messageLength: number
  ): number
  /**
   * Verifies the `signatureLength` bytes at `signature` as a signature of the
   * `messageLength` bytes at `message` under the public key at `publicKey`.
   * Returns an {@link errorCodes} value: `BITCOIN_PQC_OK` when it is valid,
   * `BITCOIN_PQC_ERROR_BAD_SIGNATURE` for a signature that does not verify.
   */
  _qbit_pqc_verify(
    publicKey: number,
    message: number,
    messageLength: number,
    signature: number,
    signatureLength: number
  ): number
}

/**
 * The options a {@link PqcWasmModuleFactory} takes. {@link InitOptions} extends
 * them, apart from `qbitPqcIntrinsics`: `init()` passes the factory a
 * `locateFile` of its own, which calls yours, the bytes to compile, if it has
 * them, and its own `qbitPqcIntrinsics`.
 */
export interface PqcWasmModuleOptions {
  /**
   * Where to load a file from: called with `'pqc.wasm'` and the loader's
   * directory (a URL, or a file path in Node), it returns the URL or path to
   * load. As an {@link init} option it makes `init()` load `pqc.wasm` from there,
   * unless `wasmBinary` is set: through `@qbit-oss/pqc`, instead of compiling
   * the copy embedded in that entry. Returning `undefined` or `null` keeps the
   * default: beside the `moduleUrl` loader when `moduleUrl` is in effect and
   * its URL has a directory, and the package's own `pqc.wasm` file otherwise,
   * as for a `blob:` or `data:` `moduleUrl`, or when `createModule` is set and
   * `moduleUrl` is ignored.
   */
  locateFile?: (path: string, prefix: string) => string | undefined | null
  /**
   * The bytes of `pqc.wasm` to compile, so that no file is loaded. As an
   * {@link init} option they replace the copy embedded in `@qbit-oss/pqc` and
   * any location for `pqc.wasm` that `moduleUrl` or `locateFile` gives;
   * `null` passes no bytes, as `undefined` does.
   */
  wasmBinary?: ArrayBuffer | Uint8Array
  /**
   * Set by `init()`, not by callers: copies of the typed-array constructors and
   * `Math` functions, and of `WebAssembly.Memory.prototype`'s `buffer` getter
   * and `grow` method, that the package captured when it loaded. The
   * package's factory builds its heap views with the constructors, sizes memory
   * growth with the `Math` functions and, before it resolves, switches the
   * memory to the getter and method and rebuilds the views through them. So
   * once `init()` has settled, the views are on the memory's own buffer,
   * whatever code that ran after the package loaded did to those globals or
   * that prototype. Computing how far to grow still reads
   * `%TypedArray%.prototype.length` and `ArrayBuffer.prototype.byteLength`
   * through the prototypes (Qbit-Org/qbit-pqc#10). Its contents are internal.
   * A factory that wraps the package's should pass it on unchanged, for
   * example by passing on the whole options object. Without it, and for any
   * entry that is not a function, the package's factory uses the copy it took
   * when `wasm/pqc.mjs` was imported.
   */
  qbitPqcIntrinsics?: object
}

/**
 * An Emscripten factory that resolves with the WASM module, such as the default
 * export of `@qbit-oss/pqc/wasm/pqc.mjs`. Pass one to {@link init} as
 * `createModule`.
 */
export type PqcWasmModuleFactory = (options?: PqcWasmModuleOptions) => Promise<PqcWasmModule>

/**
 * Options for {@link init}. Without any, `init()` imports the package's loader
 * and, through `@qbit-oss/pqc`, compiles the copy of `pqc.wasm` embedded in
 * that entry (`lib/index.mjs`), fetching no file; through
 * `@qbit-oss/pqc/external-wasm`, which embeds no copy, it loads the package's
 * `wasm/pqc.wasm` file. A call shares the load of the most recent call when
 * its options match that call's (see {@link init} for when they match), even
 * while that load is still pending; once a load has failed, the next call
 * starts a new one.
 */
export interface InitOptions extends Omit<PqcWasmModuleOptions, 'qbitPqcIntrinsics'> {
  /**
   * The URL of an Emscripten loader to import instead of the package's
   * `wasm/pqc.mjs`, such as a copy served with your app from the same package
   * version. `pqc.wasm` is then loaded from the loader's directory, or from the
   * package when the URL has none (a `blob:` or `data:` URL), unless
   * `locateFile` or `wasmBinary` says otherwise. The loader is imported with
   * `import()`, which service workers do not allow. Ignored when `createModule`
   * is set.
   */
  moduleUrl?: string | URL
  /**
   * The Emscripten factory to call instead of importing a loader, such as the
   * default export of `@qbit-oss/pqc/wasm/pqc.mjs` imported statically in a
   * service worker, where `import()` is not allowed. `moduleUrl` is ignored.
   * Without `locateFile` or `wasmBinary`, the `init()` of `@qbit-oss/pqc`
   * passes it the copy of `pqc.wasm` embedded in that entry, so nothing is
   * fetched; the `init()` of `@qbit-oss/pqc/external-wasm`, which embeds no
   * copy, has it load the package's `wasm/pqc.wasm` file.
   */
  createModule?: PqcWasmModuleFactory
  /**
   * The SHA-256 that the `pqc.wasm` bytes must have, as 64 lowercase hex
   * characters; usually `constants.WASM_SHA256`. `init()` then hashes the bytes
   * it is about to compile, whether `wasmBinary`, the embedded copy, or the
   * file that `moduleUrl` or `locateFile` names, which it reads itself and
   * passes to the factory as `wasmBinary`, calling the factory once. Bytes
   * with another digest reject with a {@link PqcLoadError} before anything is
   * compiled. Any value other than undefined or such a string rejects with a
   * TypeError before anything loads.
   *
   * `init()` works out the file's location without the factory: it calls
   * `locateFile` with the directory of the `moduleUrl` loader as `prefix` or,
   * when `moduleUrl` is not in effect (as with `createModule`), the package's
   * own `wasm/` directory, not that of the caller's copy of the loader. A
   * relative `moduleUrl` is resolved against the package's own module URL,
   * which a bundler such as webpack may rewrite to a path on the build
   * machine, so pass an absolute URL. A bare specifier goes through
   * `import.meta.resolve`, and rejects where there is none. A wrong location,
   * or a `moduleUrl` that cannot be resolved, fails closed: `init()` rejects
   * and compiles nothing. In Node, a `locateFile` that returns a URL other
   * than a `file://` URL rejects. For the most predictable result, have
   * `locateFile` return an absolute URL, or pass `wasmBinary`.
   *
   * The loader (`pqc.mjs`, or a `createModule` factory) is not checked, and a
   * factory that ignores `wasmBinary` can compile other bytes.
   */
  expectedWasmSha256?: string
}

/**
 * The client `init()` resolves with. It is frozen: assigning to a method
 * throws in strict mode and is ignored otherwise. It does not expose the WASM
 * module, whose raw exports skip the wrapper's checks and zeroing.
 */
export interface PqcClient {
  /** The frozen {@link constants} object itself. */
  constants: typeof constants
  /**
   * Generates a key pair from `entropy`, which must be at least
   * `constants.MIN_ENTROPY` (128) bytes: fewer throws a RangeError. Longer
   * input is accepted, and all of it is hashed into the key seed. The same
   * entropy always gives the same key pair, so draw it from a cryptographically
   * secure generator such as `crypto.getRandomValues` and keep it as secret as
   * the key. A native failure throws a {@link PqcError}, such as
   * `OUT_OF_MEMORY` when an allocation inside the native library fails, as for
   * the seed-derivation buffer, which grows with the entropy. When the wrapper
   * itself cannot allocate WASM memory, for the entropy or the keys, it throws
   * a plain Error.
   */
  keygen(entropy: Uint8Array): PqcKeyPair
  /**
   * Low-level primitive: qbit Core's `DerivePQCKey`, HKDF-SHA256 over
   * `masterSeed` into seeded bounded30 keygen. `hkdfAccount`, `hkdfChange` and
   * `hkdfIndex` are the uint32 fields of the HKDF info string, not BIP32 path
   * fields. Core's descriptor wallet only derives `(0, 0, rangeIndex)` from a
   * 32-byte BIP32 leaf private key; any other seed or tuple gives a key that
   * importing the wallet's descriptor into Core never finds. Derive wallet keys
   * with {@link PqcClient.deriveP2mrDescriptorKey}.
   */
  derivePQCKey(masterSeed: Uint8Array, hkdfAccount: number, hkdfChange: number, hkdfIndex: number): PqcDerivedKeyPair
  /**
   * The P2MR key qbit Core's descriptor wallet derives for a `pqc(...)` key
   * (`P2MRPubkeyProvider::GetPubKey`): `derivePQCKey(leafPrivateKey, 0, 0,
   * rangeIndex)`, accepting only inputs Core can produce.
   *
   * @param leafPrivateKey The 32-byte private key the `pqc(...)` key expression
   *   resolves to, leading zero bytes included: for the wallet descriptors
   *   `mr(pk(pqc(<xprv>/87h/{coin_type}h/0h/{0|1}/*)))`, the BIP32 leaf at
   *   `m/87h/{coin_type}h/0h/{0|1}/{i}`. Not the 33-byte `00 || key` form
   *   inside an xprv, and not a BIP39 seed. A key that is zero or not below
   *   secp256k1's group order, which no BIP32 derivation produces, throws a
   *   RangeError.
   * @param rangeIndex The descriptor range position `i`, from 0 to 0x7fffffff;
   *   hardened indices are rejected. The `{0|1}` branch is part of the leaf's
   *   path and never enters the HKDF input. For a non-ranged `pqc(...)`
   *   descriptor pass 0, whatever the leaf's path: Core derives those keys with
   *   HKDF index 0.
   */
  deriveP2mrDescriptorKey(leafPrivateKey: Uint8Array, rangeIndex: number): PqcDerivedKeyPair
  /**
   * Signs `msg` with `sk`. Sign a 32-byte digest, as qbit Core does with its
   * sighashes: every FORS+C grind attempt hashes the whole message, so the
   * cost is O(attempts * msg length), seconds at 64 KiB and minutes at 1 MiB.
   * A `msg` longer than `constants.MAX_MESSAGE_SIZE` (65536) bytes throws a
   * RangeError before any WASM memory is allocated, unless
   * `options.allowLargeMessage` is true. `options` must be undefined or a
   * plain object whose only property, if any, is a boolean
   * `allowLargeMessage`; anything else throws a TypeError.
   */
  sign(sk: Uint8Array, msg: Uint8Array, options?: PqcMessageOptions): Uint8Array
  /**
   * {@link PqcClient.sign}, also returning the native signing stats. A
   * `PqcError` it throws carries them as `stats` when signing had started:
   * always for `SIGNING_LIMIT`, and for a `BAD_SIGNATURE` from a failed
   * signature or self-check. A failure before signing starts, such as
   * `BAD_KEY` or `OUT_OF_MEMORY`, leaves `stats` undefined.
   */
  signWithStats(sk: Uint8Array, msg: Uint8Array, options?: PqcMessageOptions): PqcSignWithStatsResult
  /**
   * Returns true when `sig` is a valid signature of `msg` under `pk`, and
   * false for any other bytes, including a `pk` that is not
   * `constants.PK_SIZE` (32) bytes, a `sig` that is not `constants.SIG_SIZE`
   * (3680) bytes, or a `msg` longer than `constants.MAX_MESSAGE_SIZE` (65536)
   * bytes unless `options.allowLargeMessage` is true; those are rejected
   * before any WASM memory is allocated. A shorter `msg`, including an empty
   * one, is accepted. Throws only:
   * - a TypeError when an argument is not a Uint8Array, or is (or becomes
   *   during the call) a view on a detached or out-of-bounds ArrayBuffer, or
   *   when `options` is not what {@link PqcClient.sign} accepts. This is
   *   checked before the lengths, so it applies whatever they are;
   * - a PqcError when the native library fails with anything other than
   *   BAD_SIGNATURE;
   * - an Error when WASM memory for the inputs cannot be allocated, for
   *   example for a `msg` passed with `allowLargeMessage` that is too large
   *   for the WASM heap.
   */
  verify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array, options?: PqcMessageOptions): boolean
  /**
   * Whether `sk` is internally consistent: true when its stored root matches
   * the root recomputed from its seeds, and false when it does not, the same
   * verdict for which `sign` and `signWithStats` throw a {@link PqcError} with
   * kind `'BAD_KEY'`. It does not check the PRF key `SK.prf` (bytes 16–31), so
   * a key corrupted there still validates and signs the same message
   * differently. An `sk` that is not `constants.SK_SIZE` (64) bytes throws a
   * RangeError, and a native failure other than BAD_KEY a PqcError.
   */
  secretKeyValidate(sk: Uint8Array): boolean
  /**
   * The current size in bytes of the WASM module's memory. Copying a long
   * `msg` into it can grow it, and it never shrinks.
   */
  wasmHeapBytes(): number
}

// The client the named exports use. Each init() call takes the next number in
// initCalls, and publishes its client only if no later call has published one
// already: the newest call that succeeds wins, even when an earlier call
// settles after it, and a call that fails leaves the published client alone.
let activeClient: PqcClient | undefined
let initCalls = 0
let publishedCall = 0
// The load of the latest init() call, which later calls with the same options
// share. A call with other options replaces it, so it never keeps a module
// that no one uses alive.
let latestLoad: { key: readonly unknown[]; client: Promise<PqcClient> } | undefined
// What ready() returns until the first client is published.
let firstClient: { promise: Promise<PqcClient>; resolve: (client: PqcClient) => void } | undefined

// A file beside the package's pqc.wasm. The URL of pqc.wasm is a literal so
// that bundlers which handle `new URL('...', import.meta.url)` emit the file
// and point the URL at their copy.
function packageFileUrl(path: string): string {
  const packageWasm = new URL('../wasm/pqc.wasm', import.meta.url)
  return path === 'pqc.wasm' ? packageWasm.href : new URL(path, packageWasm).href
}

// Emscripten passes the directory of the module that defines the factory as
// `prefix`: a URL, or a file path in Node. It passes '' when that module's URL
// has no directory, as for a blob: or data: URL; the package's copy is used
// then.
function locateBesideModule(path: string, prefix: string): string {
  return prefix ? prefix + path : packageFileUrl(path)
}

// Emscripten's own default. The factory asks where pqc.wasm is even when it
// has the bytes, but then never loads it. Unlike packageFileUrl, this needs no
// import.meta.url, which an IIFE or CommonJS bundle leaves empty.
function locateUnloaded(path: string, prefix: string): string {
  return prefix + path
}

// The package's Emscripten factory. The specifier is a literal, so bundlers
// include the file, and init() imports it only when it uses it.
async function loadPackageFactory(): Promise<PqcWasmModuleFactory> {
  return (await import('../wasm/pqc.mjs')).default
}

// A fresh copy of the pqc.wasm that the "." entry embeds (src/index.ts).
// This module, built as lib/core.mjs, embeds none, and neither does the
// "./external-wasm" entry, which re-exports its public API.
type EmbeddedWasm = () => Promise<Uint8Array>

// Emscripten's own test. In Node, the loader reads pqc.wasm from a file.
function isNode(): boolean {
  return (
    typeof process === 'object' &&
    typeof process.versions?.node === 'string' &&
    (process as { type?: unknown }).type !== 'renderer'
  )
}

const STATUS_REQUEST_TIMEOUT_MS = 10000

// Emscripten's loader turns a failed fetch into an abort that names neither the
// URL nor the HTTP status. Outside Node, loadError asks an http(s) or
// chrome-extension: URL once more, only to read the status of an error
// response: one GET, abandoned after STATUS_REQUEST_TIMEOUT_MS. The status is
// undefined when that request fails, times out or succeeds. A relative URL is
// resolved against `base`, as the failed request resolved it, and is not
// requested without one.
async function errorResponseStatus(url: string, base?: string): Promise<number | undefined> {
  let target: URL
  try {
    target = new URL(url, base)
  } catch {
    return undefined
  }
  if (!['http:', 'https:', 'chrome-extension:'].includes(target.protocol)) {
    return undefined
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STATUS_REQUEST_TIMEOUT_MS)
  try {
    return errorStatus(await fetch(target, { credentials: 'same-origin', signal: controller.signal }))
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

// The status of an error response, or undefined for a 2xx one. Only the
// status is wanted, so the body is cancelled rather than downloaded.
function errorStatus(response: Response): number | undefined {
  response.body?.cancel().catch(() => undefined)
  return response.ok ? undefined : response.status
}

async function loadError(url: string, cause: unknown, base?: string): Promise<PqcLoadError> {
  const status = isNode() ? undefined : await errorResponseStatus(url, base)
  return new PqcLoadError(url, status, { cause })
}

async function loadFactory(moduleUrl: string | URL): Promise<PqcWasmModuleFactory> {
  const url = moduleUrl.toString()
  let loaded: { default?: PqcWasmModuleFactory }
  try {
    loaded = await import(/* webpackIgnore: true */ url)
  } catch (error) {
    // import() resolves a relative specifier against this module, or against
    // whatever chunk a bundler put it in, which the status request cannot know.
    throw await loadError(url, error)
  }
  if (typeof loaded.default !== 'function') {
    // The module loaded, so there is no error status to ask for.
    throw new PqcLoadError(url, undefined, {
      cause: new TypeError('pqc wasm module did not export an Emscripten factory'),
    })
  }
  return loaded.default
}

/**
 * Loads the WASM module and publishes a client for the named exports
 * (`keygen`, `sign`, `verify`, ...).
 *
 * A call whose options match those of the most recent call shares its load:
 * the calls return distinct promises that resolve to the same client, and a
 * call with other options starts a new load. Options are the same when
 * `moduleUrl` has the same string form, `createModule`, `locateFile` and
 * `wasmBinary` are the same objects, and `expectedWasmSha256` is the same
 * string; `init()`, `init(undefined)` and `init({})` are the same. The named
 * exports use the client of the newest call that succeeded: an earlier call
 * that settles later does not replace it, and a call that fails leaves the
 * published client in place.
 *
 * This is the `init()` of `@qbit-oss/pqc/external-wasm`, which embeds no copy
 * of `pqc.wasm`: unless `wasmBinary` passes the bytes, the loader fetches or
 * reads the file from `locateFile`, beside `moduleUrl`, or the package's own
 * `wasm/pqc.wasm`. The `init()` of `@qbit-oss/pqc` compiles its embedded copy
 * instead when no option says where the file is. Both entries publish to the
 * same client.
 *
 * Rejects with a {@link PqcLoadError} when the WASM module cannot be loaded:
 * the loader cannot be imported or exports no factory, it cannot fetch,
 * compile or instantiate `pqc.wasm`, the bytes do not have the
 * `expectedWasmSha256` digest, or the module does not match this version of
 * the package. Rejects with a TypeError when `expectedWasmSha256` is not
 * undefined or 64 lowercase hex characters.
 */
export function init(options: InitOptions = {}): Promise<PqcClient> {
  return initWithEmbeddedWasm(options, undefined)
}

/**
 * The `init()` of the `@qbit-oss/pqc` entry (src/index.ts), which passes the
 * copy of pqc.wasm it embeds as `embeddedWasm`. It is {@link init}, except
 * that a call that neither passes `wasmBinary` nor says where pqc.wasm is
 * (`locateFile`, or `moduleUrl` without `createModule`) compiles a fresh copy
 * of those bytes. Not part of the API, and left out of the declarations: call
 * `init()`.
 *
 * @internal
 */
export async function initWithEmbeddedWasm(
  options: InitOptions = {},
  embeddedWasm: EmbeddedWasm | undefined
): Promise<PqcClient> {
  const request = readInitOptions(options, embeddedWasm)
  initCalls += 1
  const call = initCalls
  const client = await sharedLoad(request)
  if (call > publishedCall) {
    publishedCall = call
    activeClient = client
    firstClient?.resolve(client)
    firstClient = undefined
  }
  return client
}

// What one init() call asks for, read from its options once, so the key its
// load is shared under, the choice of bytes and the load itself all see the
// same values, whatever a getter on the options returns next.
interface LoadRequest {
  readonly moduleUrl: string | URL | undefined
  readonly createModule: PqcWasmModuleFactory | undefined
  readonly locateFile: InitOptions['locateFile']
  readonly wasmBinary: ArrayBuffer | Uint8Array | undefined
  readonly expectedWasmSha256: string | undefined
  // The embedded copy, when the call compiles it.
  readonly embedded: EmbeddedWasm | undefined
}

function readInitOptions(options: InitOptions, embeddedWasm: EmbeddedWasm | undefined): LoadRequest {
  const { moduleUrl, createModule, locateFile, wasmBinary, expectedWasmSha256 } = options
  // A null wasmBinary passes no bytes, as in 0.1.0.
  const bytes = wasmBinary ?? undefined
  // Unless the caller passes the bytes or says where pqc.wasm is (moduleUrl,
  // which createModule overrides, or locateFile), the "." entry compiles the
  // copy it embeds, and the "./external-wasm" entry loads the package's file.
  const usesEmbedded =
    bytes === undefined && locateFile === undefined && (createModule !== undefined || moduleUrl === undefined)
  return {
    moduleUrl,
    createModule,
    locateFile,
    wasmBinary: bytes,
    expectedWasmSha256: readExpectedWasmSha256(expectedWasmSha256),
    embedded: usesEmbedded ? embeddedWasm : undefined,
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function readExpectedWasmSha256(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new TypeError('options.expectedWasmSha256 must be a SHA-256 digest in 64 lowercase hex characters')
  }
  return value
}

function sharedLoad(request: LoadRequest): Promise<PqcClient> {
  const key = initKey(request)
  const latest = latestLoad
  if (latest !== undefined && key.every((value, i) => value === latest.key[i])) {
    return latest.client
  }
  const load = { key, client: loadClient(request) }
  latestLoad = load
  // A failed load is not shared. By the time it fails, a later call may have
  // replaced it, and that call's load stays.
  load.client.catch(() => {
    if (latestLoad === load) {
      latestLoad = undefined
    }
  })
  return load.client
}

// The embedded copy is part of the key only when the call compiles it, so the
// two entries share a load whenever they load the same way.
function initKey({
  moduleUrl,
  createModule,
  locateFile,
  wasmBinary,
  expectedWasmSha256,
  embedded,
}: LoadRequest): unknown[] {
  return [
    moduleUrl === undefined ? undefined : String(moduleUrl),
    createModule,
    locateFile,
    wasmBinary,
    expectedWasmSha256,
    embedded,
  ]
}

async function loadClient(request: LoadRequest): Promise<PqcClient> {
  try {
    return createPqcClient(await loadModule(request))
  } catch (error) {
    // Any step can fail: one of the package's own imports, such as a bundler's
    // chunk for the loader that a deploy replaced; the factory, as when a CSP
    // without 'wasm-unsafe-eval' stops the embedded copy compiling; or the
    // check that the module matches this package. Only the steps that know
    // which file failed throw a PqcLoadError themselves.
    throw error instanceof PqcLoadError ? error : new PqcLoadError(undefined, undefined, { cause: error })
  }
}

async function loadModule({
  moduleUrl,
  createModule,
  locateFile,
  wasmBinary,
  expectedWasmSha256,
  embedded,
}: LoadRequest): Promise<PqcWasmModule> {
  // createModule takes precedence over moduleUrl.
  const fromModuleUrl = createModule === undefined && moduleUrl !== undefined
  const moduleFactory =
    createModule ?? (moduleUrl === undefined ? await loadPackageFactory() : await loadFactory(moduleUrl))
  // With the embedded copy, nothing is fetched, and no bundler has to emit or
  // serve pqc.wasm. Without one, the factory loads the package's file.
  const bytes = wasmBinary ?? (embedded === undefined ? undefined : await embedded())
  // A custom locateFile that returns undefined or null defers to the default:
  // beside the loader when moduleUrl named one, so the loader and the binary
  // come from the same copy, and the package's own copy otherwise. With the
  // bytes in hand, the factory loads no file, whatever the location.
  const locateDefault = fromModuleUrl ? locateBesideModule : bytes === undefined ? packageFileUrl : locateUnloaded
  const locate = (path: string, prefix: string): string => locateFile?.(path, prefix) ?? locateDefault(path, prefix)
  if (expectedWasmSha256 !== undefined) {
    if (bytes !== undefined) {
      // The caller's wasmBinary is copied, so that writing to it later cannot
      // change what is compiled; the embedded copy is private already.
      const checked = bytes === wasmBinary ? copyWasmBinary(bytes) : (bytes as Uint8Array)
      return loadCheckedModule(moduleFactory, checked, expectedWasmSha256, undefined, locate)
    }
    // The file the factory would load, which init() reads itself, so the
    // factory needs no call to say where it is.
    const located = locate('pqc.wasm', loaderDirectory(fromModuleUrl ? moduleUrl : undefined))
    return loadCheckedModule(moduleFactory, await readWasm(located), expectedWasmSha256, located, (path, prefix) =>
      path === 'pqc.wasm' ? located : locate(path, prefix)
    )
  }
  // Where the factory loads pqc.wasm from, when it has no bytes.
  let wasmUrl: string | undefined
  const moduleOptions: PqcWasmModuleOptions = {
    qbitPqcIntrinsics: GLUE_INTRINSICS,
    locateFile: (path, prefix) => {
      const located = locate(path, prefix)
      if (path === 'pqc.wasm') {
        wasmUrl = located
      }
      return located
    },
  }

  if (bytes !== undefined) {
    moduleOptions.wasmBinary = bytes
  }

  try {
    return await moduleFactory(moduleOptions)
  } catch (error) {
    // Only without the bytes did the loader fetch pqc.wasm, resolving a
    // relative location against the page or worker.
    throw bytes === undefined && wasmUrl !== undefined
      ? await loadError(wasmUrl, error, globalThis.location?.href)
      : error
  }
}

// With expectedWasmSha256: the factory is called once, with the bytes as
// wasmBinary, after they have been hashed. `wasmUrl` is the file they were read
// from, if any, which a mismatch names. Once the bytes are in hand nothing
// more is read, so a compile failure has no file to name.
async function loadCheckedModule(
  moduleFactory: PqcWasmModuleFactory,
  checked: Uint8Array,
  expectedWasmSha256: string,
  wasmUrl: string | undefined,
  locateFile: (path: string, prefix: string) => string
): Promise<PqcWasmModule> {
  const actual = toHex(sha256(checked))
  if (actual !== expectedWasmSha256) {
    throw new PqcLoadError(wasmUrl, undefined, {
      cause: new Error(`SHA-256 ${actual} does not match expectedWasmSha256 ${expectedWasmSha256}`),
    })
  }
  return moduleFactory({ qbitPqcIntrinsics: GLUE_INTRINSICS, locateFile, wasmBinary: checked })
}

// The `prefix` Emscripten's factory passes to locateFile: the directory of the
// module that defines it, as a file path in Node and a URL elsewhere, or ''
// when that module's URL has none (blob:, data:, or the empty import.meta of
// an IIFE bundle). That module is `moduleUrl`, resolved as import() resolves
// it here, or else the package's own loader, beside its pqc.wasm. A
// `moduleUrl` that cannot be resolved rejects rather than falling back to the
// package's pqc.wasm, which need not match a loader from another copy.
function loaderDirectory(moduleUrl: string | URL | undefined): string {
  let url: URL
  if (moduleUrl === undefined) {
    try {
      url = new URL(packageFileUrl('pqc.mjs'))
    } catch {
      return ''
    }
  } else {
    url = resolveModuleUrl(String(moduleUrl))
  }
  if (isNode()) {
    if (url.protocol !== 'file:') {
      return ''
    }
    const { dirname } = process.getBuiltinModule('path')
    const { fileURLToPath } = process.getBuiltinModule('url')
    let path: string
    try {
      // Throws for a file: URL with a remote host on POSIX.
      path = fileURLToPath(url)
    } catch (error) {
      if (moduleUrl === undefined) {
        return ''
      }
      throw unresolvedModuleUrl(String(moduleUrl), error)
    }
    return `${dirname(realLoaderPath(path, moduleUrl))}/`
  }
  try {
    return new URL('.', url).href
  } catch {
    return ''
  }
}

// Node's module resolution follows symlinks, unless it runs with
// --preserve-symlinks, so a loader imported through a symlink has the real
// file's URL and looks for pqc.wasm beside that. A `moduleUrl` whose real path
// cannot be found rejects; for the package's own loader, which init() may not
// have imported, the path is kept as it is.
function realLoaderPath(path: string, moduleUrl: string | URL | undefined): string {
  if (preservesSymlinks()) {
    return path
  }
  try {
    return process.getBuiltinModule('fs').realpathSync(path)
  } catch (error) {
    if (moduleUrl === undefined) {
      return path
    }
    throw unresolvedModuleUrl(String(moduleUrl), error)
  }
}

// --preserve-symlinks on Node's command line or in NODE_OPTIONS, or
// NODE_PRESERVE_SYMLINKS=1, which turns on the same resolver option.
function preservesSymlinks(): boolean {
  const options = process.env['NODE_OPTIONS']?.split(/\s+/) ?? []
  return (
    process.env['NODE_PRESERVE_SYMLINKS'] === '1' ||
    process.execArgv.includes('--preserve-symlinks') ||
    options.includes('--preserve-symlinks')
  )
}

// How import() resolves `moduleUrl` from this module. A bare specifier, one
// that is neither a URL nor a path starting with /, ./ or ../, goes through
// import.meta.resolve, which applies package exports and import maps; without
// it (a bundler may strip it), init() cannot know what the name resolves to.
// A URL is parsed on its own, as import() parses it (file:opt/x.mjs is
// file:///opt/x.mjs); a path starting with /, ./ or ../ is resolved against
// this module's URL, which a bundler may have rewritten.
function resolveModuleUrl(moduleUrl: string): URL {
  const bare = isBareSpecifier(moduleUrl)
  if (bare && typeof import.meta.resolve !== 'function') {
    throw new PqcLoadError(moduleUrl, undefined, {
      cause: new TypeError(
        'a bare moduleUrl needs import.meta.resolve, which this runtime or bundle lacks, ' +
          'to find the pqc.wasm beside it: pass an absolute URL'
      ),
    })
  }
  try {
    if (bare) {
      return new URL(import.meta.resolve(moduleUrl))
    }
    return isUrl(moduleUrl) ? new URL(moduleUrl) : new URL(moduleUrl, import.meta.url)
  } catch (error) {
    throw unresolvedModuleUrl(moduleUrl, error)
  }
}

function unresolvedModuleUrl(moduleUrl: string, error: unknown): PqcLoadError {
  const reason = causeReason(error)
  return new PqcLoadError(moduleUrl, undefined, {
    cause: new TypeError(
      `moduleUrl cannot be resolved${reason === '' ? '' : ` (${reason})`} ` +
        'to find the pqc.wasm beside it: pass an absolute URL'
    ),
  })
}

function isBareSpecifier(specifier: string): boolean {
  return !/^\.{0,2}\//.test(specifier) && !isUrl(specifier)
}

// Whether `location` is a URL rather than a path: it parses as one with `//`
// after its scheme, or is a data:, blob: or file: URL (file:/x is absolute
// too). A path can hold a colon, as in build:v2/pqc.wasm or a Windows drive
// letter, which takes a one-letter scheme.
function isUrl(location: string): boolean {
  if (/^(?:data|blob|file):/i.test(location)) {
    return true
  }
  if (!/^[a-z][a-z0-9+.-]+:\/\//i.test(location)) {
    return false
  }
  try {
    new URL(location)
    return true
  } catch {
    return false
  }
}

// Reads pqc.wasm as the loader would: from the file system in Node, where a
// path or a URL starting with file:// (the loader's own test) names the file,
// and with fetch() elsewhere. Any other URL in Node is refused, file:/x and
// FILE:// included, which the loader would read as a missing path.
async function readWasm(url: string): Promise<Uint8Array> {
  if (isNode()) {
    const isFileUrl = url.startsWith('file://')
    if (!isFileUrl && isUrl(url)) {
      const scheme = url.slice(0, url.indexOf(':') + 1)
      const reason = /^file:/i.test(url)
        ? `a ${scheme} URL must start with file:// (lower case), as the loader reads it`
        : `URL scheme ${scheme} is not supported: in Node, init() reads pqc.wasm from a path or a file:// URL`
      throw new PqcLoadError(url, undefined, { cause: new TypeError(reason) })
    }
    try {
      return process.getBuiltinModule('fs').readFileSync(isFileUrl ? new URL(url) : url)
    } catch (error) {
      throw new PqcLoadError(url, undefined, { cause: error })
    }
  }
  let response: Response
  try {
    response = await fetch(url, { credentials: 'same-origin' })
    if (response.ok) {
      return new IntrinsicUint8Array(await response.arrayBuffer())
    }
  } catch (error) {
    throw new PqcLoadError(url, undefined, { cause: error })
  }
  throw new PqcLoadError(url, errorStatus(response))
}

// One copy, made with the captured constructor: a Uint8Array is copied by it,
// and an ArrayBuffer, which it would only view, is viewed first.
function copyWasmBinary(binary: ArrayBuffer | Uint8Array): Uint8Array {
  return new IntrinsicUint8Array(isUint8Array(binary) ? binary : new IntrinsicUint8Array(binary))
}

const HEX_DIGITS = '0123456789abcdef'

function toHex(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < typedArrayLength(bytes); i += 1) {
    const byte = bytes[i]!
    text += HEX_DIGITS[byte >>> 4]! + HEX_DIGITS[byte & 0x0f]!
  }
  return text
}

/** Whether `init()` has published a client, so the named exports can be called. */
export function isInitialized(): boolean {
  return activeClient !== undefined
}

/**
 * Resolves with the client the named exports use, as soon as `init()` has
 * published one. It does not start a load: until some `init()` call succeeds,
 * it waits.
 */
export function ready(): Promise<PqcClient> {
  if (activeClient !== undefined) {
    return Promise.resolve(activeClient)
  }
  if (firstClient === undefined) {
    let resolve!: (client: PqcClient) => void
    const promise = new Promise<PqcClient>(resolvePromise => {
      resolve = resolvePromise
    })
    firstClient = { promise, resolve }
  }
  return firstClient.promise
}

// Frozen, and without the module, which the methods close over: code given the
// client can neither replace a method the named exports call (a verify that
// returns true for every caller in the realm) nor reach the raw exports.
function createPqcClient(module: PqcWasmModule): PqcClient {
  assertWasmConstants(module)

  const client: PqcClient = {
    constants,
    keygen: entropy => keygenWithModule(module, entropy),
    derivePQCKey: (masterSeed, hkdfAccount, hkdfChange, hkdfIndex) =>
      derivePQCKeyWithKeygen(
        entropy => keygenWithModule(module, entropy),
        masterSeed,
        hkdfAccount,
        hkdfChange,
        hkdfIndex
      ),
    deriveP2mrDescriptorKey: (leafPrivateKey, rangeIndex) =>
      deriveP2mrDescriptorKeyWithKeygen(entropy => keygenWithModule(module, entropy), leafPrivateKey, rangeIndex),
    sign: (sk, msg, options) => signWithModule(module, sk, msg, options),
    signWithStats: (sk, msg, options) => signWithStatsWithModule(module, sk, msg, options),
    verify: (pk, msg, sig, options) => verifyWithModule(module, pk, msg, sig, options),
    secretKeyValidate: sk => secretKeyValidateWithModule(module, sk),
    wasmHeapBytes: () => module.HEAPU8.byteLength,
  }
  return Object.freeze(client)
}

function assertWasmConstants(module: PqcWasmModule): void {
  if (module._qbit_pqc_public_key_size() !== PK_SIZE) {
    throw new Error('pqc wasm public-key size does not match TypeScript constants')
  }
  if (module._qbit_pqc_secret_key_size() !== SK_SIZE) {
    throw new Error('pqc wasm secret-key size does not match TypeScript constants')
  }
  if (module._qbit_pqc_signature_size() !== SIG_SIZE) {
    throw new Error('pqc wasm signature size does not match TypeScript constants')
  }
  if (module._qbit_pqc_keygen_entropy_min_size() !== MIN_ENTROPY) {
    throw new Error('pqc wasm entropy size does not match TypeScript constants')
  }
  // WOTSC_LAYERS, which sizes the stats buffer, is not checked: pqc.wasm
  // exports no getter for the native layer count, and adding one changes
  // pqc.wasm and its pinned hashes. The vendored sign_stats.h fixes it at 5
  // for this single-profile build.
}

function getActiveClient(operation: string): PqcClient {
  if (activeClient === undefined) {
    throw notInitializedError(operation)
  }
  return activeClient
}

// No native call failed, so the error has code 0, and its kind and message
// replace the ones PqcError derives from a native code.
function notInitializedError(operation: string): PqcError {
  const error = new PqcError(operation, OK)
  Object.defineProperties(error, {
    kind: { value: 'NOT_INITIALIZED' },
    message: { value: `@qbit-oss/pqc init() must be awaited before calling ${operation}()` },
  })
  return error
}

/**
 * {@link PqcClient.keygen} on the client of the newest `init()` call that has
 * succeeded; a later call that fails or is still pending does not replace it.
 * Until an `init()` call has succeeded, it throws a {@link PqcError} with kind
 * `'NOT_INITIALIZED'`. `entropy` must be at least `constants.MIN_ENTROPY`
 * (128) bytes, and all of it is hashed into the key seed. An allocation
 * failure inside the native library throws a PqcError with kind
 * `'OUT_OF_MEMORY'`; one by the wrapper itself, a plain Error.
 */
export function keygen(entropy: Uint8Array): PqcKeyPair {
  return getActiveClient('keygen').keygen(entropy)
}

/**
 * {@link PqcClient.derivePQCKey} on the client of the newest `init()` call
 * that has succeeded; a later call that fails or is still pending does not
 * replace it. Until an `init()` call has succeeded, it throws a
 * {@link PqcError} with kind `'NOT_INITIALIZED'`. `hkdfAccount`, `hkdfChange`
 * and `hkdfIndex` are HKDF fields, not BIP32 path fields; derive wallet keys
 * with {@link deriveP2mrDescriptorKey}.
 */
export function derivePQCKey(
  masterSeed: Uint8Array,
  hkdfAccount: number,
  hkdfChange: number,
  hkdfIndex: number
): PqcDerivedKeyPair {
  return getActiveClient('derivePQCKey').derivePQCKey(masterSeed, hkdfAccount, hkdfChange, hkdfIndex)
}

/**
 * {@link PqcClient.deriveP2mrDescriptorKey} on the client of the newest
 * `init()` call that has succeeded; a later call that fails or is still
 * pending does not replace it. Until an `init()` call has succeeded, it throws
 * a {@link PqcError} with kind `'NOT_INITIALIZED'`. It returns the P2MR key
 * qbit Core's descriptor wallet derives from a 32-byte BIP32 leaf private key
 * at a non-hardened range position.
 */
export function deriveP2mrDescriptorKey(leafPrivateKey: Uint8Array, rangeIndex: number): PqcDerivedKeyPair {
  return getActiveClient('deriveP2mrDescriptorKey').deriveP2mrDescriptorKey(leafPrivateKey, rangeIndex)
}

/**
 * {@link PqcClient.sign} on the client of the newest `init()` call that has
 * succeeded; a later call that fails or is still pending does not replace it.
 * Until an `init()` call has succeeded, it throws a {@link PqcError} with kind
 * `'NOT_INITIALIZED'`. Sign a 32-byte digest; a `msg` longer than 64 KiB
 * needs `{ allowLargeMessage: true }`.
 */
export function sign(sk: Uint8Array, msg: Uint8Array, options?: PqcMessageOptions): Uint8Array {
  return getActiveClient('sign').sign(sk, msg, options)
}

/**
 * {@link PqcClient.signWithStats} on the client of the newest `init()` call
 * that has succeeded; a later call that fails or is still pending does not
 * replace it. Until an `init()` call has succeeded, it throws a
 * {@link PqcError} with kind `'NOT_INITIALIZED'`. It has the same message size
 * limit as {@link sign}.
 */
export function signWithStats(sk: Uint8Array, msg: Uint8Array, options?: PqcMessageOptions): PqcSignWithStatsResult {
  return getActiveClient('signWithStats').signWithStats(sk, msg, options)
}

/**
 * {@link PqcClient.verify} on the client of the newest `init()` call that has
 * succeeded; a later call that fails or is still pending does not replace it.
 * Until an `init()` call has succeeded, it throws a {@link PqcError} with kind
 * `'NOT_INITIALIZED'`; otherwise it has the same results and errors.
 */
export function verify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array, options?: PqcMessageOptions): boolean {
  return getActiveClient('verify').verify(pk, msg, sig, options)
}

/**
 * {@link PqcClient.secretKeyValidate} on the client of the newest `init()`
 * call that has succeeded; a later call that fails or is still pending does
 * not replace it. Until an `init()` call has succeeded, it throws a
 * {@link PqcError} with kind `'NOT_INITIALIZED'`. It returns whether the
 * stored root of `sk` matches its seeds; `SK.prf` is not checked.
 */
export function secretKeyValidate(sk: Uint8Array): boolean {
  return getActiveClient('secretKeyValidate').secretKeyValidate(sk)
}

/**
 * A validated byte argument. `length` is read exactly once from the intrinsic
 * getter and is the only length the wrapper uses from then on: for the
 * zero-length branch, the malloc size, the native length argument, the copy
 * and the zeroing. `view` is a plain fixed-length Uint8Array over those bytes
 * built from the intrinsic buffer/byteOffset getters, so copying it moves
 * exactly `length` bytes and throws a TypeError if the caller's buffer is
 * detached or shrunk out of bounds after validation (see copyIn).
 */
interface ByteInput {
  readonly name: string
  readonly view: Uint8Array
  readonly length: number
}

function pinBytes(name: string, value: unknown): ByteInput {
  assertUint8Array(name, value)
  // No user code can run between the attachment check and these reads, so
  // the three values describe the same, attached, in-bounds view. It is built
  // with the captured constructor, never the current globalThis.Uint8Array.
  const length = typedArrayLength(value)
  const view = new IntrinsicUint8Array(typedArrayBuffer(value), typedArrayByteOffset(value), length)
  return { name, view, length }
}

function assertNonEmpty(input: ByteInput): void {
  if (input.length === 0) {
    throw new RangeError(`${input.name} must not be empty`)
  }
}

function assertUint32(name: string, value: unknown, max = UINT32_MAX): asserts value is number {
  if (typeof value !== 'number' || !numberIsFinite(value) || !numberIsInteger(value)) {
    throw new TypeError(`${name} must be a uint32 integer`)
  }
  if (value < 0 || value > max) {
    throw new RangeError(`${name} must be between 0 and ${max}`)
  }
}

function assertExactLength(input: ByteInput, expected: number): void {
  if (input.length !== expected) {
    throw new RangeError(`${input.name} must be ${expected} bytes, got ${input.length}`)
  }
}

function assertMinLength(input: ByteInput, minimum: number): void {
  if (input.length < minimum) {
    throw new RangeError(`${input.name} must be at least ${minimum} bytes, got ${input.length}`)
  }
}

// Every FORS+C grind attempt rehashes the whole message, and a signature takes
// tens of thousands of attempts, so signing a long msg blocks the thread for
// seconds to minutes. qbit Core signs and verifies only 32-byte sighashes.
function exceedsMessageSize(input: ByteInput, allowLargeMessage: boolean): boolean {
  return !allowLargeMessage && input.length > MAX_MESSAGE_SIZE
}

function assertMessageSize(input: ByteInput, allowLargeMessage: boolean): void {
  if (exceedsMessageSize(input, allowLargeMessage)) {
    throw new RangeError(
      `${input.name} must be at most ${MAX_MESSAGE_SIZE} bytes without ` +
        `options.allowLargeMessage, got ${input.length}`
    )
  }
}

function malloc(module: PqcWasmModule, byteLength: number): number {
  const ptr = module._malloc(byteLength > 0 ? byteLength : 1)
  if (!ptr) {
    throw new Error(`WASM malloc failed for ${byteLength} bytes`)
  }
  return ptr
}

function zero(module: PqcWasmModule, ptr: number, byteLength: number): void {
  if (ptr !== 0 && byteLength > 0) {
    typedArrayFill(module.HEAPU8, 0, ptr, ptr + byteLength)
  }
}

function free(module: PqcWasmModule, ptr: number): void {
  if (ptr !== 0) {
    module._free(ptr)
  }
}

interface Allocation {
  readonly ptr: number
  readonly byteLength: number
}

/**
 * Zero, then free, the wasm allocations of a call. Every step runs even when
 * one before it throws, as zero() does on a stale HEAPU8 from a custom module
 * factory, so nothing is left allocated. The first such error is rethrown once
 * all of them have run, unless the call itself `failed`: its own error is the
 * one the caller sees.
 */
function release(module: PqcWasmModule, failed: boolean, allocations: readonly Allocation[]): void {
  let cleanupError: { readonly error: unknown } | undefined
  // Indexed loops: for...of would go through the overridable array iterator.
  for (let i = 0; i < allocations.length; i += 1) {
    const { ptr, byteLength } = allocations[i]!
    try {
      zero(module, ptr, byteLength)
    } catch (error) {
      cleanupError ??= { error }
    }
  }
  for (let i = 0; i < allocations.length; i += 1) {
    try {
      free(module, allocations[i]!.ptr)
    } catch (error) {
      cleanupError ??= { error }
    }
  }
  if (cleanupError !== undefined && !failed) {
    throw cleanupError.error
  }
}

/**
 * Copy exactly `input.length` bytes into freshly allocated wasm memory.
 * `_malloc` may grow the wasm memory, which detaches the previous heap
 * buffer; a caller view into `module.HEAPU8` (or any view that stops
 * addressing its buffer between validation and this copy) then no longer has
 * `input.length` elements, or makes the intrinsic `set` throw a TypeError,
 * before anything is copied. That is reported as the same TypeError as the
 * entry check, after releasing the allocation, instead of handing native code
 * a shorter message.
 */
function copyIn(module: PqcWasmModule, input: ByteInput): number {
  const ptr = malloc(module, input.length)
  try {
    // Invariant: the intrinsic `set` copies the source's real element count,
    // which must be exactly the size just allocated. The view was built with
    // that length, so this only fails once it is detached or out of bounds,
    // which the catch below reports as the entry check's TypeError.
    if (typedArrayLength(input.view) !== input.length) {
      throw new RangeError(`${input.name} changed length after validation`)
    }
    typedArraySet(module.HEAPU8, input.view, ptr)
  } catch (error) {
    release(module, true, [{ ptr, byteLength: input.length }])
    // Blame the caller only when the source really stopped addressing its
    // buffer; anything else (for example a stale HEAPU8 from a custom module
    // factory) is rethrown unchanged.
    assertAttached(input.name, input.view)
    throw error
  }
  return ptr
}

// Built from the intrinsic buffer/byteOffset getters rather than with
// HEAPU8.slice/subarray, which construct their result through the overridable
// `constructor` and Symbol.species of the heap view.
function heapView(module: PqcWasmModule, ptr: number, byteLength: number): Uint8Array {
  const heap = module.HEAPU8
  const byteOffset = typedArrayByteOffset(heap) + ptr
  return new IntrinsicUint8Array(typedArrayBuffer(heap), byteOffset, byteLength)
}

function copyOut(module: PqcWasmModule, ptr: number, byteLength: number): Uint8Array {
  const out = new IntrinsicUint8Array(byteLength)
  typedArraySet(out, heapView(module, ptr, byteLength), 0)
  return out
}

function throwNativeError(operation: string, code: number, details: PqcErrorDetails = {}): never {
  throw new PqcError(operation, code, details)
}

function derivePQCKeyWithKeygen(
  runKeygen: (entropy: Uint8Array) => PqcKeyPair,
  masterSeed: Uint8Array,
  hkdfAccount: number,
  hkdfChange: number,
  hkdfIndex: number
): PqcDerivedKeyPair {
  const seed = pinBytes('masterSeed', masterSeed)
  assertNonEmpty(seed)
  // The messages keep Core's DerivePQCKey field names.
  assertUint32('account', hkdfAccount)
  assertUint32('change', hkdfChange)
  assertUint32('index', hkdfIndex)

  return deriveKeyFromSeed(runKeygen, seed, hkdfAccount, hkdfChange, hkdfIndex)
}

// qbit Core's P2MRPubkeyProvider::GetPubKey: DerivePQCKey(leaf, 0, 0, position).
// Core hands it a 32-byte secp256k1 key, and a ranged descriptor's position is
// a non-hardened BIP32 child number.
function deriveP2mrDescriptorKeyWithKeygen(
  runKeygen: (entropy: Uint8Array) => PqcKeyPair,
  leafPrivateKey: Uint8Array,
  rangeIndex: number
): PqcDerivedKeyPair {
  const leaf = pinBytes('leafPrivateKey', leafPrivateKey)
  assertExactLength(leaf, P2MR_LEAF_KEY_SIZE)
  if (!isSecp256k1PrivateKey(leaf.view)) {
    throw new RangeError('leafPrivateKey must be a secp256k1 private key: nonzero and below the curve order')
  }
  assertUint32('rangeIndex', rangeIndex, P2MR_RANGE_INDEX_MAX)

  return deriveKeyFromSeed(runKeygen, leaf, 0, 0, rangeIndex)
}

// A BIP32 private key is an integer from 1 to n - 1, n being secp256k1's group
// order, and Core's CKey never holds any other value. The leaf is secret, so
// this compares all 32 bytes without branching on them.
function isSecp256k1PrivateKey(view: Uint8Array): boolean {
  let nonZero = 0
  let less = 0
  let greater = 0
  for (let i = 0; i < P2MR_LEAF_KEY_SIZE; i += 1) {
    const byte = view[i]!
    const order = SECP256K1_ORDER[i]!
    const undecided = 1 ^ (less | greater)
    less |= undecided & ((byte - order) >>> 31)
    greater |= undecided & ((order - byte) >>> 31)
    nonZero |= byte
  }
  return nonZero !== 0 && less === 1
}

function deriveKeyFromSeed(
  runKeygen: (entropy: Uint8Array) => PqcKeyPair,
  seed: ByteInput,
  hkdfAccount: number,
  hkdfChange: number,
  hkdfIndex: number
): PqcDerivedKeyPair {
  // The hash reads a module-owned copy of the validated bytes, taken before
  // anything else runs, so whatever later happens to the caller's buffer
  // (detached, shrunk or rewritten) cannot change what it hashes.
  const seedCopy = new IntrinsicUint8Array(seed.length)
  let entropy: Uint8Array
  try {
    typedArraySet(seedCopy, seed.view, 0)
    entropy = derivePQCKeygenEntropy(seedCopy, hkdfAccount, hkdfChange, hkdfIndex)
  } finally {
    typedArrayFill(seedCopy, 0)
  }
  try {
    const pair = runKeygen(entropy)
    return withDerivedKeyAliases({ pk32: pair.publicKey, sk64: pair.secretKey })
  } finally {
    typedArrayFill(entropy, 0)
  }
}

function derivePQCKeygenEntropy(masterSeed: Uint8Array, account: number, change: number, index: number): Uint8Array {
  const prk = hmacSha256(DERIVE_PQC_HKDF_SALT, masterSeed)
  const prefixLength = typedArrayLength(DERIVE_PQC_HKDF_INFO_PREFIX)
  const info = new IntrinsicUint8Array(prefixLength + 12)
  typedArraySet(info, DERIVE_PQC_HKDF_INFO_PREFIX, 0)
  const view = dataViewOf(info)
  dataViewSetUint32(view, prefixLength, account, true)
  dataViewSetUint32(view, prefixLength + 4, change, true)
  dataViewSetUint32(view, prefixLength + 8, index, true)

  try {
    return hkdfExpandSha256(prk, info, DERIVE_PQC_ENTROPY_BYTES)
  } finally {
    typedArrayFill(prk, 0)
    typedArrayFill(info, 0)
  }
}

function hkdfExpandSha256(prk: Uint8Array, info: Uint8Array, byteLength: number): Uint8Array {
  if (byteLength !== DERIVE_PQC_HKDF_BLOCKS * SHA256_BYTES) {
    throw new RangeError(`HKDF output length must be ${DERIVE_PQC_ENTROPY_BYTES} bytes`)
  }

  const infoLength = typedArrayLength(info)
  const okm = new IntrinsicUint8Array(byteLength)
  let previous = new IntrinsicUint8Array(0)
  for (let counter = 1; counter <= DERIVE_PQC_HKDF_BLOCKS; counter += 1) {
    const previousLength = typedArrayLength(previous)
    const input = new IntrinsicUint8Array(previousLength + infoLength + 1)
    typedArraySet(input, previous, 0)
    typedArraySet(input, info, previousLength)
    input[previousLength + infoLength] = counter

    const block = hmacSha256(prk, input)
    typedArraySet(okm, block, (counter - 1) * SHA256_BYTES)
    typedArrayFill(previous, 0)
    typedArrayFill(input, 0)
    previous = block
  }
  typedArrayFill(previous, 0)
  return okm
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  let normalizedKey = key
  if (typedArrayLength(key) > SHA256_BLOCK_BYTES) {
    normalizedKey = sha256(key)
  }

  const innerPad = new IntrinsicUint8Array(SHA256_BLOCK_BYTES)
  const outerPad = new IntrinsicUint8Array(SHA256_BLOCK_BYTES)
  typedArrayFill(innerPad, 0x36)
  typedArrayFill(outerPad, 0x5c)

  const keyLength = typedArrayLength(normalizedKey)
  for (let i = 0; i < keyLength; i += 1) {
    const byte = normalizedKey[i]!
    innerPad[i] ^= byte
    outerPad[i] ^= byte
  }

  const innerInput = new IntrinsicUint8Array(SHA256_BLOCK_BYTES + typedArrayLength(data))
  typedArraySet(innerInput, innerPad, 0)
  typedArraySet(innerInput, data, SHA256_BLOCK_BYTES)
  const innerHash = sha256(innerInput)

  const outerInput = new IntrinsicUint8Array(SHA256_BLOCK_BYTES + SHA256_BYTES)
  typedArraySet(outerInput, outerPad, 0)
  typedArraySet(outerInput, innerHash, SHA256_BLOCK_BYTES)
  const result = sha256(outerInput)

  typedArrayFill(innerPad, 0)
  typedArrayFill(outerPad, 0)
  typedArrayFill(innerInput, 0)
  typedArrayFill(innerHash, 0)
  typedArrayFill(outerInput, 0)
  if (normalizedKey !== key) {
    typedArrayFill(normalizedKey, 0)
  }

  return result
}

// A DataView on exactly the bytes of `bytes`, from the intrinsic getters.
function dataViewOf(bytes: Uint8Array): DataView {
  return new IntrinsicDataView(typedArrayBuffer(bytes), typedArrayByteOffset(bytes), typedArrayByteLength(bytes))
}

function sha256(message: Uint8Array): Uint8Array {
  const messageLength = typedArrayLength(message)
  const paddedLength = mathCeil((messageLength + 9) / SHA256_BLOCK_BYTES) * SHA256_BLOCK_BYTES
  const padded = new IntrinsicUint8Array(paddedLength)
  typedArraySet(padded, message, 0)
  padded[messageLength] = 0x80

  const bitLength = messageLength * 8
  const view = dataViewOf(padded)
  dataViewSetUint32(view, paddedLength - 8, mathFloor(bitLength / 0x100000000), false)
  dataViewSetUint32(view, paddedLength - 4, bitLength >>> 0, false)

  const state = new IntrinsicUint32Array(SHA256_INITIAL_STATE)
  const words = new IntrinsicUint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += SHA256_BLOCK_BYTES) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = dataViewGetUint32(view, offset + i * 4, false)
    }
    for (let i = 16; i < 64; i += 1) {
      words[i] = (smallSigma1(words[i - 2]!) + words[i - 7]! + smallSigma0(words[i - 15]!) + words[i - 16]!) >>> 0
    }

    let a = state[0]!
    let b = state[1]!
    let c = state[2]!
    let d = state[3]!
    let e = state[4]!
    let f = state[5]!
    let g = state[6]!
    let h = state[7]!

    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + bigSigma1(e) + choose(e, f, g) + SHA256_K[i]! + words[i]!) >>> 0
      const t2 = (bigSigma0(a) + majority(a, b, c)) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    state[0] = (state[0]! + a) >>> 0
    state[1] = (state[1]! + b) >>> 0
    state[2] = (state[2]! + c) >>> 0
    state[3] = (state[3]! + d) >>> 0
    state[4] = (state[4]! + e) >>> 0
    state[5] = (state[5]! + f) >>> 0
    state[6] = (state[6]! + g) >>> 0
    state[7] = (state[7]! + h) >>> 0
  }

  const digest = new IntrinsicUint8Array(SHA256_BYTES)
  const digestView = dataViewOf(digest)
  const stateWords = typedArrayLength(state)
  for (let i = 0; i < stateWords; i += 1) {
    dataViewSetUint32(digestView, i * 4, state[i]!, false)
  }
  typedArrayFill(padded, 0)
  typedArrayFill(words, 0)
  typedArrayFill(state, 0)
  return digest
}

function asciiBytes(text: string): Uint8Array {
  const bytes = new IntrinsicUint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code > 0x7f) {
      throw new RangeError('ASCII encoding only supports 7-bit characters')
    }
    bytes[i] = code
  }
  return bytes
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

function choose(x: number, y: number, z: number): number {
  return (x & y) ^ (~x & z)
}

function majority(x: number, y: number, z: number): number {
  return (x & y) ^ (x & z) ^ (y & z)
}

function bigSigma0(value: number): number {
  return rotr(value, 2) ^ rotr(value, 13) ^ rotr(value, 22)
}

function bigSigma1(value: number): number {
  return rotr(value, 6) ^ rotr(value, 11) ^ rotr(value, 25)
}

function smallSigma0(value: number): number {
  return rotr(value, 7) ^ rotr(value, 18) ^ (value >>> 3)
}

function smallSigma1(value: number): number {
  return rotr(value, 17) ^ rotr(value, 19) ^ (value >>> 10)
}

function keygenWithModule(module: PqcWasmModule, entropy: Uint8Array): PqcKeyPair {
  const entropyIn = pinBytes('entropy', entropy)
  assertMinLength(entropyIn, MIN_ENTROPY)

  let entropyPtr = 0
  let publicKeyPtr = 0
  let secretKeyPtr = 0
  let failed = false
  try {
    entropyPtr = copyIn(module, entropyIn)
    publicKeyPtr = malloc(module, PK_SIZE)
    secretKeyPtr = malloc(module, SK_SIZE)

    const rc = module._qbit_pqc_keygen(publicKeyPtr, secretKeyPtr, entropyPtr, entropyIn.length)
    if (rc !== OK) {
      throwNativeError('keygen', rc)
    }

    return {
      publicKey: copyOut(module, publicKeyPtr, PK_SIZE),
      secretKey: copyOut(module, secretKeyPtr, SK_SIZE),
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    release(module, failed, [
      { ptr: entropyPtr, byteLength: entropyIn.length },
      { ptr: publicKeyPtr, byteLength: PK_SIZE },
      { ptr: secretKeyPtr, byteLength: SK_SIZE },
    ])
  }
}

function signWithModule(
  module: PqcWasmModule,
  sk: Uint8Array,
  msg: Uint8Array,
  options: PqcMessageOptions | undefined
): Uint8Array {
  const allowLargeMessage = readAllowLargeMessage(options)
  const skIn = pinBytes('sk', sk)
  const msgIn = pinBytes('msg', msg)
  assertExactLength(skIn, SK_SIZE)
  assertMessageSize(msgIn, allowLargeMessage)

  let secretKeyPtr = 0
  let messagePtr = 0
  let signaturePtr = 0
  let failed = false
  try {
    secretKeyPtr = copyIn(module, skIn)
    if (msgIn.length > 0) {
      messagePtr = copyIn(module, msgIn)
    }
    signaturePtr = malloc(module, SIG_SIZE)

    const rc = module._qbit_pqc_sign(signaturePtr, secretKeyPtr, messagePtr, msgIn.length)
    if (rc !== OK) {
      throwNativeError('sign', rc)
    }

    return copyOut(module, signaturePtr, SIG_SIZE)
  } catch (error) {
    failed = true
    throw error
  } finally {
    release(module, failed, [
      { ptr: secretKeyPtr, byteLength: skIn.length },
      { ptr: messagePtr, byteLength: msgIn.length },
      { ptr: signaturePtr, byteLength: SIG_SIZE },
    ])
  }
}

function signWithStatsWithModule(
  module: PqcWasmModule,
  sk: Uint8Array,
  msg: Uint8Array,
  options: PqcMessageOptions | undefined
): PqcSignWithStatsResult {
  const allowLargeMessage = readAllowLargeMessage(options)
  const skIn = pinBytes('sk', sk)
  const msgIn = pinBytes('msg', msg)
  assertExactLength(skIn, SK_SIZE)
  assertMessageSize(msgIn, allowLargeMessage)

  let secretKeyPtr = 0
  let messagePtr = 0
  let signaturePtr = 0
  let statsPtr = 0
  let failed = false
  try {
    secretKeyPtr = copyIn(module, skIn)
    if (msgIn.length > 0) {
      messagePtr = copyIn(module, msgIn)
    }
    signaturePtr = malloc(module, SIG_SIZE)
    statsPtr = malloc(module, SIGN_STATS_BYTES)
    // Zeroed so that a shim path that returns without writing the stats, such
    // as BAD_ARG, reads as not started rather than as heap bytes that look
    // like caps.
    zero(module, statsPtr, SIGN_STATS_BYTES)

    const rc = module._qbit_pqc_sign_with_stats(signaturePtr, statsPtr, secretKeyPtr, messagePtr, msgIn.length)
    const stats = readStats(module, statsPtr)
    if (rc !== OK) {
      throwNativeError('signWithStats', rc, signingStarted(rc, stats) ? { stats } : {})
    }

    return {
      sig: copyOut(module, signaturePtr, SIG_SIZE),
      stats,
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    release(module, failed, [
      { ptr: secretKeyPtr, byteLength: skIn.length },
      { ptr: messagePtr, byteLength: msgIn.length },
      { ptr: signaturePtr, byteLength: SIG_SIZE },
      { ptr: statsPtr, byteLength: SIGN_STATS_BYTES },
    ])
  }
}

// The native library sets the caps only once signing starts, so a failure
// before that (BAD_KEY, OUT_OF_MEMORY, or BAD_SIGNATURE from deriving the
// signing randomness) leaves them 0 and reports no attempt. SIGNING_LIMIT is
// only reached after the start.
function signingStarted(rc: number, stats: PqcSignStats): boolean {
  return rc === ERROR_SIGNING_LIMIT || stats.forscMaxAttempts !== 0
}

function readStats(module: PqcWasmModule, statsPtr: number): PqcSignStats {
  const bytes = heapView(module, statsPtr, SIGN_STATS_BYTES)
  const raw = new IntrinsicUint32Array(typedArrayBuffer(bytes), typedArrayByteOffset(bytes), SIGN_STATS_WORDS)
  // Array.from called without a receiver creates a plain array and defines
  // each element on it, and this null-prototype array-like has no iterator or
  // inherited element to look up. Iterating `raw`, or storing into an array by
  // index, would go through an overridable iterator or Array.prototype setter.
  const layers = { __proto__: null, length: WOTSC_LAYERS }
  return {
    forscAttempts: raw[0]!,
    forscMaxAttempts: raw[1]!,
    wotscAttempts: arrayFrom(layers, (_, layer) => raw[SIGN_STATS_WOTSC_ATTEMPTS + layer]!),
    wotscLayerCount: raw[SIGN_STATS_WOTSC_TOTALS]!,
    wotscMaxAttempts: raw[SIGN_STATS_WOTSC_TOTALS + 1]!,
    wotscMaxObservedAttempts: raw[SIGN_STATS_WOTSC_TOTALS + 2]!,
    capExceeded: raw[SIGN_STATS_WOTSC_TOTALS + 3]!,
  }
}

function verifyWithModule(
  module: PqcWasmModule,
  pk: Uint8Array,
  msg: Uint8Array,
  sig: Uint8Array,
  options: PqcMessageOptions | undefined
): boolean {
  const allowLargeMessage = readAllowLargeMessage(options)
  const pkIn = pinBytes('pk', pk)
  const msgIn = pinBytes('msg', msg)
  const sigIn = pinBytes('sig', sig)
  // pk and sig usually come from an untrusted party, and bytes of the wrong
  // length cannot be a valid key or signature: return false, as qbit Core's
  // CPQCPubKey::Verify does, rather than throw. A msg over the size limit is
  // reported the same way unless the caller opted in: Core verifies only
  // 32-byte sighashes, and copying a large msg grows the wasm heap for the
  // instance's lifetime. Decided on the pinned lengths before any wasm
  // allocation, so an oversized input costs no copy.
  if (pkIn.length !== PK_SIZE || sigIn.length !== SIG_SIZE || exceedsMessageSize(msgIn, allowLargeMessage)) {
    return false
  }

  let publicKeyPtr = 0
  let messagePtr = 0
  let signaturePtr = 0
  let failed = false
  try {
    publicKeyPtr = copyIn(module, pkIn)
    if (msgIn.length > 0) {
      messagePtr = copyIn(module, msgIn)
    }
    signaturePtr = copyIn(module, sigIn)

    const rc = module._qbit_pqc_verify(publicKeyPtr, messagePtr, msgIn.length, signaturePtr, sigIn.length)
    if (rc === OK) {
      return true
    }
    if (rc === ERROR_BAD_SIGNATURE) {
      return false
    }
    throwNativeError('verify', rc)
  } catch (error) {
    failed = true
    throw error
  } finally {
    release(module, failed, [
      { ptr: publicKeyPtr, byteLength: pkIn.length },
      { ptr: messagePtr, byteLength: msgIn.length },
      { ptr: signaturePtr, byteLength: sigIn.length },
    ])
  }
}

function secretKeyValidateWithModule(module: PqcWasmModule, sk: Uint8Array): boolean {
  const skIn = pinBytes('sk', sk)
  assertExactLength(skIn, SK_SIZE)

  let secretKeyPtr = 0
  let failed = false
  try {
    secretKeyPtr = copyIn(module, skIn)
    const rc = module._qbit_pqc_secret_key_validate(secretKeyPtr, skIn.length)
    if (rc === OK) {
      return true
    }
    if (rc === ERROR_BAD_KEY) {
      return false
    }
    throwNativeError('secretKeyValidate', rc)
  } catch (error) {
    failed = true
    throw error
  } finally {
    release(module, failed, [{ ptr: secretKeyPtr, byteLength: skIn.length }])
  }
}
