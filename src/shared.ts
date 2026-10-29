// What the implementation (src/core.ts, built as lib/core.mjs) shares with the
// worker client (src/worker.ts, built as lib/worker.mjs): the error classes,
// codes and constants, the intrinsics and byte checks every argument goes
// through, and the reader of `options`. Built as lib/shared.mjs, which no
// `exports` entry names; the entries re-export its public names through
// lib/core.mjs. It imports nothing, so a client that imports it reaches
// neither the Emscripten loader nor pqc.wasm, and every file that imports it
// shares one copy, so `instanceof` works across entries.
//
// The intrinsics are captured when this module loads, before lib/core.mjs
// runs (see the comment at the top of src/core.ts for what they protect).
// Names marked @internal are exported for the package's own files only; the
// entries do not re-export them, and the declarations leave them out.
const IntrinsicUint8Array = Uint8Array
const IntrinsicObjectPrototype = Object.prototype
const {
  defineProperties: objectDefineProperties,
  getOwnPropertyDescriptor: objectGetOwnPropertyDescriptor,
  getPrototypeOf: objectGetPrototypeOf,
} = Object
const { ownKeys: reflectOwnKeys } = Reflect
const objectHasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty) as (
  object: object,
  key: PropertyKey
) => boolean

const OK = 0
const ERROR_BAD_KEY = -2
const ERROR_BAD_SIGNATURE = -3
const ERROR_SIGNING_LIMIT = -5
const PK_SIZE = 32
const SK_SIZE = 64
const SIG_SIZE = 3680
const MIN_ENTROPY = 128
const MAX_MESSAGE_SIZE = 65536
const WOTSC_LAYERS = 5
const SIGN_STATS_WORDS = 11

// %TypedArray% intrinsics captured when the module loads. Every byte argument
// is measured and copied through these rather than through its own (possibly
// overridden) accessors, so a subclass getter can neither lie about a length
// nor run user code once validation has started, and patching
// %TypedArray%.prototype or Function.prototype.call afterwards cannot disable
// the checks or change how many bytes reach wasm memory. The key-derivation
// hash calls them, and the DataView methods below, on its own buffers.
const typedArrayPrototype = Object.getPrototypeOf(IntrinsicUint8Array.prototype) as object
const typedArrayName = uncurryTypedArrayGetter<string | undefined, unknown>(Symbol.toStringTag)
const typedArrayLength = uncurryTypedArrayGetter<number, Uint8Array | Uint32Array>('length')
const typedArrayBuffer = uncurryTypedArrayGetter<ArrayBufferLike>('buffer')
const typedArrayByteOffset = uncurryTypedArrayGetter<number>('byteOffset')
const typedArrayByteLength = uncurryTypedArrayGetter<number>('byteLength')
const typedArrayValues = uncurryTypedArrayMethod<[]>('values')
const typedArraySet = uncurryTypedArrayMethod<[source: Uint8Array, offset: number]>('set')
const typedArrayFill = uncurryTypedArrayMethod<[value: number, start?: number, end?: number], Uint8Array | Uint32Array>(
  'fill'
)

function uncurryTypedArrayGetter<T, V = Uint8Array>(
  key: 'length' | 'buffer' | 'byteOffset' | 'byteLength' | typeof Symbol.toStringTag
): (view: V) => T {
  const get = Object.getOwnPropertyDescriptor(typedArrayPrototype, key)?.get
  if (typeof get !== 'function') {
    throw new TypeError(`%TypedArray%.prototype.${String(key)} getter is unavailable`)
  }
  return Function.prototype.call.bind(get) as (view: V) => T
}

function uncurryTypedArrayMethod<A extends unknown[], V = Uint8Array>(
  key: 'values' | 'set' | 'fill'
): (view: V, ...args: A) => unknown {
  const method = Object.getOwnPropertyDescriptor(typedArrayPrototype, key)?.value
  if (typeof method !== 'function') {
    throw new TypeError(`%TypedArray%.prototype.${key} is unavailable`)
  }
  return Function.prototype.call.bind(method) as (view: V, ...args: A) => unknown
}

/**
 * The %TypedArray% getters and methods above, and the Uint8Array constructor,
 * as this module captured them.
 *
 * @internal
 */
