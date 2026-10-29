// The `@qbit-oss/pqc` entry, built as lib/index.mjs: the public API of
// `@qbit-oss/pqc/external-wasm` (src/external-wasm.ts), and an init() that can
// compile the copy of pqc.wasm embedded here. The build keeps `./core` and
// `./external-wasm` as imports of lib/core.mjs and lib/external-wasm.mjs
// (tsup.config.ts), so both entries share one module instance, with one
// published client and the same classes, constants and functions, and only
// this file carries the bytes.
import { initWithEmbeddedWasm, type InitOptions, type PqcClient } from './core'

export * from './external-wasm'

// Captured when the module loads, so code that replaces the global later
// cannot change the bytes init() compiles.
const IntrinsicUint8Array = Uint8Array

/**
 * Loads the WASM module and publishes a client for the named exports
 * (`keygen`, `sign`, `verify`, ...).
 *
 * Unless an option says where `pqc.wasm` is (`locateFile`, or `moduleUrl`
 * without `createModule`) or passes its bytes (`wasmBinary`), it compiles a
 * copy of `pqc.wasm` embedded in this entry, the binary `wasm/SHA256SUMS`
 * pins, and fetches no file. Otherwise it is the `init()` of
 * `@qbit-oss/pqc/external-wasm`, which embeds no copy.
 *
 * A call whose options match those of the most recent call shares its load:
 * the calls return distinct promises that resolve to the same client, and a
 * call with other options starts a new load. Options are the same when
 * `moduleUrl` has the same string form and `createModule`, `locateFile` and
 * `wasmBinary` are the same objects; `init()`, `init(undefined)` and
 * `init({})` are the same.
 * The named exports use the client of the newest call that succeeded, through
 * either entry: an earlier call that settles later does not replace it, and a
 * call that fails leaves the published client in place.
 *
 * Rejects with a {@link PqcLoadError} when the WASM module cannot be loaded:
 * the loader cannot be imported or exports no factory, it cannot fetch,
 * compile or instantiate `pqc.wasm`, or the module does not match this
 * version of the package.
 */
export function init(options: InitOptions = {}): Promise<PqcClient> {
  return initWithEmbeddedWasm(options, embeddedWasm)
}

// The build inlines wasm/pqc.wasm as base64 (tsup.config.ts, src/wasm.d.ts).
// The specifier is a literal, so bundlers include it, and each load decodes a
// copy of its own, which the factory it is passed to may keep or change.
async function embeddedWasm(): Promise<Uint8Array> {
  const binary = atob((await import('../wasm/pqc.wasm')).default)
  const bytes = new IntrinsicUint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
