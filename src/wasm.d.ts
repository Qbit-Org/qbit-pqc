// Types for index.ts's imports of the WASM build output in wasm/. The build
// (tsup.config.ts) keeps wasm/pqc.mjs, the Emscripten factory, as an import of
// the shipped file and inlines wasm/pqc.wasm as a base64 string; the tests
// load pqc.wasm the same way (vitest.config.ts).

// constants.WASM_SHA256: the pqc.wasm digest in wasm/SHA256SUMS, which the build
// (tsup.config.ts) and the tests (vitest.config.ts) define.
declare const __PQC_WASM_SHA256__: string

declare module '*/wasm/pqc.mjs' {
  const createModule: import('./index').PqcWasmModuleFactory
  export default createModule
}

declare module '*/wasm/pqc.wasm' {
  const base64: string
  export default base64
}