export const TYPED_ARRAY_INTRINSICS = Object.freeze({
  Uint8Array: IntrinsicUint8Array,
  typedArrayName,
  typedArrayLength,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayByteLength,
  typedArrayValues,
  typedArraySet,
  typedArrayFill,
})

/**
 * The native `bitcoin_pqc_*` return codes by name: `BITCOIN_PQC_OK` (0) for
 * success and a negative code for each failure. A {@link PqcError} carries the
 * code of a native failure as `code`, its name as `nativeName` and its
 * {@link PqcErrorKind} as `kind`.
 *
 * Exported for callers, and frozen, like `constants`. `verify`,
 * `secretKeyValidate` and `signWithStats` compare native return codes with
 * module-private copies of these values.
 */
export const errorCodes = Object.freeze({
  BITCOIN_PQC_OK: OK,
  BITCOIN_PQC_ERROR_BAD_ARG: -1,
  BITCOIN_PQC_ERROR_BAD_KEY: ERROR_BAD_KEY,
  BITCOIN_PQC_ERROR_BAD_SIGNATURE: ERROR_BAD_SIGNATURE,
  BITCOIN_PQC_ERROR_NOT_IMPLEMENTED: -4,
  BITCOIN_PQC_ERROR_SIGNING_LIMIT: ERROR_SIGNING_LIMIT,
  BITCOIN_PQC_ERROR_OUT_OF_MEMORY: -6,
} as const)

/** Alias of {@link errorCodes}: the same frozen object. */
export const errors = errorCodes

/** The name of a native failure code: a key of {@link errorCodes} other than `BITCOIN_PQC_OK`. */
export type PqcNativeErrorName = Exclude<keyof typeof errorCodes, 'BITCOIN_PQC_OK'>
/** A native failure code: a value of {@link errorCodes} other than `BITCOIN_PQC_OK` (0). */
export type PqcNativeErrorCode = (typeof errorCodes)[PqcNativeErrorName]
/**
 * What failed, as a {@link PqcError} reports it in `kind`. The first six are
 * native failures, named after their {@link errorCodes} entry:
 *
 * - `BAD_ARG`: the native library rejected an argument, such as a NULL pointer
 *   or keygen entropy shorter than `constants.MIN_ENTROPY`. The wrapper rejects
 *   such input itself, with a TypeError or RangeError, before the native call.
 * - `BAD_KEY`: `sign` or `signWithStats` got a secret key whose stored root
 *   does not match its seeds, the bytes {@link PqcClient.secretKeyValidate}
 *   returns false for; from `keygen`, key generation itself failed.
 * - `BAD_SIGNATURE`: from `sign` or `signWithStats`, the signing operation
 *   itself failed. `verify` returns false instead of throwing it.
 * - `NOT_IMPLEMENTED`: reserved; the native library does not return it.
 * - `SIGNING_LIMIT`: signing one message hit the bounded30 FORS+C or WOTS+C
 *   grind-attempt cap. Retrying the same bytes hits the same cap, so change the
 *   message before signing again. The error from `signWithStats` carries the
 *   signing stats.
 * - `OUT_OF_MEMORY`: an allocation inside the native library failed: the key
 *   or signature buffers, or keygen's seed-derivation buffer. A failed WASM
 *   heap allocation by the wrapper itself throws a plain Error instead.
 * - `NOT_INITIALIZED`: a named export was called before any `init()` call
 *   succeeded. `code` is 0.
 * - `LOAD_FAILED`: `init()` could not load the WASM module. The error is a
 *   {@link PqcLoadError}, and `code` is 0.
 * - `UNKNOWN`: a return code that names no failure in {@link errorCodes}.
 */
export type PqcErrorKind =
  | 'BAD_ARG'
  | 'BAD_KEY'
  | 'BAD_SIGNATURE'
  | 'NOT_IMPLEMENTED'
  | 'SIGNING_LIMIT'
  | 'OUT_OF_MEMORY'
  | 'NOT_INITIALIZED'
  | 'LOAD_FAILED'
  | 'UNKNOWN'

// Lookup tables with no prototype: a key they lack, such as 'constructor' or
// '__proto__' from a JavaScript caller, finds nothing rather than a member of
// Object.prototype.
function withoutPrototype<T extends object>(entries: T): Readonly<T> {
  return Object.assign(Object.create(null) as T, entries)
}

