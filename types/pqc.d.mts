// Types for wasm/pqc.mjs, the Emscripten module factory, published as the
// `types` condition of the ./wasm/pqc.mjs export. Hand-written, and kept out of
// wasm/, which holds only the reproducible build output and its SHA256SUMS.
import type { PqcWasmModuleFactory } from '../lib/index.mjs'

declare const createModule: PqcWasmModuleFactory
export default createModule