const nativeErrorNamesByCode = withoutPrototype<Record<number, PqcNativeErrorName>>({
  [errorCodes.BITCOIN_PQC_ERROR_BAD_ARG]: 'BITCOIN_PQC_ERROR_BAD_ARG',
  [errorCodes.BITCOIN_PQC_ERROR_BAD_KEY]: 'BITCOIN_PQC_ERROR_BAD_KEY',
  [errorCodes.BITCOIN_PQC_ERROR_BAD_SIGNATURE]: 'BITCOIN_PQC_ERROR_BAD_SIGNATURE',
  [errorCodes.BITCOIN_PQC_ERROR_NOT_IMPLEMENTED]: 'BITCOIN_PQC_ERROR_NOT_IMPLEMENTED',
  [errorCodes.BITCOIN_PQC_ERROR_SIGNING_LIMIT]: 'BITCOIN_PQC_ERROR_SIGNING_LIMIT',
  [errorCodes.BITCOIN_PQC_ERROR_OUT_OF_MEMORY]: 'BITCOIN_PQC_ERROR_OUT_OF_MEMORY',
})

const nativeErrorKindsByName = withoutPrototype<Record<PqcNativeErrorName, PqcErrorKind>>({
  BITCOIN_PQC_ERROR_BAD_ARG: 'BAD_ARG',
  BITCOIN_PQC_ERROR_BAD_KEY: 'BAD_KEY',
  BITCOIN_PQC_ERROR_BAD_SIGNATURE: 'BAD_SIGNATURE',
  BITCOIN_PQC_ERROR_NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  BITCOIN_PQC_ERROR_SIGNING_LIMIT: 'SIGNING_LIMIT',
  BITCOIN_PQC_ERROR_OUT_OF_MEMORY: 'OUT_OF_MEMORY',
})

/**
 * The {@link errorCodes} name of a native failure code, or undefined for
 * `BITCOIN_PQC_OK` (0) and any number that is not a code.
 */
export function nativeErrorName(code: number): PqcNativeErrorName | undefined {
  return nativeErrorNamesByCode[code]
}

/**
 * The {@link PqcErrorKind} of a native failure code, as {@link PqcError}
 * derives its `kind`, or `'UNKNOWN'` for 0 and any number that is not a
 * failure code.
 */
export function nativeErrorKind(code: number): PqcErrorKind {
  const name = nativeErrorName(code)
  return name === undefined ? 'UNKNOWN' : nativeErrorKindsByName[name]
}

/**
 * The scheme's name, sizes and limits, and the native error codes:
 *
 * - `ALGORITHM`: the signature scheme, `'SLH-DSA-SHA2-128s-bounded30'`.
 * - `PK_SIZE`, `SK_SIZE`, `SIG_SIZE`: the public key, secret key and signature
 *   lengths in bytes (32, 64 and 3680).
 * - `MIN_ENTROPY`: the fewest entropy bytes `keygen` accepts (128).
 * - `MAX_MESSAGE_SIZE`: the longest `msg` in bytes without `allowLargeMessage`
 *   (65536). `sign` and `signWithStats` throw a RangeError for a longer one,
 *   and `verify` returns false.
 * - `SIGN_STATS_WORDS`: the number of uint32 words the native signer writes
 *   for `signWithStats` (11).
 * - `WOTSC_LAYERS`: the number of WOTS+C layers, the length of
 *   {@link PqcSignStats.wotscAttempts} (5).
 * - `SIGN_LIMITS`: the bit flags of {@link PqcSignStats.capExceeded}: `NONE`
 *   (0), `FORSC` (1) and `WOTSC` (2).
 * - `ERROR_CODES`: {@link errorCodes}.
 *
 * Exported for callers, and frozen with every object it holds, so no code can
 * change a size or code that other code reads from it. The wrapper itself
 * reads module-private copies.
 */
export const constants = Object.freeze({
  ALGORITHM: 'SLH-DSA-SHA2-128s-bounded30',
  PK_SIZE,
  SK_SIZE,
  SIG_SIZE,
  MIN_ENTROPY,
  MAX_MESSAGE_SIZE,
  SIGN_STATS_WORDS,
  WOTSC_LAYERS,
  SIGN_LIMITS: Object.freeze({
    NONE: 0,
    FORSC: 1,
    WOTSC: 2,
  } as const),
  ERROR_CODES: errorCodes,
  /**
   * The SHA-256 of the `pqc.wasm` this version of the package ships and embeds,
   * in lowercase hex: its line in `wasm/SHA256SUMS`. Pass it as
   * `init({ expectedWasmSha256: constants.WASM_SHA256 })` to have `init()`
   * refuse any other bytes.
   */
  WASM_SHA256: __PQC_WASM_SHA256__,
} as const)

/**
 * The native grind statistics of one signing call, from
 * {@link PqcClient.signWithStats} or the {@link PqcError} it threw. Every
 * number is a uint32. A {@link PqcError} carries them only when signing had
 * started (see {@link PqcError.stats}), and then the fields hold the attempts
 * made until it failed.
 */
export interface PqcSignStats {
  /** The FORS+C salt-grind attempts made for this signature. */
  forscAttempts: number
  /**
   * The FORS+C attempt cap: signing that reaches it without success fails with
   * `SIGNING_LIMIT`.
   */
  forscMaxAttempts: number
  /**
   * The WOTS+C counter-grind attempts for each layer, in the order the layers
   * were ground: `constants.WOTSC_LAYERS` (5) entries, 0 for a layer not
   * reached.
   */
  wotscAttempts: number[]
  /** The number of WOTS+C layers ground: `constants.WOTSC_LAYERS` (5) for a signature that completed. */
  wotscLayerCount: number
  /**
   * The WOTS+C attempt cap for each layer: a layer that reaches it fails
   * signing with `SIGNING_LIMIT`.
   */
  wotscMaxAttempts: number
  /** The most attempts any one WOTS+C layer took. */
  wotscMaxObservedAttempts: number
  /** The caps that were hit, as bit flags from `constants.SIGN_LIMITS`: `NONE` (0) when none was. */
  capExceeded: number
}

/** Optional fields of a {@link PqcError}, passed to its constructor. */
export interface PqcErrorDetails {
  /** The signing stats to attach as {@link PqcError.stats}. */
  stats?: PqcSignStats
}

/**
 * The error a call throws when the native library fails, and the named exports
 * throw before an `init()` call has succeeded; `init()` rejects with the
 * subclass {@link PqcLoadError}. `kind` says what failed. An argument of the
 * wrong type throws a TypeError instead, and one of the wrong length a
 * RangeError (`verify` returns false).
 */
export class PqcError extends Error {
  /**
   * The call that failed: `'keygen'`, `'sign'`, `'signWithStats'`, `'verify'`
   * or `'secretKeyValidate'` for a native failure, `'keygen'` also inside
   * `derivePQCKey` and `deriveP2mrDescriptorKey`; `'init'` for a
   * {@link PqcLoadError}; and for `NOT_INITIALIZED`, the named export called.
   */
  readonly operation: string
  /**
   * The native return code. Errors the wrapper raises itself, NOT_INITIALIZED
   * and LOAD_FAILED, have code 0 and no nativeName.
   */
  readonly code: number
  /** The {@link errorCodes} name of `code`, or undefined when `code` is not a native failure code. */
  readonly nativeName: PqcNativeErrorName | undefined
  /** What failed; see {@link PqcErrorKind}. It follows from `code`, except for `NOT_INITIALIZED` and `LOAD_FAILED`. */
  readonly kind: PqcErrorKind
  /**
   * The native signing stats on a failure of `signWithStats` once signing had
   * started: every `SIGNING_LIMIT` error, and a `BAD_SIGNATURE` from a failed
   * signature or self-check, with the attempts made until then. Undefined when
   * signing failed before it started (`BAD_KEY`, `OUT_OF_MEMORY`, or a
   * `BAD_SIGNATURE` deriving the signing randomness) and on every other error,
   * `NOT_INITIALIZED` included.
   */
  readonly stats: PqcSignStats | undefined

  constructor(operation: string, code: number, details: PqcErrorDetails = {}) {
    const nativeName = nativeErrorName(code)
    const kind = nativeName === undefined ? 'UNKNOWN' : nativeErrorKindsByName[nativeName]
    const label = nativeName ?? 'UNKNOWN'
    super(`${operation} failed with ${label} (${code})`)
    this.name = 'PqcError'
    this.operation = operation
    this.code = code
    this.nativeName = nativeName
    this.kind = kind
    this.stats = details.stats
  }
}

/**
 * Rejects `init()` when it cannot load the WASM module: the loader cannot be
 * imported or exports no factory, or it cannot fetch, compile or instantiate
 * pqc.wasm, as under a CSP without 'wasm-unsafe-eval'. A `createModule`
 * factory that fails, a module that does not match this version of the
 * package, and WASM bytes whose SHA-256 is not `expectedWasmSha256` count
 * too. `url` is the file that failed, when init() knows it:
 * the `moduleUrl` loader, when that cannot be imported or exports no factory,
 * or the location the loader asked for pqc.wasm at, or, with
 * `expectedWasmSha256`, the pqc.wasm file init() could not read or whose
 * digest differs. Otherwise it is undefined, as when the loader had the bytes
 * (the embedded copy, `wasmBinary`, or a file init() read and checked) and
 * fetched nothing. `status` is the HTTP status of an error
 * response for `url`, when a browser got one; it is undefined for a file, in
 * Node, and when the request failed without a response. `cause` is the
 * original error, and the message names it too.
 */
export class PqcLoadError extends PqcError {
  /** Always `'LOAD_FAILED'`. */
  override readonly kind: 'LOAD_FAILED'
  /**
   * The file that failed, when `init()` knows it: the `moduleUrl` loader, the
   * location the loader asked for `pqc.wasm` at, or, with
   * `expectedWasmSha256`, the `pqc.wasm` file `init()` could not read or whose
   * digest differs. Undefined otherwise, as when the loader had the bytes and
   * fetched nothing.
   */
  readonly url: string | undefined
  /**
   * The HTTP status of an error response for `url`, when a browser got one;
   * undefined for a file, in Node, and when the request failed without a
   * response.
   */
  readonly status: number | undefined
  /** The original error. */
  declare readonly cause: unknown

  constructor(url: string | undefined, status: number | undefined, options: { cause?: unknown } = {}) {
    super('init', OK)
    this.name = 'PqcLoadError'
    this.kind = 'LOAD_FAILED'
    const httpStatus = status === undefined ? '' : ` (HTTP ${status})`
    const reason = causeReason(options.cause)
    this.message =
      `init() could not load ${url ?? 'the WASM module'}${httpStatus}` + (reason === '' ? '' : `: ${reason}`)
    this.url = url
    this.status = status
    Object.defineProperty(this, 'cause', {
      configurable: true,
      writable: true,
      value: options.cause,
    })
  }
}

/**
 * A thrown string, or the message of an Error from any realm.
 *
 * @internal
 */
export function causeReason(cause: unknown): string {
  if (typeof cause === 'string') {
    return cause
  }
  try {
    const message = (cause as { message?: unknown } | null | undefined)?.message
    return typeof message === 'string' ? message : ''
  } catch {
    return ''
  }
}

// The aliases on every derived key. The descriptors have no prototype, so no
// `value`, `set` or `enumerable` that other code adds to Object.prototype
// reaches defineProperties: the aliases stay non-enumerable getters.
const DERIVED_KEY_ALIASES: PropertyDescriptorMap = withoutPrototype({
  publicKey: withoutPrototype({
    get(this: DerivedKey): Uint8Array {
      return this.pk32
    },
    enumerable: false,
    configurable: true,
  }),
  secretKey: withoutPrototype({
    get(this: DerivedKey): Uint8Array {
      return this.sk64
    },
    enumerable: false,
    configurable: true,
  }),
})

// The two keys of a derived key pair (PqcDerivedKey in src/index.ts).
interface DerivedKey {
  pk32: Uint8Array
  sk64: Uint8Array
}

/**
 * Adds the non-enumerable `publicKey` and `secretKey` getters of a
 * `PqcDerivedKeyPair` to `pair` and returns it.
 *
 * @internal
 */
export function withDerivedKeyAliases<T extends DerivedKey>(
  pair: T
): T & { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array } {
  return objectDefineProperties(pair, DERIVED_KEY_ALIASES) as T & {
    readonly publicKey: Uint8Array
    readonly secretKey: Uint8Array
  }
}

/**
 * Throws a TypeError unless `value` is a Uint8Array (see isUint8Array) on an
 * attached, in-bounds buffer.
 *
 * @internal
 */
export function assertUint8Array(name: string, value: unknown): asserts value is Uint8Array {
  if (!isUint8Array(value)) {
    throw new TypeError(`${name} must be a Uint8Array`)
  }
  assertAttached(name, value)
}

/**
 * Reads the [[TypedArrayName]] internal slot through the captured
 * Symbol.toStringTag getter. That recognises a Uint8Array (or a subclass such
 * as Buffer) from any realm, which `instanceof` does not, and never consults
 * the value's prototype chain, where a Proxy could run a trap. An own
 * Symbol.toStringTag property cannot spoof it, unlike Object.prototype.toString.
 *
 * @internal
 */
export function isUint8Array(value: unknown): value is Uint8Array {
  return typedArrayName(value) === 'Uint8Array'
}

function detachedMessage(name: string): string {
  return `${name} must not be a view on a detached or out-of-bounds ArrayBuffer`
}

/**
 * Reject views that no longer address their buffer. After an ArrayBuffer is
 * transferred (postMessage transfer lists, structuredClone, ArrayBuffer
 * .prototype.transfer) every view on it is detached and reports `length === 0`
 * without throwing, so a detached `msg` would otherwise sign or verify as the
 * empty message. A view pushed out of bounds by shrinking a resizable
 * ArrayBuffer reports `length === 0` the same way. SharedArrayBuffer views
 * cannot be detached and pass through unchanged.
 *
 * @internal
 */
export function assertAttached(name: string, view: Uint8Array): void {
  try {
    // %TypedArray%.prototype.values validates its receiver: it throws a
    // TypeError for a detached view and for one pushed out of bounds (which
    // ArrayBuffer.prototype.detached does not report), and is otherwise a
    // no-op. The intrinsic captured at module load is called directly, so no
    // accessor on the view or its buffer is consulted: subclass overrides of
    // `length`, `buffer` or `slice` (Node's Buffer.prototype.slice skips the
    // validation), Symbol.species hooks, a spoofed `detached` property and
    // later prototype patches cannot bypass or fake the check, and the check
    // itself runs no user code.
    typedArrayValues(view)
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError(detachedMessage(name))
    }
    throw error
  }
}

const PLAIN_OPTIONS_MESSAGE = 'options must be undefined or a plain object'
const BOOLEAN_OPTION_MESSAGE = 'options.allowLargeMessage must be a boolean'

/**
 * Reads `options.allowLargeMessage`. `options` must be undefined or a plain
 * object from this realm (an object literal or `Object.create(null)`) whose
 * only own property, if any, is `allowLargeMessage`, holding a boolean or
 * undefined. Only own properties count, so nothing inherited from a patched
 * Object.prototype is read, and only through the functions captured at module
 * load: the prototype is compared by identity and the property is read from
 * its descriptor, so a getter, or a Proxy in the prototype chain, is rejected
 * without running. A Proxy passed as `options` cannot be inspected without
 * running its traps. Every caller reads options before it pins any byte
 * argument, so whatever those traps do happens before the call measures its
 * inputs.
 *
 * @internal Exported for the worker client (src/worker.ts), which reads
 * `options` on the calling thread, as a call on this thread would, and sends
 * the worker only the boolean. Not part of the API.
 */
export function readAllowLargeMessage(options: unknown): boolean {
  if (options === undefined) {
    return false
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(PLAIN_OPTIONS_MESSAGE)
  }
  const prototype = objectGetPrototypeOf(options)
  if (prototype !== IntrinsicObjectPrototype && prototype !== null) {
    throw new TypeError(PLAIN_OPTIONS_MESSAGE)
  }
  // An indexed loop: for...of would go through an overridable iterator.
  const keys = reflectOwnKeys(options)
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!
    if (key !== 'allowLargeMessage') {
      const got = typeof key === 'string' ? key : 'a symbol key'
      throw new TypeError(`options must have no property other than allowLargeMessage, got ${got}`)
    }
  }
  if (keys.length === 0) {
    return false
  }
  const descriptor = objectGetOwnPropertyDescriptor(options, 'allowLargeMessage')
  if (descriptor === undefined) {
    return false
  }
  // The descriptor is a fresh object with an own `value` exactly when the
  // property is a data property: an accessor is rejected without calling it,
  // and `value` is never looked up on Object.prototype.
  if (!objectHasOwn(descriptor, 'value')) {
    throw new TypeError(BOOLEAN_OPTION_MESSAGE)
  }
  const value: unknown = descriptor.value
  if (value === undefined) {
    return false
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(BOOLEAN_OPTION_MESSAGE)
  }
  return value
}
